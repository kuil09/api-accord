-- Workflow projections (issue #9): required approvers, recorded approvals, and
-- per-consumer readiness with migration deadlines. These are derived read models
-- of the append-only ledger; the ledger remains the source of truth.

CREATE TABLE proposal_required_approvers (
  proposal_id TEXT NOT NULL,
  approver_kind TEXT NOT NULL CHECK (approver_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  approver_id TEXT NOT NULL,
  declared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (proposal_id, approver_id)
);

CREATE TABLE proposal_approvals (
  proposal_id TEXT NOT NULL,
  approver_kind TEXT NOT NULL CHECK (approver_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  approver_id TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  withdrawn_at TIMESTAMPTZ,
  comment TEXT,
  PRIMARY KEY (proposal_id, approver_id)
);

CREATE TABLE proposal_consumer_readiness (
  proposal_id TEXT NOT NULL,
  consumer_service_id TEXT NOT NULL,
  ready BOOLEAN NOT NULL DEFAULT FALSE,
  deadline TIMESTAMPTZ,
  evidence_ref TEXT,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (proposal_id, consumer_service_id)
);

CREATE TABLE proposal_work_items (
  proposal_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('implementation', 'test', 'deployment', 'migration')),
  description TEXT NOT NULL,
  assigned_to_kind TEXT NOT NULL CHECK (assigned_to_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  assigned_to_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (proposal_id, work_item_id)
);
