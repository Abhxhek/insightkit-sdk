-- Reference schema for the InsightKit evaluation corpus.
-- Synthetic B2B SaaS. No customer data has ever been in this file and none may be added.
-- The traps are deliberate: soft deletes, nullable timestamps, enums stored as text,
-- two plausible "user" tables, a junction table, a denormalised counter that lies, money in cents.

CREATE TABLE organizations (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  plan            text NOT NULL,
  created_at      timestamptz NOT NULL,
  trial_ends_at   timestamptz,
  churned_at      timestamptz,
  seat_count      integer NOT NULL DEFAULT 0
);
COMMENT ON COLUMN organizations.plan IS 'One of free, pro, scale, enterprise.';
COMMENT ON COLUMN organizations.churned_at IS 'NULL means still a customer.';
COMMENT ON COLUMN organizations.seat_count IS 'Denormalised. May disagree with memberships; memberships is the truth.';

CREATE TABLE users (
  id              uuid PRIMARY KEY,
  email           text NOT NULL UNIQUE,
  full_name       text,
  created_at      timestamptz NOT NULL,
  last_seen_at    timestamptz,
  deleted_at      timestamptz,
  marketing_optin boolean NOT NULL DEFAULT false
);
COMMENT ON COLUMN users.created_at IS 'Account creation. This is what "signed up" and "joined" mean.';
COMMENT ON COLUMN users.deleted_at IS 'Soft delete. Every user-facing count must filter deleted_at IS NULL.';

CREATE TABLE auth_identities (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  provider        text NOT NULL,
  provider_uid    text NOT NULL,
  created_at      timestamptz NOT NULL,
  UNIQUE (provider, provider_uid)
);
COMMENT ON TABLE auth_identities IS
  'One row per linked login method; a user may have several. "Signed up with Google" means their earliest identity by created_at has provider = google.';

CREATE TABLE memberships (
  user_id         uuid NOT NULL REFERENCES users(id),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  role            text NOT NULL,
  invited_at      timestamptz,
  accepted_at     timestamptz,
  PRIMARY KEY (user_id, org_id)
);
COMMENT ON COLUMN memberships.accepted_at IS 'NULL means the invitation is still pending.';

CREATE TABLE events (
  id              bigserial PRIMARY KEY,
  user_id         uuid REFERENCES users(id),
  org_id          uuid REFERENCES organizations(id),
  name            text NOT NULL,
  properties      jsonb NOT NULL DEFAULT '{}',
  occurred_at     timestamptz NOT NULL
);
CREATE INDEX events_occurred_at_idx ON events (occurred_at);
CREATE INDEX events_org_occurred_idx ON events (org_id, occurred_at);

CREATE TABLE projects (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id),
  created_by      uuid REFERENCES users(id),
  name            text NOT NULL,
  created_at      timestamptz NOT NULL,
  archived_at     timestamptz
);

CREATE TABLE subscriptions (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id),
  status          text NOT NULL,
  mrr_cents       integer NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'USD',
  started_at      timestamptz NOT NULL,
  canceled_at     timestamptz
);
COMMENT ON COLUMN subscriptions.mrr_cents IS 'Cents, not dollars. Divide by 100 for currency.';

CREATE TABLE invoices (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id),
  amount_cents    integer NOT NULL,
  status          text NOT NULL,
  issued_at       timestamptz NOT NULL,
  paid_at         timestamptz
);
