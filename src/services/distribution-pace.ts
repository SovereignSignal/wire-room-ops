import type { PoolClient } from 'pg';
import { getAppState, getPool } from '../db';

export const PACE_STATE_KEY = 'distribution:pace';

export interface DistributionPace {
  enabled: boolean;
  intervalMinutes: number;
  timezone: string;
  quietHours: { start: string; end: string };
  dailyCap: number | null;
  paused: boolean;
}

export const DEFAULT_PACE: DistributionPace = {
  enabled: false,
  intervalMinutes: 20,
  timezone: 'America/Los_Angeles',
  quietHours: { start: '22:00', end: '08:00' },
  dailyCap: null,
  paused: false,
};

export interface QuietWindow {
  start: string;
  end: string;
  timezone: string;
}

export interface SlotEntry {
  id: number;
  targets: string[];
}

export interface SlotClock {
  now: Date;
  intervalMinutes: number;
  booked: Map<string, Date[]>;
  lastSent: Map<string, Date | null>;
  /** Phase 1 passes null. Quiet hours are stored on the pace record and not applied yet. */
  quiet: QuietWindow | null;
}

const UNCONFIGURED = 'unconfigured';

export function normalizePace(value: unknown): DistributionPace {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const interval = Number(raw.intervalMinutes);
  const quiet = raw.quietHours && typeof raw.quietHours === 'object'
    ? raw.quietHours as Record<string, unknown>
    : null;
  const cap = raw.dailyCap === null || raw.dailyCap === undefined ? null : Number(raw.dailyCap);
  return {
    enabled: raw.enabled === true,
    intervalMinutes: Number.isFinite(interval) ? Math.min(180, Math.max(1, Math.round(interval))) : DEFAULT_PACE.intervalMinutes,
    timezone: typeof raw.timezone === 'string' && raw.timezone.trim() ? raw.timezone.trim() : DEFAULT_PACE.timezone,
    quietHours: {
      start: typeof quiet?.start === 'string' ? quiet.start : DEFAULT_PACE.quietHours.start,
      end: typeof quiet?.end === 'string' ? quiet.end : DEFAULT_PACE.quietHours.end,
    },
    dailyCap: cap !== null && Number.isFinite(cap) && cap > 0 ? Math.round(cap) : null,
    paused: raw.paused === true,
  };
}

export async function getDistributionPace(): Promise<DistributionPace> {
  return normalizePace(await getAppState(PACE_STATE_KEY));
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour, minute: Number(parts.minute) };
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - date.getTime();
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const utc = new Date(guess.getTime() - zoneOffsetMs(guess, timeZone));
  return new Date(guess.getTime() - zoneOffsetMs(utc, timeZone));
}

function isQuiet(date: Date, quiet: QuietWindow): boolean {
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === null || end === null || start === end) return false;
  const parts = zonedParts(date, quiet.timezone);
  const minute = parts.hour * 60 + parts.minute;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

