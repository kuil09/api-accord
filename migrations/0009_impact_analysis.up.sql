-- Impact analysis read model (issue #11): one row per pinned analysis snapshot.
-- The ledger keeps the full history; this table serves the latest snapshot per
-- proposal with a staleness flag recomputed by the application.

CREATE TABLE impact_analyses (
  proposal_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by_kind TEXT NOT NULL CHECK (recorded_by_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  recorded_by_id TEXT NOT NULL,
  stale BOOLEAN NOT NULL DEFAULT FALSE,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (proposal_id, recorded_at)
);

CREATE INDEX impact_analyses_proposal_idx ON impact_analyses (proposal_id, recorded_at DESC);
