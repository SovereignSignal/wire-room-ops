import { useState, useEffect, useCallback } from 'react';
import { VerticalStats, WireCounts } from '@/types';
import { Clock, FileStack, Copy, TrendingUp, Wifi, AlertTriangle, Star, ArrowRight, Mail, Save, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { fetchSchedules, updateSchedule, createSchedule, type ScheduleResponse } from '@/api';

interface SourcesTabProps {
  stats: VerticalStats[];
  wireCounts: WireCounts[];
  onNavigateToQueue: (wire: string) => void;
}

function qualityConfig(score: number): { color: string; label: string; bg: string; border: string } {
  if (score >= 60) return {
    color: 'text-status-success',
    label: 'Healthy',
    bg: 'bg-status-success/10',
    border: 'border-status-success/30',
  };
  if (score >= 40) return {
    color: 'text-status-warning',
    label: 'Marginal',
    bg: 'bg-status-warning/10',
    border: 'border-status-warning/30',
  };
  return {
    color: 'text-destructive',
    label: 'Poor — most items auto-archived',
    bg: 'bg-destructive/10',
    border: 'border-destructive/30',
  };
}

const TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
];

const TZ_LABELS: Record<string, string> = {
  'America/Los_Angeles': 'Pacific',
  'America/Denver': 'Mountain',
  'America/Chicago': 'Central',
  'America/New_York': 'Eastern',
  'UTC': 'UTC',
  'Europe/London': 'London',
  'Europe/Berlin': 'Berlin',
  'Asia/Tokyo': 'Tokyo',
  'Asia/Shanghai': 'Shanghai',
};

function DailyDigestCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [digest, setDigest] = useState<ScheduleResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState(6);
  const [minute, setMinute] = useState(0);
  const [timezone, setTimezone] = useState('America/Los_Angeles');
  const [recipients, setRecipients] = useState('');
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const { toast } = useToast();

  const loadDigest = useCallback(async () => {
    try {
      const schedules = await fetchSchedules();
      const found = schedules.find(s => s.scheduleType === 'daily-digest');
      if (found) {
        setDigest(found);
        setEnabled(found.enabled);
        setHour(found.hour);
        setMinute(found.minute);
        setTimezone(found.timezone);
        setRecipients(found.notifyEmails || '');
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load digest schedule' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadDigest(); }, [loadDigest]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        name: 'Daily Digest',
        scheduleType: 'daily-digest' as const,
        enabled,
        hour,
        minute,
        timezone,
        notifyEmails: recipients.trim() || undefined,
        dayOfWeek: 0,
        lookbackDays: 1,
      };

      let result: ScheduleResponse;
      if (digest?.id) {
        result = await updateSchedule(digest.id, payload);
      } else {
        result = await createSchedule(payload);
      }
      setDigest(result);
      setDirty(false);
      toast({ title: 'Saved', description: 'Daily digest schedule updated' });
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  const markDirty = () => setDirty(true);

  const handleSendTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/test-alert', { method: 'POST', credentials: 'include' });
      if (res.ok) {
        toast({ title: 'Test sent', description: `Check ${recipients || 'your inbox'} for the test email` });
      } else {
        const err = await res.json().catch(() => ({}));
        toast({ title: 'Send failed', description: (err as { error?: string }).error || 'Unknown error' });
      }
    } catch {
      toast({ title: 'Error', description: 'Could not reach server' });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="stat-card flex items-center justify-center p-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="stat-card group flex flex-col">
      {/* Card header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Mail className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h3 className="font-display font-semibold text-sm tracking-wider uppercase">
              Daily Digest Email
            </h3>
            <p className="text-[10px] text-muted-foreground font-mono">
              {enabled ? 'Active' : 'Disabled'} &middot; {digest?.id ? 'configured' : 'not created'}
            </p>
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => { setEnabled(checked); markDirty(); }}
        />
      </div>

      {/* Config form */}
      <div className="space-y-4 flex-1">
        {/* Time picker */}
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Hour</Label>
            <select
              value={hour}
              onChange={(e) => { setHour(Number(e.target.value)); markDirty(); }}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Minute</Label>
            <select
              value={minute}
              onChange={(e) => { setMinute(Number(e.target.value)); markDirty(); }}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {[0, 15, 30, 45].map(m => (
                <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Timezone</Label>
            <select
              value={timezone}
              onChange={(e) => { setTimezone(e.target.value); markDirty(); }}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{TZ_LABELS[tz] || tz}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Recipients */}
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Recipients</Label>
          <Input
            value={recipients}
            onChange={(e) => { setRecipients(e.target.value); markDirty(); }}
            placeholder="sov@sovereignsignal.com, ops@example.com"
            className="bg-background text-sm font-mono"
          />
          <p className="text-[10px] text-muted-foreground">Comma-separated email addresses</p>
        </div>

        {/* Next send */}
        {digest?.nextRun && enabled && (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono px-3 py-2 rounded bg-muted/30 border border-border/50">
            <Clock className="w-3 h-3" />
            Next send: {new Date(digest.nextRun).toLocaleString(undefined, {
              weekday: 'short', month: 'short', day: 'numeric',
              hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
            })}
          </div>
        )}
      </div>

      {/* Actions row */}
      <div className="mt-4 flex gap-2">
        <Button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="flex-1 gap-1.5 font-display text-[10px] tracking-wider"
          variant={dirty ? 'default' : 'outline'}
          size="sm"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          {saving ? 'SAVING...' : dirty ? 'SAVE CHANGES' : 'SAVED'}
        </Button>
        <Button
          onClick={handleSendTest}
          disabled={testing || !recipients.trim()}
          variant="outline"
          size="sm"
          className="gap-1.5 font-display text-[10px] tracking-wider"
          title="Send a test email now to verify delivery"
        >
          {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
          {testing ? 'SENDING...' : 'TEST'}
        </Button>
      </div>
    </div>
  );
}

export function SourcesTab({ stats, wireCounts, onNavigateToQueue }: SourcesTabProps) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {stats.map((stat, index) => {
          const hoursAgo = (Date.now() - new Date(stat.last_scan).getTime()) / 3_600_000;
          const isStale = hoursAgo > 6;
          const qConfig = qualityConfig(stat.avg_quality_score);
          const counts = wireCounts.find(w => w.wire === stat.wire);
          const highQualityPct = stat.items_this_week > 0
            ? Math.round((stat.high_quality_count / stat.items_this_week) * 100)
            : 0;

          return (
            <div key={stat.wire || index} className="stat-card group flex flex-col">
              {/* Decorative corner pulse */}
              <div className="absolute top-0 right-0 w-16 h-16 overflow-hidden">
                <div
                  className="absolute top-2 right-2 w-1 h-1 rounded-full bg-primary/50 signal-pulse"
                  style={{ animationDelay: `${index * 0.3}s` }}
                />
              </div>

              {/* Card header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Wifi className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-sm tracking-wider uppercase">
                      {stat.wire || <span className="text-muted-foreground italic">unknown</span>}
                    </h3>
                    <p className="text-[10px] text-muted-foreground font-mono">
                      {stat.scans_run} scans this week
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isStale && (
                    <span title={`Last scan ${Math.round(hoursAgo)}h ago — pipeline may be stalled`}>
                      <AlertTriangle className="w-4 h-4 text-status-warning animate-pulse" />
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground font-mono px-2 py-1 rounded bg-muted/50 border border-border">
                    {formatDistanceToNow(new Date(stat.last_scan), { addSuffix: true })}
                  </span>
                </div>
              </div>

              {/* Metrics grid */}
              <div className="grid grid-cols-2 gap-3 flex-1">
                {/* Ingested */}
                <div className="space-y-1 p-3 rounded bg-muted/30 border border-border/50">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <FileStack className="w-3 h-3" />
                    Ingested
                  </div>
                  <div className="text-2xl font-mono font-semibold text-foreground">
                    {stat.items_this_week}
                  </div>
                </div>

                {/* Duplicates */}
                <div className="space-y-1 p-3 rounded bg-muted/30 border border-border/50">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <Copy className="w-3 h-3" />
                    Duplicates
                  </div>
                  <div className="text-2xl font-mono font-semibold text-foreground">
                    {stat.duplicate_rate}<span className="text-sm text-muted-foreground">%</span>
                  </div>
                </div>

                {/* Avg Quality — with color threshold */}
                <div className={`space-y-1 p-3 rounded border ${qConfig.bg} ${qConfig.border}`}>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <TrendingUp className="w-3 h-3" />
                    Avg Quality
                  </div>
                  <div className={`text-2xl font-mono font-semibold ${qConfig.color}`}>
                    {stat.avg_quality_score}
                    <span className="text-[10px] ml-1 font-normal opacity-70">{qConfig.label}</span>
                  </div>
                </div>

                {/* High Quality (>=70) — replaces redundant Last Ping */}
                <div className="space-y-1 p-3 rounded bg-muted/30 border border-border/50">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <Star className="w-3 h-3" />
                    High Quality
                  </div>
                  <div className="text-2xl font-mono font-semibold text-foreground">
                    {stat.high_quality_count}
                    {stat.items_this_week > 0 && (
                      <span className={`text-sm ml-1 ${highQualityPct >= 20 ? 'text-status-success' : highQualityPct >= 5 ? 'text-status-warning' : 'text-destructive'}`}>
                        {highQualityPct}%
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Queue depth row */}
              {counts && (
                <div className="mt-3 pt-3 border-t border-border/50 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Queued</div>
                    <div className={`text-sm font-mono font-semibold ${counts.queued > 0 ? 'text-primary' : 'text-muted-foreground'}`}>
                      {counts.queued}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Approved</div>
                    <div className="text-sm font-mono font-semibold text-status-success">{counts.approved}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Archived</div>
                    <div className="text-sm font-mono font-semibold text-muted-foreground">{counts.archived}</div>
                  </div>
                </div>
              )}

              {/* View Queue link */}
              {counts && counts.queued > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNavigateToQueue(stat.wire)}
                  className="mt-3 w-full gap-1.5 text-primary hover:text-primary/80 hover:bg-primary/5 font-display text-[10px] tracking-wider border border-primary/20 hover:border-primary/40"
                >
                  VIEW {counts.queued} IN QUEUE
                  <ArrowRight className="w-3 h-3" />
                </Button>
              )}
            </div>
          );
        })}

        {/* Daily Digest Email card — always visible in the grid */}
        <DailyDigestCard />
      </div>

      {stats.length === 0 && (
        <div className="glow-card p-12 text-center">
          <span className="text-5xl mx-auto mb-4 block w-fit opacity-50">🛰️</span>
          <p className="text-muted-foreground font-display text-sm tracking-wider">NO SOURCES CONFIGURED</p>
        </div>
      )}
    </div>
  );
}
