-- Append-only domain event ledger and current-state read models for API Accord
-- core objects. The event ledger is the source of truth (INV-035); read models
-- are derived projections. No UPDATE/DELETE path mutates past events.

CREATE TABLE domain_event (
  event_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_kind TEXT NOT NULL
    CHECK (actor_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  payload JSONB NOT NULL,
  PRIMARY KEY (aggregate_type, aggregate_id, version),
  UNIQUE (event_id)
);

CREATE INDEX domain_event_occurred_idx ON domain_event (occurred_at);
CREATE INDEX domain_event_aggregate_idx ON domain_event (aggregate_type, aggregate_id);

COMMENT ON TABLE domain_event IS
  'Append-only event ledger for API Accord core objects (INV-035).';

CREATE TABLE organizations (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE teams (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  name TEXT NOT NULL
);

CREATE TABLE services (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  owning_team_id TEXT NOT NULL REFERENCES teams (id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('provider', 'consumer', 'both'))
);

CREATE TABLE api_contracts (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  provider_service_id TEXT NOT NULL REFERENCES services (id),
  title TEXT NOT NULL
);

CREATE TABLE contract_versions (
  id TEXT NOT NULL PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES api_contracts (id),
  source_revision TEXT NOT NULL,
  checksum TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  decision_record_id TEXT
);

CREATE TABLE operations (
  id TEXT NOT NULL PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES api_contracts (id),
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL
);

CREATE TABLE schemas (
  id TEXT NOT NULL PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (id),
  role TEXT NOT NULL CHECK (role IN ('request', 'response', 'error', 'event')),
  shape JSONB NOT NULL
);

CREATE TABLE dependency_edges (
  id TEXT NOT NULL PRIMARY KEY,
  consumer_service_id TEXT NOT NULL REFERENCES services (id),
  operation_id TEXT NOT NULL REFERENCES operations (id),
  usage JSONB NOT NULL,
  source TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE context_items (
  id TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL
    CHECK (scope IN ('organization', 'service', 'apiContract', 'operation', 'dependencyEdge', 'changeProposal')),
  statement TEXT NOT NULL,
  context_type TEXT NOT NULL,
  author_kind TEXT NOT NULL
    CHECK (author_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  author_id TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('unverified', 'inferred', 'confirmed', 'disputed')),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  corrected_by TEXT,
  superseded_by TEXT
);

CREATE TABLE discussion_entries (
  id TEXT NOT NULL PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('question', 'proposal', 'objection', 'constraint', 'assumption', 'evidence', 'alternative', 'correction', 'acknowledgement')),
  author_kind TEXT NOT NULL
    CHECK (author_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  is_blocking_objection BOOLEAN NOT NULL DEFAULT FALSE,
  resolved BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE change_proposals (
  id TEXT NOT NULL PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES api_contracts (id),
  title TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('draft', 'opened', 'closed')),
  accepted BOOLEAN NOT NULL DEFAULT FALSE,
  implemented BOOLEAN NOT NULL DEFAULT FALSE,
  consumer_ready BOOLEAN NOT NULL DEFAULT FALSE,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  deployed BOOLEAN NOT NULL DEFAULT FALSE,
  observed BOOLEAN NOT NULL DEFAULT FALSE,
  outcome TEXT NOT NULL DEFAULT 'none' CHECK (outcome IN ('none', 'completed', 'rejected', 'withdrawn')),
  open_blocking_objections INTEGER NOT NULL DEFAULT 0 CHECK (open_blocking_objections >= 0),
  required_approvers_satisfied BOOLEAN NOT NULL DEFAULT FALSE,
  consumer_migration_complete BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE decision_records (
  id TEXT NOT NULL PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES change_proposals (id),
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  approvers JSONB NOT NULL,
  superseded_by TEXT
);

CREATE TABLE evidence (
  id TEXT NOT NULL PRIMARY KEY,
  contract_version_id TEXT NOT NULL REFERENCES contract_versions (id),
  source_revision TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('passed', 'failed', 'skipped', 'not-run', 'waived', 'evidence-missing')),
  attached_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE deployments (
  id TEXT NOT NULL PRIMARY KEY,
  contract_version_id TEXT NOT NULL REFERENCES contract_versions (id),
  environment TEXT NOT NULL,
  deployed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE observations (
  id TEXT NOT NULL PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (id),
  environment TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0 CHECK (sample_size >= 0)
);
