import { useCallback, useEffect, useState } from 'react';

type Delivery = { id: number; entry_id: number; name: string; wire: string; channel: string; destination: string; external_id: string | null; error_message: string; post_text: string | null };
type Job = { entry_id: number; name: string; error_message: string };
export function PublicationReview() {
  const [items, setItems] = useState<Delivery[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [ids, setIds] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/distribution/review');
      if (!res.ok) throw new Error('Could not load publication review');
      const data = await res.json(); setItems(data.items); setJobs(data.jobs || []); setError('');
    } catch (err) { setError(String(err)); }
  }, []);
  useEffect(() => { void load(); const timer = setInterval(load, 30000); return () => clearInterval(timer); }, [load]);
  async function act(path: string, body: object) {
    setBusy(true);
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save confirmation');
      await load();
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  if (!items.length && !jobs.length && !error) return null;
  return <section aria-label="Publication review" className="border border-amber-500/50 rounded-lg p-4 space-y-4">
    <h3 className="font-semibold">Publication needs attention</h3>
    <p className="text-sm text-muted-foreground">Check the destination before confirming whether a message arrived. Confirming it was not delivered allows a retry.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {items.map(item => <div key={item.id} className="border-t border-border pt-3 space-y-2">
      <p>{item.name} · {item.destination || item.channel} · {item.wire}</p>
      <p className="text-sm text-muted-foreground">{item.error_message}</p>
      {item.post_text && <details><summary>Message to check</summary><pre className="whitespace-pre-wrap text-sm">{item.post_text}</pre></details>}
      <label className="block text-sm">Message ID {item.channel === 'telegram' ? '(required to confirm delivery)' : '(if available)'}
        <input className="block border border-border bg-background rounded p-2" value={ids[item.id] ?? item.external_id ?? ''}
          onChange={event => setIds(previous => ({ ...previous, [item.id]: event.target.value }))} />
      </label>
      <div className="flex gap-4">
        <button className="underline" disabled={busy || (item.channel === 'telegram' && !(ids[item.id] ?? item.external_id)?.trim())}
          onClick={() => act(`/api/distribution/review/${item.id}/resolve`, { delivered: true, externalId: ids[item.id] ?? item.external_id ?? undefined })}>I verified it was delivered</button>
        <button className="underline" disabled={busy}
          onClick={() => act(`/api/distribution/review/${item.id}/resolve`, { delivered: false })}>I verified it was not delivered</button>
      </div>
    </div>)}
    {jobs.map(job => <div key={job.entry_id} className="border-t border-border pt-3">
      <p>{job.name}: {job.error_message}</p>
      <button className="underline" disabled={busy} onClick={() => act(`/api/distribution/queue/${job.entry_id}/retry`, {})}>Retry after checking channel configuration</button>
    </div>)}
  </section>;
}
