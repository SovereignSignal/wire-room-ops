import { useState, useEffect, useCallback, Fragment } from 'react';
import { useToast } from '@/hooks/use-toast';
import { ScanPrompt, ScanEntry } from '@/types';
import {
  fetchScanPrompts,
  createScanPrompt,
  updateScanPrompt,
  deleteScanPrompt,
  runScanPrompt,
  fetchSchedules,
  updateSchedule,
  fetchPromptResults,
  fetchPromptStats,
  ScheduleResponse,
  PromptStatsData,
} from '@/api';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

interface ScanPromptsTabProps {
  verticals: string[];
}

const TOOL_TYPES = [
  { value: 'x_search', label: 'X Search', icon: '🔎' },
  { value: 'web_search', label: 'Web Search', icon: '🌐' },
  { value: 'perplexity', label: 'Perplexity', icon: '🔮' },
];

const VARIANTS = ['A', 'B', 'C', 'W', 'P', 'N', 'S'];

const INTENTS = [
  { value: 'discovery', label: 'Discovery', desc: 'Find newly announced opportunities' },
  { value: 'canonical', label: 'Canonical', desc: 'Find currently-open known programs' },
  { value: 'signal', label: 'Signal', desc: 'Catch news, funding rounds, signals' },
];

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatNextRun(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  approved: 'bg-green-500/20 text-green-400 border-green-500/30',
  archived: 'bg-muted/20 text-muted-foreground border-border',
  raw: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  duplicate: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  declined: 'bg-red-500/20 text-red-400 border-red-500/30',
};

