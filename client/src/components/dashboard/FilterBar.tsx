import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FilterState } from '@/types';
import { SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface FilterBarProps {
  filters: FilterState;
  onFilterChange: (filters: FilterState) => void;
  verticals: string[];
}

export function FilterBar({ filters, onFilterChange, verticals }: FilterBarProps) {
  const hasActiveFilters = filters.wire || filters.scoreMin !== null || filters.dateStatus !== 'all';

  const clearFilters = () => {
    onFilterChange({
      wire: null,
      scoreMin: null,
      scoreMax: null,
      dateStatus: 'all',
    });
  };

  return (
    <div className="flex items-center gap-4 p-4 glow-card">
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-display tracking-wider">
        <SlidersHorizontal className="w-4 h-4 text-primary" />
        <span>FILTERS</span>
      </div>
      
      <div className="h-6 w-px bg-border" />
      
      <div className="flex items-center gap-4 flex-1">
        {/* Vertical Filter */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Vertical</span>
          <Select 
            value={filters.wire || 'all'} 
            onValueChange={(v) => onFilterChange({ ...filters, wire: v === 'all' ? null : v })}
          >
            <SelectTrigger className="w-32 h-8 text-xs bg-muted/50 border-border font-mono">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="all" className="font-mono text-xs">All</SelectItem>
              {verticals.map(v => (
                <SelectItem key={v} value={v} className="font-mono text-xs">{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Score Range Filter */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Signal</span>
          <Select 
            value={filters.scoreMin?.toString() || 'all'} 
            onValueChange={(v) => {
              if (v === 'all') {
                onFilterChange({ ...filters, scoreMin: null, scoreMax: null });
              } else if (v === '70') {
                onFilterChange({ ...filters, scoreMin: 70, scoreMax: 100 });
              } else if (v === '50') {
                onFilterChange({ ...filters, scoreMin: 50, scoreMax: 69 });
              } else {
                onFilterChange({ ...filters, scoreMin: 0, scoreMax: 49 });
              }
            }}
          >
            <SelectTrigger className="w-32 h-8 text-xs bg-muted/50 border-border font-mono">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="all" className="font-mono text-xs">Any</SelectItem>
              <SelectItem value="70" className="font-mono text-xs">Strong (70+)</SelectItem>
              <SelectItem value="50" className="font-mono text-xs">Medium (50-69)</SelectItem>
              <SelectItem value="0" className="font-mono text-xs">Weak (&lt;50)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Date Status Filter */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Timeline</span>
          <Select 
            value={filters.dateStatus} 
            onValueChange={(v) => onFilterChange({ ...filters, dateStatus: v as FilterState['dateStatus'] })}
          >
            <SelectTrigger className="w-32 h-8 text-xs bg-muted/50 border-border font-mono">
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
          onClick={clearFilters}
          className="gap-1.5 text-muted-foreground hover:text-foreground font-display text-[10px] tracking-wider"
        >
          <X className="w-3 h-3" />
          CLEAR
        </Button>
      )}
    </div>
  );
}
