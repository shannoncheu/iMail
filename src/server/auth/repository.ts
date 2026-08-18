import "server-only";

import {
  createNeonQuery,
  type DatabaseQuery,
  type DatabaseRow,
} from "../db/neon";
import type {
  AuthenticatedOwnerSession,
  AuthProvider,
  ConsumeOAuthTransactionInput,
  CreateOAuthTransactionInput,
  CreateOwnerSessionInput,
  OAuthTransaction,
  Owner,
  OwnerIdentity,
  OwnerSession,
  RecordSecurityEventInput,
  RotateOwnerSessionInput,
  SafeMailConnection,
  SecurityEvent,
  UpsertOwnerIdentityInput,
} from "./types";

export type AuthRepositorySource =
  | { databaseUrl: string; query?: never }
  | { query: DatabaseQuery; databaseUrl?: never };

type OwnerIdentityResult = {
  owner: Owner;
  identity: OwnerIdentity;
};

export class AuthRepository {
  private readonly query: DatabaseQuery;

  constructor(source: AuthRepositorySource) {
    this.query = source.query ?? createNeonQuery(source.databaseUrl);
  }

  async createOAuthTransaction(
    input: CreateOAuthTransactionInput,
  ): Promise<OAuthTransaction> {
    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? new Date();
    const rows = await this.query<OAuthTransactionRow>(
      `
        INSERT INTO oauth_transactions (
          id,
          provider,
          state_digest,
          browser_binding_digest,
          code_verifier_ciphertext,
          code_verifier_iv,
          code_verifier_key_version,
          redirect_uri,
          return_to,
          created_at,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `,
      [
        id,
        input.provider,
        input.stateDigest,
        input.browserBindingDigest,
        input.codeVerifierEnvelope.ciphertext,
        input.codeVerifierEnvelope.iv,
        input.codeVerifierEnvelope.keyVersion,
        input.redirectUri,
        input.returnTo ?? "/",
        createdAt,
        input.expiresAt,
      ],
    );

    return requireRow(rows, "OAuth transaction was not created", toOAuthTransaction);
  }

  async consumeOAuthTransaction(
    input: ConsumeOAuthTransactionInput,
  ): Promise<OAuthTransaction | null> {
    const rows = await this.query<OAuthTransactionRow>(
      `
        WITH consumed AS (
          DELETE FROM oauth_transactions
          WHERE provider = $1
            AND state_digest = $2
            AND browser_binding_digest = $3
          RETURNING *
        )
        SELECT *
        FROM consumed
        WHERE expires_at > $4
      `,
      [
        input.provider,
        input.stateDigest,
        input.browserBindingDigest,
        input.consumedAt ?? new Date(),
      ],
    );

    return rows[0] ? toOAuthTransaction(rows[0]) : null;
  }

  async upsertOwnerIdentity(
    input: UpsertOwnerIdentityInput,
  ): Promise<OwnerIdentityResult> {
    const ownerId = input.ownerId ?? crypto.randomUUID();
    const identityId = input.identityId ?? crypto.randomUUID();
    const verifiedAt = input.verifiedAt ?? new Date();
    const rows = await this.query<OwnerIdentityJoinRow>(
      `
        WITH identity_lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(
            hashtextextended($1 || ':' || $2, 0)
          )
        ),
        ensured_owner AS (
          INSERT INTO owners (
            id,
            singleton,
            display_name,
            created_at,
            updated_at,
            last_authenticated_at
          )
          SELECT $3, TRUE, $4, $5, $5, $5
          FROM identity_lock
          ON CONFLICT (singleton) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            updated_at = EXCLUDED.updated_at,
            last_authenticated_at = EXCLUDED.last_authenticated_at
          WHERE owners.disabled_at IS NULL
          RETURNING *
        ),
        upserted_identity AS (
          INSERT INTO owner_identities (
            id,
            owner_id,
            provider,
            provider_subject,
            provider_username,
            email,
            avatar_url,
            created_at,
            updated_at,
            last_verified_at
          )
          SELECT $6, owner.id, $1, $2, $7, $8, $9, $5, $5, $5
          FROM ensured_owner AS owner
          ON CONFLICT (provider, provider_subject) DO UPDATE SET
            provider_username = EXCLUDED.provider_username,
            email = EXCLUDED.email,
            avatar_url = EXCLUDED.avatar_url,
            updated_at = EXCLUDED.updated_at,
            last_verified_at = EXCLUDED.last_verified_at
          WHERE owner_identities.owner_id = EXCLUDED.owner_id
          RETURNING *
        )
        SELECT
          owner.id AS owner_id,
          owner.display_name AS owner_display_name,
          owner.created_at AS owner_created_at,
          owner.updated_at AS owner_updated_at,
          owner.last_authenticated_at AS owner_last_authenticated_at,
          owner.disabled_at AS owner_disabled_at,
          identity.id AS identity_id,
          identity.provider AS identity_provider,
          identity.provider_subject AS identity_provider_subject,
          identity.provider_username AS identity_provider_username,
          identity.email AS identity_email,
          identity.avatar_url AS identity_avatar_url,
          identity.created_at AS identity_created_at,
          identity.updated_at AS identity_updated_at,
          identity.last_verified_at AS identity_last_verified_at
        FROM ensured_owner AS owner
        JOIN upserted_identity AS identity ON identity.owner_id = owner.id
      `,
      [
        input.provider,
        input.providerSubject,
        ownerId,
        input.displayName,
        verifiedAt,
        identityId,
        input.providerUsername ?? null,
        input.email ?? null,
        input.avatarUrl ?? null,
      ],
    );

    const row = requireRow(rows, "Owner identity could not be created or is disabled");
    return {
      owner: ownerFromJoinRow(row),
      identity: identityFromJoinRow(row),
    };
  }

