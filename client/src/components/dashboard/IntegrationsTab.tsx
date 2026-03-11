import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';

interface Integration {
  id: number;
  provider: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  created_at: string;
  updated_at: string;
}

interface ValidationResult {
  valid: boolean;
  workspace?: string;
  database?: string;
  properties?: string[];
  error?: string;
}

const BASE = '/api';

export function IntegrationsTab() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [validating, setValidating] = useState<number | null>(null);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const { toast } = useToast();

  // Form state
  const [formName, setFormName] = useState('');
  const [formToken, setFormToken] = useState('');
  const [formDatabaseId, setFormDatabaseId] = useState('');
  const [formEnabled, setFormEnabled] = useState(false);

  const loadIntegrations = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/integrations`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      setIntegrations(data);
    } catch {
      toast({ title: 'Error', description: 'Failed to load integrations' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadIntegrations(); }, [loadIntegrations]);

  const resetForm = () => {
    setFormName('');
    setFormToken('');
    setFormDatabaseId('');
    setFormEnabled(false);
    setEditingId(null);
    setValidationResult(null);
  };

  const openAddForm = () => {
    resetForm();
    setShowForm(true);
  };

  const openEditForm = (integration: Integration) => {
    setFormName(integration.name);
    setFormToken(integration.config.notion_token || '');
    setFormDatabaseId(integration.config.database_id || '');
    setFormEnabled(integration.enabled);
    setEditingId(integration.id);
    setValidationResult(null);
    setShowForm(true);
  };

  const handleSubmit = async () => {
    if (!formName.trim()) {
      toast({ title: 'Error', description: 'Name is required' });
      return;
    }

    const configData: Record<string, string> = {};
    if (formToken && !formToken.startsWith('****')) {
      configData.notion_token = formToken;
    }
    if (formDatabaseId) {
      configData.database_id = formDatabaseId.trim().replace(/[^a-f0-9-]/g, '');
    }

    try {
      const url = editingId
        ? `${BASE}/integrations/${editingId}`
        : `${BASE}/integrations`;
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'notion',
          name: formName,
          enabled: formEnabled,
          config: configData,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Request failed');
      }

      toast({ title: 'Success', description: editingId ? 'Integration updated' : 'Integration created' });
      setShowForm(false);
      resetForm();
      await loadIntegrations();
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to save' });
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this integration?')) return;
    try {
      const res = await fetch(`${BASE}/integrations/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'Deleted', description: 'Integration removed' });
      await loadIntegrations();
    } catch {
      toast({ title: 'Error', description: 'Failed to delete' });
    }
  };

  const handleValidate = async (id: number) => {
    setValidating(id);
    setValidationResult(null);
    try {
      const res = await fetch(`${BASE}/integrations/${id}/validate`, { method: 'POST' });
      const data: ValidationResult = await res.json();
      setValidationResult(data);
      if (data.valid) {
        toast({ title: '✅ Connected', description: `Workspace: ${data.workspace}${data.database ? ` · DB: ${data.database}` : ''}` });
      } else {
        toast({ title: '❌ Connection Failed', description: data.error || 'Unknown error' });
      }
    } catch {
      toast({ title: 'Error', description: 'Validation request failed' });
    } finally {
      setValidating(null);
    }
  };

  const handleSync = async (id: number) => {
    setSyncing(id);
    try {
      const res = await fetch(`${BASE}/integrations/${id}/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        toast({ title: '✅ Sync Complete', description: data.message });
      } else {
        toast({ title: '❌ Sync Failed', description: data.error || 'Unknown error' });
      }
      await loadIntegrations();
    } catch {
      toast({ title: 'Error', description: 'Sync request failed' });
    } finally {
      setSyncing(null);
    }
  };

  const handleToggleEnabled = async (integration: Integration) => {
    try {
      const res = await fetch(`${BASE}/integrations/${integration.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !integration.enabled }),
      });
      if (!res.ok) throw new Error('Update failed');
      await loadIntegrations();
    } catch {
      toast({ title: 'Error', description: 'Failed to toggle' });
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const syncStatusBadge = (status: string | null) => {
    if (!status) return null;
    const colors: Record<string, string> = {
      success: 'bg-status-success/10 text-status-success border-status-success/30',
      partial: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
      error: 'bg-red-500/10 text-red-400 border-red-500/30',
    };
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-display tracking-wider border ${colors[status] || 'bg-muted/10 text-muted-foreground border-border'}`}>
        {status.toUpperCase()}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center space-y-3">
          <div className="text-3xl animate-pulse">🔗</div>
          <p className="text-sm text-muted-foreground font-mono">LOADING INTEGRATIONS...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base sm:text-lg font-display tracking-wider glow-text">INTEGRATIONS</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Connect external services. Sync org profiles to Notion CRM.
          </p>
        </div>
        <button
          onClick={openAddForm}
          className="px-4 py-2 text-xs font-display tracking-wider bg-primary/10 text-primary border border-primary/30 rounded hover:bg-primary/20 transition-colors self-start sm:self-auto"
        >
          + ADD INTEGRATION
        </button>
      </div>

      {/* Integration list */}
      {integrations.length === 0 && !showForm ? (
        <div className="border border-dashed border-border rounded-lg p-12 text-center">
          <div className="text-4xl mb-3">🔗</div>
          <p className="text-sm text-muted-foreground">No integrations configured.</p>
          <p className="text-xs text-muted-foreground mt-1">Add a Notion integration to sync org profiles as a CRM database.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {integrations.map(integration => (
            <div key={integration.id} className="border border-border rounded-lg bg-card/80 p-5 space-y-4">
              {/* Top row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">📓</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{integration.name}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-card border border-border font-display tracking-wider">
                        {integration.provider.toUpperCase()}
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                      Token: {integration.config.notion_token || 'not set'}
                      {integration.config.database_id && ` · DB: ${integration.config.database_id.substring(0, 8)}…`}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleToggleEnabled(integration)}
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-display tracking-wider border transition-colors ${
                    integration.enabled
                      ? 'bg-status-success/10 text-status-success border-status-success/30'
                      : 'bg-muted/10 text-muted-foreground border-border'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${integration.enabled ? 'bg-status-success' : 'bg-muted-foreground'}`} />
                  {integration.enabled ? 'ACTIVE' : 'DISABLED'}
                </button>
              </div>

              {/* Sync status */}
              {integration.last_sync_at && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>Last sync: {formatDate(integration.last_sync_at)}</span>
                  {syncStatusBadge(integration.last_sync_status)}
                  {integration.last_sync_message && (
                    <span className="text-[10px] truncate max-w-[300px]">{integration.last_sync_message}</span>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleValidate(integration.id)}
                  disabled={validating === integration.id}
                  className="px-3 py-1.5 text-[10px] font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors disabled:opacity-50"
                >
                  {validating === integration.id ? 'TESTING...' : '🔌 TEST CONNECTION'}
                </button>
                <button
                  onClick={() => handleSync(integration.id)}
                  disabled={syncing === integration.id || !integration.enabled}
                  className="px-3 py-1.5 text-[10px] font-display tracking-wider bg-primary/10 text-primary border border-primary/30 rounded hover:bg-primary/20 transition-colors disabled:opacity-50"
                >
                  {syncing === integration.id ? 'SYNCING...' : '🔄 SYNC NOW'}
                </button>
                <button
                  onClick={() => openEditForm(integration)}
                  className="px-3 py-1.5 text-[10px] font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors"
                >
                  EDIT
                </button>
                <button
                  onClick={() => handleDelete(integration.id)}
                  className="px-3 py-1.5 text-[10px] font-display tracking-wider border border-red-500/30 text-red-400 rounded hover:bg-red-500/10 transition-colors"
                >
                  DELETE
                </button>
              </div>

              {/* Validation result */}
              {validationResult && validating === null && (
                <div className={`text-xs p-3 rounded border ${
                  validationResult.valid
                    ? 'bg-status-success/5 border-status-success/20 text-status-success'
                    : 'bg-red-500/5 border-red-500/20 text-red-400'
                }`}>
                  {validationResult.valid ? (
                    <div className="space-y-1">
                      <div>✅ Connected to workspace: <strong>{validationResult.workspace}</strong></div>
                      {validationResult.database && <div>📊 Database: <strong>{validationResult.database}</strong></div>}
                      {validationResult.properties && (
                        <div className="text-[10px] text-muted-foreground mt-1">
                          Properties: {validationResult.properties.join(', ')}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>❌ {validationResult.error}</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && (
        <div className="border border-primary/30 rounded-lg bg-card/80 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-display tracking-wider glow-text">
              {editingId ? 'EDIT INTEGRATION' : 'NEW NOTION INTEGRATION'}
            </h3>
            <button
              onClick={() => { setShowForm(false); resetForm(); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ✕ Close
            </button>
          </div>

          <div className="space-y-4">
            {/* Name */}
            <div>
              <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">
                DISPLAY NAME
              </label>
              <input
                type="text"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder="e.g. Wire Room CRM"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
              />
            </div>

            {/* Notion Token */}
            <div>
              <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">
                NOTION INTEGRATION TOKEN
              </label>
              <input
                type="password"
                value={formToken}
                onChange={e => setFormToken(e.target.value)}
                placeholder={editingId ? '(unchanged if left empty)' : 'ntn_...'}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Create at notion.so/my-integrations → New integration → copy the token.
                The integration must be invited to the target database.
              </p>
            </div>

            {/* Database ID */}
            <div>
              <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">
                NOTION DATABASE ID
              </label>
              <input
                type="text"
                value={formDatabaseId}
                onChange={e => setFormDatabaseId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Open the database as a full page → copy the ID from the URL.
                The database should have: Name (title), Wires (multi-select), Entries (number), First Seen (date), Last Seen (date).
              </p>
            </div>

            {/* Enabled */}
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
              <span className="text-xs text-muted-foreground">{formEnabled ? 'Enabled (will sync)' : 'Disabled'}</span>
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

      {/* Help section */}
      <div className="border border-border/50 rounded-lg p-5 bg-card/30">
        <h3 className="text-xs font-display tracking-wider text-muted-foreground mb-3">HOW IT WORKS</h3>
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>1. Create a Notion integration at <span className="font-mono text-foreground/60">notion.so/my-integrations</span></p>
          <p>2. Create a database with columns: <strong>Name</strong> (title), <strong>Wires</strong> (multi-select), <strong>Entries</strong> (number), <strong>First Seen</strong> (date), <strong>Last Seen</strong> (date)</p>
          <p>3. Invite the integration to the database page (Share → Invite)</p>
          <p>4. Paste the token and database ID here, then hit Test Connection</p>
          <p>5. Enable the integration and hit Sync Now — org profiles will be pushed to Notion</p>
        </div>
      </div>
    </div>
  );
}
