/**
 * Weekly Issue Job — generate Sov's weekly Grant Wire draft in the locked Substack shape.
 *
 * Rides the daily cycle on Fridays (no separate cron, no Claude routine slot). Pulls the
 * week's DISTRIBUTED-and-approved items (the public feed) since the last issue, verifies
 * each against its live source, then for each beat splits the verified set by quality into
 * 5-6 FEATURED paragraphs + an "Also open" list (both drawn only from what actually
 * published — fidelity to the channels). The structure is assembled deterministically
 * (assembleIssue); Claude writes only the one-line item descriptions (hybrid). Repeats from
 * last week's issue are dropped. Emails the draft, lands it in the Notion Paste Log, stores
 * it as next week's prior, and bumps the week number. Publishing to Substack stays human.
 *
 * Shape is locked to Sov's edited final (see memory weekly-newsletter-template):
 * opening + channel block, `# **AI/Crypto/OSS**`, featured (bold+linked) + "Also open:"
 * (linked, not bold), `# **Conclusion**`. No em dashes.
 */

import type { Pool } from 'pg';
import { createMessageWithFallback } from '../services/anthropic';
import { scrapeUrl, isScrapableUrl } from '../services/scraper';
import { sendWeeklyDraftEmail } from '../services/email';
import { parallelAvailable, verifyOpportunities } from '../services/parallel-task';
import { landWeeklyInPasteLog } from '../services/weekly-notion';
import { getAppState, setAppState } from '../db';

interface SpineItem {
  wire: string;
  name: string;
  url: string;
  amount: string | null;
  deadline: string | null;
  summary: string | null;
  quality?: number | null;
  citationUrl?: string | null;   // verified canonical source (Parallel basis)
  confidence?: string | null;    // low/medium/high (Parallel) or undefined (unverified)
}

/** Minimal shape the pure selection helpers operate on. */
interface RankedItem {
  name: string;
  url: string;
  quality?: number | null;
}

/** A described item ready to render. */
export interface IssueItem {
  name: string;
  url: string;
  description: string;
}

/** One beat's rendered selection. */
export interface WireBlock {
  label: 'AI' | 'Crypto' | 'OSS';
  featured: IssueItem[];
  alsoOpen: IssueItem[];
}

export interface WeeklyIssueResult {
  runDate: string;
  weekNumber: number;
  spineCount: number;
  alsoOpenCount: number;
  hadPriorIssue: boolean;
  markdown: string;
  emailed: boolean;
}

const PRIOR_ISSUE_KEY = 'weekly:last-issue';   // { date, markdown }
const WEEK_NUMBER_KEY = 'weekly:week-number';  // number (last issue's week number)
const WEEK_NUMBER_SEED = 24;                   // Week 24 = week ending 2026-06-12 (first auto run -> 25)
const FEATURED_PER_WIRE = 6;                   // 5-6 featured paragraphs per beat

const CHANNEL_BULLETS = `- Crypto: [**@cryptograntwire**](https://t.me/cryptograntwire)
- AI: [**@aigrantwire**](https://t.me/aigrantwire)
- OSS: [**@ossgrantwire**](https://t.me/ossgrantwire)`;

const WIRES: Array<{ key: string; label: 'AI' | 'Crypto' | 'OSS' }> = [
  { key: 'ai', label: 'AI' },
  { key: 'crypto', label: 'Crypto' },
  { key: 'oss', label: 'OSS' },
];

