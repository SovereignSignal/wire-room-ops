import { Pool } from 'pg';
import { config } from '../config';
import { DatabaseEntry, Wire } from '../types';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.database.url,
      ssl: config.database.url.includes('localhost') ? false : { rejectUnauthorized: false },
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
  wire?: Wire | Wire[];
}

export async function getEntriesForDateRange(
  startDate: Date,
  endDate: Date,
  wire?: Wire | Wire[]
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
    const entities = row.entities || {};
    const orgs = entities.orgs || entities.protocols || [];

    return {
      id: String(row.id),
      url: url || '',
      quick_summary: row.quick_summary || '',
      category: row.category || 'Uncategorized',
      timestamp: new Date(row.timestamp),
      source: row.source,
      wire: row.wire as Wire | undefined,
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

// Normalize URL for deduplication comparison
function normalizeUrl(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    // Remove trailing slashes, lowercase hostname
    let normalized = `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
    // Include query params if present (some URLs differ only by params)
    if (parsed.search) {
      normalized += parsed.search;
    }
    return normalized;
  } catch {
    // If URL parsing fails, use as-is lowercase
    return url.toLowerCase().replace(/\/+$/, '');
  }
}

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
    SELECT id, name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, created_at, updated_at
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getScheduleById(id: string): Promise<StoredScheduleConfig | null> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, created_at, updated_at
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createSchedule(config: Omit<StoredScheduleConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoredScheduleConfig> {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO schedules (name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id, name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, created_at, updated_at
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

  if (updates.length === 0) {
    return getScheduleById(id);
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  const result = await pool.query(`
    UPDATE schedules SET ${updates.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING id, name, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, created_at, updated_at
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

export async function getAvailableWires(): Promise<WireInfo[]> {
  const pool = getPool();
  
  // Get distinct wires from channel_configs with entry counts
  const result = await pool.query(`
    SELECT 
      cc.wire,
      COUNT(DISTINCT s.id) as entry_count
    FROM channel_configs cc
    LEFT JOIN messages m ON m.channel_config_id = cc.id
    LEFT JOIN summaries s ON s.message_id = m.id AND s.processing_status = 'SUCCESS'
    WHERE cc.wire IS NOT NULL
    GROUP BY cc.wire
    ORDER BY cc.wire
  `);

  // Format display names (capitalize first letter)
  return result.rows.map(row => ({
    wire: row.wire,
    displayName: row.wire.charAt(0).toUpperCase() + row.wire.slice(1).toUpperCase(),
    entryCount: parseInt(row.entry_count, 10) || 0,
  }));
}
