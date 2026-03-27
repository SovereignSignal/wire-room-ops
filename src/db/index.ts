import { Pool } from 'pg';
import { config } from '../config';
import { DatabaseEntry } from '../types';
import type { ToolType, DistributionChannel, DistributionStatus, DistributionConfig, DistributionLog } from '../types/intake';
import { normalizeUrl } from '../utils/url';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.database.url,
      ssl: config.database.url.includes('localhost') ? false : {
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
      },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // Prevent unhandled error crashes from idle client disconnects
    pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error on idle client:', err.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export interface DateRangeOptions {
  startDate: Date;
  endDate: Date;
  wire?: string | string[];
}

export async function getEntriesForDateRange(
  startDate: Date,
  endDate: Date,
  wire?: string | string[]
): Promise<DatabaseEntry[]> {
  const pool = getPool();

  // Build wire filter clause
  let wireClause = '';
  const params: (Date | string | string[])[] = [startDate, endDate];
  
  if (wire) {
    const wires = Array.isArray(wire) ? wire : [wire];
    if (wires.length === 1) {
      wireClause = 'AND s.wire = $3';
      params.push(wires[0]);
    } else {
      wireClause = 'AND s.wire = ANY($3)';
      params.push(wires);
    }
  }

  const query = `
    SELECT
      s.id,
      s.title,
      s.summary as quick_summary,
      c.name as category,
      s.created_at as timestamp,
      m.extracted_urls,
      'telegram' as source,
      s.wire,
      s.entities
    FROM summaries s
    LEFT JOIN messages m ON s.message_id = m.id
    LEFT JOIN categories c ON s.category_id = c.id
    WHERE s.processing_status = 'SUCCESS'
      AND s.created_at >= $1
      AND s.created_at < $2
      ${wireClause}
    ORDER BY c.name, s.created_at DESC
  `;

  const result = await pool.query(query, params);

  const entries = result.rows.map(row => {
    // Extract first URL from the JSON array
    const urls = row.extracted_urls || [];
    const url = Array.isArray(urls) ? urls[0] : urls;

    // Extract orgs from entities (supports both 'orgs' and legacy 'protocols' field)
    // Handle case where entities might be a string that needs parsing
    let entities = row.entities || {};
    if (typeof entities === 'string') {
      try {
        entities = JSON.parse(entities);
      } catch {
        entities = {};
      }
    }
    const orgs = entities.orgs || entities.protocols || [];

    return {
      id: String(row.id),
      url: url || '',
      quick_summary: row.quick_summary || '',
      category: row.category || 'Uncategorized',
      timestamp: new Date(row.timestamp),
      source: row.source,
      wire: row.wire || undefined,
      title: row.title || undefined,
      orgs: Array.isArray(orgs) ? orgs : [],
    };
  });

  // Deduplicate by URL (keep first occurrence, which is most recent due to ORDER BY)
  return deduplicateByUrl(entries);
}

// Deduplicate entries by URL, keeping the first occurrence
function deduplicateByUrl(entries: DatabaseEntry[]): DatabaseEntry[] {
  const seen = new Set<string>();
  return entries.filter(entry => {
    // Normalize URL for comparison
    const normalizedUrl = normalizeUrl(entry.url);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      return false;
    }
    seen.add(normalizedUrl);
    return true;
  });
}

// normalizeUrl imported from ../utils/url

export function getDefaultDateRange(): { start: Date; end: Date } {
  const now = new Date();

  if (config.dateRange.startDate && config.dateRange.endDate) {
    return {
      start: new Date(config.dateRange.startDate),
      end: new Date(config.dateRange.endDate),
    };
  }

  // Default: Last 7 days ending today
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);

  return { start, end };
}

