import { Pool } from 'pg';
import { config } from '../config';
import { DatabaseEntry } from '../types';

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

export async function getEntriesForDateRange(
  startDate: Date,
  endDate: Date
): Promise<DatabaseEntry[]> {
  const pool = getPool();
  
  const query = `
    SELECT 
      id,
      url,
      quick_summary,
      category,
      timestamp,
      source
    FROM entries
    WHERE timestamp >= $1 AND timestamp < $2
    ORDER BY category, timestamp DESC
  `;
  
  const result = await pool.query(query, [startDate, endDate]);
  
  return result.rows.map(row => ({
    id: row.id,
    url: row.url,
    quick_summary: row.quick_summary,
    category: row.category || 'Uncategorized',
    timestamp: new Date(row.timestamp),
    source: row.source,
  }));
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
