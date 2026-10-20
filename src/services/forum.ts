/**
 * Forum Service — discuss.watch API client
 *
 * Governance-forum discovery lane. Per wire:
 *   1. Pull candidate threads from a curated governance/grants forum allowlist
 *      (plus a `hot` catch-all); known older topics can surface source changes.
 *   2. LLM-judge each thread (opportunity / not) and extract structured fields.
 *
 * Opportunities are mapped to RawScanResult[] for the intake pipeline.
 * Replaces the retired broad-keyword dual scan (2% approve / 67% dupe).
 * Rate limit: ~14 req/min (4.2s delay between requests).
 */

import { config } from '../config';
import type { Pool } from 'pg';
import type { RawScanResult } from '../types/intake';
import { findForumHistoryByHost, forumFingerprint, forumTopicKey, forumObservationAlreadySeen, forumObservationMayBeNew, forumPriorReviewable, forumUpdateEligible, stampForumObservation, storedForumObservation, trustedForumObservation, forumUpdateNote, type ForumObservation, type ForumHistoryEntry } from './forum-seen';
import { sleep } from '../utils/async';
import { getCachedProvider } from './api-provider';
import { logApiUsage } from './api-usage';
import { DEFAULT_GROK_MODEL, chatCompletionExtras } from './grok';

// --- Wire-to-category mapping (discuss.watch categories match wire keys) ---
// Wire keys map 1:1 to discuss.watch categories today; keeping the map
// explicit so the mapping is easy to change if they diverge.
const WIRE_CATEGORY_MAP: Record<string, string> = {
  crypto: 'crypto',
  ai: 'ai',
  oss: 'oss',
};

// Rate limit: ~14 req/min = 4.2s between requests
const REQUEST_DELAY_MS = 4300;

// --- Interfaces ---

export interface ForumScanOptions {
  wire?: string;
  since?: string;
  onProgress?: (message: string, pct: number) => void;
  /** Supplied only by the in-process forum job, never by an intake request. */
  pool?: Pool;
}

// Retained name for the orchestrator's options (was the dual-scan option shape).
export type DualForumScanOptions = ForumScanOptions;

export interface WireResults {
  wire: string;
  results: RawScanResult[];
}

interface DiscussWatchDiscussion {
  id?: string | number;
  title?: string;
  url?: string;
  forum?: { name?: string; url?: string; token?: string };
  createdAt?: string;
  lastActivityAt?: string;
  replies?: number;
  views?: number;
  likes?: number;
  isHot?: boolean;
}

interface DiscussWatchDiscussionsResponse {
  data?: DiscussWatchDiscussion[];
  meta?: { total?: number; category?: string; forums?: number };
  error?: string;
}

/**
 * Extract dollar amount from text using simple regex patterns.
 * Handles: $100K, $1.5M, $50,000, $1 million, etc.
 */
function extractAmount(text: string): string | null {
  if (!text) return null;

  const patterns = [
    /\$[\d,.]+\s*[Mm](?:illion)?/,
    /\$[\d,.]+\s*[Bb](?:illion)?/,
    /\$[\d,.]+\s*[Kk]/,
    /\$[\d,]+(?:\.\d+)?/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }

  return null;
}

// Lowercase and strip a trailing slash only. Keep the fragment: Snapshot
// proposal links are hash routes, and dropping it would merge distinct proposals.
function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/\/+$/, '');
}

// Max age for forum discussions: only ingest posts created within this window.
// The discuss.watch `since` param filters by lastActivityAt (bumps), not createdAt,
// so old posts with new comments would slip through without this check.
const MAX_DISCUSSION_AGE_DAYS = 30;

/**
 * Keyword pre-filter for grants-ecosystem relevance. Used as the FALLBACK gate
 * when the LLM judge is unavailable (no key) or a batch errors — degrades to the
 * old keyword behavior rather than dropping or flooding candidates.
 */
// Keyword fallback when the LLM judge is down. Open calls plus wire areas
// 1–6 (results, treasury moves, incentives). The judge is the primary gate.
export const RELEVANCE_KEYWORDS = [
  // Core funding signals
  'grant program', 'grants program', 'funding opportunity', 'funding round',
  'bounty program', 'bug bounty', 'hackathon', 'fellowship program',
  'rfp', 'treasury proposal', 'budget proposal', 'funded by',
  'sponsorship program', 'developer program', 'contributor program',
  'open call', 'call for proposals', 'applications open', 'apply now',
  // Program names
  'GSoC', 'Google Summer of Code', 'Outreachy', 'LFX', 'Ethereum Foundation',
  'retro funding', 'retroactive funding', 'public goods funding',
  // Active opportunity indicators
  'applications are open', 'deadline', 'apply here', 'accepting applications',
  'rolling applications', 'stipend', 'scholarship program', 'residency program',
  'accelerator program', 'incubator program', 'grant round',
  'awarded', 'recipients', 'results', 'retro', 'treasury', 'allocation',
  'incentive', 'rewards', 'credits',
];

