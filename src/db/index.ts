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
      s.id,
      s.title,
      s.summary as quick_summary,
      c.name as category,
      s.created_at as timestamp,
      m.extracted_urls,
      'telegram' as source
    FROM summaries s
    LEFT JOIN messages m ON s.message_id = m.id
    LEFT JOIN categories c ON s.category_id = c.id
    WHERE s.processing_status = 'SUCCESS'
      AND s.created_at >= $1
      AND s.created_at < $2
    ORDER BY c.name, s.created_at DESC
  `;

  const result = await pool.query(query, [startDate, endDate]);

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
