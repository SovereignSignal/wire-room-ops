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
  model: string | null;
  outputFormat: 'text' | 'json';
  intent: 'discovery' | 'canonical' | 'signal';
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

// --- AutoResearch / Experiment types ---

export interface ScoringParams {
  w_amount: number;
  w_deadline: number;
  w_funding_type: number;
  w_actionability: number;
  w_vagueness: number;
  w_governance: number;
  w_awarded: number;
  w_small_amount: number;
  w_expired: number;
  [key: string]: number;
}

export interface ParamMutation {
  param: string;
  from: number;
  to: number;
}

export type ExperimentDecision = 'keep' | 'rollback' | 'extend' | 'active' | 'pending';

export interface ExperimentResults {
  approval_rate: number;
  engagement_rate: number;
  editorial_efficiency: number;
  composite_score: number;
  entry_count: number;
}

export interface ScoringExperiment {
  id: string;
  name: string;
  status: 'active' | 'completed' | 'rolled_back';
  decision?: ExperimentDecision;
  params: ScoringParams;
  defaultParams: ScoringParams;
  mutations: ParamMutation[];
  parentId: string | null;
  currentResults?: ExperimentResults;
  created_at: string;
  completed_at?: string;
  rollback_reason?: string;
}

export const PARAM_RANGES: Record<string, { min: number; max: number; step: number; label: string }> = {
  w_amount: { min: 0, max: 50, step: 1, label: 'Amount Weight' },
  w_deadline: { min: 0, max: 50, step: 1, label: 'Deadline Weight' },
  w_funding_type: { min: 0, max: 50, step: 1, label: 'Funding Type Weight' },
  w_actionability: { min: 0, max: 50, step: 1, label: 'Actionability Weight' },
  w_vagueness: { min: -30, max: 0, step: 1, label: 'Vagueness Penalty' },
  w_governance: { min: -30, max: 0, step: 1, label: 'Governance Penalty' },
  w_awarded: { min: -30, max: 0, step: 1, label: 'Already Awarded Penalty' },
  w_small_amount: { min: -20, max: 0, step: 1, label: 'Small Amount Penalty' },
  w_expired: { min: -30, max: 0, step: 1, label: 'Expired Penalty' },
};
