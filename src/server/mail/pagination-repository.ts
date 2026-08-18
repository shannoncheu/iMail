import "server-only";

import type { EncryptedSecretEnvelope } from "../auth/types";
import {
  createNeonQuery,
  type DatabaseQuery,
  type DatabaseRow,
} from "../db/neon";
import { decodeBase64Url, encodeBase64Url } from "../security/crypto";

export const MAIL_PAGINATION_SESSION_TTL_MS = 15 * 60 * 1_000;

// pagination-vault.ts limits plaintext to 512 KiB; AES-GCM appends a 16-byte tag.
const maximumStateCiphertextBytes = 512 * 1_024 + 16;
const sha256Base64UrlPattern = /^[A-Za-z0-9_-]{43}$/u;

export interface MailPaginationSession {
  id: string;
  ownerId: string;
  queryFingerprint: string;
  revision: number;
  stateEnvelope: EncryptedSecretEnvelope;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export type StoredMailPaginationSession = MailPaginationSession;

export interface CreateMailPaginationSessionInput {
  id?: string;
  ownerId: string;
  queryFingerprint: string;
  stateEnvelope: EncryptedSecretEnvelope;
  createdAt?: Date;
}

export interface FindMailPaginationSessionInput {
  id: string;
  ownerId: string;
  queryFingerprint: string;
  activeAt?: Date;
}

export interface AdvanceMailPaginationSessionInput {
  id: string;
  ownerId: string;
  queryFingerprint: string;
  expectedRevision: number;
  stateEnvelope: EncryptedSecretEnvelope;
  activeAt?: Date;
}

export interface DeleteMailPaginationSessionInput {
  id: string;
  ownerId: string;
}

export type MailPaginationRepositorySource =
  | { databaseUrl: string; query?: never }
  | { query: DatabaseQuery; databaseUrl?: never };

export class MailPaginationRepository {
  private readonly query: DatabaseQuery;

  constructor(source: MailPaginationRepositorySource) {
    this.query = source.query ?? createNeonQuery(source.databaseUrl);
  }

  async create(
    input: CreateMailPaginationSessionInput,
  ): Promise<MailPaginationSession> {
    const id = input.id ?? crypto.randomUUID();
    const createdAt = requiredDate(input.createdAt ?? new Date(), "createdAt");
    const expiresAt = new Date(
      createdAt.getTime() + MAIL_PAGINATION_SESSION_TTL_MS,
    );
    const queryFingerprint = requireQueryFingerprint(input.queryFingerprint);
    const envelope = envelopeBytes(input.stateEnvelope);
    const rows = await this.query<MailPaginationSessionRow>(
      `
        INSERT INTO mail_pagination_sessions (
          id,
          owner_id,
          query_fingerprint,
          revision,
          state_ciphertext,
          state_iv,
          state_key_version,
          created_at,
          updated_at,
          expires_at
        )
        SELECT $1, owner.id, $3, 0, $4, $5, $6, $7, $7, $8
        FROM owners AS owner
        WHERE owner.id = $2
          AND owner.disabled_at IS NULL
        RETURNING *
      `,
      [
        id,
        input.ownerId,
        queryFingerprint,
        envelope.ciphertext,
        envelope.iv,
        envelope.keyVersion,
        createdAt,
        expiresAt,
      ],
    );
    return requireRow(
      rows,
      "Mail pagination session was not created",
      toMailPaginationSession,
    );
  }

  async find(
    input: FindMailPaginationSessionInput,
  ): Promise<MailPaginationSession | null> {
    const activeAt = requiredDate(input.activeAt ?? new Date(), "activeAt");
    const rows = await this.query<MailPaginationSessionRow>(
      `${mailPaginationSessionSelect}
       WHERE session.owner_id = $1
         AND session.id = $2
         AND session.query_fingerprint = $3
         AND session.expires_at > $4
         AND session.expires_at > CURRENT_TIMESTAMP
         AND owner.disabled_at IS NULL`,
      [
        input.ownerId,
        input.id,
        requireQueryFingerprint(input.queryFingerprint),
        activeAt,
      ],
    );
    return rows[0] ? toMailPaginationSession(rows[0]) : null;
  }

  async advance(
    input: AdvanceMailPaginationSessionInput,
  ): Promise<MailPaginationSession | null> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new TypeError("expectedRevision must be a non-negative integer");
    }
    const activeAt = requiredDate(input.activeAt ?? new Date(), "activeAt");
    const envelope = envelopeBytes(input.stateEnvelope);
    const rows = await this.query<MailPaginationSessionRow>(
      `
        UPDATE mail_pagination_sessions AS session
        SET revision = session.revision + 1,
            state_ciphertext = $5,
            state_iv = $6,
            state_key_version = $7,
            updated_at = $8
        FROM owners AS owner
        WHERE session.owner_id = $1
          AND session.id = $2
          AND session.query_fingerprint = $3
          AND session.revision = $4
          AND session.expires_at > $8
          AND session.expires_at > CURRENT_TIMESTAMP
          AND owner.id = session.owner_id
          AND owner.disabled_at IS NULL
        RETURNING session.*
      `,
      [
        input.ownerId,
        input.id,
        requireQueryFingerprint(input.queryFingerprint),
        input.expectedRevision,
        envelope.ciphertext,
        envelope.iv,
        envelope.keyVersion,
        activeAt,
      ],
    );
    return rows[0] ? toMailPaginationSession(rows[0]) : null;
  }

  async delete(input: DeleteMailPaginationSessionInput): Promise<boolean> {
    const rows = await this.query<{ id: unknown }>(
      `
        DELETE FROM mail_pagination_sessions
        WHERE owner_id = $1 AND id = $2
        RETURNING id
      `,
      [input.ownerId, input.id],
    );
    return rows.length > 0;
  }
}

