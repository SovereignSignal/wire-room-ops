/** Intake lifecycle of a funding call. Null on rows written before this column. */
export const ENTRY_LIFECYCLES = ['open', 'forthcoming', 'closed', 'unknown'] as const;
export type EntryLifecycle = typeof ENTRY_LIFECYCLES[number];

export function isEntryLifecycle(value: unknown): value is EntryLifecycle {
  return typeof value === 'string' && (ENTRY_LIFECYCLES as readonly string[]).includes(value);
}

/** Queued note when Gate 2 says intake is not open yet. */
export const FORTHCOMING_HOLD_NOTE = 'Forthcoming call; held from sending until intake is open.';

/** publication_queue.error_message for a forthcoming hold. Approve and the digest share it. */
export const FORTHCOMING_HOLD_ERROR = 'Forthcoming call; held from sending';

export type LifecycleSettleAction = 'none' | 'promote' | 'collapse';

/**
 * A later intake of a forthcoming call promotes only when the new read is open.
 * Anything else collapses onto the existing row instead of becoming a second program.
 */
export function intakeLifecycleAction(
  priorLifecycle: string | null | undefined,
  incoming: string | null | undefined,
): LifecycleSettleAction {
  if (priorLifecycle !== 'forthcoming') return 'none';
  return incoming === 'open' ? 'promote' : 'collapse';
}
