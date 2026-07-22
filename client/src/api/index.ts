import { ScanEntry, WireCounts, DbStats, DbTableResponse, ScanPrompt, GrantsIntelSummary, GrantsIntelObservation, EntryDistributionLog } from '@/types';
import { normalizeQualityScore } from '@/lib/dashboard-state';

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

export async function fetchPromptResults(promptId: string, limit = 20): Promise<{ entries: ScanEntry[]; total: number }> {
  const q = new URLSearchParams({ promptId, limit: String(limit), status: 'raw,queued,approved,archived,duplicate,declined' }).toString();
  const res = await authFetch(`${BASE}/scan/entries?${q}`);
  if (!res.ok) throw new Error(`Failed to fetch prompt results: ${res.status}`);
  const data = await res.json();
  return {
    entries: (data.entries || []).map((e: any) => ({
      ...e,
      id: String(e.id),
      wire: e.wire || '',
      quality_score: normalizeQualityScore(e.quality_score),
    })),
    total: data.total || 0,
  };
}

export async function fetchEntries(params: { status?: string; wire?: string; limit?: number; offset?: number; minScore?: number; excludeSources?: string } = {}): Promise<{ entries: ScanEntry[]; total: number }> {
  const effectiveParams = { limit: 100, offset: 0, ...params };
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(effectiveParams).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
  ).toString();
  const res = await authFetch(`${BASE}/scan/entries${q ? "?" + q : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch entries: ${res.status}`);
  const data = await res.json();
  // Existing API returns { entries, total, count }
  return {
    entries: (data.entries || []).map((e: any) => ({
      ...e,
      id: String(e.id),
      wire: e.wire || '',
      quality_score: normalizeQualityScore(e.quality_score),
    })),
    total: Number(data.total) || 0,
  };
}

export async function fetchEntry(id: string): Promise<ScanEntry | null> {
  const res = await authFetch(`${BASE}/scan/entries/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch entry: ${res.status}`);
  const data = await res.json();
  const e = data.entry;
  return { ...e, id: String(e.id), wire: e.wire || '', quality_score: normalizeQualityScore(e.quality_score) };
}

export async function fetchEntryDistribution(id: number | string): Promise<EntryDistributionLog[]> {
  const res = await authFetch(`${BASE}/scan/entries/${encodeURIComponent(id)}/distribution`);
  if (!res.ok) throw new Error(`Failed to fetch entry distribution: ${res.status}`);
  return res.json();
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
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.issues?.join('; ') || body.error || res.status;
    throw new Error(String(detail));
  }
  return res.json();
}

export async function bulkUpdateEntryStatus(ids: (number | string)[], status: string) {
  const action = STATUS_TO_ACTION[status] || status;
  const res = await authFetch(`${BASE}/scan/entries/bulk-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, action }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.issues?.join('; ') || body.error || res.status;
    throw new Error(String(detail));
  }
  return res.json();
}

export async function quietApproveEntry(id: number | string) {
  const res = await authFetch(`${BASE}/scan/entries/${id}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: 'approve', quiet: true }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.issues?.join('; ') || body.error || res.status;
    throw new Error(String(detail));
  }
  return res.json();
}

