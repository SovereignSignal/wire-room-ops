import { ProcessedEntry, ProcessingStats, WeeklySummaryResult } from '../types';

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

function groupByCategory(entries: ProcessedEntry[]): Map<string, ProcessedEntry[]> {
  const groups = new Map<string, ProcessedEntry[]>();
  
  for (const entry of entries) {
    const category = entry.category || 'Uncategorized';
    const existing = groups.get(category) || [];
    existing.push(entry);
    groups.set(category, existing);
  }
  
  return groups;
}

function extractTitle(entry: ProcessedEntry): string {
  const summary = entry.enrichedSummary;

  // Skip error indicators - go straight to fallback
  const errorIndicators = [
    'unable', 'i cannot', 'i can\'t', 'error', 'failed', 'cannot access',
    'not able', 'i\'m unable', 'i am unable', 'manual review'
  ];
  const lowerSummary = summary.toLowerCase();
  const startsWithError = errorIndicators.some(indicator => lowerSummary.startsWith(indicator));

  if (!startsWithError) {
    // Look for patterns like "Organization announced..." or "The Project..."
    const patterns = [
      /^\*\*([A-Z][A-Za-z0-9\s\-\.]+?)\*\*/,  // **Organization Name**
      /^([A-Z][A-Za-z0-9\s\-\.]+?)(?:\s+(?:announced|launched|released|introduced|opened|is|has|will|offers|provides|partnered))/i,
      /^(?:The\s+)?([A-Z][A-Za-z0-9\s\-\.]+?)\s+(?:has|is|announced|launched)/i,
    ];

    for (const pattern of patterns) {
      const match = summary.match(pattern);
      if (match && match[1] && match[1].length < 60 && match[1].length > 2) {
        const title = match[1].trim();
        // Skip if it looks like an error phrase
        if (!errorIndicators.some(e => title.toLowerCase().includes(e))) {
          return title;
        }
      }
    }
  }

  // Fallback: use domain from URL, or extract from X.com username
  try {
    const url = new URL(entry.url);

    // For X.com URLs, try to extract the username as a better title
    if (url.hostname.includes('x.com') || url.hostname.includes('twitter.com')) {
      const pathMatch = entry.url.match(/(?:x\.com|twitter\.com)\/([^\/]+)/i);
      if (pathMatch && pathMatch[1] && !pathMatch[1].includes('status')) {
        return `@${pathMatch[1]}`;
      }
    }

    return url.hostname.replace('www.', '');
  } catch {
    return 'Entry';
  }
}

export function generateMarkdown(
  entries: ProcessedEntry[],
  stats: ProcessingStats,
  dateRange: { start: Date; end: Date }
): WeeklySummaryResult {
  const generatedAt = new Date();
  const grouped = groupByCategory(entries);
  
  const lines: string[] = [];
  
  // Header
  lines.push('# Crypto Grant Wire Weekly Summaries');
  lines.push(`## Week of ${formatDate(dateRange.start)} - ${formatDate(dateRange.end)}`);
  lines.push('');
  lines.push(`Generated: ${formatTimestamp(generatedAt)}`);
  lines.push(`Total entries: ${stats.totalEntries}`);
  lines.push(`X.com entries (via Grok): ${stats.xcomEntries}`);
  lines.push(`Other entries (via Opus): ${stats.otherEntries}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Entries by category
  const sortedCategories = [...grouped.keys()].sort((a, b) => {
    // Put "Uncategorized" at the end
    if (a === 'Uncategorized') return 1;
    if (b === 'Uncategorized') return -1;
    return a.localeCompare(b);
  });

  for (const category of sortedCategories) {
    const categoryEntries = grouped.get(category) || [];
    
    lines.push(`## ${category}`);
    lines.push('');
    
    for (const entry of categoryEntries) {
      const title = extractTitle(entry);
      
      lines.push(`### ${title}`);
      lines.push(`**Source:** ${entry.url}`);
      lines.push(`**Category:** ${entry.category}`);
      lines.push(`**Summary:** ${entry.enrichedSummary}`);
      
      if (entry.processingError) {
        lines.push(`**⚠️ Processing Note:** ${entry.processingError}`);
      }
      
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  // Processing notes
  lines.push('## Processing Notes');
  lines.push('');
  lines.push(`- Entries processed: ${stats.totalEntries}`);
  lines.push(`- X.com entries (Grok): ${stats.xcomEntries}`);
  lines.push(`- Other entries (Opus): ${stats.otherEntries}`);
  lines.push(`- Successfully processed: ${stats.successfulProcessing}`);
  lines.push(`- Failed/manual review needed: ${stats.failedProcessing}`);
  lines.push(`- Categories found: ${stats.categories.join(', ')}`);
  
  // List any errors
  const errors = entries.filter(e => e.processingError);
  if (errors.length > 0) {
    lines.push('');
    lines.push('### Entries requiring manual review:');
    for (const entry of errors) {
      lines.push(`- ${entry.url}: ${entry.processingError}`);
    }
  }

  return {
    markdown: lines.join('\n'),
    stats,
    dateRange,
    generatedAt,
  };
}
