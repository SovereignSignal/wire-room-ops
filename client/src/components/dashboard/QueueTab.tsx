import { useState, useMemo } from 'react';
import { ScanEntry, FilterState } from '@/types';
import { ScoreBadge } from './ScoreBadge';
import { VerticalTag } from './VerticalTag';
import { ActionBar } from './ActionBar';
import { FilterBar } from './FilterBar';
import { Checkbox } from '@/components/ui/checkbox';
import { ExternalLink } from 'lucide-react';

interface QueueTabProps {
  entries: ScanEntry[];
  verticals: string[];
  onUpdateStatus: (ids: string[], status: ScanEntry['status']) => void;
  onViewDetails: (entry: ScanEntry) => void;
}

export function QueueTab({ entries, verticals, onUpdateStatus, onViewDetails }: QueueTabProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<FilterState>({
    wire: null,
    scoreMin: null,
    scoreMax: null,
    dateStatus: 'all',
  });

  const filteredEntries = useMemo(() => {
    return entries.filter(entry => {
      if (filters.wire && entry.wire !== filters.wire) return false;
      if (filters.scoreMin !== null && entry.quality_score < filters.scoreMin) return false;
      if (filters.scoreMax !== null && entry.quality_score > filters.scoreMax) return false;
      
      if (filters.dateStatus !== 'all') {
        const hasDate = !!entry.deadline_parsed;
        const isExpired = hasDate && new Date(entry.deadline_parsed!) < new Date();
        
        if (filters.dateStatus === 'no_date' && hasDate) return false;
        if (filters.dateStatus === 'upcoming' && (!hasDate || isExpired)) return false;
        if (filters.dateStatus === 'expired' && !isExpired) return false;
      }
      
      return true;
    });
  }, [entries, filters]);

  const toggleSelect = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredEntries.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredEntries.map(e => e.id)));
    }
  };

  const handleAction = (status: ScanEntry['status']) => {
    onUpdateStatus(Array.from(selectedIds), status);
    setSelectedIds(new Set());
  };

  return (
    <div className="space-y-4">
      <FilterBar filters={filters} onFilterChange={setFilters} verticals={verticals} />
      
      <div className="glow-card overflow-hidden">
        <table className="ops-table">
          <thead>
            <tr>
              <th className="w-10">
                <Checkbox 
                  checked={selectedIds.size === filteredEntries.length && filteredEntries.length > 0}
                  onCheckedChange={toggleSelectAll}
                  className="border-primary/50 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                />
              </th>
              <th>Designation</th>
              <th className="w-24">Vertical</th>
              <th className="w-20">Signal</th>
              <th className="w-24">Value</th>
              <th className="w-28">Deadline</th>
              <th className="w-20">Source</th>
            </tr>
          </thead>
          <tbody>
            {filteredEntries.map(entry => (
              <tr 
                key={entry.id} 
                className={`cursor-pointer ${selectedIds.has(entry.id) ? 'bg-primary/5' : ''}`}
                onClick={() => onViewDetails(entry)}
              >
                <td onClick={(e) => e.stopPropagation()}>
                  <Checkbox 
                    checked={selectedIds.has(entry.id)}
                    onCheckedChange={() => toggleSelect(entry.id)}
                    className="border-primary/50 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                  />
                </td>
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
                  <a 
                    href={entry.source_url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:text-primary/80 text-sm transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </td>
              </tr>
            ))}
            {filteredEntries.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-12 text-muted-foreground font-display text-sm tracking-wider">
                  NO ITEMS MATCH FILTERS
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ActionBar
        selectedCount={selectedIds.size}
        onApprove={() => handleAction('approved')}
        onArchive={() => handleAction('archived')}
        onFlag={() => handleAction('flagged')}
        onClear={() => setSelectedIds(new Set())}
      />
    </div>
  );
}