  async createOwnerSession(
    input: CreateOwnerSessionInput,
  ): Promise<OwnerSession | null> {
    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? new Date();
    const rows = await this.query<SessionRow>(
      `
        INSERT INTO sessions (
          id,
          owner_id,
          identity_id,
          token_digest,
          created_at,
          last_seen_at,
          expires_at,
          ip_hash,
          user_agent_hash
        )
        SELECT $1, owner.id, identity.id, $4, $5, $5, $6, $7, $8
        FROM owners AS owner
        JOIN owner_identities AS identity
          ON identity.id = $3 AND identity.owner_id = owner.id
        WHERE owner.id = $2 AND owner.disabled_at IS NULL
        RETURNING *
      `,
      [
        id,
        input.ownerId,
        input.identityId,
        input.tokenDigest,
        createdAt,
        input.expiresAt,
        input.ipHash ?? null,
        input.userAgentHash ?? null,
      ],
    );

    return rows[0] ? toOwnerSession(rows[0]) : null;
  }

  async rotateOwnerSession(
    input: RotateOwnerSessionInput,
  ): Promise<OwnerSession | null> {
    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? new Date();
    const rows = await this.query<SessionRow>(
      `
        WITH revoked AS (
          UPDATE sessions
          SET revoked_at = $1
          WHERE token_digest = $2
            AND revoked_at IS NULL
            AND expires_at > $1
          RETURNING id, owner_id, identity_id
        )
        INSERT INTO sessions (
          id,
          owner_id,
          identity_id,
          token_digest,
          rotated_from_session_id,
          created_at,
          last_seen_at,
          expires_at,
          ip_hash,
          user_agent_hash
        )
        SELECT $3, owner.id, revoked.identity_id, $4, revoked.id, $1, $1, $5, $6, $7
        FROM revoked
        JOIN owners AS owner ON owner.id = revoked.owner_id
        WHERE owner.disabled_at IS NULL
        RETURNING *
      `,
      [
        createdAt,
        input.previousTokenDigest,
        id,
        input.tokenDigest,
        input.expiresAt,
        input.ipHash ?? null,
        input.userAgentHash ?? null,
      ],
    );

    return rows[0] ? toOwnerSession(rows[0]) : null;
  }

  async findSessionByDigest(
    tokenDigest: string,
    activeAt = new Date(),
  ): Promise<AuthenticatedOwnerSession | null> {
    const rows = await this.query<AuthenticatedSessionRow>(
      `
        SELECT
          session.id AS session_id,
          session.owner_id AS session_owner_id,
          session.identity_id AS session_identity_id,
          session.rotated_from_session_id,
          session.created_at AS session_created_at,
          session.last_seen_at,
          session.expires_at,
          session.revoked_at,
          session.ip_hash,
          session.user_agent_hash,
          owner.display_name AS owner_display_name,
          owner.created_at AS owner_created_at,
          owner.updated_at AS owner_updated_at,
          owner.last_authenticated_at,
          owner.disabled_at,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'id', identity.id,
                'ownerId', identity.owner_id,
                'provider', identity.provider,
                'providerSubject', identity.provider_subject,
                'providerUsername', identity.provider_username,
                'email', identity.email,
                'avatarUrl', identity.avatar_url,
                'createdAt', identity.created_at,
                'updatedAt', identity.updated_at,
                'lastVerifiedAt', identity.last_verified_at
              ) ORDER BY identity.created_at
            ) FILTER (WHERE identity.id IS NOT NULL),
            '[]'::jsonb
          ) AS identities
        FROM sessions AS session
        JOIN owners AS owner ON owner.id = session.owner_id
        LEFT JOIN owner_identities AS identity ON identity.owner_id = owner.id
        WHERE session.token_digest = $1
          AND session.revoked_at IS NULL
          AND session.expires_at > $2
          AND owner.disabled_at IS NULL
        GROUP BY session.id, owner.id
      `,
      [tokenDigest, activeAt],
    );

    return rows[0] ? toAuthenticatedOwnerSession(rows[0]) : null;
  }

