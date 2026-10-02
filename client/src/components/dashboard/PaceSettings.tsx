import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/hooks/use-toast';

type QuietHours = { start: string; end: string } | null;

type Pace = {
  enabled: boolean;
  intervalMinutes: number;
  timezone: string;
  quietHours: QuietHours;
  dailyCap: number | null;
  paused: boolean;
};

type Chat = {
  targetId: string;
  wire: string;
  name: string;
  nextAt: string | null;
  sentToday: number;
};

type Change = {
  at: string;
  actor: string;
  summary: string;
};

type Outgoing = {
  banner: string;
  note: string;
  pace: Pace;
  chats: Chat[];
};

function when(value: string | null, timeZone: string): string {
  if (!value) return 'nothing queued';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'nothing queued';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

async function putPace(body: Record<string, unknown>): Promise<{ pace: Pace; changes: Change[] }> {
  const res = await fetch('/api/distribution/pace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not save pace settings');
  return data;
}

export function PaceSettings() {
  const { toast } = useToast();
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const markDirty = (value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  };
  const [intervalMinutes, setIntervalMinutes] = useState('20');
  const [quietOn, setQuietOn] = useState(true);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('08:00');
  const [dailyCap, setDailyCap] = useState('');

  const applyPace = useCallback((pace: Pace) => {
    setIntervalMinutes(String(pace.intervalMinutes));
    setQuietOn(pace.quietHours !== null);
    setQuietStart(pace.quietHours?.start ?? '22:00');
    setQuietEnd(pace.quietHours?.end ?? '08:00');
    setDailyCap(pace.dailyCap === null ? '' : String(pace.dailyCap));
  }, []);

  const load = useCallback(async () => {
    try {
      const [outgoingRes, paceRes] = await Promise.all([
        fetch('/api/distribution/outgoing'),
        fetch('/api/distribution/pace'),
      ]);
      if (!outgoingRes.ok || !paceRes.ok) throw new Error('Could not load pace settings');
      const outgoingData = await outgoingRes.json() as Outgoing;
      const paceData = await paceRes.json() as { pace: Pace; changes: Change[] };
      setOutgoing({ ...outgoingData, pace: paceData.pace });
      setChanges(Array.isArray(paceData.changes) ? paceData.changes : []);
      setError('');
      if (!dirtyRef.current) applyPace(paceData.pace);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load pace settings');
    }
  }, [applyPace]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, 30000);
    return () => clearInterval(timer);
  }, [load]);

  const pace = outgoing?.pace;
  const savePatch = async (body: Record<string, unknown>, success: string, refreshForm: boolean) => {
    setSaving(true);
    try {
      const saved = await putPace(body);
      setOutgoing(current => current ? { ...current, pace: saved.pace } : current);
      setChanges(saved.changes ?? []);
      if (refreshForm) {
        applyPace(saved.pace);
        markDirty(false);
      }
      setError('');
      toast({ title: 'Saved', description: success });
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save pace settings';
      setError(message);
      toast({ title: 'Not saved', description: message });
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = () => {
    if (!pace || saving) return;
    const turningOn = !pace.enabled;
    const confirmed = window.confirm(turningOn
      ? 'Turn pacing on? New approvals wait their turn instead of posting immediately.'
      : 'Turn pacing off? Approvals will publish immediately again.');
    if (!confirmed) return;
    void savePatch({ enabled: turningOn }, turningOn ? 'Pacing is on.' : 'Pacing is off. Approvals publish immediately.', false);
  };

  const togglePaused = () => {
    if (!pace || saving) return;
    void savePatch(
      { paused: !pace.paused },
      pace.paused ? 'Resumed. One post per chat goes out, then the interval applies.' : 'Paused. Nothing sends until you resume.',
      false,
    );
  };

  const saveSchedule = () => {
    const interval = Number(intervalMinutes);
    if (!Number.isFinite(interval)) {
      setError('Interval must be a number of minutes.');
      return;
    }
    let cap: number | null = null;
    if (dailyCap.trim() !== '') {
      cap = Number(dailyCap);
      if (!Number.isInteger(cap) || cap < 1) {
        setError('Daily cap must be a positive whole number, or left empty.');
        return;
      }
    }
    if (quietOn && (!quietStart || !quietEnd)) {
      setError('Quiet hours need a start and an end, or turn them off.');
      return;
    }
    void savePatch({
      intervalMinutes: interval,
      quietHours: quietOn ? { start: quietStart, end: quietEnd } : null,
      dailyCap: cap,
    }, 'Pace settings saved.', true);
  };

  const zone = pace?.timezone ?? 'America/Los_Angeles';
  const latest = changes[0];

  return (
    <section aria-label="Pacing" className="border border-border rounded-lg p-4 space-y-4">
      <div>
        <h3 className="font-semibold">Pacing</h3>
        <p className="text-sm mt-1">{outgoing?.banner ?? 'Loading the stream.'}</p>
        <p className="text-xs text-muted-foreground mt-1">{outgoing?.note ?? 'Each Telegram chat gets its own line of posts.'}</p>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <div>
        <h4 className="text-xs font-display tracking-wider text-muted-foreground">NEXT SLOT PER CHAT</h4>
        {(outgoing?.chats.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground mt-1">No Telegram chat is configured yet.</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {outgoing?.chats.map(chat => (
              <li key={`${chat.targetId}-${chat.wire}`} className="text-sm border-t border-border pt-2">
                <span className="font-medium">{chat.name || chat.wire}</span>
                <span className="text-muted-foreground"> · {chat.wire}</span>
                <p className="text-xs text-muted-foreground">
                  Next {when(chat.nextAt, zone)}
                  {pace?.dailyCap ? ` · ${chat.sentToday} of ${pace.dailyCap} sent today` : chat.sentToday ? ` · ${chat.sentToday} sent today` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium" id="pace-enabled-label">Enabled</span>
          <button
            type="button"
            aria-labelledby="pace-enabled-label"
            aria-pressed={pace?.enabled === true}
            disabled={!pace || saving}
            onClick={toggleEnabled}
            className={`relative h-11 w-16 shrink-0 rounded-full transition-colors disabled:opacity-50 ${pace?.enabled ? 'bg-primary' : 'bg-muted'}`}
          >
            <span className={`absolute top-1 h-9 w-9 rounded-full bg-white transition-transform ${pace?.enabled ? 'left-6' : 'left-1'}`} />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">Off means Approve to Wires posts right away. On means each post waits for its turn.</p>
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Minutes between posts</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={180}
          value={intervalMinutes}
          onChange={event => { setIntervalMinutes(event.target.value); markDirty(true); }}
          className="w-full min-h-11 px-3 text-base sm:text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
        />
        <span className="block text-xs text-muted-foreground">How long this chat waits after a post before the next one. 20 minutes is the calm default.</span>
      </label>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium" id="pace-quiet-label">Quiet hours</span>
          <button
            type="button"
            aria-labelledby="pace-quiet-label"
            aria-pressed={quietOn}
            onClick={() => { setQuietOn(on => !on); markDirty(true); }}
            className={`relative h-11 w-16 shrink-0 rounded-full transition-colors ${quietOn ? 'bg-primary' : 'bg-muted'}`}
          >
            <span className={`absolute top-1 h-9 w-9 rounded-full bg-white transition-transform ${quietOn ? 'left-6' : 'left-1'}`} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Start</span>
            <input
              type="time"
              value={quietStart}
              disabled={!quietOn}
              onChange={event => { setQuietStart(event.target.value); markDirty(true); }}
              className="w-full min-h-11 px-3 text-base sm:text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none disabled:opacity-50"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">End</span>
            <input
              type="time"
              value={quietEnd}
              disabled={!quietOn}
              onChange={event => { setQuietEnd(event.target.value); markDirty(true); }}
              className="w-full min-h-11 px-3 text-base sm:text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none disabled:opacity-50"
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">Nothing sends between these times ({zone}). Posts due then wait until the end, still spaced out.</p>
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Daily cap per chat</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          placeholder="No cap"
          value={dailyCap}
          onChange={event => { setDailyCap(event.target.value); markDirty(true); }}
          className="w-full min-h-11 px-3 text-base sm:text-sm bg-background border border-border rounded focus:border-primary/50 focus:outline-none"
        />
        <span className="block text-xs text-muted-foreground">Most posts one chat will send in a day. Leave empty for no limit. The rest wait until the next morning.</span>
      </label>

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          type="button"
          onClick={saveSchedule}
          disabled={saving || !dirty}
          className="min-h-11 px-4 text-sm font-medium bg-primary text-primary-foreground rounded disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save schedule'}
        </button>
        <button
          type="button"
          onClick={togglePaused}
          disabled={!pace || saving}
          className="min-h-11 px-4 text-sm font-medium border border-border rounded disabled:opacity-50"
        >
          {pace?.paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">Pause keeps the queue and sends nothing. Resume sends one post per chat, then waits out the interval.</p>

      {latest && (
        <p className="text-xs text-muted-foreground">
          Last change {when(latest.at, zone)} by {latest.actor}: {latest.summary}
        </p>
      )}
    </section>
  );
}
