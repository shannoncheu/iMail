import type {
  MailAccount,
  MailAttachment,
  MailDraft,
  MailFolder,
  MailFolderId,
  MailMessagePage,
  MailParticipant,
  MailProvider,
  MailThread,
  MessageLocation,
  MessageQuery,
  OperationResult,
  ProviderCapabilities,
  ProviderSource,
  ThreadMessage,
} from "./MailProvider";

const API_ROOT = "/api/mail";
const MAX_ID_LENGTH = 8_192;
const MAX_CSRF_TOKEN_LENGTH = 4_096;
const MAX_SEARCH_LENGTH = 256;
const MAX_CURSOR_LENGTH = 24_000;
const MAX_PAGE_SIZE = 100;
const MAX_MUTATION_IDS = 200;
const MAX_ATTACHMENT_BASE64_LENGTH = 7 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const PROVIDERS = new Set<ProviderSource>(["gmail", "outlook", "zoho"]);
const FOLDERS = new Set<MailFolderId>([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "archive",
  "spam",
  "trash",
]);
const ATTACHMENT_KINDS = new Set<MailAttachment["kind"]>([
  "document",
  "image",
  "archive",
]);

const DEFAULT_ACCOUNT_PRESENTATION: Readonly<
  Record<
    ProviderSource,
    Readonly<{ color: string; capabilities: ProviderCapabilities }>
  >
> = Object.freeze({
  gmail: {
    color: "#d96555",
    capabilities: {
      labels: true,
      reliableDraftUpdates: true,
      externalImages: true,
      permanentDelete: false,
    },
  },
  outlook: {
    color: "#4f7fdc",
    capabilities: {
      labels: false,
      reliableDraftUpdates: true,
      externalImages: true,
      permanentDelete: true,
    },
  },
  zoho: {
    color: "#e42527",
    capabilities: {
      labels: true,
      reliableDraftUpdates: false,
      externalImages: true,
      permanentDelete: true,
    },
  },
});

export interface ApiMailProviderOptions {
  csrfToken: string;
  fetchImplementation?: typeof fetch;
}

export class ApiMailProviderError extends Error {
  readonly code = "MAIL_API_REQUEST_FAILED";

  constructor(
    readonly status: number,
    readonly reason: string,
    readonly retryAfterSeconds: number | null = null,
    message = errorMessageForStatus(status),
  ) {
    super(message);
    this.name = "ApiMailProviderError";
  }
}

function errorMessageForStatus(status: number): string {
  if (status === 0) return "The mail service could not be reached";
  if (status === 400) return "The mail request was rejected";
  if (status === 401) return "Sign in is required";
  if (status === 403) return "The mail request is not allowed";
  if (status === 404) return "The requested mail item was not found";
  if (status === 409) return "The mailbox changed before the request completed";
  if (status === 413) return "The mail request is too large";
  if (status === 429) return "Too many mail requests were sent";
  if (status >= 500) return "The mail service is temporarily unavailable";
  return "The mail request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse(field);
  return value;
}

function requiredArray(
  value: unknown,
  field: string,
  maximumLength: number,
): unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw invalidResponse(field);
  }
  return value;
}

function requiredString(
  value: unknown,
  field: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || value.length > maximumLength) {
    throw invalidResponse(field);
  }
  if (!allowEmpty && !value.trim()) throw invalidResponse(field);
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field, maximumLength, true);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalidResponse(field);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredBoolean(value, field);
}

function optionalNonnegativeInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidResponse(field);
  }
  return value as number;
}

function requiredSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw invalidResponse(field);
  return value as number;
}

function invalidResponse(field: string): ApiMailProviderError {
  return new ApiMailProviderError(
    502,
    "invalid_response",
    null,
    `The mail service returned an invalid ${field}`,
  );
}

function parseProvider(value: unknown, field = "provider"): ProviderSource {
  if (typeof value !== "string" || !PROVIDERS.has(value as ProviderSource)) {
    throw invalidResponse(field);
  }
  return value as ProviderSource;
}

