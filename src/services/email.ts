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

export async function sendLoginEmail(email: string, magicLink: string): Promise<void> {
  console.log(`[Email] Sending login email to: ${email}`);

  const client = getResend();

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in to CryptoGrantWire</title>
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
                <span style="color: #ffffff;">Crypto</span><span style="color: #f5a623;">Grant</span><span style="color: #ffffff;">Wire</span>
              </h1>
              <p style="margin: 0 0 32px; color: #999999; font-size: 16px;">Sign in to your dashboard</p>

              <!-- Message -->
              <p style="margin: 0 0 32px; color: #ffffff; font-size: 16px; line-height: 1.6;">
                Click the button below to securely sign in to your account.
              </p>

              <!-- Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="background-color: #f5a623; border-radius: 8px;">
                    <a href="${magicLink}" target="_blank" style="display: inline-block; padding: 16px 32px; color: #0d0d0d; font-size: 16px; font-weight: 600; text-decoration: none;">
                      Sign In
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Footer -->
              <p style="margin: 32px 0 0; color: #666666; font-size: 14px; line-height: 1.5;">
                This link expires in 15 minutes.<br>
                If you didn't request this, you can safely ignore this email.
              </p>
            </td>
          </tr>
        </table>

        <!-- Bottom text -->
        <p style="margin: 24px 0 0; color: #666666; font-size: 12px;">
          CryptoGrantWire Newsletter Automation
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `
CryptoGrantWire - Sign In

Click here to sign in to your dashboard:
${magicLink}

This link expires in 15 minutes.
If you didn't request this, you can safely ignore this email.

---
CryptoGrantWire Newsletter Automation
  `.trim();

  try {
    const result = await client.emails.send({
      from: config.email.fromEmail,
      to: email,
      subject: 'Sign in to Crypto Grant Wire',
      html: htmlContent,
      text: textContent,
    });
    console.log(`[Email] Send result:`, JSON.stringify(result));
  } catch (error: any) {
    console.error(`[Email] Failed to send:`, error?.message || error);
    console.error(`[Email] Full error:`, JSON.stringify(error, null, 2));
    throw error;
  }
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
  <title>Weekly Summaries Ready - CryptoGrantWire</title>
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
                <span style="color: #ffffff;">Crypto</span><span style="color: #f5a623;">Grant</span><span style="color: #ffffff;">Wire</span>
              </h1>
              <p style="margin: 0 0 24px; color: #999999; font-size: 14px; text-align: center;">Newsletter Automation</p>

              <!-- Header -->
              <h2 style="margin: 0 0 16px; color: #ffffff; font-size: 20px; font-weight: 600;">
                Weekly Summaries Ready
              </h2>
              <p style="margin: 0 0 24px; color: #cccccc; font-size: 15px; line-height: 1.5;">
                Hey Sov, your Grant Wire summaries for this week are ready for review.
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
                          <a href="${downloadUrl}" target="_blank" style="display: inline-block; padding: 14px 28px; color: #0d0d0d; font-size: 15px; font-weight: 600; text-decoration: none;">
                            Download Markdown File
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin: 16px 0 0; color: #666666; font-size: 13px; text-align: center;">
                This link requires Magic Link authentication.
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
          CryptoGrantWire Newsletter Automation
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `
CryptoGrantWire - Weekly Summaries Ready

Hey Sov, your Grant Wire summaries for this week are ready for review.

THIS WEEK'S STATS
-----------------
${stats.totalEntries} entries processed
- ${stats.xcomEntries} from X.com (via Grok)
- ${stats.otherEntries} from other sources (via Claude)
${stats.failedProcessing > 0 ? `- ${stats.failedProcessing} entries need manual review` : ''}

Download your file:
${downloadUrl}

(This link requires Magic Link authentication)

---
Week of ${dateRangeStr}
CryptoGrantWire Newsletter Automation
  `.trim();

  await client.emails.send({
    from: config.email.fromEmail,
    to: config.email.notificationEmail,
    subject: `Crypto Grant Wire Weekly Summaries Ready - ${dateRangeStr}`,
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
  <title>Test Alert - CryptoGrantWire</title>
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
                <span style="color: #ffffff;">Crypto</span><span style="color: #f5a623;">Grant</span><span style="color: #ffffff;">Wire</span>
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
          CryptoGrantWire Newsletter Automation
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `
CryptoGrantWire - Test Alert

Email Alerts Are Working!

This is a test alert to verify that your email notifications are configured correctly.
If you received this email, your scheduled alerts will work properly.

Sent at: ${timestamp}

---
CryptoGrantWire Newsletter Automation
  `.trim();

  console.log(`[Email] Sending test alert to: ${config.email.notificationEmail}`);

  await client.emails.send({
    from: config.email.fromEmail,
    to: config.email.notificationEmail,
    subject: 'Test Alert - CryptoGrantWire',
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Test alert sent successfully`);
}

export async function sendScheduledJobFailureEmail(errorMessage: string, jobStartTime: Date): Promise<void> {
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
  <title>Scheduled Job Failed - CryptoGrantWire</title>
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
                <span style="color: #ffffff;">Crypto</span><span style="color: #f5a623;">Grant</span><span style="color: #ffffff;">Wire</span>
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
                      ${errorMessage}
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
          CryptoGrantWire Newsletter Automation
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `
CryptoGrantWire - Scheduled Job Failed

The scheduled weekly summary job failed to complete.

ERROR MESSAGE
-------------
${errorMessage}

Job started at: ${timestamp}

Please check the dashboard or server logs for more details.

---
CryptoGrantWire Newsletter Automation
  `.trim();

  console.log(`[Email] Sending scheduled job failure notification to: ${config.email.notificationEmail}`);

  await client.emails.send({
    from: config.email.fromEmail,
    to: config.email.notificationEmail,
    subject: '⚠️ CryptoGrantWire Scheduled Job Failed',
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
  <title>New Download Link - CryptoGrantWire</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0d0d0d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d0d0d;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px;">
          <tr>
            <td style="padding: 48px 40px; text-align: center;">
              <h1 style="margin: 0 0 8px; font-size: 28px; font-weight: 700;">
                <span style="color: #ffffff;">Crypto</span><span style="color: #f5a623;">Grant</span><span style="color: #ffffff;">Wire</span>
              </h1>
              <p style="margin: 0 0 32px; color: #999999; font-size: 16px;">Fresh Download Link</p>

              <h2 style="margin: 0 0 16px; color: #ffffff; font-size: 20px; font-weight: 600;">
                Your new download link is ready
              </h2>
              <p style="margin: 0 0 8px; color: #999999; font-size: 14px;">File:</p>
              <p style="margin: 0 0 32px; color: #f5a623; font-size: 14px; font-family: monospace;">${filename}</p>

              <a href="${downloadUrl}" style="display: inline-block; background-color: #f5a623; color: #0d0d0d; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600;">
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
CryptoGrantWire - Fresh Download Link

Your new download link is ready.

File: ${filename}

Download: ${downloadUrl}

This link expires in 24 hours.
  `.trim();

  await client.emails.send({
    from: config.email.fromEmail,
    to: email,
    subject: 'CryptoGrantWire - Fresh Download Link',
    html: htmlContent,
    text: textContent,
  });

  console.log(`[Email] Resend link email sent successfully`);
}
