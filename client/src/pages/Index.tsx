import { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '@/components/dashboard/DashboardLayout';
import { OverviewTab } from '@/components/dashboard/OverviewTab';
import { QueueTab } from '@/components/dashboard/QueueTab';

import { DatabaseTab } from '@/components/dashboard/DatabaseTab';
import { ScanPromptsTab } from '@/components/dashboard/ScanPromptsTab';
import { SettingsTab } from '@/components/dashboard/SettingsTab';
// ReviewTab removed — approve/decline now inline in QueueTab
import { Starfield } from '@/components/dashboard/Starfield';
import { EntryDetailsSheet } from '@/components/dashboard/EntryDetailsSheet';
import { fetchEntries, updateEntryStatus, bulkUpdateEntryStatus, quietApproveEntry, bulkQuietApprove, fetchStats, fetchFeeds, fetchWireCounts } from '@/api';
import { ScanEntry, VerticalStats, WireCounts } from '@/types';
import { useToast } from '@/hooks/use-toast';

const Index = () => {
  const [activeTab, setActiveTab] = useState('overview');
  const [queueEntries, setQueueEntries] = useState<ScanEntry[]>([]);
  const [approvedEntries, setApprovedEntries] = useState<ScanEntry[]>([]);
  const [stats, setStats] = useState<VerticalStats[]>([]);
  const [wireCounts, setWireCounts] = useState<WireCounts[]>([]);
  const [verticals, setVerticals] = useState<string[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<ScanEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { toast } = useToast();

  const loadData = useCallback(async () => {
    try {
      const results = await Promise.allSettled([
        fetchEntries({ status: 'queued' }),
        fetchEntries({ status: 'approved' }),
        fetchStats(),
        fetchFeeds(),
        fetchWireCounts(),
      ]);

      const [queuedR, approvedR, statsR, feedsR, wireCountsR] = results;

      // Check if ALL failed (likely auth issue)
      const allFailed = results.every(r => r.status === 'rejected');
      if (allFailed) {
        // Likely session expired — redirect to login
        window.location.href = '/';
        return;
      }

      // Apply successful results, log failures
      if (queuedR.status === 'fulfilled') setQueueEntries(queuedR.value);
      else console.warn('Failed to load queued entries:', queuedR.reason);

      if (approvedR.status === 'fulfilled') setApprovedEntries(approvedR.value);
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

      // Show toast only if some (but not all) failed
      const failedCount = results.filter(r => r.status === 'rejected').length;
      if (failedCount > 0) {
        toast({ title: 'Warning', description: `${failedCount} data source(s) failed to load` });
      }
      setLastUpdated(new Date());
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

  // Auto-refresh queue count every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchEntries({ status: 'queued' })
        .then(entries => {
          setQueueEntries(entries);
          setLastUpdated(new Date());
        })
        .catch(() => {/* silent — stale data is fine */});
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

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
        onTabChange={setActiveTab}
        queueCount={queueEntries.length}
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        onRefresh={handleRefresh}
      >
        {activeTab === 'scans' && (
          <ScanPromptsTab verticals={verticals} />
        )}
        {activeTab === 'overview' && (
          <OverviewTab
            queueEntries={queueEntries}
            publishedEntries={approvedEntries}
            rawCount={wireCounts.reduce((sum, wc) => sum + wc.raw, 0)}
            stats={stats}
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
            onRefresh={loadData}
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
            onNavigateToQueue={(wire) => {
              setActiveTab('queue');
            }}
          />
        )}
      </DashboardLayout>

      <EntryDetailsSheet
        entry={selectedEntry}
        onClose={() => setSelectedEntry(null)}
      />
    </>
  );
};

export default Index;
