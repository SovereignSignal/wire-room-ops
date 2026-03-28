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
  // Base weights
  w_has_amount: number;
  w_amount_threshold: number;
  w_has_deadline: number;
  w_deadline_upcoming: number;
  w_funding_opportunity: number;
  w_actionable: number;

  // Penalties (negative values)
  p_governance_noise: number;
  p_already_awarded: number;
  p_vague_description: number;
  p_small_amount: number;

  // Thresholds
  t_amount_min: number;
  t_amount_tiny: number;
  t_deadline_window_days: number;
  t_rolling_bonus: number;

  // Queue threshold
  t_queue_min_score: number;

  [key: string]: number;
}

export const DEFAULT_PARAMS: ScoringParams = {
  w_has_amount: 25,
  w_amount_threshold: 15,
  w_has_deadline: 15,
  w_deadline_upcoming: 10,
  w_funding_opportunity: 20,
  w_actionable: 15,

  p_governance_noise: -15,
  p_already_awarded: -10,
  p_vague_description: -5,
  p_small_amount: -5,

  t_amount_min: 5000,
  t_amount_tiny: 1000,
  t_deadline_window_days: 60,
  t_rolling_bonus: 5,

  t_queue_min_score: 40,
};

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
  status: 'active' | 'completed' | 'rolled_back' | 'pending' | 'aborted';
  decision?: ExperimentDecision;
  params: ScoringParams;
  parent_experiment_id: string | null;
  mutation_description: string | null;
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  min_duration_hours?: number;
  entry_count?: number;
  approved_count?: number;
  declined_count?: number;
  created_by?: string;
  // Enriched fields (attached by frontend from API response)
  defaultParams?: ScoringParams;
  mutations?: ParamMutation[];
  currentResults?: ExperimentResults;
  rollback_reason?: string;
}

export const PARAM_RANGES: Record<string, { min: number; max: number; step: number; label: string }> = {
  w_has_amount:          { min: 10, max: 40, step: 1, label: 'Has Amount Weight' },
  w_amount_threshold:    { min: 5,  max: 30, step: 1, label: 'Amount Threshold Weight' },
  w_has_deadline:        { min: 5,  max: 25, step: 1, label: 'Has Deadline Weight' },
  w_deadline_upcoming:   { min: 0,  max: 20, step: 1, label: 'Deadline Upcoming Weight' },
  w_funding_opportunity: { min: 10, max: 35, step: 1, label: 'Funding Opportunity Weight' },
  w_actionable:          { min: 5,  max: 25, step: 1, label: 'Actionable Weight' },

  p_governance_noise:    { min: -30, max: 0, step: 1, label: 'Governance Noise Penalty' },
  p_already_awarded:     { min: -25, max: 0, step: 1, label: 'Already Awarded Penalty' },
  p_vague_description:   { min: -15, max: 0, step: 1, label: 'Vague Description Penalty' },
  p_small_amount:        { min: -15, max: 0, step: 1, label: 'Small Amount Penalty' },

  t_amount_min:          { min: 1000,  max: 25000, step: 100, label: 'Min Amount Threshold ($)' },
  t_amount_tiny:         { min: 100,   max: 5000,  step: 100, label: 'Tiny Amount Threshold ($)' },
  t_deadline_window_days:{ min: 14,    max: 120,   step: 1,   label: 'Deadline Window (days)' },
  t_rolling_bonus:       { min: 0,     max: 15,    step: 1,   label: 'Rolling Bonus' },

  t_queue_min_score:     { min: 20, max: 70, step: 1, label: 'Queue Min Score' },
};
