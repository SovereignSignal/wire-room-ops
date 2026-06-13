/**
 * Forum Service — discuss.watch API client
 *
 * Governance-forum discovery lane. Per wire:
 *   1. Pull candidate threads from a curated governance/grants forum allowlist
 *      (plus a `hot` catch-all), age-gated on original post date.
 *   2. LLM-judge each thread (opportunity / not) and extract structured fields.
 *
 * Opportunities are mapped to RawScanResult[] for the intake pipeline.
 * Replaces the retired broad-keyword dual scan (2% approve / 67% dupe).
 * Rate limit: ~14 req/min (4.2s delay between requests).
 */

import { config } from '../config';
import type { RawScanResult } from '../types/intake';
import { sleep } from '../utils/async';
import { getCachedProvider } from './api-provider';
import { logApiUsage } from './api-usage';

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
// Tightened relevance filter — must indicate ACTIVE funding opportunity.
// Removed: proposal (catches GSoC proposals), governance/milestone/deliverable (catches discussions),
// council/committee (catches governance), ecosystem (too broad).
const RELEVANCE_KEYWORDS = [
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
  crypto: [
    // L1/L2 ecosystems running active grants / treasury / ecosystem-fund programs
    'arbitrum', 'optimism', 'zksync era', 'polygon', 'starknet', 'mantle',
    'linea', 'scroll', 'taiko', 'mode network', 'celo', 'gnosis', 'celestia',
    'cosmos hub', 'near protocol', 'polkadot', 'cardano', 'solana', 'avalanche',
    'aptos', 'stacks', 'berachain', 'monad', 'story protocol',
    // Public-goods / grants-native venues
    'gitcoin', 'ens', 'octant', 'the graph',
    // DeFi DAOs that run grants / ecosystem funds
    'aave', 'compound', 'sky (makerdao)', 'curve finance', 'balancer',
    'lido finance', 'eigenlayer', 'cow protocol', 'morpho', 'yearn finance',
    'dydx', 'gmx',
    // Standards / research venues where funded programs surface
    'ethereum magicians', 'ethereum research',
    // NOTE: 'uniswap governance' is deliberately EXCLUDED — operator works for the
    // Uniswap Foundation, so UF opportunities are never surfaced (see skip below).
  ],
  ai: [
    // The one funding-signal forum in the AI category; the rest is dev tooling.
    'ea forum',
  ],
  oss: [
    // OSS funding rarely originates on project-support forums; rely on `hot` + LLM.
  ],
};

// Forum names we never surface, regardless of allowlist or hot catch-all.
const FORUM_SKIP_PATTERNS: RegExp[] = [
  /uniswap/i, // operator works for the Uniswap Foundation
];

const JUDGE_BATCH_SIZE = 12;

export interface ForumCandidate {
  title: string;
  url: string;
  forumName: string;
  createdAt: string | null;
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
      if (item.createdAt && new Date(item.createdAt).getTime() < ageCutoff) continue;
      const forumName = item.forum?.name || item.forum?.token || '';
      if (FORUM_SKIP_PATTERNS.some(p => p.test(forumName))) continue;
      const key = normalizeUrl(item.url);
      if (candidates.has(key)) continue;
      candidates.set(key, {
        title: item.title,
        url: item.url,
        forumName,
        createdAt: item.createdAt || item.lastActivityAt || null,
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

function buildForumJudgePrompt(batch: ForumCandidate[], wire: string): string {
  const wireLabel = wire === 'crypto' ? 'crypto / web3' : wire === 'ai' ? 'AI / ML' : 'open-source software';
  const lines = batch.map((c, i) => `${i + 1}. [${c.forumName || 'forum'}] ${c.title}`).join('\n');
  return `You are screening ${wireLabel} forum threads to find FUNDING OPPORTUNITIES for builders.

An OPPORTUNITY is a thread that reveals a PROGRAM others can apply to for money: a grant program, ecosystem/treasury fund, RFP, bounty, retroactive public-goods round, fellowship, accelerator/incubator, or hackathon with prizes — OR a governance proposal to CREATE, RENEW, or EXTEND any such program. Governance proposals COUNT: they are the earliest signal a program exists. An individual project's application or request TO a clearly-named, currently-open program also counts (it evidences that the program is live).

NOT an opportunity (set is_opportunity=false):
- A single project's pitch, launch, or progress post that merely HOPES FOR or is "open to" funding without naming a specific program that is currently accepting applications.
- Delegate communications, voting-power / quorum / parameter changes, council or committee ELECTIONS, security-council rotations, treasury diversification or token swaps with no builder funding, protocol upgrades, partnership or listing announcements, market/price updates, meeting notes, milestone/transparency reports, and software releases.

When unsure BUT a concrete fundable program is named, lean is_opportunity=true — an operator reviews everything downstream. When the thread is just one project hoping to get funded, lean false.

For EACH numbered thread, return one JSON object. Respond with ONLY a JSON array (no prose, no markdown fences):
[{"n":1,"is_opportunity":true,"name":"<concise program name, not the raw thread title>","funder":"<org running it, or null>","amount":"<dollar figure or null>","deadline":"<date / Rolling / null>","signal_stage":"proposed|open|recurring|closing","summary":"<one sentence: what it funds and who can apply>"}]

signal_stage: "proposed" = governance proposal to create/renew; "open" = currently accepting; "recurring" = established rolling program; "closing" = deadline near.

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
  const model = provider?.default_model || 'grok-4.20-beta-0309-non-reasoning';
  const apiKey = provider?.api_key || config.apis.grok.apiKey;
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
          max_tokens: 1600,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        logApiUsage({ provider: 'grok', model, purpose: 'forum-judge', wire, duration_ms: Date.now() - start, success: false, error_message: String(response.status) });
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

  for (let wi = 0; wi < wires.length; wi++) {
    const wire = wires[wi];
    const base = (wi / wires.length) * 100;
    const span = 100 / wires.length;
    const wp = (p: number, label?: string) => progress(label || `Forum ${wire}`, Math.round(base + span * p / 100));

    wp(0);
    const candidates = await fetchGovernanceForumCandidates(wire, since, (_m, p) => wp(p * 0.35));
    candidateCount += candidates.length;
    if (candidates.length === 0) continue;

    const opportunities = await judgeForumCandidates(candidates, wire, (_m, p) => wp(35 + p * 0.6));
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
