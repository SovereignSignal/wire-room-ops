import { useEffect, useMemo, useState } from 'react';
import { EntryDistributionLog, ScanEntry } from '@/types';
import { fetchEntryDistribution } from '@/api';

function isXUrl(url: string): boolean {
  try { const h = new URL(url).hostname.replace(/^www\./, ''); return h === 'x.com' || h === 'twitter.com'; }
  catch { return false; }
}

/** Returns non-X direct URL for slide-out display (labeled as potentially stale) */
function getDirectUrl(entry: { source_url?: string; description?: string }): string | null {
  const url = entry.source_url?.trim();
  if (url && url.startsWith('http') && !url.startsWith('https://manual/') && !url.startsWith('https://t.me/manual/') && !isXUrl(url)) {
    return url;
  }
  const descMatch = (entry.description || '').match(/https?:\/\/[^\s)>"]+/);
  return descMatch && !isXUrl(descMatch[0]) ? descMatch[0] : null;
}
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
import { ExternalLink, Calendar, DollarSign, Activity, FileText, Tag } from 'lucide-react';
import { format } from 'date-fns';

interface EntryDetailsSheetProps {
  entry: ScanEntry | null;
  onClose: () => void;
}

export function EntryDetailsSheet({ entry, onClose }: EntryDetailsSheetProps) {
  const [distributionLogs, setDistributionLogs] = useState<EntryDistributionLog[]>([]);

  useEffect(() => {
    let active = true;
    setDistributionLogs([]);
    if (!entry || entry.status !== 'approved') return () => { active = false; };

    fetchEntryDistribution(entry.id)
      .then(logs => { if (active) setDistributionLogs(logs); })
      .catch(() => { /* Without a successful log, the truthful label is Approved. */ });

    return () => { active = false; };
  }, [entry]);

  const successfulChannels = useMemo(
    () => [...new Set(distributionLogs.filter(log => log.status === 'success').map(log => log.channel))],
    [distributionLogs],
  );
  const hasPublicationProof = successfulChannels.length > 0;

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
                  {entry.status === 'approved' && (
                    <span className="text-xs font-mono px-2 py-1 rounded bg-status-success/10 text-status-success border border-status-success/20">
                      {hasPublicationProof ? '✅ PUBLISHED' : '✓ APPROVED'}
                    </span>
                  )}

                  {entry.classification && entry.classification !== 'UNCHECKED' && (
                    <span className={`text-xs font-mono px-2 py-1 rounded border ${
                      entry.classification === 'GRANT' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                      entry.classification === 'EXPIRED' ? 'bg-orange-500/10 text-orange-400 border-orange-500/20' :
                      entry.classification === 'NEWS' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' :
                      'bg-red-500/10 text-red-400 border-red-500/20'
                    }`}>{
                      entry.classification === 'GRANT' ? '✅ GRANT' :
                      entry.classification === 'EXPIRED' ? '⏰ EXPIRED' :
                      entry.classification === 'NEWS' ? '📰 NEWS' : '🚫 NOISE'
                    }</span>
                  )}
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

              {entry.metadata?.summary && (
                <div className="glow-card p-4 space-y-2 border-primary/20">
                  <div className="flex items-center gap-1.5 text-[10px] text-primary uppercase tracking-wider">
                    <Tag className="w-3 h-3" />
                    AI Summary
                  </div>
                  <div className="text-sm font-mono text-foreground/90 leading-relaxed">
                    {entry.metadata.summary}
                  </div>
                  {(entry.metadata.eligibility || entry.metadata.amount || entry.metadata.deadline) && (
                    <div className="flex flex-wrap gap-3 pt-2 border-t border-border mt-2">
                      {entry.metadata.amount && (
                        <span className="text-xs font-mono text-muted-foreground">
                          <span className="text-green-400">{entry.metadata.amount}</span>
                        </span>
                      )}
                      {entry.metadata.deadline && (
                        <span className="text-xs font-mono text-muted-foreground">
                          Due: <span className="text-orange-400">{entry.metadata.deadline}</span>
                        </span>
                      )}
                      {entry.metadata.eligibility && (
                        <span className="text-xs font-mono text-muted-foreground">
                          For: <span className="text-blue-400">{entry.metadata.eligibility}</span>
                        </span>
                      )}
                    </div>
                  )}
                  {entry.classification_reason && (
                    <div className="text-[10px] font-mono text-muted-foreground/60 pt-1">
                      Reason: {entry.classification_reason}
                    </div>
                  )}
                </div>
              )}

              <div className="glow-card p-4 space-y-4">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider border-b border-border pb-2">
                  <Activity className="w-3 h-3" />
                  Metadata
                </div>
                
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground font-mono">Source Link</span>
                    <div className="flex items-center gap-3">
                      {/* X links: trusted, shown as primary */}
                      {entry.source_url && isXUrl(entry.source_url) && (
                        <a
                          href={entry.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors font-mono"
                        >
                          X Post <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      {/* Web links: shown as primary link */}
                      {getDirectUrl(entry) && (
                        <a
                          href={getDirectUrl(entry)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors font-mono"
                        >
                          Source <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      {/* No URL indicator */}
                      {!entry.source_url && (
                        <span className="text-xs text-muted-foreground font-mono">No source link</span>
                      )}
                    </div>
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

              {entry.metadata?.related_source && (
                <div className="glow-card p-4 space-y-2 border-cyan-400/30">
                  <div className="flex items-center gap-1.5 text-[10px] text-cyan-300 uppercase tracking-wider">
                    <ExternalLink className="w-3 h-3" />
                    Possible Alternate Source
                  </div>
                  <div className="text-sm font-mono text-muted-foreground bg-cyan-500/5 p-3 rounded space-y-2">
                    <div>{entry.metadata.related_source.matched_entry_name || `Entry #${entry.metadata.related_source.matched_entry_id}`}</div>
                    {entry.metadata.related_source.matched_source_url && (
                      <a
                        href={entry.metadata.related_source.matched_source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200 transition-colors font-mono"
                      >
                        Prior source <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {entry.metadata.related_source.reason && (
                      <div className="text-[10px] text-muted-foreground/70">{entry.metadata.related_source.reason}</div>
                    )}
                  </div>
                </div>
              )}

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

              {successfulChannels.length > 0 && (
                <div className="glow-card p-4 space-y-3">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider border-b border-border pb-2">
                    <Activity className="w-3 h-3" />
                    Distribution
                  </div>
                  <DistributionBadges channels={successfulChannels} />
                </div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
