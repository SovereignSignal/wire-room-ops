import { useState, useEffect, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { fetchDbConfig, testDbConnection, saveDbConfig as saveDbConfigApi, fetchDbTable, fetchDbStats } from '@/api';
import type { DbScanEntry, DbIntakeRun, DbDistributionEntry, DbStats, DbTableResponse } from '@/types';
import { ChevronDown, ChevronUp, ExternalLink, Database, Download } from 'lucide-react';

type TableName = 'scan-entries' | 'intake-runs' | 'distribution-log' | 'summaries';

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-primary/20 text-primary border-primary/30',
  approved: 'bg-status-success/20 text-status-success border-status-success/30',
  archived: 'bg-muted/50 text-muted-foreground border-border',
  declined: 'bg-muted/50 text-muted-foreground border-border',
  raw: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  duplicate: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  success: 'bg-status-success/20 text-status-success border-status-success/30',
  failed: 'bg-status-danger/20 text-status-danger border-status-danger/30',
  pending: 'bg-muted/50 text-muted-foreground border-border',
};

const WIRE_COLORS: Record<string, string> = {
  crypto: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  ai: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  oss: 'bg-green-500/20 text-green-400 border-green-500/30',
};

function getWireBadgeClass(wire: string): string {
  return WIRE_COLORS[wire] || 'bg-muted/50 text-muted-foreground border-border';
}

function getStatusBadgeClass(status: string): string {
  return STATUS_COLORS[status] || 'bg-muted/50 text-muted-foreground border-border';
}

function QualityCell({ score }: { score: number | null }) {
  if (score == null) return <span className="text-muted-foreground font-mono">—</span>;
  const color = score >= 70 ? 'text-status-success' : score >= 40 ? 'text-yellow-400' : 'text-status-danger';
  return <span className={`font-mono font-semibold ${color}`}>{score}</span>;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function relativeTime(dateStr: string): string {
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true });
  } catch {
    return dateStr;
  }
}

