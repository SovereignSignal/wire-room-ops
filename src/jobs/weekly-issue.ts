/**
 * Weekly Issue Job — generate Sov's weekly Grant Wire draft from the published feed.
 *
 * Rides the daily cycle on Fridays (no separate cron, no Claude routine slot). Pulls
 * the week's DISTRIBUTED items (the public feed) as the spine, plus currently-open
 * queued/approved opportunities for an "also open" list, reads the prior issue from
 * app_state for cross-week callbacks + voice, synthesizes the draft via Claude, then
 * emails it to the operator and stores it for next week. Publishing to Substack stays
 * a human step — this produces the draft for review.
 *
 * The deep agentic engine (repos/grant-wire-engine) remains for on-demand full runs;
 * this is the reliable, automatic baseline.
 */

import type { Pool } from 'pg';
import { createMessageWithFallback } from '../services/anthropic';
import { sendWeeklyDraftEmail } from '../services/email';
import { getAppState, setAppState } from '../db';

interface SpineItem {
  wire: string;
  name: string;
  url: string;
  amount: string | null;
  deadline: string | null;
  summary: string | null;
}

export interface WeeklyIssueResult {
  runDate: string;
  spineCount: number;
  alsoOpenCount: number;
  hadPriorIssue: boolean;
  markdown: string;
  emailed: boolean;
}

const PRIOR_ISSUE_KEY = 'weekly:last-issue';   // { date, markdown }
const CHANNELS_BLOCK = `## Follow Sov's Grant Wires
For real-time updates as these land, join the Telegram channels:
- Crypto: [@cryptograntwire](https://t.me/cryptograntwire)
- AI: [@aigrantwire](https://t.me/aigrantwire)
- OSS: [@ossgrantwire](https://t.me/ossgrantwire)`;