function parseFolderId(value: unknown, field = "folder id"): MailFolderId {
  if (typeof value !== "string" || !FOLDERS.has(value as MailFolderId)) {
    throw invalidResponse(field);
  }
  return value as MailFolderId;
}

function parseCapabilities(
  value: unknown,
  provider: ProviderSource,
): ProviderCapabilities {
  if (value === undefined || value === null) {
    return { ...DEFAULT_ACCOUNT_PRESENTATION[provider].capabilities };
  }
  const record = requiredRecord(value, "provider capabilities");
  return {
    labels: requiredBoolean(record.labels, "labels capability"),
    reliableDraftUpdates: requiredBoolean(
      record.reliableDraftUpdates,
      "draft capability",
    ),
    externalImages: requiredBoolean(
      record.externalImages,
      "external image capability",
    ),
    permanentDelete: requiredBoolean(
      record.permanentDelete,
      "delete capability",
    ),
  };
}

function parseAccount(value: unknown): MailAccount {
  const record = requiredRecord(value, "mail account");
  const provider = parseProvider(record.provider);
  const address = requiredString(
    record.address ?? record.emailAddress,
    "account address",
    320,
  );
  const status = optionalString(record.status, "account status", 64);
  const connected =
    record.connected === undefined
      ? status === undefined || status === "connected"
      : requiredBoolean(record.connected, "account connection state");
  return {
    id: requiredString(record.id, "account id", MAX_ID_LENGTH),
    provider,
    label: requiredString(record.label, "account label", 200),
    address,
    color:
      optionalString(record.color, "account color", 64) ??
      DEFAULT_ACCOUNT_PRESENTATION[provider].color,
    connected,
    capabilities: parseCapabilities(record.capabilities, provider),
  };
}

function parseFolder(value: unknown): MailFolder {
  const record = requiredRecord(value, "mail folder");
  const count = optionalNonnegativeInteger(record.count, "folder count");
  return {
    id: parseFolderId(record.id),
    label: requiredString(record.label, "folder label", 200),
    ...(count !== undefined ? { count } : {}),
  };
}

function parseParticipant(value: unknown): MailParticipant {
  const record = requiredRecord(value, "mail participant");
  return {
    name: requiredString(record.name, "participant name", 512, true),
    email: requiredString(record.email, "participant address", 320),
  };
}

function sameOriginMailUrl(value: unknown, field: string): string | undefined {
  const candidate = optionalString(value, field, 8_192);
  if (candidate === undefined) return undefined;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) {
    throw invalidResponse(field);
  }
  const parsed = new URL(candidate, "https://imail.invalid");
  if (
    parsed.origin !== "https://imail.invalid" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !parsed.pathname.startsWith(`${API_ROOT}/`)
  ) {
    throw invalidResponse(field);
  }
  return `${parsed.pathname}${parsed.search}`;
}

function parseAttachment(value: unknown): MailAttachment {
  const record = requiredRecord(value, "mail attachment");
  const kind = requiredString(record.kind, "attachment kind", 32);
  if (!ATTACHMENT_KINDS.has(kind as MailAttachment["kind"])) {
    throw invalidResponse("attachment kind");
  }
  const mimeType = optionalString(record.mimeType, "attachment MIME type", 255);
  const sizeBytes = optionalNonnegativeInteger(
    record.sizeBytes,
    "attachment byte size",
  );
  const downloadUrl = sameOriginMailUrl(
    record.downloadUrl,
    "attachment download URL",
  );
  const inline = optionalBoolean(record.inline, "attachment inline state");
  const contentId = optionalString(record.contentId, "attachment content id", 998);
  return {
    id: requiredString(record.id, "attachment id", MAX_ID_LENGTH),
    name: requiredString(record.name, "attachment name", 512),
    size: requiredString(record.size, "attachment size", 64),
    kind: kind as MailAttachment["kind"],
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(downloadUrl !== undefined ? { downloadUrl } : {}),
    ...(inline !== undefined ? { inline } : {}),
    ...(contentId !== undefined ? { contentId } : {}),
  };
}

