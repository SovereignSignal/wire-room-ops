/**
 * Experiment Loop Runner
 *
 * Checks safety triggers, evaluates active experiments, and creates
 * new experiments when the previous one completes.
 *
 * Usage:
 *   npx ts-node src/scripts/run-experiment-loop.ts [--strategy=random_walk|gradient_estimate|explore]
 *
 * Designed to run on a cron (e.g. every 6 hours alongside engagement collection).
 */

import { Pool } from 'pg';
import { config } from '../config';
import { ExperimentEngine, mutateParams } from '../services/experiment-engine';
import { DEFAULT_PARAMS } from '../services/quality-scorer';
import type { ScoringParams } from '../types/intake';

type Strategy = 'random_walk' | 'gradient_estimate' | 'explore';

function createPool(): Pool {
  return new Pool({
    connectionString: config.database.url,
    ssl: config.database.url.includes('localhost') ? false : {
      rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
    },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

function parseArgs(): { strategy: Strategy } {
  const args = process.argv.slice(2);
  let strategy: Strategy = 'random_walk';

  for (const arg of args) {
    const [key, val] = arg.split('=');
    if (key === '--strategy' && (val === 'random_walk' || val === 'gradient_estimate' || val === 'explore')) {
      strategy = val;
    }
  }

  return { strategy };
}

async function main() {
  const { strategy } = parseArgs();
  const pool = createPool();
  const engine = new ExperimentEngine(pool);

  try {
    // Step 1: Check safety triggers on active experiment
    const safetyReason = await engine.checkSafetyTriggers();
    if (safetyReason) {
      const active = await engine.getActiveExperiment();
      if (active) {
        console.log(`[Loop] Safety trigger: ${safetyReason}`);
        await engine.rollbackExperiment(active.id, safetyReason);
      }
    }

    // Step 2: Check if there's an active experiment to evaluate
    const active = await engine.getActiveExperiment();

    if (active && active.started_at) {
      const hoursActive = (Date.now() - active.started_at.getTime()) / 3600000;
      console.log(`[Loop] Active experiment: ${active.name} (${Math.round(hoursActive)}h, ${active.entry_count} entries)`);

      // Only evaluate if minimum duration has passed
      if (hoursActive < active.min_duration_hours) {
        console.log(`[Loop] Minimum duration not reached (${active.min_duration_hours}h). Waiting.`);
        return;
      }

      // Compute current results
      const results = await engine.computeResults(active.id);
      console.log(`[Loop] Results: approval=${(results.approval_rate * 100).toFixed(1)}% engagement=${(results.engagement_rate * 100).toFixed(1)}% efficiency=${(results.editorial_efficiency * 100).toFixed(1)}% composite=${results.composite_score.toFixed(3)}`);

      // Get baseline for comparison
      const baseline = await engine.getBaseline();
      const decision = engine.evaluateExperiment(
        { entry_count: active.entry_count, approved_count: active.approved_count, results },
        baseline ? { results: baseline.results! } : null
      );

      console.log(`[Loop] Decision: ${decision}`);

      if (decision === 'extend') {
        console.log('[Loop] Extending experiment — need more data.');
        return;
      }

      if (decision === 'keep') {
        await engine.completeExperiment(active.id, results);
        console.log(`[Loop] Experiment kept as new baseline: ${active.name}`);
      } else {
        await engine.rollbackExperiment(active.id, `evaluation: ${decision}`);
        console.log(`[Loop] Experiment rolled back: ${active.name}`);
      }
    }

    // Step 3: Create a new experiment
    const bestParams = await getBestParams(engine);
    const history = await engine.getHistory();
    const { mutated, changed, description } = mutateParams(bestParams, strategy, history);

    if (changed.length === 0) {
      console.log('[Loop] Mutation produced no effective change. Skipping new experiment.');
      return;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const name = `exp_${dateStr}_${changed.join('_').slice(0, 40)}`;
    const parentExperiment = await engine.getBaseline();

    await engine.createExperiment(
      name,
      mutated,
      parentExperiment?.id ?? null,
      description,
      'system'
    );

    console.log(`[Loop] New experiment created: ${name}`);
    console.log(`[Loop] Mutations: ${description}`);

  } catch (err) {
    console.error('[Loop] Error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function getBestParams(engine: ExperimentEngine): Promise<ScoringParams> {
  // Use the most recent completed experiment's params, or DEFAULT_PARAMS
  const baseline = await engine.getBaseline();
  return baseline?.params ?? DEFAULT_PARAMS;
}

main();
