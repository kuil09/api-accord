-- Structured discussion and decision records (issue #8). The legacy `resolved`
-- boolean is kept for compatibility; `status` carries open/resolved/wont-fix/superseded.

ALTER TABLE discussion_entries
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'wont-fix', 'superseded')),
  ADD COLUMN IF NOT EXISTS affected_consumers JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS severity TEXT CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  ADD COLUMN IF NOT EXISTS evidence_ref TEXT,
  ADD COLUMN IF NOT EXISTS in_reply_to TEXT,
  ADD COLUMN IF NOT EXISTS quotes TEXT,
  ADD COLUMN IF NOT EXISTS duplicate_of TEXT;

ALTER TABLE decision_records
  ADD COLUMN IF NOT EXISTS constraints JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS rejected_alternatives JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_entry_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS supersedes TEXT;
