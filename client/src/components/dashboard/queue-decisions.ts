export type QueueDecisionKey = 'wires' | 'programs' | 'reject';
export type QueueDecisionTone = 'success' | 'warning' | 'danger';

export interface QueueDecisionDefinition {
  key: QueueDecisionKey;
  label: string;
  title: string;
  status: 'approved' | 'declined';
  quiet: boolean;
  tone: QueueDecisionTone;
}

/** Shared operator decisions for row and bulk review controls. */
export const QUEUE_DECISIONS: readonly QueueDecisionDefinition[] = [
  {
    key: 'wires',
    label: 'Approve to Wires',
    title: 'Approve and distribute this announcement to its selected wires',
    status: 'approved',
    quiet: false,
    tone: 'success',
  },
  {
    key: 'programs',
    label: 'Approve to Programs',
    title: 'Approve and retain this program without wire distribution',
    status: 'approved',
    quiet: true,
    tone: 'warning',
  },
  {
    key: 'reject',
    label: 'Reject',
    title: 'Reject this item and retain the reviewed decision for duplicate checks',
    status: 'declined',
    quiet: false,
    tone: 'danger',
  },
] as const;

export const QUEUE_DECISION_BUTTON_BASE =
  'inline-flex w-full h-full min-h-12 min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-center text-[10px] font-display font-bold uppercase tracking-wide whitespace-normal leading-tight transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50';

export const QUEUE_DECISION_TONE_CLASSES: Record<QueueDecisionTone, string> = {
  success:
    'border-status-success/50 bg-status-success/15 text-status-success hover:border-status-success/75 hover:bg-status-success/25 hover:shadow-[0_0_14px_hsl(var(--status-success)/0.35)]',
  warning:
    'border-status-warning/55 bg-status-warning/15 text-status-warning hover:border-status-warning/80 hover:bg-status-warning/25 hover:shadow-[0_0_14px_hsl(var(--status-warning)/0.35)]',
  danger:
    'border-status-danger/55 bg-status-danger/15 text-status-danger hover:border-status-danger/80 hover:bg-status-danger/25 hover:shadow-[0_0_14px_hsl(var(--status-danger)/0.35)]',
};

export function getQueueDecision(key: QueueDecisionKey): QueueDecisionDefinition {
  const decision = QUEUE_DECISIONS.find((candidate) => candidate.key === key);
  if (!decision) throw new Error(`Unknown queue decision: ${key}`);
  return decision;
}

export function queueDecisionButtonClass(tone: QueueDecisionTone): string {
  return `${QUEUE_DECISION_BUTTON_BASE} ${QUEUE_DECISION_TONE_CLASSES[tone]}`;
}
