import { Resend } from 'resend';
import { config } from '../config';
import { ProcessingStats } from '../types';
import { escapeHtml } from '../utils/html';
import type { ScanExecutionResult } from '../jobs/scan-execution';

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    resend = new Resend(config.email.resendApiKey);
  }
  return resend;
}

function formatDateRange(start: Date, end: Date): string {
  const options: Intl.DateTimeFormatOptions = { 
    month: 'short', 
    day: 'numeric',
    year: 'numeric'
  };
  return `${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`;
}

export async function sendNotificationEmail(
  downloadUrl: string,
  stats: ProcessingStats,
  dateRange: { start: Date; end: Date }
): Promise<void> {
  const client = getResend();
  const dateRangeStr = formatDateRange(dateRange.start, dateRange.end);

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly Summaries Ready - The Wire Room</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0d0d0d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px;">
          <tr>
            <td style="padding: 40px;">
              <!-- Logo -->
              <h1 style="margin: 0 0 8px; font-size: 24px; font-weight: 700; text-align: center;">
                <span style="color: #ffffff;">The</span> <span style="color: #f5a623;">Wire</span> <span style="color: #ffffff;">Room</span>
              </h1>
              <p style="margin: 0 0 24px; color: #999999; font-size: 14px; text-align: center;">Newsletter Automation</p>

              <!-- Header -->
              <h2 style="margin: 0 0 16px; color: #ffffff; font-size: 20px; font-weight: 600;">
                Weekly Summaries Ready
              </h2>
              <p style="margin: 0 0 24px; color: #cccccc; font-size: 15px; line-height: 1.5;">
                Your Wire Room summaries for this week are ready for review.
              </p>

              <!-- Stats Box -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d; border: 1px solid #2a2a2a; border-radius: 12px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 12px; color: #f5a623; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                      This Week's Stats
                    </p>
                    <p style="margin: 0 0 8px; color: #ffffff; font-size: 15px;">
                      <strong style="color: #f5a623;">${stats.totalEntries}</strong> entries processed
                    </p>
                    <p style="margin: 0 0 8px; color: #999999; font-size: 14px;">
                      ${stats.xcomEntries} from X.com (via Grok)
                    </p>
                    <p style="margin: 0; color: #999999; font-size: 14px;">
                      ${stats.otherEntries} from other sources (via Claude)
                    </p>
                    ${stats.failedProcessing > 0 ? `
                    <p style="margin: 8px 0 0; color: #ef5350; font-size: 14px;">
                      ${stats.failedProcessing} entries need manual review
                    </p>
                    ` : ''}
                  </td>
                </tr>
              </table>

              <!-- Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" width="100%">
                <tr>
                  <td align="center">
                    <table role="presentation" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="background-color: #f5a623; border-radius: 8px;">
                          <a href="${escapeHtml(downloadUrl)}" target="_blank" style="display: inline-block; padding: 14px 28px; color: #0d0d0d; font-size: 15px; font-weight: 600; text-decoration: none;">
                            Download Markdown File
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin: 16px 0 0; color: #666666; font-size: 13px; text-align: center;">
                This link requires dashboard authentication.
              </p>

              <!-- Footer -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px; border-top: 1px solid #2a2a2a;">
                <tr>
                  <td style="padding-top: 24px; text-align: center;">
                    <p style="margin: 0; color: #666666; font-size: 13px;">
                      Week of ${dateRangeStr}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Bottom text -->
        <p style="margin: 24px 0 0; color: #666666; font-size: 12px;">
          The Wire Room
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `
The Wire Room - Weekly Summaries Ready

Your Wire Room summaries for this week are ready for review.

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
The Wire Room
  `.trim();

  await client.emails.send({
    from: config.email.fromEmail,
    to: config.email.notificationEmail,
    subject: `Weekly Summaries Ready - ${dateRangeStr}`,
    html: htmlContent,
    text: textContent,
  });
}

