import { Button } from '@/components/ui/button';
import { CheckCircle, Archive, X } from 'lucide-react';

interface ActionBarProps {
  selectedCount: number;
  onApprove: () => void;
  onArchive: () => void;
  onClear: () => void;
}

export function ActionBar({ selectedCount, onApprove, onArchive, onClear }: ActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="action-bar animate-in slide-in-from-bottom-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono text-primary text-lg">{selectedCount}</span>
        <span className="text-muted-foreground font-display text-[10px] tracking-wider uppercase">Selected</span>
      </div>

      <div className="h-6 w-px bg-border" />

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onApprove}
          className="gap-1.5 bg-status-success/20 text-status-success border border-status-success/30 hover:bg-status-success/30 font-display text-[10px] tracking-wider"
        >
          <CheckCircle className="w-3.5 h-3.5" />
          APPROVE
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

      <div className="h-6 w-px bg-border" />

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
