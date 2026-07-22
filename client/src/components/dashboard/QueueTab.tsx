import { useState, useMemo, useRef, useEffect } from 'react';
import { ScanEntry, FilterState, Classification } from '@/types';
import { CuratorBadge } from './CuratorBadge';
import { VerticalTag } from './VerticalTag';
import { ActionBar } from './ActionBar';
import { FilterBar } from './FilterBar';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { ExternalLink, CheckCircle, Archive, ChevronDown, EyeOff } from 'lucide-react';
import { updateEntryWires, fetchWires } from '@/api';
import { effectiveOperatorRoute, isInScoreBand, visibleSelection } from '@/lib/dashboard-state';

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

// operator_route is the classifier's editorial routing hint. It is no longer
// used to auto-archive (everything reaches the queue); it is shown and filtered
// here so the operator can triage the wide-net queue by route.
const ROUTE_OPTIONS = ['publish', 'source_check', 'park', 'relationship_signal', 'decline'] as const;
type RouteKey = typeof ROUTE_OPTIONS[number];

const routeStyles: Record<string, string> = {
  publish: 'border-green-500/50 text-green-400 bg-green-500/10',
  source_check: 'border-cyan-400/50 text-cyan-300 bg-cyan-500/10',
  park: 'border-amber-400/50 text-amber-400 bg-amber-400/10',
  relationship_signal: 'border-violet-500/50 text-violet-400 bg-violet-500/10',
  decline: 'border-red-500/50 text-red-400 bg-red-500/10',
  none: 'border-border text-muted-foreground bg-muted/20',
};

const routeLabels: Record<string, string> = {
  publish: 'PUBLISH',
  source_check: 'SRC-CHECK',
  park: 'PARK',
  relationship_signal: 'BD-SIGNAL',
  decline: 'DECLINE',
  none: 'NO ROUTE',
};

