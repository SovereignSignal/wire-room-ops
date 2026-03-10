-- Migration: approve-to-summaries
-- Ensures the summaries table can accept entries from the scan pipeline
-- (which have no corresponding messages or categories row).

-- Make message_id nullable (it may already be, but this is idempotent)
ALTER TABLE summaries ALTER COLUMN message_id DROP NOT NULL;

-- Make category_id nullable (same)
ALTER TABLE summaries ALTER COLUMN category_id DROP NOT NULL;
