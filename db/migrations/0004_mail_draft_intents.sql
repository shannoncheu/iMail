DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mail_connections_id_owner_unique'
  ) THEN
    ALTER TABLE mail_connections
      ADD CONSTRAINT mail_connections_id_owner_unique
      UNIQUE (id, owner_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS mail_draft_intents (
  owner_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  draft_native_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_native_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, connection_id, draft_native_id),
  FOREIGN KEY (connection_id, owner_id)
    REFERENCES mail_connections(id, owner_id)
    ON DELETE CASCADE,
  CONSTRAINT mail_draft_intents_draft_native_id
    CHECK (char_length(draft_native_id) BETWEEN 1 AND 4096),
  CONSTRAINT mail_draft_intents_mode
    CHECK (mode IN ('reply', 'forward')),
  CONSTRAINT mail_draft_intents_source_type
    CHECK (source_type IN ('thread', 'message')),
  CONSTRAINT mail_draft_intents_source_native_id
    CHECK (char_length(source_native_id) BETWEEN 1 AND 4096),
  CONSTRAINT mail_draft_intents_updated_after_creation
    CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS mail_draft_intents_connection_updated_idx
  ON mail_draft_intents (connection_id, updated_at DESC);
