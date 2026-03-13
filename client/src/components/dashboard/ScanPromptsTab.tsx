import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { ScanPrompt } from '@/types';
import {
  fetchScanPrompts,
  createScanPrompt,
  updateScanPrompt,
  deleteScanPrompt,
  testScanPrompt,
} from '@/api';

interface ScanPromptsTabProps {
  verticals: string[];
}

const TOOL_TYPES = [
  { value: 'x_search', label: 'X Search', icon: '🔎' },
  { value: 'web_search', label: 'Web Search', icon: '🌐' },
  { value: 'perplexity', label: 'Perplexity', icon: '🔮' },
];

const VARIANTS = ['A', 'B', 'C'];

export function ScanPromptsTab({ verticals }: ScanPromptsTabProps) {
  const [prompts, setPrompts] = useState<ScanPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    promptId: string;
    parsedCount: number;
    model: string;
    tokensUsed: number;
    parsedResults: any[];
    content: string;
  } | null>(null);
  const [testResultExpanded, setTestResultExpanded] = useState(false);
  const { toast } = useToast();

  // Form state
  const [formWire, setFormWire] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [formToolType, setFormToolType] = useState('x_search');
  const [formVariant, setFormVariant] = useState('');
  const [formPromptText, setFormPromptText] = useState('');
  const [formResponseFormat, setFormResponseFormat] = useState('');
  const [formActive, setFormActive] = useState(true);

  const loadPrompts = useCallback(async () => {
    try {
      const data = await fetchScanPrompts();
      setPrompts(data);
    } catch {
      toast({ title: 'Error', description: 'Failed to load scan prompts' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadPrompts(); }, [loadPrompts]);

  const resetForm = () => {
    setFormWire(verticals[0] || '');
    setFormLabel('');
    setFormToolType('x_search');
    setFormVariant('');
    setFormPromptText('');
    setFormResponseFormat('');
    setFormActive(true);
    setEditingId(null);
  };

  const openAddForm = () => {
    resetForm();
    setShowForm(true);
  };

  const openEditForm = (p: ScanPrompt) => {
    setFormWire(p.wire);
    setFormLabel(p.label);
    setFormToolType(p.toolType);
    setFormVariant(p.variant || '');
    setFormPromptText(p.promptText);
    setFormResponseFormat(p.responseFormat || '');
    setFormActive(p.isActive);
    setEditingId(p.id);
    setShowForm(true);
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
      setShowForm(false);
      resetForm();
      await loadPrompts();
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to save' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this scan prompt?')) return;
    try {
      await deleteScanPrompt(id);
      toast({ title: 'Deleted', description: 'Prompt removed' });
      if (testResult?.promptId === id) setTestResult(null);
      await loadPrompts();
    } catch {
      toast({ title: 'Error', description: 'Failed to delete prompt' });
    }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    setTestResult(null);
    try {
      const result = await testScanPrompt(id);
      setTestResult({
        promptId: id,
        parsedCount: result.parsedCount,
        model: result.model,
        tokensUsed: result.tokensUsed,
        parsedResults: result.parsedResults,
        content: result.content,
      });
      setTestResultExpanded(false);
      toast({ title: 'Test Complete', description: `${result.parsedCount} result${result.parsedCount !== 1 ? 's' : ''} parsed` });
    } catch (error) {
      toast({ title: 'Test Failed', description: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      setTesting(null);
    }
  };

  const handleToggleActive = async (p: ScanPrompt) => {
    try {
      await updateScanPrompt(p.id, { isActive: !p.isActive });
      await loadPrompts();
    } catch {
      toast({ title: 'Error', description: 'Failed to update prompt' });
    }
  };

  const toolInfo = (type: string) => TOOL_TYPES.find(t => t.value === type) || TOOL_TYPES[0];

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
          onClick={openAddForm}
          className="px-4 py-2 text-xs font-display tracking-wider bg-primary/10 text-primary border border-primary/30 rounded hover:bg-primary/20 transition-colors self-start sm:self-auto"
        >
          + ADD PROMPT
        </button>
      </div>

      {/* Prompt table */}
      {prompts.length === 0 && !showForm ? (
        <div className="border border-dashed border-border rounded-lg p-12 text-center">
          <div className="text-4xl mb-3">🔍</div>
          <p className="text-sm text-muted-foreground">No scan prompts configured yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Click "+ Add Prompt" to create your first scan prompt.</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead>
              <tr className="bg-card/80 border-b border-border">
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">LABEL</th>
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">WIRE</th>
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">TOOL</th>
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">VARIANT</th>
                <th className="text-center text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">STATUS</th>
                <th className="text-right text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {prompts.map(p => (
                <tr key={p.id} className="border-b border-border/50 hover:bg-card/40 transition-colors">
                  <td className="px-4 py-3 text-sm font-medium">{p.label}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className="inline-flex items-center px-2 py-0.5 rounded bg-card border border-border text-xs font-mono">
                      {p.wire}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-card border border-border text-xs">
                      {toolInfo(p.toolType).icon} {toolInfo(p.toolType).label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-muted-foreground">{p.variant || '—'}</td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => handleToggleActive(p)}
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-display tracking-wider border transition-colors ${
                        p.isActive
                          ? 'bg-status-success/10 text-status-success border-status-success/30'
                          : 'bg-muted/10 text-muted-foreground border-border'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${p.isActive ? 'bg-status-success' : 'bg-muted-foreground'}`} />
                      {p.isActive ? 'ACTIVE' : 'DISABLED'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleTest(p.id)}
                        disabled={testing === p.id}
                        className="px-2 py-1 text-[10px] font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors disabled:opacity-50"
                      >
                        {testing === p.id ? '...' : 'TEST'}
                      </button>
                      <button
                        onClick={() => openEditForm(p)}
                        className="px-2 py-1 text-[10px] font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors"
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Test Result */}
      {testResult && (
        <div className="border border-primary/20 rounded-lg bg-card/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h4 className="text-xs font-display tracking-wider text-primary">TEST RESULTS</h4>
              <span className="text-xs text-muted-foreground font-mono">
                {testResult.parsedCount} parsed &middot; {testResult.model} &middot; {testResult.tokensUsed.toLocaleString()} tokens
              </span>
            </div>
            <button
              onClick={() => setTestResult(null)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Dismiss
            </button>
          </div>

          {/* Parsed result names */}
          {testResult.parsedResults.length > 0 && (
            <div className="space-y-1">
              {testResult.parsedResults.slice(0, 10).map((r: any, i: number) => (
                <div key={i} className="text-xs font-mono text-muted-foreground flex items-baseline gap-2">
                  <span className="text-primary/60 w-4 text-right flex-shrink-0">{i + 1}.</span>
                  <span className="truncate">{r.name || r.title || '(untitled)'}</span>
                </div>
              ))}
              {testResult.parsedResults.length > 10 && (
                <p className="text-[10px] text-muted-foreground pl-6">
                  ...and {testResult.parsedResults.length - 10} more
                </p>
              )}
            </div>
          )}

          {/* Collapsible raw output */}
          <div>
            <button
              onClick={() => setTestResultExpanded(!testResultExpanded)}
              className="text-[10px] font-display tracking-wider text-muted-foreground hover:text-foreground transition-colors"
            >
              {testResultExpanded ? '▾ HIDE RAW OUTPUT' : '▸ SHOW RAW OUTPUT'}
            </button>
            {testResultExpanded && (
              <pre className="mt-2 p-3 bg-background border border-border rounded text-[11px] font-mono text-muted-foreground overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap">
                {testResult.content.slice(0, 3000)}
                {testResult.content.length > 3000 && '\n\n... (truncated)'}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && (
        <div className="border border-primary/30 rounded-lg bg-card/80 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-display tracking-wider glow-text">
              {editingId ? 'EDIT PROMPT' : 'NEW PROMPT'}
            </h3>
            <button
              onClick={() => { setShowForm(false); resetForm(); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Close
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Wire */}
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

            {/* Label */}
            <div>
              <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">LABEL</label>
              <input
                type="text"
                value={formLabel}
                onChange={e => setFormLabel(e.target.value)}
                placeholder="e.g. Crypto Grants X Search"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
              />
            </div>

            {/* Tool Type */}
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

            {/* Variant */}
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

            {/* Prompt Text */}
            <div className="md:col-span-2">
              <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">PROMPT TEXT</label>
              <textarea
                value={formPromptText}
                onChange={e => setFormPromptText(e.target.value)}
                placeholder="Enter the scan prompt..."
                rows={8}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono resize-y"
              />
            </div>

            {/* Response Format */}
            <div className="md:col-span-2">
              <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">
                RESPONSE FORMAT <span className="text-muted-foreground/60">(optional)</span>
              </label>
              <textarea
                value={formResponseFormat}
                onChange={e => setFormResponseFormat(e.target.value)}
                placeholder="Optional format instructions for the model..."
                rows={3}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono resize-y"
              />
            </div>

            {/* Active toggle */}
            <div className="flex items-center gap-3 md:col-span-2">
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

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handleSubmit}
              className="px-6 py-2 text-xs font-display tracking-wider bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
            >
              {editingId ? 'UPDATE' : 'CREATE'}
            </button>
            <button
              onClick={() => { setShowForm(false); resetForm(); }}
              className="px-6 py-2 text-xs font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors"
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
