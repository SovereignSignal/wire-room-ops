/**
 * Render a weekly issue markdown file to the newsletter HTML (no DB, no send).
 * Run: npx ts-node src/scripts/weekly-preview.ts <markdown-path> [out.html]
 */
import { readFileSync, writeFileSync } from 'fs';
import { buildWeeklyEmailHtml } from '../services/email';

const inPath = process.argv[2];
const outPath = process.argv[3] || '/tmp/weekly-preview.html';
if (!inPath) { console.error('usage: weekly-preview.ts <markdown-path> [out.html]'); process.exit(1); }

const md = readFileSync(inPath, 'utf8');
const { title, html } = buildWeeklyEmailHtml(md);
writeFileSync(outPath, html);
console.log(`Rendered "${title}" -> ${outPath} (${html.length} bytes)`);
