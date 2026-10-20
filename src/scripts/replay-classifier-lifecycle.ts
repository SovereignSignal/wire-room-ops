/**
 * Dry-run classifier lifecycle replay. No database writes.
 *
 *   npx ts-node --transpile-only src/scripts/replay-classifier-lifecycle.ts --out replay-classifier-lifecycle.json
 *
 * Compares the legacy prompt (the GRANT boundary that still says "or opens
 * on a stated date", parsed with lifecycle coercion off) to the current
 * prompt. Both calls use the deployed Grok model, temperature 0.1, and the
 * same operator-signal guidance. Exit 0 when the pass criteria hold, 1 when
 * they fail, 2 when setup fails. This script is not part of CI.
 */
import fs from 'fs';
import { getPool, closePool } from '../db';
import { refreshProviderCache, getCachedProvider } from '../services/api-provider';
import { computeOperatorSignals, formatSignalsForPrompt } from '../services/operator-signals';
import { classifyEntry, type ClassificationResult } from '../services/classifier';
import {
  assertReplayReadOnly,
  evaluateReplay,
  selectReplayIds,
  type ReplayRow,
} from '../services/classifier-replay';

const TEMPERATURE = 0.1;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function failSetup(message: string): never {
  console.error(message);
  process.exit(2);
}

interface FixtureCase {
  entry_id: number;
  wire: string;
  input_record: {
    name: string;
    description: string;
    source_url: string;
    amount?: string | null;
    deadline?: string | null;
    classification?: string;
  };
}

interface EntryBody {
  id: number;
  name: string;
  description: string | null;
  source_url: string | null;
  wire: string;
  amount: string | null;
  deadline_parsed: string | Date | null;
  source_published_at: string | Date | null;
  classification: string | null;
  wire_area: string | null;
  lifecycle: string | null;
  in_scope: boolean | null;
}

function sideFrom(result: ClassificationResult) {
  return {
    classification: result.classification,
    inScope: result.inScope,
    lifecycle: result.lifecycle,
    wireArea: result.wireArea,
  };
}

async function main(): Promise<void> {
  const outPath = argValue('--out') || 'replay-classifier-lifecycle.json';
  const limit = Number(argValue('--limit') || '200');
  const fixturePath = argValue('--fixture') || 'fixtures/review-sixteen-factual.json';
  if (!Number.isSafeInteger(limit) || limit < 1) failSetup('--limit must be a positive integer');
  if (!fs.existsSync(fixturePath)) failSetup(`Fixture not found: ${fixturePath}`);

  let fixture: { cases: FixtureCase[] };
  try {
    fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { cases: FixtureCase[] };
  } catch (error) {
    failSetup(`Fixture unreadable: ${error instanceof Error ? error.message : error}`);
  }
  const fixtureById = new Map(fixture.cases.map(item => [item.entry_id, item]));

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const read = async (sql: string, params?: unknown[]) => {
      assertReplayReadOnly(sql);
      return client.query(sql, params);
    };

    const recent = await read(
      `SELECT id FROM scan_entries WHERE status = 'queued' ORDER BY created_at DESC LIMIT 400`,
    );
    const approved = await read(
      `SELECT id FROM scan_entries
       WHERE status = 'approved' AND classification = 'GRANT'
         AND COALESCE(decision_at, updated_at) >= NOW() - INTERVAL '30 days'`,
    );
    const ids = selectReplayIds({
      recentQueuedIds: recent.rows.map(row => Number(row.id)),
      approvedGrantIds: approved.rows.map(row => Number(row.id)),
      fixtureIds: fixture.cases.map(item => item.entry_id),
      limit,
    });
    const bodies = await read(
      `SELECT id, name, description, source_url, wire, amount, deadline_parsed, source_published_at,
              classification, wire_area, lifecycle,
              CASE
                WHEN quality_breakdown IS NULL THEN NULL
                WHEN jsonb_typeof(quality_breakdown->'in_scope') = 'boolean' THEN (quality_breakdown->>'in_scope')::boolean
                ELSE NULL
              END AS in_scope
       FROM scan_entries
       WHERE id = ANY($1::int[])`,
      [ids],
    );
    const byId = new Map<number, EntryBody>(bodies.rows.map(row => [Number(row.id), row as EntryBody]));

    await client.query('ROLLBACK');

    await refreshProviderCache();
    const provider = getCachedProvider('grok');
    if (!provider?.api_key) failSetup('Grok API key is not configured');

    const guidanceByWire = new Map<string, string>();
    const guidanceFor = async (wire: string) => {
      const cached = guidanceByWire.get(wire);
      if (cached !== undefined) return cached;
      let text = '';
      try {
        text = formatSignalsForPrompt(await computeOperatorSignals(wire));
      } catch (error) {
        console.error(`[replay] operator signals skipped for ${wire}:`, error instanceof Error ? error.message : error);
      }
      guidanceByWire.set(wire, text);
      return text;
    };

    const rows: ReplayRow[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const stored = byId.get(id);
      const fixtureCase = fixtureById.get(id);
      const source = stored ?? (fixtureCase ? {
        name: fixtureCase.input_record.name,
        description: fixtureCase.input_record.description,
        source_url: fixtureCase.input_record.source_url,
        wire: fixtureCase.wire,
        amount: fixtureCase.input_record.amount ?? null,
        deadline_parsed: fixtureCase.input_record.deadline ?? null,
        source_published_at: null,
      } : null);
      if (!source?.source_url || !source.name) {
        missing.push(`#${id} is not in the database or the fixture`);
        continue;
      }
      const entry = {
        name: source.name,
        description: source.description || '',
        source_url: source.source_url,
        wire: source.wire,
        amount: source.amount,
        deadlineParsed: source.deadline_parsed,
        sourcePublishedAt: source.source_published_at,
      };
      const operatorGuidance = await guidanceFor(entry.wire);
      const previous = await classifyEntry(entry, { variant: 'legacy', recordUsage: false, operatorGuidance });
      const next = await classifyEntry(entry, { variant: 'current', recordUsage: false, operatorGuidance });
      rows.push({ id, previous: sideFrom(previous), next: sideFrom(next) });
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const evaluation = evaluateReplay(rows);
    if (missing.length) evaluation.failures.push(...missing);
    evaluation.pass = evaluation.failures.length === 0;
    const report = {
      ...evaluation,
      model: provider.default_model || null,
      temperature: TEMPERATURE,
      row_count: rows.length,
      missing,
    };
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      pass: report.pass,
      out: outPath,
      row_count: report.row_count,
      flips: report.flips.length,
      failures: report.failures,
    }));
    process.exit(report.pass ? 0 : 1);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