export async function sendTestAlertEmail(): Promise<void> {
  const client = getResend();
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

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Alert - The Wire Room</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0d0d0d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 480px; background-color: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px;">
          <tr>
            <td style="padding: 48px 40px; text-align: center;">
              <!-- Logo -->
              <h1 style="margin: 0 0 8px; font-size: 28px; font-weight: 700;">
                <span style="color: #ffffff;">The</span> <span style="color: #f5a623;">Wire</span> <span style="color: #ffffff;">Room</span>
              </h1>
              <p style="margin: 0 0 32px; color: #999999; font-size: 16px;">Test Alert</p>

              <!-- Success Icon -->
              <div style="margin-bottom: 24px; font-size: 48px;">✅</div>

              <!-- Message -->
              <h2 style="margin: 0 0 16px; color: #4caf50; font-size: 20px; font-weight: 600;">
                Email Alerts Are Working!
              </h2>
              <p style="margin: 0 0 24px; color: #cccccc; font-size: 15px; line-height: 1.6;">
                This is a test alert to verify that your email notifications are configured correctly.
                If you received this email, your scheduled alerts will work properly.
              </p>

              <!-- Timestamp -->
              <p style="margin: 0; color: #666666; font-size: 13px;">
                Sent at: ${timestamp}
              </p>
            </td>
          </tr>
        </table>

        <!-- Bottom text -->
        <p style="margin: 24px 0 0; color: #666666; font-size: 12px;">
          The Wire Room
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `
The Wire Room - Test Alert

Email Alerts Are Working!

This is a test alert to verify that your email notifications are configured correctly.
If you received this email, your scheduled alerts will work properly.

Sent at: ${timestamp}

---
The Wire Room
  `.trim();

  console.log(`[Email] Sending test alert to: ${config.email.notificationEmail}`);

  await client.emails.send({
    from: config.email.fromEmail,
    to: config.email.notificationEmail,
    subject: 'Test Alert - The Wire Room',
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Test alert sent successfully`);
}

export async function sendScheduledJobFailureEmail(errorMessage: string, jobStartTime: Date, recipients?: string[]): Promise<void> {
  const client = getResend();
  const timestamp = jobStartTime.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scheduled Job Failed - The Wire Room</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0d0d0d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px;">
          <tr>
            <td style="padding: 48px 40px; text-align: center;">
              <!-- Logo -->
              <h1 style="margin: 0 0 8px; font-size: 28px; font-weight: 700;">
                <span style="color: #ffffff;">The</span> <span style="color: #f5a623;">Wire</span> <span style="color: #ffffff;">Room</span>
              </h1>
              <p style="margin: 0 0 32px; color: #999999; font-size: 16px;">Scheduled Job Alert</p>

              <!-- Error Icon -->
              <div style="margin-bottom: 24px; font-size: 48px;">⚠️</div>

              <!-- Message -->
              <h2 style="margin: 0 0 16px; color: #ef5350; font-size: 20px; font-weight: 600;">
                Scheduled Job Failed
              </h2>
              <p style="margin: 0 0 24px; color: #cccccc; font-size: 15px; line-height: 1.6;">
                The scheduled weekly summary job failed to complete. Please check the dashboard or server logs for more details.
              </p>

              <!-- Error Details Box -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d; border: 1px solid rgba(239, 83, 80, 0.3); border-radius: 12px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 8px; color: #ef5350; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                      Error Message
                    </p>
                    <p style="margin: 0; color: #ffffff; font-size: 14px; font-family: monospace; word-break: break-word;">
                      ${escapeHtml(errorMessage)}
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Timestamp -->
              <p style="margin: 0; color: #666666; font-size: 13px;">
                Job started at: ${timestamp}
              </p>
            </td>
          </tr>
        </table>

        <!-- Bottom text -->
        <p style="margin: 24px 0 0; color: #666666; font-size: 12px;">
          The Wire Room
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `
The Wire Room - Scheduled Job Failed

The scheduled weekly summary job failed to complete.

ERROR MESSAGE
-------------
${errorMessage}

Job started at: ${timestamp}

Please check the dashboard or server logs for more details.

---
The Wire Room
  `.trim();

  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;
  console.log(`[Email] Sending scheduled job failure notification to: ${Array.isArray(to) ? to.join(', ') : to}`);

  await client.emails.send({
    from: config.email.fromEmail,
    to,
    subject: 'Wire Room Ops - Scheduled Job Failed',
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Scheduled job failure notification sent successfully`);
}

export async function sendResendLinkEmail(email: string, downloadUrl: string, filename: string): Promise<void> {
  const client = getResend();

  console.log(`[Email] Sending resend link email to: ${email}`);

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Download Link - The Wire Room</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0d0d0d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px;">
          <tr>
            <td style="padding: 48px 40px; text-align: center;">
              <h1 style="margin: 0 0 8px; font-size: 28px; font-weight: 700;">
                <span style="color: #ffffff;">The</span> <span style="color: #f5a623;">Wire</span> <span style="color: #ffffff;">Room</span>
              </h1>
              <p style="margin: 0 0 32px; color: #999999; font-size: 16px;">Fresh Download Link</p>

              <h2 style="margin: 0 0 16px; color: #ffffff; font-size: 20px; font-weight: 600;">
                Your new download link is ready
              </h2>
              <p style="margin: 0 0 8px; color: #999999; font-size: 14px;">File:</p>
              <p style="margin: 0 0 32px; color: #f5a623; font-size: 14px; font-family: monospace;">${escapeHtml(filename)}</p>

              <a href="${escapeHtml(downloadUrl)}" style="display: inline-block; background-color: #f5a623; color: #0d0d0d; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600;">
                Download File
              </a>

              <p style="margin: 32px 0 0; color: #666666; font-size: 12px;">
                This link expires in 24 hours.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `
The Wire Room - Fresh Download Link

Your new download link is ready.

File: ${filename}

Download: ${downloadUrl}

This link expires in 24 hours.
  `.trim();

  await client.emails.send({
    from: config.email.fromEmail,
    to: email,
    subject: 'The Wire Room - Fresh Download Link',
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
  const client = getResend();
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
      const scoreColor = score >= 60 ? '#4caf50' : score >= 40 ? '#f5a623' : '#ef5350';
      const name = escapeHtml(entry.name);
      const nameCell = entry.sourceUrl
        ? `<a href="${escapeHtml(entry.sourceUrl)}" style="color: #ffffff; text-decoration: underline;">${name}</a>`
        : name;
      const amount = entry.amount ? escapeHtml(entry.amount) : '\u2014';
      const deadline = entry.deadline ? escapeHtml(entry.deadline) : '\u2014';
      const wire = escapeHtml(entry.wire);

      return `<tr>
        <td style="padding: 8px 6px; border-bottom: 1px solid #2a2a2a; text-align: center;">
          <span style="display: inline-block; background-color: ${scoreColor}; color: #0d0d0d; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 700;">${score}</span>
        </td>
        <td style="padding: 8px 6px; border-bottom: 1px solid #2a2a2a; color: #ffffff; font-size: 14px;">${nameCell}</td>
        <td style="padding: 8px 6px; border-bottom: 1px solid #2a2a2a; color: #cccccc; font-size: 13px;">${amount}</td>
        <td style="padding: 8px 6px; border-bottom: 1px solid #2a2a2a; color: #cccccc; font-size: 13px;">${deadline}</td>
        <td style="padding: 8px 6px; border-bottom: 1px solid #2a2a2a; text-align: center;">
          <span style="display: inline-block; background-color: #2a2a2a; color: #999999; padding: 2px 6px; border-radius: 4px; font-size: 11px;">${wire}</span>
        </td>
      </tr>`;
    }).join('');

    topFindsHtml = `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
        <tr>
          <th style="padding: 8px 6px; text-align: center; color: #f5a623; font-size: 12px; font-weight: 600; text-transform: uppercase; border-bottom: 2px solid #2a2a2a;">Score</th>
          <th style="padding: 8px 6px; text-align: left; color: #f5a623; font-size: 12px; font-weight: 600; text-transform: uppercase; border-bottom: 2px solid #2a2a2a;">Name</th>
          <th style="padding: 8px 6px; text-align: left; color: #f5a623; font-size: 12px; font-weight: 600; text-transform: uppercase; border-bottom: 2px solid #2a2a2a;">Amount</th>
          <th style="padding: 8px 6px; text-align: left; color: #f5a623; font-size: 12px; font-weight: 600; text-transform: uppercase; border-bottom: 2px solid #2a2a2a;">Deadline</th>
          <th style="padding: 8px 6px; text-align: center; color: #f5a623; font-size: 12px; font-weight: 600; text-transform: uppercase; border-bottom: 2px solid #2a2a2a;">Wire</th>
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
    topFindsHtml = '<p style="color: #999999; font-size: 14px; font-style: italic;">No entries met the quality threshold today.</p>';
    topFindsText = '  No entries met the quality threshold today.';
  }

  // Build per-prompt summary lines
  const promptLines = perPrompt.map(p => {
    if (p.error) {
      return `<p style="margin: 0 0 4px; color: #ef5350; font-size: 13px;">${escapeHtml(p.label)}: FAILED</p>`;
    }
    return `<p style="margin: 0 0 4px; color: #cccccc; font-size: 13px;">${escapeHtml(p.label)}: ${p.resultCount} results (${Math.round(p.durationMs / 1000)}s)</p>`;
  }).join('');

  const promptLinesText = perPrompt.map(p => {
    if (p.error) return `  ${p.label}: FAILED`;
    return `  ${p.label}: ${p.resultCount} results (${Math.round(p.durationMs / 1000)}s)`;
  }).join('\n');

  // Failures line (optional)
  const failuresHtml = promptsFailed > 0
    ? `<p style="margin: 8px 0 0; color: #ef5350; font-size: 14px;">${promptsFailed} prompt(s) failed</p>`
    : '';

  const reviewUrl = `${dashboardUrl.replace(/\/$/, '')}/queue`;

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Scan Digest - The Wire Room</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0d0d0d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px;">
          <tr>
            <td style="padding: 40px;">
              <!-- Logo -->
              <h1 style="margin: 0 0 8px; font-size: 24px; font-weight: 700; text-align: center;">
                <span style="color: #ffffff;">The</span> <span style="color: #f5a623;">Wire</span> <span style="color: #ffffff;">Room</span>
              </h1>
              <p style="margin: 0 0 24px; color: #999999; font-size: 14px; text-align: center;">Daily Scan Digest</p>

              <!-- Header -->
              <h2 style="margin: 0 0 16px; color: #ffffff; font-size: 20px; font-weight: 600;">
                Scan Results for ${dateStr}
              </h2>

              <!-- Stats Box -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d; border: 1px solid #2a2a2a; border-radius: 12px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 12px; color: #f5a623; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                      Scan Stats
                    </p>
                    <p style="margin: 0 0 8px; color: #ffffff; font-size: 15px;">
                      <strong style="color: #f5a623;">${totalResults}</strong> results scanned across <strong style="color: #f5a623;">${promptsExecuted}</strong> prompts
                    </p>
                    <p style="margin: 0 0 8px; color: #999999; font-size: 14px;">
                      ${intakeSummary.newUnique} unique finds, ${intakeSummary.duplicatesFound} duplicates filtered
                    </p>
                    <p style="margin: 0 0 8px; color: #999999; font-size: 14px;">
                      ${intakeSummary.highQualityCount} high quality (score &ge; 60)
                    </p>
                    <p style="margin: 0; color: #999999; font-size: 14px;">
                      Duration: ${durationSec}s
                    </p>
                    ${failuresHtml}
                  </td>
                </tr>
              </table>

              <!-- Top Finds -->
              <p style="margin: 0 0 12px; color: #f5a623; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                Top Finds
              </p>
              ${topFindsHtml}

              <!-- Per-Prompt Summary -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d; border: 1px solid #2a2a2a; border-radius: 12px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <p style="margin: 0 0 8px; color: #f5a623; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                      Per-Prompt Breakdown
                    </p>
                    ${promptLines}
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" width="100%">
                <tr>
                  <td align="center">
                    <table role="presentation" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="background-color: #f5a623; border-radius: 8px;">
                          <a href="${escapeHtml(reviewUrl)}" target="_blank" style="display: inline-block; padding: 14px 28px; color: #0d0d0d; font-size: 15px; font-weight: 600; text-decoration: none;">
                            Review Queue
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Footer -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px; border-top: 1px solid #2a2a2a;">
                <tr>
                  <td style="padding-top: 24px; text-align: center;">
                    <p style="margin: 0; color: #666666; font-size: 13px;">
                      You're receiving this because scan-execution completed. Manage schedules on your dashboard.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Bottom text -->
        <p style="margin: 24px 0 0; color: #666666; font-size: 12px;">
          The Wire Room
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `
The Wire Room - Daily Scan Digest

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
The Wire Room
  `.trim();

  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;
  console.log(`[Email] Sending scan digest to: ${Array.isArray(to) ? to.join(', ') : to}`);

  await client.emails.send({
    from: config.email.fromEmail,
    to,
    subject: `Daily Scan Digest - ${dateStr} | ${intakeSummary.newUnique} new finds`,
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Scan digest email sent successfully`);
}

