CREATE TABLE IF NOT EXISTS mail_pagination_sessions (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  query_fingerprint TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  state_ciphertext BYTEA NOT NULL,
  state_iv BYTEA NOT NULL,
  state_key_version SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT mail_pagination_sessions_query_fingerprint
    CHECK (query_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT mail_pagination_sessions_revision
    CHECK (revision >= 0),
  CONSTRAINT mail_pagination_sessions_ciphertext
    CHECK (octet_length(state_ciphertext) BETWEEN 16 AND 524304),
  CONSTRAINT mail_pagination_sessions_iv
    CHECK (octet_length(state_iv) = 12),
  CONSTRAINT mail_pagination_sessions_key_version
    CHECK (state_key_version > 0),
  CONSTRAINT mail_pagination_sessions_updated_after_creation
    CHECK (updated_at >= created_at),
  CONSTRAINT mail_pagination_sessions_fixed_lifetime
    CHECK (expires_at = created_at + INTERVAL '15 minutes'),
  CONSTRAINT mail_pagination_sessions_updated_before_expiry
    CHECK (updated_at < expires_at)
);

CREATE INDEX IF NOT EXISTS mail_pagination_sessions_owner_active_idx
  ON mail_pagination_sessions (owner_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS mail_pagination_sessions_expires_at_idx
  ON mail_pagination_sessions (expires_at);
