import { Pool } from 'pg';
import { config } from '../config';
import { DatabaseEntry } from '../types';
import type { ToolType, DistributionChannel, DistributionStatus, DistributionLog } from '../types/intake';
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
  scheduleType?: 'weekly-summary' | 'scan-execution' | 'forum-scan';
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
      day_of_week INTEGER NOT NULL DEFAULT 3,
      hour INTEGER NOT NULL DEFAULT 9,
      minute INTEGER NOT NULL DEFAULT 0,
      lookback_days INTEGER NOT NULL DEFAULT 7,
      grok_model TEXT,
      anthropic_model TEXT,
      timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
      wire TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
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
          INSERT INTO schedules (name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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

export async function getAllSchedules(): Promise<StoredScheduleConfig[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, schedule_type, frequency_hours, notify_emails, created_at, updated_at
    FROM schedules
    ORDER BY created_at ASC
  `);

  return result.rows.map(row => ({
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
    scheduleType: row.schedule_type || 'weekly-summary',
    frequencyHours: row.frequency_hours || undefined,
    notifyEmails: row.notify_emails || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
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

  const row = result.rows[0];
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
    scheduleType: row.schedule_type || 'weekly-summary',
    frequencyHours: row.frequency_hours || undefined,
    notifyEmails: row.notify_emails || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    config.scheduleType || 'weekly-summary',
    config.frequencyHours || null,
    config.notifyEmails || null,
  ]);

  const row = result.rows[0];
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
    scheduleType: row.schedule_type || 'weekly-summary',
    frequencyHours: row.frequency_hours || undefined,
    notifyEmails: row.notify_emails || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

  const row = result.rows[0];
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
    scheduleType: row.schedule_type || 'weekly-summary',
    frequencyHours: row.frequency_hours || undefined,
    notifyEmails: row.notify_emails || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  wire: string;
  displayName: string;
  entryCount: number;
}

export async function getEntryCountsByWire(): Promise<Record<string, number>> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT s.wire, COUNT(DISTINCT s.id) as entry_count
    FROM summaries s
    WHERE s.processing_status = 'SUCCESS' AND s.wire IS NOT NULL
    GROUP BY s.wire
  `);
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

  // Seed known feeds
  let sortIdx = 0;
  for (const [key, data] of Object.entries(SEED_FEEDS)) {
    await pool.query(`
      INSERT INTO feeds (key, display_name, title_template, sort_order)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (key) DO NOTHING
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

export async function updateFeed(key: string, updates: { displayName?: string; titleTemplate?: string; sortOrder?: number }): Promise<FeedRecord | null> {
  const pool = getPool();

  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.displayName !== undefined) { setClauses.push(`display_name = $${paramIndex++}`); values.push(updates.displayName); }
  if (updates.titleTemplate !== undefined) { setClauses.push(`title_template = $${paramIndex++}`); values.push(updates.titleTemplate || null); }
  if (updates.sortOrder !== undefined) { setClauses.push(`sort_order = $${paramIndex++}`); values.push(updates.sortOrder); }

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
    prompt_variant TEXT NOT NULL CHECK (prompt_variant IN ('A', 'B', 'C', 'N')),
    scan_source TEXT NOT NULL DEFAULT 'x-scan',
    scan_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'raw'
      CHECK (status IN ('raw','deduped','duplicate','scored','queued','enriched','published','archived','skipped','approved','declined')),
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
  await client.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_queue ON scan_entries(wire, status, quality_score DESC NULLS LAST) WHERE status IN ('scored', 'queued')`);
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
      CHECK (scan_source IN ('x-scan', 'web-search', 'telegram', 'email', 'forum'))
  `);
  await client.query(`
    ALTER TABLE scan_entries DROP CONSTRAINT IF EXISTS scan_entries_prompt_variant_check
  `);
  await client.query(`
    ALTER TABLE scan_entries ADD CONSTRAINT scan_entries_prompt_variant_check
      CHECK (prompt_variant IN ('A', 'B', 'C', 'N'))
  `);
  await client.query(`
    ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS submitted_by TEXT
  `);

  // Phase 4 migration: make seen_urls.first_seen_entry_id nullable
  // so we can seed URLs from tele-sum messages (no corresponding scan_entries row)
  await client.query(`
    ALTER TABLE seen_urls ALTER COLUMN first_seen_entry_id DROP NOT NULL
  `);

    await client.query('COMMIT');
    console.log('[DB] Scan pipeline tables ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
      CHECK (status IN ('raw','deduped','duplicate','scored','queued','enriched','published','archived','skipped','approved','declined'))
  `);

  // Phase 2: schedule_type for distinguishing weekly-summary vs scan-execution
  await pool.query(`
    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS schedule_type TEXT DEFAULT 'weekly-summary'
  `);

  // Schedule frequency + notify emails columns
  await pool.query(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS frequency_hours INTEGER`);
  await pool.query(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS notify_emails TEXT`);

  // Phase 3 migration: tool_type column for x_search vs web_search
  await pool.query(`
    ALTER TABLE scan_prompts ADD COLUMN IF NOT EXISTS tool_type TEXT DEFAULT 'x_search'
      CHECK (tool_type IN ('x_search', 'web_search'))
  `);

  console.log('[DB] Scan prompts table ready (Phase 2+3 migrations applied)');
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
}): Promise<ScanPromptRecord> {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO scan_prompts (wire, label, prompt_text, response_format, is_active, sort_order, tool_type, variant)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
  ]);

  return parseScanPromptRow(result.rows[0]);
}