function RouteBadge({ route }: { route?: string }) {
  const r = route && routeLabels[route] ? route : (route ? route : 'none');
  const style = routeStyles[r] || routeStyles.none;
  const label = routeLabels[r] || r.toUpperCase();
  return (
    <span title={`effective route: ${route || 'none'}`} className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono font-medium border ${style}`}>
      {label}
    </span>
  );
}

function RelatedSourceBadge({ entry }: { entry: ScanEntry }) {
  const related = entry.metadata?.related_source;
  if (!related) return null;
  const confidence = typeof related.confidence === 'number' ? ` ${Math.round(related.confidence * 100)}%` : '';
  const label = related.relation_type === 'alternate_source' ? 'ALT SRC' : 'RELATED';
  return (
    <span
      title={related.reason || `Related to ${related.matched_entry_name || `entry #${related.matched_entry_id}`}`}
      className="inline-flex items-center whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-mono font-medium border border-cyan-400/50 text-cyan-300 bg-cyan-500/10"
    >
      {label}{confidence}
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
  // Self-heal: if the page-mount wires fetch failed (e.g. a deploy blip),
  // refetch lazily when the dropdown is opened instead of staying broken
  // for the rest of the session.
  const [fetchedWires, setFetchedWires] = useState<{ key: string; displayName: string }[]>([]);
  const effectiveWires = availableWires.length > 0 ? availableWires : fetchedWires;
  const options = effectiveWires.length > 0 ? effectiveWires.map(w => w.key) : [wire];
  // Only core options can be selected. If an entry carries a legacy/non-core
  // wire (from before the dropdown was locked), it is dropped from the picker
  // so the user can cleanly re-tag it to a valid wire instead of being stuck
  // with an un-toggleable value.
  const rawSelected = (wires && wires.length > 0) ? wires : [wire];
  const selected = rawSelected.filter(s => options.includes(s));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && effectiveWires.length === 0) {
      fetchWires().then(ws => { if (ws.length > 0) setFetchedWires(ws); }).catch(() => {});
    }
  }, [open, effectiveWires.length]);

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
        {selected.length === 0 ? 'PICK' : selected.length > 1 ? `${selected[0]} +${selected.length - 1}` : selected[0]}
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
  total: number;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export function QueueTab({ entries, verticals, onUpdateStatus, onViewDetails, onSingleAction, onQuietApprove, onEntryUpdated, total, loadingMore, onLoadMore }: QueueTabProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [wireFilter, setWireFilter] = useState<string | null>(null);
  const [classificationFilter, setClassificationFilter] = useState<string | null>(null);
  const [routeFilter, setRouteFilter] = useState<string | null>(null);
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
      // Operator-route filter (wide-net queue triage)
      if (routeFilter) {
        const entryRoute = effectiveOperatorRoute(entry.metadata);
        if (entryRoute !== routeFilter) return false;
      }
      // Advanced filters
      if (filters.wire && entry.wire !== filters.wire) return false;
      if (!isInScoreBand(entry.quality_score, filters.scoreMin, filters.scoreMax)) return false;
      
      if (filters.dateStatus !== 'all') {
        const hasDate = !!entry.deadline_parsed;
        const isExpired = hasDate && new Date(entry.deadline_parsed!) < new Date();
        
        if (filters.dateStatus === 'no_date' && hasDate) return false;
        if (filters.dateStatus === 'upcoming' && (!hasDate || isExpired)) return false;
        if (filters.dateStatus === 'expired' && !isExpired) return false;
      }
      
      return true;
    });
  }, [entries, filters, wireFilter, classificationFilter, routeFilter]);

  const visibleIds = useMemo(
    () => new Set(filteredEntries.map(entry => entry.id)),
    [filteredEntries],
  );
  const selectedVisibleIds = useMemo(
    () => visibleSelection(selectedIds, visibleIds),
    [selectedIds, visibleIds],
  );

  useEffect(() => {
    setSelectedIds(current => {
      const next = visibleSelection(current, visibleIds);
      return next.size === current.size ? current : next;
    });
  }, [visibleIds]);

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
    if (selectedVisibleIds.size === filteredEntries.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredEntries.map(e => e.id)));
    }
  };

  const handleAction = (status: ScanEntry['status']) => {
    const ids = Array.from(selectedVisibleIds);
    if (ids.length === 0) return;
    onUpdateStatus(ids, status);
    setSelectedIds(new Set());
  };

  return (
    <div className={`space-y-4 ${selectedVisibleIds.size > 0 ? 'pb-28 sm:pb-20' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-muted-foreground">
        <span>LOADED {entries.length} OF {total} QUEUED</span>
        {filteredEntries.length !== entries.length && (
          <span>{filteredEntries.length} MATCH CURRENT FILTERS</span>
        )}
      </div>

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
      <div className="flex items-center gap-1.5 flex-wrap">
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

      {/* Operator-route filter — triage the wide-net queue by editorial route */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-muted-foreground font-mono mr-1">ROUTE:</span>
        <button
          onClick={() => setRouteFilter(null)}
          className={`px-2 py-1 rounded text-[9px] font-mono border transition-colors ${
            routeFilter === null
              ? 'bg-primary/20 text-primary border-primary/50'
              : 'bg-muted/20 text-muted-foreground border-border hover:text-foreground hover:bg-muted/40'
          }`}
        >
          All
        </button>
        {ROUTE_OPTIONS.map((r: RouteKey) => (
          <button
            key={r}
            onClick={() => setRouteFilter(routeFilter === r ? null : r)}
            className={`px-2 py-1 rounded text-[9px] font-mono border transition-colors ${
              routeFilter === r
                ? routeStyles[r]
                : 'bg-muted/20 text-muted-foreground border-border hover:text-foreground hover:bg-muted/40'
            }`}
          >
            {routeLabels[r]}
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
              <RouteBadge route={effectiveOperatorRoute(entry.metadata)} />
              <RelatedSourceBadge entry={entry} />
              <CuratorBadge curator={entry.metadata?.curator} />
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2.5 pt-2 border-t border-border/50" onClick={(e) => e.stopPropagation()}>
              <Button
                size="sm"
                onClick={() => (onSingleAction ?? ((id, s) => onUpdateStatus([id], s)))(entry.id, 'approved')}
                className="w-full gap-1.5 bg-status-success/20 text-status-success border border-status-success/30 hover:bg-status-success/30 font-display text-[10px] tracking-wider h-9"
              >
                <CheckCircle className="w-4 h-4 shrink-0" />
                APPROVE + PUBLISH
              </Button>
              <Button
                size="sm"
                onClick={() => onQuietApprove([entry.id])}
                title="Approve without distributing"
                className="w-full gap-1.5 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 font-display text-[10px] tracking-wider h-9"
              >
                <EyeOff className="w-4 h-4 shrink-0" />
                QUIET APPROVE
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => (onSingleAction ?? ((id, s) => onUpdateStatus([id], s)))(entry.id, 'archived')}
                className="w-full gap-1.5 font-display text-[10px] tracking-wider h-9"
              >
                <Archive className="w-4 h-4 shrink-0" />
                ARCHIVE
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop table view */}
      <div className="hidden md:block glow-card overflow-x-auto overflow-y-visible">
        <table className="ops-table w-full">
          <thead>
            <tr>
              <th className="w-[36px] px-2">
                <Checkbox
                  checked={selectedVisibleIds.size === filteredEntries.length && filteredEntries.length > 0}
                  onCheckedChange={toggleSelectAll}
                  className="border-primary/50 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                />
              </th>
              <th className="px-2">Name</th>
              <th className="w-[112px] px-2">Wire</th>
              <th className="w-[132px] px-2">Curator</th>
              <th className="w-[128px] px-2">Src</th>
              <th className="w-[268px] px-2">Actions</th>
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
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    <ClassificationBadge classification={entry.classification} />
                    <RouteBadge route={effectiveOperatorRoute(entry.metadata)} />
                    <RelatedSourceBadge entry={entry} />
                  </div>
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
                  <CuratorBadge curator={entry.metadata?.curator} />
                </td>
                <td className="px-2" onClick={(e) => e.stopPropagation()}>
                  {(() => {
                    const href = resolveSourceUrl(entry);
                    if (!href) return <span className="text-muted-foreground text-sm">—</span>;
                    const isX = isXUrl(href);
                    return (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title={isX ? 'Open X post' : `Open source — ${href}`}
                        className="group inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-primary/30 bg-primary/[0.07] text-primary text-xs font-display font-semibold uppercase tracking-wide transition-all hover:bg-primary/15 hover:border-primary/60 hover:shadow-[0_0_12px_hsl(var(--primary)/0.25)] whitespace-nowrap"
                      >
                        {isX ? 'X' : getSourceLabel(href)}
                        <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" />
                      </a>
                    );
                  })()}
                </td>
                <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => (onSingleAction ?? ((id, s) => onUpdateStatus([id], s)))(entry.id, 'approved')}
                      title="Approve & distribute to channels"
                      className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-status-success/45 bg-status-success/15 text-status-success text-[11px] font-display font-bold uppercase tracking-wider transition-all hover:bg-status-success/25 hover:border-status-success/70 hover:shadow-[0_0_14px_hsl(var(--status-success)/0.4)] active:scale-95"
                    >
                      <CheckCircle className="w-4 h-4" />
                      Approve
                    </button>
                    <button
                      onClick={() => onQuietApprove([entry.id])}
                      title="Quiet approve — keep in DB, do not distribute"
                      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-primary/35 bg-primary/[0.07] text-primary text-[11px] font-display font-semibold uppercase tracking-wider transition-all hover:bg-primary/18 hover:border-primary/60 hover:shadow-[0_0_12px_hsl(var(--primary)/0.3)] active:scale-95"
                    >
                      <EyeOff className="w-4 h-4" />
                      Quiet
                    </button>
                    <button
                      onClick={() => (onSingleAction ?? ((id, s) => onUpdateStatus([id], s)))(entry.id, 'archived')}
                      title="Skip / Archive"
                      className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border/80 bg-transparent text-muted-foreground transition-all hover:bg-muted hover:text-foreground hover:border-border active:scale-95"
                    >
                      <Archive className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredEntries.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-12 text-muted-foreground font-display text-sm tracking-wider">
                  NO ITEMS MATCH FILTERS
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {entries.length < total && (
        <div className="flex flex-col items-center gap-2 py-2">
          <Button
            variant="outline"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="min-w-40 font-display text-[10px] tracking-wider"
          >
            {loadingMore ? 'LOADING...' : `LOAD NEXT ${Math.min(100, total - entries.length)}`}
          </Button>
          <span className="text-[10px] font-mono text-muted-foreground">
            Filters apply to the {entries.length} loaded rows.
          </span>
        </div>
      )}

      <ActionBar
        selectedCount={selectedVisibleIds.size}
        onApprove={() => handleAction('approved')}
        onQuietApprove={() => {
          const ids = Array.from(selectedVisibleIds);
          if (ids.length === 0) return;
          onQuietApprove(ids);
          setSelectedIds(new Set());
        }}
        onArchive={() => handleAction('archived')}
        onClear={() => setSelectedIds(new Set())}
      />
    </div>
  );
}