// Schedule configuration persistence
export interface StoredScheduleConfig {
  id: string;
  name: string;
  enabled: boolean;
  dayOfWeek: number;
  hour: number;
  minute: number;
  lookbackDays: number;
  grokModel?: string;
  anthropicModel?: string;
  timezone: string;
  wire?: string;
  scheduleType?: 'scan-execution' | 'forum-scan' | 'daily-digest' | 'collect-engagement' | 'experiment-loop' | 'drip-distribution';
  frequencyHours?: number;
  notifyEmails?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export async function ensureScheduleTable(): Promise<void> {
  const pool = getPool();
  
  // Create new schedules table (supports multiple schedules)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL DEFAULT 'Untitled Schedule',
      enabled BOOLEAN NOT NULL DEFAULT false,
      day_of_week INTEGER NOT NULL DEFAULT 7,
      hour INTEGER NOT NULL DEFAULT 9,
      minute INTEGER NOT NULL DEFAULT 0,
      lookback_days INTEGER NOT NULL DEFAULT 7,
      grok_model TEXT,
      anthropic_model TEXT,
      timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
      wire TEXT,
      schedule_type TEXT NOT NULL DEFAULT 'scan-execution',
      frequency_hours INTEGER,
      notify_emails TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrate older schedule schema forward (idempotent)
  await pool.query(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS schedule_type TEXT DEFAULT 'scan-execution'`);
  await pool.query(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS frequency_hours INTEGER`);
  await pool.query(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS notify_emails TEXT`);
  await pool.query(`
    UPDATE schedules
    SET schedule_type = 'scan-execution'
    WHERE schedule_type IS NULL
      OR schedule_type NOT IN ('scan-execution', 'forum-scan', 'daily-digest', 'collect-engagement', 'experiment-loop', 'drip-distribution')
  `);
  await pool.query(`ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_schedule_type_check`);
  await pool.query(`
    ALTER TABLE schedules
    ADD CONSTRAINT schedules_schedule_type_check
    CHECK (schedule_type IN ('scan-execution', 'forum-scan', 'daily-digest', 'collect-engagement', 'experiment-loop', 'drip-distribution'))
  `);

  // Migrate data from old schedule_config table if it exists
  const oldTableExists = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'schedule_config'
    )
  `);

  if (oldTableExists.rows[0].exists) {
    const oldConfig = await pool.query(`SELECT * FROM schedule_config WHERE id = 1`);
    if (oldConfig.rows.length > 0) {
      const row = oldConfig.rows[0];
      // Check if we already migrated
      const existingSchedules = await pool.query(`SELECT COUNT(*) FROM schedules`);
      if (parseInt(existingSchedules.rows[0].count, 10) === 0) {
        await pool.query(`
          INSERT INTO schedules (name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, schedule_type)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'scan-execution')
        `, [
          'Default Schedule',
          row.enabled,
          row.day_of_week,
          row.hour,
          row.minute,
          row.lookback_days,
          row.grok_model,
          row.anthropic_model,
          row.timezone,
          row.wire,
        ]);
        console.log('[DB] Migrated schedule from schedule_config to schedules table');
      }
    }
  }
}

function parseScheduleRow(row: any): StoredScheduleConfig {
  const normalizedScheduleType: StoredScheduleConfig['scheduleType'] =
    row.schedule_type === 'forum-scan' ? 'forum-scan' :
    row.schedule_type === 'daily-digest' ? 'daily-digest' :
    row.schedule_type === 'collect-engagement' ? 'collect-engagement' :
    row.schedule_type === 'experiment-loop' ? 'experiment-loop' :
    row.schedule_type === 'drip-distribution' ? 'drip-distribution' : 'scan-execution';

  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    dayOfWeek: row.day_of_week,
    hour: row.hour,
    minute: row.minute,
    lookbackDays: row.lookback_days,
    grokModel: row.grok_model || undefined,
    anthropicModel: row.anthropic_model || undefined,
    timezone: row.timezone,
    wire: row.wire || undefined,
    scheduleType: normalizedScheduleType,
    frequencyHours: row.frequency_hours || undefined,
    notifyEmails: row.notify_emails || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getAllSchedules(): Promise<StoredScheduleConfig[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, schedule_type, frequency_hours, notify_emails, created_at, updated_at
    FROM schedules
    ORDER BY created_at ASC
  `);

  return result.rows.map(parseScheduleRow);
}

export async function getScheduleById(id: string): Promise<StoredScheduleConfig | null> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, schedule_type, frequency_hours, notify_emails, created_at, updated_at
    FROM schedules
    WHERE id = $1
  `, [id]);

  if (result.rows.length === 0) {
    return null;
  }

  return parseScheduleRow(result.rows[0]);
}

export async function createSchedule(config: Omit<StoredScheduleConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoredScheduleConfig> {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO schedules (name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, schedule_type, frequency_hours, notify_emails)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING id, name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, schedule_type, frequency_hours, notify_emails, created_at, updated_at
  `, [
    config.name,
    config.enabled,
    config.dayOfWeek,
    config.hour,
    config.minute,
    config.lookbackDays,
    config.grokModel || null,
    config.anthropicModel || null,
    config.timezone,
    config.wire || null,
    config.scheduleType || 'scan-execution',
    config.frequencyHours || null,
    config.notifyEmails || null,
  ]);

  return parseScheduleRow(result.rows[0]);
}

export async function updateSchedule(id: string, config: Partial<Omit<StoredScheduleConfig, 'id' | 'createdAt' | 'updatedAt'>>): Promise<StoredScheduleConfig | null> {
  const pool = getPool();
  
  // Build dynamic update query
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (config.name !== undefined) { updates.push(`name = $${paramIndex++}`); values.push(config.name); }
  if (config.enabled !== undefined) { updates.push(`enabled = $${paramIndex++}`); values.push(config.enabled); }
  if (config.dayOfWeek !== undefined) { updates.push(`day_of_week = $${paramIndex++}`); values.push(config.dayOfWeek); }
  if (config.hour !== undefined) { updates.push(`hour = $${paramIndex++}`); values.push(config.hour); }
  if (config.minute !== undefined) { updates.push(`minute = $${paramIndex++}`); values.push(config.minute); }
  if (config.lookbackDays !== undefined) { updates.push(`lookback_days = $${paramIndex++}`); values.push(config.lookbackDays); }
  if (config.grokModel !== undefined) { updates.push(`grok_model = $${paramIndex++}`); values.push(config.grokModel || null); }
  if (config.anthropicModel !== undefined) { updates.push(`anthropic_model = $${paramIndex++}`); values.push(config.anthropicModel || null); }
  if (config.timezone !== undefined) { updates.push(`timezone = $${paramIndex++}`); values.push(config.timezone); }
  if (config.wire !== undefined) { updates.push(`wire = $${paramIndex++}`); values.push(config.wire || null); }
  if (config.scheduleType !== undefined) { updates.push(`schedule_type = $${paramIndex++}`); values.push(config.scheduleType); }
  if (config.frequencyHours !== undefined) { updates.push(`frequency_hours = $${paramIndex++}`); values.push(config.frequencyHours || null); }
  if (config.notifyEmails !== undefined) { updates.push(`notify_emails = $${paramIndex++}`); values.push(config.notifyEmails || null); }

  if (updates.length === 0) {
    return getScheduleById(id);
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  const result = await pool.query(`
    UPDATE schedules SET ${updates.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING id, name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, schedule_type, frequency_hours, notify_emails, created_at, updated_at
  `, values);

  if (result.rows.length === 0) {
    return null;
  }

  return parseScheduleRow(result.rows[0]);
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(`DELETE FROM schedules WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

// Legacy compatibility - get first schedule or null
export async function getScheduleConfig(): Promise<StoredScheduleConfig | null> {
  const schedules = await getAllSchedules();
  return schedules.length > 0 ? schedules[0] : null;
}

// Legacy compatibility - save/update first schedule
export async function saveScheduleConfig(config: Omit<StoredScheduleConfig, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<void> {
  if (config.id) {
    await updateSchedule(config.id, config);
  } else {
    const schedules = await getAllSchedules();
    if (schedules.length > 0) {
      await updateSchedule(schedules[0].id, config);
    } else {
      await createSchedule(config);
    }
  }
}

export interface WireInfo {
  key: string;
  wire: string;
  displayName: string;
  entryCount: number;
}

function isMissingRelationError(error: unknown, relation: string): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error && 'data' in error
      ? String((error as { data?: { error?: string } }).data?.error || '')
      : '';

  return (error as { code?: string } | null)?.code === '42P01'
    || message.includes(`relation "${relation}" does not exist`);
}

export async function getEntryCountsByWire(): Promise<Record<string, number>> {
  const pool = getPool();
  let result;

  try {
    result = await pool.query(`
      SELECT s.wire, COUNT(DISTINCT s.id) as entry_count
      FROM summaries s
      WHERE s.processing_status = 'SUCCESS' AND s.wire IS NOT NULL
      GROUP BY s.wire
    `);
  } catch (error) {
    if (isMissingRelationError(error, 'summaries')) {
      return {};
    }
    throw error;
  }

  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    counts[row.wire] = parseInt(row.entry_count, 10) || 0;
  }
  return counts;
}

export async function getAvailableWires(): Promise<WireInfo[]> {
  const feeds = await getAllFeeds(false);
  const counts = await getEntryCountsByWire();

  return feeds.map(f => ({
    key: f.key,
    wire: f.key,
    displayName: f.displayName,
    entryCount: counts[f.key] || 0,
  }));
}

// --- Feeds table management ---

export interface FeedRecord {
  key: string;
  displayName: string;
  titleTemplate: string | null;
  sortOrder: number;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScanPromptRecord {
  id: string;
  wire: string;
  label: string;
  promptText: string;
  responseFormat: string | null;
  variant: string | null;
  toolType: ToolType;
  model: string | null;
  outputFormat: 'text' | 'json';
  intent: 'discovery' | 'canonical' | 'signal';
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

function parseScanPromptRow(row: any): ScanPromptRecord {
  return {
    id: row.id,
    wire: row.wire,
    label: row.label,
    promptText: row.prompt_text,
    responseFormat: row.response_format || null,
    variant: row.variant || null,
    toolType: row.tool_type || 'x_search',
    model: row.model || null,
    outputFormat: row.output_format || 'text',
    intent: row.intent || 'discovery',
    isActive: row.is_active ?? true,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SEED_FEEDS: Record<string, { displayName: string; titleTemplate: string }> = {
  crypto: { displayName: 'Crypto', titleTemplate: "The Wire Room — Crypto Weekly Update" },
  ai: { displayName: 'AI', titleTemplate: "The Wire Room — AI Weekly Update" },
  oss: { displayName: 'OSS', titleTemplate: "The Wire Room — OSS Weekly Update" },
};

export async function ensureFeedsTable(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      title_template TEXT,
      sort_order INTEGER DEFAULT 0,
      archived BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed known feeds — upsert so new core wires are always added on deploy
  let sortIdx = 0;
  for (const [key, data] of Object.entries(SEED_FEEDS)) {
    await pool.query(`
      INSERT INTO feeds (key, display_name, title_template, sort_order)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (key) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        title_template = EXCLUDED.title_template
      WHERE feeds.archived = false
    `, [key, data.displayName, data.titleTemplate, sortIdx++]);
  }

  // Auto-discover from channel_configs
  try {
    const discovered = await pool.query(`
      SELECT DISTINCT wire FROM channel_configs WHERE wire IS NOT NULL
    `);

    for (const row of discovered.rows) {
      const wireKey = row.wire as string;
      if (!SEED_FEEDS[wireKey]) {
        // Auto-generate display name: capitalize first letter of each word
        const displayName = wireKey.charAt(0).toUpperCase() + wireKey.slice(1);
        await pool.query(`
          INSERT INTO feeds (key, display_name, sort_order)
          VALUES ($1, $2, $3)
          ON CONFLICT (key) DO NOTHING
        `, [wireKey, displayName, 100]);
      }
    }
  } catch {
    // channel_configs table may not exist in all environments
    console.log('[DB] channel_configs not available for feed auto-discovery');
  }

  console.log('[DB] Feeds table ready');
}

function parseFeedRow(row: any): FeedRecord {
  return {
    key: row.key,
    displayName: row.display_name,
    titleTemplate: row.title_template || null,
    sortOrder: row.sort_order ?? 0,
    archived: row.archived ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getAllFeeds(includeArchived = false): Promise<FeedRecord[]> {
  const pool = getPool();
  const query = includeArchived
    ? `SELECT * FROM feeds ORDER BY sort_order ASC, key ASC`
    : `SELECT * FROM feeds WHERE archived = false ORDER BY sort_order ASC, key ASC`;

  const result = await pool.query(query);
  return result.rows.map(parseFeedRow);
}

export async function getFeedByKey(key: string): Promise<FeedRecord | null> {
  const pool = getPool();
  const result = await pool.query(`SELECT * FROM feeds WHERE key = $1`, [key]);
  return result.rows.length > 0 ? parseFeedRow(result.rows[0]) : null;
}

export async function createFeed(params: { key: string; displayName: string; titleTemplate?: string; sortOrder?: number }): Promise<FeedRecord> {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO feeds (key, display_name, title_template, sort_order)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [params.key, params.displayName, params.titleTemplate || null, params.sortOrder ?? 0]);

  return parseFeedRow(result.rows[0]);
}

export async function updateFeed(key: string, updates: { displayName?: string; titleTemplate?: string; sortOrder?: number; archived?: boolean }): Promise<FeedRecord | null> {
  const pool = getPool();

  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.displayName !== undefined) { setClauses.push(`display_name = $${paramIndex++}`); values.push(updates.displayName); }
  if (updates.titleTemplate !== undefined) { setClauses.push(`title_template = $${paramIndex++}`); values.push(updates.titleTemplate || null); }
  if (updates.sortOrder !== undefined) { setClauses.push(`sort_order = $${paramIndex++}`); values.push(updates.sortOrder); }
  if (updates.archived !== undefined) { setClauses.push(`archived = $${paramIndex++}`); values.push(updates.archived); }

  if (setClauses.length === 0) return getFeedByKey(key);

  setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(key);

  const result = await pool.query(`
    UPDATE feeds SET ${setClauses.join(', ')}
    WHERE key = $${paramIndex}
    RETURNING *
  `, values);

  return result.rows.length > 0 ? parseFeedRow(result.rows[0]) : null;
}

export async function archiveFeed(key: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(`
    UPDATE feeds SET archived = true, updated_at = CURRENT_TIMESTAMP
    WHERE key = $1
  `, [key]);
  return (result.rowCount ?? 0) > 0;
}

// --- Scan pipeline tables ---

export async function ensureScanTables(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

  // scan_entries — core table for all scan results
  // No wire CHECK constraint: wire values are dynamic (validated against feeds table at API level)
  await client.query(`CREATE TABLE IF NOT EXISTS scan_entries (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    source_url TEXT NOT NULL,
    amount TEXT,
    amount_numeric NUMERIC,
    amount_currency TEXT,
    deadline TEXT,
    deadline_parsed DATE,
    wire TEXT NOT NULL,
    prompt_variant TEXT NOT NULL CHECK (prompt_variant IN ('A', 'B', 'C', 'N', 'W', 'P', 'S')),
    scan_source TEXT NOT NULL DEFAULT 'x-scan',
    scan_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'raw'
      CHECK (status IN ('raw','deduped','duplicate','queued','enriched','published','archived','skipped','approved','declined')),
    quality_score INTEGER,
    quality_breakdown JSONB,
    duplicate_of_id INTEGER REFERENCES scan_entries(id),
    duplicate_reason TEXT,
    enriched_summary TEXT,
    processing_method TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // seen_urls — fast URL dedup lookup
  await client.query(`CREATE TABLE IF NOT EXISTS seen_urls (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    first_seen_entry_id INTEGER NOT NULL REFERENCES scan_entries(id),
    first_seen_date DATE NOT NULL,
    wire TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(normalized_url, wire)
  )`);

  // seen_names — fuzzy name matching
  await client.query(`CREATE TABLE IF NOT EXISTS seen_names (
    id SERIAL PRIMARY KEY,
    name_original TEXT NOT NULL,
    name_normalized TEXT NOT NULL,
    name_tokens TEXT[],
    entry_id INTEGER NOT NULL REFERENCES scan_entries(id),
    wire TEXT NOT NULL,
    first_seen DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  // Ensure one seen_name row per entry (idempotent retries)
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_seen_names_entry_id ON seen_names(entry_id)`);

  // intake_runs — log of each processing run
  await client.query(`CREATE TABLE IF NOT EXISTS intake_runs (
    id SERIAL PRIMARY KEY,
    run_date DATE NOT NULL,
    wire TEXT,
    total_ingested INTEGER DEFAULT 0,
    duplicates_found INTEGER DEFAULT 0,
    new_unique INTEGER DEFAULT 0,
    avg_quality_score NUMERIC,
    high_quality_count INTEGER DEFAULT 0,
    summary JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Indexes
  await client.query(`CREATE INDEX IF NOT EXISTS idx_seen_urls_normalized ON seen_urls(normalized_url)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_seen_urls_wire ON seen_urls(wire)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_seen_names_normalized ON seen_names(name_normalized)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_seen_names_wire ON seen_names(wire)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_seen_names_tokens ON seen_names USING GIN(name_tokens)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_wire ON scan_entries(wire)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_status ON scan_entries(status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_scan_date ON scan_entries(scan_date)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_quality ON scan_entries(quality_score DESC NULLS LAST)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_source_url ON scan_entries(source_url)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_wire_date ON scan_entries(wire, scan_date)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_wire_status ON scan_entries(wire, status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_queue ON scan_entries(wire, status, quality_score DESC NULLS LAST) WHERE status IN ('queued')`);
  // Wire Room read path: WHERE status='approved' [AND wire=$1] ORDER BY created_at DESC
  // Drop old version if it exists (was keyed on status instead of wire)
  await client.query(`DROP INDEX IF EXISTS idx_scan_entries_approved`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_approved ON scan_entries(wire, created_at DESC) WHERE status = 'approved'`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_intake_runs_date ON intake_runs(run_date)`);

  // Updated_at trigger (idempotent)
  await client.query(`
    CREATE OR REPLACE FUNCTION update_scan_entries_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`DROP TRIGGER IF EXISTS scan_entries_updated_at ON scan_entries`);
  await client.query(`
    CREATE TRIGGER scan_entries_updated_at
      BEFORE UPDATE ON scan_entries
      FOR EACH ROW
      EXECUTE FUNCTION update_scan_entries_updated_at()
  `);

  // Phase 3 migrations: expand constraints for telegram/email/forum ingestion
  await client.query(`
    ALTER TABLE scan_entries DROP CONSTRAINT IF EXISTS scan_entries_scan_source_check
  `);
  await client.query(`
    ALTER TABLE scan_entries ADD CONSTRAINT scan_entries_scan_source_check
      CHECK (scan_source IN ('x-scan', 'web-search', 'perplexity', 'community', 'telegram', 'telegram-intake', 'manual-intake', 'email', 'forum'))
  `);
  await client.query(`
    ALTER TABLE scan_entries DROP CONSTRAINT IF EXISTS scan_entries_prompt_variant_check
  `);
  await client.query(`
    ALTER TABLE scan_entries ADD CONSTRAINT scan_entries_prompt_variant_check
      CHECK (prompt_variant IN ('A', 'B', 'C', 'N', 'W', 'P', 'S'))
  `);
  await client.query(`
    ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS submitted_by TEXT
  `);

  // Phase 4 migration: make seen_urls.first_seen_entry_id nullable
  // so we can seed URLs from tele-sum messages (no corresponding scan_entries row)
  await client.query(`
    ALTER TABLE seen_urls ALTER COLUMN first_seen_entry_id DROP NOT NULL
  `);

  // Phase 5 migration: ensure summaries table accepts scan-pipeline entries
  // (message_id and category_id must be nullable for entries with no tele-sum origin)
  try {
    await client.query(`ALTER TABLE summaries ALTER COLUMN message_id DROP NOT NULL`);
    await client.query(`ALTER TABLE summaries ALTER COLUMN category_id DROP NOT NULL`);
  } catch {
    // summaries table may not exist yet — that's OK, it's an external table
  }

    await client.query('COMMIT');
    console.log('[DB] Scan pipeline tables ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureClassificationColumns(): Promise<void> {
  const pool = getPool();

  // Add classification columns
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS classification VARCHAR(20) DEFAULT 'UNCHECKED'`);
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS classification_reason TEXT`);
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'`);

  // Expand status constraint to include 'incomplete'
  await pool.query(`ALTER TABLE scan_entries DROP CONSTRAINT IF EXISTS scan_entries_status_check`);
  await pool.query(`
    ALTER TABLE scan_entries ADD CONSTRAINT scan_entries_status_check
      CHECK (status IN ('raw','deduped','duplicate','queued','enriched','published','archived','skipped','approved','declined','incomplete'))
  `);

  // Indexes for classification queries
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_classification ON scan_entries(classification)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_status_wire ON scan_entries(status, wire)`);

  console.log('[DB] Classification columns ready');
}

export async function ensureScanPromptsTable(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scan_prompts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wire TEXT NOT NULL,
      label TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      response_format TEXT,
      is_active BOOLEAN DEFAULT true,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_prompts_wire ON scan_prompts(wire)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_prompts_wire_order ON scan_prompts(wire, sort_order)`);

  // updated_at trigger
  await pool.query(`
    CREATE OR REPLACE FUNCTION update_scan_prompts_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS scan_prompts_updated_at ON scan_prompts`);
  await pool.query(`
    CREATE TRIGGER scan_prompts_updated_at
      BEFORE UPDATE ON scan_prompts
      FOR EACH ROW
      EXECUTE FUNCTION update_scan_prompts_updated_at()
  `);

  // Add prompt_id FK to scan_entries (nullable, for Phase 2 tracking)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'scan_entries' AND column_name = 'prompt_id'
      ) THEN
        ALTER TABLE scan_entries ADD COLUMN prompt_id UUID REFERENCES scan_prompts(id);
      END IF;
    END $$
  `);

  // Index on prompt_id FK for efficient stats JOINs
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_prompt_id ON scan_entries(prompt_id)`);

  // Phase 2 migrations: variant column on scan_prompts
  await pool.query(`
    ALTER TABLE scan_prompts ADD COLUMN IF NOT EXISTS variant TEXT CHECK (variant IN ('A', 'B', 'C'))
  `);

  // Phase 2: Allow queue action statuses (skipped, approved, declined)
  await pool.query(`
    ALTER TABLE scan_entries DROP CONSTRAINT IF EXISTS scan_entries_status_check
  `);
  await pool.query(`
    ALTER TABLE scan_entries ADD CONSTRAINT scan_entries_status_check
      CHECK (status IN ('raw','deduped','duplicate','queued','enriched','published','archived','skipped','approved','declined'))
  `);

  // Phase 3 migration: tool_type column for x_search vs web_search
  await pool.query(`
    ALTER TABLE scan_prompts ADD COLUMN IF NOT EXISTS tool_type TEXT DEFAULT 'x_search'
      CHECK (tool_type IN ('x_search', 'web_search'))
  `);

  // Phase 3b migration: expand tool_type to include perplexity
  await pool.query(`ALTER TABLE scan_prompts DROP CONSTRAINT IF EXISTS scan_prompts_tool_type_check`);
  await pool.query(`
    ALTER TABLE scan_prompts ADD CONSTRAINT scan_prompts_tool_type_check
      CHECK (tool_type IN ('x_search', 'web_search', 'perplexity', 'community'))
  `);

  // Phase 4 migration: expand variant constraint to include 'S' (signal), 'W' (web), 'P' (perplexity), 'N' (neutral)
  await pool.query(`ALTER TABLE scan_prompts DROP CONSTRAINT IF EXISTS scan_prompts_variant_check`);
  await pool.query(`
    ALTER TABLE scan_prompts ADD CONSTRAINT scan_prompts_variant_check
      CHECK (variant IN ('A', 'B', 'C', 'W', 'P', 'N', 'S'))
  `);

  // Phase 4 migration: add community_signals JSONB column for external signal metadata
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS community_signals JSONB`);

  // Gate 2 migration: classification columns on scan_entries
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS classification TEXT DEFAULT 'UNCHECKED'`);
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS classification_reason TEXT`);
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_classification ON scan_entries(classification) WHERE status IN ('queued','approved')`);

  // Entity tags migration
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_tags ON scan_entries USING GIN(tags)`);

  // Multi-wire support: wires[] stores all applicable wires, wire stays as the primary
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS wires TEXT[] DEFAULT '{}'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_wires ON scan_entries USING GIN(wires)`);

  // Source publish date + quiet approve support
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS distributable BOOLEAN DEFAULT TRUE`);

  // Data migration: set response_format on prompts that have it NULL
  const defaultResponseFormat = `For each result, use this exact format:

1. **Program Name** — Brief description including funding amount if known
Deadline: [specific date, "Rolling", or "None listed"]
Published: [date this was announced or last updated, or "Unknown"]
Source URL: [the URL where you found this — X post, article, or program page]

Rules:
- Number each result sequentially (1, 2, 3...)
- Bold the program name with ** markers
- Include funding amount in description when mentioned (e.g. "$50K", "$1M")
- Use specific dates for deadlines when available
- Published date should reflect when the opportunity was announced or last updated, not the deadline
- Each Source URL must be a direct, canonical link — not a listicle, aggregator, or "top N" blog post
- Do NOT include citation markers like [[1]] in URLs
- Start immediately with result 1 — no preamble, introduction, or summary text
- Do NOT include a conclusion, summary, or sign-off after the last result
- Every result must have evidence of recent activity (announcement, post, update) — do not include evergreen programs without a fresh signal`;

  const { rowCount } = await pool.query(
    `UPDATE scan_prompts SET response_format = $1 WHERE response_format IS NULL`,
    [defaultResponseFormat]
  );
  if (rowCount && rowCount > 0) {
    console.log(`[DB] Set response_format on ${rowCount} prompts that had NULL`);
  }

  // Migration v6: update prompts that still have the old format (without anti-preamble rules)
  const { rowCount: updatedCount } = await pool.query(
    `UPDATE scan_prompts SET response_format = $1 WHERE response_format != $1 AND response_format NOT LIKE '%no preamble%'`,
    [defaultResponseFormat]
  );
  if (updatedCount && updatedCount > 0) {
    console.log(`[DB] Updated ${updatedCount} prompts to latest response format (v6)`);
  }

  // Migration: strip inline format instructions from prompt_text
  // The response_format column is the single source of truth for output formatting.
  // Having format instructions in BOTH prompt_text AND response_format confuses the model.
  // x_search prompts end with: "For each result:\n[Account] — ...\n[Date]"
  // web_search prompts end with: "For each result:\n[Source/Org] — ...\nCRITICAL: ..."
  const { rows: promptsWithInlineFormat } = await pool.query(
    `SELECT id, prompt_text FROM scan_prompts WHERE prompt_text LIKE '%For each result:%' AND tool_type IN ('x_search', 'web_search')`
  );
  let strippedCount = 0;
  for (const p of promptsWithInlineFormat) {
    // Find the last "For each result:" and strip everything from there
    const idx = p.prompt_text.lastIndexOf('For each result:');
    if (idx > 0) {
      const cleaned = p.prompt_text.substring(0, idx).trimEnd();
      if (cleaned !== p.prompt_text) {
        await pool.query('UPDATE scan_prompts SET prompt_text = $1 WHERE id = $2', [cleaned, p.id]);
        strippedCount++;
      }
    }
  }
  if (strippedCount > 0) {
    console.log(`[DB] Stripped conflicting inline format instructions from ${strippedCount} prompt texts`);
  }

  // Migration v5: relax recency constraints in prompt texts
  // "Last 7 days only." was causing Grok to self-reject valid active programs.
  // Replace with softer recency guidance that still prioritizes recent activity
  // but includes currently active/open programs.
  const recencyFixes = [
    {
      find: 'Last 7 days only.',
      replace: 'Prioritize activity from the last 14 days, but also include programs with currently open applications regardless of announcement date.',
    },
    {
      find: 'anything older than 7 days.',
      replace: 'programs that have already closed or expired.',
    },
    {
      find: 'anything older than 7 days',
      replace: 'programs that have already closed or expired',
    },
    {
      find: 'announced or updated in the last 7 days',
      replace: 'announced or updated recently, or with currently open applications',
    },
    {
      find: 'from the last 7 days',
      replace: 'from recent activity or currently open programs',
    },
    {
      find: 'in the last 7 days',
      replace: 'recently or with currently open applications',
    },
    {
      find: 'within the last 7 days',
      replace: 'recently or with currently open applications',
    },
  ];
  let recencyFixCount = 0;
  for (const fix of recencyFixes) {
    const { rowCount: rc } = await pool.query(
      `UPDATE scan_prompts SET prompt_text = REPLACE(prompt_text, $1, $2) WHERE prompt_text LIKE $3`,
      [fix.find, fix.replace, `%${fix.find}%`]
    );
    if (rc && rc > 0) recencyFixCount += rc;
  }
  if (recencyFixCount > 0) {
    console.log(`[DB] Relaxed recency constraints in ${recencyFixCount} prompt texts`);
  }

  // Migration v6: model column for per-prompt model override
  await pool.query(`ALTER TABLE scan_prompts ADD COLUMN IF NOT EXISTS model TEXT`);

  // Migration v6: output_format column (text or json)
  await pool.query(`ALTER TABLE scan_prompts ADD COLUMN IF NOT EXISTS output_format TEXT DEFAULT 'text'`);

  // Migration v6: intent column for prompt purpose tagging
  // Default is 'discovery'; prompts created via UI/API set intent explicitly.
  // No startup backfill — avoids clobbering intentional 'discovery' on web_search/perplexity prompts.
  await pool.query(`ALTER TABLE scan_prompts ADD COLUMN IF NOT EXISTS intent TEXT DEFAULT 'discovery'`);

  // Set reasoning model on existing x_search prompts that don't have a model set
  const { rowCount: modelSetCount } = await pool.query(
    `UPDATE scan_prompts SET model = 'grok-4.20-beta-0309-reasoning' WHERE tool_type = 'x_search' AND model IS NULL`
  );
  if (modelSetCount && modelSetCount > 0) {
    console.log(`[DB] Set reasoning model on ${modelSetCount} x_search prompts`);
  }

  // Migration v6: raw_output and parse_strategy columns on scan_entries
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS raw_output TEXT`);
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS parse_strategy TEXT`);

  console.log('[DB] Scan prompts table ready (Phase 2+3+6 migrations applied)');
}

/**
 * Seed seen_urls with URLs already in the wire (from tele-sum's messages table).
 * This prevents the scan pipeline from surfacing entries that already exist.
 * Idempotent: uses ON CONFLICT DO NOTHING, so repeated calls are cheap.
 *
 * @returns Number of newly seeded URLs (0 on subsequent runs)
 */
export async function seedSeenUrlsFromMessages(): Promise<number> {
  const pool = getPool();

  // Skip if seen_urls already has data — this is a one-time bootstrap
  const { rows: existing } = await pool.query('SELECT 1 FROM seen_urls LIMIT 1');
  if (existing.length > 0) {
    console.log('[Seed] seen_urls already populated, skipping seed');
    return 0;
  }

  // Check if the messages table exists (it's tele-sum's table, not ours)
  const tableCheck = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = 'messages'
    )
  `);
  if (!tableCheck.rows[0].exists) {
    return 0;
  }

  // Extract all URLs from successfully processed messages
  const urlRows = await pool.query(`
    SELECT DISTINCT u.url, s.wire, s.created_at::date AS first_seen
    FROM summaries s
    JOIN messages m ON s.message_id = m.id
    CROSS JOIN LATERAL jsonb_array_elements_text(m.extracted_urls) AS u(url)
    WHERE s.processing_status = 'SUCCESS'
      AND s.wire IS NOT NULL
      AND m.extracted_urls IS NOT NULL
      AND jsonb_array_length(m.extracted_urls) > 0
  `);

  if (urlRows.rows.length === 0) {
    return 0;
  }

  // Batch insert into seen_urls (200 rows per batch, 4 params each = 800)
  const BATCH_SIZE = 200;
  let seeded = 0;

  for (let i = 0; i < urlRows.rows.length; i += BATCH_SIZE) {
    const batch = urlRows.rows.slice(i, i + BATCH_SIZE);
    const values: (string | null)[] = [];
    const valueClauses: string[] = [];

    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      const normalized = normalizeUrl(row.url);
      const offset = j * 4;
      valueClauses.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
      values.push(row.url, normalized, row.first_seen, row.wire);
    }

    const res = await pool.query(
      `INSERT INTO seen_urls (url, normalized_url, first_seen_date, wire)
       VALUES ${valueClauses.join(', ')}
       ON CONFLICT (normalized_url, wire) DO NOTHING`,
      values
    );
    seeded += res.rowCount ?? 0;
  }