// Titles that indicate student proposals, project updates, or releases — not funding opportunities.
// These should be EXCLUDED even if they match relevance keywords.
const EXCLUSION_PATTERNS = [
  /\[gsoc\s*\d*\].*:.*proposal/i,  // "[GSoC 2026] Project: Proposal"
  /\[gsoc\d*\].*:.*proposal/i,      // "[GSoC2026] Project: Proposal"
  /proposal review/i,                // "GSoC 2026] Proposal Review"
  /\[draft proposal\]/i,            // "[Draft Proposal] ..."
  /looking for speaker/i,            // "Conference looking for speakers"
  /\[ann\]/i,                       // Software announcements
  /release\s+v?\d/i,                // Version releases
  /rfc:\s/i,                        // RFC discussions
  /^re:\s/i,                        // Reply threads
];

function isRelevantDiscussion(title: string): boolean {
  const lower = title.toLowerCase();

  // Exclude project proposals, releases, and discussions
  if (EXCLUSION_PATTERNS.some(p => p.test(title))) {
    return false;
  }

  return RELEVANCE_KEYWORDS.some(kw => lower.includes(kw));
}

// =====================================================================
// Governance-forum lane (the primary, current forum strategy)
// =====================================================================
//
// The forum layer is overwhelmingly a CRYPTO-GOVERNANCE signal. DAO treasuries,
// grants councils, and ecosystem funds announce — and renew — programs as
// governance proposals, which is the EARLIEST possible signal (often before any
// external announcement). The retired dual-scan (broad /search keywords across all
// 335 forums) drowned in noise; this lane instead pulls from a curated allowlist of
// forums that actually fund, then lets an LLM make the opportunity/not call.
//
// AI/OSS category forums are dev-tooling and project-support boards, NOT funders, so
// their allowlists are intentionally thin and lean on the `hot` catch-all + the LLM
// judge. (Real AI/OSS funding signal arrives via EA Forum and funder feeds — other lanes.)
//
// Names are matched LOWERCASED against discuss.watch forum names (the `forums=`
// filter does a lowercased-name match; multi-word names work). Grounded in the live
// /forums list (verified 2026-06-13).
const GOVERNANCE_ALLOWLIST: Record<string, string[]> = {
  // v2 (2026-06-13) — trimmed from 42 to 22 after a live 90-day activity probe + a
  // per-forum web-verification audit. The old list assumed grant-keyword traffic meant
  // harvestable on-forum opportunities; in 2026 it mostly means governance/treasury
  // noise. ~20 forums were dropped because their grant INTAKE migrated to portals
  // (Questbook/Charmverse/Gitcoin/Karma) or foundation sites (ENS, Solana, Avalanche,
  // Aptos, Mantle, Linea, Taiko, NEAR, dYdX, Starknet…) or wound down entirely
  // (Aave grants DAO closed Aug-2024, Compound CGP defunct since 2024). Standards/
  // research venues (ethereum magicians/research) post no opportunities. What remains:
  // forums where the grant PROCESS or clean early-signal actually appears ON Discourse.
  crypto: [
    // Active grants councils / RFP venues with genuine on-forum intake (probe-confirmed)
    'optimism', 'gitcoin', 'cow protocol', 'eigenlayer', 'scroll', 'balancer',
    'morpho', 'celo', 'lido finance', 'stacks',
    // On-forum grant PROCESS — proposals submitted + voted directly on Discourse
    // (the lane's sweet spot; added v2)
    'zcash', 'aztec', 'neutron', 'safedao', 'iotex', 'moonbeam',
    // Big-DAO early-signal — program creation/renewal surfaces on-forum as governance
    // even when the apply step is off-forum
    // Polkadot and Cosmos Hub were dropped 2026-10-20: in a two-day sample
    // Polkadot alone was 16 of 43 crypto candidates, and both were almost all
    // delegate, digest and treasury chatter. Hot threads still use the catch-all.
    'arbitrum', 'zksync era', 'polygon', 'sui',
    // Re-added 2026-07-03 (recall re-measure): the v2 trim assumed ENS intake had
    // fully migrated to the grants portal, but SPP Season 3's application thread
    // ran ON discuss.ens.domains (ratified via Snapshot 2026-05-10, $2.89M cohort)
    // and the lane missed it. ENS carries real on-forum program signal.
    'ens',
  ],
  ai: [
    // The one funding-signal forum in the AI category; the rest is dev tooling.
    'ea forum',
  ],
  oss: [
    // OSS funding rarely originates on project-support forums; rely on `hot` + LLM.
  ],
};

// Orgs we never surface, regardless of allowlist or hot catch-all (EXCLUDED_ORGS).
const FORUM_SKIP_PATTERNS: RegExp[] = config.forum.excludedOrgs;

const JUDGE_BATCH_SIZE = 12;

// =====================================================================
// discuss.watch pre-classified grants feed (lane v3, 2026-07-06)
// =====================================================================
//
// discuss.watch now runs its own classification pipeline server-side:
// full first-post bodies (via Discourse RSS + dedicated grants categories
// on 10 DAO forums + the EA Forum funding tag) -> Haiku classification in
// THIS system's vocabulary (GRANT/NEWS/NOISE) + field extraction
// (program, amounts, deadline, status). GET /api/v1/grants serves items
// pre-judged with confidence scores.
//
// This pull complements (not replaces) the allowlist+judge path: the feed
// covers 196 forums with body-level classification, while the judge path
// still uniquely catches governance proposals that create/renew programs
// (classified NEWS server-side) on the curated allowlist. URLs surfaced
// by the feed are excluded from the judge batch — pre-judged items should
// not re-spend Grok. Kill switch: FORUM_GRANTS_FEED_ENABLED=false.

