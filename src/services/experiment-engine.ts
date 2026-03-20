/**
 * Experiment Engine — Autoresearch Loop for Quality Scoring
 *
 * Manages the lifecycle of scoring parameter experiments:
 * - Create new experiments with mutated parameters
 * - Evaluate running experiments against baselines
 * - Auto-rollback on safety triggers
 * - Keep/rollback/extend decision logic
 */

import { Pool } from 'pg';
import { getPool } from '../db';
import type {
  ScoringParams,
  ScoringExperiment,
  ExperimentResults,
  ParamRange,
} from '../types/intake';
import { PARAM_RANGES, PARAM_CONSTRAINTS } from '../types/intake';
import { DEFAULT_PARAMS } from './quality-scorer';

// ============================================================
// Types
// ============================================================

type MutationStrategy = 'random_walk' | 'gradient_estimate' | 'explore';
type ExperimentDecision = 'keep' | 'rollback' | 'extend';

interface ExperimentHistory {
  id: string;
  params: ScoringParams;
  parentParams: ScoringParams;
  mutations: (keyof ScoringParams)[];
  compositeScore: number;
}

// ============================================================
// Helpers
// ============================================================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function positiveWeightSum(params: ScoringParams): number {
  return params.w_has_amount
    + params.w_amount_threshold
    + params.w_has_deadline
    + params.w_deadline_upcoming
    + params.w_funding_opportunity
    + params.w_actionable;
}

// ============================================================
// Constraint Validation
// ============================================================

export function validateConstraints(params: ScoringParams): boolean {
  // Check individual ranges
  for (const key of Object.keys(PARAM_RANGES) as (keyof ScoringParams)[]) {
    const range = PARAM_RANGES[key];
    if (params[key] < range.min || params[key] > range.max) return false;
  }

  const pwSum = positiveWeightSum(params);
  if (pwSum < PARAM_CONSTRAINTS.MIN_POSITIVE_WEIGHT_SUM) return false;
  if (pwSum > PARAM_CONSTRAINTS.MAX_POSITIVE_WEIGHT_SUM) return false;

  return true;
}

// ============================================================
// Composite Score
// ============================================================

export function compositeScore(results: ExperimentResults): number {
  const alpha = 0.5; // approval_rate weight (operator judgment is primary signal)
  const beta = 0.3;  // engagement_rate weight
  const gamma = 0.2; // editorial_efficiency weight

  return alpha * results.approval_rate
       + beta * results.engagement_rate
       + gamma * results.editorial_efficiency;
}

// ============================================================
// Mutation
// ============================================================

export function mutateParams(
  current: ScoringParams,
  strategy: MutationStrategy,
  history: ExperimentHistory[]
): { mutated: ScoringParams; changed: (keyof ScoringParams)[]; description: string } {
  const mutated = { ...current };
  const keys = Object.keys(PARAM_RANGES) as (keyof ScoringParams)[];

  const numMutations = 1 + Math.floor(Math.random() * PARAM_CONSTRAINTS.MAX_MUTATIONS_PER_EXPERIMENT);
  const toMutate = shuffle(keys).slice(0, numMutations);
  const changes: string[] = [];

  for (const key of toMutate) {
    const range = PARAM_RANGES[key];
    const currentVal = current[key];

    switch (strategy) {
      case 'random_walk': {
        const step = (range.max - range.min) * 0.1 * (Math.random() > 0.5 ? 1 : -1);
        mutated[key] = Math.round(clamp(currentVal + step, range.min, range.max));
        break;
      }
      case 'gradient_estimate': {
        const relevant = history
          .filter(h => h.mutations.includes(key))
          .slice(-5);

        if (relevant.length >= 2) {
          const increases = relevant.filter(h => h.params[key] > h.parentParams[key]);
          const decreases = relevant.filter(h => h.params[key] < h.parentParams[key]);
          const avgInc = increases.length > 0
            ? increases.reduce((s, h) => s + h.compositeScore, 0) / increases.length
            : 0;
          const avgDec = decreases.length > 0
            ? decreases.reduce((s, h) => s + h.compositeScore, 0) / decreases.length
            : 0;
          const direction = avgInc > avgDec ? 1 : -1;
          const step = (range.max - range.min) * 0.15 * direction;
          mutated[key] = Math.round(clamp(currentVal + step, range.min, range.max));
        } else {
          const step = (range.max - range.min) * 0.1 * (Math.random() > 0.5 ? 1 : -1);
          mutated[key] = Math.round(clamp(currentVal + step, range.min, range.max));
        }
        break;
      }
      case 'explore': {
        mutated[key] = Math.round(range.min + Math.random() * (range.max - range.min));
        break;
      }
    }

    if (mutated[key] !== currentVal) {
      changes.push(`${key}: ${currentVal} -> ${mutated[key]}`);
    }
  }

  // Validate constraints — if violated, return current (no-op)
  if (!validateConstraints(mutated)) {
    return { mutated: current, changed: [], description: 'mutation rejected (constraint violation)' };
  }

  const actualChanged = toMutate.filter(k => mutated[k] !== current[k]);
  return {
    mutated,
    changed: actualChanged,
    description: changes.length > 0 ? changes.join(', ') : 'no effective change',
  };
}

