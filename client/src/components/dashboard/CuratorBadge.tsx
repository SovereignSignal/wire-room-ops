import { cn } from '@/lib/utils';

interface CuratorStamp {
  route?: string;
  confidence?: string;
  rationale?: string;
  by?: string;
  at?: string;
}

const ROUTE_LABEL: Record<string, string> = {
  publish: 'Publish',
  source_check: 'Source-check',
  park: 'Park',
  relationship_signal: 'Signal',
  decline: 'Decline',
};

const ROUTE_CLASS: Record<string, string> = {
  publish: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
  source_check: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
  park: 'bg-slate-500/15 text-slate-300 border border-slate-500/30',
  relationship_signal: 'bg-violet-500/15 text-violet-300 border border-violet-500/30',
  decline: 'bg-rose-500/15 text-rose-300 border border-rose-500/30',
};

const CONF_LABEL: Record<string, string> = { high: 'H', med: 'M', low: 'L' };

/**
 * The queue's judgment signal: the curator's route + confidence, written to
 * metadata.curator. Replaces the old quality_score number (which was false
 * precision and, post-dumb-pipe, always null). Renders an em-dash when an
 * entry has not been curated yet (distinct from a real low call).
 */
export function CuratorBadge({ curator, className }: { curator?: CuratorStamp; className?: string }) {
  const route = curator?.route;
  if (!route) {
    return (
      <span className={cn('text-xs text-muted-foreground/60', className)} title="Not yet curated">
        —
      </span>
    );
  }

  const label = ROUTE_LABEL[route] || route;
  const conf = curator?.confidence ? (CONF_LABEL[curator.confidence] || curator.confidence) : null;
  const tooltip = [
    `${label}${curator?.confidence ? ` (${curator.confidence} confidence)` : ''}`,
    curator?.rationale || '',
    curator?.by ? `— ${curator.by}` : '',
  ].filter(Boolean).join('\n');

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap',
        ROUTE_CLASS[route] || 'bg-muted text-muted-foreground',
        className,
      )}
      title={tooltip}
    >
      {label}
      {conf ? <span className="opacity-60 font-mono">{conf}</span> : null}
    </span>
  );
}
