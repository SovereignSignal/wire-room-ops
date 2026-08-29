import { lazy, Suspense, useState, useEffect, useCallback, useMemo } from 'react';
import { DashboardLayout } from '@/components/dashboard/DashboardLayout';
import { OverviewTab } from '@/components/dashboard/OverviewTab';
import { QueueTab } from '@/components/dashboard/QueueTab';
import { Starfield } from '@/components/dashboard/Starfield';
import { EntryDetailsSheet } from '@/components/dashboard/EntryDetailsSheet';
import { DecisionConfirmDialog } from '@/components/dashboard/DecisionConfirmDialog';
import {
  fetchEntries,
  fetchEntry,
  updateEntryStatus,
  bulkUpdateEntryStatus,
  quietApproveEntry,
  bulkQuietApprove,
  fetchStats,
  fetchFeeds,
  fetchWireCounts,
  EntryActionBlockedError,
} from '@/api';
import { DashboardDataAvailability, ScanEntry, VerticalStats, WireCounts } from '@/types';
import { useToast } from '@/hooks/use-toast';
import { dashboardPathForTab, dashboardTabFromPath, deriveDashboardHealth, type DashboardHealth } from '@/lib/dashboard-state';
import {
  emptyQueueFilters,
  parseQueueSearch,
  queueFiltersEqual,
  queueFiltersToApi,
  serializeQueueSearch,
  type QueueQueryFilters,
} from '@/lib/queue-filters';
import { getQueueDecision, type QueueDecisionKey } from '@/components/dashboard/queue-decisions';

const DatabaseTab = lazy(() => import('@/components/dashboard/DatabaseTab').then(module => ({ default: module.DatabaseTab })));
const ScanPromptsTab = lazy(() => import('@/components/dashboard/ScanPromptsTab').then(module => ({ default: module.ScanPromptsTab })));
const SettingsTab = lazy(() => import('@/components/dashboard/SettingsTab').then(module => ({ default: module.SettingsTab })));
const GrantsIntelTab = lazy(() => import('@/components/dashboard/GrantsIntelTab').then(module => ({ default: module.GrantsIntelTab })));

const initialAvailability: DashboardDataAvailability = {
  queuedEntries: false,
  approvedEntries: false,
  stats: false,
  feeds: false,
  wireCounts: false,
};
const QUEUE_PAGE_SIZE = 100;

type PendingDecision = {
  kind: QueueDecisionKey;
  ids: string[];
  issues?: string[];
};

function queueHref(filters: QueueQueryFilters): string {
  return `/queue${serializeQueueSearch(filters)}`;
}

