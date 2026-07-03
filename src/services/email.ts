import { Resend } from 'resend';
import { config } from '../config';
import { getBrand } from '../config/brand';
import { ProcessingStats } from '../types';
import { escapeHtml } from '../utils/html';
import type { ScanExecutionResult } from '../jobs/scan-execution';
import { logApiUsage } from './api-usage';
import { getCachedProvider } from './api-provider';

function getResend(): Resend {
  // Check provider cache first (Settings > API Providers UI), fall back to env var
  const provider = getCachedProvider('resend');
  const apiKey = provider?.api_key || config.email.resendApiKey;
  if (!apiKey) {
    throw new Error('Resend API key not configured. Set RESEND_API_KEY or configure via Settings > API Providers.');
  }
  return new Resend(apiKey);
}

async function sendWithTracking(params: Parameters<Resend['emails']['send']>[0]): Promise<void> {
  const client = getResend();
  const start = Date.now();
  try {
    await client.emails.send(params);
    logApiUsage({ provider: 'resend', model: 'email', purpose: 'email', duration_ms: Date.now() - start });
  } catch (error) {
    logApiUsage({ provider: 'resend', model: 'email', purpose: 'email', duration_ms: Date.now() - start, success: false, error_message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function formatDateRange(start: Date, end: Date): string {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  return `${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Simple, light email shell — works across all clients
// ────────────────────────────────────────────────────────────────────────────

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const MONO = "font-family:'Courier New',Courier,monospace;";

function emailShell(title: string, bodyHtml: string): string {
  const brand = getBrand();
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;${FONT}">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f5f5f5;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#ffffff;border:1px solid #e0e0e0;">
          <tr>
            <td style="padding:24px 28px 16px;border-bottom:2px solid #222;">
              <span style="font-size:16px;font-weight:700;letter-spacing:3px;color:#222;">WIRE<span style="color:#0088cc;">OPS</span></span>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;border-top:1px solid #e0e0e0;">
              <p style="margin:0;color:#999;font-size:11px;">${escapeHtml(brand.name)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

function emailBtn(href: string, label: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:20px 0;">
  <tr>
    <td style="background-color:#0088cc;padding:10px 24px;">
      <a href="${escapeHtml(href)}" target="_blank" style="color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;${FONT}">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

function sectionLabel(label: string): string {
  return `<p style="margin:20px 0 8px;color:#666;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">${escapeHtml(label)}</p>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Email templates
// ────────────────────────────────────────────────────────────────────────────

export async function sendTestAlertEmail(): Promise<void> {
  const now = new Date();
  const timestamp = now.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  const body = `
    <p style="margin:0 0 8px;font-size:15px;color:#222;">Signal Confirmed</p>
    <p style="margin:0 0 16px;font-size:13px;color:#444;">Email alerts are operational.</p>
    <p style="margin:0;color:#999;font-size:12px;${MONO}">${escapeHtml(timestamp)}</p>`;

  const htmlContent = emailShell('Test Alert', body);

  const textContent = `WIREOPS - Signal Confirmed

Email alerts are operational.

${timestamp}`.trim();

  console.log(`[Email] Sending test alert to: ${config.email.notificationEmail}`);

  await sendWithTracking({
    from: config.email.fromEmail,
    to: config.email.notificationEmail,
    subject: 'WireOps - Signal Confirmed',
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Test alert sent successfully`);
}

export async function sendScheduledJobFailureEmail(errorMessage: string, jobStartTime: Date, recipients?: string[]): Promise<void> {
  const timestamp = jobStartTime.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  const body = `
    <p style="margin:0 0 8px;font-size:15px;color:#cc0000;font-weight:600;">Scheduled Job Failed</p>
    <p style="margin:0 0 16px;font-size:13px;color:#444;">Check the dashboard or server logs for details.</p>
    ${sectionLabel('Error')}
    <p style="margin:0 0 16px;font-size:12px;color:#444;${MONO}background:#f8f8f8;padding:12px;border-left:3px solid #cc0000;word-break:break-word;">${escapeHtml(errorMessage)}</p>
    <p style="margin:0;color:#999;font-size:12px;">Job started: ${escapeHtml(timestamp)}</p>`;

  const htmlContent = emailShell('Scheduled Job Failed', body);

  const textContent = `WIREOPS - Scheduled Job Failed

${errorMessage}

Job started at: ${timestamp}`.trim();

  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;
  console.log(`[Email] Sending scheduled job failure notification to: ${Array.isArray(to) ? to.join(', ') : to}`);

  await sendWithTracking({
    from: config.email.fromEmail,
    to,
    subject: 'WireOps - Scheduled Job Failed',
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Scheduled job failure notification sent successfully`);
}

export async function sendResendLinkEmail(email: string, downloadUrl: string, filename: string): Promise<void> {
  console.log(`[Email] Sending resend link email to: ${email}`);

  const body = `
    <p style="margin:0 0 8px;font-size:15px;color:#222;">Download Link</p>
    <p style="margin:0 0 16px;font-size:13px;color:#666;${MONO}">${escapeHtml(filename)}</p>
    ${emailBtn(downloadUrl, 'Download File')}
    <p style="margin:0;color:#999;font-size:12px;">This link expires in 24 hours.</p>`;

  const htmlContent = emailShell('Download Link', body);

  const textContent = `WIREOPS - Download Link

File: ${filename}

Download: ${downloadUrl}

This link expires in 24 hours.`.trim();

  await sendWithTracking({
    from: config.email.fromEmail,
    to: email,
    subject: 'WireOps - Fresh Download Link',
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Resend link email sent successfully`);
}

export async function sendScanDigestEmail(
  scanResult: ScanExecutionResult,
  dashboardUrl: string,
  recipients?: string[]
): Promise<void> {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const { intakeSummary, perPrompt, totalResults, promptsExecuted, promptsFailed, totalDurationMs } = scanResult;
  const durationSec = Math.round(totalDurationMs / 1000);

  // Top finds
  const topFinds = intakeSummary.topFinds.slice(0, 10);
  let topFindsHtml = '';
  let topFindsText = '';

  if (topFinds.length > 0) {
    const rows = topFinds.map(entry => {
      const score = entry.qualityScore ?? 0;
      const name = escapeHtml(entry.name);
      const nameCell = entry.sourceUrl
        ? `<a href="${escapeHtml(entry.sourceUrl)}" style="color:#0088cc;text-decoration:none;">${name}</a>`
        : name;
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#444;text-align:center;${MONO}">${score}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#222;">${nameCell}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666;">${escapeHtml(entry.wire)}</td>
      </tr>`;
    }).join('');

    topFindsHtml = `
      ${sectionLabel('Top Finds')}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:16px;">
        <tr>
          <th style="padding:6px 8px;text-align:center;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;">Score</th>
          <th style="padding:6px 8px;text-align:left;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;">Name</th>
          <th style="padding:6px 8px;text-align:left;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;">Wire</th>
        </tr>
        ${rows}
      </table>`;

    topFindsText = topFinds.map(e => `  [${e.qualityScore ?? 0}] ${e.name} (${e.wire})`).join('\n');
  }

  // Per-prompt breakdown
  const promptLines = perPrompt.map(p => {
    if (p.error) return `<span style="color:#cc0000;">${escapeHtml(p.label)}: FAILED</span>`;
    return `${escapeHtml(p.label)}: ${p.resultCount} results (${Math.round(p.durationMs / 1000)}s)`;
  }).join('<br>');

  const promptLinesText = perPrompt.map(p => {
    if (p.error) return `  ${p.label}: FAILED`;
    return `  ${p.label}: ${p.resultCount} results (${Math.round(p.durationMs / 1000)}s)`;
  }).join('\n');

  const reviewUrl = `${dashboardUrl.replace(/\/$/, '')}/queue`;

  const body = `
    <p style="margin:0 0 16px;font-size:15px;color:#222;">Scan Results &mdash; ${escapeHtml(dateStr)}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#444;"><strong>${totalResults}</strong> results across ${promptsExecuted} prompts</p>
    <p style="margin:0 0 4px;font-size:13px;color:#666;">${intakeSummary.newUnique} unique &middot; ${intakeSummary.duplicatesFound} duplicates &middot; ${intakeSummary.highQualityCount} high quality</p>
    <p style="margin:0 0 16px;font-size:12px;color:#999;">${durationSec}s${promptsFailed > 0 ? ` &middot; <span style="color:#cc0000;">${promptsFailed} failed</span>` : ''}</p>
    ${topFindsHtml}
    ${sectionLabel('Per-Prompt')}
    <p style="margin:0 0 16px;font-size:12px;color:#666;${MONO}line-height:1.6;">${promptLines}</p>
    ${emailBtn(reviewUrl, 'Review Queue')}`;

  const htmlContent = emailShell('Scan Digest', body);

  const textContent = `WIREOPS - Scan Digest ${dateStr}

${totalResults} results across ${promptsExecuted} prompts
${intakeSummary.newUnique} unique, ${intakeSummary.duplicatesFound} duplicates, ${intakeSummary.highQualityCount} high quality
${durationSec}s${promptsFailed > 0 ? `, ${promptsFailed} failed` : ''}

${topFindsText ? `TOP FINDS\n${topFindsText}\n` : ''}
PER-PROMPT
${promptLinesText}

Review: ${reviewUrl}`.trim();

  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;
  console.log(`[Email] Sending scan digest to: ${Array.isArray(to) ? to.join(', ') : to}`);

  await sendWithTracking({
    from: config.email.fromEmail,
    to,
    subject: `Scan Digest - ${dateStr} | ${intakeSummary.newUnique} new finds`,
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Scan digest email sent successfully`);
}

export interface TopFindEntry {
  name: string;
  wire: string;
  quality_score: number;
  amount: string | null;
  deadline: string | null;
  source_url: string | null;
}

export interface AgentBriefEntry {
  name: string;
  wire: string;
  score: number;
  sourceUrl: string;
  action: 'approved' | 'archived' | 'queued';
}

/** One run recorded via POST /api/scan/agent/send-brief. */
export interface AgentBriefRun {
  date?: string;
  entries?: AgentBriefEntry[];
  searchesDone?: number;
  totalFound?: number;
  skippedDuplicates?: number;
  receivedAt?: string;
}

/** Stored shape in app_state under `agent-brief:<date>`. */
export interface StoredAgentBrief {
  runs: AgentBriefRun[];
}

export interface DigestBdLead {
  lead: string;
  source: string;
  notes: string;
}

export interface DigestEmailExtras {
  topFinds?: TopFindEntry[];
  csvExport?: import('../jobs/csv-export').CsvExportResult;
  downloadUrls?: { csv: string | null; md: string | null };
  agentBrief?: StoredAgentBrief | null;
  sourceBreakdown?: import('../jobs/daily-digest').SourceBreakdownRow[];
  costRecap?: { rows: import('../jobs/daily-digest').CostRow[]; total: number };
  /** Wednesday BD leads written to Paid Work Leads this run (Phase C surface) */
  bdLeads?: DigestBdLead[];
  bdLeadsUrl?: string;
  /** Operational anomalies collected by the scheduler — the ONLY way ops
   *  telemetry gets into the email. No anomalies = one quiet check mark. */
  anomalies?: string[];
}

/**
 * Render the daily digest email (2026-07-03 redesign).
 *
 * Design contract — the email answers "what needs me today?" in one glance:
 *   1. one-line health strip (in / to-review / approved / $ / lanes)
 *   2. NEEDS YOU — the queued items worth attention, one line each
 *   3. BD LEADS — Wednesdays, the verified Paid Work Leads written this run
 *   4. HEADS-UP — anomalies only (lane failures, dupe spikes, cost spikes)
 *   5. one-line activity notes (agent scan, approved + export links)
 * Ops telemetry tables (per-source matrix, cost table, wire table) live in
 * the dashboard, not here. Quiet day = short email.
 */
export function renderDailyDigest(
  digest: import('../jobs/daily-digest').DailyDigestResult,
  dashboardUrl: string,
  extras: DigestEmailExtras = {},
): { subject: string; html: string; text: string } {
  const brand = getBrand();
  const base = dashboardUrl.replace(/\/$/, '');
  const reviewUrl = `${base}/queue`;
  const { topFinds, csvExport, downloadUrls, agentBrief, costRecap, bdLeads, bdLeadsUrl, anomalies } = extras;

  const wireChip = (w: string) =>
    `<span style="display:inline-block;padding:1px 6px;border:1px solid #ddd;border-radius:3px;font-size:10px;color:#666;text-transform:uppercase;${MONO}">${escapeHtml(w)}</span>`;

  // ── 1. Health strip ────────────────────────────────────────────────────
  const totalIn = digest.wires.reduce((n, w) => n + w.totalIngested, 0);
  const approved24 = digest.wires.reduce((n, w) => n + w.recentlyApproved, 0);
  const lanesOk = !anomalies || anomalies.length === 0;
  const stripParts = [
    `${totalIn} in`,
    `<strong style="color:${digest.totalPendingReview > 0 ? '#0088cc' : '#1a8a5a'};">${digest.totalPendingReview} to review</strong>`,
    `${approved24} approved`,
    costRecap ? `$${costRecap.total.toFixed(2)} API` : null,
    lanesOk ? `lanes <span style="color:#1a8a5a;">\u2713</span>` : `<strong style="color:#cc4400;">\u26a0 ${anomalies!.length} heads-up</strong>`,
  ].filter(Boolean);
  const stripHtml = `<p style="margin:0 0 18px;font-size:13px;color:#444;${MONO}">${stripParts.join(' &nbsp;\u00b7&nbsp; ')}</p>`;
  const stripText = [
    `${totalIn} in`, `${digest.totalPendingReview} to review`, `${approved24} approved`,
    costRecap ? `$${costRecap.total.toFixed(2)} API` : null, lanesOk ? 'lanes OK' : `${anomalies!.length} HEADS-UP`,
  ].filter(Boolean).join(' | ');

  // ── 2. NEEDS YOU ───────────────────────────────────────────────────────
  let needsHtml = '';
  let needsText = '';
  if (digest.totalPendingReview > 0 && topFinds && topFinds.length > 0) {
    const shown = topFinds.slice(0, 8);
    const lines = shown.map(e => {
      const nameCell = e.source_url
        ? `<a href="${escapeHtml(e.source_url)}" style="color:#0088cc;text-decoration:none;font-weight:600;">${escapeHtml(e.name)}</a>`
        : `<span style="font-weight:600;color:#222;">${escapeHtml(e.name)}</span>`;
      const meta = [e.amount, e.deadline ? `due ${e.deadline}` : null].filter(Boolean).map(x => escapeHtml(String(x))).join(' \u00b7 ');
      return `<p style="margin:0 0 7px;font-size:13px;color:#222;line-height:1.5;">${wireChip(e.wire)} ${nameCell}${meta ? ` <span style="color:#888;">\u2014 ${meta}</span>` : ''}</p>`;
    }).join('');
    const more = digest.totalPendingReview - shown.length;
    needsHtml = `
      ${sectionLabel(`Needs you (${digest.totalPendingReview})`)}
      ${lines}
      ${more > 0 ? `<p style="margin:2px 0 8px;font-size:12px;color:#888;">\u2026and ${more} more in the queue</p>` : ''}
      ${emailBtn(reviewUrl, 'Review queue')}`;
    needsText = `\nNEEDS YOU (${digest.totalPendingReview})\n` + shown.map(e =>
      `  [${e.wire}] ${e.name}${e.amount ? ` | ${e.amount}` : ''}${e.deadline ? ` | due ${e.deadline}` : ''}`
    ).join('\n') + (more > 0 ? `\n  ...and ${more} more` : '') + `\n  Review: ${reviewUrl}\n`;
  } else if (digest.totalPendingReview === 0) {
    needsHtml = `<p style="margin:0 0 16px;font-size:13px;color:#1a8a5a;">Queue is clear \u2014 nothing needs you today.</p>`;
    needsText = '\nQueue is clear - nothing needs you today.\n';
  }

  // ── 3. BD LEADS (Wednesdays) ───────────────────────────────────────────
  let bdHtml = '';
  let bdText = '';
  if (bdLeads && bdLeads.length > 0) {
    const lines = bdLeads.map(l => {
      const title = l.source
        ? `<a href="${escapeHtml(l.source)}" style="color:#7c4dcc;text-decoration:none;font-weight:600;">${escapeHtml(l.lead)}</a>`
        : `<span style="font-weight:600;color:#222;">${escapeHtml(l.lead)}</span>`;
      const note = l.notes ? `<span style="color:#888;"> \u2014 ${escapeHtml(l.notes.slice(0, 140))}</span>` : '';
      return `<p style="margin:0 0 7px;font-size:13px;color:#222;line-height:1.5;">${title}${note}</p>`;
    }).join('');
    bdHtml = `
      ${sectionLabel(`BD leads \u2014 verified, not contacted (${bdLeads.length})`)}
      ${lines}
      ${bdLeadsUrl ? emailBtn(bdLeadsUrl, 'Triage in Notion') : ''}`;
    bdText = `\nBD LEADS - VERIFIED, NOT CONTACTED (${bdLeads.length})\n` + bdLeads.map(l =>
      `  ${l.lead}${l.notes ? ` — ${l.notes.slice(0, 110)}` : ''}${l.source ? `\n    ${l.source}` : ''}`
    ).join('\n') + (bdLeadsUrl ? `\n  Triage: ${bdLeadsUrl}` : '') + '\n';
  }

  // ── 4. HEADS-UP (anomalies only) ───────────────────────────────────────
  let headsHtml = '';
  let headsText = '';
  if (anomalies && anomalies.length > 0) {
    headsHtml = `
      ${sectionLabel('Heads-up')}
      ${anomalies.map(a => `<p style="margin:0 0 6px;font-size:12px;color:#cc4400;">\u26a0 ${escapeHtml(a)}</p>`).join('')}`;
    headsText = '\nHEADS-UP\n' + anomalies.map(a => `  ! ${a}`).join('\n') + '\n';
  }

  // ── 5. Activity one-liners ─────────────────────────────────────────────
  const notes: string[] = [];
  const notesText: string[] = [];
  if (agentBrief?.runs?.length) {
    const runs = agentBrief.runs;
    const searches = runs.reduce((n, r) => n + (r.searchesDone ?? 0), 0);
    const submitted = runs.reduce((n, r) => n + (r.entries?.length ?? 0), 0);
    const dupes = runs.reduce((n, r) => n + (r.skippedDuplicates ?? 0), 0);
    notes.push(`Agent scan: ${runs.length} run${runs.length > 1 ? 's' : ''} \u00b7 ${searches} searches \u00b7 ${submitted} submitted \u00b7 ${dupes} dupes skipped`);
    notesText.push(`Agent scan: ${runs.length} runs | ${searches} searches | ${submitted} submitted | ${dupes} dupes skipped`);
  }
  if (csvExport && csvExport.entryCount > 0) {
    const links = [
      downloadUrls?.csv ? `<a href="${escapeHtml(downloadUrls.csv)}" style="color:#0088cc;">CSV</a>` : null,
      downloadUrls?.md ? `<a href="${escapeHtml(downloadUrls.md)}" style="color:#0088cc;">Markdown</a>` : null,
    ].filter(Boolean).join(' \u00b7 ');
    notes.push(`Approved last 24h: ${csvExport.entryCount}${links ? ` \u2014 ${links}` : ''}`);
    notesText.push(`Approved last 24h: ${csvExport.entryCount}${downloadUrls?.csv ? ` | CSV: ${downloadUrls.csv}` : ''}${downloadUrls?.md ? ` | MD: ${downloadUrls.md}` : ''}`);
  }
  const notesHtml = notes.length
    ? `${sectionLabel('Activity')}${notes.map(n => `<p style="margin:0 0 6px;font-size:12px;color:#666;">${n}</p>`).join('')}`
    : '';

  const body = `
    ${stripHtml}
    ${needsHtml}
    ${bdHtml}
    ${headsHtml}
    ${notesHtml}
    <p style="margin:22px 0 0;font-size:11px;color:#aaa;"><a href="${escapeHtml(base)}" style="color:#aaa;">Dashboard</a> \u00b7 per-source and cost detail lives there, not here.</p>`;

  const html = emailShell(`WireOps \u2014 ${digest.date}`, body);

  const text = `WIREOPS - ${digest.date}
${stripText}
${needsText}${bdText}${headsText}${notesText.length ? '\nACTIVITY\n' + notesText.map(n => '  ' + n).join('\n') + '\n' : ''}
Dashboard: ${base}

---
${brand.name}`;

  const subjectParts = [
    `${digest.totalPendingReview} to review`,
    bdLeads && bdLeads.length > 0 ? `${bdLeads.length} BD lead${bdLeads.length > 1 ? 's' : ''}` : null,
    !lanesOk ? `\u26a0 ${anomalies!.length} heads-up` : null,
  ].filter(Boolean);
  const subject = `WireOps \u2014 ${digest.date} | ${subjectParts.join(' \u00b7 ')}`;

  return { subject, html, text };
}

export async function sendDailyDigestEmail(
  digest: import('../jobs/daily-digest').DailyDigestResult,
  dashboardUrl: string,
  recipients?: string[],
  extras: DigestEmailExtras = {},
): Promise<void> {
  const brand = getBrand();
  const rendered = renderDailyDigest(digest, dashboardUrl, extras);
  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;

  await sendWithTracking({
    from: `${brand.fromName} <${config.email.fromEmail}>`,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  console.log(`[Email] Daily digest sent to: ${Array.isArray(to) ? to.join(', ') : to}`);
}

export async function sendCsvExportEmail(
  result: import('../jobs/csv-export').CsvExportResult,
  downloadUrls: { csv: string | null; md: string | null },
  recipients?: string[]
): Promise<void> {
  const brand = getBrand();
  const wireList = result.wires.map(w => w.toUpperCase()).join(', ');

  const buttons = [
    downloadUrls.csv ? emailBtn(downloadUrls.csv, 'Download CSV') : '',
    downloadUrls.md ? emailBtn(downloadUrls.md, 'Download Markdown') : '',
  ].filter(Boolean).join('');

  const body = `
    <p style="margin:0 0 16px;font-size:14px;color:#222;"><strong>${result.entryCount}</strong> approved entries across ${result.wires.length} wire${result.wires.length !== 1 ? 's' : ''} (${escapeHtml(wireList)})</p>
    ${sectionLabel('Entries')}
    ${result.htmlTable}
    ${buttons}
    <p style="margin:0;color:#999;font-size:11px;">Use this data as input for newsletter composition.</p>`;

  const htmlContent = emailShell(`Approved Export \u2014 ${result.date}`, body);

  const textContent = `WIREOPS - Approved Entries Export ${result.date}

${result.entryCount} approved entries across ${result.wires.length} wire(s): ${wireList}
${downloadUrls.csv ? `\nDownload CSV: ${downloadUrls.csv}` : ''}
${downloadUrls.md ? `\nDownload Markdown: ${downloadUrls.md}` : ''}

---
${brand.name}`.trim();

  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;

  await sendWithTracking({
    from: `${brand.fromName} <${config.email.fromEmail}>`,
    to,
    subject: `WireOps Export \u2014 ${result.date} | ${result.entryCount} approved entries`,
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] CSV export email sent to: ${Array.isArray(to) ? to.join(', ') : to}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Agent scan brief
// ────────────────────────────────────────────────────────────────────────────

export async function sendDeadlineDigestEmail(
  results: { wire: string; entries: { name: string; deadline: string; daysUntil: number; amount: string | null; sourceUrl: string }[] }[],
  dashboardUrl: string,
  recipients?: string[]
): Promise<void> {
  const brand = getBrand();
  const total = results.reduce((n, r) => n + r.entries.length, 0);

  type DE = { name: string; deadline: string; daysUntil: number; amount: string | null; sourceUrl: string };
  function row(e: DE): string {
    const name = e.sourceUrl
      ? `<a href="${escapeHtml(e.sourceUrl)}" style="color:#0088cc;text-decoration:none;">${escapeHtml(e.name)}</a>`
      : escapeHtml(e.name);
    const days = e.daysUntil <= 0 ? 'today' : e.daysUntil === 1 ? '1 day' : `${e.daysUntil} days`;
    return `<tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#222;">${name}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#444;${MONO}">${escapeHtml(e.deadline || '')}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#cc6600;text-align:center;">${days}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666;">${escapeHtml(e.amount || '')}</td>
    </tr>`;
  }

  const sections = results.filter(r => r.entries.length > 0).map(r => `${sectionLabel(`${r.wire} — ${r.entries.length} closing`)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #eee;">
      <tr>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:#666;border-bottom:2px solid #ddd;">Name</th>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:#666;border-bottom:2px solid #ddd;">Deadline</th>
        <th style="padding:6px 8px;text-align:center;font-size:11px;color:#666;border-bottom:2px solid #ddd;">Closes in</th>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:#666;border-bottom:2px solid #ddd;">Amount</th>
      </tr>
      ${r.entries.map(row).join('')}
    </table>`).join('');

  const body = `
    <p style="margin:0 0 16px;font-size:14px;color:#222;"><strong>${total}</strong> approved ${total === 1 ? 'entry is' : 'entries are'} closing in the next 7 days.</p>
    ${sections}
    ${emailBtn(dashboardUrl, 'View in Dashboard')}`;

  const htmlContent = emailShell('Closing Soon', body);
  const textContent = `${brand.name.toUpperCase()} — CLOSING SOON (next 7 days)

${total} approved ${total === 1 ? 'entry' : 'entries'} closing:
${results.flatMap(r => r.entries.map(e => `  - [${r.wire}] ${e.name} — ${e.deadline} (in ${e.daysUntil}d)`)).join('\n')}

Dashboard: ${dashboardUrl}

---
${brand.name}`.trim();

  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;

  await sendWithTracking({
    from: `${brand.fromName} <${config.email.fromEmail}>`,
    to,
    subject: `${brand.name} — ${total} closing in 7 days`,
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Deadline digest sent to: ${Array.isArray(to) ? to.join(', ') : to}`);
}

// --- Newsletter rendering: markdown issue -> professional HTML email ---

const NL_LINK = 'color:#1a56db;text-decoration:none;border-bottom:1px solid #bcd0f7;';

/** Render inline markdown (links, bold, escaped dollars) to safe HTML. */
function nlInline(s: string): string {
  let h = escapeHtml(s).replace(/\\\$/g, '$');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${u}" style="${NL_LINK}">${t}</a>`);
  return h;
}

/** Convert the issue markdown to a styled newsletter body + extract the title. */
export function renderIssueToNewsletter(markdown: string): { title: string; bodyHtml: string } {
  const lines = markdown.split('\n');
  let title = "Sov's Grant Wire Weekly";
  const out: string[] = [];
  let list: string[] = [];
  const flushList = () => { if (list.length) { out.push(`<ul style="margin:0 0 20px;padding-left:18px;">${list.join('')}</ul>`); list = []; } };
  let firstPara = true;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^#\s+/.test(line)) { flushList(); title = line.replace(/^#\s+/, '').replace(/\\\$/g, '$'); continue; }
    if (/^##\s+/.test(line)) {
      flushList();
      out.push(`<h2 style="margin:30px 0 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#0b1f3a;border-bottom:2px solid #0b1f3a;padding-bottom:6px;">${nlInline(line.replace(/^##\s+/, ''))}</h2>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) { out.push(''); list.push(`<li style="margin:0 0 9px;font-size:14px;line-height:1.6;color:#374151;">${nlInline(line.replace(/^[-*]\s+/, ''))}</li>`); continue; }
    if (line.trim() === '') { flushList(); continue; }
    flushList();
    const style = firstPara
      ? 'margin:0 0 20px;font-size:16px;line-height:1.7;color:#111827;'
      : 'margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151;';
    out.push(`<p style="${style}">${nlInline(line)}</p>`);
    firstPara = false;
  }
  flushList();
  return { title, bodyHtml: out.join('\n') };
}

function newsletterShell(title: string, subtitle: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef1f5;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:28px 12px;"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:660px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(16,24,40,.1);">
  <tr><td style="background:#0b1f3a;padding:26px 36px;">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;font-weight:700;color:#ffffff;line-height:1.25;">${escapeHtml(title)}</div>
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#9db4d4;margin-top:6px;text-transform:uppercase;letter-spacing:.12em;">${escapeHtml(subtitle)}</div>
  </td></tr>
  <tr><td style="padding:30px 36px 8px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
${bodyHtml}
  </td></tr>
  <tr><td style="padding:16px 36px 28px;border-top:1px solid #eef0f3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#9aa0a6;line-height:1.5;">
    Draft auto-generated and source-verified. Review and edit, then publish to Substack.
  </td></tr>
</table></td></tr></table></body></html>`;
}

/**
 * Weekly Grant Wire draft — renders the synthesized issue as a professional HTML
 * newsletter for review (the plain-text part carries the markdown for Substack).
 */
/** Build the full newsletter email HTML for an issue (exported for previews). */
export function buildWeeklyEmailHtml(markdown: string): { title: string; html: string } {
  const { title, bodyHtml } = renderIssueToNewsletter(markdown);
  return { title, html: newsletterShell(title, 'Source-verified weekly briefing · crypto · AI · OSS', bodyHtml) };
}

export async function sendWeeklyDraftEmail(
  markdown: string,
  meta: { runDate: string; spineCount: number; alsoOpenCount: number },
): Promise<void> {
  const brand = getBrand();
  const { title, html: htmlContent } = buildWeeklyEmailHtml(markdown);
  const textContent = `${title}\n(Draft for review — edit, then publish to Substack. Markdown below.)\n\n${markdown}`;

  await sendWithTracking({
    from: config.email.fromEmail,
    to: config.email.notificationEmail,
    subject: `${brand.name} Weekly — draft ready (${meta.runDate})`,
    html: htmlContent,
    text: textContent,
  });
  console.log(`[Email] Weekly newsletter draft sent to: ${config.email.notificationEmail}`);
}
