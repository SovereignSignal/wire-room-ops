import { useState } from 'react';
import { VerticalStats, WireCounts } from '@/types';
import { FileStack, Copy, TrendingUp, Wifi, AlertTriangle, Star, ArrowRight, Search, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { runForumScan, subscribeToJob } from '@/api';

interface SourcesTabProps {
  stats: VerticalStats[];
  wireCounts: WireCounts[];
  onNavigateToQueue: (wire: string) => void;
}

function qualityConfig(score: number): { color: string; label: string; bg: string; border: string } {
  if (score >= 60) return {
    color: 'text-status-success',
    label: 'Healthy',
    bg: 'bg-status-success/10',
    border: 'border-status-success/30',
  };
  if (score >= 40) return {
    color: 'text-status-warning',
    label: 'Marginal',
    bg: 'bg-status-warning/10',
    border: 'border-status-warning/30',
  };
  return {
    color: 'text-destructive',
    label: 'Poor — most items auto-archived',
    bg: 'bg-destructive/10',
    border: 'border-destructive/30',
  };
}

export function SourcesTab({ stats, wireCounts, onNavigateToQueue }: SourcesTabProps) {
  const [forumStatus, setForumStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [forumProgress, setForumProgress] = useState('');
  const [forumResult, setForumResult] = useState('');

  const handleForumScan = async () => {
    setForumStatus('running');
    setForumProgress('Starting forum scan...');
    setForumResult('');
    try {
      const { jobId } = await runForumScan();
      subscribeToJob(
        jobId,
        (data) => {
          if (data.message) setForumProgress(data.message);
          if (data.status === 'completed') {
            const r = data.result;
            setForumResult(
              r ? `${r.totalResults} found, ${r.intakeSummary?.newUnique ?? 0} unique, ${r.intakeSummary?.highQualityCount ?? 0} high quality` : 'Complete'
            );
            setForumStatus('done');
          }
          if (data.status === 'failed') {
            setForumResult(data.error || 'Scan failed');
            setForumStatus('error');
          }
        },
        () => {
          if (forumStatus === 'running') setForumStatus('done');
        }
      );
    } catch (err: any) {
      setForumResult(err.message || 'Failed to start');
      setForumStatus('error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {stats.map((stat, index) => {
          const hoursAgo = (Date.now() - new Date(stat.last_scan).getTime()) / 3_600_000;
          const isStale = hoursAgo > 6;
          const qConfig = qualityConfig(stat.avg_quality_score);
          const counts = wireCounts.find(w => w.wire === stat.wire);
          const highQualityPct = stat.items_this_week > 0
            ? Math.round((stat.high_quality_count / stat.items_this_week) * 100)
            : 0;

          return (
            <div key={stat.wire || index} className="stat-card group flex flex-col">
              {/* Decorative corner pulse */}
              <div className="absolute top-0 right-0 w-16 h-16 overflow-hidden">
                <div
                  className="absolute top-2 right-2 w-1 h-1 rounded-full bg-primary/50 signal-pulse"
                  style={{ animationDelay: `${index * 0.3}s` }}
                />
              </div>

              {/* Card header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Wifi className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-sm tracking-wider uppercase">
                      {stat.wire || <span className="text-muted-foreground italic">unknown</span>}
                    </h3>
                    <p className="text-[10px] text-muted-foreground font-mono">
                      {stat.scans_run} scans this week
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isStale && (
                    <span title={`Last scan ${Math.round(hoursAgo)}h ago — pipeline may be stalled`}>
                      <AlertTriangle className="w-4 h-4 text-status-warning animate-pulse" />
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground font-mono px-2 py-1 rounded bg-muted/50 border border-border">
                    {formatDistanceToNow(new Date(stat.last_scan), { addSuffix: true })}
                  </span>
                </div>
              </div>

              {/* Metrics grid */}
              <div className="grid grid-cols-2 gap-3 flex-1">
                {/* Ingested */}
                <div className="space-y-1 p-3 rounded bg-muted/30 border border-border/50">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <FileStack className="w-3 h-3" />
                    Ingested
                  </div>
                  <div className="text-2xl font-mono font-semibold text-foreground">
                    {stat.items_this_week}
                  </div>
                </div>

                {/* Duplicates */}
                <div className="space-y-1 p-3 rounded bg-muted/30 border border-border/50">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <Copy className="w-3 h-3" />
                    Duplicates
                  </div>
                  <div className="text-2xl font-mono font-semibold text-foreground">
                    {stat.duplicate_rate}<span className="text-sm text-muted-foreground">%</span>
                  </div>
                </div>

                {/* Avg Quality — with color threshold */}
                <div className={`space-y-1 p-3 rounded border ${qConfig.bg} ${qConfig.border}`}>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <TrendingUp className="w-3 h-3" />
                    Avg Quality
                  </div>
                  <div className={`text-2xl font-mono font-semibold ${qConfig.color}`}>
                    {stat.avg_quality_score}
                    <span className="text-[10px] ml-1 font-normal opacity-70">{qConfig.label}</span>
                  </div>
                </div>

                {/* High Quality (>=70) — replaces redundant Last Ping */}
                <div className="space-y-1 p-3 rounded bg-muted/30 border border-border/50">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <Star className="w-3 h-3" />
                    High Quality
                  </div>
                  <div className="text-2xl font-mono font-semibold text-foreground">
                    {stat.high_quality_count}
                    {stat.items_this_week > 0 && (
                      <span className={`text-sm ml-1 ${highQualityPct >= 20 ? 'text-status-success' : highQualityPct >= 5 ? 'text-status-warning' : 'text-destructive'}`}>
                        {highQualityPct}%
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Queue depth row */}
              {counts && (
                <div className="mt-3 pt-3 border-t border-border/50 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Queued</div>
                    <div className={`text-sm font-mono font-semibold ${counts.queued > 0 ? 'text-primary' : 'text-muted-foreground'}`}>
                      {counts.queued}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Approved</div>
                    <div className="text-sm font-mono font-semibold text-status-success">{counts.approved}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Archived</div>
                    <div className="text-sm font-mono font-semibold text-muted-foreground">{counts.archived}</div>
                  </div>
                </div>
              )}

              {/* View Queue link */}
              {counts && counts.queued > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNavigateToQueue(stat.wire)}
                  className="mt-3 w-full gap-1.5 text-primary hover:text-primary/80 hover:bg-primary/5 font-display text-[10px] tracking-wider border border-primary/20 hover:border-primary/40"
                >
                  VIEW {counts.queued} IN QUEUE
                  <ArrowRight className="w-3 h-3" />
                </Button>
              )}
            </div>
          );
        })}

        {/* Quiet wires — configured but with no scans this week (e.g. OSS). Show
            them so a whole wire doesn't vanish from the operator view when idle. */}
        {wireCounts
          .filter(wc => wc.wire && !stats.some(st => st.wire === wc.wire))
          .map((counts) => (
            <div key={counts.wire} className="stat-card group flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-muted/40 border border-border flex items-center justify-center">
                    <Wifi className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-sm tracking-wider uppercase">{counts.wire}</h3>
                    <p className="text-[10px] text-muted-foreground font-mono">no scans this week</p>
                  </div>
                </div>
                <span className="text-[10px] text-muted-foreground font-mono px-2 py-1 rounded bg-muted/50 border border-border">idle</span>
              </div>
              <div className="mt-auto pt-3 border-t border-border/50 grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Queued</div>
                  <div className={`text-sm font-mono font-semibold ${counts.queued > 0 ? 'text-primary' : 'text-muted-foreground'}`}>{counts.queued}</div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Approved</div>
                  <div className="text-sm font-mono font-semibold text-status-success">{counts.approved}</div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Archived</div>
                  <div className="text-sm font-mono font-semibold text-muted-foreground">{counts.archived}</div>
                </div>
              </div>
            </div>
          ))}

      </div>

      {/* Forum Scan */}
      <div className="stat-card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Search className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h3 className="font-display font-semibold text-sm tracking-wider uppercase">Forum Scan</h3>
              <p className="text-[10px] text-muted-foreground font-mono">
                discuss.watch — 150+ Discourse forums
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleForumScan}
            disabled={forumStatus === 'running'}
            className="gap-1.5 font-display text-[10px] tracking-wider"
          >
            {forumStatus === 'running' ? (
              <><Loader2 className="w-3 h-3 animate-spin" /> SCANNING...</>
            ) : (
              <><Search className="w-3 h-3" /> RUN SCAN</>
            )}
          </Button>
        </div>
        {(forumProgress || forumResult) && (
          <div className="mt-3 pt-3 border-t border-border/50">
            {forumStatus === 'running' && (
              <p className="text-[11px] text-muted-foreground font-mono">{forumProgress}</p>
            )}
            {forumResult && (
              <p className={`text-[11px] font-mono ${forumStatus === 'error' ? 'text-destructive' : 'text-status-success'}`}>
                {forumResult}
              </p>
            )}
          </div>
        )}
      </div>

      {stats.length === 0 && wireCounts.length === 0 && (
        <div className="glow-card p-12 text-center">
          <span className="text-5xl mx-auto mb-4 block w-fit opacity-50">🛰️</span>
          <p className="text-muted-foreground font-display text-sm tracking-wider">NO SOURCES CONFIGURED</p>
        </div>
      )}
    </div>
  );
}
