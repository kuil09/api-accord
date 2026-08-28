ALTER TABLE decision_records
  DROP COLUMN IF EXISTS supersedes,
  DROP COLUMN IF EXISTS source_entry_ids,
  DROP COLUMN IF EXISTS valid_until,
  DROP COLUMN IF EXISTS valid_from,
  DROP COLUMN IF EXISTS rejected_alternatives,
  DROP COLUMN IF EXISTS constraints;

ALTER TABLE discussion_entries
  DROP COLUMN IF EXISTS duplicate_of,
  DROP COLUMN IF EXISTS quotes,
  DROP COLUMN IF EXISTS in_reply_to,
  DROP COLUMN IF EXISTS evidence_ref,
  DROP COLUMN IF EXISTS severity,
  DROP COLUMN IF EXISTS affected_consumers,
  DROP COLUMN IF EXISTS status;
