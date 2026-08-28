-- Notification and subscription read models (issue #15). The dedup key folds
-- repeated occurrences; status changes are audited in the ledger.

CREATE TABLE notifications (
  notification_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('principal', 'team')),
  recipient_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  required_action TEXT,
  deadline TIMESTAMPTZ,
  blocking BOOLEAN NOT NULL DEFAULT FALSE,
  link JSONB NOT NULL DEFAULT '{}'::JSONB,
  channel TEXT NOT NULL CHECK (channel IN ('in-app', 'email', 'webhook')),
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'acknowledged', 'snoozed', 'resolved')),
  assignee_kind TEXT CHECK (assignee_kind IN ('principal', 'team')),
  assignee_id TEXT,
  snoozed_until TIMESTAMPTZ,
  occurrences INTEGER NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notification_id)
);

CREATE UNIQUE INDEX notifications_dedup_idx ON notifications (dedup_key);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_id, status);

CREATE TABLE notification_subscriptions (
  subscription_id TEXT NOT NULL PRIMARY KEY,
  subscriber_kind TEXT NOT NULL CHECK (subscriber_kind IN ('principal', 'team')),
  subscriber_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('service', 'operation', 'proposal')),
  target_id TEXT NOT NULL,
  digest TEXT NOT NULL DEFAULT 'immediate' CHECK (digest IN ('immediate', 'daily', 'weekly')),
  declared_by_kind TEXT NOT NULL CHECK (declared_by_kind IN ('human', 'agent', 'service', 'ci', 'integration')),
  declared_by_id TEXT NOT NULL,
  declared_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
