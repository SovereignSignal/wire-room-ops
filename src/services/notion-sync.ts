/**
 * Notion CRM Sync
 *
 * Syncs org_profiles to a Notion database.
 * Config (token + database ID) stored in integration_config table, not env vars.
 */

import { getPool } from '../db';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// ============================================================
// Integration Config (DB-backed, not env vars)
// ============================================================

export interface IntegrationConfig {
  id: number;
  provider: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  created_at: string;
  updated_at: string;
}

export async function ensureIntegrationConfigTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration_config (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'notion',
      name TEXT NOT NULL DEFAULT 'CRM Sync',
      enabled BOOLEAN NOT NULL DEFAULT false,
      config JSONB NOT NULL DEFAULT '{}',
      last_sync_at TIMESTAMPTZ,
      last_sync_status TEXT,
      last_sync_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(provider, name)
    )
  `);
}

export async function getIntegrationConfigs(provider?: string): Promise<IntegrationConfig[]> {
  const pool = getPool();
  if (provider) {
    const { rows } = await pool.query(
      `SELECT * FROM integration_config WHERE provider = $1 ORDER BY created_at`,
      [provider]
    );
    return rows;
  }
  const { rows } = await pool.query(`SELECT * FROM integration_config ORDER BY provider, created_at`);
  return rows;
}

export async function getIntegrationById(id: number): Promise<IntegrationConfig | null> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT * FROM integration_config WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function upsertIntegration(
  provider: string,
  name: string,
  enabled: boolean,
  config: Record<string, string>
): Promise<IntegrationConfig> {
  const pool = getPool();
  const { rows } = await pool.query(`
    INSERT INTO integration_config (provider, name, enabled, config)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (provider, name) DO UPDATE SET
      enabled = $3,
      config = integration_config.config || $4,
      updated_at = NOW()
    RETURNING *
  `, [provider, name, enabled, JSON.stringify(config)]);
  return rows[0];
}

export async function updateIntegration(
  id: number,
  updates: { enabled?: boolean; config?: Record<string, string> }
): Promise<IntegrationConfig> {
  const pool = getPool();
  const sets: string[] = ['updated_at = NOW()'];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.enabled !== undefined) {
    sets.push(`enabled = $${paramIndex++}`);
    values.push(updates.enabled);
  }
  if (updates.config) {
    sets.push(`config = config || $${paramIndex++}`);
    values.push(JSON.stringify(updates.config));
  }

  values.push(id);
  const { rows } = await pool.query(
    `UPDATE integration_config SET ${sets.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return rows[0];
}

export async function deleteIntegration(id: number): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM integration_config WHERE id = $1`, [id]);
}

// ============================================================
// Notion Sync Logic
// ============================================================

interface NotionPage {
  id: string;
  properties: Record<string, any>;
}

async function notionRequest(
  method: string,
  path: string,
  token: string,
  body?: any
): Promise<any> {
  const url = `${NOTION_API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({} as any));
    throw new Error(`Notion API ${res.status}: ${(err as any).message || res.statusText}`);
  }

  return res.json();
}

/**
 * Validate a Notion integration token by listing the user.
 */
