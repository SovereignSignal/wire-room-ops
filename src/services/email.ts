import { Resend } from 'resend';
import { config } from '../config';
import { ProcessingStats } from '../types';

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
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { margin-bottom: 24px; }
    .stats { background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 20px 0; }
    .stats-item { margin: 8px 0; }
    .button { display: inline-block; background: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .button:hover { background: #0052a3; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>Crypto Grant Wire Weekly Summaries Ready</h2>
      <p>Hey Sov,</p>
      <p>Your weekly Grant Wire summaries are ready for review.</p>
    </div>

    <div class="stats">
      <div class="stats-item"><strong>This week:</strong> ${stats.totalEntries} entries processed</div>
      <div class="stats-item">• ${stats.xcomEntries} from X.com (via Grok)</div>
      <div class="stats-item">• ${stats.otherEntries} from other sources (via Opus)</div>
      ${stats.failedProcessing > 0 ? `<div class="stats-item">• ${stats.failedProcessing} entries need manual review</div>` : ''}
    </div>

    <a href="${downloadUrl}" class="button">Download Markdown File</a>

    <p style="font-size: 14px; color: #666;">The link above requires Magic Link authentication.</p>

    <div class="footer">
      <p>Crypto Grant Wire Automation</p>
      <p style="font-size: 12px;">Week of ${dateRangeStr}</p>
    </div>
  </div>
</body>
</html>
  `.trim();

  const textContent = `
Hey Sov,

Your weekly Grant Wire summaries are ready for review.

This week: ${stats.totalEntries} entries processed
- ${stats.xcomEntries} from X.com (via Grok)
- ${stats.otherEntries} from other sources (via Opus)
${stats.failedProcessing > 0 ? `- ${stats.failedProcessing} entries need manual review` : ''}

Download: ${downloadUrl}

The link above requires Magic Link authentication.

---
Crypto Grant Wire Automation
Week of ${dateRangeStr}
  `.trim();

  await client.emails.send({
    from: config.email.fromEmail,
    to: config.email.notificationEmail,
    subject: `Crypto Grant Wire Weekly Summaries Ready - ${dateRangeStr}`,
    html: htmlContent,
    text: textContent,
  });
}
