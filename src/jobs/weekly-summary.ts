import { config, validateConfig } from '../config';
import { getEntriesForDateRange, getDefaultDateRange, getFeedByKey } from '../db';
import { processAllEntries, ModelOptions } from '../services/processor';
import { generateMarkdown } from '../services/markdown';
import { storeFile } from '../services/storage';
import { StoredFile } from '../types';
import { createMagicLink } from '../services/auth';
import { sendNotificationEmail } from '../services/email';
import { ProcessingStats } from '../types';

export interface JobResult {
  file: StoredFile;
  stats: ProcessingStats;
  dateRange: { start: Date; end: Date };
  wire?: string;
}

export interface JobOptions {
  sendEmail?: boolean;
  dateRange?: { start: Date; end: Date };
  onProgress?: (current: number, total: number, step: string) => void;
  models?: ModelOptions;
  wire?: string | string[];
}

export async function runWeeklySummaryJob(options: JobOptions | boolean = false): Promise<JobResult> {
  // Handle legacy boolean signature
  const opts: JobOptions = typeof options === 'boolean'
    ? { sendEmail: options }
    : options;

  const { sendEmail = false, dateRange: customDateRange, onProgress, models, wire } = opts;

  const wireLabel = wire ? (Array.isArray(wire) ? wire.join(', ') : wire) : 'all';
  console.log(`=== Grant Wire Weekly Summary Job (${wireLabel}) ===`);
  console.log(`Started at: ${new Date().toISOString()}`);

  // Validate configuration
  validateConfig();
  console.log('✓ Configuration validated');
  onProgress?.(0, 0, 'Configuration validated');

  // Get date range
  const dateRange = customDateRange || getDefaultDateRange();
  console.log(`Date range: ${dateRange.start.toISOString()} to ${dateRange.end.toISOString()}`);
  
  // Query database
  console.log('Querying database for entries...');
  if (wire) {
    console.log(`  Filtering by wire: ${wireLabel}`);
  }
  onProgress?.(0, 0, 'Querying database...');
  const entries = await getEntriesForDateRange(dateRange.start, dateRange.end, wire);
  console.log(`Found ${entries.length} entries`);
  onProgress?.(0, entries.length, `Found ${entries.length} entries`);

  if (entries.length === 0) {
    throw new Error(`No entries found for date range ${dateRange.start.toISOString().slice(0,10)} to ${dateRange.end.toISOString().slice(0,10)} (wire: ${wireLabel})`);
  }

  // Process entries
  console.log('Processing entries...');
  if (models?.grokModel) console.log(`  Using Grok model: ${models.grokModel}`);
  if (models?.anthropicModel) console.log(`  Using Anthropic model: ${models.anthropicModel}`);

  const { processed, stats } = await processAllEntries(entries, {
    onProgress: (current, total) => {
      console.log(`  Processing ${current}/${total}...`);
      onProgress?.(current, total, `Processing entry ${current} of ${total}...`);
    },
    models,
  });
  
  console.log(`✓ Processing complete:`);
  console.log(`  - Total: ${stats.totalEntries}`);
  console.log(`  - X.com (Grok): ${stats.xcomEntries}`);
  console.log(`  - Other (Opus): ${stats.otherEntries}`);
  console.log(`  - Successful: ${stats.successfulProcessing}`);
  console.log(`  - Failed: ${stats.failedProcessing}`);
  
  // Log wire breakdown if available
  if (stats.entriesByWire) {
    const wireBreakdown = Object.entries(stats.entriesByWire).map(([w, c]) => `${w}=${c}`).join(', ');
    console.log(`  - By wire: ${wireBreakdown}`);
  }

  // Generate markdown
  console.log('Generating markdown...');
  onProgress?.(stats.totalEntries, stats.totalEntries, 'Generating markdown...');
  const singleWire = wire && !Array.isArray(wire) ? wire : undefined;
  const feed = singleWire ? await getFeedByKey(singleWire) : null;
  const result = generateMarkdown(processed, stats, dateRange, singleWire, feed?.titleTemplate || undefined);
  console.log(`✓ Markdown generated (${result.markdown.length} characters)`);

  // Store file
  console.log('Storing file...');
  onProgress?.(stats.totalEntries, stats.totalEntries, 'Storing file...');
  const file = await storeFile(result.markdown, dateRange);
  console.log(`✓ File stored: ${file.filename} (ID: ${file.id})`);

  // Optionally send notification email
  if (sendEmail) {
    const downloadUrl = createMagicLink(config.email.notificationEmail, file.id);
    console.log('Sending notification email...');
    onProgress?.(stats.totalEntries, stats.totalEntries, 'Sending notification email...');
    await sendNotificationEmail(downloadUrl, stats, dateRange);
    console.log(`✓ Email sent to ${config.email.notificationEmail}`);
  }
  
  console.log('\n=== Job completed successfully ===');
  
  const resultWire = wire && !Array.isArray(wire) ? wire : undefined;
  return { file, stats, dateRange, wire: resultWire };
}

// Run if called directly (CLI mode)
if (require.main === module) {
  const { closePool } = require('../db');
  
  runWeeklySummaryJob(true)
    .then(() => {
      return closePool();
    })
    .then(() => {
      process.exit(0);
    })
    .catch(async (error) => {
      console.error('Fatal error:', error);
      await closePool();
      process.exit(1);
    });
}
