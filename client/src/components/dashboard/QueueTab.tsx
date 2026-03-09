import { useState, useMemo, useRef, useEffect } from 'react';
import { ScanEntry, FilterState } from '@/types';
import { ScoreBadge } from './ScoreBadge';
import { VerticalTag } from './VerticalTag';
import { ActionBar } from './ActionBar';
import { FilterBar } from './FilterBar';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { ExternalLink, CheckCircle, Archive, ChevronDown } from 'lucide-react';
import { updateEntryWire } from '@/api';

const WIRE_OPTIONS = ['crypto', 'ai', 'oss'] as const;

const wireColors: Record<string, string> = {
  crypto: 'bg-violet-500/20 text-violet-400 border-violet-500/40 hover:bg-violet-500/30',
  ai: 'bg-emerald-400/20 text-emerald-400 border-emerald-400/40 hover:bg-emerald-400/30',
  oss: 'bg-amber-400/20 text-amber-400 border-amber-400/40 hover:bg-amber-400/30',
};

const wireFilterColors: Record<string, string> = {
  crypto: 'bg-violet-500/20 text-violet-400 border-violet-500/50',
  ai: 'bg-emerald-400/20 text-emerald-400 border-emerald-400/50',
  oss: 'bg-amber-400/20 text-amber-400 border-amber-400/50',
};

function WireSelector({ wire, entryId, onWireChange }: { wire: string; entryId: string; onWireChange: (id: string, wire: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const colorClass = wireColors[wire.toLowerCase()] || 'bg-muted text-muted-foreground border-border hover:bg-muted/80';

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-display font-medium border uppercase tracking-wider transition-colors cursor-pointer ${colorClass}`}
      >
        {wire}
        <ChevronDown className="w-2.5 h-2.5 opacity-60" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 left-0 bg-card border border-border rounded-md shadow-lg py-1 min-w-[90px]">
          {WIRE_OPTIONS.map(w => (
            <button
              key={w}
              onClick={(e) => {
                e.stopPropagation();
                if (w !== wire) onWireChange(entryId, w);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-[10px] font-display uppercase tracking-wider transition-colors ${
                w === wire 
                  ? 'bg-primary/10 text-primary' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface QueueTabProps {
  entries: ScanEntry[];
  verticals: string[];
  onUpdateStatus: (ids: string[], status: ScanEntry['status']) => void;
  onViewDetails: (entry: ScanEntry) => void;
  onSingleAction?: (id: string, status: ScanEntry['status']) => void;
  onEntryUpdated?: (id: string, updates: Partial<ScanEntry>) => void;
}

export function QueueTab({ entries, verticals, onUpdateStatus, onViewDetails, onSingleAction, onEntryUpdated }: QueueTabProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [wireFilter, setWireFilter] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>({
    wire: null,
    scoreMin: null,
    scoreMax: null,
    dateStatus: 'all',
  });

  const handleWireChange = async (entryId: string, newWire: string) => {
    try {
      await updateEntryWire(entryId, newWire);
      onEntryUpdated?.(entryId, { wire: newWire });
    } catch (err) {
      console.error('Failed to update wire:', err);
    }
  };

  const filteredEntries = useMemo(() => {
    return entries.filter(entry => {
      // Quick wire filter (button group)
      if (wireFilter && entry.wire !== wireFilter) return false;
      // Advanced filters
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
  }, [entries, filters, wireFilter]);

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
      {/* Quick wire filter buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setWireFilter(null)}
          className={`px-3 py-1.5 rounded text-[10px] font-display font-medium uppercase tracking-wider border transition-colors ${
            wireFilter === null
              ? 'bg-primary/20 text-primary border-primary/50'
              : 'bg-muted/30 text-muted-foreground border-border hover:text-foreground hover:bg-muted/50'
          }`}
        >
          All
        </button>
        {WIRE_OPTIONS.map(w => (
          <button
            key={w}
            onClick={() => setWireFilter(wireFilter === w ? null : w)}
            className={`px-3 py-1.5 rounded text-[10px] font-display font-medium uppercase tracking-wider border transition-colors ${
              wireFilter === w
                ? wireFilterColors[w]
                : 'bg-muted/30 text-muted-foreground border-border hover:text-foreground hover:bg-muted/50'
            }`}
          >
            {w}
          </button>
        ))}
      </div>

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
              <th className="w-48 min-w-[12rem]">Actions</th>
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
                <td onClick={(e) => e.stopPropagation()}>
                  <WireSelector wire={entry.wire} entryId={entry.id} onWireChange={handleWireChange} />
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
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    <Button
                      size="sm"
                      onClick={() => (onSingleAction ?? ((id, s) => onUpdateStatus([id], s)))(entry.id, 'approved')}
                      className="gap-1 bg-status-success/20 text-status-success border border-status-success/30 hover:bg-status-success/30 font-display text-[10px] tracking-wider h-7 px-2.5"
                    >
                      <CheckCircle className="w-3 h-3 shrink-0" />
                      OK
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => (onSingleAction ?? ((id, s) => onUpdateStatus([id], s)))(entry.id, 'archived')}
                      className="gap-1 font-display text-[10px] tracking-wider h-7 px-2.5"
                    >
                      <Archive className="w-3 h-3 shrink-0" />
                      SKIP
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredEntries.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center py-12 text-muted-foreground font-display text-sm tracking-wider">
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
