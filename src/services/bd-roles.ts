/**
 * BD roles lane (Phase B of the BD loop).
 *
 * Registry-driven ingestion of senior role openings (BD / partnerships /
 * ecosystem / grants / governance / ops / chief-of-staff / revenue) across
 * crypto, AI, and OSS orgs — the second opportunity type of the BD loop and
 * the structural fix for the crypto-heavy lane mix (each source carries an
 * explicit lane tag).
 *
 * Design notes:
 * - Sources are org ATS JSON APIs (Greenhouse/Ashby, no auth) and clean RSS
 *   boards — fresh BY CONSTRUCTION, so role leads skip the Parallel verify
 *   stage (that stage exists to kill stale headlines; a posting present in
 *   today's API response cannot be stale). They still pass the SOV_SHAPE
 *   qualifier before surfacing.
 * - Net-new gating via an app_state URL watermark per source
 *   (`bd:roles:seen:<key>`), same pattern as source-feeds; the caller flushes
 *   watermarks ONLY after the Notion write succeeds (the Phase-3 lesson:
 *   never mark items seen before they are durably persisted).
 * - FIND + QUALIFY ONLY: this module fetches public job boards and returns
 *   data. It contacts no one and imports no send path.
 */
import { parseFeed, FeedSource } from './source-feeds';

export type RoleLane = 'crypto' | 'ai' | 'oss';

export interface RoleSource {
  key: string;                 // stable id, used in the watermark key
  org: string;                 // human org label
  lane: RoleLane;              // lane tag — feeds the shortlist lane-mix gauge
  method: 'greenhouse' | 'ashby' | 'rss';
  slug?: string;               // greenhouse/ashby board slug
  url?: string;                // rss feed url
  enabled: boolean;
  /** aggregate job board (not a single org's ATS): extract the hiring org from the posting title */
  aggregate?: boolean;
  note?: string;
}

export interface RolePosting {
  sourceKey: string;
  lane: RoleLane;
  org: string;
  title: string;
  url: string;
  location: string | null;
  comp: string | null;
  publishedAt: string | null;  // ISO if known
}

/**
 * The verified registry (live-tested 2026-06-16, re-verified 2026-07-03).
 * Adding a source is config, not architecture. Scrape-only boards
 * (findweb3/dao, aisafety.com/jobs, 80000hours) are deliberately deferred —
 * the ATS + RSS set covers the target orgs cleanly with zero parsing risk.
 */
export const ROLES_REGISTRY: RoleSource[] = [
  // ── AI ──────────────────────────────────────────────────────────────
  { key: 'gh-anthropic', org: 'Anthropic', lane: 'ai', method: 'greenhouse', slug: 'anthropic', enabled: true },
  { key: 'gh-scaleai', org: 'Scale AI', lane: 'ai', method: 'greenhouse', slug: 'scaleai', enabled: true },
  { key: 'ashby-openai', org: 'OpenAI', lane: 'ai', method: 'ashby', slug: 'openai', enabled: true },
  { key: 'ashby-cohere', org: 'Cohere', lane: 'ai', method: 'ashby', slug: 'cohere', enabled: true },
  { key: 'ashby-elevenlabs', org: 'ElevenLabs', lane: 'ai', method: 'ashby', slug: 'elevenlabs', enabled: true },
  { key: 'ashby-perplexity', org: 'Perplexity', lane: 'ai', method: 'ashby', slug: 'perplexity', enabled: true },
  // ── OSS ─────────────────────────────────────────────────────────────
  { key: 'rss-linuxfoundation', org: 'Linux Foundation', lane: 'oss', method: 'rss', url: 'https://careers.linuxfoundation.org/jobs.rss', enabled: true, note: 'covers all LF orgs (CNCF, OpenSSF, OpenInfra) in one feed' },
  { key: 'rss-fossjobs', org: 'FOSS Jobs board', lane: 'oss', method: 'rss', url: 'https://www.fossjobs.net/rss/all/', enabled: true, aggregate: true },
  { key: 'gh-mozilla', org: 'Mozilla', lane: 'oss', method: 'greenhouse', slug: 'mozilla', enabled: true },
  { key: 'gh-wikimedia', org: 'Wikimedia', lane: 'oss', method: 'greenhouse', slug: 'wikimedia', enabled: true },
  // ── Crypto ──────────────────────────────────────────────────────────
  { key: 'ashby-sky', org: 'Sky (MakerDAO)', lane: 'crypto', method: 'ashby', slug: 'skyecosystem', enabled: true },
  { key: 'ashby-sui', org: 'Sui Foundation', lane: 'crypto', method: 'ashby', slug: 'sui%20foundation', enabled: true },
  { key: 'ashby-starknet', org: 'Starknet Foundation', lane: 'crypto', method: 'ashby', slug: 'starknetfoundation', enabled: true },
  { key: 'ashby-monad', org: 'Monad Foundation', lane: 'crypto', method: 'ashby', slug: 'monad.foundation', enabled: true },
  { key: 'ashby-p2p', org: 'P2P.org', lane: 'crypto', method: 'ashby', slug: 'p2p.org', enabled: true },
  { key: 'ashby-kraken', org: 'Kraken', lane: 'crypto', method: 'ashby', slug: 'kraken.com', enabled: true },
  { key: 'gh-a16z', org: 'a16z', lane: 'crypto', method: 'greenhouse', slug: 'a16z', enabled: true },
];

