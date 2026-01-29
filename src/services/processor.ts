import { DatabaseEntry, ProcessedEntry, ProcessingStats } from '../types';
import { summarizeWithGrok, isXcomUrl } from './grok';
import { summarizeWithOpus } from './anthropic';

const RETRY_DELAYS = [1000, 2000, 4000];

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = 3
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < retries - 1) {
        await sleep(RETRY_DELAYS[i] || 4000);
      }
    }
  }
  
  throw lastError;
}

export async function processEntry(entry: DatabaseEntry): Promise<ProcessedEntry> {
  const isXcom = isXcomUrl(entry.url);
  
  const baseResult: ProcessedEntry = {
    id: entry.id,
    url: entry.url,
    originalSummary: entry.quick_summary,
    category: entry.category || 'Uncategorized',
    timestamp: entry.timestamp,
    source: entry.source,
    enrichedSummary: '',
    processingMethod: isXcom ? 'grok' : 'opus',
  };

  try {
    const summary = await withRetry(async () => {
      if (isXcom) {
        return await summarizeWithGrok(entry);
      } else {
        return await summarizeWithOpus(entry);
      }
    });
    
    baseResult.enrichedSummary = summary;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    baseResult.processingError = errorMessage;
    baseResult.enrichedSummary = `Unable to access - manual review needed. Original: ${entry.quick_summary}`;
  }

  return baseResult;
}

export async function processAllEntries(
  entries: DatabaseEntry[],
  onProgress?: (current: number, total: number) => void
): Promise<{ processed: ProcessedEntry[]; stats: ProcessingStats }> {
  const processed: ProcessedEntry[] = [];
  const errors: string[] = [];
  
  let xcomCount = 0;
  let otherCount = 0;
  
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    
    if (onProgress) {
      onProgress(i + 1, entries.length);
    }
    
    const result = await processEntry(entry);
    processed.push(result);
    
    if (result.processingMethod === 'grok') {
      xcomCount++;
    } else {
      otherCount++;
    }
    
    if (result.processingError) {
      errors.push(`${entry.url}: ${result.processingError}`);
    }
    
    // Rate limiting: small delay between requests
    if (i < entries.length - 1) {
      await sleep(500);
    }
  }

  const categories = [...new Set(processed.map(p => p.category))].sort();

  const stats: ProcessingStats = {
    totalEntries: entries.length,
    xcomEntries: xcomCount,
    otherEntries: otherCount,
    successfulProcessing: processed.filter(p => !p.processingError).length,
    failedProcessing: processed.filter(p => p.processingError).length,
    categories,
  };

  return { processed, stats };
}