  return seeded;
}

export async function getAllScanPrompts(wire?: string, activeOnly?: boolean): Promise<ScanPromptRecord[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (wire) {
    conditions.push(`wire = $${paramIndex++}`);
    values.push(wire);
  }
  if (activeOnly) {
    conditions.push(`is_active = true`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT * FROM scan_prompts ${whereClause} ORDER BY wire, sort_order ASC, created_at ASC`,
    values
  );

  return result.rows.map(parseScanPromptRow);
}

export async function getScanPromptById(id: string): Promise<ScanPromptRecord | null> {
  const pool = getPool();
  const result = await pool.query(`SELECT * FROM scan_prompts WHERE id = $1`, [id]);
  return result.rows.length > 0 ? parseScanPromptRow(result.rows[0]) : null;
}

export async function createScanPrompt(params: {
  wire: string;
  label: string;
  promptText: string;
  responseFormat?: string;
  isActive?: boolean;
  sortOrder?: number;
  toolType?: ToolType;
  variant?: string;
  model?: string;
  outputFormat?: 'text' | 'json';
  intent?: 'discovery' | 'canonical' | 'signal';
}): Promise<ScanPromptRecord> {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO scan_prompts (wire, label, prompt_text, response_format, is_active, sort_order, tool_type, variant, model, output_format, intent)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `, [
    params.wire,
    params.label,
    params.promptText,
    params.responseFormat || null,
    params.isActive ?? true,
    params.sortOrder ?? 0,
    params.toolType || 'x_search',
    params.variant || null,
    params.model || null,
    params.outputFormat || 'text',
    params.intent || 'discovery',
  ]);

  return parseScanPromptRow(result.rows[0]);
}

export async function updateScanPrompt(
  id: string,
  updates: Partial<{ wire: string; label: string; promptText: string; responseFormat: string | null; isActive: boolean; sortOrder: number; variant: string | null; toolType: ToolType; model: string | null; outputFormat: 'text' | 'json'; intent: 'discovery' | 'canonical' | 'signal' }>
): Promise<ScanPromptRecord | null> {
  const pool = getPool();
  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.wire !== undefined) { setClauses.push(`wire = $${paramIndex++}`); values.push(updates.wire); }
  if (updates.label !== undefined) { setClauses.push(`label = $${paramIndex++}`); values.push(updates.label); }
  if (updates.promptText !== undefined) { setClauses.push(`prompt_text = $${paramIndex++}`); values.push(updates.promptText); }
  if (updates.responseFormat !== undefined) { setClauses.push(`response_format = $${paramIndex++}`); values.push(updates.responseFormat); }
  if (updates.isActive !== undefined) { setClauses.push(`is_active = $${paramIndex++}`); values.push(updates.isActive); }
  if (updates.sortOrder !== undefined) { setClauses.push(`sort_order = $${paramIndex++}`); values.push(updates.sortOrder); }
  if (updates.variant !== undefined) { setClauses.push(`variant = $${paramIndex++}`); values.push(updates.variant); }
  if (updates.toolType !== undefined) { setClauses.push(`tool_type = $${paramIndex++}`); values.push(updates.toolType); }
  if (updates.model !== undefined) { setClauses.push(`model = $${paramIndex++}`); values.push(updates.model); }
  if (updates.outputFormat !== undefined) { setClauses.push(`output_format = $${paramIndex++}`); values.push(updates.outputFormat); }
  if (updates.intent !== undefined) { setClauses.push(`intent = $${paramIndex++}`); values.push(updates.intent); }

  if (setClauses.length === 0) return getScanPromptById(id);

  values.push(id);
  const result = await pool.query(`
    UPDATE scan_prompts SET ${setClauses.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING *
  `, values);

  return result.rows.length > 0 ? parseScanPromptRow(result.rows[0]) : null;
}

