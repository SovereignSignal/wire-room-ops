import { DatabaseEntry, ProcessedEntry, ProcessingStats } from '../types';
import { summarizeWithGrok, isXcomUrl } from './grok';
import { summarizeWithOpus } from './anthropic';
import { sleep } from '../utils/async';

export interface ModelOptions {
  grokModel?: string;
  anthropicModel?: string;
}

const RETRY_DELAYS = [1000, 2000, 4000];

export async function withRetry<T>(
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
        const baseDelay = RETRY_DELAYS[i] || 4000;
        const jitter = Math.random() * baseDelay * 0.3;
        await sleep(baseDelay + jitter);
      }
    }
  }

  throw lastError;
}

export async function processEntry(entry: DatabaseEntry, models?: ModelOptions): Promise<ProcessedEntry> {
  const isXcom = isXcomUrl(entry.url);

  const baseResult: ProcessedEntry = {
    id: entry.id,
    url: entry.url,
    originalSummary: entry.quick_summary,
    category: entry.category || 'Uncategorized',
    timestamp: entry.timestamp,
    source: entry.source,
    wire: entry.wire,
    enrichedSummary: '',
    processingMethod: isXcom ? 'grok' : 'opus',
  };

  try {
    const summary = await withRetry(async () => {
      if (isXcom) {
        return await summarizeWithGrok(entry, models?.grokModel);
      } else {
        return await summarizeWithOpus(entry, models?.anthropicModel);
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

export interface ProcessOptions {
  onProgress?: (current: number, total: number) => void;
  models?: ModelOptions;
}

export async function processAllEntries(
  entries: DatabaseEntry[],
  optionsOrProgress?: ProcessOptions | ((current: number, total: number) => void)
): Promise<{ processed: ProcessedEntry[]; stats: ProcessingStats }> {
  // Handle both old and new signatures
  const options: ProcessOptions = typeof optionsOrProgress === 'function'
    ? { onProgress: optionsOrProgress }
    : optionsOrProgress || {};

  const { onProgress, models } = options;
  const processed: ProcessedEntry[] = [];
  const errors: string[] = [];

  let xcomCount = 0;
  let otherCount = 0;
  const wireCounts: Record<string, number> = {};

  const CONCURRENCY = 3;
  let completedCount = 0;

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        const result = await processEntry(entry, models);
        completedCount++;
        if (onProgress) {
          onProgress(completedCount, entries.length);
        }
        return result;
      })
    );

    for (const result of batchResults) {
      processed.push(result);
      if (result.processingMethod === 'grok') xcomCount++;
      else otherCount++;

      if (result.wire) {
        wireCounts[result.wire] = (wireCounts[result.wire] || 0) + 1;
      }

      if (result.processingError) {
        errors.push(`${result.url || 'unknown'}: ${result.processingError}`);
      }
    }

    // Rate limiting between batches
    if (i + CONCURRENCY < entries.length) {
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
    entriesByWire: wireCounts,
  };

  return { processed, stats };
}
