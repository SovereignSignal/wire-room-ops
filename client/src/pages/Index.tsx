import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '@/components/dashboard/DashboardLayout';
import { OverviewTab } from '@/components/dashboard/OverviewTab';
import { QueueTab } from '@/components/dashboard/QueueTab';
// ReviewTab removed — approve/decline now inline in QueueTab
import { Starfield } from '@/components/dashboard/Starfield';
import { EntryDetailsSheet } from '@/components/dashboard/EntryDetailsSheet';
import { fetchEntries, fetchEntry, updateEntryStatus, bulkUpdateEntryStatus, quietApproveEntry, bulkQuietApprove, fetchStats, fetchFeeds, fetchWireCounts } from '@/api';
import { DashboardDataAvailability, ScanEntry, VerticalStats, WireCounts } from '@/types';
import { useToast } from '@/hooks/use-toast';
import { dashboardPathForTab, dashboardTabFromPath, deriveDashboardHealth, type DashboardHealth } from '@/lib/dashboard-state';

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

const Index = () => {
  const [activeTab, setActiveTab] = useState(() => dashboardTabFromPath(window.location.pathname));
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
  const { toast } = useToast();

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    const nextPath = dashboardPathForTab(tab);
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, '', nextPath);
    }
  }, []);

  useEffect(() => {
    const handlePopState = () => setActiveTab(dashboardTabFromPath(window.location.pathname));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Digest-email deep link: /queue?entry=<id> opens the entry's details sheet.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const entryId = params.get('entry');
    if (!entryId) return;
    handleTabChange('queue');
    fetchEntry(entryId)
      .then(entry => { if (entry) setSelectedEntry(entry); })
      .catch(() => { /* deep link is best-effort; the queue still shows */ });
  }, [handleTabChange]);

  const loadData = useCallback(async () => {
    try {
      const results = await Promise.allSettled([
        fetchEntries({ status: 'queued', limit: QUEUE_PAGE_SIZE, offset: 0 }),
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

      // Apply successful results, log failures
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
  }, [toast]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
  }, [loadData]);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh the WHOLE dashboard every 60 seconds (not just the queue) so the
  // Approved / Ingested / Avg-Quality cards don't sit stale between manual reloads.
  useEffect(() => {
    const interval = setInterval(() => {
      loadData().catch(() => {/* silent — stale data is fine */});
    }, 60_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleUpdateStatus = async (ids: string[], newStatus: ScanEntry['status']) => {
    try {
      if (ids.length === 1) {
        await updateEntryStatus(ids[0], newStatus);
      } else {
        await bulkUpdateEntryStatus(ids, newStatus);
      }
      toast({
        title: `${ids.length} item${ids.length > 1 ? 's' : ''} ${newStatus}`,
        description: `Successfully updated status to ${newStatus}`,
      });
      await loadData();
    } catch (err) {
      console.error('Failed to update status:', err);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast({ title: 'Action blocked', description: msg });
    }
  };

  const handleQuietApprove = async (ids: string[]) => {
    try {
      if (ids.length === 1) {
        await quietApproveEntry(ids[0]);
      } else {
        await bulkQuietApprove(ids);
      }
      toast({
        title: `${ids.length} item${ids.length > 1 ? 's' : ''} quietly approved`,
        description: 'Added to database without distribution',
      });
      await loadData();
    } catch (err) {
      console.error('Failed to quiet approve:', err);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast({ title: 'Approval blocked', description: msg });
    }
  };

  const handleLoadMoreQueue = async () => {
    if (loadingMoreQueue || queueEntries.length >= queueTotal) return;
    setLoadingMoreQueue(true);
    try {
      const page = await fetchEntries({
        status: 'queued',
        limit: QUEUE_PAGE_SIZE,
        offset: queueEntries.length,
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
          {activeTab === 'queue' && (
            <QueueTab
              entries={queueEntries}
              verticals={verticals}
              onUpdateStatus={handleUpdateStatus}
              onViewDetails={setSelectedEntry}
              onSingleAction={(id, status) => handleUpdateStatus([id], status)}
              onQuietApprove={handleQuietApprove}
              onEntryUpdated={(id, updates) => {
                setQueueEntries(prev => prev.map(e => e.id === id ? { ...e, ...updates } : e));
              }}
              total={queueTotal}
              loadingMore={loadingMoreQueue}
              onLoadMore={handleLoadMoreQueue}
            />
          )}
          {activeTab === 'database' && (
            <DatabaseTab />
          )}
          {activeTab === 'settings' && (
            <SettingsTab
              verticals={verticals}
              stats={stats}
              wireCounts={wireCounts}
              onNavigateToQueue={() => {
                handleTabChange('queue');
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
        onClose={() => {
          setSelectedEntry(null);
          if (window.location.search.includes('entry=')) {
            window.history.replaceState(null, '', window.location.pathname);
          }
        }}
      />
    </>
  );
};

export default Index;
