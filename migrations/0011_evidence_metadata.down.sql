ALTER TABLE evidence
  DROP COLUMN IF EXISTS provenance,
  DROP COLUMN IF EXISTS consumer_service_id,
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS observed_at,
  DROP COLUMN IF EXISTS checksum,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS environment,
  DROP COLUMN IF EXISTS producer_id,
  DROP COLUMN IF EXISTS producer_kind,
  DROP COLUMN IF EXISTS kind;