export async function deleteScanPrompt(id: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(`DELETE FROM scan_prompts WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

// --- Scan pipeline query helpers ---

export async function getStatusCounts(wire?: string, date?: string, promptId?: string): Promise<Record<string, number>> {
  const pool = getPool();
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (wire) {
    conditions.push(`wire = $${paramIndex++}`);
    values.push(wire);
  }
  if (date) {
    conditions.push(`scan_date = $${paramIndex++}`);
    values.push(date);
  }
  if (promptId) {
    conditions.push(`prompt_id = $${paramIndex++}`);
    values.push(promptId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT status, COUNT(*)::int AS count FROM scan_entries ${whereClause} GROUP BY status`,
    values
  );

  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

export async function getEntriesByStatus(
  statuses: string[],
  opts?: { wire?: string; date?: string; promptId?: string; limit?: number; offset?: number; minScore?: number; excludeSources?: string[] }
): Promise<{ entries: any[]; total: number }> {
  const pool = getPool();
  const conditions: string[] = [`status = ANY($1)`];
  const values: any[] = [statuses];
  let paramIndex = 2;

  if (opts?.wire) {
    conditions.push(`wire = $${paramIndex++}`);
    values.push(opts.wire);
  }
  if (opts?.date) {
    conditions.push(`scan_date = $${paramIndex++}`);
    values.push(opts.date);
  }
  if (opts?.promptId) {
    conditions.push(`prompt_id = $${paramIndex++}`);
    values.push(opts.promptId);
  }
  if (opts?.minScore != null) {
    conditions.push(`COALESCE(quality_score, 0) >= $${paramIndex++}`);
    values.push(opts.minScore);
  }
  if (opts?.excludeSources && opts.excludeSources.length > 0) {
    conditions.push(`COALESCE(scan_source, '') != ALL($${paramIndex++})`);
    values.push(opts.excludeSources);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const limit = opts?.limit || 100;
  const offset = opts?.offset || 0;

  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT * FROM scan_entries ${whereClause} ORDER BY quality_score DESC NULLS LAST, created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM scan_entries ${whereClause}`,
      values
    ),
  ]);

  return { entries: dataRes.rows, total: countRes.rows[0].total };
}

export async function getSeenUrlStats(wire?: string): Promise<{ seededCount: number; totalCount: number }> {
  const pool = getPool();
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (wire) {
    conditions.push(`wire = $${paramIndex++}`);
    values.push(wire);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE first_seen_entry_id IS NULL)::int AS seeded
     FROM seen_urls ${whereClause}`,
    values
  );

  return {
    seededCount: result.rows[0].seeded,
    totalCount: result.rows[0].total,
  };
}

export async function getSeenUrlsList(
  opts?: { wire?: string; limit?: number; offset?: number }
): Promise<{ urls: any[]; total: number }> {
  const pool = getPool();
  const conditions: string[] = [`first_seen_entry_id IS NULL`];
  const values: any[] = [];
  let paramIndex = 1;

  if (opts?.wire) {
    conditions.push(`wire = $${paramIndex++}`);
    values.push(opts.wire);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const limit = opts?.limit || 50;
  const offset = opts?.offset || 0;

  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT url, wire, first_seen_date FROM seen_urls ${whereClause} ORDER BY first_seen_date DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM seen_urls ${whereClause}`,
      values
    ),
  ]);

  return { urls: dataRes.rows, total: countRes.rows[0].total };
}

// --- Distribution tables ---

export async function ensureDistributionTables(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Migrate from old distribution tables if they exist with wrong schema.
    // New schema has a `config` JSONB column on distribution_config.
    // If the table exists but lacks this column, it's the old abandoned schema.
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'distribution_config'
      )
    `);
    if (tableExists.rows[0].exists) {
      const hasConfigCol = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'distribution_config' AND column_name = 'config'
        )
      `);
      if (!hasConfigCol.rows[0].exists) {
        await client.query(`DROP TABLE IF EXISTS distribution_logs`);
        await client.query(`DROP TABLE IF EXISTS distribution_config`);
        console.log('[DB] Dropped old distribution tables (schema migration)');
      }
    }

    // distribution_config — per-wire per-channel settings
    await client.query(`CREATE TABLE IF NOT EXISTS distribution_config (
      wire TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('telegram', 'discord', 'slack', 'x', 'newsletter')),
      enabled BOOLEAN NOT NULL DEFAULT false,
      config JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (wire, channel)
    )`);

    // Expand channel CHECK constraint (idempotent migration for existing tables)
    await client.query(`ALTER TABLE distribution_config DROP CONSTRAINT IF EXISTS distribution_config_channel_check`);
    await client.query(`ALTER TABLE distribution_config ADD CONSTRAINT distribution_config_channel_check CHECK (channel IN ('telegram', 'discord', 'slack', 'x', 'newsletter'))`);

    // distribution_channels — managed channel configs with credentials stored in DB
    await client.query(`CREATE TABLE IF NOT EXISTS distribution_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wire TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('telegram', 'discord', 'slack', 'x', 'newsletter')),
      name TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT false,
      target_id TEXT NOT NULL DEFAULT '',
      credentials JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Indexes for distribution_channels
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dist_channels_wire ON distribution_channels(wire)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dist_channels_wire_channel ON distribution_channels(wire, channel)`);

    // updated_at trigger for distribution_channels
    await client.query(`
      CREATE OR REPLACE FUNCTION update_distribution_channels_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`DROP TRIGGER IF EXISTS distribution_channels_updated_at ON distribution_channels`);
    await client.query(`
      CREATE TRIGGER distribution_channels_updated_at
        BEFORE UPDATE ON distribution_channels
        FOR EACH ROW
        EXECUTE FUNCTION update_distribution_channels_updated_at()
    `);

    // distribution_logs — per-entry per-channel delivery records
    await client.query(`CREATE TABLE IF NOT EXISTS distribution_logs (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES scan_entries(id),
      channel TEXT NOT NULL CHECK (channel IN ('telegram', 'discord', 'slack', 'x', 'newsletter')),
      wire TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'skipped')),
      post_text TEXT,
      external_id TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Expand distribution_logs channel CHECK constraint
    await client.query(`ALTER TABLE distribution_logs DROP CONSTRAINT IF EXISTS distribution_logs_channel_check`);
    await client.query(`ALTER TABLE distribution_logs ADD CONSTRAINT distribution_logs_channel_check CHECK (channel IN ('telegram', 'discord', 'slack', 'x', 'newsletter'))`);

    // Add channel_id column to track which managed channel instance was used
    // (nullable — legacy/config-based distribution doesn't have a channel_id)
    await client.query(`ALTER TABLE distribution_logs ADD COLUMN IF NOT EXISTS channel_id UUID`);

    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dist_logs_entry ON distribution_logs(entry_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dist_logs_wire_channel ON distribution_logs(wire, channel)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dist_logs_status ON distribution_logs(status)`);

    // Replace old unique index that only used (entry_id, channel) —
    // this broke multi-channel distribution (two Telegram channels collide on same entry_id + 'telegram').
    // New index includes channel_id so each managed channel instance gets its own log row.
    await client.query(`DROP INDEX IF EXISTS idx_dist_logs_no_dupes`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dist_logs_no_dupes
      ON distribution_logs(entry_id, channel, COALESCE(channel_id, '00000000-0000-0000-0000-000000000000'))
      WHERE status IN ('pending', 'success')
    `);

    // updated_at trigger for distribution_config
    await client.query(`
      CREATE OR REPLACE FUNCTION update_distribution_config_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`DROP TRIGGER IF EXISTS distribution_config_updated_at ON distribution_config`);
    await client.query(`
      CREATE TRIGGER distribution_config_updated_at
        BEFORE UPDATE ON distribution_config
        FOR EACH ROW
        EXECUTE FUNCTION update_distribution_config_updated_at()
    `);

    await client.query('COMMIT');
    console.log('[DB] Distribution tables ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function parseDistributionConfigRow(row: any): DistributionConfig {
  return {
    wire: row.wire,
    channel: row.channel,
    enabled: row.enabled,
    config: row.config || {},
  };
}

