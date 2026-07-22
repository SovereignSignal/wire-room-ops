import { Button } from '@/components/ui/button';
import { CheckCircle2, Database, X, XCircle } from 'lucide-react';
import { getQueueDecision, queueDecisionButtonClass } from './queue-decisions';

const WIRES_DECISION = getQueueDecision('wires');
const PROGRAMS_DECISION = getQueueDecision('programs');
const REJECT_DECISION = getQueueDecision('reject');

interface ActionBarProps {
  selectedCount: number;
  onApproveToWires: () => void;
  onApproveToPrograms: () => void;
  onReject: () => void;
  onClear: () => void;
}

export function ActionBar({
  selectedCount,
  onApproveToWires,
  onApproveToPrograms,
  onReject,
  onClear,
}: ActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="action-bar animate-in slide-in-from-bottom-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono text-primary text-lg">{selectedCount}</span>
        <span className="text-muted-foreground font-display text-[10px] tracking-wider uppercase">Selected</span>
      </div>

      <div className="hidden sm:block h-8 w-px bg-border" />

      <div className="grid grid-cols-3 gap-2 items-stretch w-full sm:w-[500px]">
        <Button
          size="sm"
          onClick={onApproveToWires}
          title={WIRES_DECISION.title}
          aria-label={WIRES_DECISION.label}
          className={queueDecisionButtonClass(WIRES_DECISION.tone)}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {WIRES_DECISION.label}
        </Button>
        <Button
          size="sm"
          onClick={onApproveToPrograms}
          title={PROGRAMS_DECISION.title}
          aria-label={PROGRAMS_DECISION.label}
          className={queueDecisionButtonClass(PROGRAMS_DECISION.tone)}
        >
          <Database className="w-4 h-4 shrink-0" />
          {PROGRAMS_DECISION.label}
        </Button>
        <Button
          size="sm"
          onClick={onReject}
          title={REJECT_DECISION.title}
          aria-label={REJECT_DECISION.label}
          className={queueDecisionButtonClass(REJECT_DECISION.tone)}
        >
          <XCircle className="w-4 h-4 shrink-0" />
          {REJECT_DECISION.label}
        </Button>
      </div>

      <div className="hidden sm:block h-8 w-px bg-border" />

      <Button
        size="sm"
        variant="ghost"
        onClick={onClear}
        className="gap-1.5 text-muted-foreground hover:text-foreground font-display text-[10px] tracking-wider"
      >
        <X className="w-3.5 h-3.5" />
        CLEAR
      </Button>
    </div>
  );
}
