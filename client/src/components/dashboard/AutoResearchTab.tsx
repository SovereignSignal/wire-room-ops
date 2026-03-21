import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, Plus, RotateCcw, ChevronDown, ChevronRight, FlaskConical, Activity } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  getExperiments,
  getActiveExperiment,
  createExperiment,
  rollbackExperiment,
} from '@/api';
import {
  ScoringExperiment,
  ScoringParams,
  ParamMutation,
  PARAM_RANGES,
} from '@/types';

// --- Helpers ---

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-blue-500/15 text-blue-400 border-blue-500/40';
    case 'completed': return 'bg-status-success/15 text-status-success border-status-success/40';
    case 'rolled_back': return 'bg-status-danger/15 text-status-danger border-status-danger/40';
    default: return 'bg-muted text-muted-foreground border-border';
  }
}

function decisionColor(decision?: string): string {
  switch (decision) {
    case 'keep': return 'text-status-success';
    case 'rollback': return 'text-status-danger';
    case 'extend': return 'text-status-warning';
    case 'active': return 'text-blue-400';
    default: return 'text-muted-foreground';
  }
}

function formatScore(val: number | undefined): string {
  if (val == null) return '--';
  return (val * 100).toFixed(1) + '%';
}

function formatComposite(val: number | undefined): string {
  if (val == null) return '--';
  return val.toFixed(2);
}

// --- Section 1: Active Experiment Card ---

