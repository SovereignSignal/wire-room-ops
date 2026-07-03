export type EntryStatus = 'queued' | 'approved' | 'archived' | 'declined' | 'duplicate' | 'raw' | 'skipped' | 'deduped';

export type Classification = 'GRANT' | 'EXPIRED' | 'NEWS' | 'NOISE' | 'UNCHECKED';

export interface ScanEntry {
  id: string;
  name: string;
  description: string;
  wire: string; // primary vertical/beat
  wires?: string[]; // all applicable wires (multi-pick)
  quality_score: number;
  amount: string;
  deadline: string;
  deadline_parsed: string | null;
  source_url: string;
  status: EntryStatus;
  created_at: string;
  operator_notes?: string;
  distribution_channels?: string[];
  classification?: Classification;
  classification_reason?: string;
  tags?: string[];
  metadata?: {
    amount?: string;
    deadline?: string;
    eligibility?: string;
    summary?: string;
    operator_route?: 'publish' | 'source_check' | 'park' | 'decline' | 'relationship_signal' | string;
    in_scope?: boolean;
    detected_wire?: string;
    related_source?: {
      relation_type?: 'alternate_source' | 'sibling_track' | string;
      matched_entry_id?: number;
      matched_entry_name?: string;
      matched_source_url?: string | null;
      matched_status?: string | null;
      confidence?: number;
      reason?: string;
    };
    curator?: {
      route?: 'publish' | 'source_check' | 'park' | 'relationship_signal' | 'decline' | string;
      confidence?: 'high' | 'med' | 'low' | string;
      rationale?: string;
      by?: string;
      at?: string;
    };
  };
  source_published_at?: string | null;
  distributable?: boolean;
}

export interface IntakeRun {
  id: string;
  wire: string;
  started_at: string;
  completed_at: string;
  items_ingested: number;
  duplicates_found: number;
  errors: number;
}

export interface DistributionLog {
  id: string;
  entry_id: string;
  channel: string;
  sent_at: string;
  status: 'sent' | 'failed' | 'pending';
}

export interface VerticalStats {
  wire: string;
  last_scan: string;
  items_this_week: number;
  duplicate_rate: number;
  avg_quality_score: number;
  high_quality_count: number;
  scans_run: number;
}

export interface WireCounts {
  wire: string;
  queued: number;
  approved: number;
  archived: number;
  raw: number;
}

export interface FilterState {
  wire: string | null;
  scoreMin: number | null;
  scoreMax: number | null;
  dateStatus: 'all' | 'upcoming' | 'no_date' | 'expired';
}

// Database introspection types
export interface DbScanEntry {
  id: number;
  name: string;
  description: string;
  source_url: string;
  wire: string;
  status: string;
  quality_score: number | null;
  scan_source: string;
  prompt_variant: string | null;
  created_at: string;
  amount: string | null;
  deadline: string | null;
}

export interface DbIntakeRun {
  id: string;
  wire: string;
  total_ingested: number;
  new_unique: number;
  duplicates_found: number;
  avg_quality_score: number | null;
  high_quality_count: number;
  created_at: string;
}

export interface DbDistributionEntry {
  id: string;
  channel: string;
  wire: string;
  status: string;
  post_text: string | null;
  created_at: string;
}

export interface DbTableResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface DbStats {
  scan_entries: { total: number; queued: number; approved: number; archived: number; raw: number };
  intake_runs: { total: number; last_run: string | null };
  distribution_log: { total: number; sent_24h: number };
}

export interface GrantsIntelSourceRun {
  track: 'A' | 'B' | 'C' | string;
  source_name: string;
  status: string;
  runs: number;
  records_normalized: number;
  last_finished: string | null;
}

export interface GrantsIntelRoutingCount {
  track: string;
  routing: string;
  count: number;
}

export interface GrantsIntelPillars {
  landscape_observations: number;
  opportunity_candidates: number;
  wire_candidates: number;
  writing_inputs: number;
}

export interface GrantsIntelSummary {
  sourceRuns: GrantsIntelSourceRun[];
  routingCounts: GrantsIntelRoutingCount[];
  pillars: GrantsIntelPillars;
  recentWire: { wire: string; status: string; count: number }[];
}

export interface GrantsIntelObservation {
  id: number;
  run_id: string;
  track: string;
  source_name: string;
  source_domain: string | null;
  wire: string | null;
  title: string;
  organization: string | null;
  opportunity_type: string | null;
  description: string | null;
  url: string | null;
  apply_url: string | null;
  deadline: string | null;
  amount: string | null;
  currency: string | null;
  ecosystem: string | null;
  status: string | null;
  confidence: string | number | null;
  routing: string | null;
  dedupe_key: string;
  observed_at: string;
  matched_scan_entry_id: number | null;
  matched_scan_entry_name: string | null;
  matched_scan_entry_status: string | null;
  matched_scan_entry_created_at: string | null;
  match_status: 'already_in_wire_room' | 'known_grant_archive' | 'new_to_wire_room';
}

export interface ScanPrompt {
  id: string;
  wire: string;
  label: string;
  promptText: string;
  responseFormat: string | null;
  variant: string | null;
  toolType: 'x_search' | 'web_search' | 'perplexity';
  model: string | null;
  outputFormat: 'text' | 'json';
  intent: 'discovery' | 'canonical' | 'signal';
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}
