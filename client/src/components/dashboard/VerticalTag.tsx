import { cn } from '@/lib/utils';

interface VerticalTagProps {
  vertical: string;
  className?: string;
}

const verticalColors: Record<string, string> = {
  crypto: 'bg-violet-500/15 text-violet-400 border-violet-500/40',
  grants: 'bg-emerald-400/15 text-emerald-400 border-emerald-400/40',
  news: 'bg-cyan-400/15 text-cyan-400 border-cyan-400/40',
  jobs: 'bg-amber-400/15 text-amber-400 border-amber-400/40',
  leads: 'bg-rose-400/15 text-rose-400 border-rose-400/40',
};

export function VerticalTag({ vertical, className }: VerticalTagProps) {
  const colorClass = verticalColors[vertical.toLowerCase()] || 'bg-muted text-muted-foreground border-border';

  return (
    <span 
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-display font-medium border uppercase tracking-wider',
        colorClass,
        className
      )}
    >
      {vertical}
    </span>
  );
}
