import { DashboardDataAvailability, ScanEntry, VerticalStats } from '@/types';
import { ScoreBadge } from './ScoreBadge';
import { Activity, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface OverviewTabProps {
  queueEntries: ScanEntry[];
  publishedEntries: ScanEntry[];
  queuedCount: number;
  approvedCount: number;
  totalWires: number;
  rawCount: number;
  stats: VerticalStats[];
  availability: DashboardDataAvailability;
}

function MetricValue({ available, value }: { available: boolean; value: number }) {
  if (!available) {
    return <span className="text-sm font-display tracking-wider text-muted-foreground">UNAVAILABLE</span>;
  }
  return <>{value}</>;
}

export function OverviewTab({ queueEntries, publishedEntries, queuedCount, approvedCount, totalWires, rawCount, stats, availability }: OverviewTabProps) {
  const totalItemsThisWeek = stats.reduce((acc, curr) => acc + curr.items_this_week, 0);
  // Volume-weighted average across wires — a near-empty wire shouldn't swing the
  // number as much as a busy one. Falls back to a simple mean when there's no volume.
  const avgQuality = totalItemsThisWeek > 0
    ? stats.reduce((acc, curr) => acc + curr.avg_quality_score * curr.items_this_week, 0) / totalItemsThisWeek
    : stats.length > 0
      ? stats.reduce((acc, curr) => acc + curr.avg_quality_score, 0) / stats.length
      : 0;

  // Get most recent items across all categories
  const recentItems = [...queueEntries, ...publishedEntries]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Ingested */}
        <div className="stat-card group">
          <div className="absolute top-0 right-0 w-16 h-16 overflow-hidden">
            <div className="absolute top-2 right-2 w-1 h-1 rounded-full bg-primary/50 signal-pulse" />
          </div>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center text-lg">
              📡
            </div>
            <h3 className="font-display font-semibold text-sm tracking-wider uppercase">INGESTED THIS WEEK</h3>
          </div>
          <div className="text-3xl font-mono font-semibold text-foreground">
            <MetricValue available={availability.stats} value={totalItemsThisWeek} />
          </div>
        </div>

        {/* Queue */}
        <div className="stat-card group">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center text-lg">
              ⏳
            </div>
            <h3 className="font-display font-semibold text-sm tracking-wider uppercase">IN QUEUE</h3>
          </div>
          <div className="text-3xl font-mono font-semibold text-foreground">
            <MetricValue available={availability.wireCounts} value={queuedCount} />
          </div>
        </div>

        {/* Raw / Incoming */}
        <div className="stat-card group">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded bg-orange-500/10 border border-orange-500/20 flex items-center justify-center text-lg">
              📥
            </div>
            <h3 className="font-display font-semibold text-sm tracking-wider uppercase">RAW / INCOMING</h3>
          </div>
          <div className="text-3xl font-mono font-semibold text-foreground">
            <MetricValue available={availability.wireCounts} value={rawCount} />
          </div>
        </div>

        {/* Published */}
        <div className="stat-card group">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded bg-status-success/10 border border-status-success/20 flex items-center justify-center text-lg">
              ✅
            </div>
            <h3 className="font-display font-semibold text-sm tracking-wider uppercase">APPROVED</h3>
          </div>
          <div className="text-3xl font-mono font-semibold text-foreground">
            <MetricValue available={availability.wireCounts} value={approvedCount} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* System Status */}
        <div className="glow-card p-6 col-span-1 lg:col-span-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-display tracking-wider mb-6">
            <Activity className="w-4 h-4 text-primary" />
            <span>SYSTEM STATUS</span>
          </div>
          
          <div className="space-y-6">
            <div className="flex justify-between items-center pb-4 border-b border-border">
              <span className="text-sm font-mono text-muted-foreground">Avg Quality</span>
              <ScoreBadge score={availability.stats ? Math.round(avgQuality) : null} />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-mono text-muted-foreground">Wires active this week</span>
              <span className="font-mono">
                {availability.stats && availability.wireCounts ? `${stats.length} / ${totalWires}` : 'Unavailable'}
              </span>
            </div>
          </div>
        </div>

        {/* Recent Activity */}
        <div className="glow-card p-0 col-span-1 lg:col-span-2 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-border flex items-center gap-2 text-xs text-muted-foreground font-display tracking-wider bg-card/50">
            <Clock className="w-4 h-4 text-primary" />
            <span>RECENT ACTIVITY</span>
          </div>
          
          <div className="flex-1 overflow-auto">
            {recentItems.length > 0 ? (
              <table className="ops-table w-full">
                <tbody>
                  {recentItems.map(item => (
                    <tr key={item.id}>
                      <td className="w-8">
                        {item.status === 'queued' && <span className="text-primary opacity-80">⏳</span>}
                        {item.status === 'approved' && <span className="text-status-success opacity-80">✅</span>}
                        {item.status === 'archived' && <span className="text-muted-foreground opacity-80">❌</span>}
                      </td>
                      <td>
                        <div className="font-medium text-sm text-foreground truncate max-w-[200px] md:max-w-md">{item.name}</div>
                      </td>
                      <td className="w-24">
                        <span className="text-[10px] uppercase font-display tracking-wider text-muted-foreground px-2 py-1 rounded bg-muted/50 border border-border">
                          {item.wire}
                        </span>
                      </td>
                      <td className="w-32 text-right">
                        <span className="text-xs text-muted-foreground font-mono">
                          {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : availability.queuedEntries || availability.approvedEntries ? (
              <div className="p-8 text-center text-muted-foreground font-display text-sm tracking-wider">
                NO RECENT ACTIVITY
              </div>
            ) : (
              <div className="p-8 text-center text-status-danger font-display text-sm tracking-wider">
                ACTIVITY UNAVAILABLE
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
