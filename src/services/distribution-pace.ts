import type { PoolClient } from 'pg';
import { getAppState, getPool, setAppState } from '../db';

export const PACE_STATE_KEY = 'distribution:pace';

export interface DistributionPace {
  enabled: boolean;
  intervalMinutes: number;
  timezone: string;
  /** Null means posts may send at any hour. */
  quietHours: { start: string; end: string } | null;
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
  quiet: QuietWindow | null;
  dailyCap?: number | null;
  timezone?: string;
  sentToday?: Map<string, number>;
}

export interface PaceRules {
  now: Date;
  intervalMinutes: number;
  quiet: QuietWindow | null;
  dailyCap: number | null;
  timezone: string;
}

/** Notes the worker writes when it pushes a row. A real send error is left alone. */
export const PACE_HOLD_REASONS = ['quiet hours', 'daily cap'] as const;

export interface PaceChange {
  at: string;
  actor: string;
  summary: string;
  from: DistributionPace;
  to: DistributionPace;
}

export const PACE_LOG_KEY = 'distribution:pace:log';
const PACE_LOG_LIMIT = 40;

export class PaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaceValidationError';
  }
}

const UNCONFIGURED = 'unconfigured';

export function isIanaTimeZone(value: string): boolean {
  if (!value || value.length > 100) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** HH:MM, hour padded. Returns null when the text is not a clock time. */
export function normalizeClock(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function readQuietHours(value: unknown): DistributionPace['quietHours'] {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return { ...DEFAULT_PACE.quietHours! };
  const start = normalizeClock((value as { start?: unknown }).start);
  const end = normalizeClock((value as { end?: unknown }).end);
  if (!start || !end || start === end) return { ...DEFAULT_PACE.quietHours! };
  return { start, end };
}

export function normalizePace(value: unknown): DistributionPace {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const interval = Number(raw.intervalMinutes);
  const cap = raw.dailyCap === null || raw.dailyCap === undefined ? null : Number(raw.dailyCap);
  const timezone = typeof raw.timezone === 'string' ? raw.timezone.trim() : '';
  return {
    enabled: raw.enabled === true,
    intervalMinutes: Number.isFinite(interval) ? Math.min(180, Math.max(1, Math.round(interval))) : DEFAULT_PACE.intervalMinutes,
    timezone: isIanaTimeZone(timezone) ? timezone : DEFAULT_PACE.timezone,
    quietHours: readQuietHours(raw.quietHours),
    dailyCap: cap !== null && Number.isFinite(cap) && cap > 0 ? Math.round(cap) : null,
    paused: raw.paused === true,
  };
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new PaceValidationError(`${field} must be true or false`);
  return value;
}

/**
 * Merge a settings PUT onto the current pace. intervalMinutes is clamped to 1–180.
 * timezone, quiet hours, daily cap, and the two switches are rejected when they are the wrong shape.
 */
export function parsePaceUpdate(body: unknown, current: DistributionPace): DistributionPace {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PaceValidationError('Pace settings must be an object');
  }
  const raw = body as Record<string, unknown>;
  const next: DistributionPace = {
    ...current,
    quietHours: current.quietHours ? { ...current.quietHours } : null,
  };
  if ('enabled' in raw) next.enabled = requireBoolean(raw.enabled, 'enabled');
  if ('paused' in raw) next.paused = requireBoolean(raw.paused, 'paused');
  if ('intervalMinutes' in raw) {
    const interval = raw.intervalMinutes;
    if (typeof interval !== 'number' || !Number.isFinite(interval)) {
      throw new PaceValidationError('intervalMinutes must be a number of minutes');
    }
    next.intervalMinutes = Math.min(180, Math.max(1, Math.round(interval)));
  }
  if ('timezone' in raw) {
    if (typeof raw.timezone !== 'string' || !isIanaTimeZone(raw.timezone.trim())) {
      throw new PaceValidationError('timezone must be an IANA time zone, such as America/Los_Angeles');
    }
    next.timezone = raw.timezone.trim();
  }
  if ('quietHours' in raw) {
    if (raw.quietHours === null) {
      next.quietHours = null;
    } else if (!raw.quietHours || typeof raw.quietHours !== 'object' || Array.isArray(raw.quietHours)) {
      throw new PaceValidationError('quietHours must be { start, end } as HH:MM, or null');
    } else {
      const start = normalizeClock((raw.quietHours as { start?: unknown }).start);
      const end = normalizeClock((raw.quietHours as { end?: unknown }).end);
      if (!start || !end) throw new PaceValidationError('quietHours start and end must be HH:MM, or the whole window null');
      if (start === end) throw new PaceValidationError('quietHours start and end must be different');
      next.quietHours = { start, end };
    }
  }
  if ('dailyCap' in raw) {
    if (raw.dailyCap === null) {
      next.dailyCap = null;
    } else if (typeof raw.dailyCap !== 'number' || !Number.isInteger(raw.dailyCap) || raw.dailyCap < 1) {
      throw new PaceValidationError('dailyCap must be a positive whole number, or null for no cap');
    } else {
      next.dailyCap = raw.dailyCap;
    }
  }
  return next;
}

export function paceEqual(a: DistributionPace, b: DistributionPace): boolean {
  return JSON.stringify(normalizePace(a)) === JSON.stringify(normalizePace(b));
}

function paceSummary(from: DistributionPace, to: DistributionPace): string {
  const bits: string[] = [];
  if (from.enabled !== to.enabled) bits.push(to.enabled ? 'Turned pacing on' : 'Turned pacing off');
  if (from.paused !== to.paused) bits.push(to.paused ? 'Paused the stream' : 'Resumed the stream');
  if (from.intervalMinutes !== to.intervalMinutes) bits.push(`Interval ${to.intervalMinutes} minutes`);
  const quiet = to.quietHours ? `${to.quietHours.start}–${to.quietHours.end}` : 'off';
  const previousQuiet = from.quietHours ? `${from.quietHours.start}–${from.quietHours.end}` : 'off';
  if (quiet !== previousQuiet || from.timezone !== to.timezone) {
    bits.push(`Quiet hours ${quiet} (${to.timezone})`);
  }
  if (from.dailyCap !== to.dailyCap) bits.push(to.dailyCap ? `Daily cap ${to.dailyCap} per chat` : 'Daily cap off');
  if (!bits.length) bits.push('Saved pace settings');
  return bits.join('. ');
}

export async function saveDistributionPace(next: DistributionPace, actor: string): Promise<{ pace: DistributionPace; changed: boolean }> {
  const previous = await getDistributionPace();
  const stored = normalizePace(next);
  if (paceEqual(previous, stored)) return { pace: previous, changed: false };
  await setAppState(PACE_STATE_KEY, stored);
  const change: PaceChange = {
    at: new Date().toISOString(),
    actor,
    summary: paceSummary(previous, stored),
    from: previous,
    to: stored,
  };
  const prior = await getAppState<PaceChange[]>(PACE_LOG_KEY);
  const log = Array.isArray(prior) ? prior : [];
  await setAppState(PACE_LOG_KEY, [change, ...log].slice(0, PACE_LOG_LIMIT));
  console.log(`[Distribution] Pace settings changed by ${actor} at ${change.at}: ${change.summary}. ${JSON.stringify(previous)} -> ${JSON.stringify(stored)}`);
  return { pace: stored, changed: true };
}

export async function listPaceChanges(): Promise<PaceChange[]> {
  const prior = await getAppState<PaceChange[]>(PACE_LOG_KEY);
  return Array.isArray(prior) ? prior : [];
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

function dayKey(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addDaysKey(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + days));
  return next.toISOString().slice(0, 10);
}

/** Local midnight to the next local midnight. A DST day is 23 or 25 hours. */
export function zonedDayBounds(now: Date, timeZone: string): { start: Date; end: Date; key: string } {
  const key = dayKey(now, timeZone);
  const [year, month, date] = key.split('-').map(Number);
  const start = zonedTimeToUtc(year, month, date, 0, 0, timeZone);
  const next = addDaysKey(key, 1).split('-').map(Number);
  const end = zonedTimeToUtc(next[0], next[1], next[2], 0, 0, timeZone);
  return { start, end, key };
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
  // A quiet end that falls in a DST gap is not a real local time. Walk forward
  // until the instant is outside the window so the morning slot is sendable.
  let candidate = zonedTimeToUtc(year, month, day, Math.floor(end / 60), end % 60, quiet.timezone);
  for (let step = 0; step < 180 && isQuiet(candidate, quiet); step++) {
    candidate = addMinutes(candidate, 1);
  }
  return candidate;
}

function firstOpenOfDay(day: string, rules: PaceRules): Date {
  const [year, month, date] = day.split('-').map(Number);
  const midnight = zonedTimeToUtc(year, month, date, 0, 0, rules.timezone);
  return pushOutOfQuiet(midnight, rules.quiet);
}

export function quietWindowOf(pace: DistributionPace): QuietWindow | null {
  if (!pace.quietHours) return null;
  return { start: pace.quietHours.start, end: pace.quietHours.end, timezone: pace.timezone };
}

export function paceRules(pace: DistributionPace, now: Date): PaceRules {
  return {
    now,
    intervalMinutes: pace.intervalMinutes,
    quiet: quietWindowOf(pace),
    dailyCap: pace.dailyCap,
    timezone: pace.timezone,
  };
}

function fitForward(
  at: Date,
  previous: Date | null,
  dayCount: Map<string, number>,
  rules: PaceRules,
): { at: Date; reason: 'quiet hours' | 'daily cap' | null } {
  let cursor = new Date(at.getTime());
  let reason: 'quiet hours' | 'daily cap' | null = null;
  for (let step = 0; step < 500; step++) {
    if (rules.quiet && isQuiet(cursor, rules.quiet)) {
      cursor = pushOutOfQuiet(cursor, rules.quiet);
      if (reason !== 'daily cap') reason = 'quiet hours';
      continue;
    }
    if (previous && cursor.getTime() <= previous.getTime()) {
      cursor = addMinutes(previous, rules.intervalMinutes);
      continue;
    }
    if (rules.dailyCap && rules.dailyCap > 0) {
      const day = dayKey(cursor, rules.timezone);
      if ((dayCount.get(day) ?? 0) >= rules.dailyCap) {
        cursor = firstOpenOfDay(addDaysKey(day, 1), rules);
        reason = 'daily cap';
        continue;
      }
    }
    return { at: cursor, reason };
  }
  return { at: cursor, reason };
}

/**
 * Place one chat's queued rows in their current order.
 * Future rows keep their time unless quiet hours or the daily cap push them later.
 * Overdue rows catch up one interval apart, and never inside a quiet window.
 */
export function planChat(
  rows: { id: number; at: Date }[],
  sentToday: number,
  rules: PaceRules,
  floors: Map<number, Date> = new Map(),
): { id: number; at: Date; reason: 'quiet hours' | 'daily cap' | null }[] {
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
  const dayCount = new Map<string, number>();
  if (sentToday > 0) dayCount.set(dayKey(rules.now, rules.timezone), sentToday);
  const planned: { id: number; at: Date; reason: 'quiet hours' | 'daily cap' | null }[] = [];
  let previous: Date | null = null;
  let previousReason: 'quiet hours' | 'daily cap' | null = null;
  const quietNow = !!(rules.quiet && isQuiet(rules.now, rules.quiet));

  for (const row of sorted) {
    const overdue = row.at.getTime() <= rules.now.getTime();
    let desired: Date;
    if (overdue) {
      desired = previous ? addMinutes(previous, rules.intervalMinutes) : new Date(rules.now.getTime());
    } else {
      desired = new Date(row.at.getTime());
      if (previous && desired.getTime() <= previous.getTime()) desired = addMinutes(previous, rules.intervalMinutes);
    }
    const floor = floors.get(row.id);
    if (floor && desired.getTime() < floor.getTime()) desired = new Date(floor.getTime());
    const fitted = fitForward(desired, previous, dayCount, rules);
    let reason = fitted.reason;
    if (!reason && fitted.at.getTime() > row.at.getTime() + 1000) {
      if (quietNow && overdue) reason = 'quiet hours';
      else if (previousReason) reason = previousReason;
    }
    planned.push({ id: row.id, at: fitted.at, reason });
    previous = fitted.at;
    previousReason = reason;
    const day = dayKey(fitted.at, rules.timezone);
    dayCount.set(day, (dayCount.get(day) ?? 0) + 1);
  }
  return planned;
}

/** One timestamp per row. A row on several chats takes the later chat's time so neither chat bursts. */
export function planQueue(
  rows: { id: number; at: Date; targets: string[] }[],
  sentToday: Map<string, number>,
  rules: PaceRules,
): { id: number; at: Date; reason: 'quiet hours' | 'daily cap' | null }[] {
  if (!rows.length) return [];
  const normalized = rows.map(row => ({
    id: row.id,
    at: row.at,
    targets: row.targets.length ? row.targets : [UNCONFIGURED],
  }));
  const targets = [...new Set(normalized.flatMap(row => row.targets))];
  const at = new Map(normalized.map(row => [row.id, new Date(row.at.getTime())]));
  const reason = new Map<number, 'quiet hours' | 'daily cap' | null>();
  const floors = new Map<number, Date>();

  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const target of targets) {
      const subset = normalized.filter(row => row.targets.includes(target)).map(row => ({ id: row.id, at: row.at }));
      for (const item of planChat(subset, sentToday.get(target) ?? 0, rules, floors)) {
        const current = at.get(item.id)!;
        if (item.at.getTime() > current.getTime() + 500) {
          at.set(item.id, item.at);
          floors.set(item.id, item.at);
          moved = true;
        }
        if (item.reason) reason.set(item.id, item.reason);
      }
    }
    if (!moved) break;
  }

  return normalized.map(row => ({ id: row.id, at: at.get(row.id)!, reason: reason.get(row.id) ?? null }));
}

