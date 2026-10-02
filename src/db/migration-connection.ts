/**
 * Connection selection for the explicit migration command.
 *
 * The running application only ever reads DATABASE_URL (src/config/index.ts),
 * which in production is a restricted runtime login with no DDL rights. The
 * migration command needs the schema owner, so it prefers MIGRATION_DATABASE_URL
 * when that is set and falls back to DATABASE_URL otherwise (local dev and CI
 * use one owner login for both). Nothing outside the migration command may
 * read MIGRATION_DATABASE_URL; tests/migration-connection.test.js pins that.
 */

export type MigrationConnectionSource = 'MIGRATION_DATABASE_URL' | 'DATABASE_URL';

export interface MigrationConnection {
  url: string;
  source: MigrationConnectionSource;
}

export interface ConnectionDescription {
  user: string | null;
  host: string | null;
  database: string | null;
}

export function resolveMigrationConnection(env: NodeJS.ProcessEnv = process.env): MigrationConnection | null {
  const owner = env.MIGRATION_DATABASE_URL?.trim();
  if (owner) return { url: owner, source: 'MIGRATION_DATABASE_URL' };
  const runtime = env.DATABASE_URL?.trim();
  if (runtime) return { url: runtime, source: 'DATABASE_URL' };
  return null;
}

/** Loggable view of a connection string. Never includes the password or the URL. */
export function describeConnection(url: string): ConnectionDescription {
  try {
    const parsed = new URL(url);
    return {
      user: parsed.username ? decodeURIComponent(parsed.username) : null,
      host: parsed.hostname || null,
      database: parsed.pathname.replace(/^\//, '') || null,
    };
  } catch {
    return { user: null, host: null, database: null };
  }
}

/**
 * The login that will run the application. Grants are applied to it after the
 * schema changes so the restricted role can use every table the release reads.
 *
 * RUNTIME_DATABASE_ROLE wins when set. Otherwise the login in DATABASE_URL is
 * the runtime role whenever it differs from the migration login. When both
 * resolve to the same login (single-owner local dev and CI) there is nothing to
 * grant and null is returned.
 */
export function resolveRuntimeRole(
  connection: MigrationConnection,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.RUNTIME_DATABASE_ROLE?.trim();
  if (explicit) return explicit;
  if (connection.source !== 'MIGRATION_DATABASE_URL') return null;
  const runtimeUrl = env.DATABASE_URL?.trim();
  if (!runtimeUrl) return null;
  const runtimeUser = describeConnection(runtimeUrl).user;
  const migrationUser = describeConnection(connection.url).user;
  if (!runtimeUser || runtimeUser === migrationUser) return null;
  return runtimeUser;
}
