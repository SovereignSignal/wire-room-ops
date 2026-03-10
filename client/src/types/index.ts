export type EntryStatus = 'queued' | 'approved' | 'archived' | 'flagged';

export type Classification = 'GRANT' | 'EXPIRED' | 'NEWS' | 'NOISE' | 'UNCHECKED';

export interface ScanEntry {
  id: string;
  name: string;
  description: string;
  wire: string; // vertical/beat
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
  metadata?: {
    amount?: string;
    deadline?: string;
    eligibility?: string;
    summary?: string;
  };
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
