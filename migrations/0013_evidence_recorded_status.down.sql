ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_status_check;
ALTER TABLE evidence ADD CONSTRAINT evidence_status_check
  CHECK (status IN ('passed', 'failed', 'skipped', 'not-run', 'waived', 'evidence-missing'));
