import type { PoolClient } from 'pg';

/**
 * Runtime privileges for the restricted application login.
 *
 * This is the executable copy of scripts/database-runtime-grants.sql. The
 * migration command runs it (owner connection) after every schema apply so a
 * new table or sequence is usable by the runtime role before the release
 * starts. Table-level grants cover columns added later, so re-running after a
 * column-only migration is a no-op that still verifies nothing was revoked.
 * tests/runtime-grants-lockstep.test.js keeps the SQL file and these lists equal.
 */

/** Tables the application reads and writes. All exist after migration. */
export const RUNTIME_WRITABLE_TABLES: ReadonlyArray<string> = [
  'sessions', 'feeds', 'schedules', 'scan_entries', 'scan_prompts', 'seen_urls', 'seen_names',
  'intake_runs', 'distribution_config', 'distribution_channels', 'distribution_logs',
  'publication_queue', 'org_profiles', 'discovered_contacts', 'programs', 'watch_surfaces',
  'integration_config', 'app_state', 'monitored_accounts', 'api_providers', 'model_pricing',
  'source_runs', 'opportunity_observations', 'telegram_intake_receipts', 'generated_files',
  'scout_runs',
];

/** Append-only telemetry. */
export const RUNTIME_INSERT_ONLY_TABLES: ReadonlyArray<string> = ['api_usage_log', 'scout_alerts'];

/** Read-only for the runtime: the version gate must not be writable by the app. */
export const RUNTIME_READ_ONLY_TABLES: ReadonlyArray<string> = ['wro_schema_migrations'];

/** Sibling-owned tables (tele-sum) that may be absent in a standalone install. */
export const OPTIONAL_SHARED_WRITABLE_TABLES: ReadonlyArray<string> = ['summaries'];
export const OPTIONAL_SHARED_READ_ONLY_TABLES: ReadonlyArray<string> = ['messages', 'categories', 'grant_entries'];

const WRITE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function tableExists(client: PoolClient, table: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: string | null }>(
    `SELECT to_regclass($1) AS exists`, [`public.${table}`],
  );
  return rows[0]?.exists !== null;
}

async function serialSequences(client: PoolClient, tables: ReadonlyArray<string>): Promise<string[]> {
  const { rows } = await client.query<{ seq: string }>(
    `SELECT DISTINCT pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) AS seq
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
       AND pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) IS NOT NULL`,
    [tables],
  );
  return rows.map(row => row.seq);
}

export async function roleExists(client: PoolClient, role: string): Promise<boolean> {
  const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  return rows.length > 0;
}

/** Idempotent. GRANT on an already granted object changes nothing. */
export async function applyRuntimeGrants(client: PoolClient, role: string): Promise<void> {
  const r = quoteIdent(role);
  const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdent(rows[0].db)} TO ${r}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${r}`);
  await client.query(
    `GRANT ${WRITE_PRIVILEGES.join(', ')} ON ${RUNTIME_WRITABLE_TABLES.map(quoteIdent).join(', ')} TO ${r}`,
  );
  await client.query(`GRANT SELECT, INSERT ON ${RUNTIME_INSERT_ONLY_TABLES.map(quoteIdent).join(', ')} TO ${r}`);
  await client.query(`GRANT SELECT ON ${RUNTIME_READ_ONLY_TABLES.map(quoteIdent).join(', ')} TO ${r}`);
  for (const table of OPTIONAL_SHARED_WRITABLE_TABLES) {
    if (await tableExists(client, table)) {
      await client.query(`GRANT SELECT, INSERT, UPDATE ON public.${quoteIdent(table)} TO ${r}`);
    }
  }
  for (const table of OPTIONAL_SHARED_READ_ONLY_TABLES) {
    if (await tableExists(client, table)) {
      await client.query(`GRANT SELECT ON public.${quoteIdent(table)} TO ${r}`);
    }
  }
  const sequences = await serialSequences(client, [
    ...RUNTIME_WRITABLE_TABLES, ...RUNTIME_INSERT_ONLY_TABLES, ...OPTIONAL_SHARED_WRITABLE_TABLES,
  ]);
  for (const sequence of sequences) {
    await client.query(`GRANT USAGE ON SEQUENCE ${sequence} TO ${r}`);
  }
}

/** Returns every privilege the runtime role is missing. Empty means ready. */
export async function verifyRuntimeGrants(client: PoolClient, role: string): Promise<string[]> {
  const missing: string[] = [];
  const schema = await client.query<{ ok: boolean }>(
    `SELECT has_schema_privilege($1, 'public', 'USAGE') AS ok`, [role],
  );
  if (!schema.rows[0]?.ok) missing.push('USAGE ON SCHEMA public');

  const check = async (table: string, privileges: ReadonlyArray<string>) => {
    for (const privilege of privileges) {
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT has_table_privilege($1, $2, $3) AS ok`, [role, `public.${table}`, privilege],
      );
      if (!rows[0]?.ok) missing.push(`${privilege} ON ${table}`);
    }
  };
  for (const table of RUNTIME_WRITABLE_TABLES) await check(table, WRITE_PRIVILEGES);
  for (const table of RUNTIME_INSERT_ONLY_TABLES) await check(table, ['SELECT', 'INSERT']);
  for (const table of RUNTIME_READ_ONLY_TABLES) await check(table, ['SELECT']);
  for (const table of OPTIONAL_SHARED_WRITABLE_TABLES) {
    if (await tableExists(client, table)) await check(table, ['SELECT', 'INSERT', 'UPDATE']);
  }
  for (const table of OPTIONAL_SHARED_READ_ONLY_TABLES) {
    if (await tableExists(client, table)) await check(table, ['SELECT']);
  }
  const sequences = await serialSequences(client, [
    ...RUNTIME_WRITABLE_TABLES, ...RUNTIME_INSERT_ONLY_TABLES, ...OPTIONAL_SHARED_WRITABLE_TABLES,
  ]);
  for (const sequence of sequences) {
    const { rows } = await client.query<{ ok: boolean }>(
      `SELECT has_sequence_privilege($1, $2, 'USAGE') AS ok`, [role, sequence],
    );
    if (!rows[0]?.ok) missing.push(`USAGE ON SEQUENCE ${sequence}`);
  }
  return missing;
}
