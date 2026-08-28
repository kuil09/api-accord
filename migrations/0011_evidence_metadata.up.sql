-- Evidence metadata extension (issue #16): kind, producer, environment, source,
-- checksum, expiry, consumer scope and provenance. Existing rows keep their
-- meaning; new columns are nullable.

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS kind TEXT,
  ADD COLUMN IF NOT EXISTS producer_kind TEXT CHECK (producer_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  ADD COLUMN IF NOT EXISTS producer_id TEXT,
  ADD COLUMN IF NOT EXISTS environment TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS checksum TEXT,
  ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consumer_service_id TEXT,
  ADD COLUMN IF NOT EXISTS provenance TEXT CHECK (provenance IN ('github-check', 'direct-submission'));