function parseDraft(value: unknown): MailDraft {
  const record = requiredRecord(value, "mail draft");
  const recipients = (value: unknown, field: string) =>
    requiredArray(value, field, 200).map((address) =>
      requiredString(address, field, 320),
    );
  let composeIntent: MailDraft["composeIntent"];
  if (record.composeIntent !== undefined) {
    const intent = requiredRecord(record.composeIntent, "draft compose intent");
    if (intent.mode !== "reply" && intent.mode !== "forward") {
      throw new TypeError("Invalid draft compose intent mode");
    }
    composeIntent = {
      mode: intent.mode,
      sourceId: requiredString(
        intent.sourceId,
        "draft compose intent source",
        MAX_ID_LENGTH,
      ),
    };
  }
  return {
    id: requiredString(record.id, "draft id", MAX_ID_LENGTH),
    accountId: inputAccountId(record.accountId, "draft account id"),
    to: recipients(record.to, "draft To recipients"),
    cc: recipients(record.cc, "draft Cc recipients"),
    bcc: recipients(record.bcc, "draft Bcc recipients"),
    subject: requiredString(record.subject, "draft subject", 998, true),
    body: requiredString(record.body, "draft body", 1_000_000, true),
    attachments: requiredArray(
      record.attachments,
      "draft attachments",
      10,
    ).map(parseAttachment),
    ...(composeIntent ? { composeIntent } : {}),
  };
}

function parseThreadMessage(value: unknown): ThreadMessage {
  const record = requiredRecord(value, "thread message");
  const contentUrl = sameOriginMailUrl(record.contentUrl, "message content URL");
  return {
    id: requiredString(record.id, "message id", MAX_ID_LENGTH),
    sender: parseParticipant(record.sender),
    recipients: requiredArray(record.recipients, "message recipients", 1_000).map(
      parseParticipant,
    ),
    sentAt: requiredString(record.sentAt, "message date", 200, true),
    sentAtFull: requiredString(record.sentAtFull, "full message date", 200, true),
    body: requiredArray(record.body, "message body", 10_000).map((paragraph) =>
      requiredString(paragraph, "message paragraph", 1_000_000, true),
    ),
    ...(contentUrl !== undefined ? { contentUrl } : {}),
    attachments: requiredArray(
      record.attachments,
      "message attachments",
      1_000,
    ).map(parseAttachment),
  };
}

function parseThread(value: unknown): MailThread {
  const record = requiredRecord(value, "mail thread");
  return {
    id: requiredString(record.id, "thread id", MAX_ID_LENGTH),
    provider: parseProvider(record.provider),
    accountId: requiredString(record.accountId, "thread account id", MAX_ID_LENGTH),
    folder: parseFolderId(record.folder, "thread folder"),
    sender: parseParticipant(record.sender),
    subject: requiredString(record.subject, "thread subject", 998, true),
    preview: requiredString(record.preview, "thread preview", 100_000, true),
    receivedAt: requiredString(record.receivedAt, "thread date", 200, true),
    receivedAtFull: requiredString(
      record.receivedAtFull,
      "full thread date",
      200,
      true,
    ),
    receivedAtMs: requiredSafeInteger(
      record.receivedAtMs,
      "thread timestamp",
    ),
    unread: requiredBoolean(record.unread, "thread unread state"),
    starred: requiredBoolean(record.starred, "thread starred state"),
    labels: requiredArray(record.labels, "thread labels", 1_000).map((label) =>
      requiredString(label, "thread label", 512),
    ),
    hasExternalImages: requiredBoolean(
      record.hasExternalImages,
      "thread external image state",
    ),
    messages: requiredArray(record.messages, "thread messages", 1_000).map(
      parseThreadMessage,
    ),
  };
}

