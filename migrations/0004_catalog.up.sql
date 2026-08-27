-- Catalog extension (issue #5): widen Service/Contract with ownership and import
-- provenance, and add the operation op_id stable identifier. Schema already
-- supports JSONB shapes. Apply/rollback is additive so existing rows are kept.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS repository_url TEXT,
  ADD COLUMN IF NOT EXISTS environments JSONB NOT NULL DEFAULT '[]'::JSONB;

ALTER TABLE api_contracts
  ADD COLUMN IF NOT EXISTS import_source TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS import_source_url TEXT,
  ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS op_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS operations_op_id_idx ON operations (contract_id, op_id);
