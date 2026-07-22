import { Button } from '@/components/ui/button';
import { CheckCircle, Archive, X, EyeOff } from 'lucide-react';

interface ActionBarProps {
  selectedCount: number;
  onApprove: () => void;
  onQuietApprove: () => void;
  onArchive: () => void;
  onClear: () => void;
}

export function ActionBar({ selectedCount, onApprove, onQuietApprove, onArchive, onClear }: ActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="action-bar animate-in slide-in-from-bottom-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono text-primary text-lg">{selectedCount}</span>
        <span className="text-muted-foreground font-display text-[10px] tracking-wider uppercase">Selected</span>
      </div>

      <div className="hidden sm:block h-6 w-px bg-border" />

      <div className="flex items-center justify-center gap-2 flex-wrap">
        <Button
          size="sm"
          onClick={onApprove}
          className="gap-1.5 bg-status-success/20 text-status-success border border-status-success/30 hover:bg-status-success/30 font-display text-[10px] tracking-wider"
        >
          <CheckCircle className="w-3.5 h-3.5" />
          APPROVE + PUBLISH
        </Button>
        <Button
          size="sm"
          onClick={onQuietApprove}
          title="Approve without distributing"
          className="gap-1.5 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 font-display text-[10px] tracking-wider"
        >
          <EyeOff className="w-3.5 h-3.5" />
          QUIET APPROVE
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={onArchive}
          className="gap-1.5 font-display text-[10px] tracking-wider"
        >
          <Archive className="w-3.5 h-3.5" />
          ARCHIVE
        </Button>
      </div>

      <div className="hidden sm:block h-6 w-px bg-border" />

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
