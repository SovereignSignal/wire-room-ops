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

export async function sendNotificationEmail(
  downloadUrl: string,
  stats: ProcessingStats,
  dateRange: { start: Date; end: Date }
): Promise<void> {
  const dateRangeStr = formatDateRange(dateRange.start, dateRange.end);

  const body = `
    <p style="margin:0 0 16px;font-size:15px;color:#222;">Weekly Summaries Ready</p>
    <p style="margin:0 0 4px;font-size:13px;color:#444;"><strong>${stats.totalEntries}</strong> entries processed</p>
    <p style="margin:0 0 4px;font-size:13px;color:#666;">${stats.xcomEntries} from X.com &middot; ${stats.otherEntries} from other sources</p>
    ${stats.failedProcessing > 0 ? `<p style="margin:0 0 4px;font-size:13px;color:#cc0000;">${stats.failedProcessing} entries need manual review</p>` : ''}
    ${emailBtn(downloadUrl, 'Download Markdown File')}
    <p style="margin:0;color:#999;font-size:12px;">Week of ${escapeHtml(dateRangeStr)}</p>`;

  const htmlContent = emailShell('Weekly Summaries Ready', body);

  const textContent = `WIREOPS - Weekly Summaries Ready

${stats.totalEntries} entries processed
- ${stats.xcomEntries} from X.com
- ${stats.otherEntries} from other sources
${stats.failedProcessing > 0 ? `- ${stats.failedProcessing} need manual review` : ''}

Download: ${downloadUrl}

Week of ${dateRangeStr}`.trim();

  await sendWithTracking({
    from: config.email.fromEmail,
    to: config.email.notificationEmail,
    subject: `Weekly Summaries Ready - ${dateRangeStr}`,
    html: htmlContent,
    text: textContent,
  });
}

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

