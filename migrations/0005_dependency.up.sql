-- Dependency edge extension (issue #6): structured usage, assumptions, and
-- compatibility policy. The legacy free-form `usage JSONB` column is retained
-- for backward compatibility; new structured columns carry the typed data.

ALTER TABLE dependency_edges
  ADD COLUMN IF NOT EXISTS usage_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS assumptions_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS compatibility_json JSONB NOT NULL DEFAULT '{"allowAdditiveFields":true,"allowNewEnumValues":false,"allowNullableChange":false}'::JSONB,
  ADD COLUMN IF NOT EXISTS criticality TEXT NOT NULL DEFAULT 'medium' CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
  ADD COLUMN IF NOT EXISTS owner_team_id TEXT,
  ADD COLUMN IF NOT EXISTS deprecated BOOLEAN NOT NULL DEFAULT FALSE;
