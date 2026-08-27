ALTER TABLE dependency_edges
  DROP COLUMN IF EXISTS usage_json,
  DROP COLUMN IF EXISTS assumptions_json,
  DROP COLUMN IF EXISTS compatibility_json,
  DROP COLUMN IF EXISTS criticality,
  DROP COLUMN IF EXISTS owner_team_id,
  DROP COLUMN IF EXISTS deprecated;