// ── Role taxonomy filter ─────────────────────────────────────────────────
// Cheap title gate BEFORE the LLM qualifier: Sov's lane is senior
// BD/partnerships/ecosystem/grants/governance/ops/CoS/revenue — not
// engineering, not junior, not sales-floor.
const ROLE_KEYWORDS = /(business development|\bbd\b|partnerships?\b|alliances|ecosystem|grants?\b|grant.?making|governance|operations|\bops\b|chief of staff|revenue|program (officer|manager|director|lead)|go.?to.?market|\bgtm\b|corp(orate)? dev|foundation (director|lead|manager))/i;
const SENIORITY = /(head|director|vp\b|vice president|lead\b|chief|principal|general manager|\bgm\b|manager|officer|steward)/i;
const EXCLUDE = /(engineer|engineering|developer|scientist|research(er)?\b|intern(ship)?|counsel|attorney|paralegal|recruit(er|ing)|designer|support\b|accountant|account (executive|manager)|\bsdr\b|customer|success manager|community manager|content|marketing manager|social media|it manager|security|infrastructure|lead gen(eration)?|technical program|escalations)/i;

export function roleMatchesLane(title: string): boolean {
  const t = title.trim();
  if (!t) return false;
  return ROLE_KEYWORDS.test(t) && SENIORITY.test(t) && !EXCLUDE.test(t);
}

/**
 * For aggregate boards, split a posting title like
 * "[Full-time] Program Manager - Sovereign Tech Fund (all genders) at Sovereign Tech Agency"
 * into { title, org } so the lead reads as the HIRING ORG, not the board.
 * Falls back to the source org label when no " at " marker exists.
 */
export function splitAggregateTitle(raw: string, fallbackOrg: string): { title: string; org: string } {
  const cleaned = raw.replace(/^\[[^\]]{1,30}\]\s*/, '').trim();  // strip "[Full-time] " style prefixes
  const m = cleaned.match(/^(.*)\s+at\s+([^,]{2,80})$/i);
  if (m && m[1].trim() && m[2].trim()) {
    return { title: m[1].trim(), org: m[2].trim() };
  }
  return { title: cleaned || raw.trim(), org: fallbackOrg };
}

// ── Per-method parsers (pure — unit-tested against fixture JSON) ────────
export function parseGreenhouse(json: unknown, src: RoleSource): RolePosting[] {
  const jobs = (json as { jobs?: Array<Record<string, unknown>> })?.jobs || [];
  return jobs.map(j => ({
    sourceKey: src.key,
    lane: src.lane,
    org: src.org,
    title: String(j.title || '').trim(),
    url: String(j.absolute_url || ''),
    location: (j.location as { name?: string } | undefined)?.name || null,
    comp: null,
    publishedAt: typeof j.updated_at === 'string' ? j.updated_at : null,
  })).filter(p => p.title && p.url);
}

export function parseAshby(json: unknown, src: RoleSource): RolePosting[] {
  const jobs = (json as { jobs?: Array<Record<string, unknown>> })?.jobs || [];
  return jobs.map(j => ({
    sourceKey: src.key,
    lane: src.lane,
    org: src.org,
    title: String(j.title || '').trim(),
    url: String(j.jobUrl || j.applyUrl || ''),
    location: typeof j.location === 'string' ? j.location : null,
    comp: (j.compensation as { compensationTierSummary?: string } | undefined)?.compensationTierSummary || null,
    publishedAt: typeof j.publishedAt === 'string' ? j.publishedAt : null,
  })).filter(p => p.title && p.url);
}