export function ScanPromptsTab({ verticals }: ScanPromptsTabProps) {
  const [prompts, setPrompts] = useState<ScanPrompt[]>([]);
  const [schedules, setSchedules] = useState<ScheduleResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{
    promptId: string;
    parsedCount: number;
    newUnique: number;
    duplicatesFound: number;
    highQualityCount: number;
    model: string;
  } | null>(null);
  const { toast } = useToast();

  // Form state
  const [formWire, setFormWire] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [formToolType, setFormToolType] = useState('x_search');
  const [formVariant, setFormVariant] = useState('');
  const [formModel, setFormModel] = useState('');
  const [formOutputFormat, setFormOutputFormat] = useState<'text' | 'json'>('text');
  const [formIntent, setFormIntent] = useState<'discovery' | 'canonical' | 'signal'>('discovery');
  const [formPromptText, setFormPromptText] = useState('');
  const [formResponseFormat, setFormResponseFormat] = useState('');
  const [formActive, setFormActive] = useState(true);

  // Schedule editing state
  const [scheduleHour, setScheduleHour] = useState(0);
  const [scheduleMinute, setScheduleMinute] = useState(0);
  const [scheduleFrequency, setScheduleFrequency] = useState(12);
  const [scheduleEnabled, setScheduleEnabled] = useState(true);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleEditing, setScheduleEditing] = useState(false);

  // Recent results state
  const [promptResults, setPromptResults] = useState<ScanEntry[]>([]);
  const [promptResultsTotal, setPromptResultsTotal] = useState(0);
  const [resultsLoading, setResultsLoading] = useState(false);

  // Prompt scorecard state
  const [promptStatsData, setPromptStatsData] = useState<PromptStatsData[]>([]);
  const [scorecardOpen, setScorecardOpen] = useState(false);
  const [overlapStats, setOverlapStats] = useState<{ totalUniqueEntries: number; entriesFoundByMultiple: number; overlapRate: number } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [promptsData, schedulesData, statsData] = await Promise.all([
        fetchScanPrompts(),
        fetchSchedules().catch(() => [] as ScheduleResponse[]),
        fetchPromptStats(21).catch(() => ({ prompts: [], overlapStats: { totalUniqueEntries: 0, entriesFoundByMultiple: 0, overlapRate: 0 } })),
      ]);
      setPrompts(promptsData);
      setSchedules(schedulesData);
      setPromptStatsData(statsData.prompts);
      setOverlapStats(statsData.overlapStats);
    } catch {
      toast({ title: 'Error', description: 'Failed to load scan prompts' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  // Load results when editing a prompt
  const loadPromptResults = useCallback(async (promptId: string) => {
    setResultsLoading(true);
    try {
      const data = await fetchPromptResults(promptId, 25);
      setPromptResults(data.entries);
      setPromptResultsTotal(data.total);
    } catch {
      setPromptResults([]);
      setPromptResultsTotal(0);
    } finally {
      setResultsLoading(false);
    }
  }, []);

  // Get schedule info for a wire
  const getWireSchedule = (wire: string): ScheduleResponse | undefined => {
    return schedules.find(s => s.wire === wire && s.scheduleType === 'scan-execution');
  };

  const resetForm = () => {
    setFormWire(verticals[0] || '');
    setFormLabel('');
    setFormToolType('x_search');
    setFormVariant('');
    setFormModel('');
    setFormOutputFormat('text');
    setFormIntent('discovery');
    setFormPromptText('');
    setFormResponseFormat('');
    setFormActive(true);
    setEditingId(null);
    setScheduleEditing(false);
    setPromptResults([]);
    setPromptResultsTotal(0);
  };

  const openAddSheet = () => {
    resetForm();
    setSheetOpen(true);
  };

  const openEditSheet = (p: ScanPrompt) => {
    setFormWire(p.wire);
    setFormLabel(p.label);
    setFormToolType(p.toolType);
    setFormVariant(p.variant || '');
    setFormModel(p.model || '');
    setFormOutputFormat(p.outputFormat || 'text');
    setFormIntent(p.intent || 'discovery');
    setFormPromptText(p.promptText);
    setFormResponseFormat(p.responseFormat || '');
    setFormActive(p.isActive);
    setEditingId(p.id);
    setScheduleEditing(false);
    setSheetOpen(true);

    // Load schedule state
    const sched = getWireSchedule(p.wire);
    if (sched) {
      setScheduleHour(sched.hour);
      setScheduleMinute(sched.minute);
      setScheduleFrequency(sched.frequencyHours || 12);
      setScheduleEnabled(sched.enabled);
    }

    // Load recent results
    loadPromptResults(p.id);
  };

  const handleSubmit = async () => {
    if (!formLabel.trim()) {
      toast({ title: 'Error', description: 'Label is required' });
      return;
    }
    if (!formPromptText.trim()) {
      toast({ title: 'Error', description: 'Prompt text is required' });
      return;
    }
    if (!formWire) {
      toast({ title: 'Error', description: 'Wire is required' });
      return;
    }

    const body = {
      wire: formWire,
      label: formLabel.trim(),
      promptText: formPromptText,
      toolType: formToolType,
      variant: formVariant || undefined,
      model: formModel || undefined,
      outputFormat: formOutputFormat,
      intent: formIntent,
      responseFormat: formResponseFormat || undefined,
      isActive: formActive,
    };

    try {
      if (editingId) {
        await updateScanPrompt(editingId, body);
        toast({ title: 'Updated', description: 'Prompt updated' });
      } else {
        await createScanPrompt(body);
        toast({ title: 'Created', description: 'Prompt created' });
      }
      setSheetOpen(false);
      resetForm();
      await loadData();
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to save' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this scan prompt?')) return;
    try {
      await deleteScanPrompt(id);
      toast({ title: 'Deleted', description: 'Prompt removed' });
      if (runResult?.promptId === id) setRunResult(null);
      await loadData();
    } catch {
      toast({ title: 'Error', description: 'Failed to delete prompt' });
    }
  };

  const handleRun = async (id: string) => {
    setRunning(id);
    setRunResult(null);
    try {
      const result = await runScanPrompt(id);
      setRunResult({
        promptId: id,
        parsedCount: result.parsedCount,
        newUnique: result.newUnique,
        duplicatesFound: result.duplicatesFound,
        highQualityCount: result.highQualityCount,
        model: result.model,
      });
      toast({
        title: 'Scan Complete',
        description: `${result.parsedCount} found, ${result.newUnique} new, ${result.duplicatesFound} dupes`,
      });
      await loadData();
    } catch (error) {
      toast({ title: 'Scan Failed', description: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      setRunning(null);
    }
  };

  const handleToggleActive = async (p: ScanPrompt) => {
    try {
      await updateScanPrompt(p.id, { isActive: !p.isActive });
      await loadData();
    } catch {
      toast({ title: 'Error', description: 'Failed to update prompt' });
    }
  };

  const handleScheduleSave = async () => {
    const sched = editingPrompt ? getWireSchedule(editingPrompt.wire) : undefined;
    if (!sched) return;

    setScheduleSaving(true);
    try {
      await updateSchedule(sched.id, {
        hour: scheduleHour,
        minute: scheduleMinute,
        frequencyHours: scheduleFrequency,
        enabled: scheduleEnabled,
      });
      toast({ title: 'Schedule Updated', description: `${sched.name} schedule saved` });
      setScheduleEditing(false);
      // Refresh schedules to get updated nextRun
      const schedulesData = await fetchSchedules().catch(() => [] as ScheduleResponse[]);
      setSchedules(schedulesData);
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to update schedule' });
    } finally {
      setScheduleSaving(false);
    }
  };

  const toolInfo = (type: string) => TOOL_TYPES.find(t => t.value === type) || TOOL_TYPES[0];

  // Get the editing prompt's schedule info for the sheet
  const editingPrompt = editingId ? prompts.find(p => p.id === editingId) : null;
  const sheetSchedule = editingPrompt ? getWireSchedule(editingPrompt.wire) : formWire ? getWireSchedule(formWire) : undefined;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center space-y-3">
          <div className="text-3xl animate-pulse">🔍</div>
          <p className="text-sm text-muted-foreground font-mono">LOADING PROMPTS...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base sm:text-lg font-display tracking-wider glow-text">SCAN PROMPTS</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {prompts.length} prompt{prompts.length !== 1 ? 's' : ''} configured.
          </p>
        </div>
        <button
          onClick={openAddSheet}
          className="px-4 py-2 text-xs font-display tracking-wider bg-primary/10 text-primary border border-primary/30 rounded hover:bg-primary/20 transition-colors self-start sm:self-auto"
        >
          + ADD PROMPT
        </button>
      </div>

      {/* Prompt Scorecard */}
      {promptStatsData.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <button
            onClick={() => setScorecardOpen(!scorecardOpen)}
            className="w-full flex items-center justify-between px-4 py-3 bg-card/60 hover:bg-card/80 transition-colors"
          >
            <div className="flex items-center gap-3">
              <h3 className="text-[10px] font-display tracking-widest text-muted-foreground">PROMPT SCORECARD</h3>
              <span className="text-[10px] font-mono text-muted-foreground/60">21-day window</span>
              {overlapStats && (
                <span className="text-[10px] font-mono text-muted-foreground/60">
                  {Math.round(overlapStats.overlapRate * 100)}% overlap
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{scorecardOpen ? '\u25B2' : '\u25BC'}</span>
          </button>
          {scorecardOpen && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="bg-card/40 border-t border-border">
                    <th className="text-left text-[9px] font-display tracking-widest text-muted-foreground px-3 py-2">PROMPT</th>
                    <th className="text-left text-[9px] font-display tracking-widest text-muted-foreground px-2 py-2">SRC</th>
                    <th className="text-right text-[9px] font-display tracking-widest text-muted-foreground px-2 py-2">TOTAL</th>
                    <th className="text-right text-[9px] font-display tracking-widest text-muted-foreground px-2 py-2">UNIQUE</th>
                    <th className="text-right text-[9px] font-display tracking-widest text-muted-foreground px-2 py-2">DUP%</th>
                    <th className="text-right text-[9px] font-display tracking-widest text-muted-foreground px-2 py-2">AVG Q</th>
                    <th className="text-right text-[9px] font-display tracking-widest text-muted-foreground px-2 py-2">APPR</th>
                    <th className="text-right text-[9px] font-display tracking-widest text-muted-foreground px-2 py-2">APPR%</th>
                    <th className="text-center text-[9px] font-display tracking-widest text-muted-foreground px-2 py-2">CLASS MIX</th>
                    <th className="text-right text-[9px] font-display tracking-widest text-muted-foreground px-2 py-2">PUB%</th>
                  </tr>
                </thead>
                <tbody>
                  {promptStatsData.map((s, i) => {
                    const approvalPct = Math.round(s.approvalRate * 100);
                    const dupPct = Math.round(s.duplicateRate * 100);
                    const pubPct = Math.round(s.publishedAtCoverage * 100);
                    const approvalColor = approvalPct >= 50 ? 'text-green-400' : approvalPct >= 25 ? 'text-yellow-400' : 'text-red-400';
                    const dupColor = dupPct <= 30 ? 'text-green-400' : dupPct <= 60 ? 'text-yellow-400' : 'text-red-400';
                    const scoreColor = s.avgQualityScore >= 60 ? 'text-green-400' : s.avgQualityScore >= 40 ? 'text-yellow-400' : 'text-red-400';
                    const srcLabel = s.scanSource === 'x-scan' ? 'X' : s.scanSource === 'web-search' ? 'WEB' : s.scanSource === 'perplexity' ? 'PPLX' : s.scanSource?.toUpperCase()?.slice(0, 4) || '?';
                    return (
                      <tr key={s.promptId || i} className="border-t border-border/30 hover:bg-card/30">
                        <td className="px-3 py-2 text-xs">
                          <span className="font-medium">{s.label}</span>
                          <span className="text-muted-foreground/60 ml-1 text-[10px]">{s.wire}</span>
                        </td>
                        <td className="px-2 py-2 text-[10px] font-mono text-muted-foreground">{srcLabel}</td>
                        <td className="px-2 py-2 text-xs font-mono text-right">{s.totalResults}</td>
                        <td className="px-2 py-2 text-xs font-mono text-right">{s.uniqueResults}</td>
                        <td className={`px-2 py-2 text-xs font-mono text-right ${dupColor}`}>{dupPct}%</td>
                        <td className={`px-2 py-2 text-xs font-mono text-right ${scoreColor}`}>{s.avgQualityScore}</td>
                        <td className="px-2 py-2 text-xs font-mono text-right">
                          <span className="text-green-400">{s.approvedCount}</span>
                          {s.declinedCount > 0 && <span className="text-red-400 ml-1">/{s.declinedCount}</span>}
                        </td>
                        <td className={`px-2 py-2 text-xs font-mono text-right ${approvalColor}`}>
                          {s.approvedCount + s.declinedCount > 0 ? `${approvalPct}%` : '\u2014'}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-0.5 justify-center">
                            {s.classificationMix.GRANT > 0 && <span className="px-1 py-0 rounded text-[8px] font-mono bg-green-500/10 text-green-400 border border-green-500/20">{s.classificationMix.GRANT}G</span>}
                            {s.classificationMix.NEWS > 0 && <span className="px-1 py-0 rounded text-[8px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20">{s.classificationMix.NEWS}N</span>}
                            {s.classificationMix.EXPIRED > 0 && <span className="px-1 py-0 rounded text-[8px] font-mono bg-orange-500/10 text-orange-400 border border-orange-500/20">{s.classificationMix.EXPIRED}E</span>}
                            {s.classificationMix.NOISE > 0 && <span className="px-1 py-0 rounded text-[8px] font-mono bg-red-500/10 text-red-400 border border-red-500/20">{s.classificationMix.NOISE}X</span>}
                            {s.classificationMix.UNCHECKED > 0 && <span className="px-1 py-0 rounded text-[8px] font-mono bg-muted/20 text-muted-foreground border border-border">{s.classificationMix.UNCHECKED}?</span>}
                          </div>
                        </td>
                        <td className={`px-2 py-2 text-xs font-mono text-right ${pubPct > 0 ? 'text-cyan-400' : 'text-muted-foreground/40'}`}>{pubPct}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Prompt table */}
      {prompts.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-12 text-center">
          <div className="text-4xl mb-3">🔍</div>
          <p className="text-sm text-muted-foreground">No scan prompts configured yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Click "+ Add Prompt" to create your first scan prompt.</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full min-w-[800px]">
            <thead>
              <tr className="bg-card/80 border-b border-border">
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">LABEL</th>
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-3 py-3">WIRE</th>
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-3 py-3">TOOL</th>
                <th className="text-center text-[10px] font-display tracking-widest text-muted-foreground px-3 py-3">STATUS</th>
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-3 py-3">LAST RUN</th>
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-3 py-3">NEXT RUN</th>
                <th className="text-right text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {[...prompts].sort((a, b) => {
                // Active first, then inactive
                if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
                // Within same status: sort by wire, then sortOrder
                if (a.wire !== b.wire) return a.wire.localeCompare(b.wire);
                return a.sortOrder - b.sortOrder;
              }).map((p, idx, sorted) => {
                const schedule = getWireSchedule(p.wire);
                const prevActive = idx > 0 ? sorted[idx - 1].isActive : true;
                const showDivider = prevActive && !p.isActive;
                return (
                  <Fragment key={p.id}>{showDivider && (
                    <tr className="border-t-2 border-t-border/60">
                      <td colSpan={7} className="px-4 py-2 text-[10px] font-display tracking-widest text-muted-foreground/60 uppercase bg-muted/5">
                        Inactive Prompts
                      </td>
                    </tr>
                  )}
                  <tr className={`border-b border-border/50 hover:bg-card/40 transition-colors ${!p.isActive ? 'opacity-40' : ''}`}>
                    <td className="px-4 py-3 text-sm font-medium">{p.label}</td>
                    <td className="px-3 py-3 text-sm">
                      <span className="inline-flex items-center px-2 py-0.5 rounded bg-card border border-border text-xs font-mono">
                        {p.wire}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-sm">
                      <span className="inline-flex items-center gap-1 text-xs">
                        {toolInfo(p.toolType).icon} {toolInfo(p.toolType).label}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-center">
                      <button
                        onClick={() => handleToggleActive(p)}
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-display tracking-wider border transition-colors ${
                          p.isActive
                            ? 'bg-status-success/10 text-status-success border-status-success/30'
                            : 'bg-muted/10 text-muted-foreground border-border'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${p.isActive ? 'bg-status-success' : 'bg-muted-foreground'}`} />
                        {p.isActive ? 'ACTIVE' : 'OFF'}
                      </button>
                    </td>
                    <td className="px-3 py-3 text-xs font-mono text-muted-foreground">
                      {p.lastRunAt ? timeAgo(p.lastRunAt) : <span className="text-muted-foreground/40">never</span>}
                    </td>
                    <td className="px-3 py-3 text-xs font-mono text-muted-foreground">
                      {schedule?.nextRun ? (
                        formatNextRun(schedule.nextRun)
                      ) : (
                        <span className="text-muted-foreground/40">no schedule</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleRun(p.id)}
                          disabled={running === p.id}
                          className="px-2 py-1 text-[10px] font-display tracking-wider border border-primary/30 text-primary rounded hover:bg-primary/10 transition-colors disabled:opacity-50"
                        >
                          {running === p.id ? '...' : 'RUN'}
                        </button>
                        <button
                          onClick={() => openEditSheet(p)}
                          className="px-2 py-1 text-[10px] font-display tracking-wider border border-primary/30 text-primary rounded hover:bg-primary/10 transition-colors"
                        >
                          EDIT
                        </button>
                        <button
                          onClick={() => handleDelete(p.id)}
                          className="px-2 py-1 text-[10px] font-display tracking-wider border border-red-500/30 text-red-400 rounded hover:bg-red-500/10 transition-colors"
                        >
                          DEL
                        </button>
                      </div>
                    </td>
                  </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Run Result */}
      {runResult && (
        <div className="border border-primary/20 rounded-lg bg-card/60 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h4 className="text-xs font-display tracking-wider text-primary">SCAN RESULTS</h4>
              <span className="text-xs text-muted-foreground font-mono">
                {runResult.parsedCount} found &middot; {runResult.newUnique} new &middot; {runResult.duplicatesFound} dupes &middot; {runResult.highQualityCount} high quality
              </span>
            </div>
            <button
              onClick={() => setRunResult(null)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Slide-out Edit/Add Sheet */}
      <Sheet open={sheetOpen} onOpenChange={(open) => { if (!open) { setSheetOpen(false); resetForm(); } }}>
        <SheetContent className="w-full sm:max-w-md md:max-w-lg border-l border-border bg-card overflow-y-auto">
          <div className="pt-6 space-y-6">
            <SheetHeader>
              <SheetTitle className="font-display tracking-wider text-base">
                {editingId ? 'EDIT PROMPT' : 'NEW PROMPT'}
              </SheetTitle>
            </SheetHeader>

            {/* Schedule section — editable */}
            {(editingId || formWire) && (
              <div className="bg-muted/20 border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-display tracking-widest text-muted-foreground">SCHEDULE</p>
                  {sheetSchedule && !scheduleEditing && (
                    <button
                      onClick={() => setScheduleEditing(true)}
                      className="text-[10px] font-display tracking-wider text-primary hover:text-primary/80 transition-colors"
                    >
                      EDIT
                    </button>
                  )}
                </div>

                {sheetSchedule ? (
                  scheduleEditing ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setScheduleEnabled(!scheduleEnabled)}
                          className={`relative w-10 h-5 rounded-full transition-colors ${
                            scheduleEnabled ? 'bg-primary' : 'bg-muted'
                          }`}
                        >
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                            scheduleEnabled ? 'left-5' : 'left-0.5'
                          }`} />
                        </button>
                        <span className="text-xs text-muted-foreground">
                          {scheduleEnabled ? 'Schedule enabled' : 'Schedule paused'}
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1">START HOUR</label>
                          <select
                            value={scheduleHour}
                            onChange={e => setScheduleHour(Number(e.target.value))}
                            className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono"
                          >
                            {Array.from({ length: 24 }, (_, i) => (
                              <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1">MINUTE</label>
                          <select
                            value={scheduleMinute}
                            onChange={e => setScheduleMinute(Number(e.target.value))}
                            className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono"
                          >
                            {[0, 15, 30, 45].map(m => (
                              <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1">EVERY</label>
                          <select
                            value={scheduleFrequency}
                            onChange={e => setScheduleFrequency(Number(e.target.value))}
                            className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono"
                          >
                            {[1, 2, 3, 4, 6, 8, 12, 24].map(h => (
                              <option key={h} value={h}>{h === 24 ? 'Daily' : `${h}h`}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleScheduleSave}
                          disabled={scheduleSaving}
                          className="px-3 py-1 text-[10px] font-display tracking-wider bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
                        >
                          {scheduleSaving ? 'SAVING...' : 'SAVE SCHEDULE'}
                        </button>
                        <button
                          onClick={() => {
                            setScheduleEditing(false);
                            // Reset to original values
                            if (sheetSchedule) {
                              setScheduleHour(sheetSchedule.hour);
                              setScheduleMinute(sheetSchedule.minute);
                              setScheduleFrequency(sheetSchedule.frequencyHours || 12);
                              setScheduleEnabled(sheetSchedule.enabled);
                            }
                          }}
                          className="px-3 py-1 text-[10px] font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors"
                        >
                          CANCEL
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-foreground">
                        <span className="text-muted-foreground">Schedule:</span> {sheetSchedule.name}
                        {sheetSchedule.enabled ? (
                          <span className="ml-2 text-status-success text-[10px]">ENABLED</span>
                        ) : (
                          <span className="ml-2 text-muted-foreground text-[10px]">DISABLED</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Runs every {sheetSchedule.frequencyHours || 24}h starting at {String(sheetSchedule.hour).padStart(2, '0')}:{String(sheetSchedule.minute).padStart(2, '0')} UTC
                      </p>
                      {sheetSchedule.nextRun && (
                        <p className="text-xs text-muted-foreground">
                          Next run: {new Date(sheetSchedule.nextRun).toLocaleString()} ({formatNextRun(sheetSchedule.nextRun)})
                        </p>
                      )}
                      {editingPrompt?.lastRunAt && (
                        <p className="text-xs text-muted-foreground">
                          Last run: {timeAgo(editingPrompt.lastRunAt)}
                        </p>
                      )}
                    </>
                  )
                ) : (
                  <p className="text-xs text-muted-foreground/60">No scan-execution schedule configured for this wire.</p>
                )}
              </div>
            )}

            {/* Form fields */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">WIRE</label>
                  <select
                    value={formWire}
                    onChange={e => setFormWire(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
                  >
                    <option value="">Select wire...</option>
                    {verticals.map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">VARIANT</label>
                  <select
                    value={formVariant}
                    onChange={e => setFormVariant(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
                  >
                    <option value="">(none)</option>
                    {VARIANTS.map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">LABEL</label>
                <input
                  type="text"
                  value={formLabel}
                  onChange={e => setFormLabel(e.target.value)}
                  placeholder="e.g. AI A — Action Scan"
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">TOOL TYPE</label>
                <select
                  value={formToolType}
                  onChange={e => setFormToolType(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
                >
                  {TOOL_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.icon} {t.label}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">INTENT</label>
                  <select
                    value={formIntent}
                    onChange={e => setFormIntent(e.target.value as 'discovery' | 'canonical' | 'signal')}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
                  >
                    {INTENTS.map(i => (
                      <option key={i.value} value={i.value}>{i.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">OUTPUT</label>
                  <select
                    value={formOutputFormat}
                    onChange={e => setFormOutputFormat(e.target.value as 'text' | 'json')}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
                  >
                    <option value="text">Text (parsed)</option>
                    <option value="json">JSON (structured)</option>
                  </select>
                </div>
              </div>

              {(formToolType === 'x_search' || formToolType === 'web_search') && (
                <div>
                  <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">
                    MODEL OVERRIDE <span className="text-muted-foreground/60">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={formModel}
                    onChange={e => setFormModel(e.target.value)}
                    placeholder="Default (provider setting)"
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono"
                  />
                </div>
              )}

              <div>
                <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">PROMPT TEXT</label>
                <textarea
                  value={formPromptText}
                  onChange={e => setFormPromptText(e.target.value)}
                  placeholder="Enter the scan prompt..."
                  rows={8}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono resize-y"
                />
              </div>

              <div>
                <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">
                  RESPONSE FORMAT <span className="text-muted-foreground/60">(optional)</span>
                </label>
                <textarea
                  value={formResponseFormat}
                  onChange={e => setFormResponseFormat(e.target.value)}
                  placeholder="Optional format instructions..."
                  rows={3}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono resize-y"
                />
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => setFormActive(!formActive)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    formActive ? 'bg-primary' : 'bg-muted'
                  }`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    formActive ? 'left-5' : 'left-0.5'
                  }`} />
                </button>
                <span className="text-xs text-muted-foreground">{formActive ? 'Active' : 'Disabled'}</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2 border-t border-border">
              <button
                onClick={handleSubmit}
                className="px-6 py-2 text-xs font-display tracking-wider bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
              >
                {editingId ? 'UPDATE' : 'CREATE'}
              </button>
              <button
                onClick={() => { setSheetOpen(false); resetForm(); }}
                className="px-6 py-2 text-xs font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors"
              >
                CANCEL
              </button>
            </div>

            {/* Recent Results Section */}
            {editingId && (
              <div className="pt-4 border-t border-border space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-display tracking-widest text-muted-foreground">
                    RECENT RESULTS
                    {promptResultsTotal > 0 && (
                      <span className="ml-2 text-foreground">({promptResultsTotal} total)</span>
                    )}
                  </p>
                  {!resultsLoading && editingId && (
                    <button
                      onClick={() => loadPromptResults(editingId)}
                      className="text-[10px] font-display tracking-wider text-primary hover:text-primary/80 transition-colors"
                    >
                      REFRESH
                    </button>
                  )}
                </div>

                {resultsLoading ? (
                  <p className="text-xs text-muted-foreground animate-pulse">Loading results...</p>
                ) : promptResults.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60">No results found for this prompt.</p>
                ) : (
                  <div className="space-y-1">
                    {promptResults.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex items-start gap-2 py-1.5 border-b border-border/30 last:border-0"
                      >
                        <span className={`flex-shrink-0 mt-0.5 inline-flex items-center px-1.5 py-0 rounded text-[9px] font-display tracking-wider border ${
                          STATUS_COLORS[entry.status] || STATUS_COLORS.raw
                        }`}>
                          {entry.status === 'approved' ? 'APR' :
                           entry.status === 'queued' ? 'QUE' :
                           entry.status === 'archived' ? 'ARC' :
                           entry.status === 'duplicate' ? 'DUP' :
                           entry.status === 'declined' ? 'DEC' :
                           entry.status.slice(0, 3).toUpperCase()}
                        </span>
                        {entry.quality_score > 0 && (
                          <span className={`flex-shrink-0 mt-0.5 text-[9px] font-mono w-5 text-right ${
                            entry.quality_score >= 70 ? 'text-green-400' :
                            entry.quality_score >= 40 ? 'text-yellow-400' : 'text-muted-foreground'
                          }`}>
                            {entry.quality_score}
                          </span>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs truncate">{entry.name || '(untitled)'}</p>
                          <p className="text-[10px] text-muted-foreground/60 font-mono">
                            {entry.created_at ? timeAgo(entry.created_at) : ''}
                          </p>
                        </div>
                      </div>
                    ))}
                    {promptResultsTotal > promptResults.length && (
                      <p className="text-[10px] text-muted-foreground/60 text-center pt-1">
                        Showing {promptResults.length} of {promptResultsTotal}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
