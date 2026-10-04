/**
 * Channel-agnostic intake logic.
 *
 * Accepts an IntakeMessage (text + optional URLs + sender info) from any
 * channel adapter (Telegram, email, API, CLI…), detects the target wire,
 * and inserts a raw scan_entry into the database.
 *
 * Wire detection uses per-wire keyword sets loaded from environment variables
 * (INTAKE_WIRE_KEYWORDS_{WIRE}) with built-in defaults as fallback.
 */

import type { Pool } from 'pg';
import { getPool, getAllFeeds } from '../db';
import { checkDuplicate, registerSeenInTransaction } from '../services/dedup';
import { type Classification, type OperatorRoute } from '../services/classifier';
import { scrapeUrl, isScrapableUrl, truncateContent } from './scraper';
import { normalizeUrl } from '../utils/url';
import { blockedSourceDomain, classifySourceLink } from '../services/source-filter';
import { safePublicFetch } from '../utils/ssrf';
import { demoteEntryToDuplicateInTransaction, lockDuplicateGraph } from './duplicate-chain';

// ────────────────────────────────────────────────────────────────────────────────────
// URL Title Fetcher
// ────────────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a URL and extract the page title.
 * Used when forwarded messages have generic names (e.g., "Fortune", "Bloomberg").
 */
async function fetchUrlTitle(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout
    
    // SSRF guard: these URLs arrive in forwarded messages (untrusted input)
    const resp = await safePublicFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StringerBot/1.0; +https://sovereignsignal.com)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timeout);

    if (!resp || !resp.ok) return null;
    
    const html = await resp.text();
    
    // Extract title from <title> tag
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      let title = titleMatch[1].trim();
      // Clean up common title patterns: "Title | Site Name" or "Title - Site Name"
      title = title.replace(/\s*[|–—]\s*[^|–—]+$/, '');
      title = title.replace(/\s*[-]([^\-]+)$/, '');
      // Decode HTML entities
      title = title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      return title.slice(0, 200); // Limit length
    }
    
    // Fallback: try <h1>
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) {
      return h1Match[1].trim().slice(0, 200);
    }
    
    return null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Bare URL detection + scraping
// ────────────────────────────────────────────────────────────────────────────

/**
 * Detect if a message is essentially just bare URL(s) with negligible text.
 */
function isBareUrlMessage(text: string, urls: string[]): boolean {
  if (urls.length === 0) return false;
  let stripped = text;
  for (const url of urls) stripped = stripped.replace(url, '');
  return stripped.replace(/\s+/g, ' ').trim().length < 20;
}

/**
 * Scrape a URL via Firecrawl and extract a real name + description.
 * Returns null for Twitter/X URLs (handled natively by Grok) or non-scrapable URLs.
 */
export interface ScrapedIntakeData {
  name: string | null;
  description: string | null;
  scrapedContent: string | null;
}

/** Telegram link pastes get one Firecrawl attempt. Other intake scrapes keep the shared default. */
export function intakeFirecrawlOptions(scanSource: string): { job: 'telegram-link' | 'fallback'; attempts?: number } {
  if (scanSource === 'telegram' || scanSource === 'telegram-intake') {
    return { job: 'telegram-link', attempts: 1 };
  }
  return { job: 'fallback' };
}

