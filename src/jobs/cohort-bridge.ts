/**
 * Cohort Notion bridge — Cowork + Codex daily scans table → WRO.
 *
 * The desktop producers write rows into the shared Notion "Cowork + Codex –
 * Daily Grant Scans Table". The Stringer VM used to ingest that table at
 * 05:00 PT and stamp `source_runs` (`claude-cohort-notion`). When that host
 * misses a window, the digest health check opens a durable backfill cursor
 * and the lane stays red until a successful run_id containing "backfill" or
 * "replay" is recorded.
 *
 * This job is the in-process failover, folded into the daily-digest cycle
 * (owner rule: fold, don't multiply). It:
 *   1. Reads the Notion table from the pending cursor (or last heartbeat)
 *   2. Writes a durable source_run heartbeat (always, even on a quiet day)
 *   3. Persists opportunity_observations for every fetched row
 *   4. Promotes rows with a usable URL through intake, including Deferred rows
 *      explicitly marked "Needs review:" by broad-capture producers
 *
 * A pending replay cursor forces the run_id to contain "backfill" so
 * checkCohortHealth clears it on the same digest.
 */

import type { Pool } from 'pg';
import type { IntakeRunSummary, RawScanResult, ScanSubmission } from '../types/intake';
import { config } from '../config';
import { getAppState, setAppState } from '../db';
import { getIntegrationConfigs, queryAllNotionPages } from '../services/notion-sync';
import { isUsefulUrl } from '../services/intake';
import { runDailyIntake } from './daily-intake';
import { normalizeUrl } from '../utils/url';
import {
  COHORT_HEALTH_STATE_KEY,
  COHORT_SOURCE_NAME,
  type CohortHealthState,
} from './cohort-health';

export const COHORT_SEEN_STATE_KEY = 'cohort-bridge:seen-v1';
export const COHORT_TRACK = 'COHORT';
export const COHORT_PROMOTE_LIMIT = 100;
export const DEFAULT_COHORT_DATABASE_ID = '366000c0d590805ba2abdd2957ee86a7';

const SEEN_CAP = 800;
const FALLBACK_WINDOW_MS = 36 * 60 * 60 * 1000;

export interface CohortScanRow {
  pageId: string;
  name: string;
  wire: 'crypto' | 'ai' | 'oss' | null;
  wireLabel: string | null;
  section: string | null;
  url: string;
  summary: string;
  dateFound: string | null;
  deadline: string | null;
  sourceDate: string | null;
  createdTime: string | null;
}

export interface CohortSeenState {
  urls: string[];
  lastRun?: string;
}

export interface CohortBridgeResult {
  skipped: boolean;
  reason?: string;
  ok: boolean;
  runId: string | null;
  isBackfill: boolean;
  since: string | null;
  fetched: number;
  observations: number;
  promoted: number;
  intakeSummary: IntakeRunSummary;
  error?: string;
  durationMs: number;
}

export interface CohortBridgeOptions {
  dryRun?: boolean;
  now?: Date;
  onProgress?: (message: string, pct: number) => void;
}

interface NotionCredentials {
  token: string;
  databaseId: string;
}

interface CohortBridgeDeps {
  getAppState: typeof getAppState;
  setAppState: typeof setAppState;
  getCredentials: () => Promise<NotionCredentials | null>;
  queryPages: (token: string, databaseId: string, sinceIso: string) => Promise<unknown[]>;
  runIntake: typeof runDailyIntake;
  isEnabled: () => boolean;
}

const defaultDeps: CohortBridgeDeps = {
  getAppState,
  setAppState,
  getCredentials: defaultGetCredentials,
  queryPages: defaultQueryPages,
  runIntake: runDailyIntake,
  isEnabled: () => config.cohort.enabled,
};

function emptyIntake(today: string): IntakeRunSummary {
  return {
    runDate: today,
    wire: 'all',
    totalIngested: 0,
    duplicatesFound: 0,
    newUnique: 0,
    averageQualityScore: 0,
    highQualityCount: 0,
    byPrompt: {},
    topFinds: [],
  };
}