function placeOnChat(args: {
  now: Date;
  intervalMinutes: number;
  bookedAt: Date[];
  lastSentAt: Date | null;
  quiet: QuietWindow | null;
  dailyCap?: number | null;
  sentToday?: number;
  timezone?: string;
}): { at: Date; reason: 'quiet hours' | 'daily cap' | null } {
  const timezone = args.timezone || args.quiet?.timezone || DEFAULT_PACE.timezone;
  const rules: PaceRules = {
    now: args.now,
    intervalMinutes: args.intervalMinutes,
    quiet: args.quiet,
    dailyCap: args.dailyCap ?? null,
    timezone,
  };
  const sentToday = args.sentToday ?? 0;
  const projected = planQueue(
    args.bookedAt.map((at, index) => ({ id: index + 1, at, targets: ['chat'] })),
    new Map([['chat', sentToday]]),
    rules,
  ).map(row => row.at);
  const previous = projected.reduce<Date | null>((max, at) => max === null || at > max ? at : max, null);
  let desired = new Date(args.now.getTime());
  if (args.lastSentAt) {
    const afterSend = addMinutes(args.lastSentAt, args.intervalMinutes);
    if (afterSend > desired) desired = afterSend;
  }
  if (previous) {
    const afterBooked = addMinutes(previous, args.intervalMinutes);
    if (afterBooked > desired) desired = afterBooked;
  }
  const dayCount = new Map<string, number>();
  if (sentToday > 0) dayCount.set(dayKey(args.now, timezone), sentToday);
  for (const at of projected) {
    const day = dayKey(at, timezone);
    dayCount.set(day, (dayCount.get(day) ?? 0) + 1);
  }
  return fitForward(desired, previous, dayCount, rules);
}

