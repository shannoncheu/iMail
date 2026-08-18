import "server-only";

import {
  createNeonQuery,
  type DatabaseQuery,
  type DatabaseRow,
} from "../db/neon";

export type MailDraftIntentMode = "reply" | "forward";
export type MailDraftIntentSourceType = "thread" | "message";

export interface MailDraftIntent {
  ownerId: string;
  connectionId: string;
  draftNativeId: string;
  mode: MailDraftIntentMode;
  sourceType: MailDraftIntentSourceType;
  sourceNativeId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FindMailDraftIntentInput {
  ownerId: string;
  connectionId: string;
  draftNativeId: string;
}

export interface ReplaceMailDraftIntentInput extends FindMailDraftIntentInput {
  previousDraftNativeId?: string;
  mode: MailDraftIntentMode;
  sourceType: MailDraftIntentSourceType;
  sourceNativeId: string;
  updatedAt?: Date;
}

export type MailDraftIntentRepositorySource =
  | { databaseUrl: string; query?: never }
  | { query: DatabaseQuery; databaseUrl?: never };

export class MailDraftIntentRepository {
  private readonly query: DatabaseQuery;

  constructor(source: MailDraftIntentRepositorySource) {
    this.query = source.query ?? createNeonQuery(source.databaseUrl);
  }

  async find(input: FindMailDraftIntentInput): Promise<MailDraftIntent | null> {
    const rows = await this.query<MailDraftIntentRow>(
      `${mailDraftIntentSelect}
       WHERE intent.owner_id = $1
         AND intent.connection_id = $2
         AND intent.draft_native_id = $3
         AND connection.status = 'connected'`,
      [
        input.ownerId,
        input.connectionId,
        requiredNativeId(input.draftNativeId, "draftNativeId"),
      ],
    );
    return rows[0] ? toMailDraftIntent(rows[0]) : null;
  }

  async replace(input: ReplaceMailDraftIntentInput): Promise<MailDraftIntent> {
    const updatedAt = requiredDate(input.updatedAt ?? new Date(), "updatedAt");
    const draftNativeId = requiredNativeId(
      input.draftNativeId,
      "draftNativeId",
    );
    const previousDraftNativeId = requiredNativeId(
      input.previousDraftNativeId ?? draftNativeId,
      "previousDraftNativeId",
    );
    const mode = requiredMode(input.mode);
    const sourceType = requiredSourceType(input.sourceType);
    const sourceNativeId = requiredNativeId(
      input.sourceNativeId,
      "sourceNativeId",
    );
    const rows = await this.query<MailDraftIntentRow>(
      `
        WITH eligible_connection AS (
          SELECT id, owner_id
          FROM mail_connections
          WHERE owner_id = $1
            AND id = $2
            AND status = 'connected'
        ), saved AS (
          INSERT INTO mail_draft_intents (
            owner_id,
            connection_id,
            draft_native_id,
            mode,
            source_type,
            source_native_id,
            created_at,
            updated_at
          )
          SELECT owner_id, id, $4, $5, $6, $7, $8, $8
          FROM eligible_connection
          ON CONFLICT (owner_id, connection_id, draft_native_id)
          DO UPDATE SET
            mode = EXCLUDED.mode,
            source_type = EXCLUDED.source_type,
            source_native_id = EXCLUDED.source_native_id,
            updated_at = EXCLUDED.updated_at
          RETURNING *
        ), removed_previous AS (
          DELETE FROM mail_draft_intents AS previous
          WHERE previous.owner_id = $1
            AND previous.connection_id = $2
            AND previous.draft_native_id = $3
            AND previous.draft_native_id <> $4
            AND EXISTS (SELECT 1 FROM saved)
          RETURNING previous.draft_native_id
        )
        SELECT * FROM saved
      `,
      [
        input.ownerId,
        input.connectionId,
        previousDraftNativeId,
        draftNativeId,
        mode,
        sourceType,
        sourceNativeId,
        updatedAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Mail draft intent was not saved");
    return toMailDraftIntent(row);
  }

  async delete(input: FindMailDraftIntentInput): Promise<boolean> {
    const rows = await this.query<{ draft_native_id: unknown }>(
      `
        DELETE FROM mail_draft_intents
        WHERE owner_id = $1
          AND connection_id = $2
          AND draft_native_id = $3
        RETURNING draft_native_id
      `,
      [
        input.ownerId,
        input.connectionId,
        requiredNativeId(input.draftNativeId, "draftNativeId"),
      ],
    );
    return rows.length > 0;
  }
}

const mailDraftIntentSelect = `
  SELECT
    intent.owner_id,
    intent.connection_id,
    intent.draft_native_id,
    intent.mode,
    intent.source_type,
    intent.source_native_id,
    intent.created_at,
    intent.updated_at
  FROM mail_draft_intents AS intent
  JOIN mail_connections AS connection
    ON connection.id = intent.connection_id
   AND connection.owner_id = intent.owner_id
`;

interface MailDraftIntentRow extends DatabaseRow {
  owner_id: unknown;
  connection_id: unknown;
  draft_native_id: unknown;
  mode: unknown;
  source_type: unknown;
  source_native_id: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function toMailDraftIntent(row: MailDraftIntentRow): MailDraftIntent {
  return {
    ownerId: requiredString(row.owner_id, "mail_draft_intents.owner_id"),
    connectionId: requiredString(
      row.connection_id,
      "mail_draft_intents.connection_id",
    ),
    draftNativeId: requiredNativeId(
      row.draft_native_id,
      "mail_draft_intents.draft_native_id",
    ),
    mode: requiredMode(row.mode),
    sourceType: requiredSourceType(row.source_type),
    sourceNativeId: requiredNativeId(
      row.source_native_id,
      "mail_draft_intents.source_native_id",
    ),
    createdAt: requiredDate(row.created_at, "mail_draft_intents.created_at"),
    updatedAt: requiredDate(row.updated_at, "mail_draft_intents.updated_at"),
  };
}

function requiredMode(value: unknown): MailDraftIntentMode {
  if (value !== "reply" && value !== "forward") {
    throw new TypeError("Mail draft intent mode is invalid");
  }
  return value;
}

function requiredSourceType(value: unknown): MailDraftIntentSourceType {
  if (value !== "thread" && value !== "message") {
    throw new TypeError("Mail draft intent source type is invalid");
  }
  return value;
}

function requiredNativeId(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (result.length > 4_096) throw new TypeError(`${field} is too long`);
  return result;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredDate(value: unknown, field: string): Date {
  const result = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(result.getTime())) throw new TypeError(`${field} must be a date`);
  return result;
}