export async function updateScanPrompt(
  id: string,
  updates: Partial<{ wire: string; label: string; promptText: string; responseFormat: string | null; isActive: boolean; sortOrder: number; variant: string | null; toolType: ToolType }>
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

export async function getStatusCounts(wire?: string, date?: string): Promise<Record<string, number>> {
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
  opts?: { wire?: string; date?: string; limit?: number; offset?: number }
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

// --- Distribution config table ---

export interface DistributionConfigRecord {
  wire: string;
  enabled: boolean;
  telegramChannelId: string;
  xApiKey: string;
  xApiSecret: string;
  xAccessToken: string;
  xAccessTokenSecret: string;
  xHandle: string;
  createdAt: Date;
  updatedAt: Date;
}

function parseDistributionConfigRow(row: any): DistributionConfigRecord {
  return {
    wire: row.wire,
    enabled: row.enabled,
    telegramChannelId: row.telegram_channel_id || '',
    xApiKey: row.x_api_key || '',
    xApiSecret: row.x_api_secret || '',
    xAccessToken: row.x_access_token || '',
    xAccessTokenSecret: row.x_access_token_secret || '',
    xHandle: row.x_handle || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getDistributionConfigs(): Promise<DistributionConfigRecord[]> {
  const pool = getPool();
  const result = await pool.query(`SELECT * FROM distribution_config ORDER BY wire ASC`);
  return result.rows.map(parseDistributionConfigRow);
}

export async function getDistributionConfig(wire: string): Promise<DistributionConfigRecord | null> {
  const pool = getPool();
  const result = await pool.query(`SELECT * FROM distribution_config WHERE wire = $1`, [wire]);
  return result.rows.length > 0 ? parseDistributionConfigRow(result.rows[0]) : null;
}

export async function upsertDistributionConfig(
  wire: string,
  fields: Partial<Omit<DistributionConfigRecord, 'wire' | 'createdAt' | 'updatedAt'>>
): Promise<DistributionConfigRecord> {
  const pool = getPool();

  // Build SET clauses dynamically so we only update provided fields
  const setClauses: string[] = [];
  const values: any[] = [wire];
  let paramIndex = 2;

  // For INSERT, we need defaults
  const insertCols = ['wire'];
  const insertVals = ['$1'];

  if (fields.enabled !== undefined) {
    setClauses.push(`enabled = $${paramIndex}`);
    insertCols.push('enabled');
    insertVals.push(`$${paramIndex}`);
    values.push(fields.enabled);
    paramIndex++;
  }
  if (fields.telegramChannelId !== undefined) {
    setClauses.push(`telegram_channel_id = $${paramIndex}`);
    insertCols.push('telegram_channel_id');
    insertVals.push(`$${paramIndex}`);
    values.push(fields.telegramChannelId);
    paramIndex++;
  }
  if (fields.xApiKey !== undefined) {
    setClauses.push(`x_api_key = $${paramIndex}`);
    insertCols.push('x_api_key');
    insertVals.push(`$${paramIndex}`);
    values.push(fields.xApiKey);
    paramIndex++;
  }
  if (fields.xApiSecret !== undefined) {
    setClauses.push(`x_api_secret = $${paramIndex}`);
    insertCols.push('x_api_secret');
    insertVals.push(`$${paramIndex}`);
    values.push(fields.xApiSecret);
    paramIndex++;
  }
  if (fields.xAccessToken !== undefined) {
    setClauses.push(`x_access_token = $${paramIndex}`);
    insertCols.push('x_access_token');
    insertVals.push(`$${paramIndex}`);
    values.push(fields.xAccessToken);
    paramIndex++;
  }
  if (fields.xAccessTokenSecret !== undefined) {
    setClauses.push(`x_access_token_secret = $${paramIndex}`);
    insertCols.push('x_access_token_secret');
    insertVals.push(`$${paramIndex}`);
    values.push(fields.xAccessTokenSecret);
    paramIndex++;
  }
  if (fields.xHandle !== undefined) {
    setClauses.push(`x_handle = $${paramIndex}`);
    insertCols.push('x_handle');
    insertVals.push(`$${paramIndex}`);
    values.push(fields.xHandle);
    paramIndex++;
  }

  if (setClauses.length === 0) {
    // No fields to update — just ensure the row exists
    const result = await pool.query(
      `INSERT INTO distribution_config (wire) VALUES ($1)
       ON CONFLICT (wire) DO NOTHING
       RETURNING *`,
      [wire]
    );
    if (result.rows.length > 0) return parseDistributionConfigRow(result.rows[0]);
    // Row already existed
    const existing = await getDistributionConfig(wire);
    return existing!;
  }

  setClauses.push(`updated_at = NOW()`);

  const result = await pool.query(
    `INSERT INTO distribution_config (${insertCols.join(', ')})
     VALUES (${insertVals.join(', ')})
     ON CONFLICT (wire) DO UPDATE SET ${setClauses.join(', ')}
     RETURNING *`,
    values
  );

  return parseDistributionConfigRow(result.rows[0]);
}

// --- Distribution logs table ---

export async function ensureDistributionTable(): Promise<void> {
  const pool = getPool();

  // Distribution config: per-wire channel settings (DB-managed, not env vars)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS distribution_config (
      wire TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT false,
      telegram_channel_id TEXT NOT NULL DEFAULT '',
      x_api_key TEXT NOT NULL DEFAULT '',
      x_api_secret TEXT NOT NULL DEFAULT '',
      x_access_token TEXT NOT NULL DEFAULT '',
      x_access_token_secret TEXT NOT NULL DEFAULT '',
      x_handle TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // updated_at trigger for distribution_config
  await pool.query(`
    CREATE OR REPLACE FUNCTION update_distribution_config_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS distribution_config_updated_at ON distribution_config`);
  await pool.query(`
    CREATE TRIGGER distribution_config_updated_at
      BEFORE UPDATE ON distribution_config
      FOR EACH ROW
      EXECUTE FUNCTION update_distribution_config_updated_at()
  `);

  // Seed from env vars on first run (if table is empty and env vars exist)
  const countRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM distribution_config`);
  if (countRes.rows[0].cnt === 0) {
    const { config: appConfig } = await import('../config');
    const wires = ['crypto', 'ai', 'oss'];
    let seeded = 0;
    for (const wire of wires) {
      const xCreds = (appConfig.distribution.x as Record<string, { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string }>)[wire];
      const tgChannel = (appConfig.distribution.telegramChannels as Record<string, string>)[wire];
      const hasAnything = !!(xCreds?.apiKey || tgChannel);
      if (hasAnything || appConfig.distribution.enabled) {
        await pool.query(
          `INSERT INTO distribution_config (wire, enabled, telegram_channel_id, x_api_key, x_api_secret, x_access_token, x_access_token_secret)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (wire) DO NOTHING`,
          [
            wire,
            appConfig.distribution.enabled,
            tgChannel || '',
            xCreds?.apiKey || '',
            xCreds?.apiSecret || '',
            xCreds?.accessToken || '',
            xCreds?.accessTokenSecret || '',
          ]
        );
        seeded++;
      }
    }
    if (seeded > 0) {
      console.log(`[DB] Distribution config seeded from env vars (${seeded} wires)`);
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS distribution_logs (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES scan_entries(id),
      channel TEXT NOT NULL CHECK (channel IN ('telegram', 'x')),
      wire TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'skipped')),
      post_text TEXT,
      external_id TEXT,
      external_url TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_distribution_logs_entry_id ON distribution_logs(entry_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_distribution_logs_wire_channel ON distribution_logs(wire, channel)`);
  // Prevent double-posting: only one pending/success row per entry+channel
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_distribution_logs_entry_channel_active ON distribution_logs(entry_id, channel) WHERE status IN ('pending', 'success')`);

  // updated_at trigger
  await pool.query(`
    CREATE OR REPLACE FUNCTION update_distribution_logs_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`DROP TRIGGER IF EXISTS distribution_logs_updated_at ON distribution_logs`);
  await pool.query(`
    CREATE TRIGGER distribution_logs_updated_at
      BEFORE UPDATE ON distribution_logs
      FOR EACH ROW
      EXECUTE FUNCTION update_distribution_logs_updated_at()
  `);

  console.log('[DB] Distribution logs table ready');
}

function parseDistributionLogRow(row: any): DistributionLog {
  return {
    id: row.id,
    entryId: row.entry_id,
    channel: row.channel as DistributionChannel,
    wire: row.wire,
    status: row.status as DistributionStatus,
    postText: row.post_text || null,
    externalId: row.external_id || null,
    externalUrl: row.external_url || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertDistributionLog(params: {
  entryId: number;
  channel: DistributionChannel;
  wire: string;
  status?: DistributionStatus;
  postText?: string;
}): Promise<DistributionLog> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO distribution_logs (entry_id, channel, wire, status, post_text)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [params.entryId, params.channel, params.wire, params.status || 'pending', params.postText || null]
  );
  return parseDistributionLogRow(result.rows[0]);
}

export async function updateDistributionLog(
  id: number,
  updates: Partial<{ status: DistributionStatus; postText: string; externalId: string; externalUrl: string; errorMessage: string }>
): Promise<DistributionLog | null> {
  const pool = getPool();
  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.status !== undefined) { setClauses.push(`status = $${paramIndex++}`); values.push(updates.status); }
  if (updates.postText !== undefined) { setClauses.push(`post_text = $${paramIndex++}`); values.push(updates.postText); }
  if (updates.externalId !== undefined) { setClauses.push(`external_id = $${paramIndex++}`); values.push(updates.externalId); }
  if (updates.externalUrl !== undefined) { setClauses.push(`external_url = $${paramIndex++}`); values.push(updates.externalUrl); }
  if (updates.errorMessage !== undefined) { setClauses.push(`error_message = $${paramIndex++}`); values.push(updates.errorMessage); }

  if (setClauses.length === 0) return null;

  values.push(id);
  const result = await pool.query(
    `UPDATE distribution_logs SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows.length > 0 ? parseDistributionLogRow(result.rows[0]) : null;
}

export async function getDistributionLogs(entryId: number): Promise<DistributionLog[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM distribution_logs WHERE entry_id = $1 ORDER BY created_at DESC`,
    [entryId]
  );
  return result.rows.map(parseDistributionLogRow);
}

export async function getDistributionLogsByEntryIds(entryIds: number[]): Promise<Map<number, DistributionLog[]>> {
  if (entryIds.length === 0) return new Map();
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM distribution_logs WHERE entry_id = ANY($1) ORDER BY entry_id, created_at DESC`,
    [entryIds]
  );
  const map = new Map<number, DistributionLog[]>();
  for (const row of result.rows) {
    const log = parseDistributionLogRow(row);
    const existing = map.get(log.entryId) || [];
    existing.push(log);
    map.set(log.entryId, existing);
  }
  return map;
}

export async function deleteDistributionLogs(entryId: number, statusFilter?: DistributionStatus): Promise<number> {
  const pool = getPool();
  if (statusFilter) {
    const result = await pool.query(
      `DELETE FROM distribution_logs WHERE entry_id = $1 AND status = $2`,
      [entryId, statusFilter]
    );
    return result.rowCount ?? 0;
  }
  const result = await pool.query(
    `DELETE FROM distribution_logs WHERE entry_id = $1`,
    [entryId]
  );
  return result.rowCount ?? 0;
}