function parseRssRoles(xml: string, src: RoleSource): RolePosting[] {
  // Reuse the hand-rolled RSS/Atom parser from source-feeds via a synthetic
  // FeedSource (the parser only reads fixed RSS fields + key/name for logs).
  const synthetic: FeedSource = {
    key: src.key, name: src.org, wire: src.lane, method: 'rss', endpoint: src.url || '', enabled: true,
  };
  return parseFeed(xml, synthetic).map(it => {
    const { title, org } = src.aggregate
      ? splitAggregateTitle(it.name, src.org)
      : { title: it.name, org: src.org };
    return {
      sourceKey: src.key,
      lane: src.lane,
      org,
      title,
      url: it.url,
      location: null,
      comp: null,
      publishedAt: it.publishedAt,
    };
  }).filter(p => p.title && p.url);
}

// ── Fetch ────────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function fetchRoleSource(src: RoleSource, fetchImpl: typeof fetch = fetch): Promise<RolePosting[]> {
  const timeout = AbortSignal.timeout(20_000);
  if (src.method === 'greenhouse') {
    const resp = await fetchImpl(`https://boards-api.greenhouse.io/v1/boards/${src.slug}/jobs?content=false`, { signal: timeout });
    if (!resp.ok) throw new Error(`greenhouse ${src.slug}: ${resp.status}`);
    return parseGreenhouse(await resp.json(), src);
  }
  if (src.method === 'ashby') {
    const resp = await fetchImpl(`https://api.ashbyhq.com/posting-api/job-board/${src.slug}?includeCompensation=true`, { signal: timeout });
    if (!resp.ok) throw new Error(`ashby ${src.slug}: ${resp.status}`);
    return parseAshby(await resp.json(), src);
  }
  // rss
  const resp = await fetchImpl(src.url!, { signal: timeout, headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml' } });
  if (!resp.ok) throw new Error(`rss ${src.key}: ${resp.status}`);
  return parseRssRoles(await resp.text(), src);
}

// ── Net-new selection (pure — unit-tested) ───────────────────────────────
export const ROLES_SEEN_CAP = 800;
export const ROLES_FIRST_RUN_LIMIT = 8;

export interface FreshRolesResult {
  fresh: RolePosting[];        // postings to qualify this run
  seenUrls: string[];          // the NEW full seen-set to persist (post-run)
  firstRunCapped: boolean;
}

/**
 * Given this fetch's lane-fit postings and the previously-seen URL set,
 * return the net-new postings plus the updated seen-set. First run of a
 * source: cap submissions to the newest ROLES_FIRST_RUN_LIMIT but mark the
 * whole backlog seen so activation doesn't flood the shortlist.
 */
export function pickFreshRoles(postings: RolePosting[], prevSeen: string[] | null): FreshRolesResult {
  const firstRun = prevSeen === null;
  const seen = new Set((prevSeen || []).map(u => u.trim()));
  const batch = new Set<string>();
  let fresh: RolePosting[] = [];
  for (const p of postings) {
    const u = p.url.trim();
    if (seen.has(u) || batch.has(u)) continue;
    batch.add(u);
    fresh.push(p);
  }
  let firstRunCapped = false;
  if (firstRun && fresh.length > ROLES_FIRST_RUN_LIMIT) {
    fresh = fresh.slice().sort((a, b) => (Date.parse(b.publishedAt || '') || 0) - (Date.parse(a.publishedAt || '') || 0)).slice(0, ROLES_FIRST_RUN_LIMIT);
    firstRunCapped = true;
  }
  const merged: string[] = [];
  const s = new Set<string>();
  for (const u of [...postings.map(p => p.url.trim()), ...(prevSeen || [])]) {
    if (!u || s.has(u)) continue;
    s.add(u);
    merged.push(u);
    if (merged.length >= ROLES_SEEN_CAP) break;
  }
  return { fresh, seenUrls: merged, firstRunCapped };
}

export function enabledRoleSources(): RoleSource[] {
  return ROLES_REGISTRY.filter(s => s.enabled);
}
