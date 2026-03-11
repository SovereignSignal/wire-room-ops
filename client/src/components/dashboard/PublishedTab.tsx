import { useState, useMemo } from 'react';
import { ScanEntry } from '@/types';
import { ScoreBadge } from './ScoreBadge';
import { VerticalTag } from './VerticalTag';
import { DistributionBadges } from './DistributionBadges';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ExternalLink } from 'lucide-react';

interface PublishedTabProps {
  entries: ScanEntry[];
  verticals: string[];
  onViewDetails: (entry: ScanEntry) => void;
}

export function PublishedTab({ entries, verticals, onViewDetails }: PublishedTabProps) {
  const [activeVertical, setActiveVertical] = useState<string>('all');

  const filteredEntries = useMemo(() => {
    if (activeVertical === 'all') return entries;
    return entries.filter(e => e.wire === activeVertical);
  }, [entries, activeVertical]);

  return (
    <div className="space-y-4">
      {/* Vertical sub-tabs */}
      <Tabs value={activeVertical} onValueChange={setActiveVertical}>
        <TabsList className="bg-card/50 border border-border h-10">
          <TabsTrigger 
            value="all" 
            className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary font-display text-[10px] tracking-wider"
          >
            ALL
            <span className="ml-1.5 text-[10px] text-muted-foreground font-mono">
              {entries.length}
            </span>
          </TabsTrigger>
          {verticals.map(v => {
            const count = entries.filter(e => e.wire === v).length;
            return (
              <TabsTrigger 
                key={v}
                value={v}
                className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary font-display text-[10px] tracking-wider uppercase"
              >
                {v}
                <span className="ml-1.5 text-[10px] text-muted-foreground font-mono">
                  {count}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      <div className="glow-card overflow-hidden">
        <table className="ops-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="w-24">Wire</th>
              <th className="w-20">Score</th>
              <th className="w-24">Amount</th>
              <th className="w-28">Deadline</th>
              <th className="w-48">Distribution</th>
              <th className="w-20">Source</th>
            </tr>
          </thead>
          <tbody>
            {filteredEntries.map(entry => (
              <tr key={entry.id} className="cursor-pointer" onClick={() => onViewDetails(entry)}>
                <td>
                  <div className="font-medium text-foreground">{entry.name}</div>
                  <div className="text-xs text-muted-foreground truncate max-w-md">
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
                <td className="text-sm font-mono">
                  {entry.deadline || <span className="text-muted-foreground">—</span>}
                </td>
                <td>
                  <DistributionBadges channels={entry.distribution_channels || []} />
                </td>
                <td>
                  {entry.source_url && entry.source_url.startsWith('http') ? (
                    <a
                      href={entry.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:text-primary/80 text-sm"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
            {filteredEntries.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-12 text-muted-foreground font-display text-sm tracking-wider">
                  NO PUBLISHED ITEMS
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
