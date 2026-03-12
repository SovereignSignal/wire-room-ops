import { useState, useEffect, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchUsageSummary, fetchRecentUsage, type UsageSummaryRow } from '@/api';

type Period = 1 | 7 | 30;

const PERIODS: { key: Period; label: string }[] = [
  { key: 1, label: '24H' },
  { key: 7, label: '7D' },
  { key: 30, label: '30D' },
];

function fmt(n: number): string {
  return n.toLocaleString();
}

function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function relativeTime(dateStr: string): string {
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: false })
      .replace('about ', '')
      .replace('less than a minute', '<1m')
      .replace(' minutes', 'm')
      .replace(' minute', 'm')
      .replace(' hours', 'h')
      .replace(' hour', 'h')
      .replace(' days', 'd')
      .replace(' day', 'd')
      + ' ago';
  } catch {
    return dateStr;
  }
}

export function UsageTab() {
  const [period, setPeriod] = useState<Period>(7);
  const [summary, setSummary] = useState<UsageSummaryRow[]>([]);
  const [recent, setRecent] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (days: Period) => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([
        fetchUsageSummary({ days }),
        fetchRecentUsage(20),
      ]);
      setSummary(s);
      setRecent(r);
    } catch (err) {
      console.error('Failed to load usage data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [period, load]);

  // Aggregate totals from summary rows
  const totalCalls = summary.reduce((a, r) => a + r.calls, 0);
  const totalCost = summary.reduce((a, r) => a + r.estimated_cost_usd, 0);
  const totalTokens = summary.reduce((a, r) => a + r.tokens_in + r.tokens_out, 0);
  const totalErrors = summary.reduce((a, r) => a + r.errors, 0);
  const errorRate = totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0;

  // Group by provider
  const byProvider = summary.reduce<Record<string, { calls: number; tokens_in: number; tokens_out: number; cost: number; errors: number }>>((acc, r) => {
    const p = r.provider;
    if (!acc[p]) acc[p] = { calls: 0, tokens_in: 0, tokens_out: 0, cost: 0, errors: 0 };
    acc[p].calls += r.calls;
    acc[p].tokens_in += r.tokens_in;
    acc[p].tokens_out += r.tokens_out;
    acc[p].cost += r.estimated_cost_usd;
    acc[p].errors += r.errors;
    return acc;
  }, {});

  // Group by purpose
  const byPurpose = summary.reduce<Record<string, { calls: number; cost: number }>>((acc, r) => {
    const p = r.purpose;
    if (!acc[p]) acc[p] = { calls: 0, cost: 0 };
    acc[p].calls += r.calls;
    acc[p].cost += r.estimated_cost_usd;
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="border border-border rounded-lg bg-card/80 p-4">
              <Skeleton className="h-3 w-20 mb-3" />
              <Skeleton className="h-8 w-16" />
            </div>
          ))}
        </div>
        <div className="glow-card p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full mb-2" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header + period selector */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base sm:text-lg font-display tracking-wider glow-text">API USAGE</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Token consumption, costs, and error rates across providers.
          </p>
        </div>
        <div className="flex gap-1">
          {PERIODS.map(p => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-4 py-2 rounded-lg text-xs font-display tracking-wider border transition-all ${
                period === p.key
                  ? 'bg-primary/10 text-primary border-primary/30 shadow-sm shadow-primary/10'
                  : 'bg-card/50 text-muted-foreground border-border hover:bg-card/80 hover:text-foreground'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="border border-border rounded-lg bg-card/80 p-4">
          <div className="text-[10px] font-display tracking-widest text-muted-foreground mb-1">TOTAL CALLS</div>
          <div className="text-2xl font-display glow-text">{fmt(totalCalls)}</div>
        </div>
        <div className="border border-border rounded-lg bg-card/80 p-4">
          <div className="text-[10px] font-display tracking-widest text-muted-foreground mb-1">ESTIMATED SPEND</div>
          <div className="text-2xl font-display glow-text">{fmtCost(totalCost)}</div>
        </div>
        <div className="border border-border rounded-lg bg-card/80 p-4">
          <div className="text-[10px] font-display tracking-widest text-muted-foreground mb-1">TOTAL TOKENS</div>
          <div className="text-2xl font-display glow-text">{fmt(totalTokens)}</div>
        </div>
        <div className="border border-border rounded-lg bg-card/80 p-4">
          <div className="text-[10px] font-display tracking-widest text-muted-foreground mb-1">ERROR RATE</div>
          <div className="text-2xl font-display glow-text">{fmtPct(errorRate)}</div>
        </div>
      </div>

      {/* Provider breakdown */}
      {Object.keys(byProvider).length > 0 && (
        <div className="glow-card overflow-hidden">
          <div className="p-4 border-b border-border bg-card/50">
            <h3 className="font-display text-xs tracking-wider text-muted-foreground">PROVIDER BREAKDOWN</h3>
          </div>
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase">PROVIDER</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase text-right">CALLS</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase text-right">TOKENS IN</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase text-right">TOKENS OUT</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase text-right">COST</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase text-right">ERROR RATE</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(byProvider)
                  .sort(([, a], [, b]) => b.cost - a.cost)
                  .map(([provider, d]) => (
                    <TableRow key={provider} className="hover:bg-primary/5">
                      <TableCell className="font-mono text-sm">{provider}</TableCell>
                      <TableCell className="font-mono text-sm text-right">{fmt(d.calls)}</TableCell>
                      <TableCell className="font-mono text-sm text-right text-muted-foreground">{fmt(d.tokens_in)}</TableCell>
                      <TableCell className="font-mono text-sm text-right text-muted-foreground">{fmt(d.tokens_out)}</TableCell>
                      <TableCell className="font-mono text-sm text-right">{fmtCost(d.cost)}</TableCell>
                      <TableCell className="font-mono text-sm text-right">
                        {d.calls > 0 ? fmtPct((d.errors / d.calls) * 100) : '0.0%'}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Purpose breakdown */}
      {Object.keys(byPurpose).length > 0 && (
        <div className="glow-card overflow-hidden">
          <div className="p-4 border-b border-border bg-card/50">
            <h3 className="font-display text-xs tracking-wider text-muted-foreground">PURPOSE BREAKDOWN</h3>
          </div>
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase">PURPOSE</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase text-right">CALLS</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase text-right">COST</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(byPurpose)
                  .sort(([, a], [, b]) => b.cost - a.cost)
                  .map(([purpose, d]) => (
                    <TableRow key={purpose} className="hover:bg-primary/5">
                      <TableCell className="font-mono text-sm">{purpose}</TableCell>
                      <TableCell className="font-mono text-sm text-right">{fmt(d.calls)}</TableCell>
                      <TableCell className="font-mono text-sm text-right">{fmtCost(d.cost)}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Recent activity */}
      <div className="glow-card overflow-hidden">
        <div className="p-4 border-b border-border bg-card/50">
          <h3 className="font-display text-xs tracking-wider text-muted-foreground">RECENT ACTIVITY</h3>
        </div>
        <div className="overflow-auto">
          {recent.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-muted-foreground font-display text-sm tracking-wider">NO RECENT API CALLS</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase">TIME</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase">PROVIDER</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase">MODEL</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase">PURPOSE</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase text-right">TOKENS</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase text-right">COST</TableHead>
                  <TableHead className="font-display text-[10px] tracking-wider uppercase text-center">STATUS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((row: any, i: number) => {
                  const tokens = (row.tokens_in || 0) + (row.tokens_out || 0);
                  const isError = row.success === false || !!row.error_message;
                  return (
                    <TableRow key={row.id ?? i} className="hover:bg-primary/5">
                      <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {row.created_at ? relativeTime(row.created_at) : '--'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.provider || '--'}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground max-w-[160px] truncate">
                        {row.model || '--'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.purpose || '--'}</TableCell>
                      <TableCell className="font-mono text-xs text-right text-muted-foreground">
                        {tokens > 0 ? fmt(tokens) : '--'}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-right">
                        {row.estimated_cost_usd != null ? fmtCost(row.estimated_cost_usd) : '--'}
                      </TableCell>
                      <TableCell className="text-center">
                        <span
                          className={`inline-block w-2 h-2 rounded-full ${
                            isError ? 'bg-red-500' : 'bg-emerald-500'
                          }`}
                          title={isError ? (row.error || 'error') : 'success'}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}
