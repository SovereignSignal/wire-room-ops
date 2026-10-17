import { useState, useEffect, useCallback } from 'react';
import { Clock, Mail, Save, Loader2, TestTube } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { fetchSchedules, updateSchedule, createSchedule, type ScheduleResponse } from '@/api';

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

export function DailyDigestCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [digest, setDigest] = useState<ScheduleResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState(6);
  const [minute, setMinute] = useState(0);
  const [timezone, setTimezone] = useState('America/Los_Angeles');
  const [recipients, setRecipients] = useState('');
  const [dirty, setDirty] = useState(false);
  const [sendingDigest, setSendingDigest] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
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

  const handleSendDigest = async () => {
    setSendingDigest(true);
    try {
      const res = await fetch('/api/digest/send-now', { method: 'POST', credentials: 'include' });
      const data = await res.json() as { success: boolean; skipped?: boolean; message?: string; error?: string; stats?: { pendingReview: number } };
      if (res.ok && data.success) {
        toast({
          title: data.skipped ? 'Digest email skipped' : 'Digest sent',
          description: data.message || `${data.stats?.pendingReview ?? 0} pending items included`,
        });
      } else {
        toast({ title: 'Send failed', description: data.error || 'Unknown error' });
      }
    } catch {
      toast({ title: 'Error', description: 'Could not reach server' });
    } finally {
      setSendingDigest(false);
    }
  };

  const handleTestEmail = async () => {
    setTestingEmail(true);
    try {
      const res = await fetch('/api/test-alert', { method: 'POST', credentials: 'include' });
      const data = await res.json() as { success: boolean; message?: string; error?: string };
      if (res.ok && data.success) {
        toast({ title: 'Test email sent', description: data.message || 'Check your inbox' });
      } else {
        toast({ title: 'Test failed', description: data.error || 'Unknown error' });
      }
    } catch {
      toast({ title: 'Error', description: 'Could not reach server' });
    } finally {
      setTestingEmail(false);
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
            placeholder="you@example.com, ops@example.com"
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
          onClick={handleTestEmail}
          disabled={testingEmail}
          variant="outline"
          size="sm"
          className="gap-1.5 font-display text-[10px] tracking-wider"
          title="Send a test email to verify Resend is working"
        >
          {testingEmail ? <Loader2 className="w-3 h-3 animate-spin" /> : <TestTube className="w-3 h-3" />}
          {testingEmail ? 'TESTING...' : 'TEST EMAIL'}
        </Button>
        <Button
          onClick={handleSendDigest}
          disabled={sendingDigest || dirty}
          variant="outline"
          size="sm"
          className="gap-1.5 font-display text-[10px] tracking-wider"
          title={dirty ? 'Save recipient changes before sending' : 'Send the actual daily digest summary to the saved recipients'}
        >
          {sendingDigest ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
          {sendingDigest ? 'SENDING...' : dirty ? 'SAVE FIRST' : 'SEND NOW'}
        </Button>
      </div>
    </div>
  );
}