function metaField(metadata: unknown, key: string): string | null {
  if (metadata && typeof metadata === 'object') {
    const v = (metadata as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** The week's distributed-and-approved items — the spine of the recap. */
async function gatherSpine(pool: Pool): Promise<SpineItem[]> {
  const { rows } = await pool.query(`
    with deduped as (
      select distinct on (se.id)
        coalesce(dl.wire, se.wire) as wire, se.name, se.source_url,
        se.amount, se.deadline, se.quality_score, se.metadata
      from distribution_logs dl
      join scan_entries se on se.id = dl.entry_id
      where dl.status = 'success'
        and dl.created_at >= now() - interval '7 days'
        and coalesce(se.status,'') = 'approved'
      order by se.id, dl.created_at asc
    )
    select * from deduped
    order by wire, quality_score desc nulls last`);
  return rows
    .filter(r => r.name && r.source_url)
    .map(r => ({
      wire: r.wire || 'crypto',
      name: r.name,
      url: r.source_url,
      amount: r.amount || metaField(r.metadata, 'amount'),
      deadline: r.deadline || metaField(r.metadata, 'deadline'),
      summary: metaField(r.metadata, 'summary'),
    }));
}

/** Currently-open opportunities in the queue/approved set, not already in the spine. */
async function gatherAlsoOpen(pool: Pool, spineUrls: Set<string>): Promise<SpineItem[]> {
  const { rows } = await pool.query(`
    select wire, name, source_url, amount, deadline, quality_score, metadata, classification
    from scan_entries
    where status in ('queued','approved')
      and classification = 'GRANT'
      and coalesce(quality_score,0) >= 55
      and created_at >= now() - interval '21 days'
      and (deadline_parsed is null or deadline_parsed >= current_date)
    order by quality_score desc nulls last
    limit 40`);
  const out: SpineItem[] = [];
  for (const r of rows) {
    if (!r.name || !r.source_url) continue;
    if (spineUrls.has(String(r.source_url).toLowerCase().replace(/\/+$/, ''))) continue;
    out.push({
      wire: r.wire || 'crypto',
      name: r.name,
      url: r.source_url,
      amount: r.amount || metaField(r.metadata, 'amount'),
      deadline: r.deadline || metaField(r.metadata, 'deadline'),
      summary: metaField(r.metadata, 'summary'),
    });
    if (out.length >= 14) break;
  }
  return out;
}

function compact(items: SpineItem[]): string {
  return items
    .map(i => `- [${i.wire}] ${i.name}${i.amount ? ` | amount: ${i.amount}` : ''}${i.deadline ? ` | deadline: ${i.deadline}` : ''} | ${i.url}${i.summary ? `\n    ${i.summary.slice(0, 200)}` : ''}`)
    .join('\n');
}

function buildPrompt(spine: SpineItem[], alsoOpen: SpineItem[], priorIssue: string | null, runDate: string): string {
  return `You are writing Sov's weekly "Grant Wire" issue for ${runDate} — a curated operator briefing on the week's grant and funding opportunities across three beats: crypto, AI, and open-source software. Direct, plain, useful. You are writing for builders deciding what to apply to.

THIS WEEK'S PUBLISHED ITEMS (the spine — what already went out on the channels this week; these are the core of the issue):
${compact(spine) || '(none)'}

ALSO OPEN RIGHT NOW (currently-open opportunities in the system that did not get featured — use these for a short "Also open right now" list):
${compact(alsoOpen) || '(none)'}

${priorIssue ? `LAST WEEK'S ISSUE (match this exact voice, register, and format; and make 1-3 GENUINE cross-week callbacks where a tie is actually true — a program now closing, a recurring funder, a continuing theme — never invent a tie):\n"""\n${priorIssue.slice(0, 6000)}\n"""\n` : 'There is no prior issue to reference; open with a brief standalone lede.'}

WRITE the issue as markdown with this structure:
- Title: \`# Sov's Grant Wire Weekly: ${runDate}\`
- A 1-2 line factual lede naming the week's biggest programs and numbers (and a genuine continuity nod to last week if one fits).
- \`## Quick read\` — 3-5 bullets, each with a source link.
- One \`## AI\` / \`## Crypto\` / \`## OSS\` section as relevant, one tight paragraph per featured item (curate to the ~12-16 strongest): what it is, amount, deadline, who it fits, where to apply; caveats stated straight.
- \`## Also open right now\` — one line each for the additional open programs: \`- [Name](url): amount, deadline, one-clause who-it-fits.\`
- \`## Dates worth catching\` — the near deadlines, chronological.
- End with this exact channels block:
${CHANNELS_BLOCK}

STYLE RULES (strict): every factual claim needs a visible source link in markdown [text](url) form. No em dashes or en dashes anywhere (restructure the sentence instead). No "not X but Y" constructions. Never use the words foster, crucial, significantly, or comprehensive. Escape dollar amounts as \\$50,000. Prefer the program's own page as the source link. If an item looks stale or its deadline has passed, drop it. Output ONLY the markdown issue, no preamble.`;
}

export async function runWeeklyIssue(
  pool: Pool,
  options: { onProgress?: (msg: string, pct: number) => void; skipEmail?: boolean; skipStore?: boolean } = {},
): Promise<WeeklyIssueResult> {
  const progress = options.onProgress || (() => {});
  const runDate = new Date().toISOString().split('T')[0];

  progress('Gathering published feed...', 10);
  const spine = await gatherSpine(pool);
  const spineUrls = new Set(spine.map(s => s.url.toLowerCase().replace(/\/+$/, '')));
  const alsoOpen = await gatherAlsoOpen(pool, spineUrls);

  const prior = await getAppState<{ date: string; markdown: string }>(PRIOR_ISSUE_KEY).catch(() => null);

  progress(`Synthesizing from ${spine.length} published + ${alsoOpen.length} open...`, 40);
  const prompt = buildPrompt(spine, alsoOpen, prior?.markdown || null, runDate);
  // Pin a current, available model — the resolver otherwise can land on a tier this org
  // can't access. Opus for the writing quality this needs.
  const { text } = await createMessageWithFallback(prompt, { model: 'claude-opus-4-8', maxTokens: 4000, purpose: 'weekly-issue' });
  const markdown = text.trim();

  progress('Emailing draft + storing for next week...', 85);
  let emailed = false;
  if (!options.skipEmail) {
    try {
      await sendWeeklyDraftEmail(markdown, { runDate, spineCount: spine.length, alsoOpenCount: alsoOpen.length });
      emailed = true;
    } catch (err) {
      console.error('[Weekly] Failed to email draft:', err instanceof Error ? err.message : err);
    }
  }

  // Store as the prior issue for next week's lookback + voice exemplar.
  if (!options.skipStore) {
    try { await setAppState(PRIOR_ISSUE_KEY, { date: runDate, markdown }); } catch { /* non-fatal */ }
  }

  progress('Weekly issue complete', 100);
  console.log(`[Weekly] ${runDate}: spine=${spine.length}, alsoOpen=${alsoOpen.length}, prior=${prior ? 'yes' : 'no'}, emailed=${emailed}`);
  return { runDate, spineCount: spine.length, alsoOpenCount: alsoOpen.length, hadPriorIssue: !!prior, markdown, emailed };
}
