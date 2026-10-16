/**
 * Contacts Sync — Notion Contacts DB → wire-room monitor.
 *
 * Makes the Notion "Contacts" database the CONTROL SURFACE for who the people-
 * monitor watches. One-way reconcile (Notion is the source of truth for the
 * people layer):
 *  - Each Notion contact's X URL → handle; Status drives whether it's watched.
 *  - Status != 'Skip'  → upserted into monitored_accounts as kind='person', enabled.
 *  - Status == 'Skip'  → upserted but disabled (polling stops).
 *  - A kind='person' row whose handle is NOT in Notion anymore → disabled.
 *  - kind='org' rows are never touched (orgs aren't in the Contacts DB).
 *
 * Cheap: one Notion read + a few DB writes, no LLM/X cost. The Notion
 * integration token (SimpleCRM - Notion) must be granted access to the
 * Contacts DB in Notion, or this no-ops with a clear message.
 */

import type { Pool } from 'pg';
import { getIntegrationConfigs, queryAllNotionPages } from '../services/notion-sync';
import { config } from '../config';


export interface ContactsSyncResult {
  ok: boolean;
  message?: string;
  total?: number;
  watched?: number;
  skipped?: number;
  disabledMissing?: number;
}

/** A Notion contact is watched unless explicitly Skipped or still pending review. */
export function shouldWatchContact(status: string | null | undefined): boolean {
  const s = (status || '').trim().toLowerCase();
  return s !== 'skip' && s !== 'needs review';
}

export function handleFromXUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/(?:twitter|x)\.com\/@?([A-Za-z0-9_]{1,15})/i);
  return m ? m[1].toLowerCase() : null;
}

function readTitle(p: any): string { return (p?.title || []).map((t: any) => t.plain_text).join('').trim(); }
function readRichText(p: any): string { return (p?.rich_text || []).map((t: any) => t.plain_text).join('').trim(); }
function readUrl(p: any): string { return p?.url || ''; }
function readSelect(p: any): string { return p?.select?.name || ''; }

export async function runContactsSync(pool: Pool): Promise<ContactsSyncResult> {
  const configs = await getIntegrationConfigs('notion');
  const integration = configs.find(c => c.enabled && c.config?.notion_token);
  if (!integration) {
    return { ok: false, message: 'No enabled Notion integration configured' };
  }
  const token = integration.config.notion_token as string;
  const dbId = (integration.config.contacts_database_id as string) || config.notionDatabases.contacts;
  if (!dbId) return { ok: false, message: 'No Contacts database id configured (integration config or CONTACTS_NOTION_DATABASE_ID)' };

  let pages;
  try {
    pages = await queryAllNotionPages(token, dbId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 404 = the integration hasn't been granted access to the Contacts DB
    return { ok: false, message: `Could not read Contacts DB (${msg}). Grant the "SimpleCRM - Notion" integration access to the Contacts database in Notion.` };
  }

  // Wire + Program were pruned from the Contacts schema 2026-07-03 (5% filled,
  // wires describe content lanes, not people). Existing monitored_accounts
  // wire/linked_program values are preserved (COALESCE keeps prior wire; the
  // upsert no longer sets linked_program).
  const desired: Array<{ handle: string; name: string; role: string; watched: boolean }> = [];
  for (const page of pages) {
    const props = page.properties || {};
    const handle = handleFromXUrl(readUrl(props['X']));
    if (!handle) continue;
    const status = readSelect(props['Status']);
    desired.push({
      handle,
      name: readTitle(props['Name']),
      role: readRichText(props['Role']),
      watched: shouldWatchContact(status),
    });
  }

  let watched = 0, skipped = 0;
  for (const d of desired) {
    await pool.query(
      `INSERT INTO monitored_accounts (handle, kind, person_name, role, source, enabled)
       VALUES ($1, 'person', $2, $3, 'notion-contacts', $4)
       ON CONFLICT (handle) DO UPDATE SET
         kind = 'person',
         person_name = EXCLUDED.person_name,
         role = EXCLUDED.role,
         enabled = EXCLUDED.enabled,
         updated_at = NOW()`,
      [d.handle, d.name || null, d.role || null, d.watched]
    );
    if (d.watched) watched++; else skipped++;
  }

  // Notion is the source of truth for the people layer: any kind='person' row
  // whose handle is no longer present in Notion gets disabled (never deleted).
  const handles = desired.map(d => d.handle);
  const disableRes = await pool.query(
    `UPDATE monitored_accounts SET enabled = false, updated_at = NOW()
     WHERE kind = 'person' AND enabled = true AND NOT (lower(handle) = ANY($1))`,
    [handles.length > 0 ? handles : ['__none__']]
  );

  const result: ContactsSyncResult = {
    ok: true,
    total: desired.length,
    watched,
    skipped,
    disabledMissing: disableRes.rowCount || 0,
  };
  console.log(`[ContactsSync] ${result.total} contacts: ${watched} watched, ${skipped} skipped, ${result.disabledMissing} disabled (absent from Notion)`);
  return result;
}