  async revokeSessionByDigest(
    tokenDigest: string,
    revokedAt = new Date(),
  ): Promise<boolean> {
    const rows = await this.query<{ id: unknown }>(
      `
        UPDATE sessions
        SET revoked_at = $2
        WHERE token_digest = $1 AND revoked_at IS NULL
        RETURNING id
      `,
      [tokenDigest, revokedAt],
    );

    return rows.length > 0;
  }

  async listSafeMailConnections(
    ownerId: string,
  ): Promise<SafeMailConnection[]> {
    const rows = await this.query<MailConnectionRow>(
      `
        SELECT
          id,
          owner_id,
          provider,
          provider_account_id,
          email_address,
          label,
          status,
          scopes,
          created_at,
          updated_at,
          connected_at,
          last_refreshed_at,
          disconnected_at
        FROM mail_connections
        WHERE owner_id = $1
        ORDER BY created_at, id
      `,
      [ownerId],
    );

    return rows.map(toSafeMailConnection);
  }

  async recordSecurityEvent(
    input: RecordSecurityEventInput,
  ): Promise<SecurityEvent> {
    const id = input.id ?? crypto.randomUUID();
    const occurredAt = input.occurredAt ?? new Date();
    const rows = await this.query<SecurityEventRow>(
      `
        INSERT INTO security_events (
          id,
          owner_id,
          event_type,
          severity,
          request_id,
          ip_hash,
          user_agent_hash,
          metadata,
          occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        RETURNING *
      `,
      [
        id,
        input.ownerId ?? null,
        input.eventType,
        input.severity ?? "info",
        input.requestId ?? null,
        input.ipHash ?? null,
        input.userAgentHash ?? null,
        JSON.stringify(input.metadata ?? {}),
        occurredAt,
      ],
    );

    return requireRow(rows, "Security event was not recorded", toSecurityEvent);
  }
}

interface OAuthTransactionRow extends DatabaseRow {
  id: unknown;
  provider: unknown;
  state_digest: unknown;
  browser_binding_digest: unknown;
  code_verifier_ciphertext: unknown;
  code_verifier_iv: unknown;
  code_verifier_key_version: unknown;
  redirect_uri: unknown;
  return_to: unknown;
  created_at: unknown;
  expires_at: unknown;
}

interface SessionRow extends DatabaseRow {
  id: unknown;
  owner_id: unknown;
  identity_id: unknown;
  rotated_from_session_id: unknown;
  created_at: unknown;
  last_seen_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  ip_hash: unknown;
  user_agent_hash: unknown;
}

interface OwnerIdentityJoinRow extends DatabaseRow {
  owner_id: unknown;
  owner_display_name: unknown;
  owner_created_at: unknown;
  owner_updated_at: unknown;
  owner_last_authenticated_at: unknown;
  owner_disabled_at: unknown;
  identity_id: unknown;
  identity_provider: unknown;
  identity_provider_subject: unknown;
  identity_provider_username: unknown;
  identity_email: unknown;
  identity_avatar_url: unknown;
  identity_created_at: unknown;
  identity_updated_at: unknown;
  identity_last_verified_at: unknown;
}

interface AuthenticatedSessionRow extends DatabaseRow {
  session_id: unknown;
  session_owner_id: unknown;
  session_identity_id: unknown;
  rotated_from_session_id: unknown;
  session_created_at: unknown;
  last_seen_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  ip_hash: unknown;
  user_agent_hash: unknown;
  owner_display_name: unknown;
  owner_created_at: unknown;
  owner_updated_at: unknown;
  last_authenticated_at: unknown;
  disabled_at: unknown;
  identities: unknown;
}