function parseMessageLocation(value: unknown): MessageLocation {
  const record = requiredRecord(value, "message location");
  return {
    id: requiredString(record.id, "message location id", MAX_ID_LENGTH),
    folder: parseFolderId(record.folder, "message location folder"),
  };
}

function parseOperationResult(value: unknown): OperationResult {
  const record = requiredRecord(value, "operation result");
  const previous = record.previousLocations;
  return {
    succeeded: requiredArray(record.succeeded, "successful operation ids", 10_000).map(
      (id) => requiredString(id, "successful operation id", MAX_ID_LENGTH),
    ),
    failed: requiredArray(record.failed, "failed operations", 10_000).map(
      (failure) => {
        const item = requiredRecord(failure, "failed operation");
        return {
          id: requiredString(item.id, "failed operation id", MAX_ID_LENGTH),
          reason: requiredString(item.reason, "failed operation reason", 1_024),
        };
      },
    ),
    ...(previous === undefined
      ? {}
      : {
          previousLocations: requiredArray(
            previous,
            "previous message locations",
            10_000,
          ).map(parseMessageLocation),
        }),
  };
}

function parseReason(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(value)) {
    return "mail_request_failed";
  }
  return value;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value || !/^\d{1,8}$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

function inputString(
  value: unknown,
  field: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    (!allowEmpty && !value.trim())
  ) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value;
}

function inputId(value: unknown, field = "message id"): string {
  return inputString(value, field, MAX_ID_LENGTH);
}

function inputAccountId(value: unknown, field = "draft account id"): string {
  const id = inputString(value, field, 128);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new TypeError(`Invalid ${field}`);
  }
  return id;
}

function serializeAttachment(attachment: MailAttachment): Record<string, unknown> {
  const contentBase64 = attachment.contentBase64;
  if (
    contentBase64 !== undefined &&
    (typeof contentBase64 !== "string" ||
      !contentBase64 ||
      contentBase64.length > MAX_ATTACHMENT_BASE64_LENGTH ||
      contentBase64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        contentBase64,
      ))
  ) {
    throw new TypeError("Invalid attachment content");
  }
  const kind = inputString(attachment.kind, "attachment kind", 32);
  if (!ATTACHMENT_KINDS.has(kind as MailAttachment["kind"])) {
    throw new TypeError("Invalid attachment kind");
  }
  if (
    attachment.sizeBytes !== undefined &&
    (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0)
  ) {
    throw new TypeError("Invalid attachment byte size");
  }
  if (attachment.inline !== undefined && typeof attachment.inline !== "boolean") {
    throw new TypeError("Invalid attachment inline state");
  }
  return {
    id: inputString(attachment.id, "attachment id", MAX_ID_LENGTH),
    name: inputString(attachment.name, "attachment name", 512),
    size: inputString(attachment.size, "attachment size", 64),
    kind,
    ...(attachment.mimeType
      ? { mimeType: inputString(attachment.mimeType, "attachment MIME type", 255) }
      : {}),
    ...(attachment.sizeBytes !== undefined
      ? { sizeBytes: attachment.sizeBytes }
      : {}),
    ...(attachment.inline !== undefined ? { inline: attachment.inline } : {}),
    ...(attachment.contentId
      ? { contentId: inputString(attachment.contentId, "attachment content id", 998) }
      : {}),
    ...(contentBase64 !== undefined ? { contentBase64 } : {}),
  };
}

