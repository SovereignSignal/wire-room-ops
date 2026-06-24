/**
 * Curator stamp — the downstream judgment the queue curator (Stringer) writes
 * onto each pending entry, non-destructively, in `metadata.curator`.
 *
 * This replaces the old inline Grok `quality_score` as the queue's judgment
 * signal: an actionable route + a confidence, not a false-precision 0-100.
 * The pure builder validates/normalizes input so the route handler and the
 * agent share one contract.
 */

export type CuratorRoute =
  | 'publish'
  | 'source_check'
  | 'park'
  | 'relationship_signal'
  | 'decline';

export type CuratorConfidence = 'high' | 'med' | 'low';

export interface CuratorStamp {
  route: CuratorRoute;
  confidence: CuratorConfidence;
  rationale: string;
  by: string;
  at: string; // ISO timestamp
}

const VALID_ROUTES = new Set<CuratorRoute>([
  'publish',
  'source_check',
  'park',
  'relationship_signal',
  'decline',
]);

const VALID_CONFIDENCE = new Set<CuratorConfidence>(['high', 'med', 'low']);

/**
 * Build a validated, normalized curator stamp. Throws on an invalid route or
 * confidence so a bad call never silently writes garbage into the queue.
 *
 * @param now ISO timestamp; injectable for deterministic tests.
 */
export function buildCuratorStamp(
  input: { route: string; confidence: string; rationale?: string; by?: string },
  now: string = new Date().toISOString(),
): CuratorStamp {
  const route = String(input.route ?? '').trim().toLowerCase();
  if (!VALID_ROUTES.has(route as CuratorRoute)) {
    throw new Error(`Invalid curator route: ${input.route}`);
  }

  const confidence = String(input.confidence ?? '').trim().toLowerCase();
  if (!VALID_CONFIDENCE.has(confidence as CuratorConfidence)) {
    throw new Error(`Invalid confidence: ${input.confidence}`);
  }

  const rationale = typeof input.rationale === 'string' ? input.rationale.trim().slice(0, 500) : '';
  const by = typeof input.by === 'string' && input.by.trim() ? input.by.trim().slice(0, 80) : 'curator';

  return { route: route as CuratorRoute, confidence: confidence as CuratorConfidence, rationale, by, at: now };
}
