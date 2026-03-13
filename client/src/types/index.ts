export type EntryStatus = 'queued' | 'approved' | 'archived';

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

export interface ScanPrompt {
  id: string;
  wire: string;
  label: string;
  promptText: string;
  responseFormat: string | null;
  variant: string | null;
  toolType: 'x_search' | 'web_search' | 'perplexity';
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