interface MailConnectionRow extends DatabaseRow {
  id: unknown;
  owner_id: unknown;
  provider: unknown;
  provider_account_id: unknown;
  email_address: unknown;
  label: unknown;
  status: unknown;
  scopes: unknown;
  created_at: unknown;
  updated_at: unknown;
  connected_at: unknown;
  last_refreshed_at: unknown;
  disconnected_at: unknown;
}

interface SecurityEventRow extends DatabaseRow {
  id: unknown;
  owner_id: unknown;
  event_type: unknown;
  severity: unknown;
  request_id: unknown;
  ip_hash: unknown;
  user_agent_hash: unknown;
  metadata: unknown;
  occurred_at: unknown;
}

function toOAuthTransaction(row: OAuthTransactionRow): OAuthTransaction {
  return {
    id: requiredString(row.id, "oauth_transactions.id"),
    provider: row.provider as AuthProvider,
    stateDigest: requiredString(
      row.state_digest,
      "oauth_transactions.state_digest",
    ),
    browserBindingDigest: requiredString(
      row.browser_binding_digest,
      "oauth_transactions.browser_binding_digest",
    ),
    codeVerifierEnvelope: {
      algorithm: "A256GCM",
      ciphertext: requiredString(
        row.code_verifier_ciphertext,
        "oauth_transactions.code_verifier_ciphertext",
      ),
      iv: requiredString(
        row.code_verifier_iv,
        "oauth_transactions.code_verifier_iv",
      ),
      keyVersion: requiredPositiveInteger(
        row.code_verifier_key_version,
        "oauth_transactions.code_verifier_key_version",
      ),
    },
    redirectUri: requiredString(
      row.redirect_uri,
      "oauth_transactions.redirect_uri",
    ),
    returnTo: requiredString(row.return_to, "oauth_transactions.return_to"),
    createdAt: requiredDate(row.created_at, "oauth_transactions.created_at"),
    expiresAt: requiredDate(row.expires_at, "oauth_transactions.expires_at"),
  };
}

function toOwnerSession(row: SessionRow): OwnerSession {
  return {
    id: requiredString(row.id, "sessions.id"),
    ownerId: requiredString(row.owner_id, "sessions.owner_id"),
    identityId: requiredString(row.identity_id, "sessions.identity_id"),
    rotatedFromSessionId: optionalString(row.rotated_from_session_id),
    createdAt: requiredDate(row.created_at, "sessions.created_at"),
    lastSeenAt: requiredDate(row.last_seen_at, "sessions.last_seen_at"),
    expiresAt: requiredDate(row.expires_at, "sessions.expires_at"),
    revokedAt: optionalDate(row.revoked_at, "sessions.revoked_at"),
    ipHash: optionalString(row.ip_hash),
    userAgentHash: optionalString(row.user_agent_hash),
  };
}

function ownerFromJoinRow(row: OwnerIdentityJoinRow): Owner {
  return {
    id: requiredString(row.owner_id, "owners.id"),
    displayName: requiredString(row.owner_display_name, "owners.display_name"),
    createdAt: requiredDate(row.owner_created_at, "owners.created_at"),
    updatedAt: requiredDate(row.owner_updated_at, "owners.updated_at"),
    lastAuthenticatedAt: optionalDate(
      row.owner_last_authenticated_at,
      "owners.last_authenticated_at",
    ),
    disabledAt: optionalDate(row.owner_disabled_at, "owners.disabled_at"),
  };
}

function identityFromJoinRow(row: OwnerIdentityJoinRow): OwnerIdentity {
  return {
    id: requiredString(row.identity_id, "owner_identities.id"),
    ownerId: requiredString(row.owner_id, "owner_identities.owner_id"),
    provider: row.identity_provider as AuthProvider,
    providerSubject: requiredString(
      row.identity_provider_subject,
      "owner_identities.provider_subject",
    ),
    providerUsername: optionalString(row.identity_provider_username),
    email: optionalString(row.identity_email),
    avatarUrl: optionalString(row.identity_avatar_url),
    createdAt: requiredDate(
      row.identity_created_at,
      "owner_identities.created_at",
    ),
    updatedAt: requiredDate(
      row.identity_updated_at,
      "owner_identities.updated_at",
    ),
    lastVerifiedAt: requiredDate(
      row.identity_last_verified_at,
      "owner_identities.last_verified_at",
    ),
  };
}

