/**
 * Close open calls whose deadline has passed.
 *
 * grants.watch reads `classification = 'GRANT'` rows from scan_entries. A row
 * still labelled an open call after its deadline becomes an open round with a
 * past close date there, and the registry validator rejects the whole Desk
 * sync for it. This pass marks such rows closed before that read: lifecycle
 * 'closed' and classification 'EXPIRED', with the prior values kept in
 * metadata.auto_closed. Nothing is deleted and status is unchanged.
 *
 * A deadline closes at the stated time in the stated zone. With no time it
 * closes at the end of that day; with no zone, at the end of the day Anywhere
 * on Earth (UTC-12), the latest the call could still be open somewhere. A
 * grace period runs after that before the row is touched.
 */

import type { Pool } from 'pg';
import { setAppState } from '../db';
import { zonedTimeToUtc } from './distribution-pace';

export const DEFAULT_GRACE_HOURS = 6;
export const MAX_GRACE_HOURS = 72;
export const DEFAULT_BATCH_LIMIT = 500;
export const OPEN_CALL_EXPIRY_STATE_KEY = 'open-call-expiry:last-run';
/** Statuses grants.watch reads, plus archived registry-lane rows. */
export const EXPIRY_STATUSES = ['approved', 'queued', 'archived'] as const;

const AOE_OFFSET_MINUTES = -12 * 60;

const ZONES: Record<string, string> = {
  UTC: 'UTC', GMT: 'UTC',
  ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York',
  CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago',
  MT: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver',
  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  BST: 'Europe/London', WET: 'Europe/Lisbon', CET: 'Europe/Berlin', CEST: 'Europe/Berlin',
  EET: 'Europe/Athens', EEST: 'Europe/Athens',
  JST: 'Asia/Tokyo', KST: 'Asia/Seoul', SGT: 'Asia/Singapore', HKT: 'Asia/Hong_Kong',
  AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney',
};

export function expiryGraceHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPEN_CALL_EXPIRY_GRACE_HOURS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_GRACE_HOURS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_GRACE_HOURS;
  return Math.min(value, MAX_GRACE_HOURS);
}

type Zone = { kind: 'iana'; zone: string; label: string } | { kind: 'offset'; minutes: number; label: string };

function statedZone(text: string): Zone | null {
  if (/\b(?:AoE|anywhere on earth)\b/i.test(text)) return { kind: 'offset', minutes: AOE_OFFSET_MINUTES, label: 'AoE' };
  const offset = /\b(?:UTC|GMT)\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?\b/.exec(text);
  if (offset) {
    const hours = Number(offset[2]);
    const minutes = Number(offset[3] || 0);
    if (hours <= 14 && minutes < 60) {
      const sign = offset[1] === '+' ? 1 : -1;
      return { kind: 'offset', minutes: sign * (hours * 60 + minutes), label: offset[0].replace(/\s+/g, '') };
    }
  }
  const abbreviation = /\b(UTC|GMT|E[SD]?T|C[SD]?T|M[SD]?T|P[SD]?T|BST|WET|CEST|CET|EEST|EET|JST|KST|SGT|HKT|AE[SD]T)\b/.exec(text);
  return abbreviation ? { kind: 'iana', zone: ZONES[abbreviation[1]], label: abbreviation[1] } : null;
}

function statedTime(text: string): { hour: number; minute: number } | null {
  if (/\bnoon\b/i.test(text)) return { hour: 12, minute: 0 };
  const meridiem = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s?m\b\.?/i.exec(text);
  if (meridiem) {
    const hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] || 0);
    if (hour >= 1 && hour <= 12 && minute < 60) {
      const pm = meridiem[3].toLowerCase() === 'p';
      return { hour: (hour % 12) + (pm ? 12 : 0), minute };
    }
  }
  const clock = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  return clock ? { hour: Number(clock[1]), minute: Number(clock[2]) } : null;
}

function addDays(day: string, days: number): [number, number, number] {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + days));
  return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
}

function instantIn(zone: Zone, year: number, month: number, day: number, hour: number, minute: number): Date {
  if (zone.kind === 'iana') return zonedTimeToUtc(year, month, day, hour, minute, zone.zone);
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - zone.minutes * 60_000);
}

export interface DeadlineClose {
  closesAt: Date;
  zone: string;
  /** stated = time and zone from the deadline text; end_of_day otherwise. */
  basis: 'stated_time' | 'end_of_day';
}

/**
 * When a deadline actually closes. `deadlineDate` is the parsed calendar day
 * (YYYY-MM-DD); the free-text deadline only contributes a time and zone.
 */
export function deadlineCloseInstant(deadlineDate: string, deadlineText?: string | null): DeadlineClose | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadlineDate)) return null;
  const text = deadlineText || '';
  const zone = statedZone(text) ?? { kind: 'offset', minutes: AOE_OFFSET_MINUTES, label: 'AoE' };
  const time = statedTime(text);
  const [year, month, day] = deadlineDate.split('-').map(Number);
  if (time) {
    return { closesAt: instantIn(zone, year, month, day, time.hour, time.minute), zone: zone.label, basis: 'stated_time' };
  }
  const [nextYear, nextMonth, nextDay] = addDays(deadlineDate, 1);
  return { closesAt: instantIn(zone, nextYear, nextMonth, nextDay, 0, 0), zone: zone.label, basis: 'end_of_day' };
}