function parseDistributionLogRow(row: any): DistributionLog {
  return {
    id: row.id,
    entryId: row.entry_id,
    channel: row.channel,
    channelId: row.channel_id || null,
    wire: row.wire,
    status: row.status,
    postText: row.post_text || null,
    externalId: row.external_id || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
  };
}

export async function getDistributionConfigs(wire?: string): Promise<DistributionConfig[]> {
  const pool = getPool();
  if (wire) {
    const result = await pool.query(
      `SELECT * FROM distribution_config WHERE wire = $1 ORDER BY channel`,
      [wire]
    );
    return result.rows.map(parseDistributionConfigRow);
  }
  const result = await pool.query(`SELECT * FROM distribution_config ORDER BY wire, channel`);
  return result.rows.map(parseDistributionConfigRow);
}

export async function upsertDistributionConfig(
  wire: string,
  channel: DistributionChannel,
  enabled: boolean,
  configData: Record<string, string>
): Promise<DistributionConfig> {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO distribution_config (wire, channel, enabled, config)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (wire, channel)
    DO UPDATE SET enabled = $3, config = $4
    RETURNING *
  `, [wire, channel, enabled, JSON.stringify(configData)]);
  return parseDistributionConfigRow(result.rows[0]);
}

export async function getUndistributedEntries(
  wire: string,
  channel?: DistributionChannel
): Promise<any[]> {
  const pool = getPool();
  // Find approved entries that don't have a success/pending log for the given channel(s)
  const channels = channel ? [channel] : ['telegram', 'x'];
  const result = await pool.query(`
    SELECT se.*
    FROM scan_entries se
    WHERE se.wire = $1
      AND se.status = 'approved'
      AND se.distributable IS NOT FALSE
      AND NOT EXISTS (
        SELECT 1 FROM distribution_logs dl
        WHERE dl.entry_id = se.id
          AND dl.channel = ANY($2)
          AND dl.status IN ('pending', 'success')
      )
    ORDER BY se.created_at DESC
  `, [wire, channels]);
  return result.rows;
}

export async function logDistribution(params: {
  entryId: number;
  channel: DistributionChannel;
  wire: string;
  status: DistributionStatus;
  postText?: string;
  externalId?: string;
  errorMessage?: string;
  channelId?: string;
}): Promise<DistributionLog> {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO distribution_logs (entry_id, channel, channel_id, wire, status, post_text, external_id, error_message)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [
    params.entryId,
    params.channel,
    params.channelId || null,
    params.wire,
    params.status,
    params.postText || null,
    params.externalId || null,
    params.errorMessage || null,
  ]);
  return parseDistributionLogRow(result.rows[0]);
}

export async function getDistributionLogs(entryId: number): Promise<DistributionLog[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM distribution_logs WHERE entry_id = $1 ORDER BY created_at DESC`,
    [entryId]
  );
  return result.rows.map(parseDistributionLogRow);
}

