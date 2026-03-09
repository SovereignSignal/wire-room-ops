import { ScanEntry } from '@/types';
import { ScoreBadge } from './ScoreBadge';
import { VerticalTag } from './VerticalTag';
import { Button } from '@/components/ui/button';
import { ExternalLink } from 'lucide-react';

interface ReviewTabProps {
  entries: ScanEntry[];
  onDecision: (id: string, decision: 'approved' | 'archived') => void;
  onViewDetails: (entry: ScanEntry) => void;
}

export function ReviewTab({ entries, onDecision, onViewDetails }: ReviewTabProps) {
  return (
    <div className="space-y-4">
      {entries.length === 0 ? (
        <div className="glow-card p-12 text-center">
          <span className="text-5xl mx-auto mb-4 block w-fit opacity-50">⚠️</span>
          <p className="text-muted-foreground font-display text-sm tracking-wider">NO ITEMS PENDING REVIEW</p>
        </div>
      ) : (
        <div className="glow-card overflow-hidden">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Designation</th>
                <th className="w-24">Vertical</th>
                <th className="w-20">Signal</th>
                <th className="w-24">Value</th>
                <th className="w-64">Operator Notes</th>
                <th className="w-20">Source</th>
                <th className="w-36">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id} className="cursor-pointer" onClick={() => onViewDetails(entry)}>
                  <td>
                    <div className="font-medium text-foreground">{entry.name}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-sm">
                      {entry.description}
                    </div>
                  </td>
                  <td>
                    <VerticalTag vertical={entry.wire} />
                  </td>
                  <td>
                    <ScoreBadge score={entry.quality_score} />
                  </td>
                  <td className="font-mono text-sm">{entry.amount}</td>
                  <td>
                    <div className="text-xs text-status-warning bg-status-warning/10 px-3 py-2 rounded border border-status-warning/20 font-mono">
                      ⚠ {entry.operator_notes || 'No notes'}
                    </div>
                  </td>
                  <td>
                    <a 
                      href={entry.source_url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:text-primary/80 text-sm"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2">
                      <Button 
                        size="sm" 
                        onClick={() => onDecision(entry.id, 'approved')}
                        className="gap-1 bg-status-success/20 text-status-success border border-status-success/30 hover:bg-status-success/30 font-display text-[10px] tracking-wider"
                      >
                        <span className="text-xs">✅</span>
                        APPROVE
                      </Button>
                      <Button 
                        size="sm" 
                        variant="secondary"
                        onClick={() => onDecision(entry.id, 'archived')}
                        className="gap-1 font-display text-[10px] tracking-wider"
                      >
                        <span className="text-xs">❌</span>
                        REJECT
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