function readTitle(prop: unknown): string {
  const items = (prop as { title?: Array<{ plain_text?: string }> } | undefined)?.title || [];
  return items.map(t => t.plain_text || '').join('').trim();
}

function readRichText(prop: unknown): string {
  const items = (prop as { rich_text?: Array<{ plain_text?: string }> } | undefined)?.rich_text || [];
  return items.map(t => t.plain_text || '').join('').trim();
}

function readUrl(prop: unknown): string {
  return String((prop as { url?: string } | undefined)?.url || '').trim();
}

function readSelect(prop: unknown): string | null {
  return (prop as { select?: { name?: string } } | undefined)?.select?.name || null;
}

function readDate(prop: unknown): string | null {
  return (prop as { date?: { start?: string } } | undefined)?.date?.start || null;
}

export function mapCohortWire(value: string | null | undefined): 'crypto' | 'ai' | 'oss' | null {
  const v = (value || '').trim().toLowerCase();
  if (v === 'crypto') return 'crypto';
  if (v === 'ai' || v === 'ai/ml') return 'ai';
  if (v === 'oss' || v === 'open source' || v === 'open-source') return 'oss';
  return null;
}

export function parseNotionScanPage(page: {
  id?: string;
  created_time?: string;
  properties?: Record<string, unknown>;
}): CohortScanRow | null {
  const props = page.properties || {};
  const name = readTitle(props.Name || props.name || props.Title);
  if (!name) return null;
  const wireLabel = readSelect(props.Wire || props.wire);
  return {
    pageId: page.id || '',
    name,
    wire: mapCohortWire(wireLabel),
    wireLabel,
    section: readSelect(props.Section || props.section),
    url: readUrl(props['Primary URL'] || props['primary url'] || props.URL),
    summary: readRichText(props.Summary || props.summary),
    dateFound: readDate(props['Date Found']),
    deadline: readDate(props.Deadline),
    sourceDate: readDate(props['Source Date']),
    createdTime: page.created_time || null,
  };
}

export function shouldPromoteRow(row: CohortScanRow): boolean {
  if (!row.wire) return false;
  if (!row.name.trim()) return false;
  if ((row.section || '').trim().toLowerCase() === 'deferred'
    && !/^needs review:/i.test(row.summary.trim())) return false;
  return isUsefulUrl(row.url);
}

export function routingForRow(row: CohortScanRow, promoted: boolean): string {
  if (promoted) return 'wire_queue_candidate';
  if ((row.section || '').trim().toLowerCase() === 'deferred') return 'raw_only';
  return 'daily_brief';
}

export function dedupeKeyForRow(row: CohortScanRow): string {
  const nu = normalizeUrl(row.url);
  if (nu) return nu.slice(0, 500);
  return `name:${row.name.trim().toLowerCase()}`.slice(0, 500);
}

export function buildCohortRunId(now: Date, isBackfill: boolean): string {
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  const hhmmss = iso.slice(11, 19).replace(/:/g, '');
  const stamp = `${date}T${hhmmss}Z`;
  return isBackfill ? `claude-cohort-backfill-${stamp}` : `claude-cohort-${stamp}`;
}

export function selectCohortSince(input: {
  pendingBackfillFrom?: string | null;
  lastSuccessfulFinishedAt?: string | null;
  now: Date;
  fallbackMs?: number;
}): string {
  if (input.pendingBackfillFrom && !Number.isNaN(Date.parse(input.pendingBackfillFrom))) {
    return new Date(input.pendingBackfillFrom).toISOString();
  }
  if (input.lastSuccessfulFinishedAt && !Number.isNaN(Date.parse(input.lastSuccessfulFinishedAt))) {
    return new Date(input.lastSuccessfulFinishedAt).toISOString();
  }
  return new Date(input.now.getTime() - (input.fallbackMs ?? FALLBACK_WINDOW_MS)).toISOString();
}

