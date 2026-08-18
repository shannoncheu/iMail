import "server-only";

import {
  createNeonQuery,
  type DatabaseQuery,
  type DatabaseRow,
} from "../db/neon";
import type { MailConnectionProvider } from "../auth/types";
import { decodeBase64Url, encodeBase64Url } from "../security/crypto";
import type {
  ConsumeMailOAuthTransactionInput,
  CreateMailOAuthTransactionInput,
  MailOAuthTransaction,
  RateLimitDecision,
  StoredMailConnection,
  AcquireMailRefreshLeaseInput,
  UpdateMailCredentialsInput,
  UpsertMailConnectionInput,
} from "./connection-types";

export type MailConnectionRepositorySource =
  | { databaseUrl: string; query?: never }
  | { query: DatabaseQuery; databaseUrl?: never };

export class MailConnectionRepository {
  private readonly query: DatabaseQuery;

  constructor(source: MailConnectionRepositorySource) {
    this.query = source.query ?? createNeonQuery(source.databaseUrl);
  }

  async createOAuthTransaction(
    input: CreateMailOAuthTransactionInput,
  ): Promise<MailOAuthTransaction> {
    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? new Date();
    const rows = await this.query<MailOAuthTransactionRow>(
      `
        INSERT INTO mail_oauth_transactions (
          id,
          owner_id,
          session_id,
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
        SELECT $1, session.owner_id, session.id, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13
        FROM sessions AS session
        JOIN owners AS owner ON owner.id = session.owner_id
        WHERE session.id = $3
          AND session.owner_id = $2
          AND session.revoked_at IS NULL
          AND session.expires_at > $12
          AND owner.disabled_at IS NULL
        RETURNING *
      `,
      [
        id,
        input.ownerId,
        input.sessionId,
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
    return requireRow(rows, "Mail OAuth transaction was not created", toOAuthTransaction);
  }

  async consumeOAuthTransaction(
    input: ConsumeMailOAuthTransactionInput,
  ): Promise<MailOAuthTransaction | null> {
    const rows = await this.query<MailOAuthTransactionRow>(
      `
        WITH consumed AS (
          DELETE FROM mail_oauth_transactions
          WHERE provider = $1
            AND state_digest = $2
            AND browser_binding_digest = $3
          RETURNING *
        )
        SELECT consumed.*
        FROM consumed
        JOIN sessions AS session ON session.id = consumed.session_id
        JOIN owners AS owner ON owner.id = consumed.owner_id
        WHERE consumed.expires_at > $4
          AND session.revoked_at IS NULL
          AND session.expires_at > $4
          AND session.owner_id = consumed.owner_id
          AND owner.disabled_at IS NULL
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

  async findByProviderAccount(
    ownerId: string,
    provider: MailConnectionProvider,
    providerAccountId: string,
  ): Promise<StoredMailConnection | null> {
    const rows = await this.query<MailConnectionRow>(
      `${mailConnectionSelect}
       WHERE owner_id = $1 AND provider = $2 AND provider_account_id = $3`,
      [ownerId, provider, providerAccountId],
    );
    return rows[0] ? toStoredConnection(rows[0]) : null;
  }

  async findById(
    ownerId: string,
    id: string,
  ): Promise<StoredMailConnection | null> {
    const rows = await this.query<MailConnectionRow>(
      `${mailConnectionSelect}
       WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    return rows[0] ? toStoredConnection(rows[0]) : null;
  }

  async listConnected(ownerId: string): Promise<StoredMailConnection[]> {
    const rows = await this.query<MailConnectionRow>(
      `${mailConnectionSelect}
       WHERE owner_id = $1 AND status = 'connected'
       ORDER BY connected_at, id`,
      [ownerId],
    );
    return rows.map(toStoredConnection);
  }

  async claimRevocationPending(limit = 25): Promise<StoredMailConnection[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Revocation retry limit is invalid");
    }
    const rows = await this.query<MailConnectionRow>(
      `
        WITH candidates AS (
          SELECT id, owner_id
          FROM mail_connections
          WHERE status = 'error'
            AND credentials_ciphertext IS NOT NULL
            AND (
              last_error_code = 'revocation_pending'
              OR (
                last_error_code = 'revocation_in_progress'
                AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '10 minutes'
              )
            )
          ORDER BY updated_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE mail_connections AS connection
        SET last_error_code = 'revocation_in_progress',
            token_version = connection.token_version + 1,
            updated_at = CURRENT_TIMESTAMP
        FROM candidates
        WHERE connection.id = candidates.id
          AND connection.owner_id = candidates.owner_id
        RETURNING connection.*
      `,
      [limit],
    );
    return rows.map(toStoredConnection);
  }

  async upsertConnection(
    input: UpsertMailConnectionInput,
  ): Promise<StoredMailConnection> {
    const now = input.connectedAt ?? new Date();
    const rows = await this.query<MailConnectionRow>(
      `
        INSERT INTO mail_connections (
          id,
          owner_id,
          provider,
          provider_account_id,
          email_address,
          label,
          status,
          scopes,
          credentials_ciphertext,
          credentials_iv,
          credentials_key_version,
          access_expires_at,
          token_version,
          provider_metadata,
          last_error_code,
          created_at,
          updated_at,
          connected_at,
          last_refreshed_at,
          disconnected_at
        )
        SELECT $1, owner.id, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, 1, $13::jsonb, $14, $15, $15, $15, $15, NULL
        FROM owners AS owner
        WHERE owner.id = $2 AND owner.disabled_at IS NULL
        ON CONFLICT (owner_id, provider, provider_account_id) DO UPDATE SET
          email_address = EXCLUDED.email_address,
          label = EXCLUDED.label,
          status = EXCLUDED.status,
          scopes = EXCLUDED.scopes,
          credentials_ciphertext = EXCLUDED.credentials_ciphertext,
          credentials_iv = EXCLUDED.credentials_iv,
          credentials_key_version = EXCLUDED.credentials_key_version,
          access_expires_at = EXCLUDED.access_expires_at,
          token_version = mail_connections.token_version + 1,
          provider_metadata = EXCLUDED.provider_metadata,
          last_error_code = EXCLUDED.last_error_code,
          updated_at = EXCLUDED.updated_at,
          connected_at = EXCLUDED.connected_at,
          last_refreshed_at = EXCLUDED.last_refreshed_at,
          disconnected_at = NULL,
          refresh_lease_id = NULL,
          refresh_lease_expires_at = NULL
        WHERE NOT (
          mail_connections.status = 'error'
          AND mail_connections.last_error_code IN (
            'revocation_pending',
            'revocation_in_progress'
          )
        )
          AND mail_connections.token_version = $16
        RETURNING ${mailConnectionColumns}
      `,
      [
        input.id,
        input.ownerId,
        input.provider,
        input.providerAccountId,
        input.emailAddress,
        input.label,
        input.status ?? "connected",
        input.scopes,
        decodeBase64Url(input.credentials.ciphertext),
        decodeBase64Url(input.credentials.iv),
        input.credentials.keyVersion,
        input.accessExpiresAt ?? null,
        JSON.stringify(input.providerMetadata ?? {}),
        input.lastErrorCode ?? null,
        now,
        input.expectedTokenVersion ?? null,
      ],
    );
    return requireRow(rows, "Mail connection was not saved", toStoredConnection);
  }

  async updateCredentials(
    input: UpdateMailCredentialsInput,
  ): Promise<StoredMailConnection | null> {
    const refreshedAt = input.refreshedAt ?? new Date();
    const rows = await this.query<MailConnectionRow>(
      `
        UPDATE mail_connections
        SET credentials_ciphertext = $4,
            credentials_iv = $5,
            credentials_key_version = $6,
            scopes = $7,
            access_expires_at = $8,
            provider_metadata = $9::jsonb,
            status = 'connected',
            last_error_code = NULL,
            token_version = token_version + 1,
            updated_at = $10,
            last_refreshed_at = $10,
            disconnected_at = NULL,
            refresh_lease_id = NULL,
            refresh_lease_expires_at = NULL
        WHERE id = $1
          AND owner_id = $2
          AND token_version = $3
          AND status = 'connected'
          AND refresh_lease_id = $11
        RETURNING ${mailConnectionColumns}
      `,
      [
        input.id,
        input.ownerId,
        input.expectedTokenVersion,
        decodeBase64Url(input.credentials.ciphertext),
        decodeBase64Url(input.credentials.iv),
        input.credentials.keyVersion,
        input.scopes,
        input.accessExpiresAt ?? null,
        JSON.stringify(input.providerMetadata ?? {}),
        refreshedAt,
        input.refreshLeaseId,
      ],
    );
    return rows[0] ? toStoredConnection(rows[0]) : null;
  }

  async acquireRefreshLease(
    input: AcquireMailRefreshLeaseInput,
  ): Promise<StoredMailConnection | null> {
    const rows = await this.query<MailConnectionRow>(
      `
        UPDATE mail_connections
        SET refresh_lease_id = $4,
            refresh_lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '45 seconds'
        WHERE id = $1
          AND owner_id = $2
          AND token_version = $3
          AND status = 'connected'
          AND credentials_ciphertext IS NOT NULL
          AND (
            refresh_lease_id IS NULL OR refresh_lease_expires_at <= CURRENT_TIMESTAMP
          )
        RETURNING ${mailConnectionColumns}
      `,
      [
        input.id,
        input.ownerId,
        input.expectedTokenVersion,
        input.leaseId,
      ],
    );
    return rows[0] ? toStoredConnection(rows[0]) : null;
  }

  async releaseRefreshLease(input: {
    id: string;
    ownerId: string;
    expectedTokenVersion: number;
    leaseId: string;
  }): Promise<boolean> {
    const rows = await this.query<{ id: unknown }>(
      `
        UPDATE mail_connections
        SET refresh_lease_id = NULL, refresh_lease_expires_at = NULL
        WHERE id = $1
          AND owner_id = $2
          AND token_version = $3
          AND refresh_lease_id = $4
        RETURNING id
      `,
      [
        input.id,
        input.ownerId,
        input.expectedTokenVersion,
        input.leaseId,
      ],
    );
    return rows.length > 0;
  }

  async markError(
    ownerId: string,
    id: string,
    errorCode: string,
    occurredAt = new Date(),
  ): Promise<boolean> {
    const rows = await this.query<{ id: unknown }>(
      `
        UPDATE mail_connections
        SET status = 'error', last_error_code = $3, updated_at = $4
        WHERE owner_id = $1 AND id = $2
        RETURNING id
      `,
      [ownerId, id, errorCode, occurredAt],
    );
    return rows.length > 0;
  }

  async claimConnectionForRevocation(
    ownerId: string,
    id: string,
    expectedTokenVersion: number,
  ): Promise<StoredMailConnection | null> {
    const rows = await this.query<MailConnectionRow>(
      `
        UPDATE mail_connections
        SET status = 'error',
            last_error_code = 'revocation_in_progress',
            token_version = token_version + 1,
            refresh_lease_id = NULL,
            refresh_lease_expires_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE owner_id = $1
          AND id = $2
          AND token_version = $3
          AND status = 'connected'
          AND credentials_ciphertext IS NOT NULL
        RETURNING ${mailConnectionColumns}
      `,
      [ownerId, id, expectedTokenVersion],
    );
    return rows[0] ? toStoredConnection(rows[0]) : null;
  }


  async releaseRevocationClaim(
    ownerId: string,
    id: string,
    expectedTokenVersion: number,
  ): Promise<boolean> {
    const rows = await this.query<{ id: unknown }>(
      `
        UPDATE mail_connections
        SET last_error_code = 'revocation_pending',
            token_version = token_version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE owner_id = $1
          AND id = $2
          AND token_version = $3
          AND status = 'error'
          AND last_error_code = 'revocation_in_progress'
        RETURNING id
      `,
      [ownerId, id, expectedTokenVersion],
    );
    return rows.length > 0;
  }

  async finalizeRevocationClaim(
    ownerId: string,
    id: string,
    expectedTokenVersion: number,
  ): Promise<boolean> {
    const rows = await this.query<{ id: unknown }>(
      `
        UPDATE mail_connections
        SET status = 'disconnected',
            credentials_ciphertext = NULL,
            credentials_iv = NULL,
            credentials_key_version = NULL,
            access_expires_at = NULL,
            token_version = token_version + 1,
            last_error_code = NULL,
            refresh_lease_id = NULL,
            refresh_lease_expires_at = NULL,
            updated_at = CURRENT_TIMESTAMP,
            disconnected_at = CURRENT_TIMESTAMP
        WHERE owner_id = $1
          AND id = $2
          AND token_version = $3
          AND status = 'error'
          AND last_error_code = 'revocation_in_progress'
        RETURNING id
      `,
      [ownerId, id, expectedTokenVersion],
    );
    return rows.length > 0;
  }

  async consumeRateLimit(input: {
    bucketKey: string;
    action: string;
    subjectDigest: string;
    maximum: number;
    windowStartedAt: Date;
    expiresAt: Date;
    now?: Date;
  }): Promise<RateLimitDecision> {
    const now = input.now ?? new Date();
    const rows = await this.query<RateLimitRow>(
      `
        INSERT INTO rate_limit_buckets (
          bucket_key, action, subject_digest, window_started_at,
          request_count, expires_at
        )
        VALUES ($1, $2, $3, $4, 1, $5)
        ON CONFLICT (bucket_key) DO UPDATE SET
          request_count = CASE
            WHEN rate_limit_buckets.expires_at <= $6 THEN 1
            ELSE rate_limit_buckets.request_count + 1
          END,
          window_started_at = CASE
            WHEN rate_limit_buckets.expires_at <= $6 THEN EXCLUDED.window_started_at
            ELSE rate_limit_buckets.window_started_at
          END,
          expires_at = CASE
            WHEN rate_limit_buckets.expires_at <= $6 THEN EXCLUDED.expires_at
            ELSE rate_limit_buckets.expires_at
          END
        RETURNING request_count, expires_at
      `,
      [
        input.bucketKey,
        input.action,
        input.subjectDigest,
        input.windowStartedAt,
        input.expiresAt,
        now,
      ],
    );
    const row = requireRow(rows, "Rate-limit bucket was not updated");
    const count = requiredInteger(row.request_count, "rate_limit request_count");
    const expiresAt = requiredDate(row.expires_at, "rate_limit expires_at");
    return {
      allowed: count <= input.maximum,
      remaining: Math.max(0, input.maximum - count),
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((expiresAt.getTime() - now.getTime()) / 1000),
      ),
    };
  }

  async cleanupExpired(now = new Date()): Promise<{
    oauthTransactions: number;
    identityOAuthTransactions: number;
    paginationSessions: number;
    sessions: number;
    rateLimits: number;
    securityEvents: number;
  }> {
    const rows = await this.query<CleanupRow>(
      `
        WITH oauth AS (
          DELETE FROM mail_oauth_transactions WHERE expires_at <= $1 RETURNING 1
        ), identity_oauth AS (
          DELETE FROM oauth_transactions WHERE expires_at <= $1 RETURNING 1
        ), pagination AS (
          DELETE FROM mail_pagination_sessions WHERE expires_at <= $1 RETURNING 1
        ), expired_sessions AS (
          DELETE FROM sessions
          WHERE expires_at <= $1 OR (revoked_at IS NOT NULL AND revoked_at < $1 - INTERVAL '7 days')
          RETURNING 1
        ), limits AS (
          DELETE FROM rate_limit_buckets WHERE expires_at <= $1 RETURNING 1
        ), old_events AS (
          DELETE FROM security_events
          WHERE occurred_at < $1 - INTERVAL '90 days'
          RETURNING 1
        )
        SELECT
          (SELECT count(*) FROM oauth) AS oauth_count,
          (SELECT count(*) FROM identity_oauth) AS identity_oauth_count,
          (SELECT count(*) FROM pagination) AS pagination_count,
          (SELECT count(*) FROM expired_sessions) AS session_count,
          (SELECT count(*) FROM limits) AS limit_count,
          (SELECT count(*) FROM old_events) AS security_event_count
      `,
      [now],
    );
    const row = requireRow(rows, "Maintenance cleanup did not return counts");
    return {
      oauthTransactions: requiredInteger(row.oauth_count, "oauth_count"),
      identityOAuthTransactions: requiredInteger(
        row.identity_oauth_count,
        "identity_oauth_count",
      ),
      paginationSessions: requiredInteger(
        row.pagination_count,
        "pagination_count",
      ),
      sessions: requiredInteger(row.session_count, "session_count"),
      rateLimits: requiredInteger(row.limit_count, "limit_count"),
      securityEvents: requiredInteger(
        row.security_event_count,
        "security_event_count",
      ),
    };
  }
}

const mailConnectionColumns = `
  id,
  owner_id,
  provider,
  provider_account_id,
  email_address,
  label,
  status,
  scopes,
  credentials_ciphertext,
  credentials_iv,
  credentials_key_version,
  access_expires_at,
  token_version,
  provider_metadata,
  last_error_code,
  created_at,
  updated_at,
  connected_at,
  last_refreshed_at,
  disconnected_at
`;

const mailConnectionSelect = `SELECT ${mailConnectionColumns} FROM mail_connections`;

interface MailOAuthTransactionRow extends DatabaseRow {
  id: unknown;
  owner_id: unknown;
  session_id: unknown;
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

interface MailConnectionRow extends DatabaseRow {
  id: unknown;
  owner_id: unknown;
  provider: unknown;
  provider_account_id: unknown;
  email_address: unknown;
  label: unknown;
  status: unknown;
  scopes: unknown;
  credentials_ciphertext: unknown;
  credentials_iv: unknown;
  credentials_key_version: unknown;
  access_expires_at: unknown;
  token_version: unknown;
  provider_metadata: unknown;
  last_error_code: unknown;
  created_at: unknown;
  updated_at: unknown;
  connected_at: unknown;
  last_refreshed_at: unknown;
  disconnected_at: unknown;
}

interface RateLimitRow extends DatabaseRow {
  request_count: unknown;
  expires_at: unknown;
}

interface CleanupRow extends DatabaseRow {
  oauth_count: unknown;
  identity_oauth_count: unknown;
  pagination_count: unknown;
  session_count: unknown;
  limit_count: unknown;
  security_event_count: unknown;
}

function toOAuthTransaction(row: MailOAuthTransactionRow): MailOAuthTransaction {
  return {
    id: requiredString(row.id, "mail_oauth_transactions.id"),
    ownerId: requiredString(row.owner_id, "mail_oauth_transactions.owner_id"),
    sessionId: requiredString(row.session_id, "mail_oauth_transactions.session_id"),
    provider: row.provider as MailConnectionProvider,
    stateDigest: requiredString(row.state_digest, "mail_oauth_transactions.state_digest"),
    browserBindingDigest: requiredString(
      row.browser_binding_digest,
      "mail_oauth_transactions.browser_binding_digest",
    ),
    codeVerifierEnvelope: {
      algorithm: "A256GCM",
      ciphertext: requiredString(
        row.code_verifier_ciphertext,
        "mail_oauth_transactions.code_verifier_ciphertext",
      ),
      iv: requiredString(row.code_verifier_iv, "mail_oauth_transactions.code_verifier_iv"),
      keyVersion: requiredPositiveInteger(
        row.code_verifier_key_version,
        "mail_oauth_transactions.code_verifier_key_version",
      ),
    },
    redirectUri: requiredString(row.redirect_uri, "mail_oauth_transactions.redirect_uri"),
    returnTo: requiredString(row.return_to, "mail_oauth_transactions.return_to"),
    createdAt: requiredDate(row.created_at, "mail_oauth_transactions.created_at"),
    expiresAt: requiredDate(row.expires_at, "mail_oauth_transactions.expires_at"),
  };
}

function toStoredConnection(row: MailConnectionRow): StoredMailConnection {
  const ciphertext = optionalBytes(row.credentials_ciphertext);
  const iv = optionalBytes(row.credentials_iv);
  const keyVersion = optionalPositiveInteger(row.credentials_key_version);
  const hasCredentials = Boolean(ciphertext && iv && keyVersion);
  return {
    id: requiredString(row.id, "mail_connections.id"),
    ownerId: requiredString(row.owner_id, "mail_connections.owner_id"),
    provider: row.provider as StoredMailConnection["provider"],
    providerAccountId: requiredString(
      row.provider_account_id,
      "mail_connections.provider_account_id",
    ),
    emailAddress: requiredString(row.email_address, "mail_connections.email_address"),
    label: requiredString(row.label, "mail_connections.label"),
    status: row.status as StoredMailConnection["status"],
    scopes: Array.isArray(row.scopes)
      ? row.scopes.map((scope) => requiredString(scope, "mail connection scope"))
      : [],
    credentials: hasCredentials
      ? {
          algorithm: "A256GCM",
          ciphertext: encodeBase64Url(ciphertext!),
          iv: encodeBase64Url(iv!),
          keyVersion: keyVersion!,
        }
      : null,
    accessExpiresAt: optionalDate(row.access_expires_at, "mail_connections.access_expires_at"),
    tokenVersion: requiredNonNegativeInteger(row.token_version, "mail_connections.token_version"),
    providerMetadata: requiredObject(row.provider_metadata, "mail_connections.provider_metadata"),
    lastErrorCode: optionalString(row.last_error_code),
    createdAt: requiredDate(row.created_at, "mail_connections.created_at"),
    updatedAt: requiredDate(row.updated_at, "mail_connections.updated_at"),
    connectedAt: optionalDate(row.connected_at, "mail_connections.connected_at"),
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

function optionalBytes(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === "string" && /^\\x[0-9a-f]+$/i.test(value)) {
    const hex = value.slice(2);
    if (hex.length % 2 !== 0) throw new TypeError("PostgreSQL bytea is malformed");
    return Uint8Array.from(
      Array.from({ length: hex.length / 2 }, (_, index) =>
        Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
      ),
    );
  }
  throw new TypeError("PostgreSQL bytea value is not supported");
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

function requiredInteger(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new TypeError(`${field} must be an integer`);
  return result;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const result = requiredInteger(value, field);
  if (result <= 0) throw new TypeError(`${field} must be positive`);
  return result;
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return requiredPositiveInteger(value, "positive integer");
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  const result = requiredInteger(value, field);
  if (result < 0) throw new TypeError(`${field} must not be negative`);
  return result;
}

function requiredDate(value: unknown, field: string): Date {
  const result = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(result.getTime())) throw new TypeError(`${field} must be a date`);
  return result;
}

function optionalDate(value: unknown, field: string): Date | null {
  return value === null || value === undefined ? null : requiredDate(value, field);
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new TypeError(`${field} must contain JSON`);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
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
