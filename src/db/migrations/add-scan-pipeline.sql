-- Migration: Add scan pipeline tables
-- Run this against your existing wire-room-ops Postgres database

-- ============================================================
-- scan_entries: All raw and processed scan results
-- ============================================================
CREATE TABLE IF NOT EXISTS scan_entries (
  id SERIAL PRIMARY KEY,

  -- Core content
  name TEXT NOT NULL,
  description TEXT,
  source_url TEXT NOT NULL,
  amount TEXT,                          -- Raw amount string ("$50K", "EUR 125M", etc.)
  amount_numeric NUMERIC,              -- Parsed numeric value in USD equivalent
  amount_currency TEXT,                 -- Currency code (USD, EUR, GBP, INR, etc.)
  deadline TEXT,                        -- Raw deadline string
  deadline_parsed DATE,                -- Parsed deadline date

  -- Classification
  wire TEXT NOT NULL CHECK (wire IN ('crypto', 'ai', 'oss')),
  prompt_variant TEXT NOT NULL CHECK (prompt_variant IN ('A', 'B', 'C')),
  scan_source TEXT NOT NULL DEFAULT 'x-scan' CHECK (scan_source IN ('x-scan', 'web-search')),
  scan_date DATE NOT NULL,

  -- Processing state
  status TEXT NOT NULL DEFAULT 'raw'
    CHECK (status IN ('raw', 'deduped', 'duplicate', 'scored', 'queued', 'enriched', 'published', 'archived')),
  quality_score INTEGER,               -- 0-100
  quality_breakdown JSONB,             -- Detailed scoring breakdown

  -- Dedup tracking
  duplicate_of_id INTEGER REFERENCES scan_entries(id),
  duplicate_reason TEXT,

  -- Enrichment (filled after AI processing)
  enriched_summary TEXT,
  processing_method TEXT,              -- 'grok' or 'claude'

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- seen_urls: Fast lookup table for URL-based dedup
-- ============================================================
CREATE TABLE IF NOT EXISTS seen_urls (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,         -- Stripped of tracking params, lowercased
  first_seen_entry_id INTEGER NOT NULL REFERENCES scan_entries(id),
  first_seen_date DATE NOT NULL,
  wire TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(normalized_url, wire)
);

-- ============================================================
-- seen_names: Lookup table for fuzzy name matching
-- ============================================================
CREATE TABLE IF NOT EXISTS seen_names (
  id SERIAL PRIMARY KEY,
  name_original TEXT NOT NULL,
  name_normalized TEXT NOT NULL,        -- Lowercased, stripped of common words
  name_tokens TEXT[],                   -- Array of significant tokens for matching
  entry_id INTEGER NOT NULL REFERENCES scan_entries(id),
  wire TEXT NOT NULL,
  first_seen DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- intake_runs: Log of each intake processing run
-- ============================================================
CREATE TABLE IF NOT EXISTS intake_runs (
  id SERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  wire TEXT,                            -- NULL means all wires
  total_ingested INTEGER DEFAULT 0,
  duplicates_found INTEGER DEFAULT 0,
  new_unique INTEGER DEFAULT 0,
  avg_quality_score NUMERIC,
  high_quality_count INTEGER DEFAULT 0,
  summary JSONB,                        -- Full IntakeRunSummary as JSON
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Indexes for performance
-- ============================================================

-- URL dedup lookups (most common operation)
CREATE INDEX IF NOT EXISTS idx_seen_urls_normalized ON seen_urls(normalized_url);
CREATE INDEX IF NOT EXISTS idx_seen_urls_wire ON seen_urls(wire);

-- Name matching lookups
CREATE INDEX IF NOT EXISTS idx_seen_names_normalized ON seen_names(name_normalized);
CREATE INDEX IF NOT EXISTS idx_seen_names_wire ON seen_names(wire);
CREATE INDEX IF NOT EXISTS idx_seen_names_tokens ON seen_names USING GIN(name_tokens);

-- Scan entries queries
CREATE INDEX IF NOT EXISTS idx_scan_entries_wire ON scan_entries(wire);
CREATE INDEX IF NOT EXISTS idx_scan_entries_status ON scan_entries(status);
CREATE INDEX IF NOT EXISTS idx_scan_entries_scan_date ON scan_entries(scan_date);
CREATE INDEX IF NOT EXISTS idx_scan_entries_quality ON scan_entries(quality_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_scan_entries_source_url ON scan_entries(source_url);
CREATE INDEX IF NOT EXISTS idx_scan_entries_wire_date ON scan_entries(wire, scan_date);
CREATE INDEX IF NOT EXISTS idx_scan_entries_wire_status ON scan_entries(wire, status);

-- Combined index for the daily queue view
CREATE INDEX IF NOT EXISTS idx_scan_entries_queue
  ON scan_entries(wire, status, quality_score DESC NULLS LAST)
  WHERE status IN ('scored', 'queued');

-- Intake run lookups
CREATE INDEX IF NOT EXISTS idx_intake_runs_date ON intake_runs(run_date);

-- ============================================================
-- Updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_scan_entries_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scan_entries_updated_at
  BEFORE UPDATE ON scan_entries
  FOR EACH ROW
  EXECUTE FUNCTION update_scan_entries_updated_at();
