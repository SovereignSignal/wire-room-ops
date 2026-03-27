/**
 * Drip Distribution Job
 * 
 * Distributes one approved-but-undistributed entry per active wire per run.
 * Designed to run on a schedule (e.g. every 30-60 min) to create a natural
 * stream of content rather than batch-distributing everything at once.
 */

import { Pool } from 'pg';
import { getAvailableWires } from '../db';
import { distributeEntry } from '../services/distribution';

export interface DripDistributionResult {
  distributed: number;
  skipped: number;
  errors: number;
  details: string[];
}

export async function runDripDistribution(pool: Pool): Promise<DripDistributionResult> {
  const result: DripDistributionResult = {
    distributed: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  // Get all active wires
  const wires = await getAvailableWires();
  console.log(`[DripDistribution] Checking ${wires.length} active wires`);

  for (const wire of wires) {
    try {
      // Find the oldest approved entry that hasn't been distributed yet
      const entryResult = await pool.query(
        `SELECT se.id, se.name, se.wire
         FROM scan_entries se
         WHERE se.status = 'approved'
           AND se.wire = $1
           AND se.distributable = true
           AND se.created_at > NOW() - INTERVAL '30 days'
           AND (
             (se.description IS NOT NULL AND LENGTH(TRIM(se.description)) > 50)
             OR se.enriched_summary IS NOT NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM distribution_logs dl
             WHERE dl.entry_id = se.id
           )
         ORDER BY se.updated_at ASC
         LIMIT 1`,
        [wire.key]
      );

      if (entryResult.rows.length === 0) {
        result.skipped++;
        result.details.push(`${wire.key}: no pending entries`);
        continue;
      }

      const entry = entryResult.rows[0];
      console.log(`[DripDistribution] Distributing entry ${entry.id} ("${entry.name}") for wire ${wire.key}`);

      const distResult = await distributeEntry(entry.id, wire.key);

      if (distResult.distributed > 0) {
        result.distributed++;
        result.details.push(`${wire.key}: distributed "${entry.name}" (id=${entry.id})`);
      } else if (distResult.failed > 0) {
        result.errors++;
        result.details.push(`${wire.key}: failed to distribute "${entry.name}" (id=${entry.id})`);
      } else {
        result.skipped++;
        result.details.push(`${wire.key}: entry ${entry.id} skipped (no channels configured)`);
      }
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      result.details.push(`${wire.key}: error — ${msg}`);
      console.error(`[DripDistribution] Error processing wire ${wire.key}:`, err);
    }
  }

  console.log(`[DripDistribution] Complete: ${result.distributed} distributed, ${result.skipped} skipped, ${result.errors} errors`);
  return result;
}