/** Next time a chat can take a post. bookedAt values are slots already taken. */
export function nextSlot(args: {
  now: Date;
  intervalMinutes: number;
  bookedAt: Date[];
  lastSentAt: Date | null;
  quiet: QuietWindow | null;
  dailyCap?: number | null;
  sentToday?: number;
  timezone?: string;
}): Date {
  return placeOnChat(args).at;
}

/** Assign send times in entry order. An entry on several chats takes the later slot and books every chat. */
export function assignSlots(entries: SlotEntry[], clock: SlotClock): { id: number; at: Date; reason: 'quiet hours' | 'daily cap' | null }[] {
  const booked = new Map<string, Date[]>([...clock.booked].map(([target, slots]) => [target, [...slots]]));
  const assigned: { id: number; at: Date; reason: 'quiet hours' | 'daily cap' | null }[] = [];
  for (const entry of entries) {
    const targets = entry.targets.length ? entry.targets : [UNCONFIGURED];
    let slot = new Date(0);
    let reason: 'quiet hours' | 'daily cap' | null = null;
    for (const target of targets) {
      const next = placeOnChat({
        now: clock.now,
        intervalMinutes: clock.intervalMinutes,
        bookedAt: booked.get(target) ?? [],
        lastSentAt: clock.lastSent.get(target) ?? null,
        quiet: clock.quiet,
        dailyCap: clock.dailyCap ?? null,
        sentToday: clock.sentToday?.get(target) ?? 0,
        timezone: clock.timezone || clock.quiet?.timezone,
      });
      if (next.at > slot) {
        slot = next.at;
        reason = next.reason;
      } else if (next.at.getTime() === slot.getTime() && next.reason) {
        reason = next.reason;
      }
    }
    for (const target of targets) {
      const slots = booked.get(target) ?? [];
      slots.push(slot);
      booked.set(target, slots);
    }
    assigned.push({ id: entry.id, at: slot, reason });
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

export function mergeQueueNote(current: string | null, reason: string | null): string | null {
  const hold = current === 'quiet hours' || current === 'daily cap';
  if (reason) return hold || !current ? reason : current;
  if (hold) return null;
  return current;
}

type Queryable = { query: PoolClient['query'] };

export async function sentTodayByTarget(db: Queryable, pace: DistributionPace, now: Date): Promise<Map<string, number>> {
  const bounds = zonedDayBounds(now, pace.timezone);
  const rows = (await db.query(
    `SELECT dc.target_id, COUNT(*)::int AS sent
     FROM distribution_logs dl
     JOIN distribution_channels dc ON dc.id = dl.channel_id
     WHERE dl.channel = 'telegram' AND dl.status = 'success' AND dl.sent_at IS NOT NULL
       AND dl.sent_at >= $1 AND dl.sent_at < $2
       AND dc.enabled AND dc.channel = 'telegram'
     GROUP BY dc.target_id`,
    [bounds.start.toISOString(), bounds.end.toISOString()],
  )).rows as { target_id: string; sent: number }[];
  return new Map(rows.map(row => [row.target_id, Number(row.sent)]));
}

export async function bookPacedQueue(
  client: PoolClient,
  entries: { id: number; wire: string; wires: string[] | null }[],
  pace: DistributionPace,
  posts?: Map<number, { postText: string; generatedAt: string; model: string | null; checkResult: unknown; verifierResult: unknown }>,
): Promise<void> {
  if (!entries.length) return;
  // Share-row-exclusive is self-exclusive, so two bookings cannot both read an empty chat and take the same slot.
  await client.query('LOCK TABLE publication_queue IN SHARE ROW EXCLUSIVE MODE');
  const now = new Date();
  const channels = (await client.query(
    `SELECT target_id, wire FROM distribution_channels
     WHERE enabled AND channel = 'telegram' AND target_id <> ''`,
  )).rows as { target_id: string; wire: string }[];
  const channelTargets = channels.map(row => ({ targetId: row.target_id, wire: row.wire }));
  const entryIds = entries.map(entry => entry.id);
  // A running row is an in-flight send. Its available_at is already in the past, so count it as occupying the chat now.
  // Rows in this batch are excluded, or a re-book would space the entry after itself.
  const bookedRows = (await client.query(
    `SELECT dc.target_id, q.status,
            CASE WHEN q.status = 'running' THEN GREATEST(q.available_at, NOW())
                 ELSE q.available_at END AS available_at
     FROM publication_queue q
     JOIN scan_entries se ON se.id = q.entry_id
     JOIN distribution_channels dc
       ON dc.enabled AND dc.channel = 'telegram' AND dc.target_id <> ''
      AND (dc.wire = se.wire OR dc.wire = ANY(COALESCE(se.wires, ARRAY[]::text[])))
     WHERE q.status IN ('queued', 'running')
       AND NOT (q.entry_id = ANY($1::int[]))`,
    [entryIds],
  )).rows as { target_id: string; status: string; available_at: Date }[];
  const sentRows = (await client.query(
    `SELECT dc.target_id, MAX(COALESCE(dl.sent_at, dl.created_at)) AS sent_at
     FROM distribution_logs dl
     JOIN distribution_channels dc ON dc.id = dl.channel_id
     WHERE dl.channel = 'telegram' AND dl.status = 'success'
       AND dc.enabled AND dc.channel = 'telegram'
     GROUP BY dc.target_id`,
  )).rows as { target_id: string; sent_at: Date }[];
  const booked = new Map<string, Date[]>();
  const lastSent = new Map<string, Date | null>(sentRows.map(row => [row.target_id, new Date(row.sent_at)]));
  for (const row of bookedRows) {
    const at = new Date(row.available_at);
    const slots = booked.get(row.target_id) ?? [];
    slots.push(at);
    booked.set(row.target_id, slots);
    if (row.status === 'running') {
      const prev = lastSent.get(row.target_id);
      if (!prev || at > prev) lastSent.set(row.target_id, at);
    }
  }
  const sentToday = await sentTodayByTarget(client, pace, now);
  const assigned = assignSlots(
    entries.map(entry => ({ id: entry.id, targets: targetsFor(entry, channelTargets) })),
    {
      now,
      intervalMinutes: pace.intervalMinutes,
      booked,
      lastSent,
      quiet: quietWindowOf(pace),
      dailyCap: pace.dailyCap,
      timezone: pace.timezone,
      sentToday,
    },
  );
  const ids = assigned.map(row => row.id);
  const stored = ids.map(id => posts?.get(id));
  await client.query(
    `INSERT INTO publication_queue (
       entry_id, available_at, error_message, post_text, generated_at, model, check_result, verifier_result
     )
     SELECT id, at, NULLIF(note, ''), post_text, generated_at, model, check_result::jsonb, verifier_result::jsonb
     FROM unnest($1::int[], $2::timestamptz[], $3::text[], $4::text[], $5::timestamptz[], $6::text[], $7::text[], $8::text[])
       AS t(id, at, note, post_text, generated_at, model, check_result, verifier_result)
     ON CONFLICT (entry_id) DO UPDATE
       SET status = 'queued', attempts = 0, available_at = EXCLUDED.available_at,
           lease_token = NULL, lease_expires_at = NULL, error_message = EXCLUDED.error_message, updated_at = NOW(),
           post_text = COALESCE(EXCLUDED.post_text, publication_queue.post_text),
           generated_at = COALESCE(EXCLUDED.generated_at, publication_queue.generated_at),
           model = COALESCE(EXCLUDED.model, publication_queue.model),
           check_result = COALESCE(EXCLUDED.check_result, publication_queue.check_result),
           verifier_result = COALESCE(EXCLUDED.verifier_result, publication_queue.verifier_result)`,
    [
      ids,
      assigned.map(row => row.at.toISOString()),
      assigned.map(row => row.reason ?? ''),
      stored.map(post => post?.postText ?? null),
      stored.map(post => post?.generatedAt ?? null),
      stored.map(post => post?.model ?? null),
      stored.map(post => post ? JSON.stringify(post.checkResult) : null),
      stored.map(post => post ? JSON.stringify(post.verifierResult) : null),
    ],
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
          (dl.channel_id = dc.id AND dl.status IN ('pending', 'success', 'acknowledged'))
          OR (dl.channel_id IS NULL AND dl.status = 'success')
          OR (dl.channel_id IS NULL AND dl.status = 'acknowledged')
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
  postText: string | null;
}

export interface SentItem {
  entryId: number;
  name: string;
  wire: string;
  externalId: string | null;
  sentAt: string | null;
  claimedAt: string | null;
}

export interface OutgoingChat {
  targetId: string;
  wire: string;
  name: string;
  nextAt: string | null;
  sentToday: number;
}

export interface ProgramsOnlyItem {
  id: number;
  title: string;
  approved_at: string;
  actioned_by: string | null;
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
    programsOnly: number;
  };
  items: OutgoingItem[];
  sent: SentItem[];
  programsOnly: ProgramsOnlyItem[];
  chats: OutgoingChat[];
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
  const hold = row.error_message === 'quiet hours' || row.error_message === 'daily cap';
  if (row.error_message && !hold && available > now) return 'retry wait';
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
  const day = zonedDayBounds(now, pace.timezone);
  const [queued, missing, blankReceipts, sent, chatRows, sentTodayRows, programsOnlyRows] = await Promise.all([
    pool.query(
      `SELECT q.entry_id, q.status, q.available_at, q.created_at, q.error_message, q.attempts,
              q.post_text, se.name, se.wire, se.lifecycle
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
         AND se.lifecycle IS DISTINCT FROM 'forthcoming'
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
    pool.query(
      `SELECT dc.target_id, dc.wire, dc.name, MIN(q.available_at) AS next_at
       FROM distribution_channels dc
       LEFT JOIN scan_entries se
         ON dc.wire = se.wire OR dc.wire = ANY(COALESCE(se.wires, ARRAY[]::text[]))
       LEFT JOIN publication_queue q ON q.entry_id = se.id AND q.status = 'queued'
       WHERE dc.enabled AND dc.channel = 'telegram' AND dc.target_id <> ''
       GROUP BY dc.target_id, dc.wire, dc.name
       ORDER BY dc.wire, dc.name`,
    ),
    pool.query(
      `SELECT dc.target_id, COUNT(*)::int AS sent
       FROM distribution_logs dl
       JOIN distribution_channels dc ON dc.id = dl.channel_id
       WHERE dl.channel = 'telegram' AND dl.status = 'success' AND dl.sent_at >= $1 AND dl.sent_at < $2
         AND dc.enabled AND dc.channel = 'telegram'
       GROUP BY dc.target_id`,
      [day.start.toISOString(), day.end.toISOString()],
    ),
    pool.query(
      `SELECT se.id, se.name AS title, se.decision_at AS approved_at, se.actioned_by
       FROM scan_entries se
       WHERE se.status = 'approved'
         AND se.distributable IS FALSE
         AND se.decision_at >= NOW() - INTERVAL '7 days'
         AND NOT EXISTS (
           SELECT 1 FROM publication_queue q
           WHERE q.entry_id = se.id AND q.status = 'withheld'
         )
       ORDER BY se.decision_at DESC, se.id DESC`,
    ),
  ]);

  const items: OutgoingItem[] = queued.rows.map(row => {
    const forthcoming = row.lifecycle === 'forthcoming';
    const state = forthcoming ? 'withheld' : queueState(row, now);
    return {
      entryId: Number(row.entry_id),
      name: row.name,
      wire: row.wire,
      state,
      availableAt: row.status === 'withheld' || forthcoming ? null : iso(row.available_at),
      createdAt: iso(row.created_at),
      errorMessage: forthcoming
        ? 'Forthcoming call; held from sending'
        : (pace.enabled && pace.paused && state === 'due' && !row.error_message ? 'Paused' : row.error_message),
      externalId: null,
      attempts: Number(row.attempts),
      postText: row.post_text ?? null,
    };
  });
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
      postText: null,
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
      postText: null,
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
    programsOnly: 0,
  };
  counts.waiting = counts.scheduled + counts.due + counts.retryWait;
  const programsOnly: ProgramsOnlyItem[] = programsOnlyRows.rows.flatMap(row => {
    const approvedAt = iso(row.approved_at);
    if (!approvedAt) return [];
    return [{
      id: Number(row.id),
      title: row.title ?? '',
      approved_at: approvedAt,
      actioned_by: row.actioned_by ?? null,
    }];
  });
  counts.programsOnly = programsOnly.length;

  const sentToday = new Map<string, number>(sentTodayRows.rows.map(row => [row.target_id, Number(row.sent)]));
  const chats: OutgoingChat[] = chatRows.rows.map(row => ({
    targetId: row.target_id,
    wire: row.wire,
    name: row.name,
    nextAt: iso(row.next_at),
    sentToday: sentToday.get(row.target_id) ?? 0,
  }));
  const nextChat = chats
    .filter(chat => chat.nextAt)
    .sort((a, b) => new Date(a.nextAt!).getTime() - new Date(b.nextAt!).getTime())[0];
  const next = nextChat?.nextAt
    ? { available_at: nextChat.nextAt, wire: nextChat.wire }
    : queued.rows.find(row => row.status === 'queued');
  let banner = 'Pacing off — approvals publish immediately';
  if (pace.enabled) {
    const when = next ? formatWhen(new Date(next.available_at), pace.timezone) : 'nothing queued';
    const wire = next ? ` · ${next.wire}` : '';
    const paused = pace.paused ? ' · paused' : '';
    const quietNow = pace.quietHours && isQuiet(now, { ...pace.quietHours, timezone: pace.timezone });
    const quiet = quietNow ? ' · quiet hours' : '';
    banner = `Next post ${when}${wire} · ${counts.waiting} scheduled${paused}${quiet}`;
  }
  const quietText = pace.quietHours
    ? ` Quiet hours ${pace.quietHours.start}–${pace.quietHours.end} ${pace.timezone}.`
    : '';
  const capText = pace.dailyCap ? ` Daily cap ${pace.dailyCap} per chat.` : '';

  return {
    pace,
    banner,
    note: pace.enabled
      ? `Posts are spaced ${pace.intervalMinutes} minutes apart per Telegram chat.${quietText}${capText}${pace.paused ? ' Paused — nothing sends until resume.' : ''}`
      : 'The outgoing list is live. Pacing stays off until it is turned on, so this deploy does not change the channel.',
    counts,
    items,
    programsOnly,
    sent: sent.rows.map(row => ({
      entryId: Number(row.entry_id),
      name: row.name,
      wire: row.wire,
      externalId: row.external_id,
      sentAt: iso(row.sent_at),
      claimedAt: iso(row.created_at),
    })),
    chats,
  };
}