function metaField(metadata: unknown, key: string): string | null {
  if (metadata && typeof metadata === 'object') {
    const v = (metadata as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

const normUrl = (u: string): string => (u || '').trim().toLowerCase().replace(/\/+$/, '');
const normName = (n: string): string => (n || '').trim().toLowerCase().replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------
// Pure selection + assembly (unit-tested in tests/weekly-issue.test.js)
// ---------------------------------------------------------------------------

/** Drop same-URL and same-name repeats, keeping the highest-scoring instance. */
export function dedupeItems<T extends RankedItem>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
  const seenUrl = new Set<string>();
  const seenName = new Set<string>();
  const out: T[] = [];
  for (const it of sorted) {
    const u = normUrl(it.url);
    const n = normName(it.name);
    if ((u && seenUrl.has(u)) || (n && seenName.has(n))) continue;
    if (u) seenUrl.add(u);
    if (n) seenName.add(n);
    out.push(it);
  }
  return out;
}

/** Sort by score, take the top N as featured, the rest as also-open. */
export function splitByScore<T extends RankedItem>(
  items: T[],
  featuredMax: number,
): { featured: T[]; alsoOpen: T[] } {
  const sorted = [...items].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
  return { featured: sorted.slice(0, featuredMax), alsoOpen: sorted.slice(featuredMax) };
}

/** Remove items whose URL or name already appeared in last week's issue (no repeats). */
export function stripPriorIssueItems<T extends RankedItem>(items: T[], priorMarkdown: string | null): T[] {
  if (!priorMarkdown) return items;
  const hay = priorMarkdown.toLowerCase();
  return items.filter((it) => {
    const u = normUrl(it.url);
    const n = normName(it.name);
    if (u && hay.includes(u)) return false;
    if (n && n.length >= 4 && hay.includes(n)) return false;
    return true;
  });
}

/** Assemble the locked Substack shape from described blocks. Deterministic, no LLM. */
export function assembleIssue(opts: { weekEnding: string; blocks: WireBlock[] }): string {
  const { weekEnding, blocks } = opts;
  const parts: string[] = [];
  parts.push(
    `Welcome back to my weekly update on AI, Crypto, and OSS grants. This issue covers the week ending **${weekEnding}**. Remember that the Telegram channels receive updates first, so please subscribe!`,
  );
  parts.push(CHANNEL_BULLETS);
  parts.push("Alright, let's hop in.");

  for (const b of blocks) {
    if (!b.featured.length && !b.alsoOpen.length) continue;
    parts.push(`# **${b.label}**`);
    for (const f of b.featured) {
      parts.push(`[**${f.name}**](${f.url}) ${f.description}`.trim());
    }
    if (b.alsoOpen.length) {
      parts.push('Also open:');
      parts.push(b.alsoOpen.map((a) => `- [${a.name}](${a.url}): ${a.description}`).join('\n'));
    }
  }

  parts.push('# **Conclusion**');
  parts.push("That's it for this week! For real-time updates, join the Telegram channels:");
  parts.push(CHANNEL_BULLETS);
  parts.push('Hope to see you next time!');
  parts.push('Peace,\nSov');
  return parts.join('\n\n');
}

/** "June 12, 2026" */
function formatWeekEnding(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** Fallback one-liner when the description model is unavailable. */
function fallbackDesc(it: SpineItem, kind: 'featured' | 'alsoopen'): string {
  if (kind === 'featured') {
    const base = (it.summary || '').trim();
    const dl = it.deadline ? ` Deadline **${it.deadline}**.` : '';
    return base ? `${base}${dl}` : `is an open funding opportunity.${dl}`;
  }
  const amt = it.amount ? `${it.amount}. ` : '';
  return `${amt}${it.deadline || 'Open now'}.`;
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

/** The week's distributed-and-approved items since the last issue — the spine of the recap. */
async function gatherSpine(pool: Pool, windowStart: string): Promise<SpineItem[]> {
  const { rows } = await pool.query(
    `
    with deduped as (
      select distinct on (se.id)
        coalesce(dl.wire, se.wire) as wire, se.name, se.source_url,
        se.amount, se.deadline, se.quality_score, se.metadata
      from distribution_logs dl
      join scan_entries se on se.id = dl.entry_id
      where dl.status = 'success'
        and dl.created_at >= $1
        and coalesce(se.status,'') = 'approved'
        and coalesce(se.classification,'') <> 'NOISE'
      order by se.id, dl.created_at asc
    )
    select * from deduped
    order by wire, quality_score desc nulls last`,
    [windowStart],
  );
  return rows
    .filter((r) => r.name && r.source_url)
    .map((r) => ({
      wire: (r.wire || 'crypto').toLowerCase(),
      name: r.name,
      url: r.source_url,
      amount: r.amount || metaField(r.metadata, 'amount'),
      deadline: r.deadline || metaField(r.metadata, 'deadline'),
      summary: metaField(r.metadata, 'summary'),
      quality: typeof r.quality_score === 'number' ? r.quality_score : null,
    }));
}

// ---------------------------------------------------------------------------
// Hybrid prose: Claude writes only the per-item descriptions
// ---------------------------------------------------------------------------

function buildDescribePrompt(items: Array<{ it: SpineItem; kind: 'featured' | 'alsoopen' }>): string {
  const lines = items
    .map((x, i) => {
      return `### ${i + 1} [${x.kind}] ${x.it.name}\nwire: ${x.it.wire}; amount: ${x.it.amount || 'n/a'}; deadline: ${x.it.deadline || 'n/a'}\nsource: ${x.it.url}\nnotes: ${(x.it.summary || 'n/a').slice(0, 240)}`;
    })
    .join('\n\n');
  return `You are writing terse descriptions for Sov's weekly Grant Wire newsletter. For EACH numbered item, write copy that appears immediately AFTER a bolded, linked program name. Plain, factual, useful to a builder deciding what to apply to.

kind=featured: ONE sentence (a short second sentence is allowed only to state the deadline). Begin with a verb so it reads after the name ("is", "offers", "provides", "runs"). Weave in the funding amount and who it is for. Bold the dollar amount like **\\$150M**, and bold the deadline like Deadline **July 17** (or end with "Rolling." when there is no deadline).

kind=alsoopen: ONE short clause, no leading verb: amount, who it fits, then the deadline. Example: "\\$10K+ for enterprise multi-agent builders. June 19."

STRICT: no em dashes or en dashes (restructure instead). Do not repeat the program name. Do not invent facts beyond what is given. Never use the words foster, crucial, significantly, or comprehensive.

Return ONLY a JSON array: [{"n":1,"text":"..."}].

ITEMS:
${lines}`;
}

async function writeDescriptions(
  items: Array<{ it: SpineItem; kind: 'featured' | 'alsoopen' }>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!items.length) return map;
  try {
    const { text } = await createMessageWithFallback(buildDescribePrompt(items), {
      model: 'claude-opus-4-8',
      maxTokens: 4000,
      purpose: 'weekly-describe',
    });
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
    const arr = JSON.parse(s >= 0 && e > s ? cleaned.slice(s, e + 1) : cleaned);
    if (Array.isArray(arr)) {
      for (const o of arr) {
        if (o && typeof o.n === 'number' && typeof o.text === 'string') {
          const item = items[o.n - 1];
          if (item) map.set(item.it.url, o.text.trim());
        }
      }
    }
  } catch (err) {
    console.error('[Weekly] describe failed, using fallbacks:', err instanceof Error ? err.message : err);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Verification (unchanged) — confirm each item is currently open, fix amount/deadline
// ---------------------------------------------------------------------------

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

/**
 * Verify via Parallel Task API — one deep, source-cited Task per item. Returns each
 * confirmed-open item with corrected amount/deadline + a citation URL + confidence.
 * Drops items Parallel marks closed; keeps items whose Task errored as unverified
 * (so a transient API blip never silently loses a real grant).
 */
async function verifyViaParallel(items: SpineItem[], label: string, cap: number): Promise<SpineItem[]> {
  const toCheck = items.slice(0, cap);
  if (!toCheck.length) return [];
  const results = await verifyOpportunities(
    toCheck.map(it => ({ name: it.name, amount: it.amount, deadline: it.deadline, url: it.url })),
    { wire: label },
  );
  const out: SpineItem[] = [];
  let verified = 0, dropped = 0, unverified = 0;
  toCheck.forEach((it, i) => {
    const r = results[i];
    if (!r) { out.push(it); unverified++; return; }   // Task errored → keep, unverified
    if (!r.is_open) { dropped++; return; }              // confirmed closed → drop
    verified++;
    out.push({
      ...it,
      amount: r.amount || it.amount,
      deadline: r.deadline || it.deadline,
      url: r.apply_url || it.url,
      citationUrl: r.citationUrl,
      confidence: r.confidence,
    });
  });
  console.log(`[Weekly] parallel-verify ${label}: ${toCheck.length} checked -> ${verified} verified-open, ${unverified} unverified-kept, ${dropped} dropped`);
  return out;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runWeeklyIssue(
  pool: Pool,
  options: { onProgress?: (msg: string, pct: number) => void; skipEmail?: boolean; skipStore?: boolean } = {},
): Promise<WeeklyIssueResult> {
  const progress = options.onProgress || (() => {});
  const runDate = new Date().toISOString().split('T')[0];

  const prior = await getAppState<{ date: string; markdown: string }>(PRIOR_ISSUE_KEY).catch(() => null);
  const windowStart = prior?.date
    ? `${prior.date}T00:00:00Z`
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  progress('Gathering published feed since last issue...', 8);
  const spineRaw = await gatherSpine(pool, windowStart);

  // Verify against live sources. Parallel Task API (cited + confidence) is the primary
  // path; the Firecrawl scrape+judge loop is the fallback when Parallel is unavailable.
  const useParallel = parallelAvailable();
  progress(`Verifying ${spineRaw.length} published via ${useParallel ? 'Parallel (cited)' : 'scrape'}...`, 22);
  let spine: SpineItem[];
  if (useParallel) {
    try {
      spine = await verifyViaParallel(spineRaw, 'spine', 40);
    } catch (e) {
      console.error('[Weekly] Parallel verify failed, falling back to scrape:', e instanceof Error ? e.message : e);
      spine = await verifyItems(spineRaw, 'spine', 40);
    }
  } else {
    spine = await verifyItems(spineRaw, 'spine', 40);
  }
  console.log(`[Weekly] verified: spine ${spineRaw.length}->${spine.length}`);

  // Per-beat selection: dedupe, drop last week's repeats, split top 5-6 featured / rest also-open.
  // Featured AND also-open both come only from what actually published (fidelity to the channels).
  const selections = WIRES.map((w) => {
    let items = spine.filter((s) => (s.wire || '').toLowerCase() === w.key);
    items = dedupeItems(items);
    items = stripPriorIssueItems(items, prior?.markdown || null);
    const { featured, alsoOpen } = splitByScore(items, FEATURED_PER_WIRE);
    return { ...w, featured, alsoOpen };
  });

  // Hybrid: one batched call writes every description; structure stays deterministic.
  progress('Writing item descriptions...', 60);
  const toDescribe: Array<{ it: SpineItem; kind: 'featured' | 'alsoopen' }> = [];
  for (const s of selections) {
    s.featured.forEach((it) => toDescribe.push({ it, kind: 'featured' }));
    s.alsoOpen.forEach((it) => toDescribe.push({ it, kind: 'alsoopen' }));
  }
  const descMap = await writeDescriptions(toDescribe);

  const blocks: WireBlock[] = selections.map((s) => ({
    label: s.label,
    featured: s.featured.map((it) => ({ name: it.name, url: it.url, description: descMap.get(it.url) || fallbackDesc(it, 'featured') })),
    alsoOpen: s.alsoOpen.map((it) => ({ name: it.name, url: it.url, description: descMap.get(it.url) || fallbackDesc(it, 'alsoopen') })),
  }));

  const weekEnding = formatWeekEnding(new Date());
  const markdown = assembleIssue({ weekEnding, blocks });

  const prevWeek = await getAppState<number>(WEEK_NUMBER_KEY).catch(() => null);
  const weekNumber = (typeof prevWeek === 'number' ? prevWeek : WEEK_NUMBER_SEED) + 1;

  const spineCount = selections.reduce((n, s) => n + s.featured.length, 0);
  const alsoOpenCount = selections.reduce((n, s) => n + s.alsoOpen.length, 0);

  progress('Emailing + landing in Notion Paste Log...', 85);
  let emailed = false;
  if (!options.skipEmail) {
    try {
      await sendWeeklyDraftEmail(markdown, { runDate, spineCount, alsoOpenCount });
      emailed = true;
    } catch (err) {
      console.error('[Weekly] Failed to email draft:', err instanceof Error ? err.message : err);
    }

    // Land the draft in the Notion Paste Log (rendered rich text → copy into Substack).
    // Fails soft if the integration isn't shared on the Paste Log page yet.
    const land = await landWeeklyInPasteLog(`${runDate} — Grant Wire Weekly — Week ${weekNumber} — Substack paste copy`, markdown);
    if (land.ok) console.log(`[Weekly] Landed in Notion Paste Log: ${land.url}`);
    else console.warn(`[Weekly] Notion Paste Log landing skipped: ${land.error} (share the Paste Log page with the Wire Room Ops integration)`);
  }

  // Store as the prior issue for next week's lookback + repeat-dedup, and bump the week number.
  if (!options.skipStore) {
    try { await setAppState(PRIOR_ISSUE_KEY, { date: runDate, markdown }); } catch { /* non-fatal */ }
    try { await setAppState(WEEK_NUMBER_KEY, weekNumber); } catch { /* non-fatal */ }
  }

  progress('Weekly issue complete', 100);
  console.log(`[Weekly] ${runDate}: week=${weekNumber}, featured=${spineCount}, alsoOpen=${alsoOpenCount}, prior=${prior ? 'yes' : 'no'}, emailed=${emailed}`);
  return { runDate, weekNumber, spineCount, alsoOpenCount, hadPriorIssue: !!prior, markdown, emailed };
}