const Index = () => {
  const [activeTab, setActiveTab] = useState(() => dashboardTabFromPath(window.location.pathname));
  const [queueFilters, setQueueFilters] = useState<QueueQueryFilters>(() => (
    dashboardTabFromPath(window.location.pathname) === 'queue'
      ? parseQueueSearch(window.location.search)
      : emptyQueueFilters()
  ));
  const [queueEntries, setQueueEntries] = useState<ScanEntry[]>([]);
  const [approvedEntries, setApprovedEntries] = useState<ScanEntry[]>([]);
  const [stats, setStats] = useState<VerticalStats[]>([]);
  const [wireCounts, setWireCounts] = useState<WireCounts[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [verticals, setVerticals] = useState<string[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<ScanEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [health, setHealth] = useState<DashboardHealth>('offline');
  const [availability, setAvailability] = useState<DashboardDataAvailability>(initialAvailability);
  const [loadingMoreQueue, setLoadingMoreQueue] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const { toast } = useToast();
  const queueQuery = useMemo(() => queueFiltersToApi(queueFilters), [queueFilters]);

  const syncQueueUrl = useCallback((filters: QueueQueryFilters) => {
    const next = queueHref(filters);
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState(null, '', next);
    }
  }, []);

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    if (tab === 'queue') {
      const next = queueHref(queueFilters);
      if (`${window.location.pathname}${window.location.search}` !== next) {
        window.history.pushState(null, '', next);
      }
      return;
    }
    const nextPath = dashboardPathForTab(tab);
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, '', nextPath);
    }
  }, [queueFilters]);

  const handleQueueFiltersChange = useCallback((next: QueueQueryFilters) => {
    setQueueFilters(current => queueFiltersEqual(current, next) ? current : next);
    if (dashboardTabFromPath(window.location.pathname) === 'queue') {
      syncQueueUrl(next);
    }
  }, [syncQueueUrl]);

  useEffect(() => {
    const handlePopState = () => {
      const tab = dashboardTabFromPath(window.location.pathname);
      setActiveTab(tab);
      if (tab === 'queue') {
        setQueueFilters(parseQueueSearch(window.location.search));
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const entryId = queueFilters.entryId;
    if (!entryId) {
      setSelectedEntry(null);
      return;
    }
    const alreadyOpen = selectedEntry?.id === entryId;
    if (alreadyOpen) return;
    fetchEntry(entryId)
      .then(entry => { if (entry) setSelectedEntry(entry); })
      .catch(() => { /* deep link is best-effort; the queue still shows */ });
  }, [queueFilters.entryId, selectedEntry?.id]);

  const loadData = useCallback(async () => {
    try {
      const results = await Promise.allSettled([
        fetchEntries({ status: 'queued', limit: QUEUE_PAGE_SIZE, offset: 0, ...queueQuery }),
        fetchEntries({ status: 'approved', limit: 500, offset: 0 }),
        fetchStats(),
        fetchFeeds(),
        fetchWireCounts(),
      ]);

      const [queuedR, approvedR, statsR, feedsR, wireCountsR] = results;
      const nextHealth = deriveDashboardHealth(results);
      setHealth(nextHealth);
      setAvailability(current => ({
        queuedEntries: current.queuedEntries || queuedR.status === 'fulfilled',
        approvedEntries: current.approvedEntries || approvedR.status === 'fulfilled',
        stats: current.stats || statsR.status === 'fulfilled',
        feeds: current.feeds || feedsR.status === 'fulfilled',
        wireCounts: current.wireCounts || wireCountsR.status === 'fulfilled',
      }));

      if (queuedR.status === 'fulfilled') {
        setQueueEntries(queuedR.value.entries);
        setQueueTotal(queuedR.value.total);
      }
      else console.warn('Failed to load queued entries:', queuedR.reason);

      if (approvedR.status === 'fulfilled') {
        setApprovedEntries(approvedR.value.entries);
      }
      else console.warn('Failed to load approved entries:', approvedR.reason);

      if (feedsR.status === 'fulfilled') {
        setVerticals(feedsR.value.map((f: { key: string }) => f.key));
      } else {
        console.warn('Failed to load feeds:', feedsR.reason);
      }

      if (wireCountsR.status === 'fulfilled') {
        setWireCounts(wireCountsR.value);
      } else {
        console.warn('Failed to load wire counts:', wireCountsR.reason);
      }

      if (statsR.status === 'fulfilled') {
        const statsData = statsR.value;
        const verticalStats: VerticalStats[] = (statsData.intake || []).filter((r: any) => r.wire).map((r: any) => ({
          wire: r.wire,
          last_scan: r.last_scan || new Date().toISOString(),
          items_this_week: Number(r.items_this_week) || 0,
          duplicate_rate: r.items_this_week > 0
            ? Math.round((Number(r.duplicates_found) / (Number(r.items_this_week) + Number(r.duplicates_found))) * 100)
            : 0,
          avg_quality_score: Number(r.avg_quality_score) || 0,
          high_quality_count: Number(r.high_quality_count) || 0,
          scans_run: Number(r.scans_run) || 0,
        }));
        setStats(verticalStats);
      } else {
        console.warn('Failed to load stats:', statsR.reason);
      }

      const failedCount = results.filter(r => r.status === 'rejected').length;
      if (nextHealth === 'offline') {
        toast({ title: 'Dashboard offline', description: 'No dashboard data sources responded' });
      } else if (failedCount > 0) {
        toast({ title: 'Dashboard degraded', description: `${failedCount} data source(s) failed to load` });
      }
      if (nextHealth !== 'offline') setLastUpdated(new Date());
    } catch (err) {
      console.error('Failed to load data:', err);
      toast({ title: 'Error', description: 'Failed to load dashboard data' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast, queueQuery]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
  }, [loadData]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const interval = setInterval(() => {
      loadData().catch(() => {/* silent — stale data is fine */});
    }, 60_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const closeSelectedEntry = useCallback(() => {
    setSelectedEntry(null);
    handleQueueFiltersChange({ ...queueFilters, entryId: null });
  }, [handleQueueFiltersChange, queueFilters]);

  const executeDecision = useCallback(async (pending: PendingDecision, force = false) => {
    const { kind, ids } = pending;
    setDecisionBusy(true);
    try {
      if (kind === 'programs') {
        if (ids.length === 1) await quietApproveEntry(ids[0], { force });
        else await bulkQuietApprove(ids, { force });
        toast({
          title: `Approved to Programs: ${ids.length} item${ids.length > 1 ? 's' : ''}`,
          description: 'Stored without Wire distribution',
        });
      } else {
        const status = kind === 'reject' ? 'declined' : 'approved';
        if (ids.length === 1) await updateEntryStatus(ids[0], status, { force });
        else await bulkUpdateEntryStatus(ids, status, { force });
        toast({
          title: `${ids.length} item${ids.length > 1 ? 's' : ''} ${status}`,
          description: kind === 'wires' ? 'Publishing to selected wires' : `Successfully updated status to ${status}`,
        });
      }
      setPendingDecision(null);
      if (selectedEntry && ids.includes(selectedEntry.id)) closeSelectedEntry();
      await loadData();
    } catch (err) {
      console.error('Failed to update status:', err);
      if (err instanceof EntryActionBlockedError && kind !== 'reject') {
        setPendingDecision({ ...pending, issues: err.issues.length ? err.issues : [err.message] });
        return;
      }
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast({ title: kind === 'programs' ? 'Program approval blocked' : 'Action blocked', description: msg });
    } finally {
      setDecisionBusy(false);
    }
  }, [closeSelectedEntry, loadData, selectedEntry, toast]);

  const requestDecision = useCallback((kind: QueueDecisionKey, ids: string[]) => {
    if (ids.length === 0) return;
    if (kind === 'reject' && ids.length === 1) {
      void executeDecision({ kind, ids });
      return;
    }
    setPendingDecision({ kind, ids });
  }, [executeDecision]);

  const handleUpdateStatus = (ids: string[], newStatus: ScanEntry['status']) => {
    if (newStatus === 'approved') requestDecision('wires', ids);
    else if (newStatus === 'declined') requestDecision('reject', ids);
    else void executeDecision({ kind: 'reject', ids });
  };

  const handleApproveToPrograms = (ids: string[]) => {
    requestDecision('programs', ids);
  };

  const handleLoadMoreQueue = async () => {
    if (loadingMoreQueue || queueEntries.length >= queueTotal) return;
    setLoadingMoreQueue(true);
    try {
      const page = await fetchEntries({
        status: 'queued',
        limit: QUEUE_PAGE_SIZE,
        offset: queueEntries.length,
        ...queueQuery,
      });
      setQueueEntries(current => {
        const existing = new Set(current.map(entry => entry.id));
        return [...current, ...page.entries.filter(entry => !existing.has(entry.id))];
      });
      setQueueTotal(page.total);
    } catch (err) {
      console.error('Failed to load more queue entries:', err);
      toast({ title: 'Queue load failed', description: 'Could not load the next queue page' });
    } finally {
      setLoadingMoreQueue(false);
    }
  };

  const pendingNames = pendingDecision
    ? queueEntries.filter(entry => pendingDecision.ids.includes(entry.id)).map(entry => entry.name)
    : [];
  const pendingMeta = pendingDecision ? getQueueDecision(pendingDecision.kind) : null;

  if (loading) {
    return (
      <>
        <Starfield />
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center space-y-4">
            <div className="text-4xl animate-pulse">📡</div>
            <p className="font-display text-sm tracking-wider text-muted-foreground">
              ESTABLISHING CONNECTION...
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Starfield />
      <DashboardLayout
        activeTab={activeTab}
        onTabChange={handleTabChange}
        queueCount={availability.queuedEntries ? queueTotal : 0}
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        onRefresh={handleRefresh}
        health={health}
      >
        <Suspense fallback={<div className="glow-card p-8 text-center text-sm font-display tracking-wider text-muted-foreground">LOADING MODULE...</div>}>
          {activeTab === 'scans' && (
            <ScanPromptsTab verticals={verticals} />
          )}
          {activeTab === 'overview' && (
            <OverviewTab
              queueEntries={queueEntries}
              publishedEntries={approvedEntries}
              queuedCount={wireCounts.reduce((sum, wc) => sum + wc.queued, 0)}
              approvedCount={wireCounts.reduce((sum, wc) => sum + wc.approved, 0)}
              totalWires={wireCounts.length}
              rawCount={wireCounts.reduce((sum, wc) => sum + wc.raw, 0)}
              stats={stats}
              availability={availability}
            />
          )}
          <div hidden={activeTab !== 'queue'}>
            <QueueTab
              entries={queueEntries}
              filters={queueFilters}
              onFiltersChange={handleQueueFiltersChange}
              onUpdateStatus={handleUpdateStatus}
              onViewDetails={(entry) => {
                setSelectedEntry(entry);
                handleQueueFiltersChange({ ...queueFilters, entryId: entry.id });
              }}
              onSingleAction={(id, status) => handleUpdateStatus([id], status)}
              onApproveToPrograms={handleApproveToPrograms}
              onEntryUpdated={(id, updates) => {
                setQueueEntries(prev => prev.map(e => e.id === id ? { ...e, ...updates } : e));
              }}
              total={queueTotal}
              loadingMore={loadingMoreQueue}
              onLoadMore={handleLoadMoreQueue}
            />
          </div>
          {activeTab === 'database' && (
            <DatabaseTab />
          )}
          {activeTab === 'settings' && (
            <SettingsTab
              verticals={verticals}
              stats={stats}
              wireCounts={wireCounts}
              onNavigateToQueue={(wire) => {
                const next = { ...queueFilters, wire, entryId: null };
                setQueueFilters(next);
                setActiveTab('queue');
                window.history.pushState(null, '', queueHref(next));
              }}
            />
          )}
          {activeTab === 'grants-intel' && (
            <GrantsIntelTab />
          )}
        </Suspense>
      </DashboardLayout>

      <EntryDetailsSheet
        entry={selectedEntry}
        onClose={closeSelectedEntry}
        onApproveToWires={(id) => requestDecision('wires', [id])}
        onApproveToPrograms={(id) => requestDecision('programs', [id])}
        onReject={(id) => requestDecision('reject', [id])}
      />

      <DecisionConfirmDialog
        open={!!pendingDecision}
        title={pendingDecision?.issues?.length
          ? 'Approval blocked'
          : pendingMeta?.label || 'Confirm'}
        description={pendingDecision?.issues?.length
          ? 'The approval guard blocked this publish. Review the issues, then approve anyway only if you still want it live.'
          : pendingDecision?.kind === 'wires'
            ? 'This publishes to Telegram immediately.'
            : pendingDecision?.kind === 'programs'
              ? 'Store these items without wire distribution.'
              : 'Reject these items and keep the reviewed decision for duplicate checks.'}
        confirmLabel={pendingMeta?.label || 'Confirm'}
        tone={pendingMeta?.tone || 'warning'}
        count={pendingDecision?.ids.length || 0}
        names={pendingNames}
        issues={pendingDecision?.issues}
        forceLabel={pendingDecision?.issues?.length ? 'Approve anyway' : undefined}
        busy={decisionBusy}
        onConfirm={() => pendingDecision && void executeDecision(pendingDecision)}
        onForce={pendingDecision?.issues?.length
          ? () => pendingDecision && void executeDecision(pendingDecision, true)
          : undefined}
        onCancel={() => !decisionBusy && setPendingDecision(null)}
      />
    </>
  );
};

export default Index;
