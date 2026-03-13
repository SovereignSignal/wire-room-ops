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
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  };
  return `${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Shared email theme — matches WireOps dashboard aesthetic
// ────────────────────────────────────────────────────────────────────────────

const E = {
  bg:        '#0a0a0f',
  card:      '#111118',
  border:    '#1e1e2e',
  cyan:      '#00eaff',
  text:      '#e2e2e8',
  muted:     '#6b6b7b',
  dim:       '#44445a',
  error:     '#ef5350',
  success:   '#4caf50',
  warn:      '#f5a623',
  font:      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

function emailShell(title: string, subtitle: string, bodyHtml: string, maxWidth = 540): string {
  const brand = getBrand();
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${E.bg};font-family:${E.font};">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${E.bg};">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:${maxWidth}px;background-color:${E.card};border:1px solid ${E.border};border-radius:12px;">
          <tr>
            <td style="padding:40px;">
              <!-- Header -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:28px;">
                <tr>
                  <td style="text-align:center;">
                    <p style="margin:0 0 4px;font-size:22px;font-weight:700;letter-spacing:4px;text-transform:uppercase;">
                      <span style="color:${E.text};">WIRE</span><span style="color:${E.cyan};">OPS</span>
                    </p>
                    <p style="margin:0;color:${E.muted};font-size:11px;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(subtitle)}</p>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:28px;">
                <tr><td style="height:1px;background:linear-gradient(to right,transparent,${E.cyan}40,transparent);font-size:0;">&nbsp;</td></tr>
              </table>
              <!-- Body -->
              ${bodyHtml}
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0;color:${E.dim};font-size:11px;letter-spacing:1px;text-transform:uppercase;">${escapeHtml(brand.name)}</p>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

function emailBtn(href: string, label: string, color = E.cyan): string {
  const textColor = color === E.cyan ? E.bg : '#ffffff';
  return `<table role="presentation" cellspacing="0" cellpadding="0" width="100%">
  <tr><td align="center">
    <table role="presentation" cellspacing="0" cellpadding="0">
      <tr>
        <td style="background-color:${color};border-radius:6px;">
          <a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:12px 28px;color:${textColor};font-size:14px;font-weight:600;text-decoration:none;letter-spacing:0.5px;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`;
}

function emailStatBox(rows: string[]): string {
  const rowsHtml = rows.map(r => `<p style="margin:0 0 6px;color:${E.text};font-size:14px;">${r}</p>`).join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${E.bg};border:1px solid ${E.border};border-radius:8px;margin-bottom:24px;">
  <tr><td style="padding:16px 20px;">${rowsHtml}</td></tr>
</table>`;
}

