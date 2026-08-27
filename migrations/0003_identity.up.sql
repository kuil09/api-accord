-- Principals and MCP credentials for identity, RBAC and audit (issue #4).
-- Credentials store only a salted hash; the plaintext secret is never persisted (INV-031).

CREATE TABLE principals (
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  created_by_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE credentials (
  id TEXT NOT NULL PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  name TEXT NOT NULL,
  scopes JSONB NOT NULL,
  secret_hash TEXT NOT NULL,
  issued_by_kind TEXT NOT NULL CHECK (issued_by_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  issued_by_id TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT,
  last_used_client TEXT,
  revoked_at TIMESTAMPTZ,
  rotated_from TEXT REFERENCES credentials (id)
);

CREATE INDEX credentials_principal_idx ON credentials (principal_id);
CREATE INDEX credentials_active_idx ON credentials (principal_id) WHERE revoked_at IS NULL;