export function rowIsInWindow(row: CohortScanRow, sinceIso: string): boolean {
  const sinceMs = Date.parse(sinceIso);
  const sinceDay = sinceIso.slice(0, 10);
  if (row.dateFound) {
    const foundMs = Date.parse(row.dateFound);
    if (!Number.isNaN(foundMs) && foundMs >= sinceMs) return true;
    if (row.dateFound.slice(0, 10) >= sinceDay) return true;
  }
  if (row.createdTime) {
    const createdMs = Date.parse(row.createdTime);
    if (!Number.isNaN(createdMs) && createdMs >= sinceMs) return true;
  }
  return false;
}

function sourceDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || null;
  } catch {
    return null;
  }
}

export function toRaw(row: CohortScanRow, runId: string): RawScanResult {
  return {
    name: row.name,
    description: row.summary || row.name,
    sourceUrl: row.url,
    amount: null,
    deadline: row.deadline,
    sourcePublishedAt: row.sourceDate,
    metadata: {
      cohort_bridge: {
        run_id: runId,
        notion_page_id: row.pageId,
        section: row.section,
        date_found: row.dateFound,
      },
    },
  };
}

async function defaultGetCredentials(): Promise<NotionCredentials | null> {
  const databaseId = config.cohort.databaseId || DEFAULT_COHORT_DATABASE_ID;
  if (config.cohort.token) return { token: config.cohort.token, databaseId };
  const configs = await getIntegrationConfigs('notion');
  const integration = configs.find(c => c.enabled && c.config?.notion_token);
  if (!integration?.config?.notion_token) return null;
  return {
    token: String(integration.config.notion_token),
    databaseId: String(integration.config.cohort_database_id || databaseId),
  };
}

async function defaultQueryPages(token: string, databaseId: string, sinceIso: string): Promise<unknown[]> {
  const sinceDate = sinceIso.slice(0, 10);
  try {
    return await queryAllNotionPages(token, databaseId, {
      filter: {
        or: [
          { property: 'Date Found', date: { on_or_after: sinceDate } },
          { timestamp: 'created_time', created_time: { on_or_after: sinceIso } },
        ],
      },
    });
  } catch (err) {
    console.warn(`[Cohort] filtered Notion query failed (${err instanceof Error ? err.message : err}); falling back to full table`);
    return queryAllNotionPages(token, databaseId);
  }
}

function mergeSeenUrls(existing: string[] | undefined, incoming: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const url of [...incoming, ...(existing || [])]) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= SEEN_CAP) break;
  }
  return out;
}

