import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchGrantsIntelObservations, fetchGrantsIntelSummary } from '@/api';
import type { GrantsIntelObservation, GrantsIntelSummary } from '@/types';

const ROUTES = ['wire_queue_candidate', 'daily_brief', 'opportunity_signal', 'raw_only'];

function badgeClass(value: string): string {
  if (value === 'new_to_wire_room') return 'bg-status-success/20 text-status-success border-status-success/30';
  if (value === 'already_in_wire_room') return 'bg-primary/20 text-primary border-primary/30';
  if (value === 'known_grant_archive') return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
  if (value === 'wire_queue_candidate') return 'bg-purple-500/20 text-purple-400 border-purple-500/30';
  if (value === 'daily_brief') return 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30';
  if (value === 'opportunity_signal') return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
  return 'bg-muted/50 text-muted-foreground border-border';
}

function formatDate(value?: string | null): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function amountLabel(item: GrantsIntelObservation): string {
  if (!item.amount || item.amount === '0') return 'unknown';
  return `${item.amount} ${item.currency || ''}`.trim();
}

function StatCard({ label, value, note }: { label: string; value: number | string; note: string }) {
  return (
    <div className="stat-card">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-display">{label}</p>
      <p className="text-3xl font-mono font-semibold text-foreground mt-2">{value}</p>
      <p className="text-xs text-muted-foreground mt-2">{note}</p>
    </div>
  );
}

export function GrantsIntelTab() {
  const [summary, setSummary] = useState<GrantsIntelSummary | null>(null);
  const [observations, setObservations] = useState<GrantsIntelObservation[]>([]);
  const [wire, setWire] = useState('crypto');
  const [routing, setRouting] = useState('wire_queue_candidate');
  const [track, setTrack] = useState('all');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryData, observationData] = await Promise.all([
        fetchGrantsIntelSummary(),
        fetchGrantsIntelObservations({
          wire: wire === 'all' ? undefined : wire,
          routing: routing === 'all' ? undefined : routing,
          track: track === 'all' ? undefined : track,
          limit: 100,
        }),
      ]);
      setSummary(summaryData);
      setObservations(observationData.observations || []);
    } finally {
      setLoading(false);
    }
  }, [routing, track, wire]);

  useEffect(() => {
    load();
  }, [load]);

  const matchCounts = useMemo(() => {
    return observations.reduce<Record<string, number>>((acc, item) => {
      acc[item.match_status] = (acc[item.match_status] || 0) + 1;
      return acc;
    }, {});
  }, [observations]);

  const pillars = summary?.pillars || {
    landscape_observations: 0,
    opportunity_candidates: 0,
    wire_candidates: 0,
    writing_inputs: 0,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-display tracking-wider glow-text">GRANTS INTEL</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Intake view across the four pillars: map, opportunities, Wire routing, and writing inputs.
          </p>
        </div>
        <Button onClick={load} disabled={loading} variant="outline" className="gap-2">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="Landscape map" value={pillars.landscape_observations} note="observations captured" />
        <StatCard label="Opps + network" value={pillars.opportunity_candidates} note="reviewable signals" />
        <StatCard label="Wire candidates" value={pillars.wire_candidates} note="possible queue promos" />
        <StatCard label="Writing inputs" value={pillars.writing_inputs} note="brief/signal material" />
      </div>

      <div className="rounded-lg border border-border bg-card/70 p-4 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-widest text-muted-foreground font-display">Filter</p>
            <p className="text-xs text-muted-foreground">Start with Crypto + Wire candidates to see what is new and useful.</p>
          </div>
          <div className="flex flex-wrap gap-2 md:ml-auto">
            <Select value={wire} onValueChange={setWire}>
              <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All wires</SelectItem>
                <SelectItem value="crypto">Crypto</SelectItem>
                <SelectItem value="ai">AI/ML</SelectItem>
                <SelectItem value="oss">OSS</SelectItem>
              </SelectContent>
            </Select>
            <Select value={routing} onValueChange={setRouting}>
              <SelectTrigger className="w-[210px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All routes</SelectItem>
                {ROUTES.map(route => <SelectItem key={route} value={route}>{route}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={track} onValueChange={setTrack}>
              <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tracks</SelectItem>
                <SelectItem value="A">Track A</SelectItem>
                <SelectItem value="B">Track B</SelectItem>
                <SelectItem value="C">Track C</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <Badge className={badgeClass('new_to_wire_room')}>new: {matchCounts.new_to_wire_room || 0}</Badge>
          <Badge className={badgeClass('already_in_wire_room')}>already in Wire: {matchCounts.already_in_wire_room || 0}</Badge>
          <Badge className={badgeClass('known_grant_archive')}>archive match: {matchCounts.known_grant_archive || 0}</Badge>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card/70 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Known?</TableHead>
              <TableHead>Deadline</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Loading grants intel...</TableCell></TableRow>
            )}
            {!loading && observations.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No observations match this filter.</TableCell></TableRow>
            )}
            {!loading && observations.map(item => {
              const link = item.apply_url || item.url || '';
              return (
                <TableRow key={`${item.id}-${item.dedupe_key}`}>
                  <TableCell className="max-w-[420px]">
                    <div className="space-y-1">
                      <div className="font-medium text-foreground">{item.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {item.organization || 'unknown org'} · {item.wire || 'unknown wire'} · Track {item.track}
                      </div>
                      {link && (
                        <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          Open source <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </TableCell>
                  <TableCell><Badge className={badgeClass(item.routing || '')}>{item.routing || 'raw_only'}</Badge></TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Badge className={badgeClass(item.match_status)}>{item.match_status.replace(/_/g, ' ')}</Badge>
                      {item.matched_scan_entry_name && (
                        <div className="text-[11px] text-muted-foreground">{item.matched_scan_entry_status}: {item.matched_scan_entry_name}</div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{formatDate(item.deadline)}</TableCell>
                  <TableCell className="font-mono text-xs">{amountLabel(item)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.source_name}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
