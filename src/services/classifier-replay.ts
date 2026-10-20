/**
 * Pure selection and pass/fail rules for the classifier lifecycle replay.
 * The script that calls Grok lives in src/scripts and is not part of CI.
 */

export const REPLAY_REQUIRED_IDS = [19856, 19921, 19855, 19958];

export interface ReplaySelection {
  recentQueuedIds: number[];
  approvedGrantIds: number[];
  fixtureIds: number[];
  requiredIds?: number[];
  limit?: number;
}

/** Approved grants, the fixture, and the required ids are always included. */
export function selectReplayIds(input: ReplaySelection): number[] {
  const requiredIds = input.requiredIds ?? REPLAY_REQUIRED_IDS;
  const limit = input.limit ?? 200;
  const required: number[] = [];
  const seen = new Set<number>();
  for (const id of [...input.approvedGrantIds, ...input.fixtureIds, ...requiredIds]) {
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    required.push(id);
  }
  const cap = Math.max(limit, required.length);
  const out = [...required];
  for (const id of input.recentQueuedIds) {
    if (out.length >= cap) break;
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface ReplaySide {
  classification: string;
  inScope: boolean;
  lifecycle: string | null;
  wireArea?: string | null;
}

export interface ReplayRow {
  id: number;
  previous: ReplaySide;
  next: ReplaySide;
}

export type GrantFlipKind = 'forthcoming' | 'closure' | 'award' | 'open_call' | 'other';

export interface ReplayEvaluation {
  pass: boolean;
  rows: ReplayRow[];
  confusion: Record<string, number>;
  flips: Array<{ id: number; from: string; to: string; kind: GrantFlipKind; lifecycle: string | null; wireArea: string | null }>;
  open_call_finalised: { previous: number; next: number };
  failures: string[];
}

export function finalisesProgram(side: Pick<ReplaySide, 'classification' | 'inScope'>): boolean {
  return side.inScope === true && (side.classification === 'GRANT' || side.classification === 'EXPIRED');
}

/** A GRANT that stops being GRANT. Forthcoming, award, and closure are allowed. */
export function grantFlipKind(previous: ReplaySide, next: ReplaySide): GrantFlipKind | null {
  if (previous.classification !== 'GRANT' || next.classification === 'GRANT') return null;
  if (next.lifecycle === 'forthcoming') return 'forthcoming';
  if (next.lifecycle === 'closed' || next.classification === 'EXPIRED') return 'closure';
  if (next.wireArea === '2') return 'award';
  if (next.lifecycle === 'open') return 'open_call';
  return 'other';
}

export function evaluateReplay(rows: ReplayRow[]): ReplayEvaluation {
  const confusion: Record<string, number> = {};
  const flips: ReplayEvaluation['flips'] = [];
  const failures: string[] = [];
  for (const row of rows) {
    const key = `${row.previous.classification}→${row.next.classification}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
    const kind = grantFlipKind(row.previous, row.next);
    if (!kind) continue;
    flips.push({
      id: row.id,
      from: row.previous.classification,
      to: row.next.classification,
      kind,
      lifecycle: row.next.lifecycle,
      wireArea: row.next.wireArea ?? null,
    });
    if (kind === 'open_call' || kind === 'other') {
      failures.push(`#${row.id} GRANT→${row.next.classification} is ${kind} (lifecycle ${row.next.lifecycle ?? 'null'})`);
    }
  }

  const openRows = rows.filter(row => row.next.lifecycle === 'open');
  const open_call_finalised = {
    previous: openRows.filter(row => finalisesProgram(row.previous)).length,
    next: openRows.filter(row => finalisesProgram(row.next)).length,
  };
  if (open_call_finalised.next < open_call_finalised.previous) {
    failures.push(
      `open-call program finalisation dropped from ${open_call_finalised.previous} to ${open_call_finalised.next}`,
    );
  }

  return {
    pass: failures.length === 0,
    rows,
    confusion,
    flips,
    open_call_finalised,
    failures,
  };
}

const WRITE_SQL = /\b(insert|update|delete|alter|drop|create|truncate|grant|revoke)\b/i;

/** Reject anything but a read. FOR UPDATE is a write for this purpose. */
export function assertReplayReadOnly(sql: string): void {
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ');
  if (WRITE_SQL.test(stripped)) {
    throw new Error('replay refused a write');
  }
}