export async function bulkQuietApprove(ids: (number | string)[]) {
  const res = await authFetch(`${BASE}/scan/entries/bulk-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, action: 'approve', quiet: true }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.issues?.join('; ') || body.error || res.status;
    throw new Error(String(detail));
  }
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

export async function fetchWireCounts(): Promise<WireCounts[]> {
  // Fetch queue depth per wire using /api/scan/status-counts endpoint
  // Called once per wire — aggregate across known wires
  const feeds = await fetchFeeds();
  return Promise.all(
    feeds.map(async (f) => {
      const res = await authFetch(`${BASE}/scan/status-counts?wire=${encodeURIComponent(f.key)}`);
      if (!res.ok) throw new Error(`Failed to fetch ${f.key} status counts: ${res.status}`);
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

export async function fetchGrantsIntelSummary(): Promise<GrantsIntelSummary> {
  const res = await authFetch(`${BASE}/grants-intel/summary`);
  if (!res.ok) throw new Error(`Failed to fetch grants intel summary: ${res.status}`);
  return res.json();
}

export async function fetchGrantsIntelObservations(params: { wire?: string; routing?: string; track?: string; limit?: number; offset?: number } = {}): Promise<{ observations: GrantsIntelObservation[]; count: number; total: number; limit: number; offset: number }> {
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]))
  ).toString();
  const res = await authFetch(`${BASE}/grants-intel/observations${q ? '?' + q : ''}`);
  if (!res.ok) throw new Error(`Failed to fetch grants intel observations: ${res.status}`);
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
  scheduleType?: 'scan-execution' | 'forum-scan' | 'daily-digest' | 'account-monitor' | 'source-feeds';
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

export async function fetchRecentUsage(limit = 20): Promise<any[]> {
  const res = await authFetch(`${BASE}/usage/recent?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to fetch recent usage: ${res.status}`);
  return res.json();
}

// --- Prompt Effectiveness Stats ---

export interface PromptStatsData {
  promptId: string | null;
  wire: string;
  label: string;
  variant: string;
  scanSource: string;
  totalResults: number;
  uniqueResults: number;
  duplicateRate: number;
  avgQualityScore: number;
  highQualityCount: number;
  approvedCount: number;
  declinedCount: number;
  approvalRate: number;
  classificationMix: Record<string, number>;
  publishedAtCoverage: number;
}

export async function fetchPromptStats(days = 21): Promise<{ prompts: PromptStatsData[]; overlapStats: { totalUniqueEntries: number; entriesFoundByMultiple: number; overlapRate: number } }> {
  const res = await authFetch(`${BASE}/scan/prompt-stats?days=${days}`);
  if (!res.ok) throw new Error(`Failed to fetch prompt stats: ${res.status}`);
  return res.json();
}

// --- Scan Prompts API ---

export async function fetchScanPrompts(wire?: string): Promise<ScanPrompt[]> {
  const q = wire ? `?wire=${encodeURIComponent(wire)}` : '';
  const res = await authFetch(`${BASE}/scan/prompts${q}`);
  if (!res.ok) throw new Error(`Failed to fetch scan prompts: ${res.status}`);
  return res.json();
}

export async function createScanPrompt(data: {
  wire: string;
  label: string;
  promptText: string;
  responseFormat?: string;
  toolType?: string;
  variant?: string;
  model?: string;
  outputFormat?: string;
  intent?: string;
  isActive?: boolean;
}): Promise<ScanPrompt> {
  const res = await authFetch(`${BASE}/scan/prompts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create prompt: ${res.status}`);
  }
  return res.json();
}

export async function updateScanPrompt(id: string, data: Partial<{
  wire: string;
  label: string;
  promptText: string;
  responseFormat: string | null;
  toolType: string;
  variant: string | null;
  model: string | null;
  outputFormat: string;
  intent: string;
  isActive: boolean;
}>): Promise<ScanPrompt> {
  const res = await authFetch(`${BASE}/scan/prompts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update prompt: ${res.status}`);
  }
  return res.json();
}

export async function deleteScanPrompt(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/scan/prompts/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete prompt: ${res.status}`);
}

// --- Forum Scan API ---

export async function runForumScan(wire?: string): Promise<{ jobId: string }> {
  const res = await authFetch(`${BASE}/forum/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wire ? { wire } : {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Forum scan failed: ${res.status}`);
  }
  return res.json();
}

export function subscribeToJob(jobId: string, onUpdate: (data: any) => void, onDone: () => void): () => void {
  const es = new EventSource(`${BASE}/job/${jobId}/progress`);
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onUpdate(data);
      if (data.status === 'completed' || data.status === 'failed') {
        es.close();
        onDone();
      }
    } catch { /* ignore parse errors */ }
  };
  es.onerror = () => {
    es.close();
    onDone();
  };
  return () => es.close();
}

export async function runScanPrompt(id: string): Promise<{
  success: boolean;
  parsedCount: number;
  newUnique: number;
  duplicatesFound: number;
  highQualityCount: number;
  model: string;
}> {
  const res = await authFetch(`${BASE}/scan/prompts/${id}/run`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Run failed: ${res.status}`);
  }
  return res.json();
}

// --- Cost Stats API ---

export interface CostStatsByPrompt {
  promptId: string;
  wire: string;
  variant: string;
  label: string;
  toolType: string;
  isActive: boolean;
  totalEntries: number;
  approvedEntries: number;
  approvalRate: number;
  estimatedCost: number;
  costPerApproved: number | null;
}

export interface CostStatsSummary {
  totalCost30d: number;
  scanCost30d: number;
  classifyCost30d: number;
  totalApproved30d: number;
  costPerApproved: number | null;
}

export interface CostStatsResponse {
  summary: CostStatsSummary;
  byPrompt: CostStatsByPrompt[];
}

export async function fetchCostStats(): Promise<CostStatsResponse> {
  const res = await authFetch(`${BASE}/scan/cost-stats`);
  if (!res.ok) throw new Error(`Failed to fetch cost stats: ${res.status}`);
  return res.json();
}