export async function getDistributionStatusBulk(
  wire: string
): Promise<Record<number, Record<string, DistributionStatus>>> {
  const pool = getPool();
  // Get the latest log per entry+channel for all approved entries in this wire
  const result = await pool.query(`
    SELECT DISTINCT ON (dl.entry_id, dl.channel)
      dl.entry_id, dl.channel, dl.status
    FROM distribution_logs dl
    JOIN scan_entries se ON se.id = dl.entry_id
    WHERE se.wire = $1 AND se.status = 'approved'
    ORDER BY dl.entry_id, dl.channel, dl.created_at DESC
  `, [wire]);

  const statusMap: Record<number, Record<string, DistributionStatus>> = {};
  for (const row of result.rows) {
    if (!statusMap[row.entry_id]) statusMap[row.entry_id] = {};
    statusMap[row.entry_id][row.channel] = row.status;
  }
  return statusMap;
}

export async function getDistributionStatusForEntries(
  entryIds: number[]
): Promise<Record<number, Record<string, DistributionStatus>>> {
  if (entryIds.length === 0) {
    return {};
  }

  const pool = getPool();
  const result = await pool.query(`
    SELECT DISTINCT ON (entry_id, channel)
      entry_id, channel, status
    FROM distribution_logs
    WHERE entry_id = ANY($1)
    ORDER BY entry_id, channel, created_at DESC
  `, [entryIds]);

  const statusMap: Record<number, Record<string, DistributionStatus>> = {};
  for (const row of result.rows) {
    if (!statusMap[row.entry_id]) {
      statusMap[row.entry_id] = {};
    }
    statusMap[row.entry_id][row.channel] = row.status;
  }

  return statusMap;
}

