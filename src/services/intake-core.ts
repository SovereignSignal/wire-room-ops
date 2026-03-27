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

import { getPool, getAllFeeds } from '../db';
import { checkDuplicate, registerSeen } from '../services/dedup';
import { classifyEntry } from '../services/classifier';
import { getActiveParams } from './quality-scorer';

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface IntakeMessage {
  text: string;              // raw message text
  urls?: string[];           // pre-extracted URLs (optional, core will also extract)
  senderId: string;          // channel-specific user ID
  channelMessageId: string;  // for correlating callback responses
  forwardedFrom?: string;    // original source name if forwarded
}

export interface IntakeResult {
  status: 'inserted' | 'needs_wire' | 'rejected' | 'error';
  entryId?: number;
  pendingKey?: string;       // key for completing wire selection later
  detectedWire?: string;
  availableWires?: string[]; // from DB
  confirmText?: string;      // human-readable summary of what was captured
  errorMessage?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Pending entries (waiting for wire selection)
// ────────────────────────────────────────────────────────────────────────────

interface PendingEntry {
  name: string;
  description: string;
  sourceUrl: string;
  scanDate: string;
  submittedBy: string;
  scanSource: string;
  createdAt: number;
}

const pendingEntries = new Map<string, PendingEntry>();

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

async function insertEntry(entry: {
  name: string;
  description: string;
  sourceUrl: string;
  wire: string;
  scanDate: string;
  submittedBy: string;
  scanSource: string;
  status?: string;
  experimentId?: string | null;
}): Promise<number> {
  const pool = getPool();
  const status = entry.status ?? 'raw'; // Raw entries flow through the classification pipeline
  const res = await pool.query(
    `INSERT INTO scan_entries
     (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status, submitted_by, experiment_id)
     VALUES ($1, $2, $3, $4, 'N', $5, $6, $7, $8, $9)
     RETURNING id`,
    [entry.name, entry.description, entry.sourceUrl, entry.wire, entry.scanSource, entry.scanDate, status, entry.submittedBy, entry.experimentId ?? null]
  );
  return res.rows[0].id;
}

// ────────────────────────────────────────────────────────────────────────────
// Post-insert classification (fire-and-forget)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Classify a newly-inserted raw entry and promote it to 'queued'.
 * Runs async — caller does not wait for completion.
 */
async function classifyAndQueue(entryId: number, name: string, description: string, sourceUrl: string, wire: string): Promise<void> {
  try {
    const result = await classifyEntry({ name, description, source_url: sourceUrl, wire });
    const newStatus = result.classification === 'NOISE' ? 'archived' : 'queued';
    const pool = getPool();
    await pool.query(
      `UPDATE scan_entries
       SET quality_score = $1, quality_breakdown = $2, status = $8,
           classification = $3, classification_reason = $4,
           metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
           tags = $6
       WHERE id = $7 AND status = 'raw'`,
      [
        result.qualityScore,
        JSON.stringify({ scoreReason: result.scoreReason }),
        result.classification,
        result.reason,
        JSON.stringify(result.extracted),
        result.tags,
        entryId,
        newStatus,
      ]
    );
    console.log(`[IntakeCore] Classified entry #${entryId}: ${result.classification} → ${newStatus} (score: ${result.qualityScore})`);
  } catch (err) {
    // Fallback: promote to queued with score 0 so it's still visible
    console.error(`[IntakeCore] Classification failed for entry #${entryId}, queuing with score 0:`, err);
    const pool = getPool();
    await pool.query(`UPDATE scan_entries SET status = 'queued' WHERE id = $1 AND status = 'raw'`, [entryId]);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Core intake functions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Process an incoming message from any channel. Detects wire, inserts entry.
 *
 * @param msg         The channel-agnostic message
 * @param scanSource  The scan_source value for the DB row (default: "manual-intake")
 */
export async function processIntakeMessage(
  msg: IntakeMessage,
  scanSource = 'manual-intake',
): Promise<IntakeResult> {
  const text = msg.text.trim();
  if (!text) {
    return { status: 'rejected', errorMessage: 'Empty message' };
  }

  // Load active wires
  const wires = await getActiveWires();
  if (wires.length === 0) {
    return { status: 'error', errorMessage: 'No active wires configured' };
  }

  const { experimentId } = await getActiveParams();

  // Extract URLs
  const textUrls = extractUrls(text);
  const passedUrls = msg.urls || [];
  const allUrls = [...new Set([...passedUrls, ...textUrls])];
  const primaryUrl = allUrls[0] || `https://t.me/manual/${Date.now()}`;

  const name = buildName(text, allUrls[0] || null);
  const scanDate = new Date().toISOString().slice(0, 10);

  // Detect wire
  const wire = detectWire(text, wires);

  if (wire) {
    // Dedup check — fail open if dedup service errors
    try {
      const dedupResult = await checkDuplicate(getPool(), { sourceUrl: primaryUrl, name, wire }, 180);
      if (dedupResult.isDuplicate) {
        return { status: 'rejected', errorMessage: `Duplicate: already seen as "${dedupResult.matchedEntryName}"` };
      }
    } catch (dedupErr) {
      console.error('[IntakeCore] Dedup check failed, proceeding with insert:', dedupErr);
    }

    try {
      const id = await insertEntry({
        name,
        description: text,
        sourceUrl: primaryUrl,
        wire,
        scanDate,
        submittedBy: msg.senderId,
        scanSource,
        experimentId,
      });
      // Register in dedup tables immediately so future scans won't re-discover this entry.
      // classifyAndQueue (below) promotes status from raw→queued before processRawEntries
      // runs, so processRawEntries never sees these entries. ON CONFLICT DO NOTHING makes
      // double-registration harmless.
      await registerSeen(getPool(), { id, sourceUrl: primaryUrl, name, wire, scanDate });
      // Fire-and-forget classification so entry gets scored before next intake run
      setImmediate(() => classifyAndQueue(id, name, text, primaryUrl, wire));
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
    const dedupResult = await checkDuplicate(getPool(), { sourceUrl: primaryUrl, name, wire: fallbackWire }, 180);
    if (dedupResult.isDuplicate) {
      return { status: 'rejected', errorMessage: `Duplicate: already seen as "${dedupResult.matchedEntryName}"` };
    }
  } catch (dedupErr) {
    console.error('[IntakeCore] Dedup check failed, proceeding with insert:', dedupErr);
  }

  try {
    const id = await insertEntry({
      name,
      description: text,
      sourceUrl: primaryUrl,
      wire: fallbackWire,
      scanDate,
      submittedBy: msg.senderId,
      scanSource,
      experimentId,
    });
    await registerSeen(getPool(), { id, sourceUrl: primaryUrl, name, wire: fallbackWire, scanDate });
    // Fire-and-forget classification so entry gets scored before next intake run
    setImmediate(() => classifyAndQueue(id, name, text, primaryUrl, fallbackWire));
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

/**
 * Complete a pending intake after the user selects a wire.
 */
export async function completeWireSelection(
  pendingKey: string,
  wire: string,
): Promise<IntakeResult> {
  const { experimentId } = await getActiveParams();

  const entry = pendingEntries.get(pendingKey);
  if (!entry) {
    return { status: 'error', errorMessage: 'Pending entry expired or not found' };
  }

  pendingEntries.delete(pendingKey);

  // Dedup check — fail open if dedup service errors
  try {
    const dedupResult = await checkDuplicate(getPool(), { sourceUrl: entry.sourceUrl, name: entry.name, wire }, 180);
    if (dedupResult.isDuplicate) {
      return { status: 'rejected', errorMessage: `Duplicate: already seen as "${dedupResult.matchedEntryName}"` };
    }
  } catch (dedupErr) {
    console.error('[IntakeCore] Dedup check failed, proceeding with insert:', dedupErr);
  }

  try {
    const id = await insertEntry({ ...entry, wire, experimentId });
    await registerSeen(getPool(), { id, sourceUrl: entry.sourceUrl, name: entry.name, wire, scanDate: entry.scanDate });
    // Fire-and-forget classification
    setImmediate(() => classifyAndQueue(id, entry.name, entry.description, entry.sourceUrl, wire));
    return {
      status: 'inserted',
      entryId: id,
      detectedWire: wire,
      confirmText: `Captured ${wire} entry #${id}: ${entry.name}`,
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
  /** @deprecated use duplicates + errors instead */
  failed: number;
  entries: Array<{ name: string; wire: string; id?: number; error?: string; isDuplicate?: boolean }>;
}

/**
 * Detect whether a message is a batch list.
 * Matches:
 *   - Numbered: "1. **Name**" or "1. Text" with "2. " later
 *   - Bold markdown: "**Name** — Description" appearing 2+ times
 *   - Markdown links: "[Name](url)" appearing 2+ times (newsletters/briefings)
 *   - Structured: Multiple "Link: https://..." lines (Telegram strips ** to bold rendering)
 */
export function isBatchMessage(text: string): boolean {
  // Numbered list format
  if (/^\s*1\.\s+\*\*/.test(text)) return true;
  if (/^\s*1\.\s+\S/.test(text) && /\n\s*2\.\s+/.test(text)) return true;

  // Bold-name format with literal ** markers
  const boldEntries = text.match(/^\s*\*\*[^*]+\*\*\s*[—–\-]/gm);
  if (boldEntries && boldEntries.length >= 2) return true;
  if (boldEntries && boldEntries.length === 1 && /\nLink:\s*https?:\/\//i.test(text)) return true;

  // Markdown link format: [Name](url) — common in newsletters/briefings
  const mdLinks = text.match(/\[([^\]]{3,})\]\(https?:\/\/[^)]+\)/g);
  if (mdLinks && mdLinks.length >= 2) return true;

  // Structured format without ** (Telegram renders bold and strips markers):
  // Multiple "Link: <url>" lines = structured batch
  const linkLines = text.match(/^Link:\s*https?:\/\//gim);
  if (linkLines && linkLines.length >= 2) return true;
  // Single entry with both Deadline: and Link: (Telegram split of larger batch)
  if (linkLines && linkLines.length === 1 && /\nDeadline:/i.test(text)) return true;

  return false;
}

/**
 * Parse a batch list into individual entries.
 * Handles three formats:
 *   Numbered:  N. **Name** — Description / Deadline: X / Link: <url>
 *   Bold:      **Name** — Description / Deadline: X / Link: <url>
 *   Markdown:  [Name](url) — Description (newsletters/briefings)
 */
function parseBatchEntries(text: string): Array<{ name: string; description: string; sourceUrl: string; deadline?: string }> {
  // Strip trailing "Total: N results..." line
  const cleaned = text.replace(/\n*Total:\s*\d+\s+results?[^\n]*$/i, '').trim();

  // Detect format: numbered vs bold-name vs markdown-link
  const isNumbered = /^\s*\d+\.\s+/.test(cleaned);
  const mdLinkMatches = [...cleaned.matchAll(/\[([^\]]{3,})\]\((https?:\/\/[^)]+)\)/g)];
  const isMarkdownLinks = !isNumbered && !/\*\*[^*]+\*\*/.test(cleaned) && mdLinkMatches.length >= 2;

  let chunks: string[];
  if (isNumbered) {
    // Split on numbered item boundaries: \n1. or \n2. etc
    chunks = cleaned.split(/\n(?=\s*\d+\.\s+)/).filter(c => c.trim() && /^\s*\d+\./.test(c.trim()));
  } else if (isMarkdownLinks) {
    // Markdown link format: [Name](url) — common in newsletters/briefings
    // Each [Name](url) is one entry; extract name, URL, and surrounding description
    return mdLinkMatches.map(m => {
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
    // Split on blank lines or before lines that look like entry starts (Name — Description)
    // Each entry block has: Name — Description, Deadline: ..., Link: ...
    chunks = cleaned.split(/\n\s*\n/).filter(c => {
      const trimmed = c.trim();
      // Must contain a Link: line to be a valid entry
      return trimmed.length > 0 && /Link:\s*https?:\/\//i.test(trimmed);
    });

    // Fallback: if blank-line split produced fewer chunks than Link: lines,
    // entries are run together without blank lines. Re-split by accumulating
    // lines into blocks that end when a new "Link:" line starts a new entry.
    const linkLineCount = (cleaned.match(/^Link:\s*https?:\/\//gim) || []).length;
    if (chunks.length < linkLineCount && linkLineCount >= 2) {
      chunks = [];
      let block = '';
      for (const line of cleaned.split('\n')) {
        // A "Link:" line closes the current entry after it's appended
        block += line + '\n';
        if (/^Link:\s*https?:\/\//i.test(line.trim())) {
          chunks.push(block.trim());
          block = '';
        }
      }
      // Remaining lines without a Link: are discarded (incomplete entry)
      chunks = chunks.filter(c => c.length > 0 && /Link:\s*https?:\/\//i.test(c));
    }
  }

  return chunks.map(rawChunk => {
    // Trim leading blank lines and strip numbered prefix (e.g. "14. " or " 3.  ")
    const chunk = rawChunk.trim();
    const withoutPrefix = chunk.replace(/^\s*\d+\.\s+/, '');

    // Extract name from **bold** or leading text (now without numbered prefix)
    const boldMatch = withoutPrefix.match(/^\*\*([^*]+)\*\*/);
    // For non-bold: capture up to em dash, en dash, or newline
    const plainMatch = withoutPrefix.match(/^([^\n—–]+)/);

    let rawName: string;
    if (boldMatch) {
      rawName = boldMatch[1].trim();
    } else if (plainMatch) {
      rawName = plainMatch[1].trim();
    } else {
      rawName = withoutPrefix.split('\n')[0].trim();
    }

    // Strip trailing em-dash description suffix and any leftover numbered prefix
    const name = rawName
      .replace(/\s*—.*$/, '')
      .replace(/^\d+\.\s+/, '')  // safety: strip any remaining numbered prefix
      .trim()
      .slice(0, 120);

    // Extract URL from Link: line or any https:// in chunk
    const linkMatch = chunk.match(/Link:\s*<?(\bhttps?:\/\/[^\s>]+)/i);
    const urlMatch = chunk.match(/\bhttps?:\/\/[^\s<>)]+/);
    const sourceUrl = (linkMatch?.[1] || urlMatch?.[0] || '').trim() || `https://manual/${Date.now()}`;

    // Extract deadline
    const deadlineMatch = chunk.match(/Deadline:\s*([^\n]+)/i);
    const deadline = deadlineMatch ? deadlineMatch[1].trim() : undefined;

    // Build clean description: name — description text, append deadline if present
    const descMatch = chunk.match(/\*\*[^*]+\*\*\s*[—–\-]\s*([\s\S]+?)(?:\n(?:Deadline|Link):|\s*$)/)
      || withoutPrefix.match(/^[^—–]+[—–]\s*([\s\S]+?)(?:\n(?:Deadline|Link):|\s*$)/);
    let description = descMatch ? descMatch[1].trim() : chunk.replace(/^\d+\.\s*/, '').trim();
    if (deadline && deadline.toLowerCase() !== 'none listed') {
      description += `\nDeadline: ${deadline}`;
    }

    return { name, description, sourceUrl, deadline };
  }).filter(e => e.name.length > 2);
}

/**
 * Process a batch message (numbered list) — inserts one entry per item.
 */
export async function processBatchMessage(
  msg: IntakeMessage,
  scanSource = 'telegram',
): Promise<BatchIntakeResult> {
  const text = msg.text.trim();
  const wires = await getActiveWires();
  const scanDate = new Date().toISOString().slice(0, 10);
  const entries = parseBatchEntries(text);
  const { experimentId } = await getActiveParams();

  const result: BatchIntakeResult = { inserted: 0, duplicates: 0, errors: 0, failed: 0, entries: [] };
  const toClassify: Array<{ id: number; name: string; description: string; sourceUrl: string; wire: string }> = [];

  for (const entry of entries) {
    // Detect wire from combined name + description
    const combined = `${entry.name} ${entry.description}`;
    const wire = detectWire(combined, wires);

    if (!wire) {
      // Default to 'crypto' if available — most unclassified grant content is crypto.
      // Gate 2 LLM classifier will correct the wire assignment if it's wrong.
      const defaultWire = wires.includes('crypto') ? 'crypto' : wires[0];
      if (!defaultWire) {
        result.errors++;
        result.failed++;
        result.entries.push({ name: entry.name, wire: 'unknown', error: 'No wires configured' });
        continue;
      }
      console.log(`[BatchIntake] Wire not detected for "${entry.name}", defaulting to "${defaultWire}"`);
      // Proceed with defaultWire
      const resolvedWire = defaultWire;
      // (fall through by reassigning wire variable)
      Object.assign(entry, { _resolvedWire: resolvedWire });
    }
    const resolvedWire = (entry as typeof entry & { _resolvedWire?: string })._resolvedWire || wire!;

    // Dedup check — fail open if dedup service errors
    try {
      const dedupResult = await checkDuplicate(getPool(), { sourceUrl: entry.sourceUrl, name: entry.name, wire: resolvedWire }, 180);
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
      const id = await insertEntry({
        name: entry.name,
        description: entry.description,
        sourceUrl: entry.sourceUrl,
        wire: resolvedWire,
        scanDate,
        submittedBy: msg.senderId,
        scanSource,
        experimentId,
      });
      await registerSeen(getPool(), { id, sourceUrl: entry.sourceUrl, name: entry.name, wire: resolvedWire, scanDate });
      toClassify.push({ id, name: entry.name, description: entry.description, sourceUrl: entry.sourceUrl, wire: resolvedWire });
      result.inserted++;
      result.entries.push({ name: entry.name, wire: resolvedWire, id });
    } catch (err) {
      result.errors++;
      result.failed++;
      result.entries.push({ name: entry.name, wire: resolvedWire, error: err instanceof Error ? err.message : 'Insert failed' });
    }
  }

  // Classify all inserted entries sequentially in a single setImmediate
  // to avoid N concurrent LLM calls that can hit API rate limits.
  if (toClassify.length > 0) {
    setImmediate(async () => {
      for (const e of toClassify) {
        await classifyAndQueue(e.id, e.name, e.description, e.sourceUrl, e.wire);
      }
    });
  }

  // Refresh experiment counts after batch insert
  if (experimentId && result.inserted > 0) {
    try {
      const { ExperimentEngine } = await import('./experiment-engine');
      const engine = new ExperimentEngine();
      await engine.refreshCounts(experimentId);
    } catch (err) {
      console.error('[IntakeCore] Failed to refresh experiment counts:', err);
    }
  }

  return result;
}

/**
 * Cleanup expired pending entries (older than 1 hour).
 */
export function cleanupPendingEntries(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [key, entry] of pendingEntries.entries()) {
    if (entry.createdAt < oneHourAgo) {
      pendingEntries.delete(key);
    }
  }
}
