import { Button } from '@/components/ui/button';
import { queueDecisionButtonClass, type QueueDecisionTone } from './queue-decisions';

export interface DecisionConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  tone: QueueDecisionTone;
  count: number;
  names?: string[];
  issues?: string[];
  forceLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onForce?: () => void;
  onCancel: () => void;
}

export function DecisionConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone,
  count,
  names = [],
  issues = [],
  forceLabel,
  busy = false,
  onConfirm,
  onForce,
  onCancel,
}: DecisionConfirmDialogProps) {
  if (!open) return null;

  const preview = names.slice(0, 4);
  const extra = names.length - preview.length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Cancel decision"
        className="absolute inset-0 bg-black/70"
        onClick={busy ? undefined : onCancel}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="decision-confirm-title"
        className="relative z-10 w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-2xl"
      >
        <h2 id="decision-confirm-title" className="font-display text-sm tracking-wider text-foreground">
          {title}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        {count > 1 && (
          <p className="mt-2 font-mono text-xs text-primary">{count} items</p>
        )}
        {preview.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs font-mono text-muted-foreground">
            {preview.map(name => (
              <li key={name} className="truncate">{name}</li>
            ))}
            {extra > 0 && <li>+{extra} more</li>}
          </ul>
        )}
        {issues.length > 0 && (
          <div className="mt-3 rounded-md border border-status-warning/40 bg-status-warning/10 p-3">
            <p className="text-[10px] font-display tracking-wider text-status-warning">APPROVAL GUARD</p>
            <ul className="mt-1 space-y-1 text-xs text-foreground/90">
              {issues.map(issue => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onCancel}
            className="font-display text-[10px] tracking-wider"
          >
            Cancel
          </Button>
          {onForce && forceLabel ? (
            <Button
              type="button"
              disabled={busy}
              onClick={onForce}
              className={queueDecisionButtonClass('warning')}
            >
              {busy ? 'Working…' : forceLabel}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className={queueDecisionButtonClass(tone)}
            >
              {busy ? 'Working…' : confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