const mailPaginationSessionColumns = `
  session.id,
  session.owner_id,
  session.query_fingerprint,
  session.revision,
  session.state_ciphertext,
  session.state_iv,
  session.state_key_version,
  session.created_at,
  session.updated_at,
  session.expires_at
`;

const mailPaginationSessionSelect =
  `SELECT ${mailPaginationSessionColumns}
   FROM mail_pagination_sessions AS session
   JOIN owners AS owner ON owner.id = session.owner_id`;

interface MailPaginationSessionRow extends DatabaseRow {
  id: unknown;
  owner_id: unknown;
  query_fingerprint: unknown;
  revision: unknown;
  state_ciphertext: unknown;
  state_iv: unknown;
  state_key_version: unknown;
  created_at: unknown;
  updated_at: unknown;
  expires_at: unknown;
}

function toMailPaginationSession(
  row: MailPaginationSessionRow,
): MailPaginationSession {
  const ciphertext = requiredBytes(
    row.state_ciphertext,
    "mail_pagination_sessions.state_ciphertext",
  );
  if (
    ciphertext.byteLength < 16 ||
    ciphertext.byteLength > maximumStateCiphertextBytes
  ) {
    throw new TypeError("Stored pagination ciphertext has an invalid size");
  }
  const iv = requiredBytes(row.state_iv, "mail_pagination_sessions.state_iv");
  if (iv.byteLength !== 12) {
    throw new TypeError("Stored pagination IV must contain exactly 12 bytes");
  }
  return {
    id: requiredString(row.id, "mail_pagination_sessions.id"),
    ownerId: requiredString(
      row.owner_id,
      "mail_pagination_sessions.owner_id",
    ),
    queryFingerprint: requireQueryFingerprint(
      requiredString(
        row.query_fingerprint,
        "mail_pagination_sessions.query_fingerprint",
      ),
    ),
    revision: requiredNonNegativeInteger(
      row.revision,
      "mail_pagination_sessions.revision",
    ),
    stateEnvelope: {
      algorithm: "A256GCM",
      ciphertext: encodeBase64Url(ciphertext),
      iv: encodeBase64Url(iv),
      keyVersion: requiredPositiveInteger(
        row.state_key_version,
        "mail_pagination_sessions.state_key_version",
      ),
    },
    createdAt: requiredDate(
      row.created_at,
      "mail_pagination_sessions.created_at",
    ),
    updatedAt: requiredDate(
      row.updated_at,
      "mail_pagination_sessions.updated_at",
    ),
    expiresAt: requiredDate(
      row.expires_at,
      "mail_pagination_sessions.expires_at",
    ),
  };
}

function envelopeBytes(envelope: EncryptedSecretEnvelope): {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  keyVersion: number;
} {
  if (envelope.algorithm !== "A256GCM") {
    throw new TypeError("Pagination state must use A256GCM");
  }
  if (!Number.isSafeInteger(envelope.keyVersion) || envelope.keyVersion <= 0) {
    throw new TypeError("Pagination key version must be a positive integer");
  }
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  const iv = decodeBase64Url(envelope.iv);
  if (
    ciphertext.byteLength < 16 ||
    ciphertext.byteLength > maximumStateCiphertextBytes
  ) {
    throw new TypeError("Pagination ciphertext has an invalid size");
  }
  if (iv.byteLength !== 12) {
    throw new TypeError("Pagination IV must contain exactly 12 bytes");
  }
  return { ciphertext, iv, keyVersion: envelope.keyVersion };
}

function requireQueryFingerprint(value: string): string {
  if (!sha256Base64UrlPattern.test(value)) {
    throw new TypeError("Mail pagination query fingerprint is invalid");
  }
  return value;
}

function requiredBytes(value: unknown, field: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === "string" && /^\\x[0-9a-f]+$/iu.test(value)) {
    const hex = value.slice(2);
    if (hex.length % 2 !== 0) throw new TypeError(`${field} is malformed`);
    return Uint8Array.from(
      Array.from({ length: hex.length / 2 }, (_, index) =>
        Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
      ),
    );
  }
  throw new TypeError(`${field} is not a supported PostgreSQL bytea value`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`${field} must be an integer`);
  }
  return result;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const result = requiredInteger(value, field);
  if (result <= 0) throw new TypeError(`${field} must be positive`);
  return result;
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

function requireRow<Row, Result>(
  rows: Row[],
  message: string,
  transform: (row: Row) => Result,
): Result {
  const row = rows[0];
  if (!row) throw new Error(message);
  return transform(row);
}