// ============================================================
// Experiment Engine Class
// ============================================================

export class ExperimentEngine {
  private pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool || getPool();
  }

  /** Get the currently active experiment, if any. */
  async getActiveExperiment(): Promise<ScoringExperiment | null> {
    const result = await this.pool.query(
      `SELECT * FROM scoring_experiments WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /** Get the most recent completed experiment (the baseline). */
  async getBaseline(): Promise<ScoringExperiment | null> {
    const result = await this.pool.query(
      `SELECT * FROM scoring_experiments WHERE status = 'completed' ORDER BY ended_at DESC LIMIT 1`
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /** List experiments with optional status filter. */
  async listExperiments(status?: string, limit = 50): Promise<ScoringExperiment[]> {
    let query = 'SELECT * FROM scoring_experiments';
    const params: unknown[] = [];

    if (status) {
      query += ' WHERE status = $1';
      params.push(status);
    }
    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await this.pool.query(query, params);
    return result.rows.map(r => this.mapRow(r));
  }

  /** Create and activate a new experiment. Deactivates any current active experiment first. */
  async createExperiment(
    name: string,
    params: ScoringParams,
    parentId: string | null,
    mutationDescription: string | null,
    createdBy = 'system'
  ): Promise<ScoringExperiment> {
    if (!validateConstraints(params)) {
      throw new Error('Params violate constraints');
    }

    // Deactivate current active experiment if any
    const active = await this.getActiveExperiment();
    if (active) {
      await this.pool.query(
        `UPDATE scoring_experiments SET status = 'aborted', ended_at = NOW() WHERE id = $1`,
        [active.id]
      );
      console.log(`[Experiment] Aborted previous active experiment: ${active.name}`);
    }

    const result = await this.pool.query(
      `INSERT INTO scoring_experiments (name, status, params, parent_experiment_id, mutation_description, started_at, created_by)
       VALUES ($1, 'active', $2, $3, $4, NOW(), $5)
       RETURNING *`,
      [name, JSON.stringify(params), parentId, mutationDescription, createdBy]
    );

    console.log(`[Experiment] Created and activated: ${name}`);
    return this.mapRow(result.rows[0]);
  }

  /** Rollback an experiment — revert to parent's params or DEFAULT_PARAMS. */
  async rollbackExperiment(experimentId: string, reason: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE scoring_experiments
       SET status = 'rolled_back', ended_at = NOW(),
           results = COALESCE(results, '{}'::jsonb) || jsonb_build_object('rollback_reason', $2)
       WHERE id = $1 AND status = 'active'
       RETURNING *`,
      [experimentId, reason]
    );

    if (result.rows.length === 0) {
      throw new Error(`Experiment ${experimentId} is not active`);
    }

    console.log(`[Experiment] Rolled back: ${result.rows[0].name} — ${reason}`);
  }

  /** Complete an experiment — mark as successful, record final results. */
  async completeExperiment(experimentId: string, results: ExperimentResults): Promise<void> {
    await this.pool.query(
      `UPDATE scoring_experiments
       SET status = 'completed', ended_at = NOW(), results = $2
       WHERE id = $1 AND status = 'active'`,
      [experimentId, JSON.stringify(results)]
    );
    console.log(`[Experiment] Completed: ${experimentId}`);
  }

  /** Update entry/approval/decline counts for the active experiment. */
  async refreshCounts(experimentId: string): Promise<{ entry_count: number; approved_count: number; declined_count: number }> {
    const result = await this.pool.query(`
      UPDATE scoring_experiments SET
        entry_count = (SELECT COUNT(*) FROM scan_entries WHERE experiment_id = $1),
        approved_count = (SELECT COUNT(*) FROM scan_entries WHERE experiment_id = $1 AND status = 'approved'),
        declined_count = (SELECT COUNT(*) FROM scan_entries WHERE experiment_id = $1 AND status = 'declined')
      WHERE id = $1
      RETURNING entry_count, approved_count, declined_count
    `, [experimentId]);

    return result.rows[0];
  }

  /** Check safety triggers on the active experiment. Returns rollback reason or null. */
  async checkSafetyTriggers(): Promise<string | null> {
    const active = await this.getActiveExperiment();
    if (!active || !active.started_at) return null;

    const counts = await this.refreshCounts(active.id);
    const hoursActive = (Date.now() - active.started_at.getTime()) / 3600000;

    // Trigger 1: Low approval rate over 72h
    if (hoursActive >= 72 && counts.entry_count > 0) {
      const approvalRate = counts.approved_count / counts.entry_count;
      if (approvalRate < PARAM_CONSTRAINTS.MIN_APPROVAL_RATE) {
        return `auto: approval_rate ${(approvalRate * 100).toFixed(1)}% < 15% at ${Math.round(hoursActive)}h`;
      }
    }

    // Trigger 2: Zero approvals after 20 entries
    if (counts.entry_count >= 20 && counts.approved_count === 0) {
      return `auto: 0 approvals after ${counts.entry_count} entries`;
    }

    // Trigger 3: Max experiment duration
    if (hoursActive >= PARAM_CONSTRAINTS.MAX_EXPERIMENT_HOURS) {
      return `auto: max duration (${PARAM_CONSTRAINTS.MAX_EXPERIMENT_HOURS}h) reached`;
    }

    return null;
  }

  /** Compute experiment results from DB data. */
  async computeResults(experimentId: string): Promise<ExperimentResults> {
    const counts = await this.refreshCounts(experimentId);

    const approvalRate = counts.entry_count > 0
      ? counts.approved_count / counts.entry_count
      : 0;

    // Engagement: average engagement_score for entries in this experiment
    const engResult = await this.pool.query(`
      SELECT COALESCE(AVG(em.engagement_score), 0) as avg_engagement
      FROM engagement_metrics em
      JOIN scan_entries se ON se.id = em.entry_id
      WHERE se.experiment_id = $1
    `, [experimentId]);
    const engagementRate = parseFloat(engResult.rows[0].avg_engagement) / 100;

    // Editorial efficiency: 1 - (avg_time_in_queue / max_allowed_time)
    // max_allowed_time = 168h (1 week)
    const effResult = await this.pool.query(`
      SELECT COALESCE(AVG(
        EXTRACT(EPOCH FROM (
          CASE WHEN se.status IN ('approved', 'declined') THEN se.updated_at ELSE NOW() END
          - se.created_at
        )) / 3600
      ), 168) as avg_queue_hours
      FROM scan_entries se
      WHERE se.experiment_id = $1 AND se.status IN ('approved', 'declined', 'queued')
    `, [experimentId]);
    const avgQueueHours = parseFloat(effResult.rows[0].avg_queue_hours);
    const editorialEfficiency = Math.max(0, 1 - (avgQueueHours / 168));

    return {
      approval_rate: approvalRate,
      engagement_rate: engagementRate,
      editorial_efficiency: editorialEfficiency,
      composite_score: compositeScore({
        approval_rate: approvalRate,
        engagement_rate: engagementRate,
        editorial_efficiency: editorialEfficiency,
        composite_score: 0,
      }),
    };
  }

  /** Evaluate whether the current experiment should be kept, rolled back, or extended. */
  evaluateExperiment(
    experiment: { entry_count: number; approved_count: number; results: ExperimentResults },
    baseline: { results: ExperimentResults } | null
  ): ExperimentDecision {
    // Minimum data threshold
    if (experiment.entry_count < 10) return 'extend';

    const expScore = compositeScore(experiment.results);
    const baseScore = baseline ? compositeScore(baseline.results) : 0;

    // Safety checks
    if (experiment.results.approval_rate < PARAM_CONSTRAINTS.MIN_APPROVAL_RATE) return 'rollback';
    if (experiment.approved_count === 0 && experiment.entry_count > 20) return 'rollback';

    // If no baseline, keep if we have any data
    if (!baseline) return experiment.entry_count >= 10 ? 'keep' : 'extend';

    // Improvement threshold: must be > 5% better to keep
    const improvement = baseScore > 0.01
      ? (expScore - baseScore) / baseScore
      : expScore > 0 ? 1 : 0;

    if (improvement > 0.05) return 'keep';
    if (improvement < -0.05) return 'rollback';

    // Within noise band
    if (experiment.entry_count < 30) return 'extend';

    // Enough data, marginal difference: prefer stability
    return 'rollback';
  }

  /** Get experiment history for gradient estimation. */
  async getHistory(limit = 20): Promise<ExperimentHistory[]> {
    const result = await this.pool.query(`
      SELECT e.id, e.params, e.mutation_description, e.results,
             p.params as parent_params
      FROM scoring_experiments e
      LEFT JOIN scoring_experiments p ON p.id = e.parent_experiment_id
      WHERE e.status IN ('completed', 'rolled_back')
        AND e.results IS NOT NULL
        AND p.params IS NOT NULL
      ORDER BY e.ended_at DESC
      LIMIT $1
    `, [limit]);

    return result.rows.map(r => {
      const mutations: (keyof ScoringParams)[] = [];
      const params = r.params as ScoringParams;
      const parentParams = r.parent_params as ScoringParams;

      for (const key of Object.keys(PARAM_RANGES) as (keyof ScoringParams)[]) {
        if (params[key] !== parentParams[key]) {
          mutations.push(key);
        }
      }

      return {
        id: r.id,
        params,
        parentParams,
        mutations,
        compositeScore: r.results?.composite_score ?? 0,
      };
    });
  }

  // ============================================================
  // Private
  // ============================================================

  private mapRow(row: Record<string, unknown>): ScoringExperiment {
    return {
      id: row.id as string,
      name: row.name as string,
      status: row.status as ScoringExperiment['status'],
      params: row.params as ScoringParams,
      parent_experiment_id: row.parent_experiment_id as string | null,
      mutation_description: row.mutation_description as string | null,
      started_at: row.started_at ? new Date(row.started_at as string) : null,
      ended_at: row.ended_at ? new Date(row.ended_at as string) : null,
      min_duration_hours: row.min_duration_hours as number,
      results: row.results as ExperimentResults | null,
      entry_count: row.entry_count as number,
      approved_count: row.approved_count as number,
      declined_count: row.declined_count as number,
      created_at: new Date(row.created_at as string),
      created_by: row.created_by as string,
    };
  }
}