interface GrantsFeedItem {
  id?: string | number;
  name?: string;
  title?: string;
  url?: string;
  wire?: string;
  protocol?: string | null;
  classification?: string;
  kind?: string | null;
  confidence?: number;
  program?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  currency?: string | null;
  deadline?: string | null;
  status?: string | null;
  excerpt?: string | null;
  topicCreatedAt?: string | null;
  firstSeenAt?: string;
  lastActivityAt?: string | null;
  engagement?: { replies?: number };
}

interface GrantsFeedResponse {
  items?: GrantsFeedItem[];
  meta?: { count?: number; nextCursor?: number | null; configured?: boolean };
  error?: string;
}

/** Compose a human-readable amount string from extracted numeric fields. */
function formatFeedAmount(item: GrantsFeedItem): string | null {
  const max = item.amountMax ?? item.amountMin;
  if (max == null || !Number.isFinite(max)) return null;
  const min = item.amountMin;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const range = min != null && Number.isFinite(min) && min !== max ? `${fmt(min)}–${fmt(max)}` : fmt(max);
  const currency = (item.currency || '').trim().toUpperCase();
  const composed = !currency || currency === 'USD' ? `$${range}` : `${range} ${currency}`;
  return composed.slice(0, 60);
}

/** Map a pre-classified discuss.watch grants item to a RawScanResult. */
export function grantsFeedItemToRaw(item: GrantsFeedItem): RawScanResult {
  const title = (item.title || item.name || '').trim();
  const program = item.program?.trim() || '';
  // The thread headline is the entry name. The extracted program string is
  // often that same headline, and using it as `name` collapsed distinct
  // threads (and every application under one program) during exact-name dedup.
  // Program stays in metadata and in the description.
  const name = (title || program).slice(0, 200);
  const forumLabel = item.protocol ? `${item.protocol} forum` : 'Governance forum';

  const parts: string[] = [];
  parts.push(item.excerpt?.trim() ? item.excerpt.trim().slice(0, 280) : title);
  if (program) parts.push(`Program: ${program}`);
  if (item.status?.trim()) parts.push(`Signal: ${item.status.trim()}`);
  parts.push(`Source: ${forumLabel} (discuss.watch grants feed, ${item.confidence ?? 0}% ${item.kind || 'grant'})`);

  const metadata: Record<string, unknown> = {};
  if (program) metadata.program = program;

  const raw: RawScanResult = {
    name,
    description: parts.join(' — '),
    sourceUrl: item.url || '',
    amount: formatFeedAmount(item),
    deadline: item.deadline ? String(item.deadline).slice(0, 10) : null,
    sourcePublishedAt: item.topicCreatedAt || item.firstSeenAt || null,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
  return stampForumObservation(raw, {
    version: 1, topicKey: forumTopicKey(raw.sourceUrl),
    revision: forumFingerprint([title, item.lastActivityAt || item.topicCreatedAt || null, item.engagement?.replies ?? 0]),
    fingerprint: forumFingerprint([title, item.excerpt || '', program, item.status || null, item.amountMin ?? null, item.amountMax ?? null, item.currency || null, item.deadline || null]),
    originalPublishedAt: item.topicCreatedAt || null,
    lastActivityAt: item.lastActivityAt || item.topicCreatedAt || null,
    evidence: 'grants_feed', complete: false, excerpt: (item.excerpt || title).slice(0, 6000),
  });
}

/** Feed statuses that are never an open call. The feed's GRANT class still
 *  carries live votes, award results and closed calls; those skip the judge,
 *  so they are dropped here rather than queued. */
const GRANTS_FEED_DROPPED_STATUSES = new Set(['voting', 'awarded', 'closed']);

/** discuss.watch matches `status` exactly, so each comma-separated value is its own request. */
function grantsFeedStatusValues(status: string | undefined): Array<string | undefined> {
  if (status == null) return [undefined];
  const values = status.split(',').map(part => part.trim()).filter(Boolean);
  return values.length > 0 ? values : [undefined];
}

/** True when this item's id or URL was not already kept. Records it when new. */
function rememberGrantsFeedItem(
  seenIds: Set<string>,
  seenUrls: Set<string>,
  item: GrantsFeedItem,
): boolean {
  const id = item.id == null ? '' : String(item.id).trim();
  const url = item.url ? normalizeUrl(item.url) : '';
  if ((id !== '' && seenIds.has(id)) || (url !== '' && seenUrls.has(url))) return false;
  if (id !== '') seenIds.add(id);
  if (url !== '') seenUrls.add(url);
  return true;
}

/**
 * One /grants GET. Null on HTTP, API, or network failure (the caller fails soft).
 * An empty `items` array is a successful page.
 */
async function fetchGrantsFeedItems(
  baseUrl: string,
  params: URLSearchParams,
): Promise<GrantsFeedItem[] | null> {
  try {
    const response = await fetch(`${baseUrl}/grants?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.warn(`[Forum] /grants returned ${response.status} (${params.toString()})`);
      return null;
    }
    const data = await response.json() as GrantsFeedResponse;
    if (data.error || !Array.isArray(data.items)) {
      if (data.error) console.warn(`[Forum] /grants API error: ${data.error}`);
      return null;
    }
    return data.items;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Forum] /grants fetch failed: ${msg}`);
    return null;
  }
}

/**
 * Pull pre-classified feed items for one wire from discuss.watch.
 * A comma-separated `extra.status` is one request per exact status;
 * pages are merged and rows that share an item id or URL collapse.
 * Age-gated on topicCreatedAt (the feed's `since` filters firstSeenAt, and
 * its first sweeps surface old threads from dedicated grants categories).
 * Fails soft: a failed request contributes nothing, and every request failing
 * returns empty — the judge path still runs.
 */
export async function fetchGrantsFeedResults(
  wire: string,
  since: string,
  extra: Record<string, string> = {},
  includeRecentlyActive = false,
): Promise<{ results: RawScanResult[]; urls: Set<string> }> {
  const empty = { results: [] as RawScanResult[], urls: new Set<string>() };
  const baseUrl = config.forum.discussWatchBaseUrl;
  const { status: statusParam, ...rest } = extra;
  const statuses = grantsFeedStatusValues(statusParam);

  const items: GrantsFeedItem[] = [];
  let anySuccess = false;
  for (let i = 0; i < statuses.length; i++) {
    if (i > 0) await sleep(REQUEST_DELAY_MS);
    const params = new URLSearchParams({
      wire,
      since,
      min_confidence: String(config.forum.grantsMinConfidence),
      limit: '100',
      ...rest,
    });
    const status = statuses[i];
    if (status) params.set('status', status);
    const page = await fetchGrantsFeedItems(baseUrl, params);
    if (page == null) continue;
    anySuccess = true;
    items.push(...page);
  }
  if (!anySuccess) return empty;

  const ageCutoff = Date.now() - MAX_DISCUSSION_AGE_DAYS * 86400000;
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const results: RawScanResult[] = [];
  const urls = new Set<string>();
  for (const item of items) {
    if (!item.url || !(item.title || item.name)) continue;
    if (GRANTS_FEED_DROPPED_STATUSES.has((item.status || '').trim().toLowerCase())) continue;
    // Same exclusion-list skip as the judge path (matches protocol AND url)
    const skipHaystack = `${item.protocol || ''} ${item.url}`;
    if (FORUM_SKIP_PATTERNS.some(p => p.test(skipHaystack))) continue;
    // Age gate on the thread's original post date
    const created = item.topicCreatedAt ? new Date(item.topicCreatedAt).getTime() : NaN;
      if (!Number.isNaN(created) && created < ageCutoff
          && !(includeRecentlyActive && item.lastActivityAt && Date.parse(item.lastActivityAt) >= Date.parse(since))) continue;
    if (!rememberGrantsFeedItem(seenIds, seenUrls, item)) continue;
    const raw = grantsFeedItemToRaw(item);
    if (!raw.sourceUrl) continue;
    results.push(raw);
    urls.add(normalizeUrl(raw.sourceUrl));
  }
  console.log(`[Forum] ${wire} grants feed: ${results.length} pre-classified items (of ${items.length} returned)`);
  return { results, urls };
}

export interface ForumCandidate {
  title: string;
  url: string;
  forumName: string;
  createdAt: string | null;
  lastActivityAt?: string | null;
  replies: number;
  views: number;
  source: 'allowlist' | 'hot';
}

export interface GovernanceForumScanResult {
  byWire: WireResults[];
  candidateCount: number;
  opportunityCount: number;
}

/**
 * Thin GET wrapper for discuss.watch /discussions with one 429 retry.
 * Returns the parsed response or null on any failure (the lane fails soft).
 */
async function fetchDiscussions(
  baseUrl: string,
  paramObj: Record<string, string>,
): Promise<DiscussWatchDiscussionsResponse | null> {
  const params = new URLSearchParams(paramObj);
  let retried = false;
  const attempt = async (): Promise<DiscussWatchDiscussionsResponse | null> => {
    try {
      const response = await fetch(`${baseUrl}/discussions?${params}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        if (response.status === 429 && !retried) {
          retried = true;
          console.warn('[Forum] Rate limited on /discussions, waiting 10s and retrying...');
          await sleep(10000);
          return attempt();
        }
        console.warn(`[Forum] /discussions returned ${response.status} (${params.toString()})`);
        return null;
      }
      const data = await response.json() as DiscussWatchDiscussionsResponse;
      if (data.error) {
        console.warn(`[Forum] /discussions API error: ${data.error}`);
        return null;
      }
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Forum] /discussions fetch failed: ${msg}`);
      return null;
    }
  };
  return attempt();
}

/**
 * Pull governance-forum candidates for one wire: the curated allowlist (freshest
 * threads, sort=new) plus a `hot=true` catch-all for high-engagement threads from
 * non-allowlist forums. Age-gated on original post date (createdAt) because the
 * `since=` param filters lastActivityAt, not createdAt. No keyword pre-filter here —
 * the LLM judge decides relevance, so the lane stays recall-leaning.
 */
export async function fetchGovernanceForumCandidates(
  wire: string,
  since: string,
  onProgress?: (msg: string, pct: number) => void,
  includeRecentlyActive = false,
): Promise<ForumCandidate[]> {
  const baseUrl = config.forum.discussWatchBaseUrl;
  const category = WIRE_CATEGORY_MAP[wire] || wire;
  const allowlist = GOVERNANCE_ALLOWLIST[wire] || [];
  const progress = onProgress || (() => {});
  const ageCutoff = Date.now() - MAX_DISCUSSION_AGE_DAYS * 86400000;

  const candidates = new Map<string, ForumCandidate>(); // keyed by normalized url

  const ingest = (items: DiscussWatchDiscussion[] | undefined, src: 'allowlist' | 'hot') => {
    for (const item of items || []) {
      if (!item.url || !item.title) continue;
      // Age gate on original post date (since= filters lastActivityAt, not createdAt)
      if (item.createdAt && new Date(item.createdAt).getTime() < ageCutoff
          && !(includeRecentlyActive && item.lastActivityAt && Date.parse(item.lastActivityAt) >= Date.parse(since))) continue;
      const forumName = item.forum?.name || item.forum?.token || '';
      if (FORUM_SKIP_PATTERNS.some(p => p.test(forumName))) continue;
      const key = normalizeUrl(item.url);
      if (candidates.has(key)) continue;
      candidates.set(key, {
        title: item.title,
        url: item.url,
        forumName,
        createdAt: item.createdAt || null,
        lastActivityAt: item.lastActivityAt || item.createdAt || null,
        replies: item.replies ?? 0,
        views: item.views ?? 0,
        source: src,
      });
    }
  };

  // Pull 1: allowlist forums (the forums that actually fund), freshest first.
  if (allowlist.length > 0) {
    progress(`Pulling ${allowlist.length} ${category} governance forums`, 20);
    const data = await fetchDiscussions(baseUrl, {
      category,
      since,
      sort: 'new',
      limit: '60',
      forums: allowlist.join(','),
    });
    ingest(data?.data, 'allowlist');
    await sleep(REQUEST_DELAY_MS);
  }

  // Pull 2: hot catch-all — high-engagement threads from forums outside the allowlist.
  progress(`Pulling hot ${category} threads`, 60);
  const hotData = await fetchDiscussions(baseUrl, {
    category,
    since,
    sort: 'new',
    limit: '40',
    hot: 'true',
  });
  ingest(hotData?.data, 'hot');

  const out = [...candidates.values()];
  console.log(`[Forum] ${category} candidates: ${out.length} (allowlist=${allowlist.length} forums + hot, age<=${MAX_DISCUSSION_AGE_DAYS}d)`);
  return out;
}

/** Convert a forum candidate (optionally enriched by the LLM judge) into a RawScanResult. */
function candidateToRaw(c: ForumCandidate, judged: ForumJudgment | null): RawScanResult {
  const forumPrefix = c.forumName ? `${c.forumName} forum` : 'Governance forum';
  const eng = c.replies > 0 ? ` (${c.replies} replies)` : '';
  let name = c.title;
  let amount: string | null = extractAmount(c.title);
  let deadline: string | null = null;
  let description = `${forumPrefix}: ${c.title}${eng}`;

  if (judged) {
    if (judged.name && judged.name.trim()) name = judged.name.trim().slice(0, 200);
    const parts: string[] = [judged.summary?.trim() || c.title];
    if (judged.funder?.trim()) parts.push(`Funder: ${judged.funder.trim()}`);
    if (judged.signal_stage?.trim()) parts.push(`Signal: ${judged.signal_stage.trim()}`);
    parts.push(`Source: ${forumPrefix}${eng}`);
    description = parts.join(' — ');
    if (typeof judged.amount === 'string' && /\d/.test(judged.amount)) amount = judged.amount.trim().slice(0, 60);
    if (typeof judged.deadline === 'string' && judged.deadline.trim() && judged.deadline.trim().toLowerCase() !== 'null') {
      deadline = judged.deadline.trim().slice(0, 50);
    }
  }

  return {
    name,
    description,
    sourceUrl: c.url,
    amount,
    deadline,
    sourcePublishedAt: c.createdAt,
  };
}

export function forumCandidateRevision(c: ForumCandidate): string {
  return forumFingerprint([c.title.trim(), c.lastActivityAt || c.createdAt, c.replies]);
}

function sourceText(html: string): string {
  return html.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

/** Read only the existing discuss.watch detail adapter, at most 20 times per scan.
 * It can expose only part of a long thread; that limitation is retained in review. */
export async function captureForumObservation(c: ForumCandidate, budget: { remaining: number }): Promise<ForumObservation> {
  const observation: ForumObservation = {
    version: 1, topicKey: forumTopicKey(c.url), revision: forumCandidateRevision(c),
    fingerprint: forumFingerprint([c.title, c.lastActivityAt || c.createdAt, c.replies]),
    originalPublishedAt: c.createdAt, lastActivityAt: c.lastActivityAt || c.createdAt,
    evidence: 'activity_only', complete: false, excerpt: c.title,
  };
  let key: URL;
  try { key = new URL(observation.topicKey); } catch { return observation; }
  const topicId = key.pathname.match(/^\/t\/(\d+)$/)?.[1];
  if (!topicId || budget.remaining <= 0) return observation;
  budget.remaining--;
  const endpoint = new URL('../discourse/topic', config.forum.discussWatchBaseUrl.replace(/\/$/, '') + '/');
  endpoint.searchParams.set('forumUrl', key.origin);
  endpoint.searchParams.set('topicId', topicId);
  try {
    const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return observation;
    const data = await response.json() as { topic?: { id?: number; title?: string; postsCount?: number; posts?: Array<{ id?: number; postNumber?: number; content?: string }> } };
    const topic = data.topic;
    if (String(topic?.id) !== topicId || !Array.isArray(topic?.posts) || !topic.posts.length) return observation;
    const posts = topic.posts.filter(p => typeof p.content === 'string').map(p => ({
      id: p.id, number: p.postNumber, text: sourceText(p.content!),
      links: [...p.content!.matchAll(/href=["']([^"']+)["']/g)].map(match => match[1]),
    })).sort((a, b) => (a.number || 0) - (b.number || 0));
    if (!posts.length) return observation;
    const complete = Number.isInteger(topic.postsCount) && topic.postsCount === posts.length;
    const opening = posts[0].number === 1 ? posts[0] : undefined;
    return {
      ...observation, evidence: 'topic_detail', complete,
      ...(opening ? { postFingerprint: forumFingerprint([topic.title || c.title, opening.text, opening.links]) } : {}),
      // Engagement and timestamps cannot change a complete content fingerprint.
      // With partial detail, newer activity may be in the unreturned posts.
      fingerprint: forumFingerprint([topic.title || c.title, posts, complete ? null : observation.revision]),
      excerpt: posts.slice(-3).map(p => `Post ${p.number ?? p.id}: ${p.text.slice(0, 1800)}`).join('\n').slice(0, 6000),
    };
  } catch {
    return observation;
  }
}

function sameTopicHistory(url: string, history: ForumHistoryEntry[]): ForumHistoryEntry[] {
  const key = forumTopicKey(url);
  return history.filter(row => forumTopicKey(row.source_url) === key);
}

/** Legacy rows have no body snapshot: only a later authoritative source activity
 * can reopen them. A model's changed paraphrase or a newer scan date cannot. */
function updatedForumResult(raw: RawScanResult, observation: ForumObservation, prior: ForumHistoryEntry): RawScanResult {
  const old = storedForumObservation(prior);
  const contentChanged = old?.evidence === observation.evidence
    && ((old.complete && observation.complete) || observation.evidence === 'grants_feed');
  const update: ForumObservation = { ...observation, priorEntryId: prior.id, changeEvidence: contentChanged ? 'content' : 'activity' };
  const result = {
    ...raw,
    description: `${forumUpdateNote(update)}\n\nCurrent source evidence:\n${observation.excerpt}`,
    // Never turn latest activity into the thread's original publication date.
    sourcePublishedAt: observation.originalPublishedAt,
  };
  return stampForumObservation(result, update);
}

/** Reuse the daily scan: known changed topics go to source-check review; only
 * genuinely new topics spend the existing opportunity-judge call. */
export async function prepareForumObservations(
  pool: Pool, candidates: ForumCandidate[], feeds: RawScanResult[], budget: { remaining: number },
): Promise<{ candidates: ForumCandidate[]; feeds: RawScanResult[]; updates: RawScanResult[] }> {
  const history = await findForumHistoryByHost(pool, [...candidates.map(c => c.url), ...feeds.map(r => r.sourceUrl)]);
  const out = { candidates: [] as ForumCandidate[], feeds: [] as RawScanResult[], updates: [] as RawScanResult[] };
  const ageCutoff = Date.now() - MAX_DISCUSSION_AGE_DAYS * 86400000;
  for (const raw of feeds) {
    const priorRows = sameTopicHistory(raw.sourceUrl, history);
    const observation = trustedForumObservation(raw);
    if (!priorRows.length) {
      if (!raw.sourcePublishedAt || Date.parse(raw.sourcePublishedAt) >= ageCutoff) out.feeds.push(raw);
    } else if (observation && !forumObservationAlreadySeen(observation, priorRows)
        && forumObservationMayBeNew(observation, priorRows[0])
        && forumUpdateEligible(observation, priorRows)) {
      out.updates.push(updatedForumResult(raw, observation, priorRows[0]));
    }
  }
  for (const c of candidates) {
    const priorRows = sameTopicHistory(c.url, history);
    const prior = priorRows[0];
    if (!prior) {
      if (!c.createdAt || Date.parse(c.createdAt) >= ageCutoff) out.candidates.push(c);
      continue;
    }
    const old = storedForumObservation(prior);
    // Only an opening-post change can reopen a declined or archived topic, and
    // that needs a stored opening-post baseline. Without one, spend no detail read.
    if (!forumPriorReviewable(priorRows) && !priorRows.some(row => storedForumObservation(row)?.postFingerprint)) continue;
    // A first-post edit need not bump Discourse activity. Re-read a bounded
    // number of known detail snapshots even when the list revision is stable.
    // Without a prior detail baseline, an unchanged revision is not evidence
    // of a new event and must not trigger a historical replay.
    if (old?.revision === forumCandidateRevision(c)
        && (old.evidence !== 'topic_detail' || budget.remaining <= 0)) continue;
    if (old?.evidence === 'grants_feed' && old.lastActivityAt && c.lastActivityAt
        && Date.parse(c.lastActivityAt) <= Date.parse(old.lastActivityAt)) continue;
    if (!old && !forumObservationMayBeNew({
      version: 1, topicKey: forumTopicKey(c.url), revision: '', fingerprint: '',
      originalPublishedAt: c.createdAt, lastActivityAt: c.lastActivityAt || c.createdAt,
      evidence: 'activity_only', complete: false, excerpt: c.title,
    }, prior)) continue;
    const observation = await captureForumObservation(c, budget);
    if (old?.revision === observation.revision
        && (old.evidence !== observation.evidence || old.complete !== observation.complete)) continue;
    if (forumObservationAlreadySeen(observation, priorRows) || !forumObservationMayBeNew(observation, prior)) continue;
    if (!forumUpdateEligible(observation, priorRows)) continue;
    // If both adapters observed the change, retain one source-check candidate
    // with the thread detail, rather than one feed row plus one topic row.
    out.updates = out.updates.filter(raw => forumTopicKey(raw.sourceUrl) !== observation.topicKey);
    out.updates.push(updatedForumResult(candidateToRaw(c, null), observation, prior));
  }
  return out;
}


interface ForumJudgment {
  n?: number;
  is_opportunity?: boolean;
  name?: string;
  funder?: string;
  amount?: string;
  deadline?: string;
  signal_stage?: string;
  summary?: string;
}

export function buildForumJudgePrompt(batch: ForumCandidate[], wire: string): string {
  const wireLabel = wire === 'crypto' ? 'crypto / web3' : wire === 'ai' ? 'AI / ML' : 'open-source software';
  const lines = batch.map((c, i) => `${i + 1}. [${c.forumName || 'forum'}] ${c.title}`).join('\n');
  return `You are screening ${wireLabel} forum threads for the wire.

Find posts in wire areas 1–6: treasury/governance decisions that move capital or create/renew/change grant programs, grant round results and retros, open calls, incentive programs, and substantive analysis of funding mechanisms. NOT: delegate elections and comms, price/token talk, routine ops with no capital decision. Individual applications from a single team are not wire items unless the decision itself moves capital.

Set is_opportunity=true only for areas 1–6. Set is_opportunity=false for the NOT list and for anything outside those areas.

When unsure BUT the thread is a capital decision, a round result, or a named open program, lean is_opportunity=true — an operator reviews everything downstream.

For EACH numbered thread, return one JSON object. Respond with ONLY a JSON array (no prose, no markdown fences):
[{"n":1,"is_opportunity":true,"name":"<concise name, not the raw thread title>","funder":"<org or null>","amount":"<figure as written or null>","deadline":"<date / Rolling / null>","signal_stage":"proposed|open|awarded|voting|recurring","summary":"<one sentence of facts only: who, what, amount, date>"}]

signal_stage: "proposed" = governance proposal that moves capital or changes a grant framework; "open" = currently accepting; "awarded" = results, recipients, or a retro; "voting" = a live capital or framework vote; "recurring" = established rolling program.

Threads:
${lines}`;
}

function parseForumJudgeResponse(content: string, batch: ForumCandidate[]): RawScanResult[] {
  let arr: unknown;
  try {
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    const jsonStr = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
    arr = JSON.parse(jsonStr);
  } catch {
    // Parse failure → degrade to the keyword pre-filter for this batch (old behavior),
    // never a raw flood.
    return batch.filter(c => isRelevantDiscussion(c.title)).map(c => candidateToRaw(c, null));
  }
  if (!Array.isArray(arr)) {
    return batch.filter(c => isRelevantDiscussion(c.title)).map(c => candidateToRaw(c, null));
  }

  const byIndex = new Map<number, ForumJudgment>();
  for (const j of arr as ForumJudgment[]) {
    if (j && typeof j.n === 'number') byIndex.set(j.n, j);
  }

  const out: RawScanResult[] = [];
  for (let i = 0; i < batch.length; i++) {
    const j = byIndex.get(i + 1);
    if (!j) continue;                    // model omitted it → treat as not an opportunity
    if (j.is_opportunity === false) continue;
    out.push(candidateToRaw(batch[i], j));
  }
  return out;
}

/**
 * LLM judge: classify each forum candidate as opportunity / not, and extract structured
 * fields. Batched (12/call) through Grok via the shared provider + usage logging. Fails
 * soft per batch: on any error, that batch degrades to the keyword pre-filter rather than
 * being dropped or flooded.
 */
export async function judgeForumCandidates(
  candidates: ForumCandidate[],
  wire: string,
  onProgress?: (msg: string, pct: number) => void,
): Promise<RawScanResult[]> {
  if (candidates.length === 0) return [];
  const progress = onProgress || (() => {});

  const provider = getCachedProvider('grok');
  const model = provider?.default_model || DEFAULT_GROK_MODEL;
  const apiKey = provider?.api_key;
  const baseUrl = provider?.base_url || config.apis.grok.baseUrl;

  if (!apiKey) {
    console.warn('[Forum] No Grok API key — falling back to keyword filter (no LLM judge)');
    return candidates.filter(c => isRelevantDiscussion(c.title)).map(c => candidateToRaw(c, null));
  }

  const batches: ForumCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += JUDGE_BATCH_SIZE) {
    batches.push(candidates.slice(i, i + JUDGE_BATCH_SIZE));
  }

  const out: RawScanResult[] = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    progress(`Judging forum batch ${b + 1}/${batches.length} (${wire})`, Math.round((b / batches.length) * 100));
    const start = Date.now();
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: buildForumJudgePrompt(batch, wire) }],
          max_tokens: 6000,
          temperature: 0.1,
          ...chatCompletionExtras(baseUrl),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logApiUsage({ provider: 'grok', model, purpose: 'forum-judge', wire, duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim() });
        console.warn(`[Forum] Judge batch ${b + 1} HTTP ${response.status} — degrading batch to keyword filter`);
        out.push(...batch.filter(c => isRelevantDiscussion(c.title)).map(c => candidateToRaw(c, null)));
        continue;
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      logApiUsage({ provider: 'grok', model, purpose: 'forum-judge', wire, duration_ms: Date.now() - start, tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens });
      const content = data.choices?.[0]?.message?.content || '';
      out.push(...parseForumJudgeResponse(content, batch));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Forum] Judge batch ${b + 1} failed (${msg}) — degrading batch to keyword filter`);
      out.push(...batch.filter(c => isRelevantDiscussion(c.title)).map(c => candidateToRaw(c, null)));
    }
    if (b < batches.length - 1) await sleep(500);
  }

  console.log(`[Forum] Judge ${wire}: ${candidates.length} candidates -> ${out.length} opportunities`);
  return out;
}

/**
 * Governance-forum scan orchestrator (the current forum lane).
 * Per wire: pull allowlist + hot candidates → LLM judge → grouped opportunities.
 */
export async function runGovernanceForumScan(
  options: DualForumScanOptions = {},
): Promise<GovernanceForumScanResult> {
  const progress = options.onProgress || (() => {});
  const since = options.since
    || new Date(Date.now() - config.forum.defaultLookbackDays * 86400000).toISOString().split('T')[0];
  const wires = options.wire ? [options.wire] : Object.keys(WIRE_CATEGORY_MAP);

  const byWire: WireResults[] = [];
  let candidateCount = 0;
  let opportunityCount = 0;
  const detailBudget = { remaining: 20 };

  for (let wi = 0; wi < wires.length; wi++) {
    const wire = wires[wi];
    const base = (wi / wires.length) * 100;
    const span = 100 / wires.length;
    const wp = (p: number, label?: string) => progress(label || `Forum ${wire}`, Math.round(base + span * p / 100));

    wp(0);

    // Pull 0: pre-classified grants feed (body-level judgment done server-side;
    // these skip the Grok judge entirely).
    let feedResults: RawScanResult[] = [];
    let feedUrls = new Set<string>();
    if (config.forum.grantsFeedEnabled) {
      ({ results: feedResults, urls: feedUrls } = await fetchGrantsFeedResults(wire, since, {}, Boolean(options.pool)));
      candidateCount += feedResults.length;
      await sleep(REQUEST_DELAY_MS);
    }

    const fetched = await fetchGovernanceForumCandidates(wire, since, (_m, p) => wp(10 + p * 0.25), Boolean(options.pool));
    // Items the grants feed already judged should not re-spend the Grok judge.
    let candidates = fetched;
    candidateCount += candidates.filter(c => !feedUrls.has(normalizeUrl(c.url))).length;
    let updates: RawScanResult[] = [];
    if (options.pool) {
      const prepared = await prepareForumObservations(options.pool, candidates, feedResults, detailBudget);
      candidates = prepared.candidates;
      feedResults = prepared.feeds;
      updates = prepared.updates;
    }
    // A feed copy avoids another opportunity judge, but must not hide a new
    // reply on that topic from the source-change inspection above.
    candidates = candidates.filter(c => !feedUrls.has(normalizeUrl(c.url)));

    const judged = candidates.length > 0
      ? await judgeForumCandidates(candidates, wire, (_m, p) => wp(35 + p * 0.6))
      : [];
    if (options.pool) {
      for (const raw of judged) {
        const candidate = candidates.find(c => forumTopicKey(c.url) === forumTopicKey(raw.sourceUrl));
        if (candidate) stampForumObservation(raw, await captureForumObservation(candidate, detailBudget));
      }
    }

    const opportunities = [...feedResults, ...judged, ...updates];
    if (opportunities.length > 0) {
      byWire.push({ wire, results: opportunities });
      opportunityCount += opportunities.length;
    }

    if (wi < wires.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  progress(`Forum scan complete: ${opportunityCount} opportunities from ${candidateCount} candidates`, 100);
  console.log(`[Forum] Governance scan complete: ${candidateCount} candidates -> ${opportunityCount} opportunities across ${byWire.length} wires`);
  return { byWire, candidateCount, opportunityCount };
}
