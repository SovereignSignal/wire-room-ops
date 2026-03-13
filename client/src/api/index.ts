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

export async function updateEntryWires(id: number | string, wires: string[]) {
  const res = await authFetch(`${BASE}/scan/entries/${id}/wire`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wires }),
  });
  if (!res.ok) throw new Error(`Failed to update wires: ${res.status}`);
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
  const data = await res.json();
  // Normalize: API may return { wire } or { key } depending on version
  return data.map((w: any) => ({
    key: w.key || w.wire,
    displayName: w.displayName || w.key || w.wire,
    color: w.color,
  }));
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

// --- API Providers ---

export interface ProviderResponse {
  provider: string;
  display_name: string;
  api_key: string; // masked
  base_url: string | null;
  default_model: string | null;
  enabled: boolean;
  source: 'db' | 'env';
}

export async function fetchProviders(): Promise<ProviderResponse[]> {
  const res = await authFetch(`${BASE}/providers`);
  if (!res.ok) throw new Error(`Failed to fetch providers: ${res.status}`);
  return res.json();
}

export async function updateProvider(provider: string, data: {
  api_key?: string;
  base_url?: string | null;
  default_model?: string | null;
  enabled?: boolean;
}): Promise<ProviderResponse> {
  const res = await authFetch(`${BASE}/providers/${provider}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update provider: ${res.status}`);
  }
  return res.json();
}

export async function testProvider(provider: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  const res = await authFetch(`${BASE}/providers/${provider}/test`, { method: 'POST' });
  if (!res.ok) throw new Error(`Test request failed: ${res.status}`);
  return res.json();
}

// --- Models ---

export interface ModelInfo {
  id: string;
  displayName: string;
  created: string;
  provider: string;
}

export async function fetchModels(): Promise<Record<string, ModelInfo[]>> {
  const res = await authFetch(`${BASE}/models`);
  if (!res.ok) throw new Error(`Failed to fetch models`);
  return res.json();
}

// --- API Usage ---

export interface UsageSummaryRow {
  provider: string;
  purpose: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
  errors: number;
}

export async function fetchUsageSummary(params: { days?: number; provider?: string; purpose?: string; wire?: string } = {}): Promise<UsageSummaryRow[]> {
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
  ).toString();
  const res = await authFetch(`${BASE}/usage/summary${q ? '?' + q : ''}`);
  if (!res.ok) throw new Error(`Failed to fetch usage: ${res.status}`);
  return res.json();
}

export async function fetchUsageTimeline(params: { days?: number; provider?: string; granularity?: string } = {}): Promise<any[]> {
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
  ).toString();
  const res = await authFetch(`${BASE}/usage/timeline${q ? '?' + q : ''}`);
  if (!res.ok) throw new Error(`Failed to fetch timeline: ${res.status}`);
  return res.json();
}

export async function fetchRecentUsage(limit = 20): Promise<any[]> {
  const res = await authFetch(`${BASE}/usage/recent?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to fetch recent usage: ${res.status}`);
  return res.json();
}

// --- Model Pricing ---

export interface ModelPricingRow {
  id: number;
  provider: string;
  model: string;
  input_cost_per_1m: number;
  output_cost_per_1m: number;
  per_request_cost: number | null;
  updated_at: string;
}

export async function fetchModelPricing(): Promise<ModelPricingRow[]> {
  const res = await authFetch(`${BASE}/pricing`);
  if (!res.ok) throw new Error(`Failed to fetch pricing: ${res.status}`);
  return res.json();
}

export async function updateModelPricing(provider: string, model: string, data: {
  input_cost_per_1m?: number;
  output_cost_per_1m?: number;
  per_request_cost?: number | null;
}): Promise<ModelPricingRow> {
  const res = await authFetch(`${BASE}/pricing/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to update pricing: ${res.status}`);
  return res.json();
}
