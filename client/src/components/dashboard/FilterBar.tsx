import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { QueueQueryFilters, QueueScoreBand, QueueTimeline } from '@/lib/queue-filters';

interface FilterBarProps {
  filters: QueueQueryFilters;
  onFilterChange: (filters: QueueQueryFilters) => void;
  onClearAll: () => void;
  hasActiveFilters: boolean;
}

export function FilterBar({ filters, onFilterChange, onClearAll, hasActiveFilters }: FilterBarProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 p-4 glow-card min-w-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-display tracking-wider shrink-0">
        <SlidersHorizontal className="w-4 h-4 text-primary" />
        <span>FILTERS</span>
      </div>
      
      <div className="hidden sm:block h-6 w-px bg-border" />
      
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:items-center gap-3 sm:gap-4 flex-1 w-full min-w-0">
        <div className="flex items-center justify-between sm:justify-start gap-2 min-w-0">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">Signal</span>
          <Select 
            value={filters.scoreBand || 'all'} 
            onValueChange={(v) => {
              onFilterChange({
                ...filters,
                scoreBand: v === 'all' ? null : v as QueueScoreBand,
              });
            }}
          >
            <SelectTrigger className="flex-1 min-w-0 sm:flex-none sm:w-36 h-8 text-xs bg-muted/50 border-border font-mono">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="all" className="font-mono text-xs">Any</SelectItem>
              <SelectItem value="strong" className="font-mono text-xs">Strong (70+)</SelectItem>
              <SelectItem value="medium" className="font-mono text-xs">Medium (50-69)</SelectItem>
              <SelectItem value="weak" className="font-mono text-xs">Weak (&lt;50)</SelectItem>
              <SelectItem value="unscored" className="font-mono text-xs">Unscored</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between sm:justify-start gap-2 min-w-0">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">Timeline</span>
          <Select 
            value={filters.timeline} 
            onValueChange={(v) => onFilterChange({ ...filters, timeline: v as QueueTimeline | 'all' })}
          >
            <SelectTrigger className="flex-1 min-w-0 sm:flex-none sm:w-32 h-8 text-xs bg-muted/50 border-border font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="all" className="font-mono text-xs">All</SelectItem>
              <SelectItem value="upcoming" className="font-mono text-xs">Upcoming</SelectItem>
              <SelectItem value="no_date" className="font-mono text-xs">No Date</SelectItem>
              <SelectItem value="expired" className="font-mono text-xs">Expired</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {hasActiveFilters && (
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={onClearAll}
          className="gap-1.5 self-start sm:self-auto text-muted-foreground hover:text-foreground font-display text-[10px] tracking-wider"
        >
          <X className="w-3 h-3" />
          CLEAR
        </Button>
      )}
    </div>
  );
}
