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
import { scrapeUrl, isScrapableUrl } from '../services/scraper';
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

THIS WEEK'S PUBLISHED ITEMS (the spine, the core of the issue). Each was already source-verified this run as currently open, with amount/deadline corrected to the live page, so you can trust these figures:
${compact(spine) || '(none)'}

ALSO OPEN RIGHT NOW (additional source-verified open opportunities for a short "Also open right now" list):
${compact(alsoOpen) || '(none)'}

${priorIssue ? `LAST WEEK'S ISSUE (match this exact voice, register, and format; and make 1-3 GENUINE cross-week callbacks where a tie is actually true — a program now closing, a recurring funder, a continuing theme — never invent a tie):\n"""\n${priorIssue.slice(0, 6000)}\n"""\n` : 'There is no prior issue to reference; open with a brief standalone lede.'}

WRITE the issue as markdown with this structure:
- Title: \`# Sov's Grant Wire Weekly: ${runDate}\`
- A 1-2 line factual lede naming the week's biggest programs and numbers (and a genuine continuity nod to last week if one fits).
- \`## Quick read\` — 3-5 bullets, each with a source link.
- One \`## AI\` / \`## Crypto\` / \`## OSS\` section as relevant. Feature AT MOST 15 items total as full paragraphs across these sections (the strongest, most relevant ones), one tight paragraph each: what it is, amount, deadline, who it fits, where to apply; caveats stated straight. Put EVERY other verified item in the "Also open right now" list as a one-liner. Do not write more than 15 full paragraphs.
- \`## Also open right now\` — one line each for the additional open programs: \`- [Name](url): amount, deadline, one-clause who-it-fits.\`
- \`## Dates worth catching\` — the near deadlines, chronological.
- End with this exact channels block:
${CHANNELS_BLOCK}

STYLE RULES (strict): every factual claim needs a visible source link in markdown [text](url) form. No em dashes or en dashes anywhere (restructure the sentence instead). No "not X but Y" constructions. Never use the words foster, crucial, significantly, or comprehensive. Escape dollar amounts as \\$50,000. Prefer the program's own page as the source link. If an item looks stale or its deadline has passed, drop it. Output ONLY the markdown issue, no preamble.`;
}

/** Run an async fn over items with bounded concurrency. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface Scraped { it: SpineItem; content: string | null; scrapable: boolean }

function buildVerifyPrompt(batch: Scraped[]): string {
  const lines = batch.map((s, i) => {
    const claim = `claimed amount: ${s.it.amount || 'n/a'}, claimed deadline: ${s.it.deadline || 'n/a'}`;
    const src = s.content
      ? `SOURCE PAGE CONTENT:\n${s.content}`
      : (s.scrapable ? 'SOURCE PAGE: could not be fetched.' : 'SOURCE: a social/X post or non-scrapable page — no canonical program page available.');
    return `### Item ${i + 1}: ${s.it.name} [${s.it.wire}]\nURL: ${s.it.url}\n${claim}\n${src}`;
  }).join('\n\n');
  return `You are fact-checking grant/funding items for a public newsletter. For EACH numbered item, judge ONLY from its source page content whether it is a CURRENTLY-OPEN funding opportunity a builder can apply to right now (a grant program, RFP, fellowship, accelerator, ecosystem fund, or live bounty round). Mark open=false if: the page shows it is closed/expired/past its deadline, it is a past-grantee announcement or recap rather than an open call, it is just news, or the source is a social post with no verifiable open program page (when you cannot verify it is open, set open=false). When open=true, correct the amount and deadline to what the page actually says (or null if not stated).

Return ONLY a JSON array, one object per item:
[{"n":1,"open":true,"amount":"<corrected or null>","deadline":"<corrected or null>"}]

ITEMS:
${lines}`;
}

function parseVerify(text: string): Map<number, { open: boolean; amount: string | null; deadline: string | null }> {
  const m = new Map<number, { open: boolean; amount: string | null; deadline: string | null }>();
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
    const arr = JSON.parse(s >= 0 && e > s ? cleaned.slice(s, e + 1) : cleaned);
    if (Array.isArray(arr)) {
      for (const o of arr) {
        if (o && typeof o.n === 'number') {
          m.set(o.n, {
            open: o.open !== false,
            amount: typeof o.amount === 'string' && o.amount.toLowerCase() !== 'null' ? o.amount : null,
            deadline: typeof o.deadline === 'string' && o.deadline.toLowerCase() !== 'null' ? o.deadline : null,
          });
        }
      }
    }
  } catch { /* caller handles empty map */ }
  return m;
}