async function scrapeForIntake(url: string, scrapeOpts: { job: string; attempts?: number }): Promise<ScrapedIntakeData | null> {
  if (/^https?:\/\/(x\.com|twitter\.com)\//i.test(url)) return null;
  if (!isScrapableUrl(url)) return null;
  try {
    const result = await scrapeUrl(url, { job: scrapeOpts.job, attempts: scrapeOpts.attempts });
    if (!result.success || !result.content) {
      console.log(`[IntakeCore] Scrape failed for ${url} (${result.error || 'empty'}); keeping the item without scraped text`);
      return null;
    }
    const truncated = truncateContent(result.content, 4000);
    let name = result.title || null;
    if (!name) {
      const h = truncated.match(/^#+ (.+)/m);
      if (h) name = h[1].trim().slice(0, 120);
    }
    const preview = truncated.slice(0, 500).replace(/\n{3,}/g, '\n\n').trim();
    const description = [result.title, preview].filter(Boolean).join('\n\n') || null;
    return { name, description, scrapedContent: truncated };
  } catch (err) {
    console.error(`[IntakeCore] scrapeForIntake failed for ${url}:`, err);
    return null;
  }
}

export type BareUrlIntakeResolution =
  | { ok: true; name: string; description: string; scrapedContent: string | null }
  | { ok: false; retryable: boolean; errorMessage: string };

/** Resolve source fields without letting post text or a URL slug become an x-monitor title. */
export function resolveBareUrlIntakeFields(input: {
  initialName: string;
  originalText: string;
  scraped: ScrapedIntakeData | null;
  scanSource: string;
}): BareUrlIntakeResolution {
  const { initialName, originalText, scraped, scanSource } = input;
  if (scanSource !== 'x-monitor') {
    return {
      ok: true,
      name: scraped?.name && scraped.name.length > initialName.length ? scraped.name : initialName,
      description: scraped?.description || originalText,
      scrapedContent: scraped?.scrapedContent ?? null,
    };
  }

  if (!scraped) {
    return { ok: false, retryable: true, errorMessage: 'Source scrape unavailable; x-monitor item will retry' };
  }
  const name = scraped.name?.trim() || '';
  const description = scraped.description?.trim() || '';
  if (!name || /^https?:\/\//i.test(name)) {
    // Firecrawl can return usable content without title metadata, and the
    // lightweight title fallback deliberately collapses network/HTTP failures
    // to null. Keep this retryable so a transient title fetch never advances
    // the account watermark as a durable rejection.
    return { ok: false, retryable: true, errorMessage: 'Source title unavailable; x-monitor item will retry' };
  }
  const descriptionText = description.replace(/\s+/g, ' ').trim();
  if (!descriptionText || /^https?:\/\/\S+$/i.test(descriptionText) || descriptionText.replace(/\s+/g, '').length < 30) {
    return { ok: false, retryable: false, errorMessage: 'Source has no usable description' };
  }
  return { ok: true, name, description, scrapedContent: scraped.scrapedContent };
}

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface IntakeMessage {
  text: string;              // raw message text
  urls?: string[];           // pre-extracted URLs (optional, core will also extract)
  senderId: string;          // channel-specific user ID
  channelMessageId: string;  // source message ID for lineage
  channelUpdateId?: string;  // transport update ID for webhook lineage
  forwardedFrom?: string;    // original source name if forwarded
}

export interface IntakeResult {
  status: 'inserted' | 'rejected' | 'error';
  entryId?: number;
  detectedWire?: string;
  confirmText?: string;      // human-readable summary of what was captured
  errorMessage?: string;
}

export type IntakeOrigin = 'operator' | 'agent';

export interface IntakeOptions {
  /** Trusted source-lane wire. Applied only when it matches an active wire. */
  wireHint?: string;
  /** Original source copy retained as provenance when intake uses a canonical URL. */
  sourceContext?: string;
  /**
   * Who submitted. Operator intake (a human pasting into the bot or the
   * dashboard) is trusted onto the wide-net queue unclassified. Agent intake
   * over the internal API key starts raw and earns its queue slot through
   * Gate 2 like every other automated lane. Absent = operator.
   */
  origin?: IntakeOrigin;
}

// ────────────────────────────────────────────────────────────────────────────
// Built-in keyword defaults (only used when env var is absent)
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_WIRE_KEYWORDS: Record<string, string[]> = {
  crypto: [
    // Crypto/web3 specific terms (no generic terms like 'grant', 'bounty', 'hackathon')
    'protocol', 'defi', 'web3', 'blockchain', 'crypto', 'token', 'staking',
    'decentralized', 'on-chain', 'on chain', 'smart contract', 'nft', 'dao', 'dex', 'dapp',
    'wallet', 'l1', 'l2', 'layer 2', 'layer2', 'mainnet', 'testnet', 'ecosystem fund',
    'retro funding', 'retroactive', 'airdrop', 'tokenomics', 'liquidity',
    // Major L1/L2 chains and protocols
    'ethereum', 'solana', 'avalanche', 'avax', 'sui', 'aptos', 'near', 'cosmos',
    'polkadot', 'cardano', 'algorand', 'hedera', 'stellar', 'tron', 'fantom',
    'arbitrum', 'optimism', 'base', 'polygon', 'matic', 'bnb', 'bsc', 'linea',
    'scroll', 'zksync', 'starknet', 'mantle', 'mode', 'blast', 'sonic',
    'ton', 'celo', 'monad', 'stacks', 'bitcoin',
    // Major protocols / orgs
    'uniswap', 'aave', 'chainlink', 'gitcoin', 'ethereum foundation', 'ef grant',
    'sia', 'filecoin', 'ipfs', 'arweave', 'the graph', 'ens', 'safe',
    'compound', 'curve', 'maker', 'makerdao', 'sky', 'lido', 'eigenlayer',
    'celestia', 'hyperliquid', 'drift', 'jupiter', 'jito', 'magic eden',
    'pyth', 'nosana',
  ],
  ai: [
    // Specific orgs / products (high signal)
    'openai', 'anthropic', 'google deepmind', 'deepmind', 'hugging face', 'huggingface',
    'meta ai', 'stability ai', 'mistral', 'cohere', 'perplexity', 'claude', 'gemini',
    'nvidia', 'amd', 'vector institute', 'mila', 'allen institute',
    // Core AI/ML terminology
    'artificial intelligence', 'machine learning', 'deep learning', 'neural network',
    'neural', 'llm', 'gpt', 'foundation model', 'transformer', 'large language model',
    'large language', 'generative ai', 'computer vision', 'nlp',
    'natural language processing', 'reinforcement learning',
    'robotics', 'robot', 'data science', 'autonomous',
    // AI safety / alignment / governance
    'ai safety', 'ai alignment', 'ai governance', 'ai ethics', 'ai risk',
    'alignment research', 'agi',
    // Broad but distinctive AI terms
    'ai', 'ml', 'ai research', 'ai fellowship', 'ai workforce',
    'ai impact', 'ai challenge', 'ai grant', 'ai hackathon', 'ai accelerator',
    'ai agent', 'ai agents', 'ai startup', 'ai tool', 'ai tools',
  ],
  oss: [
    'open source', 'open-source', 'foss', 'libre', 'free software',
    'github', 'apache', 'linux', 'linux foundation', 'cncf', 'mozilla',
    'sovereign tech', 'nlnet', 'oss', 'gnu', 'creative commons',
    'open collective', 'fiscal sponsor', 'open infrastructure',
    'maintainer', 'maintainers', 'contributor', 'contributors',
    'open data', 'debian', 'freebsd', 'r consortium',
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// Wire detection helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load keywords for a given wire. Check INTAKE_WIRE_KEYWORDS_{WIRE} env var
 * first; fall back to built-in defaults; if neither exists, return [].
 */
function getKeywordsForWire(wire: string): string[] {
  const envKey = `INTAKE_WIRE_KEYWORDS_${wire.toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal) {
    return envVal.split(',').map(k => k.trim()).filter(Boolean);
  }
  return DEFAULT_WIRE_KEYWORDS[wire] || [];
}

/**
 * Build a regex for word-boundary matching of a keyword list.
 */
function buildKeywordRegex(keywords: string[]): RegExp | null {
  if (keywords.length === 0) return null;
  // Sort longest-first so multi-word phrases match before shorter substrings
  // (e.g. "ai agents" matches before "ai" in regex alternation)
  const escaped = keywords
    .sort((a, b) => b.length - a.length)
    .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'i');
}

/**
 * Score each wire against the message text. Returns the wire with the
 * highest score, or null if ambiguous / no match.
 */
function detectWire(text: string, wires: string[]): string | null {
  const scores: Record<string, number> = {};

  for (const wire of wires) {
    const keywords = getKeywordsForWire(wire);
    const regex = buildKeywordRegex(keywords);
    if (!regex) continue;

    const matches = text.match(new RegExp(regex.source, 'gi'));
    scores[wire] = matches ? matches.length : 0;
  }

  const sorted = Object.entries(scores)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0][0];

  // Clear winner: top score is strictly greater than second
  if (sorted[0][1] > sorted[1][1]) return sorted[0][0];

  return null; // ambiguous
}

/** Keyword wire scorer used before intake registers seen_urls. Null when tied or unmatched. */
export function detectWireFromText(text: string, wires: string[] = ['crypto', 'ai', 'oss']): string | null {
  return detectWire(text, wires);
}

// ────────────────────────────────────────────────────────────────────────────
// Active wires loader
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load active wire keys from the DB feeds table. Falls back to
 * INTAKE_WIRES env var (comma-separated), then to built-in defaults.
 */
export async function getActiveWires(): Promise<string[]> {
  try {
    const feeds = await getAllFeeds(false);
    if (feeds.length > 0) return feeds.map(f => f.key);
  } catch {
    // DB may be unavailable during tests
  }

  const envWires = process.env.INTAKE_WIRES;
  if (envWires) {
    return envWires.split(',').map(w => w.trim()).filter(Boolean);
  }

  return Object.keys(DEFAULT_WIRE_KEYWORDS);
}

// ────────────────────────────────────────────────────────────────────────────
// URL extraction
// ────────────────────────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

function extractUrls(text: string): string[] {
  return (text.match(URL_REGEX) || []);
}

// ────────────────────────────────────────────────────────────────────────────
// Name builder
// ────────────────────────────────────────────────────────────────────────────

function buildName(text: string, url: string | null): string {
  let firstLine = text.split('\n')[0].trim();

  // If the first line is very short (< 20 chars) and there's more text,
  // it may be a mid-word line break — join with the next line
  if (firstLine.length < 20 && firstLine.length > 0) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      firstLine = lines.slice(0, 2).join(' ').trim();
    }
  }

  if (firstLine && firstLine !== url) {
    // Strip numbered list prefix (e.g. "14. " or "3. ")
    const cleaned = firstLine.replace(/^\d+\.\s+/, '').replace(/^#+\s+/, '').replace(/^\[+|\]+$/g, '').trim();
    return cleaned.slice(0, 120);
  }
  if (url) {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.replace('www.', '');
      // For X/Twitter URLs, use @handle format for readability
      if (domain === 'x.com' || domain === 'twitter.com') {
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 1) {
          const handle = pathParts[0];
          const statusId = pathParts.length >= 3 ? pathParts[2].substring(0, 10) : '';
          return `@${handle} post${statusId ? ` (${statusId}…)` : ''}`;
        }
      }
      // For other URLs, use domain/path for readability
      const pathSegments = parsed.pathname.split('/').filter(s => s.length > 0);
      if (pathSegments.length > 0) {
        const slug = pathSegments.slice(-2).join('/');
        return `${domain}/${slug}`.slice(0, 120);
      }
      return domain;
    } catch {
      return 'Submitted link';
    }
  }
  return 'Submitted link';
}

// ────────────────────────────────────────────────────────────────────────────
// DB insert
// ────────────────────────────────────────────────────────────────────────────

interface NewIntakeEntry {
  name: string;
  description: string;
  sourceUrl: string;
  wire: string;
  scanDate: string;
  submittedBy: string;
  scanSource: string;
  status?: string;
  deadline?: string | null;
  sourceNeedsVerification?: boolean;
  operatorRoute?: OperatorRoute;
  channelMessageId?: string;
  channelUpdateId?: string;
  channelItemKey?: string;
  forwardedFrom?: string;
  sourceContext?: string;
}

type Queryable = Pick<Pool, 'query'>;

export function buildIntakeMetadata(entry: NewIntakeEntry): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    source_needs_verification: entry.sourceNeedsVerification ?? false,
    operator_route: entry.operatorRoute ?? null,
    channel_message_id: entry.channelMessageId ?? null,
    channel_update_id: entry.channelUpdateId ?? null,
    channel_item_key: entry.channelItemKey ?? null,
    forwarded_from: entry.forwardedFrom ?? null,
  };
  if (entry.sourceContext) metadata.source_context = entry.sourceContext;
  return metadata;
}

export function telegramReplayPlaceholder(updateId: string, itemKey: string): string {
  return `https://manual/needs-source/telegram-${encodeURIComponent(updateId)}-${encodeURIComponent(itemKey)}`;
}

export async function findTelegramReplayEntry(
  db: Queryable,
  updateId?: string,
  itemKey?: string,
): Promise<{ id: number; wire: string } | null> {
  if (!updateId || !itemKey) return null;
  const existing = await db.query(
    `SELECT id, wire
     FROM scan_entries
     WHERE scan_source = 'telegram'
       AND metadata->>'channel_update_id' = $1
       AND metadata->>'channel_item_key' = $2
     ORDER BY id ASC
     LIMIT 1`,
    [updateId, itemKey],
  );
  const row = existing.rows[0];
  return row ? { id: row.id, wire: row.wire } : null;
}

async function insertEntry(db: Queryable, entry: NewIntakeEntry): Promise<number> {
  const status = entry.status ?? 'raw'; // Raw entries flow through the classification pipeline
  const res = await db.query(
    `INSERT INTO scan_entries
     (name, description, source_url, wire, prompt_variant, scan_source, scan_date,
      status, submitted_by, deadline, source_needs_verification, metadata)
     VALUES ($1, $2, $3, $4, 'N', $5, $6, $7, $8, $9, $10, $11::jsonb)
     RETURNING id`,
    [
      entry.name,
      entry.description,
      entry.sourceUrl,
      entry.wire,
      entry.scanSource,
      entry.scanDate,
      status,
      entry.submittedBy,
      entry.deadline ?? null,
      entry.sourceNeedsVerification ?? false,
      JSON.stringify(buildIntakeMetadata(entry)),
    ],
  );
  return res.rows[0].id;
}

/** Insert an intake row and resolve the exact-URL claim in one transaction. */
export async function insertIntakeEntryWithClaim(
  pool: Pool,
  entry: NewIntakeEntry,
): Promise<{ id: number; urlConflict: boolean; conflictEntryId: number | null; unresolvedParent?: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await insertEntry(client, entry);
    // Keep the graph lock ahead of URL-registry locks everywhere. A single
    // lock order prevents deadlocks with maintenance and duplicate rechecks.
    await lockDuplicateGraph(client);
    const claim = await registerSeenInTransaction(client, {
      id,
      sourceUrl: entry.sourceUrl,
      name: entry.name,
      wire: entry.wire,
      scanDate: entry.scanDate,
    });

    let conflictEntryId = claim.conflictEntryId;
    let urlConflict = claim.urlConflict;
    let unresolvedParent = false;
    if (claim.urlConflict) {
      const conflictReason = claim.conflictEntryId === null
        ? 'URL already exists in seed history'
        : 'URL claimed by concurrent submission';
      if (claim.conflictEntryId === null) {
        const demoted = await client.query(
          `UPDATE scan_entries
           SET status = 'deduped', duplicate_of_id = NULL,
               duplicate_reason = $2, distributable = false, updated_at = NOW()
           WHERE id = $1 AND status = $3 AND source_url = $4
           RETURNING id`,
          [id, conflictReason, entry.status ?? 'raw', entry.sourceUrl],
        );
        if (demoted.rowCount !== 1) throw new Error('Exact URL seed conflict loser changed before demotion');
      } else {
        const demoted = await demoteEntryToDuplicateInTransaction(client, {
          targetId: id,
          requestedParentId: claim.conflictEntryId,
          expectedStatus: entry.status ?? 'raw',
          expectedSourceUrl: entry.sourceUrl,
          reason: conflictReason,
          actor: 'intake-url-claim',
        });
        if (demoted.outcome === 'unresolvable') {
          // Permanent: the URL owner can never be a canonical parent. Throwing
          // here is what spun the Telegram webhook 44+ times in the July 2026
          // incident. Keep the freshly-inserted entry visible for review and
          // report the unresolvable parent up instead of demanding a retry.
          unresolvedParent = true;
          urlConflict = false;
          conflictEntryId = null;
        } else if (demoted.outcome !== 'linked' || demoted.canonicalParentId === null) {
          throw new Error('Exact URL claim loser changed before demotion');
        } else {
          conflictEntryId = demoted.canonicalParentId;
        }
      }
    }

    await client.query('COMMIT');
    return { id, urlConflict, conflictEntryId, unresolvedParent };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Post-insert classification (fire-and-forget)
// ────────────────────────────────────────────────────────────────────────────

export function determinePostClassificationStatus(result: {
  classification: Classification;
  qualityScore: number;
  operatorRoute?: OperatorRoute;
  wireArea?: string | null;
}, scanSource = 'manual-intake'): 'queued' | 'archived' {
  // x-monitor is a high-volume discovery lane, not operator-authored intake.
  // Areas 1–6 may publish or source-check. wire_area out never enters the queue.
  // Only settled publish/source-check candidates belong in the review queue.
  if (scanSource === 'x-monitor') {
    if (result.wireArea === 'out') return 'archived';
    return result.operatorRoute === 'publish' || result.operatorRoute === 'source_check'
      ? 'queued'
      : 'archived';
  }
  // Wide net, label by route: operator intake (Telegram + manual paste) never
  // auto-archives. Every classified item lands in the review queue carrying its
  // operator_route (publish/source_check/park/relationship_signal/decline) in
  // metadata, and the operator filters by route in the dashboard. This replaced
  // the prior gate that silently archived everything except publish/source_check
  // — which was hiding real grants (park/relationship_signal) from review.
  return 'queued';
}

export function determineInitialIntakeStatus(scanSource = 'manual-intake', origin: IntakeOrigin = 'operator'): 'raw' | 'queued' {
  // Only a human's own paste skips classification. Discovery lanes and agent
  // submissions settle through process-raw before they can be reviewed.
  return scanSource === 'x-monitor' || origin === 'agent' ? 'raw' : 'queued';
}

export function normalizeDeadlineForDb(value?: string | null, referenceDate = new Date().toISOString().slice(0, 10)): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/^\s*Deadline:\s*/i, '')
    .replace(/\([^)]*\)/g, ' ')
    .trim();

  if (!cleaned || /\b(none|not listed|rolling|ongoing|tbd|n\/a|no deadline)\b/i.test(cleaned)) return null;

  const refYear = new Date(referenceDate).getUTCFullYear();
  const dateText = /\b\d{4}\b/.test(cleaned) ? cleaned : `${cleaned} ${refYear}`;
  const parsed = new Date(dateText);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────────
// Core intake functions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Process an incoming message from any channel. Detects wire, inserts entry.
 *
 * @param msg         The channel-agnostic message
 * @param scanSource  The scan_source value for the DB row (default: "manual-intake")
 * @param options     Optional trusted source-lane hints
 */
export async function processIntakeMessage(
  msg: IntakeMessage,
  scanSource = 'manual-intake',
  options: IntakeOptions = {},
): Promise<IntakeResult> {
  const text = msg.text.trim();
  if (!text) {
    return { status: 'rejected', errorMessage: 'Empty message' };
  }

  // Defense in depth for messages that should never become opportunity rows.
  // Telegram normally routes structured scans through processBatchMessage(),
  // but a detector miss must not persist a Grok count line or one of this
  // bot's own receipts as the entry name.
  const firstLine = text.split('\n').find(line => line.trim().length > 0) || '';
  if (isBatchControlLine(firstLine) || isIntakeStatusLine(firstLine)) {
    return { status: 'rejected', errorMessage: 'Intake control/status text is not an opportunity entry' };
  }

  // Extract and validate caller-supplied URLs before any DB or network work.
  const textUrls = extractUrls(text);
  const passedUrls = msg.urls || [];
  const allUrls = [...new Set([...passedUrls, ...textUrls])];
  const suppliedPrimaryUrl = allUrls[0] || null;
  const suppliedSourceClass = suppliedPrimaryUrl ? classifySourceLink(suppliedPrimaryUrl) : null;
  if (suppliedSourceClass === 'invalid') {
    return { status: 'rejected', errorMessage: 'Invalid source URL: use HTTP or HTTPS' };
  }
  if (suppliedSourceClass === 'shortener') {
    return { status: 'rejected', errorMessage: 'Unresolved shortener URL: submit the destination source' };
  }
  const channelItemKey = msg.channelUpdateId ? 'single' : undefined;
  const primaryUrl = suppliedPrimaryUrl
    || (msg.channelUpdateId
      ? telegramReplayPlaceholder(msg.channelUpdateId, channelItemKey!)
      : `https://t.me/manual/${Date.now()}`);
  const sourceNeedsVerification = classifySourceLink(primaryUrl) === 'placeholder';

  // Load active wires only after cheap input validation.
  const wires = await getActiveWires();
  if (wires.length === 0) {
    return { status: 'error', errorMessage: 'No active wires configured' };
  }

  const replayEntry = await findTelegramReplayEntry(getPool(), msg.channelUpdateId, channelItemKey);
  if (replayEntry !== null) {
    return {
      status: 'inserted',
      entryId: replayEntry.id,
      confirmText: `Captured existing entry #${replayEntry.id} from a retried Telegram update`,
    };
  }

  // Gate 1: reject known Tier-3 aggregator sources before they cost a
  // classification call (opportunitydesk, afredac, menterprise, …).
  const blockedDomain = blockedSourceDomain(primaryUrl);
  if (blockedDomain) {
    return { status: 'rejected', errorMessage: `Blocked aggregator source: ${blockedDomain}` };
  }

  let name = buildName(text, allUrls[0] || null);

  const bareUrlMessage = isBareUrlMessage(text, allUrls);
  if (scanSource === 'x-monitor' && !bareUrlMessage) {
    return { status: 'rejected', errorMessage: 'x-monitor intake requires a bare external source URL' };
  }
  if (scanSource === 'x-monitor' && allUrls.length > 0 && !isScrapableUrl(allUrls[0])) {
    return { status: 'rejected', errorMessage: 'x-monitor source is not supported by canonical scraping' };
  }

  // Pre-scrape bare URL messages for better data quality
  let scrapedContent: string | null = null;
  let effectiveDescription = text;
  if (bareUrlMessage && allUrls.length > 0) {
    console.log(`[IntakeCore] Bare URL detected, scraping ${allUrls[0]}...`);
    let scraped = await scrapeForIntake(allUrls[0], intakeFirecrawlOptions(scanSource));
    if (scanSource === 'x-monitor' && scraped && !scraped.name) {
      const fetchedTitle = await fetchUrlTitle(allUrls[0]);
      if (fetchedTitle) scraped = { ...scraped, name: fetchedTitle };
    }
    const resolved = resolveBareUrlIntakeFields({ initialName: name, originalText: text, scraped, scanSource });
    if (!resolved.ok) {
      return {
        status: resolved.retryable ? 'error' : 'rejected',
        errorMessage: resolved.errorMessage,
      };
    }
    name = resolved.name;
    effectiveDescription = resolved.description;
    scrapedContent = resolved.scrapedContent;
    if (scraped) {
      console.log(`[IntakeCore] Scraped: name="${name}", desc=${effectiveDescription.length} chars`);
    }
  }

  // If scraping didn't run, try lightweight title fetch for generic names
  if (!scrapedContent) {
    const GENERIC_NAME_PATTERNS = [
      /^(Source|Fortune|Bloomberg|Washington Times|AWS Blog|AI Grant|Faegre Drinker|Nixon Peabody|Bankless|Mean CEO|ETC Journal|Bitcoin News|FX Leaders|Stacks Forum)$/i,
      /^Source:\s/i,
      /^[A-Z][a-z]+$/,
    ];
    const isGenericName = name.length < 25 || GENERIC_NAME_PATTERNS.some(p => p.test(name));
    if (isGenericName && allUrls.length > 0) {
      const fetchedTitle = await fetchUrlTitle(allUrls[0]);
      if (fetchedTitle && fetchedTitle.length > name.length) {
        console.log(`[IntakeCore] Fetched better title: "${fetchedTitle}" (was "${name}")`);
        name = fetchedTitle;
      }
    }
  }

  const scanDate = new Date().toISOString().slice(0, 10);
  const initialStatus = determineInitialIntakeStatus(scanSource, options.origin);

  // Source lanes with an explicit wire assignment should not be reclassified
  // from sparse post text. Ignore stale/invalid hints and fall back to content
  // detection so the active feeds table remains the authority.
  const normalizedWireHint = options.wireHint?.trim().toLowerCase();
  const wire = normalizedWireHint && wires.includes(normalizedWireHint)
    ? normalizedWireHint
    : detectWire(scrapedContent || text, wires);

  if (wire) {
    // Dedup check — fail open if dedup service errors
    try {
      const dedupResult = await checkDuplicate(getPool(), { sourceUrl: primaryUrl, name, wire }, 180, { urlOnly: true });
      if (dedupResult.isDuplicate) {
        return { status: 'rejected', errorMessage: `Duplicate: already seen as "${dedupResult.matchedEntryName}"` };
      }
    } catch (dedupErr) {
      console.error('[IntakeCore] Dedup check failed, proceeding with insert:', dedupErr);
    }

    try {
      const inserted = await insertIntakeEntryWithClaim(getPool(), {
        name,
        description: effectiveDescription,
        sourceUrl: primaryUrl,
        wire,
        scanDate,
        submittedBy: msg.senderId,
        scanSource,
        status: initialStatus,
        sourceNeedsVerification,
        operatorRoute: sourceNeedsVerification ? 'source_check' : undefined,
        channelMessageId: msg.channelMessageId,
        channelUpdateId: msg.channelUpdateId,
        channelItemKey,
        forwardedFrom: msg.forwardedFrom,
        sourceContext: options.sourceContext,
      });
      if (inserted.urlConflict) {
        return {
          status: 'rejected',
          entryId: inserted.id,
          errorMessage: inserted.conflictEntryId === null
            ? 'Duplicate: exact URL already exists in history'
            : `Duplicate: exact URL already belongs to entry #${inserted.conflictEntryId}`,
        };
      }
      const id = inserted.id;
      // Operator-authored intake remains a wide-net queue. Discovery lanes and
      // agent submissions start raw and settle through classification first.
      return {
        status: 'inserted',
        entryId: id,
        detectedWire: wire,
        confirmText: `Captured ${wire} entry #${id}: ${name}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Insert failed';
      return { status: 'error', errorMessage };
    }
  }

  // No wire detected — default to crypto (same fallback as batch intake)
  const fallbackWire = wires.includes('crypto') ? 'crypto' : wires[0];
  console.log(`[IntakeCore] Wire undetected for "${name}", defaulting to "${fallbackWire}"`);

  try {
    const dedupResult = await checkDuplicate(getPool(), { sourceUrl: primaryUrl, name, wire: fallbackWire }, 180, { urlOnly: true });
    if (dedupResult.isDuplicate) {
      return { status: 'rejected', errorMessage: `Duplicate: already seen as "${dedupResult.matchedEntryName}"` };
    }
  } catch (dedupErr) {
    console.error('[IntakeCore] Dedup check failed, proceeding with insert:', dedupErr);
  }

  try {
    const inserted = await insertIntakeEntryWithClaim(getPool(), {
      name,
      description: effectiveDescription,
      sourceUrl: primaryUrl,
      wire: fallbackWire,
      scanDate,
      submittedBy: msg.senderId,
      scanSource,
      status: initialStatus,
      sourceNeedsVerification,
      operatorRoute: sourceNeedsVerification ? 'source_check' : undefined,
      channelMessageId: msg.channelMessageId,
      channelUpdateId: msg.channelUpdateId,
      channelItemKey,
      forwardedFrom: msg.forwardedFrom,
      sourceContext: options.sourceContext,
    });
    if (inserted.urlConflict) {
      return {
        status: 'rejected',
        entryId: inserted.id,
        errorMessage: inserted.conflictEntryId === null
          ? 'Duplicate: exact URL already exists in history'
          : `Duplicate: exact URL already belongs to entry #${inserted.conflictEntryId}`,
      };
    }
    const id = inserted.id;
    // Operator-authored intake remains a wide-net queue. Discovery lanes and
    // agent submissions start raw and settle through classification first.
    return {
      status: 'inserted',
      entryId: id,
      detectedWire: fallbackWire,
      confirmText: `Captured ${fallbackWire} entry #${id}: ${name} (wire auto-assigned)`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Insert failed';
    return { status: 'error', errorMessage };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Batch intake (numbered list format from Grok scans)
// ────────────────────────────────────────────────────────────────────────────

export interface BatchIntakeResult {
  inserted: number;
  duplicates: number;
  errors: number;
  retryableErrors: number;
  /** @deprecated use duplicates + errors instead */
  failed: number;
  entries: Array<{
    name: string;
    wire: string;
    id?: number;
    error?: string;
    isDuplicate?: boolean;
    retryable?: boolean;
  }>;
}

/**
 * Detect whether a message is a batch list.
 * Matches:
 *   - Numbered: "1. **Name**" or "1. Text" with "2. " later
 *   - Bold markdown: "**Name** — Description" appearing 2+ times
 *   - Markdown links: "[Name](url)" appearing 2+ times (newsletters/briefings)
 *   - Structured: Multiple "Link: https://..." lines (Telegram strips ** to bold rendering)
 *   - Compact URL list: 2+ "Name - https://..." lines, or name/URL pairs
 */
/**
 * Grok sometimes appends citation footnote digits directly after X status IDs
 * when emitting URL lists, creating dead links like /status/<tweet-id>18.
 * Current X snowflake IDs are 19 digits, so trim obvious overlong IDs.
 */
/**
 * Prose punctuation that ends a URL rather than belonging to it. Senders wrap
 * links in brackets ("Source: [https://x.com/a/status/1]") and end sentences on
 * them; every capture path funnels through here so the list lives in one place.
 */
const TRAILING_URL_PUNCTUATION = /[\]),.;]+$/;

function normalizeParsedSourceUrl(url: string): string {
  let normalized = url.replace(TRAILING_URL_PUNCTUATION, '').replace(/\/?$/, '');

  normalized = normalized.replace(/(https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s/]+\/status\/)(\d{20,})(.*)$/i,
    (_match, prefix: string, id: string, suffix: string) => `${prefix}${id.slice(0, 19)}${suffix}`);

  // Grok often appends citation digits directly to non-X URLs too:
  //   https://www.circle.com/grant27 -> https://www.circle.com/grant
  //   https://example.org/some-slug/37 -> https://example.org/some-slug
  // Keep this conservative: only strip short trailing numeric footnotes from
  // alphabetic slug endings, and avoid query strings.
  if (!/[?#]/.test(normalized) && !/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(normalized)) {
    normalized = normalized
      .replace(/([a-z][a-z-]{2,})\d{1,3}$/i, '$1')
      .replace(/([a-z][a-z-]{2,})\/\d{1,3}$/i, '$1');
  }

  return normalized;
}

export function semanticBatchKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[()]/g, ' ')
    .replace(/\b(20\d{2}|program|grant|grants|fellowship|challenge|hackathon|on|the|official|foundation|heinrich|boll|boell)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

export function isBetterBatchSource(candidateUrl: string, existingUrl: string): boolean {
  const rank = (url: string) => {
    if (/^https:\/\/manual\/needs-source\//i.test(url)) return 0;
    if (/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/grok\//i.test(url)) return 1;
    if (/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(url)) return 2;
    return 3;
  };
  return rank(candidateUrl) > rank(existingUrl);
}

function getBatchControlCount(text: string): number | null {
  const match = text.match(/^\s*Total:\s*(\d+)\s+results?\b/i)
    || text.match(/^\s*Total(?:\s+relevant)?\s+results?\s+after\s+dedup(?:lication)?\s+and\s+filtering\s*:\s*(\d+)\b/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function isBatchMessage(text: string): boolean {
  // A leading Grok count line previously hid a numbered batch from every
  // detector below. Classify the same cleaned content that parseBatchEntries()
  // will consume so routing and parsing cannot disagree on control lines.
  const declaredResultCount = text
    .split('\n')
    .map(getBatchControlCount)
    .find((count): count is number => count !== null);
  const cleaned = stripBatchControlLines(text);

  // Numbered list format
  if (/^\s*1\.\s+\*\*/.test(cleaned)) return true;
  if (/^\s*1\.\s+\S/.test(cleaned) && /\n\s*2\.\s+/.test(cleaned)) return true;

  // Bold-name format with literal ** markers
  const boldEntries = cleaned.match(/^\s*\*\*[^*]+\*\*\s*[—–\-]/gm);
  if (boldEntries && boldEntries.length >= 2) return true;
  if (boldEntries && boldEntries.length === 1 && /\n\s*Link:\s*https?:\/\//i.test(cleaned)) return true;

  // Markdown link format: [Name](url) — common in newsletters/briefings.
  // Ignore Grok `Source: [@handle](tweet)` attribution so those pastes route
  // through the structured Source:/Link: chunker instead.
  const titleMdLinks = [...cleaned.matchAll(/\[([^\]]{3,})\]\((https?:\/\/[^)]+)\)/g)]
    .filter(match => !isSourceAttributionMarkdownLink(cleaned, match));
  if (titleMdLinks.length >= 2) return true;

  // Structured format without ** (Telegram renders bold and strips markers):
  // Multiple "Link: <url>" lines = structured batch
  const linkLines = cleaned.match(/^\s*Link:\s*.+$/gim);
  if (linkLines && linkLines.length >= 2) return true;
  // Single entry with both Deadline: and Link: (Telegram split of larger batch)
  if (linkLines && linkLines.length === 1 && /\n\s*Deadline:/i.test(cleaned)) return true;

  // Inline Grok batch format: one full entry per line, e.g.
  // "Name — Description. Deadline: June 7, 2026 Link: https://..."
  const inlineStructuredLines = cleaned
    .split('\n')
    .filter(line => /^[^\n—–]{3,}\s*[—–]\s+.+\bDeadline:\s+.+\bLink:\s+.+/i.test(line.trim()));
  if (inlineStructuredLines.length >= 2) return true;

  // A generated positive count is strong batch context even when only one
  // opportunity survived deduplication. Route it through the same parser used
  // for multi-entry scans so the count line cannot make Telegram fall back to
  // single-entry intake and discard the valid payload.
  if ((declaredResultCount ?? 0) > 0 && parseBatchEntries(cleaned).length > 0) return true;

  // Compact operator paste: one grant per line as "Name - URL" (or name then
  // URL on the next line). Telegram link-previews one URL and the single-entry
  // path previously rejected the whole message when that preview was a duplicate.
  if (parseCompactUrlListEntries(cleaned).length >= 2) return true;

  return false;
}

/**
 * Parse a batch list into individual entries.
 * Handles three formats:
 *   Numbered:  N. **Name** — Description / Deadline: X / Link: <url>
 *   Bold:      **Name** — Description / Deadline: X / Link: <url>
 *   Markdown:  [Name](url) — Description (newsletters/briefings)
 */
export function isBatchControlLine(text: string): boolean {
  return getBatchControlCount(text) !== null;
}

export function isIntakeStatusLine(text: string): boolean {
  const trimmed = text.trim();
  return /^(?:📥\s*)?Batch received\.\s+Running intake and history checks/i.test(trimmed)
    || /^Intake settled:/i.test(trimmed)
    || /^Intake saved, checks outstanding:/i.test(trimmed)
    || /^No qualifying results found\b/i.test(trimmed)
    || /^Duplicate:\s+(?:already seen as|exact URL)/i.test(trimmed)
    || /^(?:(?:[a-z][\w-]*\s+)?[—–-]\s+)?Captured\s+(?:existing\s+)?(?:[a-z][\w-]*\s+)?entry\s+#\d+\b/i.test(trimmed);
}

function stripBatchControlLines(text: string): string {
  return text
    .split('\n')
    .filter(line => !isBatchControlLine(line) && !isIntakeStatusLine(line))
    .join('\n')
    .trim();
}

function compactItemName(raw: string): string {
  return raw
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/^\s*[-*•]\s+/, '')
    .replace(/\s*[—–−-]\s*$/, '')
    .replace(/\s*:\s*$/, '')
    .replace(/^\[+|\]+$/g, '')
    .trim();
}

function pickCompactSourceUrl(urls: string[]): string {
  let best = urls[0];
  for (const url of urls.slice(1)) {
    if (isBetterBatchSource(url, best)) best = url;
  }
  return best;
}

function countStructuredFieldLines(text: string, field: 'Link' | 'Source'): number {
  const re = field === 'Link' ? /^\s*Link:\s*.+$/gim : /^\s*Source:\s*.+$/gim;
  return (text.match(re) || []).length;
}

function hasStructuredSourceBlocks(text: string): boolean {
  const linkLines = countStructuredFieldLines(text, 'Link');
  const sourceLines = countStructuredFieldLines(text, 'Source');
  if (linkLines >= 2 || sourceLines >= 2) return true;
  if ((linkLines === 1 || sourceLines === 1) && /\n\s*Deadline:/i.test(text)) return true;
  return false;
}

function lineAtIndex(text: string, index: number): string {
  const lineStart = index === 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = text.indexOf('\n', index);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
}

/** Grok `Source: [@handle](tweet)` attribution — not a newsletter title link. */
function isSourceAttributionMarkdownLink(text: string, match: RegExpMatchArray): boolean {
  const label = match[1].trim();
  if (/^@[\w.]+$/.test(label)) return true;
  return /^Source:\s*/i.test(lineAtIndex(text, match.index ?? 0));
}

/**
 * Prefer the explicit Source: field (markdown or bare URL), then Link:, then
 * any URL in the block. Keeps Telegram link-preview leftovers from becoming
 * the stored source when Grok already named the tweet.
 */
function extractStructuredSourceUrl(chunk: string): string {
  const sourceMd = chunk.match(/Source:\s*\[[^\]]*\]\((https?:\/\/[^)]+)\)/i);
  const sourceBare = chunk.match(/Source:\s*<?(\bhttps?:\/\/[^\s>]+)/i);
  const linkMatch = chunk.match(/Link:\s*<?(\bhttps?:\/\/[^\s>]+)/i);
  const anyUrl = chunk.match(/\bhttps?:\/\/[^\s<>)\]]+/);
  const raw = (sourceMd?.[1] || sourceBare?.[1] || linkMatch?.[1] || anyUrl?.[0] || '').trim();
  return raw ? normalizeParsedSourceUrl(raw) : '';
}

/**
 * Parse unnumbered operator pastes where each opportunity is a name plus a URL.
 * Returns [] unless at least two link-backed items are present, so a single
 * grant with a source URL still uses the single-entry path.
 */
export function parseCompactUrlListEntries(
  text: string,
): Array<{ name: string; description: string; sourceUrl: string; deadline?: string }> {
  const lines = stripBatchControlLines(text)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !isIntakeStatusLine(line));

  if (lines.length < 2) return [];
  // Structured Grok/Telegram "Link:" batches have their own chunker. Do not
  // steal those by treating the Link: URL as a compact one-liner.
  if (lines.some(line => /^Link:\s*.+/i.test(line))) return [];

  const items: Array<{ name: string; description: string; sourceUrl: string; deadline?: string }> = [];
  let pendingName = '';

  for (const line of lines) {
    const deadlineMatch = line.match(/^Deadline:\s*(.+)$/i);
    if (deadlineMatch) {
      if (items.length > 0) {
        const deadline = deadlineMatch[1].trim();
        items[items.length - 1].deadline = deadline;
        if (deadline && deadline.toLowerCase() !== 'none listed') {
          items[items.length - 1].description += `\nDeadline: ${deadline}`;
        }
      }
      continue;
    }

    const rawUrls = extractUrls(line);
    if (rawUrls.length === 0) {
      pendingName = compactItemName(line);
      continue;
    }

    const cleanedUrls = rawUrls.map(url => normalizeParsedSourceUrl(url));
    const sourceUrl = pickCompactSourceUrl(cleanedUrls);
    let nameSource = line;
    for (const url of rawUrls) nameSource = nameSource.replace(url, '');
    const name = compactItemName(nameSource) || compactItemName(pendingName);
    pendingName = '';
    const resolvedName = (name.length > 2 ? name : buildName(name || sourceUrl, sourceUrl)).slice(0, 120);
    items.push({
      name: resolvedName,
      description: name.length > 2 ? name : resolvedName,
      sourceUrl,
    });
  }

  const usable = items.filter(item => item.name.length > 2 && /^https?:\/\//i.test(item.sourceUrl));
  return usable.length >= 2 ? usable : [];
}

export function parseBatchEntries(text: string): Array<{ name: string; description: string; sourceUrl: string; deadline?: string }> {
  // Grok count lines can appear at the start, end, or between concatenated
  // scan blocks. Remove every standalone control line before chunking so it
  // cannot become the next entry's title.
  const cleaned = stripBatchControlLines(text);

  // Detect format: numbered vs structured Source:/Link: vs markdown-link vs bold
  const isNumbered = /^\s*\d+\.\s+/.test(cleaned);
  const structuredBlocks = hasStructuredSourceBlocks(cleaned);
  const mdLinkMatches = [...cleaned.matchAll(/\[([^\]]{3,})\]\((https?:\/\/[^)]+)\)/g)];
  const titleMdLinks = mdLinkMatches.filter(match => !isSourceAttributionMarkdownLink(cleaned, match));
  const isMarkdownLinks = !isNumbered
    && !structuredBlocks
    && !/\*\*[^*]+\*\*/.test(cleaned)
    && titleMdLinks.length >= 2;

  let chunks: string[];
  if (isNumbered) {
    // Split on numbered item boundaries: \n1. or \n2. etc
    chunks = cleaned.split(/\n(?=\s*\d+\.\s+)/).filter(c => c.trim() && /^\s*\d+\./.test(c.trim()));
  } else if (isMarkdownLinks) {
    // Markdown link format: [Name](url) — common in newsletters/briefings
    // Each [Name](url) is one entry; extract name, URL, and surrounding description
    return titleMdLinks.map(m => {
      const name = m[1].trim().slice(0, 120);
      const sourceUrl = m[2].trim();
      // Get text after the closing ) on the same line for description
      const afterIdx = m.index! + m[0].length;
      const afterText = cleaned.substring(afterIdx).split('\n')[0];
      const descMatch = afterText.match(/^\s*[—–\-]\s*(.+)/);
      const description = descMatch ? descMatch[1].trim() : name;
      return { name, description, sourceUrl };
    }).filter(e => e.name.length > 2);
  } else if (/\*\*[^*]+\*\*/.test(cleaned)) {
    // Bold-name format with literal ** markers
    chunks = cleaned.split(/\n(?=\s*\*\*[^*]+\*\*\s*[—–\-])/).filter(c => {
      const trimmed = c.trim();
      return trimmed.length > 0 && /^\*\*[^*]+\*\*/.test(trimmed);
    });
  } else {
    // Plain-text structured format (Telegram stripped ** markers):
    // Split inline one-entry-per-line Grok batches first, e.g.
    // "Name — Description. Deadline: June 7, 2026 Link: https://...".
    const inlineStructuredLines = cleaned
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^[^\n—–]{3,}\s*[—–]\s+.+\bDeadline:\s+.+\bLink:\s+.+/i.test(line));

    if (inlineStructuredLines.length >= 2) {
      chunks = inlineStructuredLines;
    } else {
      // Split on any structured Link: line, including placeholders like
      // "Link: (via post)". URL-less but strong leads should be preserved for
      // source verification instead of silently dropped.
      chunks = [];
      let block = '';
      for (const line of cleaned.split('\n')) {
        const trimmed = line.trim();
        block += line + '\n';
        if (/^Link:\s*.+/i.test(trimmed)) {
          chunks.push(block.trim());
          block = '';
        }
      }
      chunks = chunks.filter(c => c.length > 0 && /^\s*Link:\s*.+/im.test(c));

      if (chunks.length === 0) {
        let sourceBlock = '';
        for (const line of cleaned.split('\n')) {
          const trimmed = line.trim();
          sourceBlock += line + '\n';
          if (/^Source:\s*.+/i.test(trimmed)) {
            chunks.push(sourceBlock.trim());
            sourceBlock = '';
          }
        }
        chunks = chunks.filter(c => c.length > 0 && /^\s*Source:\s*.+/im.test(c));
      }

      if (chunks.length === 0) {
        const compact = parseCompactUrlListEntries(cleaned);
        if (compact.length >= 2) return compact;
        chunks = cleaned.split(/\n\s*\n/).filter(c => c.trim().length > 0);
      }
    }
  }

  return chunks.map((rawChunk, chunkIndex) => {
    // Trim leading blank lines and strip numbered prefix (e.g. "14. " or " 3.  ")
    const chunk = rawChunk.trim();
    const withoutPrefix = chunk.replace(/^\s*\d+\.\s+/, '');

    // Plain-text scans sometimes put prose before the first real item. The
    // chunker closes blocks on Link: lines, so that prose otherwise becomes
    // the item's name while the real title supplies its description. When a
    // later line has the canonical "Name — Description" shape, start there.
    const unprefixedLines = withoutPrefix.split('\n');
    const firstLine = unprefixedLines[0]?.trim() || '';
    const preambleSignals = firstLine.match(
      /\b(?:scan|results?|matches?|announcements?|findings?|compiled|qualifying)\b/gi,
    )?.length || 0;
    const looksLikePreamble = chunkIndex === 0
      && preambleSignals >= 2
      && /^(?:no\b|here(?:'s| is| are)\b|the following\b|below (?:is|are)\b|compiled\b|scan\b)/i.test(firstLine);
    const structuredTitleIndex = looksLikePreamble
      ? unprefixedLines.findIndex((line, index) =>
          index > 0 && /^[^—–\n]{3,120}\s*[—–]\s+\S/.test(line.trim()),
        )
      : -1;
    const entryText = structuredTitleIndex > 0
      ? unprefixedLines.slice(structuredTitleIndex).join('\n').trim()
      : withoutPrefix;

    // Extract name from **bold** or leading text (now without numbered prefix)
    const boldMatch = entryText.match(/^\*\*([^*]+)\*\*/);
    // For non-bold: capture up to em dash, en dash, or newline
    const plainMatch = entryText.match(/^([^\n—–]+)/);

    let rawName: string;
    if (boldMatch) {
      rawName = boldMatch[1].trim();
    } else if (plainMatch) {
      rawName = plainMatch[1].trim();
    } else {
      rawName = entryText.split('\n')[0].trim();
    }

    // Strip trailing em-dash description suffix and any leftover numbered prefix
    const name = rawName
      .replace(/\s*—.*$/, '')
      .replace(/^\d+\.\s+/, '')  // safety: strip any remaining numbered prefix
      .replace(/^\[+|\]+$/g, '') // Grok often wraps names in brackets: [Program Name]
      .trim()
      .slice(0, 120);

    // Prefer Source: (the tweet Grok cited) over Link: or a preview URL in the block.
    const sourceUrlFromFields = extractStructuredSourceUrl(chunk);
    const hasDirectUrl = Boolean(sourceUrlFromFields);
    const sourceUrl = hasDirectUrl
      ? sourceUrlFromFields
      : `https://manual/needs-source/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Extract deadline
    const deadlineMatch = chunk.match(/Deadline:\s*([\s\S]+?)(?:\s+Link:|\n|$)/i);
    const deadline = deadlineMatch ? deadlineMatch[1].trim() : undefined;

    // Build clean description: name — description text, append deadline if present
    const descMatch = entryText.match(/\*\*[^*]+\*\*\s*[—–\-]\s*([\s\S]+?)(?:\n(?:Deadline|Link|Source):|\s+Deadline:|\s*$)/)
      || entryText.match(/^[^—–]+[—–]\s*([\s\S]+?)(?:\n(?:Deadline|Link|Source):|\s+Deadline:|\s*$)/);
    let description = descMatch ? descMatch[1].trim() : entryText.replace(/^\d+\.\s*/, '').trim();
    if (!hasDirectUrl) {
      description += '\nNeeds source verification: Grok supplied a via-post or missing-link placeholder.';
    }
    if (deadline && deadline.toLowerCase() !== 'none listed') {
      description += `\nDeadline: ${deadline}`;
    }

    return { name, description, sourceUrl, deadline };
  }).filter(e => e.name.length > 2 && !isBatchControlLine(e.name));
}

/**
 * Process a batch message (numbered list) — inserts one entry per item.
 */
export async function processBatchMessage(
  msg: IntakeMessage,
  scanSource = 'telegram',
  options: IntakeOptions = {},
): Promise<BatchIntakeResult> {
  const text = msg.text.trim();
  const wires = await getActiveWires();
  const scanDate = new Date().toISOString().slice(0, 10);
  const initialStatus = determineInitialIntakeStatus(scanSource, options.origin);
  let entries = parseBatchEntries(text);
  const parsedCount = entries.length;
  const bestBySemanticKey = new Map<string, typeof entries[number]>();
  for (const entry of entries) {
    const key = semanticBatchKey(entry.name);
    const existing = bestBySemanticKey.get(key);
    if (!existing || isBetterBatchSource(entry.sourceUrl, existing.sourceUrl)) {
      bestBySemanticKey.set(key, entry);
    }
  }
  entries = Array.from(bestBySemanticKey.values());

  const result: BatchIntakeResult = {
    inserted: 0,
    duplicates: parsedCount - entries.length,
    errors: 0,
    retryableErrors: 0,
    failed: 0,
    entries: [],
  };
  const seenInBatch = new Map<string, string[]>(); // normalized URL -> accepted names

  for (const entry of entries) {
    const semanticKey = semanticBatchKey(entry.name) || entry.name.toLowerCase();
    const channelItemKey = msg.channelUpdateId ? `batch:${semanticKey}` : undefined;
    if (msg.channelUpdateId && classifySourceLink(entry.sourceUrl) === 'placeholder') {
      entry.sourceUrl = telegramReplayPlaceholder(msg.channelUpdateId, channelItemKey!);
    }

    const replayEntry = await findTelegramReplayEntry(getPool(), msg.channelUpdateId, channelItemKey);
    if (replayEntry !== null) {
      result.inserted++;
      result.entries.push({ name: entry.name, wire: replayEntry.wire, id: replayEntry.id });
      continue;
    }

    const hinted = options.wireHint?.trim().toLowerCase();
    const hintedWire = hinted && wires.includes(hinted) ? hinted : null;
    const combined = `${entry.name} ${entry.description}`;
    const wire = hintedWire || detectWire(combined, wires);

    if (!wire) {
      // Default to 'crypto' if available — most unclassified grant content is crypto.
      // Gate 2 LLM classifier will correct the wire assignment if it's wrong.
      const defaultWire = wires.includes('crypto') ? 'crypto' : wires[0];
      if (!defaultWire) {
        result.errors++;
        result.retryableErrors++;
        result.failed++;
        result.entries.push({
          name: entry.name,
          wire: 'unknown',
          error: 'No wires configured',
          retryable: true,
        });
        continue;
      }
      console.log(`[BatchIntake] Wire not detected for "${entry.name}", defaulting to "${defaultWire}"`);
      // Proceed with defaultWire
      const resolvedWire = defaultWire;
      // (fall through by reassigning wire variable)
      Object.assign(entry, { _resolvedWire: resolvedWire });
    }
    const resolvedWire = (entry as typeof entry & { _resolvedWire?: string })._resolvedWire || wire!;

    const sourceClass = classifySourceLink(entry.sourceUrl);
    if (sourceClass === 'missing' || sourceClass === 'invalid' || sourceClass === 'shortener') {
      result.errors++;
      result.failed++;
      result.entries.push({ name: entry.name, wire: resolvedWire, error: 'Missing verifiable source URL' });
      continue;
    }
    const sourceNeedsVerification = sourceClass === 'placeholder';

    // Gate 1: reject known Tier-3 aggregator sources
    const batchBlocked = blockedSourceDomain(entry.sourceUrl);
    if (batchBlocked) {
      result.errors++;
      result.failed++;
      result.entries.push({ name: entry.name, wire: resolvedWire, error: `Blocked aggregator source: ${batchBlocked}` });
      continue;
    }

    // Within-batch dedup: catch same URL appearing multiple times in one submission
    const normalizedBatchUrl = normalizeUrl(entry.sourceUrl);
    const priorNames = seenInBatch.get(normalizedBatchUrl) || [];
    let isSocialAggregate = false;
    try {
      const host = new URL(entry.sourceUrl).hostname
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/\.+$/, '');
      isSocialAggregate = host === 'x.com' || host === 'twitter.com';
    } catch {
      isSocialAggregate = false;
    }
    if (priorNames.length > 0 && (!isSocialAggregate || priorNames.length >= 2)) {
      result.duplicates++;
      result.failed++;
      result.entries.push({ name: entry.name, wire: resolvedWire, error: 'Duplicate URL within batch', isDuplicate: true });
      continue;
    }

    // DB dedup check — fail open if dedup service errors
    try {
      const dedupResult = await checkDuplicate(getPool(), { sourceUrl: entry.sourceUrl, name: entry.name, wire: resolvedWire }, 180, { urlOnly: true });
      if (dedupResult.isDuplicate) {
        result.duplicates++;
        result.failed++;
        result.entries.push({ name: entry.name, wire: resolvedWire, error: `Already seen as "${dedupResult.matchedEntryName}"`, isDuplicate: true });
        continue;
      }
    } catch (dedupErr) {
      console.error(`[IntakeCore] Dedup check failed for "${entry.name}", proceeding with insert:`, dedupErr);
    }

    try {
      const inserted = await insertIntakeEntryWithClaim(getPool(), {
        name: entry.name,
        description: entry.description,
        sourceUrl: entry.sourceUrl,
        wire: resolvedWire,
        scanDate,
        submittedBy: msg.senderId,
        scanSource,
        status: initialStatus,
        deadline: normalizeDeadlineForDb(entry.deadline, scanDate),
        sourceNeedsVerification,
        operatorRoute: sourceNeedsVerification ? 'source_check' : undefined,
        channelMessageId: msg.channelMessageId,
        channelUpdateId: msg.channelUpdateId,
        channelItemKey,
        forwardedFrom: msg.forwardedFrom,
      });
      if (inserted.urlConflict) {
        result.duplicates++;
        result.failed++;
        result.entries.push({
          name: entry.name,
          wire: resolvedWire,
          id: inserted.id,
          error: inserted.conflictEntryId === null
            ? 'Exact URL already exists in history'
            : `Exact URL already belongs to entry #${inserted.conflictEntryId}`,
          isDuplicate: true,
        });
        seenInBatch.set(normalizedBatchUrl, [...priorNames, entry.name]);
        continue;
      }
      const id = inserted.id;
      seenInBatch.set(normalizedBatchUrl, [...priorNames, entry.name]);
      result.inserted++;
      result.entries.push({ name: entry.name, wire: resolvedWire, id });
    } catch (err) {
      result.errors++;
      result.retryableErrors++;
      result.failed++;
      result.entries.push({
        name: entry.name,
        wire: resolvedWire,
        error: err instanceof Error ? err.message : 'Insert failed',
        retryable: true,
      });
    }
  }

  // Dumb pipe: batch items land in the queue as-is. No classification at intake —
  // scoring/classification/routing is the downstream filter's job.

  return result;
}
