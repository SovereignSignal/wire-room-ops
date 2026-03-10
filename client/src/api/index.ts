import { ScanEntry, WireCounts } from '@/types';

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

export async function fetchEntries(params: { status?: string; wire?: string } = {}): Promise<ScanEntry[]> {
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
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
  flagged: 'reviewlater',
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
