/**
 * Schema version 14. The Claude scout's run log (scout_runs) and alert log
 * (scout_alerts), written through /api/scout and read through /api/read.
 *
 * grant-wire-scout created both tables by hand on this database, so production
 * may already have them in a shape this repo never recorded. This migration
 * adopts them in place: it creates a missing table, adds missing columns and
 * indexes, and never changes an existing column's type, default or
 * constraints. There is deliberately no CHECK on status; the write route
 * validates it, and an existing row with an older value must not fail the
 * release.
 */
import type { PoolClient } from 'pg';

const RUN_COLUMNS: ReadonlyArray<[string, string]> = [
  ['run_id', 'TEXT'],
  ['wire', "TEXT DEFAULT ''"],
  ['variant', 'TEXT'],
  ['model', 'TEXT'],
  ['status', 'TEXT'],
  ['opportunity_count', 'INTEGER'],
  ['found_count', 'INTEGER'],
  ['dedup_dropped', 'INTEGER'],
  ['error_class', 'TEXT'],
  ['cost_usd', 'NUMERIC'],
  ['duration_ms', 'BIGINT'],
  ['started_at', 'TIMESTAMPTZ'],
  ['finished_at', 'TIMESTAMPTZ'],
  ['created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()'],
  ['recorded_by', 'TEXT'],
];

const ALERT_COLUMNS: ReadonlyArray<[string, string]> = [
  ['id', 'BIGSERIAL'],
  ['subject', 'TEXT'],
  ['body', 'TEXT'],
  ['channels_ok', 'TEXT'],
  ['created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()'],
  ['recorded_by', 'TEXT'],
  ['idempotency_key', 'TEXT'],
];

async function addMissingColumns(client: PoolClient, table: string, columns: ReadonlyArray<[string, string]>): Promise<void> {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  const present = new Set(rows.map(row => row.column_name));
  for (const [name, type] of columns) {
    if (!present.has(name)) await client.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/** True when some non-partial unique index (or primary key) has run_id as its only key. */
async function runIdIsUnique(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = 'public.scout_runs'::regclass
       AND i.indisunique AND i.indnkeyatts = 1 AND i.indpred IS NULL
       AND a.attname = 'run_id'`,
  );
  return rows.length > 0;
}

export async function applyScoutLedgerSchema(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS scout_runs (
    run_id TEXT PRIMARY KEY,
    wire TEXT NOT NULL DEFAULT '',
    variant TEXT,
    model TEXT,
    status TEXT NOT NULL,
    opportunity_count INTEGER,
    found_count INTEGER,
    dedup_dropped INTEGER,
    error_class TEXT,
    cost_usd NUMERIC,
    duration_ms BIGINT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_by TEXT
  )`);
  await addMissingColumns(client, 'scout_runs', RUN_COLUMNS);
  // The upsert's ON CONFLICT (run_id) needs this. A hand-made table already has
  // one if ledger.py has ever written to it; a second identical index is waste.
  if (!(await runIdIsUnique(client))) {
    await client.query('CREATE UNIQUE INDEX idx_scout_runs_run_id ON scout_runs (run_id)');
  }
  await client.query('CREATE INDEX IF NOT EXISTS idx_scout_runs_created_at ON scout_runs (created_at)');

  await client.query(`CREATE TABLE IF NOT EXISTS scout_alerts (
    id BIGSERIAL PRIMARY KEY,
    subject TEXT NOT NULL,
    body TEXT,
    channels_ok TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_by TEXT,
    idempotency_key TEXT
  )`);
  await addMissingColumns(client, 'scout_alerts', ALERT_COLUMNS);
  await client.query('CREATE INDEX IF NOT EXISTS idx_scout_alerts_created_at ON scout_alerts (created_at)');
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_scout_alerts_idempotency
     ON scout_alerts (recorded_by, idempotency_key) WHERE idempotency_key IS NOT NULL`,
  );
}

export async function ensureScoutLedgerTables(): Promise<void> {
  const { getPool } = await import('./index');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await applyScoutLedgerSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
