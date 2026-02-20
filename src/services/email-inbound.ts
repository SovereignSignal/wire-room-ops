/**
 * Email Inbound Service
 *
 * Handles Resend Inbound Webhook payloads.
 * Extracts URLs from email body, processes each through the URL processor,
 * and feeds results into the intake pipeline.
 */

import crypto from 'crypto';
import { config } from '../config';
import { processUrl } from './url-processor';
import { runDailyIntake } from '../jobs/daily-intake';
import { getPool } from '../db';
import type { ScanSubmission, RawScanResult } from '../types/intake';

// ============================================================
// Types
// ============================================================

export interface ResendInboundPayload {
  type: 'email.received';
  created_at: string;
  data: {
    from: string;
    to: string[];
    subject: string;
    text?: string;
    html?: string;
    headers: Array<{ name: string; value: string }>;
  };
}

export interface InboundEmailResult {
  processed: number;
  duplicates: number;
  errors: number;
  sender: string;
}

// ============================================================
// Signature Verification
// ============================================================

/**
 * Verify the Resend webhook signature (HMAC-SHA256).
 */
export function verifyResendSignature(
  payload: string,
  signature: string
): boolean {
  const secret = config.inboundEmail.webhookSigningSecret;
  if (!secret) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

// ============================================================
// Email Processing
// ============================================================

/**
 * Handle an inbound email webhook payload.
 * Extracts URLs, processes each, and feeds into intake pipeline.
 */
export async function handleInboundEmail(
  payload: ResendInboundPayload
): Promise<InboundEmailResult> {
  const sender = extractEmailAddress(payload.data.from).toLowerCase();
  console.log(`[EmailInbound] Processing email from ${sender}: "${payload.data.subject}"`);

  // Access control
  if (!config.inboundEmail.allowedSenders.includes(sender)) {
    console.log(`[EmailInbound] Rejected sender: ${sender}`);
    return { processed: 0, duplicates: 0, errors: 0, sender };
  }

  // Extract URLs from plain text body
  const body = payload.data.text || '';
  const urls = extractUrls(body);

  if (urls.length === 0) {
    console.log(`[EmailInbound] No URLs found in email from ${sender}`);
    return { processed: 0, duplicates: 0, errors: 0, sender };
  }

  console.log(`[EmailInbound] Found ${urls.length} URLs to process`);

  // Process each URL
  const results: RawScanResult[] = [];
  let errors = 0;
  let detectedWire: string | null = null;

  for (const url of urls) {
    try {
      const processed = await processUrl(url);
      results.push(processed.result);
      // Use the first detected wire for all results
      if (!detectedWire && processed.detectedWire) {
        detectedWire = processed.detectedWire;
      }
    } catch (error) {
      console.error(`[EmailInbound] Failed to process ${url}:`, error);
      errors++;
    }
  }

  if (results.length === 0) {
    return { processed: 0, duplicates: 0, errors, sender };
  }

  // Build submission and run intake
  const wire = detectedWire || config.telegram.defaultWire;
  const today = new Date().toISOString().split('T')[0];

  const submission: ScanSubmission = {
    wire,
    promptVariant: 'N',
    scanDate: today,
    source: 'email',
    results,
    submittedBy: `email:${sender}`,
  };

  const pool = getPool();
  const summary = await runDailyIntake(pool, [submission]);

  // Send confirmation reply (fire-and-forget)
  sendConfirmationEmail(sender, payload.data.subject, summary.newUnique, summary.duplicatesFound, results.length)
    .catch(e => console.error('[EmailInbound] Confirmation email failed:', e));

  return {
    processed: results.length,
    duplicates: summary.duplicatesFound,
    errors,
    sender,
  };
}

// ============================================================
// Helpers
// ============================================================

/**
 * Extract URLs from plain text, deduplicated.
 */
function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  const matches = text.match(urlRegex) || [];

  // Clean trailing punctuation and deduplicate
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const match of matches) {
    const cleaned = match.replace(/[.,;:!?)]+$/, '');
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      urls.push(cleaned);
    }
  }

  return urls;
}

/**
 * Extract bare email address from a "Name <email>" or "email" string.
 */
function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from.trim();
}

/**
 * Send a confirmation reply email via Resend.
 */
async function sendConfirmationEmail(
  to: string,
  originalSubject: string,
  queued: number,
  duplicates: number,
  total: number
): Promise<void> {
  // Lazy import to avoid circular dependencies
  const { Resend } = await import('resend');
  const resend = new Resend(config.email.resendApiKey);

  const subject = `Re: ${originalSubject || 'Grant URL Submission'}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 500px;">
      <h3 style="margin: 0 0 12px;">Grant URLs Processed</h3>
      <table style="border-collapse: collapse; width: 100%;">
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">URLs processed</td><td><strong>${total}</strong></td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">New (queued)</td><td><strong>${queued}</strong></td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">Duplicates</td><td>${duplicates}</td></tr>
      </table>
      <p style="color: #888; font-size: 13px; margin-top: 16px;">
        New entries are in the review queue on your dashboard.
      </p>
    </div>
  `;

  await resend.emails.send({
    from: config.email.fromEmail,
    to,
    subject,
    html,
  });

  console.log(`[EmailInbound] Confirmation sent to ${to}`);
}
