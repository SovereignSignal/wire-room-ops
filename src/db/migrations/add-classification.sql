-- Add classification support to scan_entries
ALTER TABLE scan_entries
  ADD COLUMN IF NOT EXISTS classification VARCHAR(20) DEFAULT 'UNCHECKED',
  ADD COLUMN IF NOT EXISTS classification_reason TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Add incomplete status support (for Gate 1 failures awaiting enrichment)
-- The status column already exists, just documenting the new valid value: 'incomplete'

-- Index for classification queries
CREATE INDEX IF NOT EXISTS idx_scan_entries_classification ON scan_entries(classification);
CREATE INDEX IF NOT EXISTS idx_scan_entries_status_wire ON scan_entries(status, wire);

COMMENT ON COLUMN scan_entries.classification IS 'GRANT | EXPIRED | NEWS | NOISE | UNCHECKED — set by Gate 2 LLM classifier';
COMMENT ON COLUMN scan_entries.metadata IS 'Extracted fields: { amount, deadline, eligibility, summary } from Gate 2 classifier';
