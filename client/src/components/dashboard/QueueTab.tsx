import { useState, useMemo, useRef, useEffect } from 'react';
import { ScanEntry, FilterState, Classification } from '@/types';
import { ScoreBadge } from './ScoreBadge';
import { VerticalTag } from './VerticalTag';
import { ActionBar } from './ActionBar';
import { FilterBar } from './FilterBar';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { ExternalLink, CheckCircle, Archive, ChevronDown, EyeOff } from 'lucide-react';
import { updateEntryWires, fetchWires } from '@/api';

const classificationStyles: Record<string, string> = {
  GRANT: 'border-green-500/50 text-green-400 bg-green-500/10',
  EXPIRED: 'border-orange-500/50 text-orange-400 bg-orange-500/10',
  NEWS: 'border-blue-500/50 text-blue-400 bg-blue-500/10',
  NOISE: 'border-red-500/50 text-red-400 bg-red-500/10',
  UNCHECKED: 'border-border text-muted-foreground bg-muted/20',
};

const classificationLabels: Record<string, string> = {
  GRANT: '\u2705 GRANT',
  EXPIRED: '\u23F0 EXPIRED',
  NEWS: '\uD83D\uDCF0 NEWS',
  NOISE: '\uD83D\uDEAB NOISE',
  UNCHECKED: '\u2014 UNCLASSIFIED',
};

