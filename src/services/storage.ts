import { v4 as uuidv4 } from 'uuid';
import { StoredFile } from '../types';
import { getPool } from '../db';

// In-memory cache (backed by database)
const filesCache = new Map<string, StoredFile>();
let cacheLoaded = false;

export async function ensureFilesTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS generated_files (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      date_range_start TIMESTAMP WITH TIME ZONE,
      date_range_end TIMESTAMP WITH TIME ZONE
    )
  `);
}

async function loadFilesFromDb(): Promise<void> {
  if (cacheLoaded) return;
  
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT id, filename, content, created_at, date_range_start, date_range_end
      FROM generated_files
      ORDER BY created_at DESC
      LIMIT 20
    `);
    
    for (const row of result.rows) {
      const file: StoredFile = {
        id: row.id,
        filename: row.filename,
        content: row.content,
        createdAt: new Date(row.created_at),
        dateRange: {
          start: new Date(row.date_range_start),
          end: new Date(row.date_range_end),
        },
      };
      filesCache.set(file.id, file);
    }
    cacheLoaded = true;
    console.log(`[Storage] Loaded ${result.rows.length} files from database`);
  } catch (error) {
    console.error('[Storage] Failed to load files from database:', error);
  }
}

export async function storeFile(
  content: string,
  dateRange: { start: Date; end: Date },
  filename?: string
): Promise<StoredFile> {
  const id = uuidv4();
  const now = new Date();

  if (!filename) {
    filename = `grant-wire-${formatDateForFilename(dateRange.start)}-to-${formatDateForFilename(dateRange.end)}.md`;
  }
  
  const file: StoredFile = {
    id,
    filename,
    content,
    createdAt: now,
    dateRange,
  };
  
  // Save to database
  const pool = getPool();
  await pool.query(`
    INSERT INTO generated_files (id, filename, content, created_at, date_range_start, date_range_end)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [id, filename, content, now, dateRange.start, dateRange.end]);
  
  // Update cache
  filesCache.set(id, file);
  
  // Clean up old files (keep last 10)
  await cleanupOldFiles();
  
  console.log(`[Storage] File stored: ${filename}`);
  return file;
}

export async function getFile(id: string): Promise<StoredFile | null> {
  await loadFilesFromDb();
  
  // Check cache first
  if (filesCache.has(id)) {
    return filesCache.get(id)!;
  }
  
  // Try database
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT id, filename, content, created_at, date_range_start, date_range_end
      FROM generated_files
      WHERE id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    const file: StoredFile = {
      id: row.id,
      filename: row.filename,
      content: row.content,
      createdAt: new Date(row.created_at),
      dateRange: {
        start: new Date(row.date_range_start),
        end: new Date(row.date_range_end),
      },
    };
    
    filesCache.set(file.id, file);
    return file;
  } catch (error) {
    console.error('[Storage] Failed to get file from database:', error);
    return null;
  }
}

export async function listFiles(): Promise<StoredFile[]> {
  await loadFilesFromDb();
  
  return Array.from(filesCache.values()).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
}

function formatDateForFilename(date: Date): string {
  return date.toISOString().split('T')[0];
}

async function cleanupOldFiles(): Promise<void> {
  try {
    const pool = getPool();

    // Keep only the 10 most recent files in DB
    await pool.query(`
      DELETE FROM generated_files
      WHERE id NOT IN (
        SELECT id FROM generated_files
        ORDER BY created_at DESC
        LIMIT 10
      )
    `);

    // Prune in-memory cache to match
    const sorted = Array.from(filesCache.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    for (const file of sorted.slice(10)) {
      filesCache.delete(file.id);
    }
  } catch (error) {
    console.error('[Storage] Failed to cleanup old files:', error);
  }
}
