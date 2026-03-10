import { ScanEntry, WireCounts, DbStats, DbTableResponse } from '@/types';

const BASE = "/api";

async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 401) {
    // Session expired — redirect to login
    window.location.href = '/';
    throw new Error('Session expired');
  }
  return res;
}

export async function fetchEntries(params: { status?: string; wire?: string; limit?: number } = {}): Promise<ScanEntry[]> {
  const effectiveParams = { limit: 500, ...params };
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(effectiveParams).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
  ).toString();
  const res = await authFetch(`${BASE}/scan/entries${q ? "?" + q : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch entries: ${res.status}`);
  const data = await res.json();
  // Existing API returns { entries, total, count }
  return (data.entries || []).map((e: any) => ({
    ...e,
    id: String(e.id),
    wire: e.wire || '',
    quality_score: Number(e.quality_score) || 0,
  }));
}

// Map our status names to the existing action endpoint verbs
const STATUS_TO_ACTION: Record<string, string> = {
  approved: 'approve',
  archived: 'decline',
  declined: 'decline',

  queued: 'restore',
};

export async function updateEntryStatus(id: number | string, status: string) {
  const action = STATUS_TO_ACTION[status] || status;
  const res = await authFetch(`${BASE}/scan/entries/${id}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error(`Failed to update entry: ${res.status}`);
  return res.json();
}

export async function bulkUpdateEntryStatus(ids: (number | string)[], status: string) {
  const action = STATUS_TO_ACTION[status] || status;
  const res = await authFetch(`${BASE}/scan/entries/bulk-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, action }),
  });
  if (!res.ok) throw new Error(`Failed to bulk update entries: ${res.status}`);
  return res.json();
}

export async function updateEntryWire(id: number | string, wire: string) {
  const res = await authFetch(`${BASE}/scan/entries/${id}/wire`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wire }),
  });
  if (!res.ok) throw new Error(`Failed to update wire: ${res.status}`);
  return res.json();
}

export async function fetchStats() {
  const res = await authFetch(`${BASE}/dashboard/stats`);
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
  return res.json();
}

export async function fetchFeeds(): Promise<{ key: string; displayName: string }[]> {
  const res = await authFetch(`${BASE}/feeds`);
  if (!res.ok) throw new Error(`Failed to fetch feeds: ${res.status}`);
  return res.json();
}

export async function fetchWires(): Promise<{ key: string; displayName: string; color?: string }[]> {
  const res = await authFetch(`${BASE}/wires`);
  if (!res.ok) return []; // fail open — return empty so UI degrades gracefully
  return res.json();
}

export async function classifyQueue(wire?: string): Promise<{ classified: number; errors: number; durationMs: number }> {
  const res = await authFetch(`${BASE}/scan/classify-queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wire ? { wire } : {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchWireCounts(): Promise<WireCounts[]> {
  // Fetch queue depth per wire using existing /api/scan/counts endpoint
  // Called once per wire — aggregate across known wires
  try {
    const feeds = await fetchFeeds();
    const results = await Promise.allSettled(
      feeds.map(async (f) => {
        const res = await authFetch(`${BASE}/scan/counts?wire=${encodeURIComponent(f.key)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return {
          wire: f.key,
          queued: Number(data.counts?.queued) || 0,
          approved: Number(data.counts?.approved) || 0,
          archived: Number(data.counts?.archived) || 0,
          raw: Number(data.counts?.raw) || 0,
        } as WireCounts;
      })
    );
    return results
      .filter((r): r is PromiseFulfilledResult<WireCounts | null> => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value as WireCounts);
  } catch {
    return [];
  }
}

// --- Database introspection API ---

export async function fetchDbConfig(): Promise<{ configured: boolean; host: string | null; database: string | null; source: string }> {
  const res = await authFetch(`${BASE}/database/config`);
  if (!res.ok) throw new Error(`Failed to fetch DB config: ${res.status}`);
  return res.json();
}

export async function testDbConnection(databaseUrl: string): Promise<{ success: boolean; latencyMs: number; version?: string; error?: string }> {
  const res = await authFetch(`${BASE}/database/config/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ databaseUrl }),
  });
  if (!res.ok) throw new Error(`Failed to test connection: ${res.status}`);
  return res.json();
}

export async function saveDbConfig(databaseUrl: string): Promise<any> {
  const res = await authFetch(`${BASE}/database/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ databaseUrl }),
  });
  if (!res.ok) throw new Error(`Failed to save DB config: ${res.status}`);
  return res.json();
}

export async function fetchDbTable<T>(
  table: 'scan-entries' | 'intake-runs' | 'distribution-log' | 'summaries',
  params: Record<string, string | number>
): Promise<DbTableResponse<T>> {
  const q = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => [k, String(v)])
    )
  ).toString();
  const res = await authFetch(`${BASE}/database/${table}${q ? '?' + q : ''}`);
  if (!res.ok) throw new Error(`Failed to fetch ${table}: ${res.status}`);
  return res.json();
}

export async function fetchDbStats(): Promise<DbStats> {
  const res = await authFetch(`${BASE}/database/stats`);
  if (!res.ok) throw new Error(`Failed to fetch DB stats: ${res.status}`);
  return res.json();
}

// --- Schedules API ---

export interface ScheduleResponse {
  id: string;
  name: string;
  enabled: boolean;
  dayOfWeek: number;
  hour: number;
  minute: number;
  lookbackDays: number;
  timezone: string;
  wire?: string;
  scheduleType?: 'scan-execution' | 'forum-scan' | 'daily-digest';
  frequencyHours?: number;
  notifyEmails?: string;
  description?: string;
  nextRun?: string | null;
}

export async function fetchSchedules(): Promise<ScheduleResponse[]> {
  const res = await authFetch(`${BASE}/schedules`);
  if (!res.ok) throw new Error(`Failed to fetch schedules: ${res.status}`);
  const data = await res.json();
  return data.schedules || [];
}

export async function createSchedule(schedule: Partial<Omit<ScheduleResponse, 'id' | 'description' | 'nextRun'>>): Promise<ScheduleResponse> {
  const res = await authFetch(`${BASE}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schedule),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to create schedule: ${res.status}`);
  }
  return res.json();
}

export async function updateSchedule(id: string, updates: Partial<Omit<ScheduleResponse, 'id' | 'description' | 'nextRun'>>): Promise<ScheduleResponse> {
  const res = await authFetch(`${BASE}/schedules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to update schedule: ${res.status}`);
  }
  return res.json();
}
