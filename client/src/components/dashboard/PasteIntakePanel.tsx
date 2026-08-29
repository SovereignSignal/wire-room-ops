import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { submitManualIntake } from '@/api';

interface PasteIntakePanelProps {
  wires: { key: string; displayName: string }[];
  onComplete?: () => void;
  onClose: () => void;
}

export function PasteIntakePanel({ wires, onComplete, onClose }: PasteIntakePanelProps) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [wire, setWire] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const result = await submitManualIntake(trimmed, wire || undefined);
      if (result.inserted != null) {
        const skipped = (result.duplicates || 0) + (result.errors || 0);
        toast({
          title: result.inserted > 0 ? 'Queued' : 'Nothing new',
          description: `${result.inserted} inserted` + (skipped ? `, ${skipped} skipped` : ''),
        });
      } else if (result.result) {
        const status = result.result.status;
        toast({
          title: status === 'inserted' ? 'Queued' : status === 'rejected' ? 'Rejected' : 'Intake failed',
          description: result.result.confirmText || result.result.errorMessage || status,
        });
      } else if (result.error) {
        toast({ title: 'Intake failed', description: result.error });
      }
      if (result.success || (result.inserted && result.inserted > 0)) {
        setText('');
        onComplete?.();
      }
    } catch (err) {
      toast({ title: 'Intake failed', description: err instanceof Error ? err.message : 'Request failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="glow-card p-4 space-y-3 border-primary/20" data-testid="paste-intake-panel">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-xs tracking-wider">PASTE INTAKE</h3>
          <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
            URL or numbered batch. Lands in the queue as manual-intake.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-7 font-display text-[10px] tracking-wider text-muted-foreground"
        >
          CLOSE
        </Button>
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={"https://example.org/grant\n\nor\n\n1. **Program name** — description\nLink: https://example.org/grant"}
        rows={6}
        className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded focus:border-primary/50 focus:outline-none resize-y min-h-[120px]"
      />
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="text-[10px] font-display tracking-wider uppercase text-muted-foreground">Wire</label>
          <select
            value={wire}
            onChange={e => setWire(e.target.value)}
            className="h-8 px-2 text-xs font-mono bg-background border border-border rounded"
          >
            <option value="">Auto-detect</option>
            {wires.map(w => (
              <option key={w.key} value={w.key}>{w.displayName || w.key}</option>
            ))}
          </select>
        </div>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={submitting || !text.trim()}
          className="h-8 font-display text-[10px] tracking-wider"
        >
          {submitting ? 'QUEUING…' : 'ADD TO QUEUE'}
        </Button>
      </div>
    </div>
  );
}