export async function sendDailyDigestEmail(
  digest: import('../jobs/daily-digest').DailyDigestResult,
  dashboardUrl: string,
  recipients?: string[]
): Promise<void> {
  const client = getResend();
  const reviewUrl = `${dashboardUrl.replace(/\/$/, '')}/queue`;

  const wireRows = digest.wires.map(w => {
    const pendingColor = w.pendingReview > 10 ? '#ef5350' : w.pendingReview > 0 ? '#f5a623' : '#4caf50';
    return `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a2a;color:#ffffff;font-size:14px;text-transform:capitalize;">${escapeHtml(w.wire)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a2a;color:#cccccc;font-size:14px;text-align:center;">${w.scansRun}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a2a;color:#cccccc;font-size:14px;text-align:center;">${w.newUnique}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a2a;color:#cccccc;font-size:14px;text-align:center;">${w.recentlyApproved}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #2a2a2a;text-align:center;">
        <span style="display:inline-block;background-color:${pendingColor};color:#0d0d0d;padding:2px 10px;border-radius:10px;font-size:13px;font-weight:700;">${w.pendingReview}</span>
      </td>
    </tr>`;
  }).join('');

  const wireText = digest.wires.map(w =>
    `  ${w.wire.padEnd(10)} scans:${w.scansRun} new:${w.newUnique} approved:${w.recentlyApproved} pending:${w.pendingReview}`
  ).join('\n');

  const htmlContent = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0d0d0d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#0d0d0d;">
  <tr><td align="center" style="padding:40px 20px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#1a1a1a;border:1px solid #2a2a2a;border-radius:16px;">
      <tr><td style="padding:40px;">
        <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;text-align:center;">
          <span style="color:#ffffff;">The</span> <span style="color:#f5a623;">Wire</span> <span style="color:#ffffff;">Room</span>
        </h1>
        <p style="margin:0 0 28px;color:#999999;font-size:13px;text-align:center;">Daily Digest — ${escapeHtml(digest.date)}</p>
        <h2 style="margin:0 0 6px;color:#ffffff;font-size:18px;font-weight:600;">Pipeline Summary</h2>
        <p style="margin:0 0 20px;color:#999999;font-size:14px;">
          ${digest.totalNewUnique} new unique finds across all wires.
          ${digest.totalPendingReview > 0
            ? `<strong style="color:#f5a623;">${digest.totalPendingReview} items pending your review.</strong>`
            : '<span style="color:#4caf50;">Queue is clear.</span>'}
        </p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
          <tr>
            <th style="padding:8px;text-align:left;color:#f5a623;font-size:12px;font-weight:600;text-transform:uppercase;border-bottom:2px solid #2a2a2a;">Wire</th>
            <th style="padding:8px;text-align:center;color:#f5a623;font-size:12px;font-weight:600;text-transform:uppercase;border-bottom:2px solid #2a2a2a;">Scans</th>
            <th style="padding:8px;text-align:center;color:#f5a623;font-size:12px;font-weight:600;text-transform:uppercase;border-bottom:2px solid #2a2a2a;">New</th>
            <th style="padding:8px;text-align:center;color:#f5a623;font-size:12px;font-weight:600;text-transform:uppercase;border-bottom:2px solid #2a2a2a;">Approved</th>
            <th style="padding:8px;text-align:center;color:#f5a623;font-size:12px;font-weight:600;text-transform:uppercase;border-bottom:2px solid #2a2a2a;">Pending</th>
          </tr>
          ${wireRows}
        </table>
        ${digest.totalPendingReview > 0 ? `
        <table role="presentation" cellspacing="0" cellpadding="0" width="100%"><tr><td align="center">
          <a href="${escapeHtml(reviewUrl)}" target="_blank" style="display:inline-block;padding:14px 32px;background-color:#f5a623;color:#0d0d0d;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">
            Review Queue (${digest.totalPendingReview})
          </a>
        </td></tr></table>` : `
        <table role="presentation" cellspacing="0" cellpadding="0" width="100%"><tr><td align="center">
          <a href="${escapeHtml(dashboardUrl)}" target="_blank" style="display:inline-block;padding:14px 32px;background-color:#2a2a2a;color:#cccccc;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">
            Open Dashboard
          </a>
        </td></tr></table>`}
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:28px;border-top:1px solid #2a2a2a;">
          <tr><td style="padding-top:20px;text-align:center;">
            <p style="margin:0;color:#666666;font-size:12px;">One email per day. Individual scan notifications are disabled.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
    <p style="margin:20px 0 0;color:#666666;font-size:11px;">The Wire Room</p>
  </td></tr>
</table>
</body></html>`;

  const textContent = `The Wire Room — Daily Digest ${digest.date}

${digest.totalNewUnique} new unique finds. ${digest.totalPendingReview} pending review.

WIRE BREAKDOWN
--------------
${wireText}

${digest.totalPendingReview > 0 ? `Review queue: ${reviewUrl}` : 'Queue is clear.'}

---
One email per day. Individual scan notifications disabled.
The Wire Room`;

  const pendingLabel = digest.totalPendingReview > 0 ? ` | ${digest.totalPendingReview} pending` : '';
  const to = recipients && recipients.length > 0 ? recipients : config.email.notificationEmail;

  await client.emails.send({
    from: config.email.fromEmail,
    to,
    subject: `Wire Room Digest — ${digest.date} | ${digest.totalNewUnique} new${pendingLabel}`,
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Daily digest sent to: ${Array.isArray(to) ? to.join(', ') : to}`);
}