function serializeDraft(draft: MailDraft): Record<string, unknown> {
  const recipients = (values: string[], field: string) => {
    if (!Array.isArray(values) || values.length > 200) {
      throw new TypeError(`Invalid ${field}`);
    }
    return values.map((address) => {
      const normalized = inputString(address, field, 320);
      if (!/^\S+@\S+$/u.test(normalized) || /[\r\n]/u.test(normalized)) {
        throw new TypeError(`Invalid ${field}`);
      }
      return normalized;
    });
  };
  if (!Array.isArray(draft.attachments) || draft.attachments.length > 10) {
    throw new TypeError("Invalid draft attachments");
  }
  const attachments = draft.attachments.map(serializeAttachment);
  const totalAttachmentBytes = attachments.reduce((total, attachment) => {
    const content = attachment.contentBase64;
    return typeof content === "string"
      ? total + decodedBase64ByteLength(content)
      : total;
  }, 0);
  if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new TypeError("Draft attachments are too large");
  }
  let composeIntent: Record<string, string> | undefined;
  if (draft.composeIntent) {
    if (
      draft.composeIntent.mode !== "reply" &&
      draft.composeIntent.mode !== "forward"
    ) {
      throw new TypeError("Invalid draft compose intent mode");
    }
    composeIntent = {
      mode: draft.composeIntent.mode,
      sourceId: inputId(
        draft.composeIntent.sourceId,
        "draft compose intent source",
      ),
    };
  }
  return {
    ...(draft.id ? { id: inputId(draft.id, "draft id") } : {}),
    accountId: inputAccountId(draft.accountId),
    to: recipients(draft.to, "To recipient"),
    cc: recipients(draft.cc, "Cc recipient"),
    bcc: recipients(draft.bcc, "Bcc recipient"),
    subject: inputString(draft.subject, "draft subject", 998, true),
    body: inputString(draft.body, "draft body", 1_000_000, true),
    attachments,
    ...(composeIntent ? { composeIntent } : {}),
  };
}

function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function serializeIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length > MAX_MUTATION_IDS) {
    throw new TypeError("Invalid message id list");
  }
  return Array.from(new Set(ids.map((id) => inputId(id))));
}

