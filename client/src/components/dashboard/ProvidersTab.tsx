import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { fetchProviders as apiFetchProviders, updateProvider as apiUpdateProvider, testProvider as apiTestProvider, fetchModels } from '@/api';
import type { ProviderResponse, ModelInfo } from '@/api';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

type Provider = ProviderResponse;

const PROVIDER_ICONS: Record<string, string> = {
  grok: '\u{1F916}',
  firecrawl: '\u{1F525}',
  perplexity: '\u{1F52E}',
  resend: '\u{1F4E7}',
  telegram: '\u{1F4E1}',
  'telegram-intake': '\u{1F4E5}',
};

const PROVIDERS_WITH_BASE_URL = new Set(['grok', 'firecrawl', 'perplexity']);
const PROVIDERS_WITH_MODELS = new Set(['grok', 'perplexity']);

export function ProvidersTab() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ provider: string; ok: boolean; message: string } | null>(null);
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({});
  const { toast } = useToast();

  useEffect(() => {
    fetchModels().then(setModels).catch(() => {}); // silent fail, degrades to text input
  }, []);

  // Form state
  const [formApiKey, setFormApiKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formModel, setFormModel] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);

  const loadProviders = useCallback(async () => {
    try {
      const data = await apiFetchProviders();
      setProviders(data);
    } catch {
      toast({ title: 'Error', description: 'Failed to load providers' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const resetForm = () => {
    setFormApiKey('');
    setFormBaseUrl('');
    setFormModel('');
    setFormEnabled(true);
    setEditingKey(null);
    setTestResult(null);
  };

  const openEditForm = (p: Provider) => {
    setFormApiKey(p.api_key || '');
    setFormBaseUrl(p.base_url || '');
    setFormModel(p.default_model || '');
    setFormEnabled(p.enabled);
    setEditingKey(p.provider);
    setTestResult(null);
  };

  const handleTest = async (provider: string) => {
    setTesting(provider);
    setTestResult(null);
    try {
      const data = await apiTestProvider(provider);
      const ok = data.success;
      const message = data.error || (ok ? `Connected (${data.latencyMs}ms)` : 'Connection failed');
      setTestResult({ provider, ok, message });
      toast({
        title: ok ? 'Connected' : 'Connection Failed',
        description: message,
      });
    } catch {
      setTestResult({ provider, ok: false, message: 'Request failed' });
      toast({ title: 'Error', description: 'Test request failed' });
    } finally {
      setTesting(null);
    }
  };

  const handleSave = async () => {
    if (!editingKey) return;

    const body: Record<string, any> = { enabled: formEnabled };
    if (formApiKey && !formApiKey.startsWith('****')) {
      body.api_key = formApiKey;
    }
    if (PROVIDERS_WITH_BASE_URL.has(editingKey) && formBaseUrl) {
      body.base_url = formBaseUrl;
    }
    if (formModel) {
      body.default_model = formModel;
    }

    try {
      await apiUpdateProvider(editingKey, body);
      toast({ title: 'Success', description: 'Provider updated' });
      resetForm();
      await loadProviders();
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to save' });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center space-y-3">
          <div className="text-3xl animate-pulse">{'\u{1F50C}'}</div>
          <p className="text-sm text-muted-foreground font-mono">LOADING PROVIDERS...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-base sm:text-lg font-display tracking-wider glow-text">API PROVIDERS</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Manage API keys, base URLs, and default models for external services.
        </p>
      </div>

      {/* Provider list */}
      {providers.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-12 text-center">
          <div className="text-4xl mb-3">{'\u{1F50C}'}</div>
          <p className="text-sm text-muted-foreground">No providers found.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {providers.map(p => (
            <div key={p.provider} className="border border-border rounded-lg bg-card/80 p-5 space-y-4">
              {/* Top row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">{PROVIDER_ICONS[p.provider] || '\u{1F50C}'}</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{p.display_name}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-card border border-border font-display tracking-wider">
                        {p.provider.toUpperCase()}
                      </span>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-display tracking-wider border ${
                        p.source === 'db'
                          ? 'bg-primary/10 text-primary border-primary/30'
                          : 'bg-muted/10 text-muted-foreground border-border'
                      }`}>
                        {p.source.toUpperCase()}
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 font-mono space-x-3">
                      <span>Key: {p.api_key || 'not set'}</span>
                      {p.base_url && <span>URL: {p.base_url}</span>}
                      {PROVIDERS_WITH_MODELS.has(p.provider) && p.default_model && <span>Model: {p.default_model}</span>}
                    </div>
                  </div>
                </div>
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-display tracking-wider border ${
                  p.enabled
                    ? 'bg-status-success/10 text-status-success border-status-success/30'
                    : 'bg-muted/10 text-muted-foreground border-border'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${p.enabled ? 'bg-status-success' : 'bg-muted-foreground'}`} />
                  {p.enabled ? 'ACTIVE' : 'DISABLED'}
                </span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleTest(p.provider)}
                  disabled={testing === p.provider}
                  className="px-3 py-1.5 text-[10px] font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors disabled:opacity-50"
                >
                  {testing === p.provider ? 'TESTING...' : '\u{1F50C} TEST CONNECTION'}
                </button>
                <button
                  onClick={() => editingKey === p.provider ? resetForm() : openEditForm(p)}
                  className="px-3 py-1.5 text-[10px] font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors"
                >
                  {editingKey === p.provider ? 'CANCEL' : 'EDIT'}
                </button>
              </div>

              {/* Test result */}
              {testResult && testResult.provider === p.provider && testing === null && (
                <div className={`text-xs p-3 rounded border ${
                  testResult.ok
                    ? 'bg-status-success/5 border-status-success/20 text-status-success'
                    : 'bg-red-500/5 border-red-500/20 text-red-400'
                }`}>
                  {testResult.ok ? '\u2705' : '\u274C'} {testResult.message}
                </div>
              )}

              {/* Inline edit form */}
              {editingKey === p.provider && (
                <div className="border-t border-border pt-4 space-y-4">
                  {/* API Key */}
                  <div>
                    <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">
                      API KEY
                    </label>
                    <input
                      type="password"
                      value={formApiKey}
                      onChange={e => setFormApiKey(e.target.value)}
                      placeholder="(unchanged)"
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono"
                    />
                  </div>

                  {/* Base URL (conditional) */}
                  {PROVIDERS_WITH_BASE_URL.has(p.provider) && (
                    <div>
                      <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">
                        BASE URL
                      </label>
                      <input
                        type="text"
                        value={formBaseUrl}
                        onChange={e => setFormBaseUrl(e.target.value)}
                        placeholder="https://api.example.com/v1"
                        className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono"
                      />
                    </div>
                  )}

                  {/* Default Model (only for AI providers) */}
                  {PROVIDERS_WITH_MODELS.has(p.provider) && (
                    <div>
                      <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">
                        DEFAULT MODEL
                      </label>
                      {models[p.provider]?.length ? (
                        <Select value={formModel} onValueChange={setFormModel}>
                          <SelectTrigger className="w-full font-mono text-sm">
                            <SelectValue placeholder="Select a model" />
                          </SelectTrigger>
                          <SelectContent>
                            {models[p.provider].slice(0, 3).map(m => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.displayName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <input
                          type="text"
                          value={formModel}
                          onChange={e => setFormModel(e.target.value)}
                          placeholder="e.g. grok-4-1-fast"
                          className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono"
                        />
                      )}
                    </div>
                  )}

                  {/* Enabled toggle */}
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setFormEnabled(!formEnabled)}
                      className={`relative w-10 h-5 rounded-full transition-colors ${
                        formEnabled ? 'bg-primary' : 'bg-muted'
                      }`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        formEnabled ? 'left-5' : 'left-0.5'
                      }`} />
                    </button>
                    <span className="text-xs text-muted-foreground">{formEnabled ? 'Enabled' : 'Disabled'}</span>
                  </div>

                  {/* Save / Cancel */}
                  <div className="flex items-center gap-3 pt-2">
                    <button
                      onClick={handleSave}
                      className="px-6 py-2 text-xs font-display tracking-wider bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
                    >
                      SAVE
                    </button>
                    <button
                      onClick={resetForm}
                      className="px-6 py-2 text-xs font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors"
                    >
                      CANCEL
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