export async function deleteFailedDistributionLogs(entryId: number): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM distribution_logs WHERE entry_id = $1 AND status = 'failed'`,
    [entryId]
  );
  return result.rowCount ?? 0;
}

// --- Distribution Channels (managed via dashboard UI) ---

export interface DistributionChannelRecord {
  id: string;
  wire: string;
  channel: string;
  name: string;
  enabled: boolean;
  targetId: string;
  credentials: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

function parseDistributionChannelRow(row: any): DistributionChannelRecord {
  return {
    id: row.id,
    wire: row.wire,
    channel: row.channel,
    name: row.name || '',
    enabled: row.enabled,
    targetId: row.target_id || '',
    credentials: row.credentials || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getDistributionChannels(wire?: string): Promise<DistributionChannelRecord[]> {
  const pool = getPool();
  if (wire) {
    const result = await pool.query(
      `SELECT * FROM distribution_channels WHERE wire = $1 ORDER BY channel, name`,
      [wire]
    );
    return result.rows.map(parseDistributionChannelRow);
  }
  const result = await pool.query(`SELECT * FROM distribution_channels ORDER BY wire, channel, name`);
  return result.rows.map(parseDistributionChannelRow);
}

export async function getDistributionChannelById(id: string): Promise<DistributionChannelRecord | null> {
  const pool = getPool();
  const result = await pool.query(`SELECT * FROM distribution_channels WHERE id = $1`, [id]);
  return result.rows.length > 0 ? parseDistributionChannelRow(result.rows[0]) : null;
}

export async function createDistributionChannel(data: {
  wire: string;
  channel: string;
  name: string;
  enabled: boolean;
  targetId: string;
  credentials: Record<string, string>;
}): Promise<DistributionChannelRecord> {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO distribution_channels (wire, channel, name, enabled, target_id, credentials)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [data.wire, data.channel, data.name, data.enabled, data.targetId, JSON.stringify(data.credentials)]);
  return parseDistributionChannelRow(result.rows[0]);
}

export async function updateDistributionChannel(
  id: string,
  data: Partial<{
    wire: string;
    channel: string;
    name: string;
    enabled: boolean;
    targetId: string;
    credentials: Record<string, string>;
  }>
): Promise<DistributionChannelRecord | null> {
  const pool = getPool();
  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.wire !== undefined) { setClauses.push(`wire = $${paramIndex++}`); values.push(data.wire); }
  if (data.channel !== undefined) { setClauses.push(`channel = $${paramIndex++}`); values.push(data.channel); }
  if (data.name !== undefined) { setClauses.push(`name = $${paramIndex++}`); values.push(data.name); }
  if (data.enabled !== undefined) { setClauses.push(`enabled = $${paramIndex++}`); values.push(data.enabled); }
  if (data.targetId !== undefined) { setClauses.push(`target_id = $${paramIndex++}`); values.push(data.targetId); }
  if (data.credentials !== undefined) { setClauses.push(`credentials = $${paramIndex++}`); values.push(JSON.stringify(data.credentials)); }

  if (setClauses.length === 0) return getDistributionChannelById(id);

  values.push(id);
  const result = await pool.query(`
    UPDATE distribution_channels SET ${setClauses.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING *
  `, values);

  return result.rows.length > 0 ? parseDistributionChannelRow(result.rows[0]) : null;
}

export async function deleteDistributionChannel(id: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(`DELETE FROM distribution_channels WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function getEnabledDistributionChannelsForWire(wire: string): Promise<DistributionChannelRecord[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM distribution_channels WHERE wire = $1 AND enabled = true ORDER BY channel, name`,
    [wire]
  );
  return result.rows.map(parseDistributionChannelRow);
}

// --- Summaries write-through on approve ---

export interface SummaryInsert {
  title: string;
  summary: string;
  wire: string;
  qualityScore: number | null;
  entities: Record<string, unknown>;
}

/**
 * Insert an approved scan_entry into the summaries table.
 * Returns the new summaries row ID, or null if the summaries table doesn't exist.
 */
export async function insertApprovedSummary(entry: SummaryInsert): Promise<number | null> {
  const pool = getPool();

  const dataQuality = entry.qualityScore !== null
    ? (entry.qualityScore >= 70 ? 'complete' : entry.qualityScore >= 40 ? 'partial' : 'incomplete')
    : 'complete';
  // confidence is an ENUM (confidencelevel): CONFIDENT or UNCERTAIN
  const confidence = entry.qualityScore !== null && entry.qualityScore >= 50
    ? 'CONFIDENT'
    : 'UNCERTAIN';

  try {
    const result = await pool.query(
      `INSERT INTO summaries (title, summary, wire, processing_status, data_quality, confidence, entities, message_id, category_id)
       VALUES ($1, $2, $3, 'SUCCESS', $4, $5, $6, NULL, NULL)
       RETURNING id`,
      [
        entry.title,
        entry.summary,
        entry.wire,
        dataQuality,
        confidence,
        JSON.stringify(entry.entities),
      ]
    );
    return result.rows[0]?.id ?? null;
  } catch (err: any) {
    // Gracefully handle missing summaries table (external table may not exist in dev)
    if (err.code === '42P01') {
      console.warn('[DB] summaries table does not exist — skipping write-through');
      return null;
    }
    console.error(`[DB] insertApprovedSummary FAILED — code=${err.code} message=${err.message} detail=${err.detail}`);
    // Don't throw — log and return null so approve still succeeds
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Approved entries export (cross-wire)
// ────────────────────────────────────────────────────────────────────────────

export interface ExportEntry {
  id: number;
  name: string;
  description: string | null;
  source_url: string;
  wire: string;
  amount: string | null;
  deadline: string | null;
  quality_score: number | null;
  classification: string | null;
  created_at: Date;
  updated_at: Date;
}

// --- Engagement metrics table ---

export async function ensureEngagementMetricsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS engagement_metrics (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      wire TEXT,
      external_id TEXT,
      impressions INTEGER,
      likes INTEGER,
      retweets INTEGER,
      replies INTEGER,
      quotes INTEGER,
      bookmarks INTEGER,
      engagement_score REAL,
      measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      post_age_hours REAL,
      UNIQUE(entry_id, channel, measured_at)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_engagement_metrics_entry ON engagement_metrics(entry_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_engagement_metrics_wire ON engagement_metrics(wire)`);
  console.log('[DB] Engagement metrics table ready');
}

export async function getApprovedEntriesForExport(hoursBack = 24): Promise<ExportEntry[]> {
  const pool = getPool();
  const result = await pool.query<ExportEntry>(
    `SELECT id, name, description, source_url, wire, amount, deadline,
            quality_score, classification, created_at, updated_at
     FROM scan_entries
     WHERE status = 'approved'
       AND updated_at >= NOW() - make_interval(hours => $1)
     ORDER BY wire, quality_score DESC NULLS LAST`,
    [hoursBack]
  );
  return result.rows;
}
