-- Drift incident read model (issue #17): derived projection of the observation
-- ledger. Resolutions and promotions are separate ledger events; this table
-- serves the current incident state per proposal-agnostic fingerprint.

CREATE TABLE drift_incidents (
  incident_id TEXT NOT NULL PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  environment TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  contract_version_id TEXT NOT NULL,
  deployment_revision TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'false-positive', 'accepted-deviation', 'fixed', 'expired')),
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  sample_size INTEGER NOT NULL DEFAULT 0,
  resolution_reason TEXT,
  promoted_context_item_id TEXT
);

CREATE INDEX drift_incidents_status_idx ON drift_incidents (status, environment);
