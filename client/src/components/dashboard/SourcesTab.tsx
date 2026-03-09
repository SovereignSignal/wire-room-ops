import { VerticalStats } from '@/types';
import { Clock, FileStack, Copy, TrendingUp, Wifi, Satellite } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ScoreBadge } from './ScoreBadge';

interface SourcesTabProps {
  stats: VerticalStats[];
}

export function SourcesTab({ stats }: SourcesTabProps) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {stats.map((stat, index) => (
          <div key={stat.wire} className="stat-card group">
            {/* Decorative corner */}
            <div className="absolute top-0 right-0 w-16 h-16 overflow-hidden">
              <div className="absolute top-2 right-2 w-1 h-1 rounded-full bg-primary/50 signal-pulse" style={{ animationDelay: `${index * 0.3}s` }} />
              <div className="absolute top-2 right-5 w-1 h-1 rounded-full bg-primary/30" />
              <div className="absolute top-5 right-2 w-1 h-1 rounded-full bg-primary/30" />
            </div>

            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Wifi className="w-4 h-4 text-primary" />
                </div>
                <h3 className="font-display font-semibold text-sm tracking-wider uppercase">{stat.wire}</h3>
              </div>
              <span className="text-[10px] text-muted-foreground font-mono px-2 py-1 rounded bg-muted/50 border border-border">
                {formatDistanceToNow(new Date(stat.last_scan), { addSuffix: true })}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1 p-3 rounded bg-muted/30 border border-border/50">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                  <FileStack className="w-3 h-3" />
                  Ingested
                </div>
                <div className="text-2xl font-mono font-semibold text-foreground">
                  {stat.items_this_week}
                </div>
              </div>

              <div className="space-y-1 p-3 rounded bg-muted/30 border border-border/50">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                  <Copy className="w-3 h-3" />
                  Duplicates
                </div>
                <div className="text-2xl font-mono font-semibold text-foreground">
                  {stat.duplicate_rate}<span className="text-sm text-muted-foreground">%</span>
                </div>
              </div>

              <div className="space-y-1 p-3 rounded bg-muted/30 border border-border/50">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                  <TrendingUp className="w-3 h-3" />
                  Avg Quality
                </div>
                <div className="flex items-center gap-2">
                  <ScoreBadge score={stat.avg_quality_score} />
                </div>
              </div>

              <div className="space-y-1 p-3 rounded bg-muted/30 border border-border/50">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                  <Clock className="w-3 h-3" />
                  Last Ping
                </div>
                <div className="text-sm font-mono text-foreground">
                  {new Date(stat.last_scan).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {stats.length === 0 && (
        <div className="glow-card p-12 text-center">
          <span className="text-5xl mx-auto mb-4 block w-fit opacity-50">🛰️</span>
          <p className="text-muted-foreground font-display text-sm tracking-wider">NO SOURCES CONFIGURED</p>
        </div>
      )}
    </div>
  );
}
