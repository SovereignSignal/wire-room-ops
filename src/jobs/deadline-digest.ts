/**
 * Deadline Digest Job
 *
 * Finds approved entries with deadlines in the next N days per wire.
 * Used to generate "Closing This Week" alerts for subscribers.
 */

import type { Pool } from 'pg';
import { getAvailableWires } from '../db';


export interface DeadlineEntry {
  id: number;
  name: string;
  wire: string;
  deadline: string;
  deadlineParsed: Date | null;
  amount: string | null;
  sourceUrl: string;
  daysUntil: number;
}

export interface DeadlineDigestResult {
  wire: string;
  entries: DeadlineEntry[];
  generatedAt: Date;
}

export async function runDeadlineDigest(
  pool: Pool,
  wire?: string,
  daysAhead = 7
): Promise<DeadlineDigestResult[]> {
  const wireInfos = wire ? null : await getAvailableWires();
  const wires: string[] = wire ? [wire] : (wireInfos?.map(w => w.key) || ['crypto', 'ai', 'oss']);

  const result = await pool.query(
    `SELECT id, name, wire, deadline, deadline_parsed, amount, source_url,
            EXTRACT(DAY FROM (deadline_parsed - NOW()))::int AS days_until
     FROM scan_entries
     WHERE status = 'approved'
       AND deadline_parsed IS NOT NULL
       AND deadline_parsed >= NOW()
       AND deadline_parsed <= NOW() + make_interval(days => $1)
       AND wire = ANY($2)
     ORDER BY deadline_parsed ASC, wire ASC`,
    [daysAhead, wires]
  );

  // Group by wire
  const byWire = new Map<string, DeadlineEntry[]>();
  for (const wire of wires) byWire.set(wire, []);

  for (const row of result.rows) {
    const entry: DeadlineEntry = {
      id: row.id,
      name: row.name,
      wire: row.wire,
      deadline: row.deadline,
      deadlineParsed: row.deadline_parsed,
      amount: row.amount,
      sourceUrl: row.source_url,
      daysUntil: row.days_until ?? 0,
    };
    const list = byWire.get(row.wire) || [];
    list.push(entry);
    byWire.set(row.wire, list);
  }

  const generatedAt = new Date();
  return wires.map(w => ({
    wire: w,
    entries: byWire.get(w) || [],
    generatedAt,
  }));
}
