import { ScanEntry } from '@/types';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { ScoreBadge } from './ScoreBadge';
import { VerticalTag } from './VerticalTag';
import { DistributionBadges } from './DistributionBadges';
import { ExternalLink, Calendar, DollarSign, Activity, FileText } from 'lucide-react';
import { format } from 'date-fns';

interface EntryDetailsSheetProps {
  entry: ScanEntry | null;
  onClose: () => void;
}

export function EntryDetailsSheet({ entry, onClose }: EntryDetailsSheetProps) {
  return (
    <Sheet open={!!entry} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-md md:max-w-lg border-l border-border bg-card overflow-y-auto">
        {entry && (
          <div className="space-y-6 pt-6">
            <SheetHeader className="space-y-4 text-left">
              <div className="flex items-center gap-2 mb-2">
                <VerticalTag vertical={entry.wire} />
                <ScoreBadge score={entry.quality_score} />
                <div className="ml-auto flex items-center gap-2">
                  {entry.status === 'queued' && <span className="text-xs font-mono px-2 py-1 rounded bg-primary/10 text-primary border border-primary/20">⏳ IN QUEUE</span>}
                  {entry.status === 'approved' && <span className="text-xs font-mono px-2 py-1 rounded bg-status-success/10 text-status-success border border-status-success/20">✅ PUBLISHED</span>}
                  {entry.status === 'flagged' && <span className="text-xs font-mono px-2 py-1 rounded bg-status-warning/10 text-status-warning border border-status-warning/20">⚠️ REVIEW</span>}
                </div>
              </div>
              
              <SheetTitle className="text-xl font-display leading-tight">{entry.name}</SheetTitle>
              
              <SheetDescription className="text-sm font-mono text-muted-foreground whitespace-pre-wrap">
                {entry.description}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="glow-card p-4 space-y-1">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <DollarSign className="w-3 h-3" />
                    Value
                  </div>
                  <div className="text-lg font-mono font-semibold">{entry.amount}</div>
                </div>
                
                <div className="glow-card p-4 space-y-1">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <Calendar className="w-3 h-3" />
                    Deadline
                  </div>
                  <div className="text-lg font-mono font-semibold">
                    {entry.deadline || 'None'}
                  </div>
                </div>
              </div>

              <div className="glow-card p-4 space-y-4">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider border-b border-border pb-2">
                  <Activity className="w-3 h-3" />
                  Metadata
                </div>
                
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground font-mono">Source Link</span>
                    <a 
                      href={entry.source_url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors font-mono"
                    >
                      Open Original <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground font-mono">Discovered</span>
                    <span className="text-xs font-mono">
                      {format(new Date(entry.created_at), 'MMM d, yyyy HH:mm')}
                    </span>
                  </div>
                  
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground font-mono">System ID</span>
                    <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                      {entry.id}
                    </span>
                  </div>
                </div>
              </div>

              {entry.operator_notes && (
                <div className="glow-card p-4 space-y-2 border-status-warning/30">
                  <div className="flex items-center gap-1.5 text-[10px] text-status-warning uppercase tracking-wider">
                    <FileText className="w-3 h-3" />
                    Operator Notes
                  </div>
                  <div className="text-sm font-mono text-muted-foreground bg-status-warning/5 p-3 rounded">
                    {entry.operator_notes}
                  </div>
                </div>
              )}

              {entry.distribution_channels && entry.distribution_channels.length > 0 && (
                <div className="glow-card p-4 space-y-3">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider border-b border-border pb-2">
                    <Activity className="w-3 h-3" />
                    Distribution
                  </div>
                  <DistributionBadges channels={entry.distribution_channels} />
                </div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}