export class ApiMailProvider implements MailProvider {
  private readonly csrfToken: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: Readonly<ApiMailProviderOptions>) {
    if (
      typeof options.csrfToken !== "string" ||
      !options.csrfToken ||
      options.csrfToken.length > MAX_CSRF_TOKEN_LENGTH ||
      /[\r\n]/u.test(options.csrfToken)
    ) {
      throw new TypeError("A valid CSRF token is required");
    }
    if (
      options.fetchImplementation !== undefined &&
      typeof options.fetchImplementation !== "function"
    ) {
      throw new TypeError("A valid fetch implementation is required");
    }
    this.csrfToken = options.csrfToken;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async getAccounts(): Promise<MailAccount[]> {
    const payload = requiredRecord(
      await this.get(`${API_ROOT}/accounts`),
      "account response",
    );
    return requiredArray(payload.accounts, "account list", 1_000).map(parseAccount);
  }

  async getFolders(
    scope: "all" | ProviderSource,
    accountId?: string,
  ): Promise<MailFolder[]> {
    const parameters = new URLSearchParams({ scope: this.inputScope(scope) });
    this.appendAccountFilter(parameters, scope, accountId);
    const payload = requiredRecord(
      await this.get(`${API_ROOT}/folders?${parameters}`),
      "folder response",
    );
    return requiredArray(payload.folders, "folder list", 1_000).map(parseFolder);
  }

  async getMessages(query: MessageQuery): Promise<MailThread[]> {
    return (await this.getMessagesPage(query)).messages;
  }

  async getMessagesPage(query: MessageQuery): Promise<MailMessagePage> {
    const parameters = this.queryParameters(query);
    const payload = requiredRecord(
      await this.get(`${API_ROOT}/messages?${parameters}`),
      "message response",
    );
    const nextCursor = optionalString(
      payload.nextCursor,
      "next message cursor",
      MAX_CURSOR_LENGTH,
    );
    const partial = optionalBoolean(payload.partial, "partial message state");
    const accountErrors =
      payload.accountErrors === undefined
        ? undefined
        : requiredArray(payload.accountErrors, "account error list", 5).map(
            (value) => {
              const error = requiredRecord(value, "account error");
              const code = requiredString(error.code, "account error code", 64);
              if (code !== "provider_unavailable") {
                throw invalidResponse("account error code");
              }
              return {
                accountId: inputAccountId(error.accountId),
                code,
              } as const;
            },
          );
    return {
      messages: requiredArray(payload.messages, "message list", 1_000).map(
        parseThread,
      ),
      ...(nextCursor ? { nextCursor } : {}),
      ...(partial !== undefined ? { partial } : {}),
      ...(accountErrors ? { accountErrors } : {}),
    };
  }

  async getMessage(id: string): Promise<MailThread | null> {
    const parameters = new URLSearchParams({ id: inputId(id) });
    try {
      const payload = requiredRecord(
        await this.get(`${API_ROOT}/message?${parameters}`),
        "single message response",
      );
      return payload.message === null ? null : parseThread(payload.message);
    } catch (error) {
      if (
        error instanceof ApiMailProviderError &&
        error.status === 404 &&
        error.reason === "not_found"
      ) {
        return null;
      }
      throw error;
    }
  }

  async sendMessage(draft: MailDraft): Promise<{ id: string }> {
    return this.parseCreatedMessage(
      await this.post(`${API_ROOT}/send`, serializeDraft(draft)),
    );
  }

  async saveDraft(draft: MailDraft): Promise<{ id: string; savedAt: string }> {
    const payload = requiredRecord(
      await this.post(`${API_ROOT}/drafts`, serializeDraft(draft)),
      "saved draft response",
    );
    return {
      id: requiredString(payload.id, "saved draft id", MAX_ID_LENGTH),
      savedAt: requiredString(payload.savedAt, "draft save date", 200),
    };
  }

  async getDraft(id: string): Promise<MailDraft | null> {
    const parameters = new URLSearchParams({ id: inputId(id, "draft id") });
    try {
      const payload = requiredRecord(
        await this.get(`${API_ROOT}/draft?${parameters}`),
        "draft response",
      );
      return payload.draft === null ? null : parseDraft(payload.draft);
    } catch (error) {
      if (
        error instanceof ApiMailProviderError &&
        error.status === 404 &&
        error.reason === "not_found"
      ) {
        return null;
      }
      throw error;
    }
  }

  async replyMessage(id: string, draft: MailDraft): Promise<{ id: string }> {
    return this.parseCreatedMessage(
      await this.post(`${API_ROOT}/reply`, {
        id: inputId(id),
        draft: serializeDraft(draft),
      }),
    );
  }

  async forwardMessage(id: string, draft: MailDraft): Promise<{ id: string }> {
    return this.parseCreatedMessage(
      await this.post(`${API_ROOT}/forward`, {
        id: inputId(id),
        draft: serializeDraft(draft),
      }),
    );
  }

  async archiveMessages(ids: string[]): Promise<OperationResult> {
    return this.mutateIds("archive", ids);
  }

  async moveToTrash(ids: string[]): Promise<OperationResult> {
    return this.mutateIds("trash", ids);
  }

  async restoreFromTrash(ids: string[]): Promise<OperationResult> {
    return this.mutateIds("restoreTrash", ids);
  }

  async restoreMessages(locations: MessageLocation[]): Promise<OperationResult> {
    if (!Array.isArray(locations) || locations.length > MAX_MUTATION_IDS) {
      throw new TypeError("Invalid message locations");
    }
    if (locations.length === 0) return { succeeded: [], failed: [] };
    return this.mutate({
      action: "restore",
      locations: locations.map((location) => ({
        id: inputId(location.id),
        folder: this.inputFolder(location.folder),
      })),
    });
  }

  async markRead(ids: string[], read: boolean): Promise<OperationResult> {
    if (typeof read !== "boolean") throw new TypeError("Invalid read state");
    const serialized = serializeIds(ids);
    if (serialized.length === 0) return { succeeded: [], failed: [] };
    return this.mutate({ action: "read", ids: serialized, read });
  }

  async setStarred(id: string, starred: boolean): Promise<OperationResult> {
    if (typeof starred !== "boolean") throw new TypeError("Invalid starred state");
    return this.mutate({
      action: "star",
      id: inputId(id),
      starred,
    });
  }

  async searchMessages(query: MessageQuery): Promise<MailThread[]> {
    return (await this.getMessagesPage(query)).messages;
  }

  private async mutate(body: Record<string, unknown>): Promise<OperationResult> {
    return parseOperationResult(await this.post(`${API_ROOT}/mutate`, body));
  }

  private async mutateIds(
    action: "archive" | "trash" | "restoreTrash",
    ids: string[],
  ): Promise<OperationResult> {
    const serialized = serializeIds(ids);
    if (serialized.length === 0) return { succeeded: [], failed: [] };
    return this.mutate({ action, ids: serialized });
  }

  private parseCreatedMessage(value: unknown): { id: string } {
    const payload = requiredRecord(value, "created message response");
    return { id: requiredString(payload.id, "created message id", MAX_ID_LENGTH) };
  }

  private queryParameters(query: MessageQuery): URLSearchParams {
    const parameters = new URLSearchParams({
      scope: this.inputScope(query.scope),
      folder: this.inputFolder(query.folder),
    });
    this.appendAccountFilter(parameters, query.scope, query.accountId);
    if (query.search !== undefined) {
      parameters.set(
        "search",
        inputString(query.search, "message search", MAX_SEARCH_LENGTH, true),
      );
    }
    if (query.cursor !== undefined) {
      parameters.set(
        "cursor",
        inputString(query.cursor, "message cursor", MAX_CURSOR_LENGTH),
      );
    }
    if (query.pageSize !== undefined) {
      if (
        !Number.isInteger(query.pageSize) ||
        query.pageSize < 1 ||
        query.pageSize > MAX_PAGE_SIZE
      ) {
        throw new TypeError("Invalid message page size");
      }
      parameters.set("pageSize", String(query.pageSize));
    }
    return parameters;
  }

  private appendAccountFilter(
    parameters: URLSearchParams,
    scope: "all" | ProviderSource,
    accountId: string | undefined,
  ): void {
    if (accountId === undefined) return;
    if (scope === "all") {
      throw new TypeError("An account filter requires a provider scope");
    }
    parameters.set(
      "accountId",
      inputAccountId(accountId, "mail account filter id"),
    );
  }

  private inputScope(value: unknown): "all" | ProviderSource {
    if (value === "all") return value;
    if (typeof value === "string" && PROVIDERS.has(value as ProviderSource)) {
      return value as ProviderSource;
    }
    throw new TypeError("Invalid mail scope");
  }

  private inputFolder(value: unknown): MailFolderId {
    if (typeof value === "string" && FOLDERS.has(value as MailFolderId)) {
      return value as MailFolderId;
    }
    throw new TypeError("Invalid mail folder");
  }

  private async get(path: string): Promise<unknown> {
    return this.request(path, { method: "GET" });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": this.csrfToken,
      },
      body: JSON.stringify(body),
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    if (!path.startsWith(`${API_ROOT}/`) || path.startsWith("//")) {
      throw new TypeError("Invalid mail API path");
    }
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    let response: Response;
    try {
      response = await this.fetchImplementation(path, {
        ...init,
        headers,
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
    } catch {
      throw new ApiMailProviderError(0, "network_error");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiMailProviderError(
        response.ok ? 502 : response.status,
        "invalid_response",
      );
    }
    if (!response.ok) {
      const record = isRecord(payload) ? payload : undefined;
      throw new ApiMailProviderError(
        response.status,
        parseReason(record?.error),
        parseRetryAfter(response.headers.get("Retry-After")),
      );
    }
    return payload;
  }
}