function emailSectionLabel(label: string): string {
  return `<p style="margin:0 0 10px;color:${E.cyan};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;">${escapeHtml(label)}</p>`;
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
    <h2 style="margin:0 0 12px;color:${E.text};font-size:18px;font-weight:600;">Weekly Summaries Ready</h2>
    <p style="margin:0 0 24px;color:${E.muted};font-size:14px;line-height:1.5;">Your summaries for this week are ready for review.</p>
    ${emailSectionLabel('This Week')}
    ${emailStatBox([
      `<strong style="color:${E.cyan};">${stats.totalEntries}</strong> entries processed`,
      `<span style="color:${E.muted};">${stats.xcomEntries} from X.com (via Grok)</span>`,
      `<span style="color:${E.muted};">${stats.otherEntries} from other sources (via Claude)</span>`,
      ...(stats.failedProcessing > 0 ? [`<span style="color:${E.error};">${stats.failedProcessing} entries need manual review</span>`] : []),
    ])}
    ${emailBtn(downloadUrl, 'Download Markdown File')}
    <p style="margin:12px 0 0;color:${E.dim};font-size:12px;text-align:center;">This link requires dashboard authentication.</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:28px;border-top:1px solid ${E.border};">
      <tr><td style="padding-top:20px;text-align:center;"><p style="margin:0;color:${E.dim};font-size:12px;">Week of ${escapeHtml(dateRangeStr)}</p></td></tr>
    </table>`;

  const htmlContent = emailShell('Weekly Summaries Ready', 'Newsletter Automation', body);

  const textContent = `
WIREOPS - Weekly Summaries Ready

Your summaries for this week are ready for review.

THIS WEEK'S STATS
-----------------
${stats.totalEntries} entries processed
- ${stats.xcomEntries} from X.com (via Grok)
- ${stats.otherEntries} from other sources (via Claude)
${stats.failedProcessing > 0 ? `- ${stats.failedProcessing} entries need manual review` : ''}

Download your file:
${downloadUrl}

(This link requires dashboard authentication)

---
Week of ${dateRangeStr}
  `.trim();

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
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const body = `
    <div style="text-align:center;">
      <div style="margin-bottom:20px;font-size:40px;">&#x1F6F0;&#xFE0F;</div>
      <h2 style="margin:0 0 12px;color:${E.success};font-size:18px;font-weight:600;letter-spacing:0.5px;">Signal Confirmed</h2>
      <p style="margin:0 0 24px;color:${E.text};font-size:14px;line-height:1.6;">
        Email alerts are operational. If you received this, your scheduled notifications will work properly.
      </p>
      <p style="margin:0;color:${E.dim};font-size:12px;font-family:monospace;">${escapeHtml(timestamp)}</p>
    </div>`;

  const htmlContent = emailShell('Test Alert', 'System Check', body, 480);

  const textContent = `
WIREOPS - Signal Confirmed

Email alerts are operational. If you received this, your scheduled notifications will work properly.

Sent at: ${timestamp}
  `.trim();

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
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const body = `
    <div style="text-align:center;">
      <div style="margin-bottom:20px;font-size:40px;">&#x26A0;&#xFE0F;</div>
      <h2 style="margin:0 0 12px;color:${E.error};font-size:18px;font-weight:600;letter-spacing:0.5px;">Scheduled Job Failed</h2>
      <p style="margin:0 0 24px;color:${E.text};font-size:14px;line-height:1.6;">
        A scheduled job failed to complete. Check the dashboard or server logs for details.
      </p>
    </div>
    ${emailSectionLabel('Error')}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${E.bg};border:1px solid ${E.error}33;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0;color:${E.text};font-size:13px;font-family:monospace;word-break:break-word;">${escapeHtml(errorMessage)}</p>
      </td></tr>
    </table>
    <p style="margin:0;color:${E.dim};font-size:12px;text-align:center;font-family:monospace;">Job started: ${escapeHtml(timestamp)}</p>`;

  const htmlContent = emailShell('Scheduled Job Failed', 'Alert', body);

  const textContent = `
WIREOPS - Scheduled Job Failed

A scheduled job failed to complete.

ERROR
-----
${errorMessage}

Job started at: ${timestamp}

Check the dashboard or server logs for details.
  `.trim();

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
    <h2 style="margin:0 0 12px;color:${E.text};font-size:18px;font-weight:600;">Fresh Download Link</h2>
    <p style="margin:0 0 6px;color:${E.muted};font-size:13px;">File:</p>
    <p style="margin:0 0 28px;color:${E.cyan};font-size:13px;font-family:monospace;">${escapeHtml(filename)}</p>
    ${emailBtn(downloadUrl, 'Download File')}
    <p style="margin:16px 0 0;color:${E.dim};font-size:12px;text-align:center;">This link expires in 24 hours.</p>`;

  const htmlContent = emailShell('Download Link', 'File Delivery', body, 480);

  const textContent = `
WIREOPS - Fresh Download Link

File: ${filename}

Download: ${downloadUrl}

This link expires in 24 hours.
  `.trim();

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

  // Build top finds rows
  const topFinds = intakeSummary.topFinds.slice(0, 10);
  let topFindsHtml = '';
  let topFindsText = '';

  if (topFinds.length > 0) {
    const rows = topFinds.map(entry => {
      const score = entry.qualityScore ?? 0;
      const scoreColor = score >= 60 ? E.success : score >= 40 ? E.warn : E.error;
      const name = escapeHtml(entry.name);
      const nameCell = entry.sourceUrl
        ? `<a href="${escapeHtml(entry.sourceUrl)}" style="color:${E.cyan};text-decoration:underline;">${name}</a>`
        : name;
      const amount = entry.amount ? escapeHtml(entry.amount) : '\u2014';
      const deadline = entry.deadline ? escapeHtml(entry.deadline) : '\u2014';
      const wire = escapeHtml(entry.wire);

      return `<tr>
        <td style="padding:8px 6px;border-bottom:1px solid ${E.border};text-align:center;">
          <span style="display:inline-block;background-color:${scoreColor};color:${E.bg};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;">${score}</span>
        </td>
        <td style="padding:8px 6px;border-bottom:1px solid ${E.border};color:${E.text};font-size:13px;">${nameCell}</td>
        <td style="padding:8px 6px;border-bottom:1px solid ${E.border};color:${E.muted};font-size:12px;">${amount}</td>
        <td style="padding:8px 6px;border-bottom:1px solid ${E.border};color:${E.muted};font-size:12px;">${deadline}</td>
        <td style="padding:8px 6px;border-bottom:1px solid ${E.border};text-align:center;">
          <span style="display:inline-block;background-color:${E.border};color:${E.muted};padding:2px 6px;border-radius:4px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">${wire}</span>
        </td>
      </tr>`;
    }).join('');

    topFindsHtml = `
      ${emailSectionLabel('Top Finds')}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
        <tr>
          <th style="padding:8px 6px;text-align:center;color:${E.cyan};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid ${E.border};">Score</th>
          <th style="padding:8px 6px;text-align:left;color:${E.cyan};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid ${E.border};">Name</th>
          <th style="padding:8px 6px;text-align:left;color:${E.cyan};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid ${E.border};">Amount</th>
          <th style="padding:8px 6px;text-align:left;color:${E.cyan};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid ${E.border};">Deadline</th>
          <th style="padding:8px 6px;text-align:center;color:${E.cyan};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid ${E.border};">Wire</th>
        </tr>
        ${rows}
      </table>`;

    topFindsText = topFinds.map(e => {
      const score = e.qualityScore ?? 0;
      const amount = e.amount || '-';
      const deadline = e.deadline || '-';
      return `  [${score}] ${e.name} | ${amount} | ${deadline} | ${e.wire}`;
    }).join('\n');
  } else {
    topFindsHtml = `<p style="color:${E.muted};font-size:13px;font-style:italic;">No entries met the quality threshold today.</p>`;
    topFindsText = '  No entries met the quality threshold today.';
  }

  // Build per-prompt summary lines
  const promptLines = perPrompt.map(p => {
    if (p.error) {
      return `<p style="margin:0 0 4px;color:${E.error};font-size:12px;font-family:monospace;">${escapeHtml(p.label)}: FAILED</p>`;
    }
    return `<p style="margin:0 0 4px;color:${E.muted};font-size:12px;font-family:monospace;">${escapeHtml(p.label)}: ${p.resultCount} results (${Math.round(p.durationMs / 1000)}s)</p>`;
  }).join('');

  const promptLinesText = perPrompt.map(p => {
    if (p.error) return `  ${p.label}: FAILED`;
    return `  ${p.label}: ${p.resultCount} results (${Math.round(p.durationMs / 1000)}s)`;
  }).join('\n');

  const failuresHtml = promptsFailed > 0
    ? `<p style="margin:8px 0 0;color:${E.error};font-size:13px;">${promptsFailed} prompt(s) failed</p>`
    : '';

  const reviewUrl = `${dashboardUrl.replace(/\/$/, '')}/queue`;

  const body = `
    <h2 style="margin:0 0 16px;color:${E.text};font-size:18px;font-weight:600;">Scan Results for ${escapeHtml(dateStr)}</h2>
    ${emailSectionLabel('Scan Stats')}
    ${emailStatBox([
      `<strong style="color:${E.cyan};">${totalResults}</strong> results across <strong style="color:${E.cyan};">${promptsExecuted}</strong> prompts`,
      `<span style="color:${E.muted};">${intakeSummary.newUnique} unique finds, ${intakeSummary.duplicatesFound} duplicates filtered</span>`,
      `<span style="color:${E.muted};">${intakeSummary.highQualityCount} high quality (score &ge; 60)</span>`,
      `<span style="color:${E.dim};">Duration: ${durationSec}s</span>`,
      ...(promptsFailed > 0 ? [`<span style="color:${E.error};">${promptsFailed} prompt(s) failed</span>`] : []),
    ])}
    ${topFindsHtml}
    ${emailSectionLabel('Per-Prompt Breakdown')}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${E.bg};border:1px solid ${E.border};border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:14px 20px;">${promptLines}</td></tr>
    </table>
    ${emailBtn(reviewUrl, 'Review Queue')}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:28px;border-top:1px solid ${E.border};">
      <tr><td style="padding-top:20px;text-align:center;">
        <p style="margin:0;color:${E.dim};font-size:11px;">You're receiving this because scan-execution completed. Manage schedules on your dashboard.</p>
      </td></tr>
    </table>`;

  const htmlContent = emailShell('Daily Scan Digest', 'Scan Digest', body, 600);

  const textContent = `
WIREOPS - Daily Scan Digest

Scan Results for ${dateStr}

SCAN STATS
----------
${totalResults} results scanned across ${promptsExecuted} prompts
${intakeSummary.newUnique} unique finds, ${intakeSummary.duplicatesFound} duplicates filtered
${intakeSummary.highQualityCount} high quality (score >= 60)
Duration: ${durationSec}s${promptsFailed > 0 ? `\n${promptsFailed} prompt(s) failed` : ''}

TOP FINDS
---------
${topFindsText}

PER-PROMPT BREAKDOWN
--------------------
${promptLinesText}

Review Queue: ${reviewUrl}

---
You're receiving this because scan-execution completed. Manage schedules on your dashboard.
  `.trim();

  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;
  console.log(`[Email] Sending scan digest to: ${Array.isArray(to) ? to.join(', ') : to}`);

  await sendWithTracking({
    from: config.email.fromEmail,
    to,
    subject: `Daily Scan Digest - ${dateStr} | ${intakeSummary.newUnique} new finds`,
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

export async function sendDailyDigestEmail(
  digest: import('../jobs/daily-digest').DailyDigestResult,
  dashboardUrl: string,
  recipients?: string[],
  topFinds?: TopFindEntry[]
): Promise<void> {
  const brand = getBrand();
  const reviewUrl = `${dashboardUrl.replace(/\/$/, '')}/queue`;

  // Wire breakdown rows
  const wireRows = digest.wires.map(w =>
    `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid ${E.border};font-size:13px;color:${E.text};text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(w.wire)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${E.border};font-size:13px;color:${E.muted};text-align:center;">${w.scansRun}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${E.border};font-size:13px;color:${E.text};text-align:center;">${w.newUnique}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${E.border};font-size:13px;color:${E.muted};text-align:center;">${w.recentlyApproved}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${E.border};font-size:13px;color:${w.pendingReview > 0 ? E.cyan : E.muted};text-align:center;font-weight:${w.pendingReview > 0 ? '700' : '400'};">${w.pendingReview}</td>
    </tr>`
  ).join('');

  const wireText = digest.wires.map(w =>
    `  ${w.wire.padEnd(10)} scans:${w.scansRun}  new:${w.newUnique}  approved:${w.recentlyApproved}  pending:${w.pendingReview}`
  ).join('\n');

  // Top pending finds
  let topFindsHtml = '';
  let topFindsText = '';
  if (topFinds && topFinds.length > 0) {
    const rows = topFinds.slice(0, 5).map(e => {
      const scoreColor = e.quality_score >= 60 ? E.success : e.quality_score >= 40 ? E.warn : E.error;
      const nameCell = e.source_url
        ? `<a href="${escapeHtml(e.source_url)}" style="color:${E.cyan};text-decoration:none;">${escapeHtml(e.name)}</a>`
        : escapeHtml(e.name);
      return `<tr>
        <td style="padding:7px 10px;border-bottom:1px solid ${E.border};font-size:12px;text-align:center;">
          <span style="display:inline-block;background-color:${scoreColor};color:${E.bg};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;">${e.quality_score}</span>
        </td>
        <td style="padding:7px 10px;border-bottom:1px solid ${E.border};font-size:12px;color:${E.text};">${nameCell}</td>
        <td style="padding:7px 10px;border-bottom:1px solid ${E.border};font-size:12px;color:${E.muted};">${e.amount ? escapeHtml(e.amount) : '\u2014'}</td>
        <td style="padding:7px 10px;border-bottom:1px solid ${E.border};font-size:12px;color:${E.muted};">${e.deadline ? escapeHtml(e.deadline) : '\u2014'}</td>
        <td style="padding:7px 10px;border-bottom:1px solid ${E.border};font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:${E.muted};">${escapeHtml(e.wire)}</td>
      </tr>`;
    }).join('');
    topFindsHtml = `
      ${emailSectionLabel('Top Pending')}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
        <tr>
          <th style="padding:8px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${E.cyan};border-bottom:1px solid ${E.border};text-align:center;">Score</th>
          <th style="padding:8px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${E.cyan};border-bottom:1px solid ${E.border};text-align:left;">Name</th>
          <th style="padding:8px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${E.cyan};border-bottom:1px solid ${E.border};text-align:left;">Amount</th>
          <th style="padding:8px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${E.cyan};border-bottom:1px solid ${E.border};text-align:left;">Deadline</th>
          <th style="padding:8px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${E.cyan};border-bottom:1px solid ${E.border};text-align:left;">Wire</th>
        </tr>
        ${rows}
      </table>`;
    topFindsText = '\nTOP PENDING\n-----------\n' + topFinds.slice(0, 5).map(e =>
      `  [${e.quality_score}] ${e.name} | ${e.amount || '\u2014'} | ${e.deadline || '\u2014'} | ${e.wire}`
    ).join('\n');
  }

  const summaryLine = `${digest.totalNewUnique} new finds today. ${digest.totalPendingReview > 0 ? `<strong style="color:${E.cyan};">${digest.totalPendingReview} pending review.</strong>` : 'Queue is clear.'}`;

  const body = `
    <p style="margin:0 0 24px;color:${E.text};font-size:15px;">${summaryLine}</p>
    ${emailSectionLabel('By Wire')}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${E.bg};border:1px solid ${E.border};border-radius:8px;margin-bottom:24px;">
      <tr>
        <th style="padding:8px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${E.cyan};border-bottom:1px solid ${E.border};text-align:left;">Wire</th>
        <th style="padding:8px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${E.cyan};border-bottom:1px solid ${E.border};text-align:center;">Scans</th>
        <th style="padding:8px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${E.cyan};border-bottom:1px solid ${E.border};text-align:center;">New</th>
        <th style="padding:8px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${E.cyan};border-bottom:1px solid ${E.border};text-align:center;">Approved</th>
        <th style="padding:8px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${E.cyan};border-bottom:1px solid ${E.border};text-align:center;">Pending</th>
      </tr>
      ${wireRows}
    </table>
    ${topFindsHtml}
    ${digest.totalPendingReview > 0
      ? emailBtn(reviewUrl, `Review Queue (${digest.totalPendingReview})`)
      : emailBtn(dashboardUrl, 'Open Dashboard', E.border)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:28px;border-top:1px solid ${E.border};">
      <tr><td style="padding-top:20px;text-align:center;">
        <p style="margin:0;color:${E.dim};font-size:11px;">${escapeHtml(brand.name)} \u2014 one digest per day</p>
      </td></tr>
    </table>`;

  const htmlContent = emailShell(`Daily Digest \u2014 ${digest.date}`, 'Daily Digest', body, 600);

  const textContent = `WIREOPS - Daily Digest ${digest.date}

${digest.totalNewUnique} new finds. ${digest.totalPendingReview > 0 ? `${digest.totalPendingReview} pending review.` : 'Queue is clear.'}

BY WIRE
-------
${wireText}
${topFindsText}
${digest.totalPendingReview > 0 ? `\nReview: ${reviewUrl}` : `\nDashboard: ${dashboardUrl}`}

---
${brand.name} | ${brand.url}`;

  const pendingLabel = digest.totalPendingReview > 0 ? ` | ${digest.totalPendingReview} pending` : '';
  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;

  await sendWithTracking({
    from: `${brand.fromName} <${config.email.fromEmail}>`,
    to,
    subject: `${brand.name} Digest \u2014 ${digest.date} | ${digest.totalNewUnique} new${pendingLabel}`,
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Daily digest sent to: ${Array.isArray(to) ? to.join(', ') : to}`);
}