function toAuthenticatedOwnerSession(
  row: AuthenticatedSessionRow,
): AuthenticatedOwnerSession {
  const identities = Array.isArray(row.identities) ? row.identities : [];

  return {
    session: {
      id: requiredString(row.session_id, "sessions.id"),
      ownerId: requiredString(row.session_owner_id, "sessions.owner_id"),
      identityId: requiredString(
        row.session_identity_id,
        "sessions.identity_id",
      ),
      rotatedFromSessionId: optionalString(row.rotated_from_session_id),
      createdAt: requiredDate(row.session_created_at, "sessions.created_at"),
      lastSeenAt: requiredDate(row.last_seen_at, "sessions.last_seen_at"),
      expiresAt: requiredDate(row.expires_at, "sessions.expires_at"),
      revokedAt: optionalDate(row.revoked_at, "sessions.revoked_at"),
      ipHash: optionalString(row.ip_hash),
      userAgentHash: optionalString(row.user_agent_hash),
    },
    owner: {
      id: requiredString(row.session_owner_id, "owners.id"),
      displayName: requiredString(row.owner_display_name, "owners.display_name"),
      createdAt: requiredDate(row.owner_created_at, "owners.created_at"),
      updatedAt: requiredDate(row.owner_updated_at, "owners.updated_at"),
      lastAuthenticatedAt: optionalDate(
        row.last_authenticated_at,
        "owners.last_authenticated_at",
      ),
      disabledAt: optionalDate(row.disabled_at, "owners.disabled_at"),
    },
    identities: identities.map(toIdentityFromJson),
  };
}

function toIdentityFromJson(value: unknown): OwnerIdentity {
  const row = requiredObject(value, "owner identity");
  return {
    id: requiredString(row.id, "owner identity id"),
    ownerId: requiredString(row.ownerId, "owner identity ownerId"),
    provider: row.provider as AuthProvider,
    providerSubject: requiredString(
      row.providerSubject,
      "owner identity providerSubject",
    ),
    providerUsername: optionalString(row.providerUsername),
    email: optionalString(row.email),
    avatarUrl: optionalString(row.avatarUrl),
    createdAt: requiredDate(row.createdAt, "owner identity createdAt"),
    updatedAt: requiredDate(row.updatedAt, "owner identity updatedAt"),
    lastVerifiedAt: requiredDate(
      row.lastVerifiedAt,
      "owner identity lastVerifiedAt",
    ),
  };
}

function toSafeMailConnection(row: MailConnectionRow): SafeMailConnection {
  return {
    id: requiredString(row.id, "mail_connections.id"),
    ownerId: requiredString(row.owner_id, "mail_connections.owner_id"),
    provider: row.provider as SafeMailConnection["provider"],
    providerAccountId: requiredString(
      row.provider_account_id,
      "mail_connections.provider_account_id",
    ),
    emailAddress: requiredString(
      row.email_address,
      "mail_connections.email_address",
    ),
    label: requiredString(row.label, "mail_connections.label"),
    status: row.status as SafeMailConnection["status"],
    scopes: Array.isArray(row.scopes)
      ? row.scopes.map((scope) => requiredString(scope, "mail connection scope"))
      : [],
    createdAt: requiredDate(row.created_at, "mail_connections.created_at"),
    updatedAt: requiredDate(row.updated_at, "mail_connections.updated_at"),
    connectedAt: optionalDate(
      row.connected_at,
      "mail_connections.connected_at",
    ),
    lastRefreshedAt: optionalDate(
      row.last_refreshed_at,
      "mail_connections.last_refreshed_at",
    ),
    disconnectedAt: optionalDate(
      row.disconnected_at,
      "mail_connections.disconnected_at",
    ),
  };
}

function toSecurityEvent(row: SecurityEventRow): SecurityEvent {
  return {
    id: requiredString(row.id, "security_events.id"),
    ownerId: optionalString(row.owner_id),
    eventType: requiredString(row.event_type, "security_events.event_type"),
    severity: row.severity as SecurityEvent["severity"],
    requestId: optionalString(row.request_id),
    ipHash: optionalString(row.ip_hash),
    userAgentHash: optionalString(row.user_agent_hash),
    metadata: requiredObject(row.metadata, "security_events.metadata"),
    occurredAt: requiredDate(row.occurred_at, "security_events.occurred_at"),
  };
}

function requiredObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return result;
}

function requiredDate(value: unknown, field: string): Date {
  const result = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(result.getTime())) {
    throw new TypeError(`${field} must be a valid date`);
  }
  return result;
}

function optionalDate(value: unknown, field: string): Date | null {
  return value === null || value === undefined
    ? null
    : requiredDate(value, field);
}

function requireRow<Row, Result = Row>(
  rows: Row[],
  message: string,
  transform?: (row: Row) => Result,
): Result {
  const row = rows[0];
  if (!row) throw new Error(message);
  return transform ? transform(row) : (row as unknown as Result);
}