function ClassificationBadge({ classification }: { classification?: Classification }) {
  const cls = classification || 'UNCHECKED';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono font-medium border ${classificationStyles[cls]}`}>
      {classificationLabels[cls]}
    </span>
  );
}

// Fallback colors for known wires; unknown wires get a neutral style
const wireColors: Record<string, string> = {
  crypto: 'bg-violet-500/20 text-violet-400 border-violet-500/40 hover:bg-violet-500/30',
  ai: 'bg-emerald-400/20 text-emerald-400 border-emerald-400/40 hover:bg-emerald-400/30',
  oss: 'bg-amber-400/20 text-amber-400 border-amber-400/40 hover:bg-amber-400/30',
};
const DEFAULT_WIRE_COLOR = 'bg-sky-500/20 text-sky-400 border-sky-500/40 hover:bg-sky-500/30';

const wireFilterColors: Record<string, string> = {
  crypto: 'bg-violet-500/20 text-violet-400 border-violet-500/50',
  ai: 'bg-emerald-400/20 text-emerald-400 border-emerald-400/50',
  oss: 'bg-amber-400/20 text-amber-400 border-amber-400/50',
};

function getSourceLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.includes('x.com') || host.includes('twitter.com')) return 'X';
    if (host.includes('github.com')) return 'GH';
    if (host.includes('linkedin.com')) return 'LI';
    if (host.includes('medium.com')) return 'MED';
    if (host.includes('substack.com')) return 'SUB';
    // Return first segment of domain, max 4 chars
    return host.split('.')[0].slice(0, 4).toUpperCase();
  } catch {
    return 'LINK';
  }
}

function isXUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'x.com' || host === 'twitter.com';
  } catch { return false; }
}

/** Returns the stored source URL if valid, or null if missing */
function resolveSourceUrl(entry: { source_url?: string }): string | null {
  const url = entry.source_url?.trim();
  if (url && url.startsWith('http') && !url.startsWith('https://manual/') && !url.startsWith('https://t.me/manual/')) {
    return url;
  }
  return null;
}

/** Returns the raw stored URL only for display in the slide-out (labeled as potentially stale) */
function getDirectUrl(entry: { source_url?: string; description?: string }): string | null {
  const url = entry.source_url?.trim();
  if (url && url.startsWith('http') && !url.startsWith('https://manual/') && !url.startsWith('https://t.me/manual/') && !isXUrl(url)) {
    return url; // show non-X direct links in slide-out as secondary option
  }
  return null;
}

function ExpandableDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 120;
  return (
    <div className="text-xs text-muted-foreground mt-0.5">
      <span className={expanded ? '' : 'line-clamp-1'}>{text}</span>
      {isLong && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="ml-1 text-primary/60 hover:text-primary text-[10px] font-mono whitespace-nowrap"
        >
          {expanded ? '▲ less' : '▼ more'}
        </button>
      )}
    </div>
  );
}

function WireSelector({ wire, wires, entryId, onWiresChange, availableWires = [] }: {
  wire: string;
  wires?: string[];
  entryId: string;
  onWiresChange: (id: string, wires: string[]) => void;
  availableWires?: { key: string; displayName: string }[];
}) {
  const options = availableWires.length > 0 ? availableWires.map(w => w.key) : [wire];
  const selected = (wires && wires.length > 0) ? wires : [wire];
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

  const toggleWire = (w: string) => {
    let next: string[];
    if (selected.includes(w)) {
      next = selected.filter(s => s !== w);
      if (next.length === 0) return; // must have at least one
    } else {
      next = [...selected, w];
    }
    onWiresChange(entryId, next);
  };

  const primaryColor = wireColors[selected[0]?.toLowerCase()] || 'bg-muted text-muted-foreground border-border hover:bg-muted/80';

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-display font-medium border uppercase tracking-wider transition-colors cursor-pointer ${primaryColor}`}
      >
        {selected.length > 1 ? `${selected[0]} +${selected.length - 1}` : selected[0]}
        <ChevronDown className="w-2.5 h-2.5 opacity-60" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 left-0 bg-card border border-border rounded-md shadow-lg py-1 min-w-[110px]">
          {options.map(w => {
            const isSelected = selected.includes(w);
            return (
              <button
                key={w}
                onClick={(e) => { e.stopPropagation(); toggleWire(w); }}
                className={`w-full text-left px-3 py-1.5 text-[10px] font-display uppercase tracking-wider transition-colors flex items-center gap-2 ${
                  isSelected
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                <span className={`w-3 h-3 rounded-sm border flex items-center justify-center text-[8px] ${
                  isSelected ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/40'
                }`}>
                  {isSelected && '✓'}
                </span>
                {w}
              </button>
            );
          })}
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
  onQuietApprove: (ids: string[]) => void;
  onEntryUpdated?: (id: string, updates: Partial<ScanEntry>) => void;
  onRefresh?: () => void;
}

export function QueueTab({ entries, verticals, onUpdateStatus, onViewDetails, onSingleAction, onQuietApprove, onEntryUpdated, onRefresh }: QueueTabProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [wireFilter, setWireFilter] = useState<string | null>(null);
  const [classificationFilter, setClassificationFilter] = useState<string | null>(null);
  const [availableWires, setAvailableWires] = useState<{ key: string; displayName: string }[]>([]);

  useEffect(() => {
    fetchWires().then(wires => {
      if (wires.length > 0) setAvailableWires(wires);
    }).catch(() => {/* fail silently — hardcoded fallback still visible in entries */});
  }, []);
  const [filters, setFilters] = useState<FilterState>({
    wire: null,
    scoreMin: null,
    scoreMax: null,
    dateStatus: 'all',
  });

  const handleWiresChange = async (entryId: string, newWires: string[]) => {
    try {
      await updateEntryWires(entryId, newWires);
      onEntryUpdated?.(entryId, { wire: newWires[0], wires: newWires });
    } catch (err) {
      console.error('Failed to update wires:', err);
    }
  };

  const filteredEntries = useMemo(() => {
    return entries.filter(entry => {
      // Quick wire filter (button group)
      if (wireFilter && entry.wire !== wireFilter) return false;
      // Classification filter
      if (classificationFilter) {
        const entryCls = entry.classification || 'UNCHECKED';
        if (entryCls !== classificationFilter) return false;
      }
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
  }, [entries, filters, wireFilter, classificationFilter]);

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
      {/* Quick wire filter buttons + classify action */}
      <div className="flex items-center gap-2 flex-wrap">
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
        {availableWires.map(({ key: w, displayName }) => (
          <button
            key={w}
            onClick={() => setWireFilter(wireFilter === w ? null : w)}
            className={`px-3 py-1.5 rounded text-[10px] font-display font-medium uppercase tracking-wider border transition-colors ${
              wireFilter === w
                ? (wireFilterColors[w] || 'bg-sky-500/20 text-sky-400 border-sky-500/50')
                : 'bg-muted/30 text-muted-foreground border-border hover:text-foreground hover:bg-muted/50'
            }`}
          >
            {displayName || w}
          </button>
        ))}


      </div>

      {/* Classification filter */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground font-mono mr-1">TYPE:</span>
        <button
          onClick={() => setClassificationFilter(null)}
          className={`px-2 py-1 rounded text-[9px] font-mono border transition-colors ${
            classificationFilter === null
              ? 'bg-primary/20 text-primary border-primary/50'
              : 'bg-muted/20 text-muted-foreground border-border hover:text-foreground hover:bg-muted/40'
          }`}
        >
          All
        </button>
        {(['GRANT', 'EXPIRED', 'NEWS', 'NOISE', 'UNCHECKED'] as const).map(cls => (
          <button
            key={cls}
            onClick={() => setClassificationFilter(classificationFilter === cls ? null : cls)}
            className={`px-2 py-1 rounded text-[9px] font-mono border transition-colors ${
              classificationFilter === cls
                ? classificationStyles[cls]
                : 'bg-muted/20 text-muted-foreground border-border hover:text-foreground hover:bg-muted/40'
            }`}
          >
            {classificationLabels[cls]}
          </button>
        ))}
      </div>

      <FilterBar filters={filters} onFilterChange={setFilters} verticals={verticals} />
      
      {/* Mobile card view */}
      <div className="block md:hidden space-y-2">
        {filteredEntries.length === 0 ? (
          <div className="glow-card p-8 text-center">
            <span className="text-4xl block mb-3 opacity-50">📡</span>
            <p className="text-muted-foreground font-display text-sm tracking-wider">NO ITEMS MATCH FILTERS</p>
          </div>
        ) : filteredEntries.map(entry => (
          <div
            key={entry.id}
            className={`glow-card p-3 ${selectedIds.has(entry.id) ? 'border-primary/40 bg-primary/5' : ''}`}
          >
            {/* Row 1: Checkbox + Name + Source link */}
            <div className="flex items-start gap-2">
              <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={selectedIds.has(entry.id)}
                  onCheckedChange={() => toggleSelect(entry.id)}
                  className="border-primary/50 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                />
              </div>
              <div className="flex-1 min-w-0" onClick={() => onViewDetails(entry)}>
                <div className="font-medium text-foreground text-sm leading-tight">{entry.name}</div>
                {entry.description && (
                  <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{entry.description}</div>
                )}
              </div>
              {resolveSourceUrl(entry) ? (
                <a href={resolveSourceUrl(entry)!} target="_blank" rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-primary hover:text-primary/80 shrink-0 p-1">
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              ) : (
                <span className="text-muted-foreground shrink-0 p-1 text-xs">—</span>
              )}
            </div>

            {/* Row 2: Badges + Amount/Deadline */}
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <div onClick={(e) => e.stopPropagation()}>
                <WireSelector wire={entry.wire} wires={entry.wires} entryId={entry.id} onWiresChange={handleWiresChange} availableWires={availableWires} />
              </div>
              <ClassificationBadge classification={entry.classification} />
              <ScoreBadge score={entry.quality_score} />
              {entry.source_published_at && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  {new Date(entry.source_published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              )}
              {entry.tags && entry.tags.length > 0 && entry.tags.map((tag, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-full border border-purple-500/30 text-purple-400 bg-purple-500/10">{tag}</span>
              ))}
              {entry.source_published_at && (
                <span className="text-[9px] font-mono text-muted-foreground/70">
                  src: {new Date(entry.source_published_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                </span>
              )}
            </div>

            {/* Row 3: Action buttons — always visible, full width */}
            <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-border/50" onClick={(e) => e.stopPropagation()}>
              <Button
                size="sm"
                onClick={() => (onSingleAction ?? ((id, s) => onUpdateStatus([id], s)))(entry.id, 'approved')}
                className="flex-1 gap-1.5 bg-status-success/20 text-status-success border border-status-success/30 hover:bg-status-success/30 font-display text-[11px] tracking-wider h-9"
              >
                <CheckCircle className="w-4 h-4 shrink-0" />
                OK
              </Button>
              <Button
                size="sm"
                onClick={() => onQuietApprove([entry.id])}
                title="Approve without distributing"
                className="flex-1 gap-1.5 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 font-display text-[11px] tracking-wider h-9"
              >
                <EyeOff className="w-4 h-4 shrink-0" />
                Q
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => (onSingleAction ?? ((id, s) => onUpdateStatus([id], s)))(entry.id, 'archived')}
                className="flex-1 gap-1.5 font-display text-[11px] tracking-wider h-9"
              >
                <Archive className="w-4 h-4 shrink-0" />
                SKIP
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop table view */}
      <div className="hidden md:block glow-card overflow-x-auto overflow-y-visible">
        <table className="ops-table">
          <thead>
            <tr>
              <th className="w-8 px-2">
                <Checkbox
                  checked={selectedIds.size === filteredEntries.length && filteredEntries.length > 0}
                  onCheckedChange={toggleSelectAll}
                  className="border-primary/50 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                />
              </th>
              <th>Name</th>
              <th className="w-[100px] px-2">Wire</th>
              <th className="w-[72px] px-2">Class</th>
              <th className="w-[56px] px-2">Score</th>
              <th className="w-[76px] px-2">Date</th>
              <th className="w-[68px] px-2">Src</th>
              <th className="w-[110px] px-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredEntries.map(entry => (
              <tr 
                key={entry.id} 
                className={`cursor-pointer ${selectedIds.has(entry.id) ? 'bg-primary/5' : ''}`}
                onClick={() => onViewDetails(entry)}
              >
                <td className="px-2" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(entry.id)}
                    onCheckedChange={() => toggleSelect(entry.id)}
                    className="border-primary/50 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                  />
                </td>
                <td className="overflow-hidden">
                  <div className="font-medium text-foreground truncate">{entry.name}</div>
                  {entry.description && (
                    <ExpandableDescription text={entry.description} />
                  )}
                  {entry.tags && entry.tags.length > 0 && (
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {entry.tags.map((tag, i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-full border border-purple-500/30 text-purple-400 bg-purple-500/10">{tag}</span>
                      ))}
                    </div>
                  )}
                  {entry.source_published_at && (
                    <span className="text-[9px] font-mono text-muted-foreground/70 mt-0.5 inline-block">
                      src: {new Date(entry.source_published_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                    </span>
                  )}
                </td>
                <td className="px-2" onClick={(e) => e.stopPropagation()}>
                  <WireSelector wire={entry.wire} wires={entry.wires} entryId={entry.id} onWiresChange={handleWiresChange} availableWires={availableWires} />
                </td>
                <td className="px-2">
                  <ClassificationBadge classification={entry.classification} />
                </td>
                <td className="px-2">
                  <ScoreBadge score={entry.quality_score} />
                </td>
                <td className="px-2">
                  {(() => {
                    const dateStr = entry.source_published_at || entry.created_at;
                    if (!dateStr) return <span className="text-muted-foreground/50 text-xs">—</span>;
                    const isSource = !!entry.source_published_at;
                    return (
                      <span className={`text-[10px] font-mono whitespace-nowrap ${isSource ? 'text-muted-foreground' : 'text-muted-foreground/60'}`}
                        title={isSource ? `Source: ${new Date(dateStr).toLocaleDateString()}` : `Added: ${new Date(dateStr).toLocaleDateString()}`}>
                        {new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    );
                  })()}
                </td>
                <td className="px-2" onClick={(e) => e.stopPropagation()}>
                  {(() => {
                    const href = resolveSourceUrl(entry);
                    if (!href) return <span className="text-muted-foreground text-xs">—</span>;
                    const isX = isXUrl(href);
                    return (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title={isX ? 'Open X post' : 'Open source'}
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 text-[9px] font-mono font-medium transition-colors whitespace-nowrap"
                      >
                        <ExternalLink className="w-3 h-3 shrink-0" />
                        {isX ? 'X' : getSourceLabel(href)}
                      </a>
                    );
                  })()}
                </td>
                <td className="px-2" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      onClick={() => (onSingleAction ?? ((id, s) => onUpdateStatus([id], s)))(entry.id, 'approved')}
                      title="Approve"
                      className="bg-status-success/20 text-status-success border border-status-success/30 hover:bg-status-success/30 h-7 w-7 p-0"
                    >
                      <CheckCircle className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => onQuietApprove([entry.id])}
                      title="Quiet approve (no distribution)"
                      className="bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 h-7 w-7 p-0"
                    >
                      <EyeOff className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => (onSingleAction ?? ((id, s) => onUpdateStatus([id], s)))(entry.id, 'archived')}
                      title="Skip / Archive"
                      className="h-7 w-7 p-0"
                    >
                      <Archive className="w-3.5 h-3.5" />
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
        onQuietApprove={() => {
          onQuietApprove(Array.from(selectedIds));
          setSelectedIds(new Set());
        }}
        onArchive={() => handleAction('archived')}
        onClear={() => setSelectedIds(new Set())}
      />
    </div>
  );
}
