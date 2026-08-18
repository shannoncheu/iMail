ALTER TABLE mail_connections
  ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS token_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS refresh_lease_id UUID,
  ADD COLUMN IF NOT EXISTS refresh_lease_expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mail_connections_token_version'
  ) THEN
    ALTER TABLE mail_connections
      ADD CONSTRAINT mail_connections_token_version
      CHECK (token_version >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mail_connections_provider_metadata_object'
  ) THEN
    ALTER TABLE mail_connections
      ADD CONSTRAINT mail_connections_provider_metadata_object
      CHECK (jsonb_typeof(provider_metadata) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mail_connections_access_expiry'
  ) THEN
    ALTER TABLE mail_connections
      ADD CONSTRAINT mail_connections_access_expiry
      CHECK (access_expires_at IS NULL OR access_expires_at >= created_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mail_connections_refresh_lease_pair'
  ) THEN
    ALTER TABLE mail_connections
      ADD CONSTRAINT mail_connections_refresh_lease_pair
      CHECK (
        (refresh_lease_id IS NULL) = (refresh_lease_expires_at IS NULL)
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS mail_oauth_transactions (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  state_digest TEXT NOT NULL,
  browser_binding_digest TEXT NOT NULL,
  code_verifier_ciphertext TEXT NOT NULL,
  code_verifier_iv TEXT NOT NULL,
  code_verifier_key_version SMALLINT NOT NULL,
  redirect_uri TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '/',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT mail_oauth_transactions_provider
    CHECK (provider IN ('gmail', 'outlook', 'zoho')),
  CONSTRAINT mail_oauth_transactions_state_digest
    CHECK (state_digest ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT mail_oauth_transactions_browser_binding_digest
    CHECK (browser_binding_digest ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT mail_oauth_transactions_ciphertext
    CHECK (code_verifier_ciphertext ~ '^[A-Za-z0-9_-]{22,}$'),
  CONSTRAINT mail_oauth_transactions_iv
    CHECK (code_verifier_iv ~ '^[A-Za-z0-9_-]{16}$'),
  CONSTRAINT mail_oauth_transactions_key_version
    CHECK (code_verifier_key_version > 0),
  CONSTRAINT mail_oauth_transactions_redirect_uri
    CHECK (char_length(redirect_uri) BETWEEN 10 AND 2048),
  CONSTRAINT mail_oauth_transactions_safe_return_to
    CHECK (
      char_length(return_to) BETWEEN 1 AND 2048
      AND left(return_to, 1) = '/'
      AND left(return_to, 2) <> '//'
      AND position('\\' IN return_to) = 0
    ),
  CONSTRAINT mail_oauth_transactions_positive_lifetime
    CHECK (expires_at > created_at),
  CONSTRAINT mail_oauth_transactions_state_unique UNIQUE (state_digest)
);

CREATE INDEX IF NOT EXISTS mail_oauth_transactions_expires_at_idx
  ON mail_oauth_transactions (expires_at);

CREATE INDEX IF NOT EXISTS mail_oauth_transactions_session_idx
  ON mail_oauth_transactions (session_id, expires_at);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT rate_limit_buckets_action
    CHECK (char_length(action) BETWEEN 1 AND 100),
  CONSTRAINT rate_limit_buckets_subject
    CHECK (subject_digest ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT rate_limit_buckets_count
    CHECK (request_count > 0),
  CONSTRAINT rate_limit_buckets_lifetime
    CHECK (expires_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_expires_at_idx
  ON rate_limit_buckets (expires_at);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
  ON sessions (expires_at);

CREATE INDEX IF NOT EXISTS security_events_occurred_at_idx
  ON security_events (occurred_at);