/**
 * Verify loop: scrape each item's source page and have the model confirm it is a
 * currently-open opportunity, correcting amount/deadline. Drops closed/unverifiable
 * items (including X-only sources with no canonical page). Bounded for cost.
 */
async function verifyItems(items: SpineItem[], label: string, cap: number): Promise<SpineItem[]> {
  const toCheck = items.slice(0, cap);
  if (!toCheck.length) return [];

  const scraped: Scraped[] = await mapLimit(toCheck, 5, async (it) => {
    if (!isScrapableUrl(it.url)) return { it, content: null, scrapable: false };
    try {
      const r = await scrapeUrl(it.url);
      return { it, content: r.success && r.content ? r.content.slice(0, 2500) : null, scrapable: true };
    } catch {
      return { it, content: null, scrapable: true };
    }
  });

  const verified: SpineItem[] = [];
  const BATCH = 8;
  for (let b = 0; b < scraped.length; b += BATCH) {
    const batch = scraped.slice(b, b + BATCH);
    let parsed: ReturnType<typeof parseVerify> | null = null;
    try {
      const { text } = await createMessageWithFallback(buildVerifyPrompt(batch), { model: 'claude-sonnet-4-6', maxTokens: 1500, purpose: 'weekly-verify' });
      parsed = parseVerify(text);
    } catch { parsed = null; }

    batch.forEach((s, i) => {
      if (!parsed || parsed.size === 0) {
        // Judge unavailable: keep only items we actually scraped content for (conservative).
        if (s.content) verified.push(s.it);
        return;
      }
      const v = parsed.get(i + 1);
      if (!v || !v.open) return; // closed / unverifiable → drop
      verified.push({ ...s.it, amount: v.amount || s.it.amount, deadline: v.deadline || s.it.deadline });
    });
  }
  console.log(`[Weekly] verify ${label}: ${toCheck.length} checked -> ${verified.length} open`);
  return verified;
}

export async function runWeeklyIssue(
  pool: Pool,
  options: { onProgress?: (msg: string, pct: number) => void; skipEmail?: boolean; skipStore?: boolean } = {},
): Promise<WeeklyIssueResult> {
  const progress = options.onProgress || (() => {});
  const runDate = new Date().toISOString().split('T')[0];

  progress('Gathering published feed...', 8);
  const spineRaw = await gatherSpine(pool);
  const spineUrls = new Set(spineRaw.map(s => s.url.toLowerCase().replace(/\/+$/, '')));
  const alsoOpenRaw = await gatherAlsoOpen(pool, spineUrls);

  progress(`Verifying ${spineRaw.length} published + ${alsoOpenRaw.length} open against live sources...`, 22);
  const spine = await verifyItems(spineRaw, 'spine', 40);
  const alsoOpen = await verifyItems(alsoOpenRaw, 'also-open', 14);
  console.log(`[Weekly] verified: spine ${spineRaw.length}->${spine.length}, also-open ${alsoOpenRaw.length}->${alsoOpen.length}`);

  const prior = await getAppState<{ date: string; markdown: string }>(PRIOR_ISSUE_KEY).catch(() => null);

  progress(`Synthesizing from ${spine.length} verified + ${alsoOpen.length} open...`, 60);
  const prompt = buildPrompt(spine, alsoOpen, prior?.markdown || null, runDate);
  // Pin a current, available model — the resolver otherwise can land on a tier this org
  // can't access. Opus for the writing quality this needs. High token ceiling so a
  // full issue (featured items + also-open + dates + channels) never truncates.
  const { text } = await createMessageWithFallback(prompt, { model: 'claude-opus-4-8', maxTokens: 8000, purpose: 'weekly-issue' });
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
