ALTER TABLE context_items
  DROP COLUMN IF EXISTS visibility,
  DROP COLUMN IF EXISTS evidence_ref,
  DROP COLUMN IF EXISTS supersedes,
  DROP COLUMN IF EXISTS corrected_at,
  DROP COLUMN IF EXISTS challenged_by_kind,
  DROP COLUMN IF EXISTS challenged_by_id,
  DROP COLUMN IF EXISTS disputed;
