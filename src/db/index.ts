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
      s.wire
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

    return {
      id: String(row.id),
      url: url || '',
      quick_summary: row.quick_summary || '',
      category: row.category || 'Uncategorized',
      timestamp: new Date(row.timestamp),
      source: row.source,
      wire: row.wire as Wire | undefined,
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
  enabled: boolean;
  dayOfWeek: number;
  hour: number;
  minute: number;
  lookbackDays: number;
  grokModel?: string;
  anthropicModel?: string;
  timezone: string;
  wire?: string;
}

export async function ensureScheduleTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      day_of_week INTEGER NOT NULL DEFAULT 3,
      hour INTEGER NOT NULL DEFAULT 9,
      minute INTEGER NOT NULL DEFAULT 0,
      lookback_days INTEGER NOT NULL DEFAULT 7,
      grok_model TEXT,
      anthropic_model TEXT,
      timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
      wire TEXT,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT single_row CHECK (id = 1)
    )
  `);
  
  // Add wire column if it doesn't exist (for existing installations)
  await pool.query(`
    ALTER TABLE schedule_config ADD COLUMN IF NOT EXISTS wire TEXT
  `).catch(() => {});
}

export async function getScheduleConfig(): Promise<StoredScheduleConfig | null> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire
    FROM schedule_config
    WHERE id = 1
  `);

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    enabled: row.enabled,
    dayOfWeek: row.day_of_week,
    hour: row.hour,
    minute: row.minute,
    lookbackDays: row.lookback_days,
    grokModel: row.grok_model || undefined,
    anthropicModel: row.anthropic_model || undefined,
    timezone: row.timezone,
    wire: row.wire || undefined,
  };
}

export async function saveScheduleConfig(config: StoredScheduleConfig): Promise<void> {
  const pool = getPool();
  await pool.query(`
    INSERT INTO schedule_config (id, enabled, day_of_week, hour, minute, lookback_days, grok_model, anthropic_model, timezone, wire, updated_at)
    VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      enabled = $1,
      day_of_week = $2,
      hour = $3,
      minute = $4,
      lookback_days = $5,
      grok_model = $6,
      anthropic_model = $7,
      timezone = $8,
      wire = $9,
      updated_at = CURRENT_TIMESTAMP
  `, [
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
