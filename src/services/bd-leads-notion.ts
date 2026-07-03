/**
 * Write verified BD leads into the Notion "Leads" database in Sov's CRM.
 *
 * Reuses the existing Notion integration (same token as the org sync). Dedups
 * by Source URL so a lead is never re-added across weeks, and sets Status =
 * "Lead" (the Status property is a Notion `status` type). FIND + QUALIFY ONLY:
 * writes leads, never creates Opps, never contacts anyone — imports no
 * distribution/send/contact path by construction.
 */
import { getIntegrationConfigs, notionRequest, queryAllNotionPages } from './notion-sync';

export interface LeadRecord {
  lead: string;    // title
  source: string;  // url ('' if none)
  notes: string;   // one-line summary
  body: string;    // fuller verified detail (page body)
}

export interface LeadsWriteResult {
  configured: boolean;
  created: number;
  skipped: number;
  errors: number;
  message: string;
}

/** Resolve the Notion token (org-sync integration) + the Leads database id. */
function leadsConfig(cfgToken?: string, leadsDbId?: string): { token?: string; dbId?: string } {
  return {
    token: cfgToken,
    dbId: leadsDbId || process.env.BD_LEADS_DATABASE_ID,
  };
}

export async function writeLeadsToNotion(leads: LeadRecord[]): Promise<LeadsWriteResult> {
  const res: LeadsWriteResult = { configured: false, created: 0, skipped: 0, errors: 0, message: '' };

  const cfg = (await getIntegrationConfigs('notion'))[0];
  const { token, dbId } = leadsConfig(cfg?.config?.notion_token, cfg?.config?.leads_database_id);
  if (!token || !dbId) {
    res.message = 'Leads Notion not configured (need notion_token + leads_database_id / BD_LEADS_DATABASE_ID)';
    return res;
  }
  res.configured = true;
  if (!leads.length) { res.message = 'no leads to write'; return res; }

  // Dedup against existing rows by Source URL (covers Lead/In progress/Converted/Rejected).
  const existingSources = new Set<string>();
  try {
    const pages = await queryAllNotionPages(token, dbId);
    for (const p of pages as Array<{ properties?: Record<string, { url?: string }> }>) {
      const src = p.properties?.Source?.url;
      if (src) existingSources.add(src.trim());
    }
  } catch (e) {
    res.message = `could not query Leads DB (is it shared with the integration?): ${e instanceof Error ? e.message : e}`;
    res.errors = leads.length;
    return res;
  }

  for (const l of leads) {
    if (l.source && existingSources.has(l.source.trim())) { res.skipped++; continue; }
    try {
      await notionRequest('POST', '/pages', token, {
        parent: { database_id: dbId },
        properties: {
          Lead: { title: [{ text: { content: l.lead.slice(0, 200) } }] },
          Status: { status: { name: 'Lead' } },
          ...(l.source ? { Source: { url: l.source } } : {}),
          Notes: { rich_text: [{ text: { content: l.notes.slice(0, 1900) } }] },
        },
        children: l.body
          ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: l.body.slice(0, 1900) } }] } }]
          : undefined,
      });
      res.created++;
      await new Promise(r => setTimeout(r, 350)); // Notion ~3 req/sec
    } catch (e) {
      console.error(`[BdLeads] Failed to create lead "${l.lead}":`, e instanceof Error ? e.message : e);
      res.errors++;
    }
  }

  res.message = `${res.created} created, ${res.skipped} already present, ${res.errors} errors`;
  return res;
}
