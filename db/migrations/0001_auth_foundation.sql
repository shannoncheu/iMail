CREATE TABLE IF NOT EXISTS owners (
  id UUID PRIMARY KEY,
  singleton BOOLEAN NOT NULL DEFAULT TRUE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_authenticated_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  CONSTRAINT owners_singleton_true
    CHECK (singleton),
  CONSTRAINT owners_singleton_unique
    UNIQUE (singleton),
  CONSTRAINT owners_display_name_length
    CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT owners_updated_after_creation
    CHECK (updated_at >= created_at),
  CONSTRAINT owners_last_authenticated_after_creation
    CHECK (last_authenticated_at IS NULL OR last_authenticated_at >= created_at),
  CONSTRAINT owners_disabled_after_creation
    CHECK (disabled_at IS NULL OR disabled_at >= created_at)
);

CREATE TABLE IF NOT EXISTS owner_identities (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  provider_username TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT owner_identities_provider
    CHECK (provider IN ('github', 'google', 'microsoft', 'zoho')),
  CONSTRAINT owner_identities_subject_length
    CHECK (char_length(provider_subject) BETWEEN 1 AND 512),
  CONSTRAINT owner_identities_username_length
    CHECK (provider_username IS NULL OR char_length(provider_username) BETWEEN 1 AND 255),
  CONSTRAINT owner_identities_email_length
    CHECK (email IS NULL OR char_length(email) <= 320),
  CONSTRAINT owner_identities_avatar_url_length
    CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 2048),
  CONSTRAINT owner_identities_updated_after_creation
    CHECK (updated_at >= created_at),
  CONSTRAINT owner_identities_verified_after_creation
    CHECK (last_verified_at >= created_at),
  CONSTRAINT owner_identities_provider_subject_unique
    UNIQUE (provider, provider_subject),
  CONSTRAINT owner_identities_id_owner_unique
    UNIQUE (id, owner_id)
);

