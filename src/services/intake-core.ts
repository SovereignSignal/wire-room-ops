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
  crypto: ['grant', 'protocol', 'defi', 'ethereum', 'solana', 'arbitrum', 'optimism', 'dao', 'web3', 'blockchain', 'uniswap', 'aave', 'crypto', 'token', 'staking'],
  ai: ['llm', 'openai', 'anthropic', 'gpt', 'machine learning', 'artificial intelligence', 'foundation model', 'deep learning', 'neural', 'transformer'],
  oss: ['open source', 'github', 'apache', 'linux', 'cncf', 'mozilla', 'open-source', 'foss', 'libre'],
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
  const escaped = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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
  const firstLine = text.split('\n')[0].trim();
  if (firstLine && firstLine !== url) {
    return firstLine.slice(0, 120);
  }
  if (url) {
    try {
      const domain = new URL(url).hostname.replace('www.', '');
      return `Manual: ${domain}`;
    } catch {
      return 'Manual submission';
    }
  }
  return 'Manual submission';
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
}): Promise<number> {
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO scan_entries
     (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status, submitted_by)
     VALUES ($1, $2, $3, $4, 'N', $5, $6, 'raw', $7)
     RETURNING id`,
    [entry.name, entry.description, entry.sourceUrl, entry.wire, entry.scanSource, entry.scanDate, entry.submittedBy]
  );
  return res.rows[0].id;
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
    try {
      const id = await insertEntry({
        name,
        description: text,
        sourceUrl: primaryUrl,
        wire,
        scanDate,
        submittedBy: msg.senderId,
        scanSource,
      });
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

  // Ambiguous or no match — store as pending
  const pendingKey = `${msg.senderId}_${msg.channelMessageId}`;
  pendingEntries.set(pendingKey, {
    name,
    description: text,
    sourceUrl: primaryUrl,
    scanDate,
    submittedBy: msg.senderId,
    scanSource,
    createdAt: Date.now(),
  });

  return {
    status: 'needs_wire',
    pendingKey,
    availableWires: wires,
  };
}

/**
 * Complete a pending intake after the user selects a wire.
 */
export async function completeWireSelection(
  pendingKey: string,
  wire: string,
): Promise<IntakeResult> {
  const entry = pendingEntries.get(pendingKey);
  if (!entry) {
    return { status: 'error', errorMessage: 'Pending entry expired or not found' };
  }

  pendingEntries.delete(pendingKey);

  try {
    const id = await insertEntry({ ...entry, wire });
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
