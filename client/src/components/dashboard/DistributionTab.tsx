import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';

interface DistributionChannel {
  id: string;
  wire: string;
  channel: string;
  name: string;
  enabled: boolean;
  target_id: string;
  credentials: Record<string, string>;
  created_at: string;
  updated_at: string;
}

interface DistributionTabProps {
  verticals: string[];
}

const CHANNEL_TYPES = [
  { value: 'telegram', label: 'Telegram', icon: '✈️' },
  { value: 'discord', label: 'Discord', icon: '🎮' },
  { value: 'slack', label: 'Slack', icon: '💬' },
];

const CHANNEL_HELP: Record<string, string> = {
  telegram: 'Bot token from @BotFather. Chat ID for channel (e.g. -100123...)',
  discord: 'Bot token from Discord Developer Portal. Channel ID (right-click channel → Copy ID)',
  slack: 'Incoming webhook URL from Slack app settings',
};

const CREDENTIAL_FIELDS: Record<string, { key: string; label: string; type: string }[]> = {
  telegram: [{ key: 'bot_token', label: 'Bot Token', type: 'password' }],
  discord: [{ key: 'bot_token', label: 'Bot Token', type: 'password' }],
  slack: [{ key: 'webhook_url', label: 'Webhook URL', type: 'password' }],
};

const BASE = '/api';

// Wires are a fixed canonical set (crypto / ai / oss). Hardcoded here so the
// channel picker can never drift, even if the feeds endpoint returns something
// unexpected. Order is the display order in the dropdown.
const WIRE_OPTIONS = [
  { key: 'crypto', label: 'Crypto' },
  { key: 'ai', label: 'AI' },
  { key: 'oss', label: 'OSS' },
];