export async function sendDailyDigestEmail(
  digest: import('../jobs/daily-digest').DailyDigestResult,
  dashboardUrl: string,
  recipients?: string[],
  topFinds?: TopFindEntry[],
  csvExport?: import('../jobs/csv-export').CsvExportResult,
  downloadUrls?: { csv: string | null; md: string | null },
  experimentStatus?: { name: string; entriesScored: number; approvalRate: number; status: string } | null,
  agentBrief?: StoredAgentBrief | null,
  sourceBreakdown?: import('../jobs/daily-digest').SourceBreakdownRow[],
  costRecap?: { rows: import('../jobs/daily-digest').CostRow[]; total: number }
): Promise<void> {
  const brand = getBrand();
  const reviewUrl = `${dashboardUrl.replace(/\/$/, '')}/queue`;

  // Wire breakdown
  const wireRows = digest.wires.map(w =>
    `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;color:#222;text-transform:uppercase;">${escapeHtml(w.wire)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;color:#666;text-align:center;">${w.scansRun}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;color:#222;text-align:center;font-weight:600;">${w.newUnique}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;color:#666;text-align:center;">${w.recentlyApproved}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;color:${w.pendingReview > 0 ? '#0088cc' : '#999'};text-align:center;font-weight:${w.pendingReview > 0 ? '700' : '400'};">${w.pendingReview}</td>
    </tr>`
  ).join('');

  const wireText = digest.wires.map(w =>
    `  ${w.wire.padEnd(10)} scans:${w.scansRun}  new:${w.newUnique}  approved:${w.recentlyApproved}  pending:${w.pendingReview}`
  ).join('\n');

  // Autoresearch experiment status section
  let experimentHtml = '';
  let experimentText = '';
  if (experimentStatus !== undefined) {
    if (experimentStatus === null) {
      experimentHtml = `
      ${sectionLabel('Autoresearch')}
      <p style="margin:0 0 16px;font-size:12px;color:#999;">No active experiment</p>`;
      experimentText = '\nAUTORESEARCH\nNo active experiment\n';
    } else {
      const approvalPct = Math.round(experimentStatus.approvalRate);
      const expLine = `\u{1F9EA} ${escapeHtml(experimentStatus.name)} | ${experimentStatus.entriesScored} entries scored | ${approvalPct}% approval | ${escapeHtml(experimentStatus.status)}`;
      experimentHtml = `
      ${sectionLabel('Autoresearch')}
      <p style="margin:0 0 16px;font-size:12px;color:#555;${MONO}">${expLine}</p>`;
      experimentText = `\nAUTORESEARCH\n\u{1F9EA} ${experimentStatus.name} | ${experimentStatus.entriesScored} entries scored | ${approvalPct}% approval | ${experimentStatus.status}\n`;
    }
  }

  // Agent scan brief (recorded by the daily-grant-scan agent)
  let agentBriefHtml = '';
  let agentBriefText = '';
  if (agentBrief && agentBrief.runs && agentBrief.runs.length > 0) {
    const runLines = agentBrief.runs.map(run => {
      const submitted = (run.entries || []).map(e =>
        `<li style="font-size:12px;color:#222;margin:2px 0;">${e.sourceUrl ? `<a href="${escapeHtml(e.sourceUrl)}" style="color:#0088cc;text-decoration:none;">${escapeHtml(e.name)}</a>` : escapeHtml(e.name)} <span style="color:#888;">(${escapeHtml(e.wire)})</span></li>`
      ).join('');
      return `<p style="margin:0 0 4px;font-size:12px;color:#555;">${run.searchesDone ?? 0} searches &middot; ${run.totalFound ?? 0} found &middot; ${(run.entries || []).length} submitted &middot; ${run.skippedDuplicates ?? 0} duplicates skipped</p>${submitted ? `<ul style="margin:0 0 8px;padding-left:18px;">${submitted}</ul>` : '<p style="margin:0 0 8px;font-size:12px;color:#999;">Nothing new submitted — quiet window.</p>'}`;
    }).join('');
    agentBriefHtml = `
      ${sectionLabel('Agent Scan')}
      ${runLines}`;
    agentBriefText = '\nAGENT SCAN\n' + agentBrief.runs.map(run =>
      `  ${run.searchesDone ?? 0} searches | ${run.totalFound ?? 0} found | ${(run.entries || []).length} submitted | ${run.skippedDuplicates ?? 0} dupes skipped` +
      (run.entries || []).map(e => `\n    - [${e.wire}] ${e.name}`).join('')
    ).join('\n') + '\n';
  } else if (agentBrief !== undefined) {
    agentBriefHtml = `
      ${sectionLabel('Agent Scan')}
      <p style="margin:0 0 16px;font-size:12px;color:#999;">No agent scan brief received today</p>`;
    agentBriefText = '\nAGENT SCAN\nNo agent scan brief received today\n';
  }

  // Intake by source (last 24h)
  let sourceHtml = '';
  let sourceText = '';
  if (sourceBreakdown && sourceBreakdown.length > 0) {
    const srcRows = sourceBreakdown.map(s =>
      `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#222;text-transform:uppercase;">${escapeHtml(s.wire)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666;">${escapeHtml(s.source)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#222;text-align:center;">${s.total}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#0088cc;text-align:center;font-weight:${s.queued > 0 ? '700' : '400'};">${s.queued}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666;text-align:center;">${s.approved}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#999;text-align:center;">${s.duplicates}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#999;text-align:center;">${s.parked}</td>
      </tr>`
    ).join('');
    sourceHtml = `
      ${sectionLabel('Intake by Source (24h)')}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:16px;">
        <tr>
          <th style="padding:4px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:left;">Wire</th>
          <th style="padding:4px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:left;">Source</th>
          <th style="padding:4px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:center;">In</th>
          <th style="padding:4px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:center;">Queued</th>
          <th style="padding:4px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:center;">Approved</th>
          <th style="padding:4px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:center;">Dupes</th>
          <th style="padding:4px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:center;">Parked</th>
        </tr>
        ${srcRows}
      </table>`;
    sourceText = '\nINTAKE BY SOURCE (24H)\n' + sourceBreakdown.map(s =>
      `  ${s.wire.padEnd(8)} ${s.source.padEnd(14)} in:${s.total} queued:${s.queued} approved:${s.approved} dupes:${s.duplicates} parked:${s.parked}`
    ).join('\n') + '\n';
  }

  // API cost recap (per-cost tools, last 24h)
  let costHtml = '';
  let costText = '';
  if (costRecap && costRecap.rows.length > 0) {
    const costRows = costRecap.rows.map(c =>
      `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#222;">${escapeHtml(c.provider)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666;text-align:center;">${c.calls}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#222;text-align:right;font-weight:600;">$${c.cost_usd.toFixed(4)}</td>
      </tr>`
    ).join('');
    costHtml = `
      ${sectionLabel('API Costs (24h)')}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:8px;">
        <tr>
          <th style="padding:4px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:left;">Provider</th>
          <th style="padding:4px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:center;">Calls</th>
          <th style="padding:4px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:right;">Cost</th>
        </tr>
        ${costRows}
        <tr>
          <td style="padding:6px 8px;font-size:12px;color:#222;font-weight:700;">Total</td>
          <td></td>
          <td style="padding:6px 8px;font-size:13px;color:#0088cc;text-align:right;font-weight:700;">$${costRecap.total.toFixed(4)}</td>
        </tr>
      </table>
      <p style="margin:0 0 16px;color:#999;font-size:10px;">X (twitter) & Parallel approximated from per-request rates; full token costs for LLM providers.</p>`;
    costText = '\nAPI COSTS (24H)\n' + costRecap.rows.map(c =>
      `  ${c.provider.padEnd(12)} ${String(c.calls).padStart(4)} calls   $${c.cost_usd.toFixed(4)}`
    ).join('\n') + `\n  ${'TOTAL'.padEnd(12)}        $${costRecap.total.toFixed(4)}\n`;
  }

  // Top pending
  let topFindsHtml = '';
  let topFindsText = '';
  if (topFinds && topFinds.length > 0) {
    const rows = topFinds.slice(0, 10).map(e => {
      const nameCell = e.source_url
        ? `<a href="${escapeHtml(e.source_url)}" style="color:#0088cc;text-decoration:none;">${escapeHtml(e.name)}</a>`
        : escapeHtml(e.name);
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#444;text-align:center;${MONO}">${e.quality_score}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#222;">${nameCell}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666;">${e.amount ? escapeHtml(e.amount) : '\u2014'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666;text-transform:uppercase;">${escapeHtml(e.wire)}</td>
      </tr>`;
    }).join('');
    topFindsHtml = `
      ${sectionLabel('Top Pending')}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:16px;">
        <tr>
          <th style="padding:6px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:center;">Score</th>
          <th style="padding:6px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:left;">Name</th>
          <th style="padding:6px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:left;">Amount</th>
          <th style="padding:6px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:left;">Wire</th>
        </tr>
        ${rows}
      </table>`;
    topFindsText = '\nTOP PENDING\n' + topFinds.slice(0, 10).map(e =>
      `  [${e.quality_score}] ${e.name} | ${e.amount || '\u2014'} | ${e.wire}`
    ).join('\n');
  }

  // Approved entries section (from CSV export)
  let approvedEntriesHtml = '';
  let approvedEntriesText = '';
  if (csvExport && csvExport.entryCount > 0) {
    const buttons = [
      downloadUrls?.csv ? emailBtn(downloadUrls.csv, 'Download CSV') : '',
      downloadUrls?.md ? emailBtn(downloadUrls.md, 'Download Markdown') : '',
    ].filter(Boolean).join('');
    approvedEntriesHtml = `
      ${sectionLabel('Approved Entries')}
      ${csvExport.htmlTable}
      ${buttons}
      <p style="margin:0 0 16px;color:#999;font-size:11px;">Use this data as input for newsletter composition.</p>`;
    approvedEntriesText = `\nAPPROVED ENTRIES (${csvExport.entryCount})\n` +
      (downloadUrls?.csv ? `Download CSV: ${downloadUrls.csv}\n` : '') +
      (downloadUrls?.md ? `Download Markdown: ${downloadUrls.md}\n` : '');
  }

  const summaryLine = `<strong>${digest.totalNewUnique}</strong> new finds today. ${digest.totalPendingReview > 0 ? `<strong style="color:#0088cc;">${digest.totalPendingReview} pending review.</strong>` : 'Queue is clear.'}`;

  const body = `
    <p style="margin:0 0 20px;font-size:14px;color:#222;">${summaryLine}</p>
    ${agentBriefHtml}
    ${experimentHtml}
    ${sectionLabel('By Wire')}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:20px;">
      <tr>
        <th style="padding:6px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:left;">Wire</th>
        <th style="padding:6px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:center;">Scans</th>
        <th style="padding:6px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:center;">New</th>
        <th style="padding:6px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:center;">Approved</th>
        <th style="padding:6px 8px;font-size:10px;font-weight:600;color:#888;border-bottom:1px solid #ddd;text-transform:uppercase;text-align:center;">Pending</th>
      </tr>
      ${wireRows}
    </table>
    ${sourceHtml}
    ${costHtml}
    ${topFindsHtml}
    ${approvedEntriesHtml}
    ${digest.totalPendingReview > 0
      ? emailBtn(reviewUrl, `Review Queue (${digest.totalPendingReview})`)
      : emailBtn(dashboardUrl, 'Open Dashboard')}`;

  const htmlContent = emailShell(`WireOps \u2014 ${digest.date}`, body);

  const textContent = `WIREOPS - ${digest.date}

${digest.totalNewUnique} new finds. ${digest.totalPendingReview > 0 ? `${digest.totalPendingReview} pending review.` : 'Queue is clear.'}
${agentBriefText}${experimentText}
BY WIRE
${wireText}
${sourceText}${costText}${topFindsText}
${approvedEntriesText}
${digest.totalPendingReview > 0 ? `\nReview: ${reviewUrl}` : `\nDashboard: ${dashboardUrl}`}

---
${brand.name}`.trim();

  const approvedCount = csvExport?.entryCount ?? 0;
  const approvedLabel = approvedCount > 0 ? ` | ${approvedCount} approved` : '';
  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;

  await sendWithTracking({
    from: `${brand.fromName} <${config.email.fromEmail}>`,
    to,
    subject: `WireOps \u2014 ${digest.date} | ${digest.totalNewUnique} new${approvedLabel}`,
    html: htmlContent,
    text: textContent,
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

export interface AgentBriefEntry {
  name: string;
  wire: string;
  score: number;
  sourceUrl: string;
  action: 'approved' | 'archived' | 'queued';
}

export async function sendAgentBriefEmail(brief: {
  date: string;
  entries: AgentBriefEntry[];
  searchesDone: number;
  totalFound: number;
  skippedDuplicates: number;
}, recipients?: string[]): Promise<void> {
  const brand = getBrand();
  const approved = brief.entries.filter(e => e.action === 'approved');
  const queued = brief.entries.filter(e => e.action === 'queued');
  const archived = brief.entries.filter(e => e.action === 'archived');
  const dashboardUrl = config.app.url;

  function entryRow(e: AgentBriefEntry): string {
    const name = e.sourceUrl
      ? `<a href="${escapeHtml(e.sourceUrl)}" style="color:#0088cc;text-decoration:none;">${escapeHtml(e.name)}</a>`
      : escapeHtml(e.name);
    return `<tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#222;">${name}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666;">${escapeHtml(e.wire)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#444;text-align:center;${MONO}">${e.score}</td>
    </tr>`;
  }

  function entryTable(entries: AgentBriefEntry[]): string {
    if (entries.length === 0) return '<p style="margin:4px 0;font-size:12px;color:#999;">None</p>';
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #eee;">
      <tr>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:#666;border-bottom:2px solid #ddd;">Name</th>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:#666;border-bottom:2px solid #ddd;">Wire</th>
        <th style="padding:6px 8px;text-align:center;font-size:11px;color:#666;border-bottom:2px solid #ddd;">Score</th>
      </tr>
      ${entries.map(entryRow).join('')}
    </table>`;
  }

  const body = `
    <p style="margin:0 0 16px;font-size:14px;color:#222;">
      <strong>${brief.totalFound}</strong> found &middot;
      <strong>${approved.length}</strong> auto-approved &middot;
      <strong>${queued.length}</strong> need your review &middot;
      <strong>${archived.length}</strong> auto-archived &middot;
      <strong>${brief.skippedDuplicates}</strong> duplicates skipped
    </p>
    ${queued.length > 0 ? `${sectionLabel('Needs your review')}${entryTable(queued)}${emailBtn(dashboardUrl, 'Review in Dashboard')}` : ''}
    ${approved.length > 0 ? `${sectionLabel('Auto-approved')}${entryTable(approved)}` : ''}
    ${archived.length > 0 ? `${sectionLabel('Auto-archived')}${entryTable(archived)}` : ''}
    <p style="margin:16px 0 0;color:#999;font-size:11px;">${brief.searchesDone} searches executed</p>`;

  const htmlContent = emailShell(`Agent Scan Brief \u2014 ${brief.date}`, body);

  const textContent = `WIREOPS AGENT BRIEF — ${brief.date}

${brief.totalFound} found | ${approved.length} auto-approved | ${queued.length} need review | ${archived.length} auto-archived | ${brief.skippedDuplicates} duplicates

${queued.length > 0 ? 'NEEDS YOUR REVIEW:\n' + queued.map(e => `  - [${e.wire}] ${e.name} (score: ${e.score})`).join('\n') + '\n' : ''}
${approved.length > 0 ? 'AUTO-APPROVED:\n' + approved.map(e => `  - [${e.wire}] ${e.name} (score: ${e.score})`).join('\n') + '\n' : ''}
Review: ${dashboardUrl}

---
${brand.name}`.trim();

  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;

  await sendWithTracking({
    from: `${brand.fromName} <${config.email.fromEmail}>`,
    to,
    subject: `WireOps Agent \u2014 ${brief.date} | ${brief.totalFound} found, ${queued.length} need review`,
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Agent brief sent to: ${Array.isArray(to) ? to.join(', ') : to}`);
}

/**
 * Weekly Grant Wire draft — emails the synthesized issue (markdown) for review.
 * The markdown is sent verbatim in a copyable block so the operator can paste it
 * straight into Substack after editing.
 */
export async function sendWeeklyDraftEmail(
  markdown: string,
  meta: { runDate: string; spineCount: number; alsoOpenCount: number },
): Promise<void> {
  const brand = getBrand();
  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:#222;"><strong>Weekly draft ready for review</strong></p>
    <p style="margin:0 0 16px;font-size:13px;color:#666;">${meta.spineCount} published this week &middot; ${meta.alsoOpenCount} also-open &middot; review, edit, then post to Substack.</p>
    <pre style="white-space:pre-wrap;word-wrap:break-word;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.5;color:#111;background:#f6f6f6;border:1px solid #e2e2e2;border-radius:6px;padding:14px;">${escapeHtml(markdown)}</pre>
    <p style="margin:14px 0 0;color:#999;font-size:12px;">${escapeHtml(brand.name)} &middot; week of ${escapeHtml(meta.runDate)}</p>`;
  const htmlContent = emailShell('Weekly Grant Wire Draft', body);
  const textContent = `${brand.name} - Weekly Grant Wire Draft (${meta.runDate})\n${meta.spineCount} published this week, ${meta.alsoOpenCount} also-open. Review, edit, post to Substack.\n\n----------\n\n${markdown}`;

  await sendWithTracking({
    from: config.email.fromEmail,
    to: config.email.notificationEmail,
    subject: `${brand.name} Weekly — draft ready (${meta.runDate})`,
    html: htmlContent,
    text: textContent,
  });
  console.log(`[Email] Weekly draft sent to: ${config.email.notificationEmail}`);
}
