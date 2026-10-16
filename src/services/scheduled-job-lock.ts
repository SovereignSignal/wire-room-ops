import type { Pool, PoolClient } from 'pg';

export interface ScheduledJobLock {
  client: PoolClient;
  release(): Promise<void>;
}

/** One runtime owns a schedule; a durable receipt also rejects a later copy of its cron tick. */
export async function acquireScheduledJobLock(
  pool: Pick<Pool, 'connect'>,
  scheduleId: string,
  occurrence: Date,
  attempt: 0 | 1,
): Promise<ScheduledJobLock | null> {
  if (!scheduleId || !Number.isFinite(occurrence.getTime()) || (attempt !== 0 && attempt !== 1)) {
    throw new Error('Invalid scheduled job claim');
  }
  // Cron has minute precision. Retries carry this original tick, not their retry time.
  const tick = new Date(Math.floor(occurrence.getTime() / 60000) * 60000).toISOString();
  const key = `scheduler:claim:${scheduleId}`;
  const client = await pool.connect();
  let acquired = false;
  let released = false;
  let connectionError: Error | undefined;
  const onError = (error: Error) => { connectionError = error; };
  client.on('error', onError);

  const release = async () => {
    if (released) return;
    released = true;
    let destroy = Boolean(connectionError);
    try {
      if (connectionError) throw connectionError;
      if (acquired) {
        const result = await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [key]);
        if (result.rows[0]?.unlocked !== true) throw new Error('Scheduled job lock was lost');
      }
    } catch (error) {
      destroy = true;
      throw error;
    } finally {
      client.removeListener('error', onError);
      client.release(destroy);
    }
  };

  try {
    const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [key]);
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) { await release(); return null; }

    const previous = (await client.query('SELECT value FROM app_state WHERE key = $1', [key])).rows[0]?.value;
    if (previous && (typeof previous.occurrence !== 'string'
      || !Number.isFinite(Date.parse(previous.occurrence))
      || (previous.attempt !== 0 && previous.attempt !== 1))) {
      throw new Error('Invalid stored scheduled job claim');
    }
    const alreadyClaimed = previous && (previous.occurrence > tick
      || (previous.occurrence === tick && previous.attempt >= attempt));
    const invalidRetry = attempt === 1 && (previous?.occurrence !== tick || previous?.attempt !== 0);
    if (alreadyClaimed || invalidRetry) { await release(); return null; }

    await client.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify({ occurrence: tick, attempt })],
    );
    return { client, release };
  } catch (error) {
    // Never return a possibly locked/broken session to the pool.
    if (!released) {
      released = true;
      client.removeListener('error', onError);
      client.release(true);
    }
    throw error;
  }
}