export async function validateNotionToken(token: string): Promise<{ valid: boolean; workspace?: string; error?: string }> {
  try {
    const data = await notionRequest('GET', '/users/me', token);
    return { valid: true, workspace: data.name || data.bot?.owner?.workspace?.name || 'Connected' };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Validate a Notion database ID — check it exists and is accessible.
 */
export async function validateNotionDatabase(token: string, databaseId: string): Promise<{
  valid: boolean;
  title?: string;
  properties?: string[];
  error?: string;
}> {
  try {
    const data = await notionRequest('GET', `/databases/${databaseId}`, token);
    const title = data.title?.map((t: any) => t.plain_text).join('') || 'Untitled';
    const properties = Object.keys(data.properties || {});
    return { valid: true, title, properties };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Sync org_profiles to a Notion database.
 * Creates or updates pages based on org name matching.
 */
export async function syncOrgsToNotion(integrationId: number): Promise<{
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  message: string;
}> {
  const pool = getPool();
  const stats = { created: 0, updated: 0, skipped: 0, errors: 0, message: '' };

  // Load integration config
  const integration = await getIntegrationById(integrationId);
  if (!integration) throw new Error('Integration not found');
  if (!integration.enabled) throw new Error('Integration is disabled');

  const token = integration.config.notion_token;
  const databaseId = integration.config.database_id;
  if (!token || !databaseId) throw new Error('Missing Notion token or database ID');

  // Get all org profiles
  const { rows: orgs } = await pool.query(
    `SELECT * FROM org_profiles ORDER BY entry_count DESC`
  );

  if (orgs.length === 0) {
    stats.message = 'No org profiles to sync';
    await updateSyncStatus(integrationId, 'success', stats.message);
    return stats;
  }

  // Query existing Notion pages to find matches
  const existingPages = await queryAllNotionPages(token, databaseId);
  const existingByName = new Map<string, string>(); // lowercase name → page ID

  for (const page of existingPages) {
    const nameProp = page.properties['Name'] || page.properties['name'] || page.properties['Title'] || page.properties['title'];
    if (nameProp?.title) {
      const name = nameProp.title.map((t: any) => t.plain_text).join('').toLowerCase();
      existingByName.set(name, page.id);
    }
  }

  console.log(`[NotionSync] Found ${existingPages.length} existing pages, syncing ${orgs.length} orgs`);

  // Sync each org
  for (const org of orgs) {
    try {
      const existingPageId = existingByName.get(org.name.toLowerCase());

      const properties = buildOrgProperties(org);

      if (existingPageId) {
        // Update existing page
        await notionRequest('PATCH', `/pages/${existingPageId}`, token, { properties });
        stats.updated++;
      } else {
        // Create new page
        await notionRequest('POST', '/pages', token, {
          parent: { database_id: databaseId },
          properties,
        });
        stats.created++;
      }

      // Rate limit — 3 requests/sec for Notion
      await new Promise(r => setTimeout(r, 350));
    } catch (err) {
      console.error(`[NotionSync] Failed to sync org ${org.name}:`, err);
      stats.errors++;
    }
  }

  stats.message = `Synced ${orgs.length} orgs: ${stats.created} created, ${stats.updated} updated, ${stats.errors} errors`;
  await updateSyncStatus(integrationId, stats.errors > 0 ? 'partial' : 'success', stats.message);

  return stats;
}

/**
 * Query all pages from a Notion database (handles pagination).
 */
async function queryAllNotionPages(token: string, databaseId: string): Promise<NotionPage[]> {
  const allPages: NotionPage[] = [];
  let startCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const body: any = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;

    const data = await notionRequest('POST', `/databases/${databaseId}/query`, token, body);
    allPages.push(...data.results);

    hasMore = data.has_more;
    startCursor = data.next_cursor || undefined;

    if (hasMore) await new Promise(r => setTimeout(r, 350));
  }

  return allPages;
}

/**
 * Build Notion properties object for an org profile.
 * Uses standard property names — Notion DB should have these columns.
 */
function buildOrgProperties(org: any): Record<string, any> {
  const props: Record<string, any> = {
    Name: { title: [{ text: { content: org.name } }] },
  };

  if (org.website) {
    props['Website'] = { url: org.website };
  }

  if (org.wires && org.wires.length > 0) {
    props['Wires'] = { multi_select: org.wires.map((w: string) => ({ name: w })) };
  }

  if (org.entry_count !== undefined) {
    props['Entries'] = { number: org.entry_count };
  }

  if (org.first_seen) {
    props['First Seen'] = { date: { start: org.first_seen.toISOString?.()?.split('T')[0] || org.first_seen } };
  }

  if (org.last_seen) {
    props['Last Seen'] = { date: { start: org.last_seen.toISOString?.()?.split('T')[0] || org.last_seen } };
  }

  if (org.description) {
    props['Description'] = { rich_text: [{ text: { content: org.description.substring(0, 2000) } }] };
  }

  if (org.tags && org.tags.length > 0) {
    props['Tags'] = { multi_select: org.tags.map((t: string) => ({ name: t })) };
  }

  if (org.total_funding) {
    props['Total Funding'] = { rich_text: [{ text: { content: org.total_funding } }] };
  }

  return props;
}

async function updateSyncStatus(integrationId: number, status: string, message: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE integration_config SET last_sync_at = NOW(), last_sync_status = $1, last_sync_message = $2, updated_at = NOW() WHERE id = $3`,
    [status, message, integrationId]
  );
}
