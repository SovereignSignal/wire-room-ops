import { ProcessedEntry, ProcessingStats, WeeklySummaryResult } from '../types';

function formatDateRange(start: Date, end: Date): string {
  const startMonth = start.toLocaleDateString('en-US', { month: 'long' });
  const endMonth = end.toLocaleDateString('en-US', { month: 'long' });
  const startDay = start.getDate();
  const endDay = end.getDate();
  const year = end.getFullYear();

  if (startMonth === endMonth) {
    return `${startMonth} ${startDay}-${endDay}, ${year}`;
  }
  return `${startMonth} ${startDay} - ${endMonth} ${endDay}, ${year}`;
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

// Convert **OrgName** to [**OrgName**](url) - make the bolded org name a hyperlink
function linkifyOrgName(summary: string, url: string): string {
  // Match **OrgName** at the start of the summary
  const match = summary.match(/^\*\*([^*]+)\*\*/);
  if (match) {
    const orgName = match[1];
    return summary.replace(/^\*\*([^*]+)\*\*/, `[**${orgName}**](${url})`);
  }
  // If no match, prepend with a linked source
  return `[Source](${url}): ${summary}`;
}

export function generateMarkdown(
  entries: ProcessedEntry[],
  stats: ProcessingStats,
  dateRange: { start: Date; end: Date },
  wire?: string,
  feedTitle?: string,
): WeeklySummaryResult {
  const generatedAt = new Date();
  const grouped = groupByCategory(entries);

  const lines: string[] = [];

  // Header - use feed title from DB, or fall back to generic
  const title = feedTitle || "Grant Wire Weekly Update";
  lines.push(`# ${title}`);
  lines.push(`### ${formatDateRange(dateRange.start, dateRange.end)}`);
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

    lines.push('---');
    lines.push('');
    lines.push(`## ${category}`);
    lines.push('');

    for (const entry of categoryEntries) {
      // Output the summary with the org name as a hyperlink
      const linkedSummary = linkifyOrgName(entry.enrichedSummary, entry.url);
      lines.push(linkedSummary);

      if (entry.processingError) {
        lines.push(`*⚠️ ${entry.processingError}*`);
      }

      lines.push('');
    }
  }

  // Footer with stats (minimal)
  lines.push('---');
  lines.push('');
  lines.push(`*Generated from ${stats.totalEntries} entries (${stats.xcomEntries} from X.com, ${stats.otherEntries} from other sources). ${stats.failedProcessing > 0 ? `${stats.failedProcessing} entries may need manual review.` : ''}*`);

  return {
    markdown: lines.join('\n'),
    stats,
    dateRange,
    generatedAt,
    wire,
  };
}
