-- Context item extension (issue #7): visibility, evidence reference, supersedes link,
-- correction timestamp, challenge attribution, and dispute flag. Existing rows keep
-- their prior meaning; new columns get safe defaults.

ALTER TABLE context_items
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'organization' CHECK (visibility IN ('public', 'organization', 'team')),
  ADD COLUMN IF NOT EXISTS evidence_ref TEXT,
  ADD COLUMN IF NOT EXISTS supersedes TEXT,
  ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS challenged_by_kind TEXT CHECK (challenged_by_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  ADD COLUMN IF NOT EXISTS challenged_by_id TEXT,
  ADD COLUMN IF NOT EXISTS disputed BOOLEAN NOT NULL DEFAULT FALSE;
