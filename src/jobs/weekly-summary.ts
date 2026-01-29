import { config, validateConfig } from '../config';
import { getEntriesForDateRange, getDefaultDateRange, closePool } from '../db';
import { processAllEntries } from '../services/processor';
import { generateMarkdown } from '../services/markdown';
import { storeFile } from '../services/storage';
import { createMagicLink } from '../services/auth';
import { sendNotificationEmail } from '../services/email';

async function runWeeklySummary(): Promise<void> {
  console.log('=== Crypto Grant Wire Weekly Summary Job ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  
  try {
    // Validate configuration
    validateConfig();
    console.log('✓ Configuration validated');
    
    // Get date range
    const dateRange = getDefaultDateRange();
    console.log(`Date range: ${dateRange.start.toISOString()} to ${dateRange.end.toISOString()}`);
    
    // Query database
    console.log('Querying database for entries...');
    const entries = await getEntriesForDateRange(dateRange.start, dateRange.end);
    console.log(`Found ${entries.length} entries`);
    
    if (entries.length === 0) {
      console.log('No entries found for this date range. Exiting.');
      return;
    }
    
    // Process entries
    console.log('Processing entries...');
    const { processed, stats } = await processAllEntries(entries, (current, total) => {
      console.log(`  Processing ${current}/${total}...`);
    });
    
    console.log(`✓ Processing complete:`);
    console.log(`  - Total: ${stats.totalEntries}`);
    console.log(`  - X.com (Grok): ${stats.xcomEntries}`);
    console.log(`  - Other (Opus): ${stats.otherEntries}`);
    console.log(`  - Successful: ${stats.successfulProcessing}`);
    console.log(`  - Failed: ${stats.failedProcessing}`);
    
    // Generate markdown
    console.log('Generating markdown...');
    const result = generateMarkdown(processed, stats, dateRange);
    console.log(`✓ Markdown generated (${result.markdown.length} characters)`);
    
    // Store file
    console.log('Storing file...');
    const file = storeFile(result.markdown, dateRange);
    console.log(`✓ File stored: ${file.filename} (ID: ${file.id})`);
    
    // Create magic link
    const downloadUrl = createMagicLink(config.email.notificationEmail, file.id);
    console.log(`✓ Magic link created`);
    
    // Send notification email
    console.log('Sending notification email...');
    await sendNotificationEmail(downloadUrl, stats, dateRange);
    console.log(`✓ Email sent to ${config.email.notificationEmail}`);
    
    console.log('\n=== Job completed successfully ===');
    
  } catch (error) {
    console.error('Job failed:', error);
    throw error;
  } finally {
    await closePool();
  }
}

// Run if called directly
runWeeklySummary()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
