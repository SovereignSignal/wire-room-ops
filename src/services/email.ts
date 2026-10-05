import { Resend } from 'resend';
import { config } from '../config';
import { getBrand } from '../config/brand';
import { ProcessingStats } from '../types';
import { escapeHtml } from '../utils/html';
import { logApiUsage } from './api-usage';
import { getCachedProvider } from './api-provider';

function getResend(): Resend {
  // The provider cache already contains the environment fallback. A disabled
  // DB row must remain a real kill switch.
  const provider = getCachedProvider('resend');
  const apiKey = provider?.api_key;
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

function dailyDigestShell(title: string, date: string, bodyHtml: string): string {
  const brand = getBrand();
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#eef3f5;${FONT}">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#eef3f5;">
    <tr>
      <td align="center" style="padding:28px 14px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#ffffff;border:1px solid #cad4dc;border-radius:6px;overflow:hidden;">
          <tr>
            <td style="padding:16px 20px;background-color:#172026;color:#ffffff;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="font-size:14px;font-weight:800;letter-spacing:3px;color:#ffffff;">WIRE<span style="color:#8fd3ff;">OPS</span></td>
                  <td align="right" style="font-size:11px;color:#9cc9e8;${MONO}">${escapeHtml(date)}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:14px 20px;border-top:1px solid #dfe6eb;">
              <p style="margin:0;color:#8b969e;font-size:11px;">${escapeHtml(brand.name)}</p>
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

export interface TopFindEntry {
  id: number;
  name: string;
  wire: string;
  quality_score: number | null;
  amount: string | null;
  deadline: string | null;
  source_url: string | null;
  curator_route: string | null;
  curator_confidence: string | null;
  /** Classifier one-liner (metadata.summary, description fallback) — the card's "what is this" */
  summary: string | null;
  /** decided-recheck stamp: 'update' renders a prior-entry note on the card */
  recheck_verdict: string | null;
  recheck_matched_name: string | null;
  recheck_matched_status: string | null;
  program_verdict: string | null;
  program_history: string | null;
  /** scan_entries.scan_source — rendered as a short lane badge */
  scan_source?: string | null;
  /** scan_entries.wire_area (schema v10). Shown only when it is 1–6 or out. */
  wire_area?: string | null;
  /** Whole days since scan_entries.created_at. 0 renders as "first seen today". */
  first_seen_age_days?: number | string | null;
  /** metadata.curator.by. agent:hedwig means QC already stamped this queued row. */
  curator_by?: string | null;
  /** scan_entries.actioned_by. agent:hedwig means Hedwig already wrote on this row. */
  actioned_by?: string | null;
  /** Structured holds already stored on the row. Empty when none exist. */
  hold_hints?: string | null;
  /** Used only for decision-changing stamps already written by dedup. */
  operator_notes?: string | null;
}

export type LaneState = 'ok' | 'warn' | 'fail';
export interface RunLedgerLane { key: string; state: LaneState; detail: string; }
/** Evidence that the machine ran — rendered inside the digest status band. */
export interface RunLedger { lanes: RunLedgerLane[]; }

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

export interface ClosingSoonRow {
  name: string;
  wire: string;
  deadline: string;
  daysUntil: number;
  amount: string | null;
  sourceUrl: string;
}

export interface DigestEmailExtras {
  /** Never-before-emailed queue items (watermarked) — the "New for review" cards */
  freshFinds?: TopFindEntry[];
  /** Total eligible new items behind freshFinds (drives the "+N more never-emailed" line) */
  totalNewEligible?: number;
  /**
   * False when the watermark could not be read and totalNewEligible is only a
   * 24h window. The band then prints never-emailed: ? instead of that count.
   */
  neverEmailedKnown?: boolean;
  /** Evidence the machine ran — rendered inside the status band */
  runLedger?: RunLedger;
  /** Approved entries closing within 7 days (folds the retired deadline email) */
  closingSoon?: ClosingSoonRow[];
  costRecap?: { rows: import('../jobs/daily-digest').CostRow[]; total: number };
  /** Wednesday BD leads written to Paid Work Leads this run */
  bdLeads?: DigestBdLead[];
  bdLeadsUrl?: string;
  /** Operational anomalies — the ONLY way ops telemetry gets into the email. */
  anomalies?: string[];
}

const DIGEST_SOURCE_LANE: Record<string, string> = {
  'x-scan': 'x-scan',
  'grok-scout': 'grok-scout',
  'web-search': 'web',
  'perplexity': 'perplexity',
  'community': 'community',
  telegram: 'telegram',
  'telegram-intake': 'telegram',
  'manual-intake': 'manual',
  email: 'email',
  forum: 'discuss',
  'x-monitor': 'x-monitor',
  'x-list': 'x-list',
  feed: 'feed',
  'claude-code': 'scout',
  'claude-cohort-notion': 'cohort',
  'known-org-watch': 'org-watch',
  stringer: 'stringer',
};

function digestSourceLane(scanSource: string | null | undefined): string | null {
  const key = scanSource?.trim();
  if (!key) return null;
  return DIGEST_SOURCE_LANE[key] ?? key;
}

function digestAreaTag(area: string | null | undefined): string | null {
  if (area == null) return null;
  const text = String(area).trim().toLowerCase();
  if (text === 'out') return 'area out';
  if (/^[1-6]$/.test(text)) return `area ${text}`;
  return null;
}

function digestFirstSeen(days: number | string | null | undefined): string | null {
  if (days == null || days === '') return null;
  const n = typeof days === 'number' ? days : Number(days);
  if (!Number.isFinite(n) || n < 0) return null;
  const whole = Math.floor(n);
  if (whole === 0) return 'first seen today';
  if (whole === 1) return 'first seen 1d';
  return `first seen ${whole}d`;
}

/** QC already wrote on this still-queued row. discuss.watch and auto-approve do not. */
function hedwigAlreadyTouched(entry: TopFindEntry): boolean {
  const by = (entry.curator_by || '').trim().toLowerCase();
  const actor = (entry.actioned_by || '').trim().toLowerCase();
  return by === 'agent:hedwig' || actor === 'agent:hedwig';
}

const DECISION_NOTE_LINE = /^(?:New cycle of #\d+\b.*|Re-surfaced after premature decline of #\d+\b.*)$/i;

function digestDecisionNotes(notes: string | null | undefined): string[] {
  if (!notes) return [];
  return notes
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => DECISION_NOTE_LINE.test(line))
    .map(line => (line.length > 180 ? `${line.slice(0, 179)}…` : line));
}

/**
 * Keep a program line only when it changes the decision: a new round, a
 * same-round repeat, or a prior decline. Seen and approved counts are noise.
 */
function digestProgramNote(entry: TopFindEntry): string | null {
  const parts = (entry.program_history || '')
    .split(/\s*·\s*/)
    .map(part => part.trim())
    .filter(part => part && !/^seen\s+\d+/i.test(part) && !/^approved\s+\d+/i.test(part));
  const declined = parts.some(part => /^declined\s+\d+/i.test(part));
  const isNew = entry.program_verdict === 'new_round';
  const isRepeat = entry.program_verdict === 'same_round';
  if (!isNew && !isRepeat && !declined) return null;
  const prefix = isNew
    ? 'New round of a known program'
    : isRepeat
      ? 'Program repeat'
      : 'Prior decline';
  const rest = parts.join(' · ');
  return rest ? `${prefix} · ${rest}` : prefix;
}

/**
 * Render the daily digest email (2026-07-09 "Run Ledger" redesign).
 *
 * The operator's cockpit — three jobs, in order:
 *   1. Status band: prove the machine ran (RUN CLEAN / ⚠ N ISSUES + lane ledger).
 *   2. New for review: never-before-emailed queue items, curator-stamped,
 *      deep-linked into the dashboard queue (?entry=<id>). The band's
 *      "never-emailed" count is this watermark, not 24h intake.
 *   3. Closing soon: approved entries with deadlines ≤7d.
 * Backlog appears only on the queue button. Quiet day = short email.
 */
export function renderDailyDigest(
  digest: import('../jobs/daily-digest').DailyDigestResult,
  dashboardUrl: string,
  extras: DigestEmailExtras = {},
): { subject: string; html: string; text: string } {
  const brand = getBrand();
  const base = dashboardUrl.replace(/\/$/, '');
  const queueUrl = `${base}/queue`;
  const { freshFinds, totalNewEligible, neverEmailedKnown, runLedger, closingSoon, costRecap, bdLeads, bdLeadsUrl, anomalies } = extras;

  const finds = freshFinds ?? [];
  const freshCount = finds.length;
  const totalNew = Math.max(totalNewEligible ?? freshCount, freshCount);
  const issueCount = anomalies?.length ?? 0;
  const totalIn = digest.wires.reduce((n, w) => n + w.totalIngested, 0);
  const waiting = digest.totalPendingReview;
  const neverEmailedLabel = neverEmailedKnown === false ? '?' : String(totalNew);

  const day = new Date(`${digest.date}T00:00:00Z`);
  const subjDate = day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const slugDate = day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).replace(/,/g, '').toUpperCase();

  // ── 1. Status band ───────────────────────────────────────────────────
  const ledgerParts = [
    ...(runLedger?.lanes ?? []).map(l => l.detail),
    `intake 24h: ${totalIn} · never-emailed: ${neverEmailedLabel} · waiting: ${waiting}`,
    costRecap ? `$${costRecap.total.toFixed(2)}` : null,
  ].filter((p): p is string => Boolean(p));
  const clean = issueCount === 0;
  const verdict = clean ? 'RUN CLEAN' : `⚠ ${issueCount} ISSUE${issueCount === 1 ? '' : 'S'}`;
  const bandHtml = `
    <div style="padding:9px 24px;background-color:${clean ? '#e6f6ee' : '#fdeee4'};border-bottom:1px solid ${clean ? '#bfe4d0' : '#f0c4a4'};">
      <p style="margin:0;font-size:11px;color:${clean ? '#116b45' : '#a23b00'};${MONO}"><strong style="letter-spacing:1px;">${escapeHtml(verdict)}</strong> &nbsp; ${ledgerParts.map(p => escapeHtml(p)).join(' &middot; ')}</p>
    </div>`;
  const bandText = `${verdict} | ${ledgerParts.join(' · ')}`;

  // ── 2. Production issues (bad day only) ──────────────────────────────
  let issuesHtml = '';
  let issuesText = '';
  if (issueCount > 0 && anomalies) {
    issuesHtml = `
      ${sectionLabel(`Production issues (${issueCount})`)}
      ${anomalies.map(a => `<div style="background:#fff7ed;border:1px solid #f0b38a;border-radius:5px;padding:10px 12px;margin:0 0 8px;color:#a23b00;font-size:12px;line-height:1.45;">${escapeHtml(a)}</div>`).join('')}`;
    issuesText = `\nPRODUCTION ISSUES (${issueCount})\n` + anomalies.map(a => `  ! ${a}`).join('\n') + '\n';
  }

  // ── 3. New for review ────────────────────────────────────────────────
  const routeLabel: Record<string, string> = {
    publish: 'PUBLISH', source_check: 'CHECK', relationship_signal: 'SIGNAL', park: 'PARK', decline: 'DECLINE',
  };
  const queueBtn = `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:16px 0 4px;">
    <tr><td style="background-color:#14181c;padding:10px 24px;">
      <a href="${escapeHtml(queueUrl)}" target="_blank" style="color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;${FONT}">Open queue → ${waiting} waiting</a>
    </td></tr>
  </table>`;

  let reviewHtml = '';
  let reviewText = '';
  if (freshCount > 0) {
    // Render defenses against known data warts: a leaked "deadline"/"due"
    // label inside the deadline value, and bare durations posing as amounts.
    const cleanDeadline = (d: string | null) => d ? (d.replace(/^(?:deadline|due|closes)[:\s]+/i, '').trim() || null) : null;
    const cleanAmount = (a: string | null) => a && !/^\d+(?:\.\d+)?\s*m(?:o|os|onths?)?$/i.test(a.trim()) ? a : null;

    const renderCards = (rows: TopFindEntry[]): { html: string; text: string } => {
      const html = rows.map(e => {
        const entryUrl = `${queueUrl}?entry=${e.id}`;
        const route = e.curator_route ? routeLabel[e.curator_route] ?? null : null;
        const stamp = route ? `${route}${e.curator_confidence ? `·${e.curator_confidence.toUpperCase()}` : ''}` : null;
        const isPublish = e.curator_route === 'publish';
        const amount = cleanAmount(e.amount);
        const deadline = cleanDeadline(e.deadline);
        const firstSeen = digestFirstSeen(e.first_seen_age_days);
        const lane = digestSourceLane(e.scan_source);
        const area = digestAreaTag(e.wire_area);
        const hints = (e.hold_hints || '').trim();
        const program = digestProgramNote(e);
        const decisionNotes = digestDecisionNotes(e.operator_notes);
        const metaParts = [
          escapeHtml(e.wire.toUpperCase()),
          `#${e.id}`,
          firstSeen ? escapeHtml(firstSeen) : null,
          lane ? escapeHtml(lane) : null,
          area ? escapeHtml(area) : null,
          stamp ? `<span style="color:${isPublish ? '#116b45' : '#8a6d1f'};font-weight:700;">${escapeHtml(stamp)}</span>` : null,
          amount ? escapeHtml(amount) : null,
          deadline ? `due ${escapeHtml(deadline)}` : null,
          e.source_url ? `<a href="${escapeHtml(e.source_url)}" style="color:#93a2ac;text-decoration:none;">source &#8599;</a>` : null,
        ].filter(Boolean);
        const summaryHtml = e.summary
          ? `<p style="margin:5px 0 0;font-size:12px;color:#4a565f;line-height:1.45;">${escapeHtml(e.summary.slice(0, 220))}</p>`
          : '';
        const updateHtml = e.recheck_verdict === 'update' && e.recheck_matched_name
          ? `<p style="margin:5px 0 0;font-size:10.5px;color:#8a6d1f;${MONO}">&#8635; Update of a prior entry: &ldquo;${escapeHtml(e.recheck_matched_name)}&rdquo; (${escapeHtml(e.recheck_matched_status || 'seen')})</p>`
          : '';
        const holdHtml = hints
          ? `<p style="margin:5px 0 0;font-size:10.5px;color:#8a6d1f;${MONO}">${escapeHtml(hints)}</p>`
          : '';
        const noteHtml = decisionNotes.map(note =>
          `<p style="margin:5px 0 0;font-size:10.5px;color:#8a6d1f;${MONO}">&#8635; ${escapeHtml(note)}</p>`
        ).join('');
        const programHtml = program
          ? `<p style="margin:5px 0 0;font-size:10.5px;color:#8a6d1f;${MONO}">&#8635; ${escapeHtml(program)}</p>`
          : '';
        return `<div style="border:1px solid #e2e8ed;border-left:3px solid ${isPublish ? '#1a8a5a' : '#d0d9df'};padding:10px 12px;margin:0 0 8px;">
        <p style="margin:0;font-size:13px;line-height:1.4;"><a href="${escapeHtml(entryUrl)}" style="color:#14181c;font-weight:700;text-decoration:none;border-bottom:1px solid #9fd4f5;">${escapeHtml(e.name)}</a></p>
        ${summaryHtml}
        <p style="margin:5px 0 0;font-size:10.5px;color:#64717b;${MONO}">${metaParts.join(' &middot; ')}</p>
        ${holdHtml}
        ${noteHtml}
        ${updateHtml}
        ${programHtml}
      </div>`;
      }).join('');

      const text = rows.map(e => {
        const route = e.curator_route ? routeLabel[e.curator_route] ?? '' : '';
        const stamp = route ? ` [${route}${e.curator_confidence ? `·${e.curator_confidence.toUpperCase()}` : ''}]` : '';
        const amount = cleanAmount(e.amount);
        const deadline = cleanDeadline(e.deadline);
        const identity = [
          e.wire.toUpperCase(),
          `#${e.id}`,
          digestFirstSeen(e.first_seen_age_days),
          digestSourceLane(e.scan_source),
          digestAreaTag(e.wire_area),
        ].filter(Boolean).join(' · ');
        const summaryLine = e.summary ? `\n    ${e.summary.slice(0, 220)}` : '';
        const hints = (e.hold_hints || '').trim();
        const holdLine = hints ? `\n    ${hints}` : '';
        const noteLine = digestDecisionNotes(e.operator_notes).map(note => `\n    ↻ ${note}`).join('');
        const updateLine = e.recheck_verdict === 'update' && e.recheck_matched_name
          ? `\n    ↻ Update of a prior entry: "${e.recheck_matched_name}" (${e.recheck_matched_status || 'seen'})` : '';
        const program = digestProgramNote(e);
        const programLine = program ? `\n    ↻ ${program}` : '';
        return `  [${identity}]${stamp} ${e.name}${amount ? ` | ${amount}` : ''}${deadline ? ` | due ${deadline}` : ''}${summaryLine}${holdLine}${noteLine}${updateLine}${programLine}\n    ${queueUrl}?entry=${e.id}`;
      }).join('\n');
      return { html, text };
    };

    const needsYou = finds.filter(e => !hedwigAlreadyTouched(e));
    const inLane = finds.filter(e => hedwigAlreadyTouched(e));
    const laneNote = 'Hedwig already wrote on these queued rows. discuss.watch and auto-approve are not marked.';
    const groupLabel = (label: string) =>
      `<p style="margin:12px 0 6px;font-size:12px;font-weight:700;color:#14181c;">${escapeHtml(label)}</p>`;
    let groupsHtml = '';
    let groupsText = '';
    if (needsYou.length > 0) {
      const rendered = renderCards(needsYou);
      groupsHtml += `${groupLabel(`Needs you (${needsYou.length})`)}${rendered.html}`;
      groupsText += `NEEDS YOU (${needsYou.length})\n${rendered.text}\n`;
    }
    if (inLane.length > 0) {
      const rendered = renderCards(inLane);
      groupsHtml += `${groupLabel(`Already in my lane (${inLane.length})`)}<p style="margin:0 0 8px;font-size:11px;color:#64717b;">${escapeHtml(laneNote)}</p>${rendered.html}`;
      groupsText += `ALREADY IN MY LANE (${inLane.length})\n  ${laneNote}\n${rendered.text}\n`;
    }
    const more = totalNew - freshCount;
    reviewHtml = `
      ${sectionLabel(`New for review (${freshCount})`)}
      ${groupsHtml}
      ${more > 0 ? `<p style="margin:4px 0 0;font-size:12px;color:#64717b;">${more} more never-emailed</p>` : ''}
      ${queueBtn}`;
    reviewText = `\nNEW FOR REVIEW (${freshCount})\n${groupsText}` + (more > 0 ? `  ${more} more never-emailed\n` : '') + `  Open queue (${waiting} waiting): ${queueUrl}\n`;
  } else {
    reviewHtml = `
      <p style="margin:18px 0 0;font-size:13px;color:#444;">Nothing new for review. Everything ingested overnight was duplicate or off-scope &mdash; the machine ran, filtered, and left you alone.</p>
      ${waiting > 0 ? `<p style="margin:10px 0 0;font-size:12px;color:#64717b;"><a href="${escapeHtml(queueUrl)}" style="color:#64717b;">${waiting} older item${waiting === 1 ? '' : 's'} still queued</a></p>` : ''}`;
    reviewText = `\nNothing new for review.${waiting > 0 ? ` ${waiting} older item${waiting === 1 ? '' : 's'} still queued: ${queueUrl}` : ''}\n`;
  }

  // ── 4. Closing soon ──────────────────────────────────────────────────
  let closingHtml = '';
  let closingText = '';
  if (closingSoon && closingSoon.length > 0) {
    const rows = closingSoon.map(c => {
      const days = c.daysUntil <= 0 ? 'today' : c.daysUntil === 1 ? '1 day' : `${c.daysUntil} days`;
      const name = c.sourceUrl
        ? `<a href="${escapeHtml(c.sourceUrl)}" style="color:#14181c;font-weight:600;text-decoration:none;">${escapeHtml(c.name)}</a>`
        : `<span style="font-weight:600;color:#14181c;">${escapeHtml(c.name)}</span>`;
      return `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #eef2f5;font-size:12px;">${name}</td>
        <td style="padding:6px 0;border-bottom:1px solid #eef2f5;font-size:12px;color:#64717b;text-align:right;${MONO}">${escapeHtml(c.amount || '')}</td>
        <td style="padding:6px 0 6px 14px;border-bottom:1px solid #eef2f5;font-size:12px;color:#b45309;font-weight:800;text-align:right;white-space:nowrap;${MONO}">${days}</td>
      </tr>`;
    }).join('');
    closingHtml = `
      ${sectionLabel(`Closing soon · approved (${closingSoon.length})`)}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table>`;
    closingText = `\nCLOSING SOON (${closingSoon.length})\n` + closingSoon.map(c =>
      `  [${c.wire}] ${c.name} — ${c.deadline} (in ${c.daysUntil}d)${c.amount ? ` | ${c.amount}` : ''}`
    ).join('\n') + '\n';
  }

  // ── 5. BD leads (Wednesdays) ─────────────────────────────────────────
  let bdHtml = '';
  let bdText = '';
  if (bdLeads && bdLeads.length > 0) {
    const lines = bdLeads.map(l => {
      const title = l.source
        ? `<a href="${escapeHtml(l.source)}" style="color:#0b86d1;text-decoration:none;font-weight:700;">${escapeHtml(l.lead)}</a>`
        : `<span style="font-weight:700;color:#14181c;">${escapeHtml(l.lead)}</span>`;
      const note = l.notes ? `<div style="margin-top:5px;color:#64717b;font-size:12px;">${escapeHtml(l.notes.slice(0, 140))}</div>` : '';
      return `<div style="border:1px solid #e2e8ed;border-radius:5px;padding:11px 12px;margin:0 0 8px;">${title}${note}</div>`;
    }).join('');
    bdHtml = `
      ${sectionLabel(`BD leads (${bdLeads.length})`)}
      ${lines}
      ${bdLeadsUrl ? emailBtn(bdLeadsUrl, 'Triage in Notion') : ''}`;
    bdText = `\nBD LEADS - VERIFIED, NOT CONTACTED (${bdLeads.length})\n` + bdLeads.map(l =>
      `  ${l.lead}${l.notes ? ` | ${l.notes.slice(0, 110)}` : ''}${l.source ? `\n    ${l.source}` : ''}`
    ).join('\n') + (bdLeadsUrl ? `\n  Triage: ${bdLeadsUrl}` : '') + '\n';
  }

  const body = `
    ${bandHtml}
    <div style="padding:0 24px 20px;">
      ${issuesHtml}
      ${reviewHtml}
      ${closingHtml}
      ${bdHtml}
      <p style="margin:20px 0 0;font-size:11px;color:#a6b1b9;"><a href="${escapeHtml(base)}" style="color:#a6b1b9;">Dashboard</a> &middot; backlog, sources, and cost detail live there.</p>
    </div>`;

  const html = dailyDigestShell(`WireOps - ${digest.date}`, slugDate, body);

  const newPart = freshCount > 0 ? `${freshCount} new for review` : 'nothing new';
  const subject = issueCount > 0
    ? `⚠ ${subjDate} — ${issueCount} issue${issueCount === 1 ? '' : 's'} · ${freshCount > 0 ? `${freshCount} new` : 'nothing new'}`
    : `${subjDate} — ${newPart} · run clean`;

  const text = `WIREOPS - ${digest.date}
${bandText}
${issuesText}${reviewText}${closingText}${bdText}
Dashboard: ${base}

---
${brand.name}`;

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