CREATE TABLE IF NOT EXISTS oauth_transactions (
  id UUID PRIMARY KEY,
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
  CONSTRAINT oauth_transactions_provider
    CHECK (provider IN ('github', 'google', 'microsoft', 'zoho')),
  CONSTRAINT oauth_transactions_state_digest_length
    CHECK (
      char_length(state_digest) BETWEEN 32 AND 128
      AND state_digest ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT oauth_transactions_browser_binding_digest_length
    CHECK (
      char_length(browser_binding_digest) BETWEEN 32 AND 128
      AND browser_binding_digest ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT oauth_transactions_code_verifier_ciphertext
    CHECK (
      char_length(code_verifier_ciphertext) BETWEEN 32 AND 4096
      AND code_verifier_ciphertext ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT oauth_transactions_code_verifier_iv
    CHECK (
      char_length(code_verifier_iv) = 16
      AND code_verifier_iv ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT oauth_transactions_code_verifier_key_version
    CHECK (code_verifier_key_version > 0),
  CONSTRAINT oauth_transactions_redirect_uri
    CHECK (
      char_length(redirect_uri) BETWEEN 8 AND 2048
      AND redirect_uri ~ '^https?://'
    ),
  CONSTRAINT oauth_transactions_safe_return_to
    CHECK (
      char_length(return_to) BETWEEN 1 AND 2048
      AND left(return_to, 1) = '/'
      AND left(return_to, 2) <> '//'
      AND position(chr(92) IN return_to) = 0
    ),
  CONSTRAINT oauth_transactions_positive_lifetime
    CHECK (expires_at > created_at),
  CONSTRAINT oauth_transactions_provider_state_unique
    UNIQUE (provider, state_digest)
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  identity_id UUID NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  rotated_from_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip_hash TEXT,
  user_agent_hash TEXT,
  CONSTRAINT sessions_token_digest_length
    CHECK (
      char_length(token_digest) BETWEEN 32 AND 128
      AND token_digest ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT sessions_positive_lifetime
    CHECK (expires_at > created_at),
  CONSTRAINT sessions_last_seen_after_creation
    CHECK (last_seen_at >= created_at),
  CONSTRAINT sessions_revoked_after_creation
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT sessions_not_rotated_from_self
    CHECK (rotated_from_session_id IS NULL OR rotated_from_session_id <> id),
  CONSTRAINT sessions_identity_owner_fk
    FOREIGN KEY (identity_id, owner_id)
    REFERENCES owner_identities(id, owner_id)
    ON DELETE CASCADE,
  CONSTRAINT sessions_ip_hash_length
    CHECK (ip_hash IS NULL OR char_length(ip_hash) BETWEEN 16 AND 128),
  CONSTRAINT sessions_user_agent_hash_length
    CHECK (user_agent_hash IS NULL OR char_length(user_agent_hash) BETWEEN 16 AND 128)
);

CREATE TABLE IF NOT EXISTS mail_connections (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  email_address TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  credentials_ciphertext BYTEA,
  credentials_iv BYTEA,
  credentials_key_version SMALLINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  connected_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  CONSTRAINT mail_connections_provider
    CHECK (provider IN ('gmail', 'outlook', 'zoho')),
  CONSTRAINT mail_connections_account_id_length
    CHECK (char_length(provider_account_id) BETWEEN 1 AND 512),
  CONSTRAINT mail_connections_email_address
    CHECK (
      char_length(email_address) BETWEEN 3 AND 320
      AND position('@' IN email_address) > 1
    ),
  CONSTRAINT mail_connections_label_length
    CHECK (char_length(label) BETWEEN 1 AND 200),
  CONSTRAINT mail_connections_status
    CHECK (status IN ('pending', 'connected', 'error', 'disconnected', 'revoked')),
  CONSTRAINT mail_connections_scope_count
    CHECK (cardinality(scopes) <= 64),
  CONSTRAINT mail_connections_credentials_complete
    CHECK (
      (
        credentials_ciphertext IS NULL
        AND credentials_iv IS NULL
        AND credentials_key_version IS NULL
      )
      OR
      (
        credentials_ciphertext IS NOT NULL
        AND octet_length(credentials_ciphertext) >= 16
        AND credentials_iv IS NOT NULL
        AND octet_length(credentials_iv) = 12
        AND credentials_key_version IS NOT NULL
        AND credentials_key_version > 0
      )
    ),
  CONSTRAINT mail_connections_updated_after_creation
    CHECK (updated_at >= created_at),
  CONSTRAINT mail_connections_connected_after_creation
    CHECK (connected_at IS NULL OR connected_at >= created_at),
  CONSTRAINT mail_connections_refreshed_after_creation
    CHECK (last_refreshed_at IS NULL OR last_refreshed_at >= created_at),
  CONSTRAINT mail_connections_disconnected_after_creation
    CHECK (disconnected_at IS NULL OR disconnected_at >= created_at),
  CONSTRAINT mail_connections_disconnected_status
    CHECK (disconnected_at IS NULL OR status IN ('disconnected', 'revoked')),
  CONSTRAINT mail_connections_owner_provider_account_unique
    UNIQUE (owner_id, provider, provider_account_id)
);

CREATE TABLE IF NOT EXISTS security_events (
  id UUID PRIMARY KEY,
  owner_id UUID REFERENCES owners(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  request_id TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT security_events_type
    CHECK (
      char_length(event_type) BETWEEN 3 AND 100
      AND event_type ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
    ),
  CONSTRAINT security_events_severity
    CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  CONSTRAINT security_events_request_id_length
    CHECK (request_id IS NULL OR char_length(request_id) BETWEEN 1 AND 200),
  CONSTRAINT security_events_ip_hash_length
    CHECK (ip_hash IS NULL OR char_length(ip_hash) BETWEEN 16 AND 128),
  CONSTRAINT security_events_user_agent_hash_length
    CHECK (user_agent_hash IS NULL OR char_length(user_agent_hash) BETWEEN 16 AND 128),
  CONSTRAINT security_events_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS owner_identities_owner_idx
  ON owner_identities (owner_id);

CREATE INDEX IF NOT EXISTS oauth_transactions_expires_at_idx
  ON oauth_transactions (expires_at);

CREATE INDEX IF NOT EXISTS sessions_active_owner_idx
  ON sessions (owner_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS sessions_identity_idx
  ON sessions (identity_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
  ON sessions (expires_at);

CREATE INDEX IF NOT EXISTS mail_connections_owner_status_idx
  ON mail_connections (owner_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS security_events_owner_occurred_idx
  ON security_events (owner_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS security_events_type_occurred_idx
  ON security_events (event_type, occurred_at DESC);
