/**
 * CSV Export Job
 *
 * Generates a CSV file and HTML table of recently approved entries across
 * all wires. Used by the daily digest schedule and on-demand API endpoint
 * as raw data input for newsletter composition.
 */

import type { Pool } from 'pg';
import { getApprovedEntriesForExport, ExportEntry } from '../db';
import { storeFile } from '../services/storage';
import { escapeHtml } from '../utils/html';

export interface CsvExportResult {
  date: string;
  entryCount: number;
  wires: string[];
  csvContent: string;
  markdownContent: string;
  htmlTable: string;
  csvFileId: string | null;
  mdFileId: string | null;
  /** @deprecated Use csvFileId */
  fileId: string | null;
}

const CSV_COLUMNS = ['Name', 'Source URL', 'Wire', 'Description', 'Amount', 'Deadline', 'Score', 'Classification'];
const MAX_INLINE_ROWS = 25;
const DESC_TRUNCATE = 200;

function escapeCsvField(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

function buildCsv(entries: ExportEntry[]): string {
  const header = CSV_COLUMNS.map(escapeCsvField).join(',');
  const rows = entries.map(e => [
    escapeCsvField(e.name),
    escapeCsvField(e.source_url),
    escapeCsvField(e.wire),
    escapeCsvField(e.description ? truncate(e.description, DESC_TRUNCATE) : ''),
    escapeCsvField(e.amount || ''),
    escapeCsvField(e.deadline || ''),
    String(e.quality_score ?? ''),
    escapeCsvField(e.classification || ''),
  ].join(','));
  return [header, ...rows].join('\r\n') + '\r\n';
}

function buildHtmlTable(entries: ExportEntry[]): string {
  const show = entries.slice(0, MAX_INLINE_ROWS);
  const overflow = entries.length - show.length;

  const thStyle = 'padding:6px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:left;';
  const tdStyle = 'padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#444;';

  const headerRow = `<tr>
    <th style="${thStyle}">Name</th>
    <th style="${thStyle}">Wire</th>
    <th style="${thStyle}text-align:center;">Score</th>
    <th style="${thStyle}">Amount</th>
  </tr>`;

  const bodyRows = show.map(e => {
    const nameCell = e.source_url
      ? `<a href="${escapeHtml(e.source_url)}" style="color:#0088cc;text-decoration:none;">${escapeHtml(truncate(e.name, 60))}</a>`
      : escapeHtml(truncate(e.name, 60));
    return `<tr>
      <td style="${tdStyle}">${nameCell}</td>
      <td style="${tdStyle}text-transform:uppercase;">${escapeHtml(e.wire)}</td>
      <td style="${tdStyle}text-align:center;font-family:'Courier New',monospace;">${e.quality_score ?? '\u2014'}</td>
      <td style="${tdStyle}">${e.amount ? escapeHtml(e.amount) : '\u2014'}</td>
    </tr>`;
  }).join('');

  let footer = '';
  if (overflow > 0) {
    footer = `<tr><td colspan="4" style="padding:8px;font-size:11px;color:#999;text-align:center;">${overflow} more in the CSV file</td></tr>`;
  }

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:16px;">
    ${headerRow}${bodyRows}${footer}
  </table>`;
}

function buildMarkdown(entries: ExportEntry[]): string {
  const byWire = new Map<string, ExportEntry[]>();
  for (const e of entries) {
    const list = byWire.get(e.wire) || [];
    list.push(e);
    byWire.set(e.wire, list);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const sections: string[] = [`# Approved Entries Export \u2014 ${dateStr}\n`];

  for (const wire of [...byWire.keys()].sort()) {
    const wireEntries = byWire.get(wire)!;
    sections.push(`## ${wire.toUpperCase()} (${wireEntries.length})\n`);
    for (const e of wireEntries) {
      const meta: string[] = [];
      if (e.amount) meta.push(e.amount);
      if (e.deadline) meta.push(`Deadline: ${e.deadline}`);
      if (e.quality_score != null) meta.push(`Score: ${e.quality_score}`);
      const metaLine = meta.length > 0 ? ` \u2014 ${meta.join(' | ')}` : '';
      sections.push(`- **${e.name}**${metaLine}`);
      sections.push(`  ${e.source_url}`);
      if (e.description) {
        sections.push(`  ${truncate(e.description, DESC_TRUNCATE)}`);
      }
      sections.push('');
    }
  }

  return sections.join('\n');
}

export async function runCsvExport(_pool: Pool, hoursBack = 24): Promise<CsvExportResult> {
  const dateStr = new Date().toISOString().slice(0, 10);
  const entries = await getApprovedEntriesForExport(hoursBack);

  if (entries.length === 0) {
    return {
      date: dateStr,
      entryCount: 0,
      wires: [],
      csvContent: '',
      markdownContent: '',
      htmlTable: '',
      csvFileId: null,
      mdFileId: null,
      fileId: null,
    };
  }

  const wires = [...new Set(entries.map(e => e.wire))].sort();
  const csvContent = buildCsv(entries);
  const markdownContent = buildMarkdown(entries);
  const htmlTable = buildHtmlTable(entries);

  const now = new Date();
  const range = { start: new Date(now.getTime() - hoursBack * 3600_000), end: now };

  // Store both formats
  const csvFile = await storeFile(csvContent, range, `wireops-export-${dateStr}.csv`);
  const mdFile = await storeFile(markdownContent, range, `wireops-export-${dateStr}.md`);

  console.log(`[CsvExport] ${entries.length} entries across ${wires.length} wires, csv=${csvFile.id} md=${mdFile.id}`);

  return {
    date: dateStr,
    entryCount: entries.length,
    wires,
    csvContent,
    markdownContent,
    htmlTable,
    csvFileId: csvFile.id,
    mdFileId: mdFile.id,
    fileId: csvFile.id,
  };
}