export function isPastDeadline(close: DeadlineClose, now: Date, graceHours: number): boolean {
  return now.getTime() >= close.closesAt.getTime() + graceHours * 3_600_000;
}

export interface ClosedCall {
  id: number;
  name: string;
  wire: string;
  status: string;
  deadline: string | null;
  deadlineDate: string;
  closesAt: string;
  zone: string;
}

export interface OpenCallExpiryResult {
  at: string;
  dryRun: boolean;
  graceHours: number;
  checked: number;
  closed: ClosedCall[];
  stillOpen: number;
}

/**
 * Mark expired open calls closed. Each row is judged on its own, so one odd
 * deadline cannot stop the rest. Re-running closes nothing twice: the update
 * only matches rows that are still open GRANT calls.
 */
export async function closeExpiredOpenCalls(
  pool: Pool,
  opts: { dryRun?: boolean; now?: Date; graceHours?: number; limit?: number } = {},
): Promise<OpenCallExpiryResult> {
  const now = opts.now ?? new Date();
  const graceHours = opts.graceHours ?? expiryGraceHours();
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_BATCH_LIMIT, 5000));
  // UTC+14 is the earliest a stated deadline can close, so nothing later than tomorrow can be due.
  const candidates = (await pool.query(
    `SELECT id, name, wire, status, deadline, to_char(deadline_parsed, 'YYYY-MM-DD') AS deadline_date,
            classification, lifecycle
     FROM scan_entries
     WHERE classification = 'GRANT'
       AND COALESCE(NULLIF(btrim(lifecycle), ''), 'open') = 'open'
       AND status = ANY($1::text[])
       AND deadline_parsed IS NOT NULL
       AND deadline_parsed <= ($2::timestamptz AT TIME ZONE 'UTC')::date + 1
     ORDER BY deadline_parsed, id
     LIMIT $3`,
    [EXPIRY_STATUSES, now.toISOString(), limit],
  )).rows as Array<{ id: number; name: string; wire: string; status: string; deadline: string | null; deadline_date: string; classification: string; lifecycle: string | null }>;

  const due: Array<{ row: typeof candidates[number]; close: DeadlineClose }> = [];
  for (const row of candidates) {
    const close = deadlineCloseInstant(row.deadline_date, row.deadline);
    if (close && isPastDeadline(close, now, graceHours)) due.push({ row, close });
  }

  let closedRows = due;
  if (!opts.dryRun && due.length) {
    const stamps = due.map(({ row, close }) => JSON.stringify({
      at: now.toISOString(),
      by: 'open-call-expiry',
      reason: 'deadline passed',
      deadline: row.deadline,
      deadline_date: row.deadline_date,
      closes_at: close.closesAt.toISOString(),
      zone: close.zone,
      basis: close.basis,
      grace_hours: graceHours,
      prior_classification: row.classification,
      prior_lifecycle: row.lifecycle,
    }));
    const updated = await pool.query(
      `UPDATE scan_entries se
       SET lifecycle = 'closed',
           classification = 'EXPIRED',
           metadata = COALESCE(se.metadata, '{}'::jsonb) || jsonb_build_object('auto_closed', v.stamp)
       FROM unnest($1::int[], $2::jsonb[]) AS v(id, stamp)
       WHERE se.id = v.id
         AND se.classification = 'GRANT'
         AND COALESCE(NULLIF(btrim(se.lifecycle), ''), 'open') = 'open'
       RETURNING se.id`,
      [due.map(({ row }) => row.id), stamps],
    );
    const done = new Set(updated.rows.map(row => Number(row.id)));
    closedRows = due.filter(({ row }) => done.has(Number(row.id)));
  }

  const closed: ClosedCall[] = closedRows.map(({ row, close }) => ({
    id: Number(row.id),
    name: row.name,
    wire: row.wire,
    status: row.status,
    deadline: row.deadline,
    deadlineDate: row.deadline_date,
    closesAt: close.closesAt.toISOString(),
    zone: close.zone,
  }));
  for (const call of closed) {
    console.log(`[OpenCallExpiry] ${opts.dryRun ? 'would close' : 'closed'} #${call.id} "${call.name}" (${call.wire}, ${call.status}) deadline ${call.deadline ?? call.deadlineDate} closed ${call.closesAt} ${call.zone} + ${graceHours}h grace`);
  }
  const result: OpenCallExpiryResult = {
    at: now.toISOString(),
    dryRun: !!opts.dryRun,
    graceHours,
    checked: candidates.length,
    closed,
    stillOpen: candidates.length - due.length,
  };
  console.log(`[OpenCallExpiry] ${result.dryRun ? 'dry run: ' : ''}${closed.length} closed of ${candidates.length} open calls due by tomorrow`);
  if (!opts.dryRun) {
    await setAppState(OPEN_CALL_EXPIRY_STATE_KEY, { ...result, closed: closed.slice(0, 100) }).catch(error => {
      console.error('[OpenCallExpiry] Could not record the run summary', error);
    });
  }
  return result;
}
