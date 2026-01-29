import { v4 as uuidv4 } from 'uuid';
import { StoredFile } from '../types';

// In-memory storage (in production, use S3, Railway volume, or database)
const files = new Map<string, StoredFile>();

export function storeFile(
  content: string,
  dateRange: { start: Date; end: Date }
): StoredFile {
  const id = uuidv4();
  const now = new Date();
  
  const filename = `grant-wire-${formatDateForFilename(dateRange.start)}-to-${formatDateForFilename(dateRange.end)}.md`;
  
  const file: StoredFile = {
    id,
    filename,
    content,
    createdAt: now,
    dateRange,
  };
  
  files.set(id, file);
  
  // Clean up old files (keep last 10)
  cleanupOldFiles();
  
  return file;
}

export function getFile(id: string): StoredFile | null {
  return files.get(id) || null;
}

export function listFiles(): StoredFile[] {
  return Array.from(files.values()).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
}

function formatDateForFilename(date: Date): string {
  return date.toISOString().split('T')[0];
}

function cleanupOldFiles(): void {
  const allFiles = listFiles();
  if (allFiles.length > 10) {
    const toDelete = allFiles.slice(10);
    for (const file of toDelete) {
      files.delete(file.id);
    }
  }
}
