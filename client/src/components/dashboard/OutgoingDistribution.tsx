import { useCallback, useEffect, useState } from 'react';

type OutgoingItem = {
  entryId: number;
  name: string;
  wire: string;
  state: string;
  availableAt: string | null;
  errorMessage: string | null;
  attempts: number | null;
};

type SentItem = {
  entryId: number;
  name: string;
  wire: string;
  externalId: string | null;
  sentAt: string | null;
  claimedAt: string | null;
};

type Snapshot = {
  banner: string;
  note: string;
  counts: {
    scheduled: number;
    due: number;
    sending: number;
    retryWait: number;
    withheld: number;
    needsReview: number;
    missing: number;
    waiting: number;
  };
  items: OutgoingItem[];
  sent: SentItem[];
};

function when(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function Row({ item }: { item: OutgoingItem }) {
  return (
    <li className="border-t border-border py-2">
      <p className="text-sm">
        <span className="font-medium">{item.name}</span>
        <span className="text-muted-foreground"> · #{item.entryId} · {item.wire} · {item.state}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {item.availableAt ? `Scheduled ${when(item.availableAt)}` : item.state === 'withheld' ? 'Will not send' : 'No send time'}
        {item.attempts ? ` · attempt ${item.attempts}` : ''}
      </p>
      {item.errorMessage && <p className="text-xs text-muted-foreground">{item.errorMessage}</p>}
    </li>
  );
}

export function OutgoingDistribution() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/distribution/outgoing');
      if (!res.ok) throw new Error('Could not load the outgoing list');
      setData(await res.json());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the outgoing list');
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  const stream = (data?.items ?? []).filter(item => item.state === 'scheduled' || item.state === 'due' || item.state === 'sending' || item.state === 'retry wait');
  const attention = (data?.items ?? []).filter(item => item.state === 'needs review' || item.state === 'missing');
  const withheld = (data?.items ?? []).filter(item => item.state === 'withheld');

  return (
    <section aria-label="Outgoing distribution" className="border border-border rounded-lg p-4 space-y-4">
      <div>
        <h3 className="font-semibold">Outgoing</h3>
        <p className="text-sm">{data?.banner ?? 'Pacing off — approvals publish immediately'}</p>
        <p className="text-xs text-muted-foreground mt-1">{data?.note ?? 'Loading the publication queue.'}</p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {data && (
        <p className="text-xs text-muted-foreground">
          {data.counts.waiting} waiting · {data.counts.sending} sending · {data.counts.needsReview} need review · {data.counts.missing} missing · {data.counts.withheld} withheld · {data.sent.length} sent in view
        </p>
      )}
      <div>
        <h4 className="text-xs font-display tracking-wider text-muted-foreground">SCHEDULED</h4>
        {stream.length === 0 ? <p className="text-sm text-muted-foreground">Nothing is waiting.</p> : (
          <ul>{stream.map(item => <Row key={`${item.state}-${item.entryId}`} item={item} />)}</ul>
        )}
      </div>
      <div>
        <h4 className="text-xs font-display tracking-wider text-muted-foreground">ATTENTION</h4>
        {attention.length === 0 ? <p className="text-sm text-muted-foreground">Nothing needs attention.</p> : (
          <ul>{attention.map(item => <Row key={`${item.state}-${item.entryId}`} item={item} />)}</ul>
        )}
      </div>
      {withheld.length > 0 && (
        <details>
          <summary className="text-xs font-display tracking-wider text-muted-foreground cursor-pointer">WITHHELD · {withheld.length}</summary>
          <p className="text-xs text-muted-foreground mt-1">Approved, kept off the Telegram wires. These will not send.</p>
          <ul>{withheld.map(item => <Row key={`${item.state}-${item.entryId}`} item={item} />)}</ul>
        </details>
      )}
      <div>
        <h4 className="text-xs font-display tracking-wider text-muted-foreground">SENT</h4>
        {(data?.sent.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">Nothing sent in the last day.</p> : (
          <ul>
            {data?.sent.map(item => (
              <li key={`${item.entryId}-${item.externalId}`} className="border-t border-border py-2 text-sm">
                <span className="font-medium">{item.name}</span>
                <span className="text-muted-foreground"> · #{item.entryId} · {item.wire} · message {item.externalId}</span>
                <p className="text-xs text-muted-foreground">{item.sentAt ? when(item.sentAt) : `Claimed ${when(item.claimedAt)}`}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