function pushOutOfQuiet(date: Date, quiet: QuietWindow | null): Date {
  if (!quiet || !isQuiet(date, quiet)) return date;
  const end = parseClock(quiet.end);
  const start = parseClock(quiet.start);
  if (end === null || start === null) return date;
  const parts = zonedParts(date, quiet.timezone);
  let year = parts.year;
  let month = parts.month;
  let day = parts.day;
  const minute = parts.hour * 60 + parts.minute;
  if (start > end && minute >= start) {
    const next = new Date(Date.UTC(year, month - 1, day));
    next.setUTCDate(next.getUTCDate() + 1);
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  return zonedTimeToUtc(year, month, day, Math.floor(end / 60), end % 60, quiet.timezone);
}

/** Next time a chat can take a post. bookedAt values are slots already taken. */
export function nextSlot(args: {
  now: Date;
  intervalMinutes: number;
  bookedAt: Date[];
  lastSentAt: Date | null;
  quiet: QuietWindow | null;
}): Date {
  let slot = new Date(args.now.getTime());
  if (args.lastSentAt) {
    const afterSend = addMinutes(args.lastSentAt, args.intervalMinutes);
    if (afterSend > slot) slot = afterSend;
  }
  if (args.bookedAt.length) {
    const latest = args.bookedAt.reduce((max, booked) => booked > max ? booked : max);
    const afterBooked = addMinutes(latest, args.intervalMinutes);
    if (afterBooked > slot) slot = afterBooked;
  }
  return pushOutOfQuiet(slot, args.quiet);
}

/** Assign send times in entry order. An entry on several chats takes the later slot and books every chat. */
export function assignSlots(entries: SlotEntry[], clock: SlotClock): { id: number; at: Date }[] {
  const booked = new Map<string, Date[]>([...clock.booked].map(([target, slots]) => [target, [...slots]]));
  const assigned: { id: number; at: Date }[] = [];
  for (const entry of entries) {
    const targets = entry.targets.length ? entry.targets : [UNCONFIGURED];
    let slot = new Date(0);
    for (const target of targets) {
      const next = nextSlot({
        now: clock.now,
        intervalMinutes: clock.intervalMinutes,
        bookedAt: booked.get(target) ?? [],
        lastSentAt: clock.lastSent.get(target) ?? null,
        quiet: clock.quiet,
      });
      if (next > slot) slot = next;
    }
    for (const target of targets) {
      const slots = booked.get(target) ?? [];
      slots.push(slot);
      booked.set(target, slots);
    }
    assigned.push({ id: entry.id, at: slot });
  }
  return assigned;
}

interface ChannelTarget {
  targetId: string;
  wire: string;
}

function wiresOf(entry: { wire: string; wires: string[] | null }): Set<string> {
  return new Set([entry.wire, ...(entry.wires ?? [])].filter(wire => typeof wire === 'string' && wire.length > 0));
}

function targetsFor(entry: { wire: string; wires: string[] | null }, channels: ChannelTarget[]): string[] {
  const wires = wiresOf(entry);
  return [...new Set(channels.filter(channel => wires.has(channel.wire)).map(channel => channel.targetId))];
}

export async function bookPacedQueue(
  client: PoolClient,
  entries: { id: number; wire: string; wires: string[] | null }[],
  intervalMinutes: number,
): Promise<void> {
  if (!entries.length) return;
  await client.query('LOCK TABLE publication_queue IN SHARE ROW EXCLUSIVE MODE');
  const channels = (await client.query(
    `SELECT target_id, wire FROM distribution_channels
     WHERE enabled AND channel = 'telegram' AND target_id <> ''`,
  )).rows as { target_id: string; wire: string }[];
  const channelTargets = channels.map(row => ({ targetId: row.target_id, wire: row.wire }));
  const bookedRows = (await client.query(
    `SELECT dc.target_id, q.available_at
     FROM publication_queue q
     JOIN scan_entries se ON se.id = q.entry_id
     JOIN distribution_channels dc
       ON dc.enabled AND dc.channel = 'telegram' AND dc.target_id <> ''
      AND (dc.wire = se.wire OR dc.wire = ANY(COALESCE(se.wires, ARRAY[]::text[])))
     WHERE q.status = 'queued'`,
  )).rows as { target_id: string; available_at: Date }[];
  const sentRows = (await client.query(
    `SELECT dc.target_id, MAX(dl.sent_at) AS sent_at
     FROM distribution_logs dl
     JOIN distribution_channels dc ON dc.id = dl.channel_id
     WHERE dl.channel = 'telegram' AND dl.status = 'success' AND dl.sent_at IS NOT NULL
       AND dc.enabled AND dc.channel = 'telegram'
     GROUP BY dc.target_id`,
  )).rows as { target_id: string; sent_at: Date }[];
  const booked = new Map<string, Date[]>();
  for (const row of bookedRows) {
    const slots = booked.get(row.target_id) ?? [];
    slots.push(new Date(row.available_at));
    booked.set(row.target_id, slots);
  }
  const lastSent = new Map<string, Date | null>(sentRows.map(row => [row.target_id, new Date(row.sent_at)]));
  const assigned = assignSlots(
    entries.map(entry => ({ id: entry.id, targets: targetsFor(entry, channelTargets) })),
    { now: new Date(), intervalMinutes, booked, lastSent, quiet: null },
  );
  await client.query(
    `INSERT INTO publication_queue (entry_id, available_at)
     SELECT id, at FROM unnest($1::int[], $2::timestamptz[]) AS t(id, at)
     ON CONFLICT (entry_id) DO UPDATE
       SET status = 'queued', attempts = 0, available_at = EXCLUDED.available_at,
           lease_token = NULL, lease_expires_at = NULL, error_message = NULL, updated_at = NOW()`,
    [assigned.map(row => row.id), assigned.map(row => row.at.toISOString())],
  );
}

/**
 * True when an enabled Telegram destination on the entry's wires has no claim or receipt.
 * Expects scan_entries as `se`. A success row with no channel_id is a send from before
 * managed channels recorded which one they used, so it settles its wire.
 */
export const UNSENT_TELEGRAM_DESTINATION_SQL = `EXISTS (
  SELECT 1 FROM distribution_channels dc
  WHERE dc.enabled AND dc.channel = 'telegram' AND dc.target_id <> ''
    AND (dc.wire = se.wire OR dc.wire = ANY(COALESCE(se.wires, ARRAY[]::text[])))
    AND NOT EXISTS (
      SELECT 1 FROM distribution_logs dl
      WHERE dl.entry_id = se.id
        AND dl.wire = dc.wire
        AND dl.channel = 'telegram'
        AND (
          (dl.channel_id = dc.id AND dl.status IN ('pending', 'success'))
          OR (dl.channel_id IS NULL AND dl.status = 'success')
        )
    )
)`;

export interface OutgoingItem {
  entryId: number;
  name: string;
  wire: string;
  state: 'scheduled' | 'due' | 'sending' | 'needs review' | 'retry wait' | 'withheld' | 'missing';
  availableAt: string | null;
  createdAt: string | null;
  errorMessage: string | null;
  externalId: string | null;
  attempts: number | null;
}

export interface SentItem {
  entryId: number;
  name: string;
  wire: string;
  externalId: string | null;
  sentAt: string | null;
  claimedAt: string | null;
}

export interface OutgoingSnapshot {
  pace: DistributionPace;
  banner: string;
  note: string;
  counts: {
    scheduled: number;
    due: number;
    sending: number;
    retryWait: number;
    withheld: number;
    needsReview: number;
    missing: number;
    waiting: number;
  };
  items: OutgoingItem[];
  sent: SentItem[];
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function queueState(row: { status: string; available_at: Date; error_message: string | null }, now: Date): OutgoingItem['state'] {
  if (row.status === 'withheld') return 'withheld';
  if (row.status === 'running') return 'sending';
  if (row.status === 'review') return 'needs review';
  const available = new Date(row.available_at);
  if (row.error_message && available > now) return 'retry wait';
  if (available > now) return 'scheduled';
  return 'due';
}

function formatWhen(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export async function listOutgoing(sentSince?: Date): Promise<OutgoingSnapshot> {
  const pool = getPool();
  const pace = await getDistributionPace();
  const since = sentSince ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const now = new Date();
  const [queued, missing, blankReceipts, sent] = await Promise.all([
    pool.query(
      `SELECT q.entry_id, q.status, q.available_at, q.created_at, q.error_message, q.attempts,
              se.name, se.wire
       FROM publication_queue q
       JOIN scan_entries se ON se.id = q.entry_id
       WHERE q.status <> 'done'
       ORDER BY q.available_at, q.entry_id`,
    ),
    pool.query(
      `SELECT se.id AS entry_id, se.name, se.wire, se.updated_at, COUNT(*) OVER () AS total
       FROM scan_entries se
       WHERE se.status = 'approved'
         AND se.distributable IS NOT FALSE
         AND NOT EXISTS (
           SELECT 1 FROM publication_queue q
           WHERE q.entry_id = se.id
             AND q.status IN ('queued', 'running', 'review', 'withheld')
         )
         AND ${UNSENT_TELEGRAM_DESTINATION_SQL}
       ORDER BY se.updated_at DESC
       LIMIT 50`,
    ),
    pool.query(
      `SELECT dl.entry_id, se.name, dl.wire, dl.created_at
       FROM distribution_logs dl
       JOIN scan_entries se ON se.id = dl.entry_id
       WHERE dl.channel = 'telegram' AND dl.status = 'success' AND dl.external_id IS NULL
         AND se.status = 'approved'
       ORDER BY dl.created_at DESC
       LIMIT 50`,
    ),
    pool.query(
      `SELECT dl.entry_id, se.name, dl.wire, dl.external_id, dl.sent_at, dl.created_at
       FROM distribution_logs dl
       JOIN scan_entries se ON se.id = dl.entry_id
       WHERE dl.channel = 'telegram' AND dl.status = 'success' AND dl.external_id IS NOT NULL
         AND COALESCE(dl.sent_at, dl.created_at) >= $1
       ORDER BY COALESCE(dl.sent_at, dl.created_at) DESC
       LIMIT 50`,
      [since],
    ),
  ]);

  const items: OutgoingItem[] = queued.rows.map(row => ({
    entryId: Number(row.entry_id),
    name: row.name,
    wire: row.wire,
    state: queueState(row, now),
    availableAt: row.status === 'withheld' ? null : iso(row.available_at),
    createdAt: iso(row.created_at),
    errorMessage: row.error_message,
    externalId: null,
    attempts: Number(row.attempts),
  }));
  const seen = new Set(items.map(item => item.entryId));
  for (const row of blankReceipts.rows) {
    const entryId = Number(row.entry_id);
    if (seen.has(entryId)) continue;
    seen.add(entryId);
    items.push({
      entryId,
      name: row.name,
      wire: row.wire,
      state: 'needs review',
      availableAt: null,
      createdAt: iso(row.created_at),
      errorMessage: 'Telegram receipt has no message id',
      externalId: null,
      attempts: null,
    });
  }
  for (const row of missing.rows) {
    const entryId = Number(row.entry_id);
    if (seen.has(entryId)) continue;
    seen.add(entryId);
    items.push({
      entryId,
      name: row.name,
      wire: row.wire,
      state: 'missing',
      availableAt: null,
      createdAt: iso(row.updated_at),
      errorMessage: 'Approved and not sent, and not on the publication queue',
      externalId: null,
      attempts: null,
    });
  }

  const counts = {
    scheduled: items.filter(item => item.state === 'scheduled').length,
    due: items.filter(item => item.state === 'due').length,
    sending: items.filter(item => item.state === 'sending').length,
    retryWait: items.filter(item => item.state === 'retry wait').length,
    withheld: items.filter(item => item.state === 'withheld').length,
    needsReview: items.filter(item => item.state === 'needs review').length,
    missing: Number(missing.rows[0]?.total ?? 0),
    waiting: 0,
  };
  counts.waiting = counts.scheduled + counts.due + counts.retryWait;

  const next = queued.rows.find(row => row.status === 'queued');
  let banner = 'Pacing off — approvals publish immediately';
  if (pace.enabled) {
    const when = next ? formatWhen(new Date(next.available_at), pace.timezone) : 'nothing queued';
    const wire = next ? ` · ${next.wire}` : '';
    const paused = pace.paused ? ' · paused' : '';
    banner = `Next post ${when}${wire} · ${counts.waiting} scheduled${paused}`;
  }

  return {
    pace,
    banner,
    note: pace.enabled
      ? `Posts are spaced ${pace.intervalMinutes} minutes apart per Telegram chat. Quiet hours are saved and not applied yet.`
      : 'The outgoing list is live. Pacing stays off until it is turned on, so this deploy does not change the channel.',
    counts,
    items,
    sent: sent.rows.map(row => ({
      entryId: Number(row.entry_id),
      name: row.name,
      wire: row.wire,
      externalId: row.external_id,
      sentAt: iso(row.sent_at),
      claimedAt: iso(row.created_at),
    })),
  };
}