export function DatabaseTab() {
  const { toast } = useToast();
  const [activeTable, setActiveTable] = useState<TableName>('scan-entries');
  const [stats, setStats] = useState<DbStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [tableLoading, setTableLoading] = useState(false);
  const [data, setData] = useState<any[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, totalPages: 0 });

  // Filters
  const [wireFilter, setWireFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // DB connection panel
  const [configOpen, setConfigOpen] = useState(false);
  const [dbConfig, setDbConfig] = useState<{ configured: boolean; host: string | null; database: string | null; source: string } | null>(null);
  const [newDbUrl, setNewDbUrl] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; latencyMs: number; version?: string; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);

  const loadStats = useCallback(async () => {
    try {
      const [s, cfg] = await Promise.all([fetchDbStats(), fetchDbConfig()]);
      setStats(s);
      setDbConfig(cfg);
    } catch (err) {
      console.error('Failed to load DB stats:', err);
      // If stats fail, still try to load config
      try { setDbConfig(await fetchDbConfig()); } catch {}
    }
  }, []);

  const loadTable = useCallback(async (table: TableName, page = 1) => {
    setTableLoading(true);
    try {
      const params: Record<string, string | number> = { page, limit: 50 };
      if (wireFilter) params.wire = wireFilter;
      if (search && (table === 'scan-entries' || table === 'summaries')) params.search = search;
      if (dateFrom && table === 'scan-entries') params.from = dateFrom;
      if (dateTo && table === 'scan-entries') params.to = dateTo;
      if (statusFilter) {
        if (table === 'scan-entries' || table === 'distribution-log' || table === 'summaries') params.status = statusFilter;
      }
      if (channelFilter && table === 'distribution-log') params.channel = channelFilter;

      const result = await fetchDbTable(table, params);
      setData(result.data);
      setPagination(result.pagination);
    } catch (err) {
      console.error(`Failed to load ${table}:`, err);
      toast({ title: 'Error', description: `Failed to load ${table}` });
    } finally {
      setTableLoading(false);
    }
  }, [wireFilter, statusFilter, channelFilter, search, dateFrom, dateTo, toast]);

  // Initial load
  useEffect(() => {
    (async () => {
      await loadStats();
      setLoading(false);
    })();
  }, [loadStats]);

  // Reload table on filter/tab change
  useEffect(() => {
    if (!loading) loadTable(activeTable, 1);
  }, [activeTable, wireFilter, statusFilter, channelFilter, loadTable, loading]);

  const handleSearch = () => {
    loadTable(activeTable, 1);
  };

  const handleTestConnection = async () => {
    if (!newDbUrl.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testDbConnection(newDbUrl.trim());
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, latencyMs: 0, error: 'Request failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!newDbUrl.trim() || !testResult?.success) return;
    setSaving(true);
    try {
      await saveDbConfigApi(newDbUrl.trim());
      toast({ title: 'Saved', description: 'Database connection updated' });
      setShowUrlInput(false);
      setNewDbUrl('');
      setTestResult(null);
      await loadStats();
      loadTable(activeTable, 1);
    } catch (err) {
      toast({ title: 'Error', description: 'Failed to save config' });
    } finally {
      setSaving(false);
    }
  };

  const handleExport = () => {
    const params = new URLSearchParams();
    if (wireFilter) params.set('wire', wireFilter);
    if (statusFilter) params.set('status', statusFilter);
    if (search) params.set('search', search);
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    window.open(`/api/database/export/scan-entries${params.toString() ? '?' + params : ''}`, '_blank');
  };

  // Reset non-common filters on table switch
  const handleTableSwitch = (table: TableName) => {
    setData([]);              // Clear stale data immediately to prevent type mismatch renders
    setTableLoading(true);    // Show skeleton while new data loads
    setActiveTable(table);
    setStatusFilter('');
    setChannelFilter('');
    setSearch('');
    setDateFrom('');
    setDateTo('');
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="stat-card">
              <Skeleton className="h-4 w-24 mb-4" />
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

  // If DB not configured, show setup instructions
  if (dbConfig && !dbConfig.configured) {
    return (
      <div className="space-y-6">
        <div className="glow-card p-12 text-center">
          <Database className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
          <h3 className="font-display text-sm tracking-wider mb-2">NO DATABASE CONFIGURED</h3>
          <p className="text-muted-foreground text-sm mb-6">
            Configure a PostgreSQL connection to introspect your live database.
          </p>
          <div className="max-w-lg mx-auto space-y-3">
            <Input
              placeholder="postgresql://user:pass@host:5432/dbname"
              value={newDbUrl}
              onChange={e => setNewDbUrl(e.target.value)}
              className="font-mono text-sm"
            />
            <div className="flex gap-2 justify-center">
              <Button
                variant="outline"
                onClick={handleTestConnection}
                disabled={testing || !newDbUrl.trim()}
                className="gap-2 font-display text-[10px] tracking-wider border-primary/20 hover:border-primary/40"
              >
                {testing ? 'TESTING...' : 'TEST CONNECTION'}
              </Button>
              <Button
                onClick={handleSaveConfig}
                disabled={saving || !testResult?.success}
                className="gap-2 font-display text-[10px] tracking-wider"
              >
                {saving ? 'SAVING...' : 'SAVE'}
              </Button>
            </div>
            {testResult && (
              <div className={`text-xs font-mono p-3 rounded border ${testResult.success ? 'border-status-success/30 text-status-success bg-status-success/5' : 'border-status-danger/30 text-status-danger bg-status-danger/5'}`}>
                {testResult.success
                  ? `Connected in ${testResult.latencyMs}ms — ${testResult.version?.split(' ').slice(0, 2).join(' ')}`
                  : `Failed: ${testResult.error}`}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const showFrom = (pagination.page - 1) * pagination.limit + 1;
  const showTo = Math.min(pagination.page * pagination.limit, pagination.total);

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="stat-card group">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center text-lg">
              <Database className="w-4 h-4 text-primary" />
            </div>
            <h3 className="font-display font-semibold text-xs tracking-wider uppercase">SCAN ENTRIES</h3>
          </div>
          <div className="text-3xl font-mono font-semibold text-foreground">
            {stats?.scan_entries.total.toLocaleString() ?? '—'}
          </div>
        </div>
        <div className="stat-card group">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded bg-status-success/10 border border-status-success/20 flex items-center justify-center text-lg">
              <span>✅</span>
            </div>
            <h3 className="font-display font-semibold text-xs tracking-wider uppercase">PUBLISHED SUMMARIES</h3>
          </div>
          <div className="text-3xl font-mono font-semibold text-foreground">
            {(stats as any)?.summaries?.total?.toLocaleString() ?? '—'}
          </div>
        </div>
        <div className="stat-card group">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center text-lg">
              <span>📡</span>
            </div>
            <h3 className="font-display font-semibold text-xs tracking-wider uppercase">QUEUE DEPTH</h3>
          </div>
          <div className="text-3xl font-mono font-semibold text-foreground">
            {stats?.scan_entries.queued.toLocaleString() ?? '—'}
          </div>
        </div>
        <div className="stat-card group">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded bg-orange-500/10 border border-orange-500/20 flex items-center justify-center text-lg">
              <span>📥</span>
            </div>
            <h3 className="font-display font-semibold text-xs tracking-wider uppercase">RAW / UNPROCESSED</h3>
          </div>
          <div className="text-3xl font-mono font-semibold text-foreground">
            {stats?.scan_entries.raw.toLocaleString() ?? '—'}
          </div>
        </div>
      </div>

      {/* Table selector */}
      <div className="glow-card overflow-hidden">
        <div className="p-4 border-b border-border bg-card/50 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1">
            {([
              ['scan-entries', 'Scan Entries'],
              ['intake-runs', 'Intake Runs'],
              ['distribution-log', 'Distribution Log'],
              ['summaries', 'Published'],
            ] as [TableName, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => handleTableSwitch(key)}
                className={`px-3 py-1.5 text-[10px] font-display tracking-wider uppercase rounded border transition-colors ${
                  activeTable === key
                    ? 'bg-primary/10 text-primary border-primary/30'
                    : 'text-muted-foreground border-transparent hover:border-border hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {activeTable === 'scan-entries' && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              className="gap-1.5 font-display text-[10px] tracking-wider border-primary/20 hover:border-primary/40"
            >
              <Download className="w-3 h-3" />
              CSV
            </Button>
          )}
        </div>

        {/* Filter bar */}
        <div className="p-4 border-b border-border bg-card/30 flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <label className="text-[10px] font-display tracking-wider uppercase text-muted-foreground">Wire</label>
            <Select value={wireFilter} onValueChange={v => setWireFilter(v === 'all' ? '' : v)}>
              <SelectTrigger className="w-[120px] h-8 text-xs font-mono">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="crypto">crypto</SelectItem>
                <SelectItem value="ai">ai</SelectItem>
                <SelectItem value="oss">oss</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(activeTable === 'scan-entries' || activeTable === 'distribution-log' || activeTable === 'summaries') && (
            <div className="space-y-1">
              <label className="text-[10px] font-display tracking-wider uppercase text-muted-foreground">Status</label>
              <Select value={statusFilter} onValueChange={v => setStatusFilter(v === 'all' ? '' : v)}>
                <SelectTrigger className="w-[120px] h-8 text-xs font-mono">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {activeTable === 'scan-entries' ? (
                    <>
                      <SelectItem value="queued">queued</SelectItem>
                      <SelectItem value="approved">approved</SelectItem>
                      <SelectItem value="archived">archived</SelectItem>
                      <SelectItem value="raw">raw</SelectItem>
                    </>
                  ) : activeTable === 'summaries' ? (
                    <>
                      <SelectItem value="SUCCESS">SUCCESS</SelectItem>
                      <SelectItem value="FAILED">FAILED</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="success">success</SelectItem>
                      <SelectItem value="failed">failed</SelectItem>
                      <SelectItem value="pending">pending</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {activeTable === 'distribution-log' && (
            <div className="space-y-1">
              <label className="text-[10px] font-display tracking-wider uppercase text-muted-foreground">Channel</label>
              <Select value={channelFilter} onValueChange={v => setChannelFilter(v === 'all' ? '' : v)}>
                <SelectTrigger className="w-[120px] h-8 text-xs font-mono">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="telegram">telegram</SelectItem>
                  <SelectItem value="x">x</SelectItem>
                  <SelectItem value="newsletter">newsletter</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {(activeTable === 'scan-entries' || activeTable === 'summaries') && (
            <>
              <div className="space-y-1">
                <label className="text-[10px] font-display tracking-wider uppercase text-muted-foreground">Search</label>
                <div className="flex gap-1.5">
                  <Input
                    placeholder={activeTable === 'summaries' ? 'Title or summary...' : 'Name or description...'}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                    className="w-[200px] h-8 text-xs font-mono"
                  />
                </div>
              </div>
              {activeTable === 'scan-entries' && (
                <>
                  <div className="space-y-1">
                    <label className="text-[10px] font-display tracking-wider uppercase text-muted-foreground">From</label>
                    <Input
                      type="date"
                      value={dateFrom}
                      onChange={e => setDateFrom(e.target.value)}
                      className="w-[140px] h-8 text-xs font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-display tracking-wider uppercase text-muted-foreground">To</label>
                    <Input
                      type="date"
                      value={dateTo}
                      onChange={e => setDateTo(e.target.value)}
                      className="w-[140px] h-8 text-xs font-mono"
                    />
                  </div>
                </>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleSearch}
                className="h-8 font-display text-[10px] tracking-wider border-primary/20 hover:border-primary/40 self-end"
              >
                APPLY
              </Button>
            </>
          )}
        </div>

        {/* Table */}
        <div className="overflow-auto">
          {tableLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : data.length === 0 ? (
            <div className="p-12 text-center">
              <span className="text-4xl block mb-3 opacity-50">📡</span>
              <p className="text-muted-foreground font-display text-sm tracking-wider">No entries match your filters</p>
            </div>
          ) : activeTable === 'scan-entries' ? (
            <ScanEntriesTable data={data as DbScanEntry[]} />
          ) : activeTable === 'intake-runs' ? (
            <IntakeRunsTable data={data as DbIntakeRun[]} />
          ) : activeTable === 'summaries' ? (
            <SummariesTable data={data} />
          ) : (
            <DistributionLogTable data={data as DbDistributionEntry[]} />
          )}
        </div>

        {/* Pagination */}
        {pagination.total > 0 && (
          <div className="p-4 border-t border-border bg-card/30 flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-mono">
              Showing {showFrom}–{showTo} of {pagination.total.toLocaleString()}
            </span>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                disabled={pagination.page <= 1}
                onClick={() => loadTable(activeTable, pagination.page - 1)}
                className="h-7 px-2 text-[10px] font-display tracking-wider"
              >
                PREV
              </Button>
              {getPageNumbers(pagination.page, pagination.totalPages).map((p, i) =>
                p === '...' ? (
                  <span key={`dot-${i}`} className="px-1 text-muted-foreground text-xs self-center">...</span>
                ) : (
                  <Button
                    key={p}
                    variant={p === pagination.page ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => loadTable(activeTable, p as number)}
                    className="h-7 w-7 px-0 text-[10px] font-mono"
                  >
                    {p}
                  </Button>
                )
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => loadTable(activeTable, pagination.page + 1)}
                className="h-7 px-2 text-[10px] font-display tracking-wider"
              >
                NEXT
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* DB Connection panel */}
      <Collapsible open={configOpen} onOpenChange={setConfigOpen}>
        <div className="glow-card overflow-hidden">
          <CollapsibleTrigger asChild>
            <button className="w-full p-4 flex items-center justify-between hover:bg-card/50 transition-colors">
              <div className="flex items-center gap-3">
                <Database className="w-4 h-4 text-muted-foreground" />
                <span className="font-display text-xs tracking-wider uppercase text-muted-foreground">DB CONNECTION</span>
                {dbConfig && (
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {dbConfig.host || 'unknown'} / {dbConfig.database || 'unknown'}
                  </span>
                )}
              </div>
              {configOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
              <div className="grid grid-cols-3 gap-4 text-xs">
                <div>
                  <span className="text-muted-foreground font-display tracking-wider uppercase text-[10px]">Host</span>
                  <p className="font-mono mt-1">{dbConfig?.host || '—'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground font-display tracking-wider uppercase text-[10px]">Database</span>
                  <p className="font-mono mt-1">{dbConfig?.database || '—'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground font-display tracking-wider uppercase text-[10px]">Source</span>
                  <p className="font-mono mt-1">{dbConfig?.source || '—'}</p>
                </div>
              </div>

              {!showUrlInput ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowUrlInput(true)}
                  className="font-display text-[10px] tracking-wider border-primary/20 hover:border-primary/40"
                >
                  CHANGE
                </Button>
              ) : (
                <div className="space-y-3">
                  <Input
                    placeholder="postgresql://user:pass@host:5432/dbname"
                    value={newDbUrl}
                    onChange={e => { setNewDbUrl(e.target.value); setTestResult(null); }}
                    className="font-mono text-sm"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleTestConnection}
                      disabled={testing || !newDbUrl.trim()}
                      className="gap-1.5 font-display text-[10px] tracking-wider border-primary/20 hover:border-primary/40"
                    >
                      {testing ? 'TESTING...' : 'TEST CONNECTION'}
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSaveConfig}
                      disabled={saving || !testResult?.success}
                      className="font-display text-[10px] tracking-wider"
                    >
                      {saving ? 'SAVING...' : 'SAVE'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setShowUrlInput(false); setNewDbUrl(''); setTestResult(null); }}
                      className="font-display text-[10px] tracking-wider text-muted-foreground"
                    >
                      CANCEL
                    </Button>
                  </div>
                  {testResult && (
                    <div className={`text-xs font-mono p-3 rounded border ${testResult.success ? 'border-status-success/30 text-status-success bg-status-success/5' : 'border-status-danger/30 text-status-danger bg-status-danger/5'}`}>
                      {testResult.success
                        ? `Connected in ${testResult.latencyMs}ms — ${testResult.version?.split(' ').slice(0, 2).join(' ')}`
                        : `Failed: ${testResult.error}`}
                    </div>
                  )}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );
}

// --- Sub-table components ---

function ScanEntriesTable({ data }: { data: DbScanEntry[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">NAME</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">WIRE</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">STATUS</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">QUALITY</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">SOURCE</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">DATE</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map(row => (
          <TableRow key={row.id} className="hover:bg-primary/5">
            <TableCell className="max-w-[300px]">
              {row.source_url ? (
                <a
                  href={row.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 flex items-center gap-1.5 group"
                >
                  <span className="truncate">{truncate(row.name, 60)}</span>
                  <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 shrink-0" />
                </a>
              ) : (
                <span className="truncate block">{truncate(row.name, 60)}</span>
              )}
            </TableCell>
            <TableCell>
              <Badge variant="outline" className={`text-[10px] font-display tracking-wider ${getWireBadgeClass(row.wire)}`}>
                {row.wire}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge variant="outline" className={`text-[10px] font-display tracking-wider ${getStatusBadgeClass(row.status)}`}>
                {row.status}
              </Badge>
            </TableCell>
            <TableCell>
              <QualityCell score={row.quality_score} />
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {row.scan_source || '—'}
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
              {relativeTime(row.created_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function IntakeRunsTable({ data }: { data: DbIntakeRun[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">WIRE</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">TOTAL</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">NEW</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">DUPES</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">AVG QUALITY</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">DATE</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map(row => (
          <TableRow key={row.id} className="hover:bg-primary/5">
            <TableCell>
              <Badge variant="outline" className={`text-[10px] font-display tracking-wider ${getWireBadgeClass(row.wire)}`}>
                {row.wire}
              </Badge>
            </TableCell>
            <TableCell className="font-mono text-sm">{(row as any).total_ingested ?? 0}</TableCell>
            <TableCell className="font-mono text-sm">{row.new_unique ?? 0}</TableCell>
            <TableCell className="font-mono text-sm text-muted-foreground">{row.duplicates_found ?? 0}</TableCell>
            <TableCell>
              <QualityCell score={row.avg_quality_score} />
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
              {relativeTime(row.created_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DistributionLogTable({ data }: { data: DbDistributionEntry[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">CHANNEL</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">WIRE</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">STATUS</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">DATE</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map(row => (
          <TableRow key={row.id} className="hover:bg-primary/5">
            <TableCell>
              <Badge variant="outline" className="text-[10px] font-display tracking-wider bg-muted/30">
                {row.channel}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge variant="outline" className={`text-[10px] font-display tracking-wider ${getWireBadgeClass(row.wire)}`}>
                {row.wire}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge variant="outline" className={`text-[10px] font-display tracking-wider ${getStatusBadgeClass(row.status)}`}>
                {row.status}
              </Badge>
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
              {relativeTime(row.created_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function extractSourceUrl(row: any): string | undefined {
  // New pipeline: entities.source_url
  let entities = row.entities || {};
  if (typeof entities === 'string') {
    try { entities = JSON.parse(entities); } catch { entities = {}; }
  }
  if (entities.source_url) return entities.source_url;

  // Legacy pipeline: messages.extracted_urls (JSONB array)
  const urls = row.extracted_urls;
  if (Array.isArray(urls) && urls.length > 0) return urls[0];

  return undefined;
}

function parseEntities(raw: any): { orgs?: string[] } {
  if (!raw) return {};
  let entities = raw;
  if (typeof entities === 'string') {
    try { entities = JSON.parse(entities); } catch { return {}; }
  }
  const orgs = entities.orgs || entities.protocols || [];
  return { orgs: orgs.length > 0 ? orgs : undefined };
}

function SummariesTable({ data }: { data: any[] }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">TITLE</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase w-20">WIRE</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase">SUMMARY</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase w-16">LINK</TableHead>
          <TableHead className="font-display text-[10px] tracking-wider uppercase w-28">DATE</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map(row => {
          const source_url = extractSourceUrl(row);
          const { orgs } = parseEntities(row.entities);
          const isExpanded = expandedId === row.id;
          const summary = row.summary || '—';

          return (
            <TableRow key={row.id} className="hover:bg-primary/5 align-top">
              <TableCell className="max-w-[250px]">
                <div className="font-medium text-sm text-foreground">{row.title || '—'}</div>
                {orgs && orgs.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {orgs.slice(0, 4).map((org: string) => (
                      <span key={org} className="text-[9px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground border border-border font-mono">
                        {org}
                      </span>
                    ))}
                    {orgs.length > 4 && (
                      <span className="text-[9px] text-muted-foreground">+{orgs.length - 4}</span>
                    )}
                  </div>
                )}
              </TableCell>
              <TableCell>
                {row.wire && (
                  <Badge variant="outline" className={`text-[10px] font-display tracking-wider ${getWireBadgeClass(row.wire)}`}>
                    {row.wire}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="max-w-[400px]">
                <div
                  className={`text-xs text-muted-foreground cursor-pointer ${isExpanded ? '' : 'line-clamp-2'}`}
                  onClick={() => setExpandedId(isExpanded ? null : row.id)}
                  title="Click to expand"
                >
                  {summary}
                </div>
              </TableCell>
              <TableCell>
                {source_url ? (
                  <a
                    href={source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:text-primary/80"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                {relativeTime(row.created_at)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// Generate page numbers with ellipsis
function getPageNumbers(current: number, total: number): (number | string)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | string)[] = [1];
  if (current > 3) pages.push('...');
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
    pages.push(i);
  }
  if (current < total - 2) pages.push('...');
  pages.push(total);
  return pages;
}