function ActiveExperimentCard({
  experiment,
  loading,
  onRollback,
}: {
  experiment: ScoringExperiment | null;
  loading: boolean;
  onRollback: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (loading) {
    return (
      <Card className="stat-card">
        <CardHeader className="pb-3">
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16" />)}
          </div>
          <Skeleton className="h-4 w-32" />
        </CardContent>
      </Card>
    );
  }

  if (!experiment) {
    return (
      <Card className="stat-card border-dashed border-primary/20">
        <CardContent className="py-10 text-center space-y-3">
          <FlaskConical className="w-10 h-10 mx-auto text-muted-foreground/50" />
          <p className="font-display text-sm tracking-wider text-muted-foreground">NO ACTIVE EXPERIMENT</p>
          <p className="text-xs text-muted-foreground/70">Create a new experiment below to begin the research loop</p>
        </CardContent>
      </Card>
    );
  }

  const r = experiment.currentResults;

  return (
    <Card className="stat-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <CardTitle className="font-display text-sm tracking-wider">{experiment.name}</CardTitle>
            <Badge variant="outline" className={`text-[10px] font-mono ${statusColor(experiment.status)}`}>
              {experiment.status.toUpperCase()}
            </Badge>
          </div>
          {experiment.status === 'active' && (
            confirming ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Confirm rollback?</span>
                <Button size="sm" variant="destructive" className="h-7 text-xs font-display tracking-wider" onClick={() => { onRollback(); setConfirming(false); }}>
                  YES, ROLLBACK
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs font-display tracking-wider border-status-danger/30 text-status-danger hover:bg-status-danger/10"
                onClick={() => setConfirming(true)}
              >
                <RotateCcw className="w-3 h-3 mr-1" />
                MANUAL ROLLBACK
              </Button>
            )
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <MetricCard label="Approval Rate" value={formatScore(r?.approval_rate)} />
          <MetricCard label="Engagement" value={formatScore(r?.engagement_rate)} />
          <MetricCard label="Editorial Eff." value={formatScore(r?.editorial_efficiency)} />
          <MetricCard label="Composite" value={formatComposite(r?.composite_score)} highlight />
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
          <span>{r?.entry_count ?? 0} entries scored</span>
          <span className="text-muted-foreground/40">|</span>
          <span>Started {timeAgo(experiment.created_at)}</span>
          {experiment.parentId && (
            <>
              <span className="text-muted-foreground/40">|</span>
              <span>Parent: {experiment.parentId.slice(0, 8)}</span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MetricCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-background/50 border border-border rounded p-3 text-center">
      <p className="text-[10px] text-muted-foreground tracking-wider uppercase mb-1">{label}</p>
      <p className={`text-lg font-mono font-semibold ${highlight ? 'text-primary glow-text' : ''}`}>{value}</p>
    </div>
  );
}

// --- Section 2: Param Inspector ---

function ParamInspector({
  experiment,
  loading,
}: {
  experiment: ScoringExperiment | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <Card className="stat-card">
        <CardHeader className="pb-3"><Skeleton className="h-5 w-40" /></CardHeader>
        <CardContent><Skeleton className="h-32" /></CardContent>
      </Card>
    );
  }

  const mutations = experiment?.mutations || [];
  const defaults = experiment?.defaultParams;

  // No active experiment — show defaults as reference
  if (!experiment || !defaults) {
    return (
      <Card className="stat-card">
        <CardHeader className="pb-3">
          <CardTitle className="font-display text-sm tracking-wider">PARAM INSPECTOR</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">No active experiment. Showing current default params as reference.</p>
          <p className="text-xs text-muted-foreground/50 italic">Start an experiment to see param diffs here.</p>
        </CardContent>
      </Card>
    );
  }

  if (mutations.length === 0) {
    return (
      <Card className="stat-card">
        <CardHeader className="pb-3">
          <CardTitle className="font-display text-sm tracking-wider">PARAM INSPECTOR</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">No params were mutated in this experiment — running with defaults.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="stat-card">
      <CardHeader className="pb-3">
        <CardTitle className="font-display text-sm tracking-wider">PARAM INSPECTOR</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="font-display text-[10px] tracking-wider">PARAM</TableHead>
              <TableHead className="font-display text-[10px] tracking-wider text-right">BASELINE</TableHead>
              <TableHead className="font-display text-[10px] tracking-wider text-right">CURRENT</TableHead>
              <TableHead className="font-display text-[10px] tracking-wider text-right">DELTA</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mutations.map((m: ParamMutation) => {
              const delta = m.to - m.from;
              const label = PARAM_RANGES[m.param]?.label || m.param;
              return (
                <TableRow key={m.param}>
                  <TableCell className="font-mono text-xs">{label}</TableCell>
                  <TableCell className="font-mono text-xs text-right text-muted-foreground">{m.from}</TableCell>
                  <TableCell className="font-mono text-xs text-right">{m.to}</TableCell>
                  <TableCell className="text-right">
                    <Badge
                      variant="outline"
                      className={`text-[10px] font-mono ${
                        delta > 0
                          ? 'bg-status-success/15 text-status-success border-status-success/40'
                          : 'bg-status-danger/15 text-status-danger border-status-danger/40'
                      }`}
                    >
                      {delta > 0 ? '+' : ''}{delta}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// --- Section 3: Experiment History ---

function ExperimentHistory({
  experiments,
  loading,
  hasMore,
  onLoadMore,
  loadingMore,
}: {
  experiments: ScoringExperiment[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading) {
    return (
      <Card className="stat-card">
        <CardHeader className="pb-3"><Skeleton className="h-5 w-48" /></CardHeader>
        <CardContent className="space-y-2">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10" />)}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="stat-card">
      <CardHeader className="pb-3">
        <CardTitle className="font-display text-sm tracking-wider">EXPERIMENT HISTORY</CardTitle>
      </CardHeader>
      <CardContent>
        {experiments.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">No experiments yet</p>
        ) : (
          <div className="space-y-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-display text-[10px] tracking-wider w-8"></TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider">NAME</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider text-right">COMPOSITE</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider">DECISION</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider hidden sm:table-cell">PARENT</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider text-right">CREATED</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {experiments.map((exp) => (
                  <>
                    <TableRow
                      key={exp.id}
                      className="cursor-pointer hover:bg-primary/5"
                      onClick={() => setExpandedId(expandedId === exp.id ? null : exp.id)}
                    >
                      <TableCell className="w-8 pr-0">
                        {expandedId === exp.id
                          ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                          : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                        }
                      </TableCell>
                      <TableCell className="font-mono text-xs">{exp.name}</TableCell>
                      <TableCell className="font-mono text-xs text-right">
                        {formatComposite(exp.currentResults?.composite_score)}
                      </TableCell>
                      <TableCell>
                        <span className={`text-xs font-mono ${decisionColor(exp.decision || exp.status)}`}>
                          {(exp.decision || exp.status).toUpperCase()}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground hidden sm:table-cell">
                        {exp.parentId ? exp.parentId.slice(0, 8) : '--'}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-right text-muted-foreground">
                        {timeAgo(exp.created_at)}
                      </TableCell>
                    </TableRow>
                    {expandedId === exp.id && (
                      <TableRow key={`${exp.id}-detail`}>
                        <TableCell colSpan={6} className="bg-background/30 p-4">
                          <ExpandedExperimentDetail experiment={exp} />
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                ))}
              </TableBody>
            </Table>
            {hasMore && (
              <div className="text-center pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs font-display tracking-wider"
                  onClick={onLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                  LOAD MORE
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ExpandedExperimentDetail({ experiment }: { experiment: ScoringExperiment }) {
  const mutations = experiment.mutations || [];

  if (mutations.length === 0) {
    return <p className="text-xs text-muted-foreground">No param mutations — ran with defaults.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-display tracking-wider text-muted-foreground">PARAM DIFF VS PARENT</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {mutations.map((m) => {
          const delta = m.to - m.from;
          const label = PARAM_RANGES[m.param]?.label || m.param;
          return (
            <div key={m.param} className="flex items-center justify-between bg-background/50 border border-border rounded px-2 py-1">
              <span className="text-[10px] font-mono text-muted-foreground">{label}</span>
              <Badge
                variant="outline"
                className={`text-[10px] font-mono ${
                  delta > 0
                    ? 'bg-status-success/15 text-status-success border-status-success/40'
                    : 'bg-status-danger/15 text-status-danger border-status-danger/40'
                }`}
              >
                {m.from} → {m.to}
              </Badge>
            </div>
          );
        })}
      </div>
      {experiment.rollback_reason && (
        <p className="text-xs text-status-danger/80 mt-2">
          Rollback reason: {experiment.rollback_reason}
        </p>
      )}
    </div>
  );
}

// --- Section 4: Create Experiment ---

function CreateExperimentForm({
  hasActive,
  onCreated,
}: {
  hasActive: boolean;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [overrides, setOverrides] = useState<Partial<ScoringParams>>({});
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const handleSliderChange = (param: string, value: number[]) => {
    setOverrides((prev) => ({ ...prev, [param]: value[0] }));
  };

  const handleRemoveOverride = (param: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[param];
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const params = Object.keys(overrides).length > 0 ? overrides as ScoringParams : undefined;
      await createExperiment(name.trim(), params);
      toast({ title: 'Experiment created', description: `"${name.trim()}" is now active` });
      setName('');
      setOverrides({});
      onCreated();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'Failed to create experiment' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="stat-card">
      <CardHeader className="pb-3">
        <CardTitle className="font-display text-sm tracking-wider">CREATE EXPERIMENT</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-1.5">
            <label className="text-[10px] font-display tracking-wider text-muted-foreground">EXPERIMENT NAME</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. boost-deadline-weight-v2"
              className="font-mono text-sm bg-background/50"
              disabled={hasActive || submitting}
            />
          </div>
          <Button
            onClick={handleSubmit}
            disabled={hasActive || !name.trim() || submitting}
            className="font-display text-xs tracking-wider gap-1.5"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            CREATE
          </Button>
        </div>

        {hasActive && (
          <p className="text-xs text-status-warning">An experiment is already active. Rollback or wait for completion before creating a new one.</p>
        )}

        <Accordion type="single" collapsible className="w-full">
          <AccordionItem value="params" className="border-border/50">
            <AccordionTrigger className="text-[10px] font-display tracking-wider text-muted-foreground hover:text-foreground py-2">
              PARAM OVERRIDES (OPTIONAL)
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pt-2">
              {Object.entries(PARAM_RANGES).map(([key, range]) => {
                const hasOverride = key in overrides;
                const currentVal = overrides[key] ?? 0;
                return (
                  <div key={key} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-mono text-muted-foreground">{range.label}</label>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono w-8 text-right">
                          {hasOverride ? currentVal : '--'}
                        </span>
                        {hasOverride && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 w-5 p-0 text-muted-foreground hover:text-status-danger"
                            onClick={() => handleRemoveOverride(key)}
                          >
                            ×
                          </Button>
                        )}
                      </div>
                    </div>
                    <Slider
                      min={range.min}
                      max={range.max}
                      step={range.step}
                      value={[hasOverride ? currentVal : (range.min + range.max) / 2]}
                      onValueChange={(v) => handleSliderChange(key, v)}
                      disabled={hasActive || submitting}
                      className="w-full"
                    />
                    <div className="flex justify-between text-[9px] text-muted-foreground/50 font-mono">
                      <span>{range.min}</span>
                      <span>{range.max}</span>
                    </div>
                  </div>
                );
              })}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}

// --- Main Tab ---

export function AutoResearchTab() {
  const [activeExperiment, setActiveExperiment] = useState<ScoringExperiment | null>(null);
  const [experiments, setExperiments] = useState<ScoringExperiment[]>([]);
  const [loadingActive, setLoadingActive] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyLimit, setHistoryLimit] = useState(20);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const { toast } = useToast();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadActive = useCallback(async () => {
    try {
      const exp = await getActiveExperiment();
      setActiveExperiment(exp);
    } catch (err) {
      console.warn('Failed to load active experiment:', err);
    } finally {
      setLoadingActive(false);
    }
  }, []);

  const loadHistory = useCallback(async (limit: number) => {
    try {
      const list = await getExperiments(undefined, limit);
      setExperiments(list);
      setHasMore(list.length >= limit);
    } catch (err) {
      console.warn('Failed to load experiments:', err);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadActive();
    loadHistory(historyLimit);
  }, [loadActive, loadHistory, historyLimit]);

  // Auto-refresh active experiment every 30s
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      loadActive();
    }, 30000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [loadActive]);

  const handleRollback = async () => {
    if (!activeExperiment) return;
    try {
      await rollbackExperiment(activeExperiment.id);
      toast({ title: 'Experiment rolled back', description: `"${activeExperiment.name}" has been rolled back` });
      await loadActive();
      await loadHistory(historyLimit);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'Failed to rollback experiment' });
    }
  };

  const handleCreated = async () => {
    await loadActive();
    await loadHistory(historyLimit);
  };

  const handleLoadMore = async () => {
    const newLimit = historyLimit + 20;
    setLoadingMore(true);
    setHistoryLimit(newLimit);
    await loadHistory(newLimit);
    setLoadingMore(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Activity className="w-5 h-5 text-primary" />
        <h2 className="font-display text-lg tracking-wider glow-text">AUTORESEARCH</h2>
        <span className="text-xs text-muted-foreground font-mono">Experiment Loop</span>
      </div>

      {/* Section 1: Active Experiment */}
      <ActiveExperimentCard
        experiment={activeExperiment}
        loading={loadingActive}
        onRollback={handleRollback}
      />

      {/* Section 2: Param Inspector */}
      <ParamInspector
        experiment={activeExperiment}
        loading={loadingActive}
      />

      {/* Section 3: Experiment History */}
      <ExperimentHistory
        experiments={experiments}
        loading={loadingHistory}
        hasMore={hasMore}
        onLoadMore={handleLoadMore}
        loadingMore={loadingMore}
      />

      {/* Section 4: Create Experiment */}
      <CreateExperimentForm
        hasActive={activeExperiment?.status === 'active'}
        onCreated={handleCreated}
      />
    </div>
  );
}
