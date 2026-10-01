/**
 * The one definition of "this entry is held for human review".
 *
 * Automatic work (program exemplar selection, program-to-organization links,
 * entry-to-organization links) must never act on a held entry. Three copies of
 * this condition used to live in three files; they recognised a duplicate-chain
 * hold only through its note text, so a writer that replaced operator_notes
 * could unhold an entry without anyone noticing.
 *
 * Held when any of:
 *  - the notes or the action reason say "hold" or "human review required";
 *  - decided-recheck blocked a canonical-parent or cross-wire demotion;
 *  - decided-recheck recorded a duplicate-chain error on an entry that is still
 *    queued. A decided entry keeps the stamp as history, but the operator's
 *    decision resolved the question, so it is scoped to the queue. The key can
 *    also hold a JSON null, which is not an error.
 *
 * The result may be SQL NULL when every column is NULL; callers that negate it
 * wrap it in COALESCE(..., false). `alias` is an internal identifier, never
 * request input.
 */
export function entryHeldSql(alias?: string): string {
  const c = alias ? `${alias}.` : '';
  return `(concat_ws(' ', ${c}operator_notes, ${c}action_reason) ~* '\\mhold\\M|human review required'
    OR ${c}metadata #>> '{decided_recheck,canonical_parent_blocked}' = 'true'
    OR ${c}metadata #>> '{decided_recheck,cross_wire_blocked}' = 'true'
    OR (${c}status = 'queued' AND jsonb_typeof(${c}metadata -> 'duplicate_chain_error') = 'object'))`;
}