export function DistributionTab(_: DistributionTabProps) {
  const [channels, setChannels] = useState<DistributionChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const { toast } = useToast();

  // Form state
  const [formWire, setFormWire] = useState('');
  const [formChannel, setFormChannel] = useState('telegram');
  const [formName, setFormName] = useState('');
  const [formTargetId, setFormTargetId] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  const [formCreds, setFormCreds] = useState<Record<string, string>>({});

  const loadChannels = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/distribution/channels`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      setChannels(data);
    } catch {
      toast({ title: 'Error', description: 'Failed to load distribution channels' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadChannels(); }, [loadChannels]);

  const resetForm = () => {
    setFormWire(WIRE_OPTIONS[0].key);
    setFormChannel('telegram');
    setFormName('');
    setFormTargetId('');
    setFormEnabled(true);
    setFormCreds({});
    setEditingId(null);
  };

  const openAddForm = () => {
    resetForm();
    setShowForm(true);
  };

  const openEditForm = (ch: DistributionChannel) => {
    setFormWire(ch.wire);
    setFormChannel(ch.channel);
    setFormName(ch.name);
    setFormTargetId(ch.target_id);
    setFormEnabled(ch.enabled);
    setFormCreds(ch.credentials);
    setEditingId(ch.id);
    setShowForm(true);
  };

  const handleSubmit = async () => {
    if (!formName.trim()) {
      toast({ title: 'Error', description: 'Name is required' });
      return;
    }

    const body = {
      wire: formWire,
      channel: formChannel,
      name: formName,
      enabled: formEnabled,
      target_id: formTargetId,
      credentials: formCreds,
    };

    try {
      const url = editingId
        ? `${BASE}/distribution/channels/${editingId}`
        : `${BASE}/distribution/channels`;
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Request failed');
      }

      toast({ title: 'Success', description: editingId ? 'Channel updated' : 'Channel created' });
      setShowForm(false);
      resetForm();
      await loadChannels();
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to save' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this distribution channel?')) return;
    try {
      const res = await fetch(`${BASE}/distribution/channels/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'Deleted', description: 'Channel removed' });
      await loadChannels();
    } catch {
      toast({ title: 'Error', description: 'Failed to delete channel' });
    }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const res = await fetch(`${BASE}/distribution/channels/${id}/test`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        toast({ title: '✅ Test Passed', description: 'Test message sent successfully' });
      } else {
        toast({ title: '❌ Test Failed', description: data.error || 'Unknown error' });
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to send test message' });
    } finally {
      setTesting(null);
    }
  };

  const handleToggleEnabled = async (ch: DistributionChannel) => {
    try {
      const res = await fetch(`${BASE}/distribution/channels/${ch.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !ch.enabled }),
      });
      if (!res.ok) throw new Error('Update failed');
      await loadChannels();
    } catch {
      toast({ title: 'Error', description: 'Failed to update channel' });
    }
  };

  const channelIcon = (type: string) => {
    return CHANNEL_TYPES.find(ct => ct.value === type)?.icon || '📡';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center space-y-3">
          <div className="text-3xl animate-pulse">📡</div>
          <p className="text-sm text-muted-foreground font-mono">LOADING CHANNELS...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base sm:text-lg font-display tracking-wider glow-text">DISTRIBUTION CHANNELS</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {channels.length} channel{channels.length !== 1 ? 's' : ''} configured.
          </p>
        </div>
        <button
          onClick={openAddForm}
          className="px-4 py-2 text-xs font-display tracking-wider bg-primary/10 text-primary border border-primary/30 rounded hover:bg-primary/20 transition-colors self-start sm:self-auto"
        >
          + ADD CHANNEL
        </button>
      </div>

      {/* Channel table */}
      {channels.length === 0 && !showForm ? (
        <div className="border border-dashed border-border rounded-lg p-12 text-center">
          <div className="text-4xl mb-3">📡</div>
          <p className="text-sm text-muted-foreground">No distribution channels configured yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Click "Add Channel" to set up Telegram, Discord, or Slack delivery.</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full min-w-[600px]">
            <thead>
              <tr className="bg-card/80 border-b border-border">
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">NAME</th>
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">TYPE</th>
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">WIRE</th>
                <th className="text-left text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">TARGET</th>
                <th className="text-center text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">STATUS</th>
                <th className="text-right text-[10px] font-display tracking-widest text-muted-foreground px-4 py-3">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {channels.map(ch => (
                <tr key={ch.id} className="border-b border-border/50 hover:bg-card/40 transition-colors">
                  <td className="px-4 py-3 text-sm font-medium">{ch.name}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-card border border-border text-xs">
                      {channelIcon(ch.channel)} {ch.channel}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-muted-foreground">{ch.wire}</td>
                  <td className="px-4 py-3 text-xs font-mono text-muted-foreground max-w-[200px] truncate">{ch.target_id || '—'}</td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => handleToggleEnabled(ch)}
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-display tracking-wider border transition-colors ${
                        ch.enabled
                          ? 'bg-status-success/10 text-status-success border-status-success/30'
                          : 'bg-muted/10 text-muted-foreground border-border'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${ch.enabled ? 'bg-status-success' : 'bg-muted-foreground'}`} />
                      {ch.enabled ? 'ACTIVE' : 'DISABLED'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleTest(ch.id)}
                        disabled={testing === ch.id}
                        className="px-2 py-1 text-[10px] font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors disabled:opacity-50"
                      >
                        {testing === ch.id ? '...' : 'TEST'}
                      </button>
                      <button
                        onClick={() => openEditForm(ch)}
                        className="px-2 py-1 text-[10px] font-display tracking-wider border border-border rounded hover:bg-card/80 transition-colors"
                      >
                        EDIT
                      </button>
                      <button
                        onClick={() => handleDelete(ch.id)}
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

      {/* Add/Edit Form */}
      {showForm && (
        <div className="border border-primary/30 rounded-lg bg-card/80 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-display tracking-wider glow-text">
              {editingId ? 'EDIT CHANNEL' : 'NEW CHANNEL'}
            </h3>
            <button
              onClick={() => { setShowForm(false); resetForm(); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ✕ Close
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Wire */}
            <div>
              <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">WIRE</label>
              <select
                value={WIRE_OPTIONS.some(o => o.key === formWire) ? formWire : ''}
                onChange={e => setFormWire(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
              >
                {WIRE_OPTIONS.map(o => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
                {/* Preserve a legacy/non-core wire when editing so it stays visible */}
                {/* until the user picks a valid one; never offered for new channels. */}
                {formWire && !WIRE_OPTIONS.some(o => o.key === formWire) && (
                  <option value={formWire}>{formWire} (legacy)</option>
                )}
              </select>
            </div>

            {/* Channel Type */}
            <div>
              <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">CHANNEL TYPE</label>
              <select
                value={formChannel}
                onChange={e => {
                  setFormChannel(e.target.value);
                  setFormCreds({});
                }}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
              >
                {CHANNEL_TYPES.map(ct => (
                  <option key={ct.value} value={ct.value}>{ct.icon} {ct.label}</option>
                ))}
              </select>
              <p className="text-[10px] text-muted-foreground mt-1">{CHANNEL_HELP[formChannel]}</p>
            </div>

            {/* Name */}
            <div>
              <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">DISPLAY NAME</label>
              <input
                type="text"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder="e.g. CryptoGrantWire Telegram"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
              />
            </div>

            {/* Target ID */}
            <div>
              <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">
                {formChannel === 'slack' ? 'TARGET (OPTIONAL)' : 'TARGET ID'}
              </label>
              <input
                type="text"
                value={formTargetId}
                onChange={e => setFormTargetId(e.target.value)}
                placeholder={
                  formChannel === 'telegram' ? '-1001234567890' :
                  formChannel === 'discord' ? '1234567890123456' :
                  'Optional for webhooks'
                }
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono"
              />
            </div>

            {/* Credentials */}
            {(CREDENTIAL_FIELDS[formChannel] || []).map(field => (
              <div key={field.key} className="md:col-span-2">
                <label className="block text-[10px] font-display tracking-widest text-muted-foreground mb-1.5">
                  {field.label.toUpperCase()}
                </label>
                <input
                  type={field.type}
                  value={formCreds[field.key] || ''}
                  onChange={e => setFormCreds(prev => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={editingId ? '(unchanged if left empty)' : `Enter ${field.label.toLowerCase()}`}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none font-mono"
                />
              </div>
            ))}

            {/* Enabled */}
            <div className="flex items-center gap-3 md:col-span-2">
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