async function writeSourceRun(
  pool: Pool,
  row: {
    runId: string;
    startedAt: Date;
    finishedAt: Date;
    status: string;
    fetched: number;
    normalized: number;
    error?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO source_runs (
       run_id, track, source_name, source_domain,
       started_at, finished_at, status,
       records_fetched, records_normalized, error_message
     ) VALUES ($1, $2, $3, 'notion.so', $4, $5, $6, $7, $8, $9)
     ON CONFLICT (run_id, source_name) DO UPDATE SET
       finished_at = EXCLUDED.finished_at,
       status = EXCLUDED.status,
       records_fetched = EXCLUDED.records_fetched,
       records_normalized = EXCLUDED.records_normalized,
       error_message = EXCLUDED.error_message,
       updated_at = NOW()`,
    [
      row.runId,
      COHORT_TRACK,
      COHORT_SOURCE_NAME,
      row.startedAt,
      row.finishedAt,
      row.status,
      row.fetched,
      row.normalized,
      row.error ?? null,
    ],
  );
}

async function insertObservations(
  pool: Pool,
  runId: string,
  rows: Array<{ row: CohortScanRow; routing: string }>,
): Promise<number> {
  let inserted = 0;
  for (const { row, routing } of rows) {
    const result = await pool.query(
      `INSERT INTO opportunity_observations (
         run_id, track, source_name, source_domain, wire,
         source_record_id, title, organization, opportunity_type,
         description, url, apply_url, deadline, amount, currency,
         ecosystem, status, confidence, routing, dedupe_key, raw_payload
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, NULL, NULL,
         $8, $9, $9, $10, NULL, NULL,
         $11, $12, NULL, $13, $14, $15::jsonb
       )
       ON CONFLICT (run_id, source_name, dedupe_key) DO NOTHING
       RETURNING id`,
      [
        runId,
        COHORT_TRACK,
        COHORT_SOURCE_NAME,
        sourceDomain(row.url),
        row.wire,
        row.pageId || null,
        row.name,
        row.summary || null,
        row.url || null,
        row.deadline,
        row.wire,
        row.section,
        routing,
        dedupeKeyForRow(row),
        JSON.stringify({
          notion_page_id: row.pageId,
          section: row.section,
          date_found: row.dateFound,
          source_date: row.sourceDate,
          created_time: row.createdTime,
        }),
      ],
    );
    if (result.rowCount) inserted += result.rowCount;
  }
  return inserted;
}

export async function runCohortBridge(
  pool: Pool,
  options: CohortBridgeOptions = {},
  deps: CohortBridgeDeps = defaultDeps,
): Promise<CohortBridgeResult> {
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const progress = options.onProgress || (() => {});
  const startedAt = now;
  const empty = emptyIntake(today);

  if (!deps.isEnabled()) {
    return {
      skipped: true, reason: 'disabled', ok: true, runId: null, isBackfill: false,
      since: null, fetched: 0, observations: 0, promoted: 0, intakeSummary: empty, durationMs: 0,
    };
  }

  progress('Resolving Notion credentials', 5);
  const creds = await deps.getCredentials();
  if (!creds) {
    return {
      skipped: true, reason: 'no notion token', ok: false, runId: null, isBackfill: false,
      since: null, fetched: 0, observations: 0, promoted: 0, intakeSummary: empty,
      error: 'No Notion token configured for the cohort bridge', durationMs: Date.now() - startedAt.getTime(),
    };
  }

  let health: CohortHealthState | null = null;
  try {
    health = await deps.getAppState<CohortHealthState>(COHORT_HEALTH_STATE_KEY);
  } catch (err) {
    console.warn(`[Cohort] health state unreadable: ${err instanceof Error ? err.message : err}`);
  }

  const isBackfill = Boolean(health?.pendingBackfillFrom);
  const since = selectCohortSince({
    pendingBackfillFrom: health?.pendingBackfillFrom,
    lastSuccessfulFinishedAt: health?.lastSuccessfulFinishedAt,
    now,
  });
  const runId = buildCohortRunId(now, isBackfill);

  progress(`Fetching Notion cohort rows since ${since.slice(0, 10)}`, 15);
  let pages: unknown[];
  try {
    pages = await deps.queryPages(creds.token, creds.databaseId, since);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!options.dryRun) {
      try {
        await writeSourceRun(pool, {
          runId, startedAt, finishedAt: new Date(), status: 'error',
          fetched: 0, normalized: 0, error: message,
        });
      } catch (writeErr) {
        console.error('[Cohort] failed to persist error heartbeat:', writeErr);
      }
    }
    return {
      skipped: false, ok: false, runId, isBackfill, since, fetched: 0, observations: 0,
      promoted: 0, intakeSummary: empty, error: message,
      durationMs: Date.now() - startedAt.getTime(),
    };
  }

  const parsed = pages
    .map(page => parseNotionScanPage(page as { id?: string; created_time?: string; properties?: Record<string, unknown> }))
    .filter((row): row is CohortScanRow => Boolean(row))
    .filter(row => rowIsInWindow(row, since));

  let seen: CohortSeenState | null = null;
  try { seen = await deps.getAppState<CohortSeenState>(COHORT_SEEN_STATE_KEY); } catch { /* first run */ }
  const seenUrls = new Set((seen?.urls || []).map(normalizeUrl).filter(Boolean));

  const fresh: CohortScanRow[] = [];
  const batch = new Set<string>();
  for (const row of parsed) {
    const key = dedupeKeyForRow(row);
    if (batch.has(key)) continue;
    const nu = normalizeUrl(row.url);
    if (nu && seenUrls.has(nu)) continue;
    batch.add(key);
    fresh.push(row);
  }

  const promotable = fresh.filter(shouldPromoteRow).slice(0, COHORT_PROMOTE_LIMIT);
  const promoteSet = new Set(promotable);

  if (options.dryRun) {
    progress(`Dry run: ${parsed.length} fetched, ${promotable.length} would promote`, 100);
    return {
      skipped: false, ok: true, runId, isBackfill, since,
      fetched: parsed.length, observations: fresh.length, promoted: promotable.length,
      intakeSummary: empty, durationMs: Date.now() - startedAt.getTime(),
    };
  }

  progress(`Persisting ${fresh.length} observations`, 40);
  let observations = 0;
  try {
    observations = await insertObservations(
      pool,
      runId,
      fresh.map(row => ({ row, routing: routingForRow(row, promoteSet.has(row)) })),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeSourceRun(pool, {
      runId, startedAt, finishedAt: new Date(), status: 'error',
      fetched: parsed.length, normalized: 0, error: message,
    });
    return {
      skipped: false, ok: false, runId, isBackfill, since, fetched: parsed.length,
      observations: 0, promoted: 0, intakeSummary: empty, error: message,
      durationMs: Date.now() - startedAt.getTime(),
    };
  }

  const byWire = new Map<string, CohortScanRow[]>();
  for (const row of promotable) {
    const wire = row.wire!;
    const list = byWire.get(wire) ?? [];
    list.push(row);
    byWire.set(wire, list);
  }

  const submissions: ScanSubmission[] = [...byWire.entries()].map(([wire, rows]) => ({
    wire,
    promptVariant: 'N',
    scanDate: today,
    source: 'claude-cohort-notion',
    submittedBy: 'cohort-bridge',
    results: rows.map(row => toRaw(row, runId)),
  }));

  let intakeSummary = empty;
  try {
    if (submissions.length > 0) {
      progress(`Running intake on ${promotable.length} cohort rows`, 70);
      intakeSummary = await deps.runIntake(pool, submissions);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeSourceRun(pool, {
      runId, startedAt, finishedAt: new Date(), status: 'error',
      fetched: parsed.length, normalized: observations, error: message,
    });
    return {
      skipped: false, ok: false, runId, isBackfill, since, fetched: parsed.length,
      observations, promoted: 0, intakeSummary: empty, error: message,
      durationMs: Date.now() - startedAt.getTime(),
    };
  }

  const finishedAt = new Date();
  await writeSourceRun(pool, {
    runId, startedAt, finishedAt, status: 'ok',
    fetched: parsed.length, normalized: observations,
  });

  const incomingUrls = fresh.map(row => normalizeUrl(row.url)).filter(Boolean);
  try {
    await deps.setAppState(COHORT_SEEN_STATE_KEY, {
      urls: mergeSeenUrls(seen?.urls, incomingUrls),
      lastRun: finishedAt.toISOString(),
    });
  } catch (err) {
    console.warn(`[Cohort] failed to persist seen watermark: ${err instanceof Error ? err.message : err}`);
  }

  progress(`Cohort bridge ${runId}: ${parsed.length} fetched, ${promotable.length} promoted`, 100);
  console.log(`[Cohort] ${runId}: fetched=${parsed.length} observations=${observations} promoted=${promotable.length} backfill=${isBackfill}`);

  return {
    skipped: false,
    ok: true,
    runId,
    isBackfill,
    since,
    fetched: parsed.length,
    observations,
    promoted: promotable.length,
    intakeSummary,
    durationMs: Date.now() - startedAt.getTime(),
  };
}
