/**
 * Weekly → Notion Paste Log. Converts the weekly issue markdown to Notion blocks and
 * creates a child page under the "Grant Wires: Weekly Summaries Paste Log" page so the
 * operator can copy rendered rich text straight into Substack.
 *
 * Uses the app's "Wire Room Ops" Notion integration (integration_config). The integration
 * must be SHARED on the Paste Log page (Notion: page → ... → Connections → add the
 * integration), otherwise the API returns 404 — this function fails soft in that case.
 */

import { getIntegrationConfigs, notionRequest } from './notion-sync';

const PASTE_LOG_PAGE_ID = process.env.WEEKLY_PASTE_LOG_PAGE_ID || '368000c0d59081bdb5c2d104d4c64ca9';

interface RichText { type: 'text'; text: { content: string; link?: { url: string } | null }; annotations?: { bold?: boolean } }

function unescapeDollars(s: string): string { return s.replace(/\\\$/g, '$'); }

/** Parse inline markdown (links + bold) into Notion rich_text segments. */
function parseRich(line: string): RichText[] {
  const out: RichText[] = [];
  const pushPlain = (text: string) => {
    for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
      if (!part) continue;
      if (/^\*\*[^*]+\*\*$/.test(part)) out.push({ type: 'text', text: { content: unescapeDollars(part.slice(2, -2)) }, annotations: { bold: true } });
      else out.push({ type: 'text', text: { content: unescapeDollars(part) } });
    }
  };
  const linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = linkRe.exec(line)) !== null) {
    if (m.index > last) pushPlain(line.slice(last, m.index));
    out.push({ type: 'text', text: { content: unescapeDollars(m[1]), link: { url: m[2] } } });
    last = m.index + m[0].length;
  }
  if (last < line.length) pushPlain(line.slice(last));
  return out.length ? out : [{ type: 'text', text: { content: unescapeDollars(line) } }];
}

function blockOf(type: string, rich: RichText[]): Record<string, unknown> {
  return { object: 'block', type, [type]: { rich_text: rich } };
}

/** Convert the issue markdown into Notion blocks (skips the H1 title + blank lines). */
export function mdToBlocks(markdown: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^#\s+/.test(line)) continue;                     // H1 = page title, skip
    if (/^###\s+/.test(line)) { blocks.push(blockOf('heading_3', parseRich(line.replace(/^###\s+/, '')))); continue; }
    if (/^##\s+/.test(line)) { blocks.push(blockOf('heading_2', parseRich(line.replace(/^##\s+/, '')))); continue; }
    if (/^[-*]\s+/.test(line)) { blocks.push(blockOf('bulleted_list_item', parseRich(line.replace(/^[-*]\s+/, '')))); continue; }
    if (line.trim() === '') continue;
    blocks.push(blockOf('paragraph', parseRich(line)));
  }
  return blocks;
}

/**
 * Create a child page under the Paste Log with the issue rendered as Notion rich text.
 * Fails soft: returns {ok:false} on missing token / no access / API error.
 */
export async function landWeeklyInPasteLog(title: string, markdown: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  let token: string | undefined;
  try {
    const cfgs = await getIntegrationConfigs('notion');
    token = cfgs[0]?.config?.notion_token as string | undefined;
  } catch { /* fall through */ }
  if (!token) return { ok: false, error: 'no notion token configured' };

  const blocks = mdToBlocks(markdown);
  try {
    const page = await notionRequest('POST', '/pages', token, {
      parent: { page_id: PASTE_LOG_PAGE_ID },
      properties: { title: { title: [{ text: { content: title.slice(0, 200) } }] } },
      children: blocks.slice(0, 100),                      // Notion caps children at 100/request
    });
    for (let i = 100; i < blocks.length; i += 100) {       // append the rest in batches
      await notionRequest('PATCH', `/blocks/${page.id}/children`, token, { children: blocks.slice(i, i + 100) });
    }
    return { ok: true, url: page.url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
