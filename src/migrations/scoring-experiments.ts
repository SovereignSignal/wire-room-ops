/**
 * Migration: Scoring Experiments (Autoresearch Loop)
 *
 * Creates tables for the self-improving scoring system:
 * 1. scoring_experiments — tracks parameter experiments
 * 2. scoring_param_log — logs which params scored each entry
 * 3. engagement_metrics — stores post-publish engagement data
 * Plus: adds experiment_id column to scan_entries
 */

import type { Pool } from 'pg';

export interface MigrationResult {
  tablesCreated: string[];
  columnsAdded: string[];
  errors: string[];
}

export async function runScoringExperimentsMigration(pool: Pool): Promise<MigrationResult> {
  const result: MigrationResult = { tablesCreated: [], columnsAdded: [], errors: [] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. scoring_experiments
    await client.query(`
      CREATE TABLE IF NOT EXISTS scoring_experiments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        -- Experiment identity
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'active', 'completed', 'rolled_back', 'aborted')),

        -- Parameters (full snapshot)
        params JSONB NOT NULL,
        parent_experiment_id UUID REFERENCES scoring_experiments(id),
        mutation_description TEXT,

        -- Timing
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        min_duration_hours INTEGER DEFAULT 48,

        -- Results (populated on completion)
        results JSONB,
        entry_count INTEGER DEFAULT 0,
        approved_count INTEGER DEFAULT 0,
        declined_count INTEGER DEFAULT 0,

        -- Metadata
        created_at TIMESTAMPTZ DEFAULT NOW(),
        created_by TEXT DEFAULT 'system'
      )
    `);
    result.tablesCreated.push('scoring_experiments');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scoring_experiments_status
        ON scoring_experiments(status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scoring_experiments_active
        ON scoring_experiments(started_at DESC) WHERE status = 'active'
    `);

    // 2. scoring_param_log
    await client.query(`
      CREATE TABLE IF NOT EXISTS scoring_param_log (
        id SERIAL PRIMARY KEY,
        entry_id INTEGER NOT NULL REFERENCES scan_entries(id),
        experiment_id UUID REFERENCES scoring_experiments(id),

        score INTEGER NOT NULL,
        breakdown JSONB NOT NULL,
        params_snapshot JSONB NOT NULL,

        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    result.tablesCreated.push('scoring_param_log');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scoring_param_log_experiment
        ON scoring_param_log(experiment_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scoring_param_log_entry
        ON scoring_param_log(entry_id)
    `);

    // 3. engagement_metrics
    await client.query(`
      CREATE TABLE IF NOT EXISTS engagement_metrics (
        id SERIAL PRIMARY KEY,
        entry_id INTEGER NOT NULL REFERENCES scan_entries(id),
        channel TEXT NOT NULL CHECK (channel IN ('x', 'telegram', 'discord', 'substack')),
        wire TEXT NOT NULL,

        external_id TEXT,
        impressions INTEGER,
        likes INTEGER,
        retweets INTEGER,
        replies INTEGER,
        quotes INTEGER,
        bookmarks INTEGER,
        clicks INTEGER,

        engagement_score NUMERIC,
        measured_at TIMESTAMPTZ NOT NULL,
        post_age_hours NUMERIC,

        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    result.tablesCreated.push('engagement_metrics');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_engagement_entry
        ON engagement_metrics(entry_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_engagement_channel
        ON engagement_metrics(channel, wire)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_engagement_measured
        ON engagement_metrics(measured_at DESC)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_engagement_no_dupes
        ON engagement_metrics(entry_id, channel, measured_at)
    `);

    // 4. Add experiment_id to scan_entries
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'scan_entries' AND column_name = 'experiment_id'
    `);
    if (colCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE scan_entries
          ADD COLUMN experiment_id UUID REFERENCES scoring_experiments(id)
      `);
      result.columnsAdded.push('scan_entries.experiment_id');
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scan_entries_experiment
        ON scan_entries(experiment_id)
    `);

    await client.query('COMMIT');
    console.log('[Migration] Scoring experiments tables created:', result.tablesCreated.join(', '));
    if (result.columnsAdded.length > 0) {
      console.log('[Migration] Columns added:', result.columnsAdded.join(', '));
    }
  } catch (err) {
    await client.query('ROLLBACK');
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(msg);
    console.error('[Migration] Failed:', msg);
    throw err;
  } finally {
    client.release();
  }

  return result;
}
