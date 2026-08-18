import "server-only";

import type {
  MailAccount,
  MailAttachment,
  MailAttachmentContent,
  MailDraft,
  MailFolder,
  MailFolderId,
  MailMessageContent,
  MailMessagePage,
  MailParticipant,
  MailProvider,
  MailThread,
  MessageLocation,
  MessageQuery,
  OperationResult,
  ThreadMessage,
} from "../../../providers/mail/MailProvider";

const DEFAULT_API_ORIGIN = "https://mail.zoho.com";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_CONTENT_RESPONSE_BYTES =
  MAX_MESSAGE_CONTENT_BYTES * 2 + 64 * 1024;

export const ZOHO_MAIL_API_ORIGINS = Object.freeze([
  "https://mail.zoho.com",
  "https://mail.zoho.eu",
  "https://mail.zoho.in",
  "https://mail.zoho.com.au",
  "https://mail.zoho.jp",
  "https://mail.zohocloud.ca",
  "https://mail.zoho.com.cn",
  "https://mail.zoho.ae",
  "https://mail.zoho.sa",
] as const);

type ZohoApiOrigin = (typeof ZOHO_MAIL_API_ORIGINS)[number];
export type ZohoAccessTokenProvider = (options: {
  forceRefresh: boolean;
}) => string | Promise<string>;
type AccessTokenSource = string | ZohoAccessTokenProvider;

export interface ZohoMailProviderOptions {
  /** Stable local connection id exposed to the application. */
  accountId: string;
  /** Zoho accountId returned by GET /api/accounts. */
  providerAccountId: string;
  /** A callback is preferred so callers can refresh tokens before each request. */
  accessToken: AccessTokenSource;
  apiOrigin?: ZohoApiOrigin | string;
  fetchImplementation?: typeof fetch;
  pageSize?: number;
  requestTimeoutMs?: number;
  now?: () => Date;
}

export class ZohoMailConfigurationError extends Error {
  readonly code = "ZOHO_MAIL_CONFIGURATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ZohoMailConfigurationError";
  }
}

export class ZohoMailApiError extends Error {
  readonly code = "ZOHO_MAIL_API_ERROR";

  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly apiStatus?: number,
  ) {
    super(message);
    this.name = "ZohoMailApiError";
  }
}

interface ZohoFolderRecord {
  folderId: string;
  folderName: string;
  folderType: string;
  path: string;
  normalized?: MailFolderId;
}

interface ZohoMessageSummary {
  messageId: string;
  threadId?: string;
  folderId: string;
  folder: MailFolderId;
  sender: MailParticipant;
  recipients: MailParticipant[];
  subject: string;
  summary: string;
  timestamp: number;
  unread: boolean;
  starred: boolean;
  hasAttachment: boolean;
  hasInline: boolean;
}

interface ZohoMessageReference {
  messageId: string;
  threadId?: string;
  folderId: string;
  folder: MailFolderId;
  summary: ZohoMessageSummary;
}

interface ZohoThreadReference {
  threadId: string;
  latestMessageId: string;
  folderId: string;
  folder: MailFolderId;
}

interface ZohoAttachmentReference {
  messageId: string;
  folderId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface ZohoUploadDescriptor {
  storeName: string;
  attachmentPath: string;
  attachmentName: string;
}

interface ListResult {
  summaries: ZohoMessageSummary[];
  /** Zoho search pagination is message-based, so those pages must stay message-based. */
  messageLevel: boolean;
  nextCursor?: string;
}

interface ZohoListedMessageId {
  folderId: string;
  messageId: string;
}

interface ZohoUpdateTarget {
  inputId: string;
  nativeId: string;
  kind: "message" | "thread";
}

const SYSTEM_FOLDERS: ReadonlyArray<
  Readonly<{ id: MailFolderId; label: string }>
> = Object.freeze([
  { id: "inbox", label: "Inbox" },
  { id: "starred", label: "Starred" },
  { id: "sent", label: "Sent" },
  { id: "drafts", label: "Drafts" },
  { id: "archive", label: "Archive" },
  { id: "spam", label: "Spam" },
  { id: "trash", label: "Trash" },
]);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  gz: "application/gzip",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  tar: "application/x-tar",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return "";
}

function requiredNativeId(value: unknown, field: string): string {
  const id = stringValue(value).trim();
  if (!/^\d{1,128}$/u.test(id)) {
    throw new ZohoMailApiError(`Zoho returned an invalid ${field}`);
  }
  return id;
}

function optionalNativeId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "" || value === 0) {
    return undefined;
  }
  const id = requiredNativeId(value, field);
  return id === "0" ? undefined : id;
}

function requiredText(
  value: unknown,
  field: string,
  maximumLength = 4_096,
): string {
  if (typeof value !== "string") {
    throw new ZohoMailApiError(`Zoho returned an invalid ${field}`);
  }
  const text = value.trim();
  if (!text || text.length > maximumLength) {
    throw new ZohoMailApiError(`Zoho returned an invalid ${field}`);
  }
  return text;
}

function optionalText(value: unknown, maximumLength = 20_000): string {
  if (typeof value !== "string" || value.length > maximumLength) return "";
  return value.trim();
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function truthyProviderValue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

function isUnreadStatus(value: unknown): boolean {
  if (typeof value === "string") {
    const status = value.trim().toLowerCase();
    if (status === "unread" || status === "0") return true;
    if (status === "read" || status === "1") return false;
  }
  return value === 0;
}

function isFlagged(value: unknown): boolean {
  if (value === undefined || value === null || value === 0) return false;
  const flag = stringValue(value).trim().toLowerCase();
  return flag !== "" && flag !== "0" && flag !== "flag_not_set";
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = Object.freeze({
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  });

  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/giu,
    (entity, body: string) => {
      const lowered = body.toLowerCase();
      if (lowered.startsWith("#x")) {
        const codePoint = Number.parseInt(lowered.slice(2), 16);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (lowered.startsWith("#")) {
        const codePoint = Number.parseInt(lowered.slice(1), 10);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return named[lowered] ?? entity;
    },
  );
}

function htmlToPlainText(value: string): string {
  const withoutActiveContent = value
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|head|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<(br|hr)\b[^>]*\/?>/giu, "\n")
    .replace(/<\/(div|p|li|ol|ul|blockquote|h[1-6]|table|tr)>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "• ")
    .replace(/<[^>]+>/gu, " ");

  return decodeHtmlEntities(withoutActiveContent)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function looksLikeHtml(content: string): boolean {
  return /<\/?[a-z][\s\S]*?>/iu.test(content);
}

function splitAddresses(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angleDepth = 0;

  for (const character of decodeHtmlEntities(value)) {
    if (character === '"') quoted = !quoted;
    if (!quoted && character === "<") angleDepth += 1;
    if (!quoted && character === ">" && angleDepth > 0) angleDepth -= 1;
    if (!quoted && angleDepth === 0 && (character === "," || character === ";")) {
      if (current.trim()) entries.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

function participantFromAddress(value: string, fallbackName = ""): MailParticipant {
  const decoded = decodeHtmlEntities(value).trim();
  const angleMatch = decoded.match(/^(.*?)<([^<>\s]+@[^<>\s]+)>$/u);
  const email = (angleMatch?.[2] ?? decoded).replace(/^mailto:/iu, "").trim();
  const explicitName = angleMatch?.[1]
    ?.replace(/^['"]|['"]$/gu, "")
    .trim();
  const name = explicitName || fallbackName.trim() || email.split("@")[0] || email;
  return { name, email };
}

function participantsFromAddresses(value: unknown): MailParticipant[] {
  const addressList = optionalText(value, 32_000);
  if (!addressList || addressList.toLowerCase() === "not provided") return [];
  return splitAddresses(addressList)
    .map((address) => participantFromAddress(address))
    .filter((participant) => participant.email.includes("@"));
}

function normalizeFolder(record: {
  folderName: string;
  folderType: string;
  path: string;
}): MailFolderId | undefined {
  const values = [record.folderType, record.folderName, record.path]
    .map((value) => value.toLowerCase().replace(/^\/+|\/+$/gu, ""))
    .filter(Boolean);
  if (values.some((value) => value === "inbox")) return "inbox";
  if (values.some((value) => value === "sent" || value === "sent mail")) {
    return "sent";
  }
  if (values.some((value) => value === "draft" || value === "drafts")) {
    return "drafts";
  }
  if (values.some((value) => value === "archive" || value === "archived")) {
    return "archive";
  }
  if (values.some((value) => value === "spam" || value === "junk")) {
    return "spam";
  }
  if (values.some((value) => value === "trash" || value === "deleted")) {
    return "trash";
  }
  return undefined;
}

function attachmentMimeType(filename: string, provided = ""): string {
  if (/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/u.test(provided)) return provided;
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function attachmentKind(
  filename: string,
  mimeType: string,
): MailAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (/\.(?:7z|bz2|gz|rar|tar|tgz|zip)$/iu.test(filename)) return "archive";
  return "document";
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  if (sizeBytes < 1_024 * 1_024) return `${(sizeBytes / 1_024).toFixed(1)} KB`;
  return `${(sizeBytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function formatTimestamp(timestamp: number): { short: string; full: string } {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return { short: "", full: "" };
  return {
    short: new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
    }).format(date),
    full: date.toISOString(),
  };
}

function safeSearchTerm(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f"]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return "";
  return normalized.slice(0, 500);
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  if (!/^[1-9]\d{0,8}$/u.test(cursor)) {
    throw new ZohoMailConfigurationError("Invalid Zoho message cursor");
  }
  return Number(cursor);
}

function listedMessageId(summary: ZohoMessageSummary): string {
  return `message:${summary.folderId}:${summary.messageId}`;
}

function parseListedMessageId(value: string): ZohoListedMessageId | null {
  const match = /^message:(\d{1,128}):(\d{1,128})$/u.exec(value);
  return match ? { folderId: match[1], messageId: match[2] } : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new ZohoMailApiError("Zoho Mail response exceeds the safety limit");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new ZohoMailApiError("Zoho Mail response exceeds the safety limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(data);
}

function base64FromBytes(value: Uint8Array): string {
  const chunkSize = 32 * 1024;
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function isMissingZohoResource(error: unknown): boolean {
  return (
    error instanceof ZohoMailApiError &&
    (error.httpStatus === 400 ||
      error.httpStatus === 404 ||
      error.apiStatus === 400 ||
      error.apiStatus === 404)
  );
}

function isMissingZohoDraft(error: unknown): boolean {
  return (
    error instanceof ZohoMailApiError &&
    (error.httpStatus === 404 || error.apiStatus === 404)
  );
}

function bytesFromBase64(value: string): Uint8Array {
  const compact = value.replace(/\s+/gu, "");
  if (
    !compact ||
    compact.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4 ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)
  ) {
    throw new ZohoMailConfigurationError("Attachment content is not valid base64");
  }

  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    throw new ZohoMailConfigurationError("Attachment content is not valid base64");
  }
  if (binary.length > MAX_ATTACHMENT_BYTES) {
    throw new ZohoMailConfigurationError("Attachment exceeds the 25 MB safety limit");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function responseFilename(value: string | null): string {
  if (!value) return "";
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded).replace(/[\\/]/gu, "_").slice(0, 255);
    } catch {
      return "";
    }
  }
  return (
    value
      .match(/filename=(?:"([^"]+)"|([^;]+))/iu)
      ?.slice(1)
      .find(Boolean)
      ?.trim()
      .replace(/[\\/]/gu, "_")
      .slice(0, 255) ?? ""
  );
}

export class ZohoMailProvider implements MailProvider {
  private readonly accountId: string;
  private readonly providerAccountId: string;
  private readonly accessToken: AccessTokenSource;
  private readonly apiOrigin: ZohoApiOrigin;
  private readonly fetchImplementation: typeof fetch;
  private readonly pageSize: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => Date;
  private accountPromise?: Promise<MailAccount>;
  private folderPromise?: Promise<ZohoFolderRecord[]>;
  private readonly messageReferences = new Map<string, ZohoMessageReference>();
  private readonly threadReferences = new Map<string, ZohoThreadReference>();
  private readonly previousFolders = new Map<string, MailFolderId>();
  private readonly attachmentReferences = new Map<
    string,
    ZohoAttachmentReference
  >();

  constructor(options: ZohoMailProviderOptions) {
    if (!options.accountId.trim() || options.accountId.length > 128) {
      throw new ZohoMailConfigurationError("A valid local connection id is required");
    }
    if (!/^\d{1,128}$/u.test(options.providerAccountId)) {
      throw new ZohoMailConfigurationError("A valid Zoho account id is required");
    }
    const requestedOrigin = (options.apiOrigin ?? DEFAULT_API_ORIGIN).replace(
      /\/$/u,
      "",
    );
    if (!(ZOHO_MAIL_API_ORIGINS as readonly string[]).includes(requestedOrigin)) {
      throw new ZohoMailConfigurationError("Unsupported Zoho Mail data-center origin");
    }
    if (
      options.pageSize !== undefined &&
      (!Number.isInteger(options.pageSize) ||
        options.pageSize < 1 ||
        options.pageSize > MAX_PAGE_SIZE)
    ) {
      throw new ZohoMailConfigurationError("Zoho page size must be from 1 to 200");
    }
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isInteger(options.requestTimeoutMs) ||
        options.requestTimeoutMs < 1_000 ||
        options.requestTimeoutMs > 60_000)
    ) {
      throw new ZohoMailConfigurationError(
        "Zoho request timeout must be from 1000 to 60000 milliseconds",
      );
    }

    this.accountId = options.accountId.trim();
    this.providerAccountId = options.providerAccountId;
    this.accessToken = options.accessToken;
    this.apiOrigin = requestedOrigin as ZohoApiOrigin;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async getAccounts(): Promise<MailAccount[]> {
    return [await this.getBoundAccount()];
  }

  async getFolders(scope: "all" | "gmail" | "outlook" | "zoho"): Promise<MailFolder[]> {
    if (scope !== "all" && scope !== "zoho") return [];
    await this.getFolderRecords();
    return SYSTEM_FOLDERS.map((folder) => ({ ...folder }));
  }

  async getMessages(query: MessageQuery): Promise<MailThread[]> {
    return (await this.getMessagesPage(query)).messages;
  }

  async getMessagesPage(query: MessageQuery): Promise<MailMessagePage> {
    if (query.scope !== "all" && query.scope !== "zoho") return { messages: [] };
    const listed = await this.listMessages(query);
    return {
      messages: listed.messageLevel
        ? this.summarizeMessages(listed.summaries, query.folder)
        : this.summarizeThreads(listed.summaries, query.folder),
      ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}),
    };
  }

  async searchMessages(query: MessageQuery): Promise<MailThread[]> {
    return (await this.getMessagesPage(query)).messages;
  }

  async getMessage(id: string): Promise<MailThread | null> {
    const listedMessage = parseListedMessageId(id);
    if (listedMessage) {
      const reference = await this.resolveListedMessageReference(listedMessage);
      if (!reference) return null;
      return this.threadFromSummaries(
        [reference.summary],
        reference.folder,
        [await this.hydrateMessage(reference.summary)],
        id,
      );
    }
    this.validateNativeInputId(id);
    const threadReference = this.threadReferences.get(id);
    const cachedMessage = this.messageReferences.get(
      threadReference?.latestMessageId ?? id,
    );
    const knownThreadId = threadReference?.threadId ?? cachedMessage?.threadId;
    if (knownThreadId) {
      const summaries = await this.fetchThreadSummaries(
        knownThreadId,
        threadReference?.folder ?? cachedMessage?.folder ?? "inbox",
      );
      if (summaries.length > 0) {
        return this.hydrateSingleThread(summaries);
      }
    }

    if (!threadReference && !cachedMessage) {
      const summaries = await this.fetchThreadSummaries(id, "inbox");
      if (summaries.length > 0) {
        return this.hydrateSingleThread(summaries);
      }
    }

    const reference = cachedMessage ?? (await this.resolveMessageReference(id));
    if (!reference) return null;
    if (reference.threadId) {
      const summaries = await this.fetchThreadSummaries(
        reference.threadId,
        reference.folder,
      );
      if (summaries.length > 0) {
        return this.hydrateSingleThread(summaries);
      }
    }
    return this.threadFromSummaries(
      [reference.summary],
      reference.folder,
      [await this.hydrateMessage(reference.summary)],
    );
  }

  async getDraft(id: string): Promise<MailDraft | null> {
    const nativeId = parseListedMessageId(id)?.messageId ?? id;
    this.validateNativeInputId(nativeId);
    try {
      const resolved = await this.resolveDraftReference(nativeId);
      if (!resolved) return null;
      const { record, reference } = resolved;
      const [content, attachments] = await Promise.all([
        this.fetchMessageContent(reference),
        reference.summary.hasAttachment || reference.summary.hasInline
          ? this.fetchAttachments(reference)
          : Promise.resolve([]),
      ]);
      const body = looksLikeHtml(content)
        ? htmlToPlainText(content)
        : content.replace(/\r\n?/gu, "\n").trim();
      return {
        id: reference.messageId,
        accountId: this.accountId,
        to: participantsFromAddresses(record.toAddress).map(
          (participant) => participant.email,
        ),
        cc: participantsFromAddresses(record.ccAddress).map(
          (participant) => participant.email,
        ),
        bcc: participantsFromAddresses(record.bccAddress).map(
          (participant) => participant.email,
        ),
        subject: optionalText(record.subject, 998),
        body,
        attachments: attachments.map((attachment) => ({
          ...attachment,
          sourceMessageId: reference.messageId,
        })),
      };
    } catch (error) {
      if (isMissingZohoDraft(error)) return null;
      throw error;
    }
  }

  async getRawMessageContent(messageId: string): Promise<MailMessageContent | null> {
    const reference = await this.resolveMessageReference(messageId);
    if (!reference) return null;
    const content = await this.fetchMessageContent(reference);
    return {
      content,
      contentType: looksLikeHtml(content) ? "text/html" : "text/plain",
    };
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<MailAttachmentContent | null> {
    this.validateNativeInputId(attachmentId);
    const message = await this.resolveMessageReference(messageId);
    if (!message) return null;
    let attachment = this.attachmentReferences.get(
      this.attachmentKey(messageId, attachmentId),
    );
    if (!attachment) {
      await this.fetchAttachments(message);
      attachment = this.attachmentReferences.get(
        this.attachmentKey(messageId, attachmentId),
      );
    }
    if (!attachment) return null;

    const response = await this.requestBinary(
      `/api/accounts/${this.providerAccountId}/folders/${attachment.folderId}/messages/${attachment.messageId}/attachments/${attachment.attachmentId}`,
    );
    const filename =
      responseFilename(response.headers.get("Content-Disposition")) ||
      attachment.filename;
    const mimeType = attachmentMimeType(
      filename,
      response.headers.get("Content-Type")?.split(";", 1)[0] ??
        attachment.mimeType,
    );
    return {
      data: response.data,
      filename,
      mimeType,
      sizeBytes: response.data.byteLength,
    };
  }

  async sendMessage(draft: MailDraft): Promise<{ id: string }> {
    this.validateDraft(draft, true);
    const payload = await this.outgoingPayload(
      await this.draftWithCurrentAttachments(draft),
    );
    const data = await this.requestJson<unknown>(
      `/api/accounts/${this.providerAccountId}/messages`,
      { method: "POST", json: payload },
    );
    const id = this.createdMessageId(data);
    await this.discardSupersededDraft(draft.id, id);
    return { id };
  }

  async saveDraft(draft: MailDraft): Promise<{ id: string; savedAt: string }> {
    this.validateDraft(draft, false);
    const outgoingDraft = await this.draftWithCurrentAttachments(draft);
    const payload = {
      ...(await this.outgoingPayload(outgoingDraft)),
      mode: "draft",
    };
    const data = await this.requestJson<unknown>(
      `/api/accounts/${this.providerAccountId}/messages`,
      { method: "POST", json: payload },
    );
    const id = this.createdMessageId(data);
    await this.discardSupersededDraft(draft.id, id);
    return { id, savedAt: this.now().toISOString() };
  }

  async replyMessage(id: string, draft: MailDraft): Promise<{ id: string }> {
    const nativeId = parseListedMessageId(id)?.messageId ?? id;
    this.validateNativeInputId(nativeId);
    this.validateDraft(draft, true);
    const targetMessageId = await this.resolveReplyTarget(nativeId);
    const payload = {
      ...(await this.outgoingPayload(
        await this.draftWithCurrentAttachments(draft),
      )),
      action: "reply",
    };
    const data = await this.requestJson<unknown>(
      `/api/accounts/${this.providerAccountId}/messages/${targetMessageId}`,
      { method: "POST", json: payload },
    );
    const createdId = this.createdMessageId(data);
    await this.discardSupersededDraft(draft.id, createdId);
    return { id: createdId };
  }

  async forwardMessage(id: string, draft: MailDraft): Promise<{ id: string }> {
    const nativeId = parseListedMessageId(id)?.messageId ?? id;
    this.validateNativeInputId(nativeId);
    this.validateDraft(draft, true);
    const targetMessageId = await this.resolveReplyTarget(nativeId);
    const reference = await this.resolveMessageReference(targetMessageId);
    if (!reference) {
      throw new ZohoMailApiError("The Zoho message to forward is unavailable");
    }

    const [content, originalAttachments] = await Promise.all([
      this.fetchMessageContent(reference),
      reference.summary.hasAttachment
        ? this.fetchAttachments(reference)
        : Promise.resolve([]),
    ]);
    const downloadedAttachments = await Promise.all(
      originalAttachments.map(async (attachment): Promise<MailAttachment> => {
        const downloaded = await this.getAttachment(
          reference.messageId,
          attachment.id,
        );
        if (!downloaded) {
          throw new ZohoMailApiError(
            "A Zoho attachment to forward is unavailable",
          );
        }
        return {
          ...attachment,
          name: downloaded.filename,
          size: formatBytes(downloaded.sizeBytes),
          mimeType: downloaded.mimeType,
          sizeBytes: downloaded.sizeBytes,
          inline: false,
          contentBase64: base64FromBytes(downloaded.data),
        };
      }),
    );
    const downloadedById = new Map(
      downloadedAttachments.map((attachment) => [attachment.id, attachment]),
    );
    const attachments = draft.attachments.map(
      (attachment) => downloadedById.get(attachment.id) ?? attachment,
    );
    const existingIds = new Set(attachments.map((attachment) => attachment.id));
    attachments.push(
      ...downloadedAttachments.filter(
        (attachment) => !existingIds.has(attachment.id),
      ),
    );

    const sourceText = looksLikeHtml(content) ? htmlToPlainText(content) : content.trim();
    const sender = this.formatParticipant(reference.summary.sender);
    const recipients = reference.summary.recipients
      .map((participant) => this.formatParticipant(participant))
      .join(", ");
    const sentAt = formatTimestamp(reference.summary.timestamp).full;
    const forwardedBlock = [
      "---------- Forwarded message ----------",
      sender ? `From: ${sender}` : "",
      sentAt ? `Date: ${sentAt}` : "",
      reference.summary.subject
        ? `Subject: ${reference.summary.subject}`
        : "",
      recipients ? `To: ${recipients}` : "",
      "",
      sourceText,
    ]
      .filter((line, index, lines) => line || index === lines.length - 2)
      .join("\n");
    const body = draft.body.trim()
      ? `${draft.body.trimEnd()}\n\n${forwardedBlock}`
      : forwardedBlock;
    const result = await this.sendMessage({ ...draft, body, attachments });
    return result;
  }

  async archiveMessages(ids: string[]): Promise<OperationResult> {
    return this.updateMessages(ids, "archiveMails", "archive", true);
  }

  async moveToTrash(ids: string[]): Promise<OperationResult> {
    return this.moveMessages(ids, "trash", true);
  }

  async restoreFromTrash(ids: string[]): Promise<OperationResult> {
    const locations = unique(ids).map((id) => ({
      id,
      folder: this.previousFolders.get(id) ?? "inbox",
    }));
    return this.restoreMessages(locations);
  }

  async restoreMessages(locations: MessageLocation[]): Promise<OperationResult> {
    const uniqueLocations = Array.from(
      new Map(locations.map((location) => [location.id, location])).values(),
    );
    const result: OperationResult = { succeeded: [], failed: [] };
    const grouped = new Map<MailFolderId, string[]>();

    for (const location of uniqueLocations) {
      try {
        this.validateNativeInputId(
          parseListedMessageId(location.id)?.messageId ?? location.id,
        );
      } catch (error) {
        result.failed.push({
          id: location.id,
          reason: error instanceof Error ? error.message : "Invalid message id",
        });
        continue;
      }
      if (location.folder === "starred") {
        result.failed.push({
          id: location.id,
          reason: "Starred is a filter and cannot be used as a message location",
        });
        continue;
      }
      const ids = grouped.get(location.folder) ?? [];
      ids.push(location.id);
      grouped.set(location.folder, ids);
    }

    for (const [folder, ids] of grouped) {
      if (folder === "starred") continue;
      const groupResult =
        folder === "archive"
          ? await this.updateMessages(ids, "archiveMails", "archive", false)
          : await this.moveMessages(ids, folder, false);
      result.succeeded.push(...groupResult.succeeded);
      result.failed.push(...groupResult.failed);
    }

    result.succeeded.forEach((id) => this.previousFolders.delete(id));
    return result;
  }

  async markRead(ids: string[], read: boolean): Promise<OperationResult> {
    return this.updateMessages(ids, read ? "markAsRead" : "markAsUnread");
  }

  async setStarred(id: string, starred: boolean): Promise<OperationResult> {
    return this.updateMessages([id], "setFlag", undefined, false, {
      flagid: starred ? "important" : "flag_not_set",
    });
  }

  private async getBoundAccount(): Promise<MailAccount> {
    this.accountPromise ??= (async () => {
      const data = await this.requestJson<unknown>("/api/accounts");
      if (!Array.isArray(data)) {
        throw new ZohoMailApiError("Zoho returned an invalid account list");
      }
      const account = data.find((value) => {
        if (!isRecord(value)) return false;
        return stringValue(value.accountId) === this.providerAccountId;
      });
      if (!isRecord(account)) {
        throw new ZohoMailApiError("The configured Zoho account is unavailable");
      }
      const accountId = requiredNativeId(account.accountId, "account id");
      if (accountId !== this.providerAccountId) {
        throw new ZohoMailApiError("Zoho returned a different account");
      }
      const address =
        optionalText(account.primaryEmailAddress, 320) ||
        optionalText(account.mailboxAddress, 320) ||
        optionalText(account.incomingUserName, 320);
      if (!/^\S+@\S+$/u.test(address)) {
        throw new ZohoMailApiError("Zoho returned an invalid account address");
      }
      const label =
        optionalText(account.displayName, 200) ||
        optionalText(account.accountDisplayName, 200) ||
        address;
      const enabled = account.enabled !== false && account.status !== false;
      return {
        id: this.accountId,
        provider: "zoho" as const,
        label,
        address,
        color: "#e42527",
        connected: enabled,
        capabilities: {
          labels: true,
          reliableDraftUpdates: false,
          externalImages: true,
          permanentDelete: true,
        },
      };
    })().catch((error) => {
      this.accountPromise = undefined;
      throw error;
    });
    return this.accountPromise;
  }

  private async getFolderRecords(): Promise<ZohoFolderRecord[]> {
    this.folderPromise ??= (async () => {
      const data = await this.requestJson<unknown>(
        `/api/accounts/${this.providerAccountId}/folders`,
      );
      if (!Array.isArray(data)) {
        throw new ZohoMailApiError("Zoho returned an invalid folder list");
      }
      return data.map((value) => {
        if (!isRecord(value)) {
          throw new ZohoMailApiError("Zoho returned an invalid folder");
        }
        const record: ZohoFolderRecord = {
          folderId: requiredNativeId(value.folderId, "folder id"),
          folderName: requiredText(value.folderName, "folder name", 1_024),
          folderType: optionalText(value.folderType, 1_024),
          path: optionalText(value.path, 2_048),
        };
        record.normalized = normalizeFolder(record);
        return record;
      });
    })().catch((error) => {
      this.folderPromise = undefined;
      throw error;
    });
    return this.folderPromise;
  }

  private async listMessages(query: MessageQuery): Promise<ListResult> {
    const start = parseCursor(query.cursor);
    const limit = query.pageSize ?? this.pageSize;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new ZohoMailConfigurationError("Zoho page size must be from 1 to 200");
    }
    const folders = await this.getFolderRecords();
    const search = safeSearchTerm(query.search ?? "");
    let data: unknown;

    const messageLevel = Boolean(search) || query.folder === "starred" || query.folder === "archive";
    if (messageLevel) {
      const criteria: string[] = [];
      if (search) criteria.push(`entire:"${search}"`);
      if (query.folder === "starred") criteria.push("has:flags");
      else if (query.folder === "archive") criteria.push("in:Archive");
      else {
        const folder = folders.find((candidate) => candidate.normalized === query.folder);
        if (!folder) return { summaries: [], messageLevel };
        criteria.push(`in:${folder.folderName.replace(/[:"]/gu, " ")}`);
      }
      if (query.folder === "spam" || query.folder === "trash") {
        criteria.push("inclspamtrash:true");
      }
      const parameters = new URLSearchParams({
        searchKey: criteria.join("::"),
        start: String(start),
        limit: String(limit),
        includeto: "true",
      });
      data = await this.requestJson<unknown>(
        `/api/accounts/${this.providerAccountId}/messages/search?${parameters}`,
      );
    } else {
      const folder = folders.find((candidate) => candidate.normalized === query.folder);
      if (!folder) return { summaries: [], messageLevel };
      const parameters = new URLSearchParams({
        folderId: folder.folderId,
        start: String(start),
        limit: String(limit),
        includeto: "true",
        threadedMails: "true",
        sortBy: "date",
        sortorder: "false",
      });
      data = await this.requestJson<unknown>(
        `/api/accounts/${this.providerAccountId}/messages/view?${parameters}`,
      );
    }

    if (!Array.isArray(data)) {
      throw new ZohoMailApiError("Zoho returned an invalid message list");
    }
    const summaries = data.map((value) =>
      this.parseMessageSummary(value, query.folder),
    );
    return {
      summaries,
      messageLevel,
      ...(data.length === limit
        ? { nextCursor: String(start + data.length) }
        : {}),
    };
  }

  private parseMessageSummary(
    value: unknown,
    requestedFolder: MailFolderId,
  ): ZohoMessageSummary {
    if (!isRecord(value)) {
      throw new ZohoMailApiError("Zoho returned an invalid message summary");
    }
    const messageId = requiredNativeId(value.messageId, "message id");
    const threadId = optionalNativeId(value.threadId, "thread id");
    const folderId = requiredNativeId(value.folderId, "folder id");
    const fromAddress = optionalText(value.fromAddress, 2_048);
    const senderName = optionalText(value.sender, 512);
    const timestamp =
      numberValue(value.receivedTime) ??
      numberValue(value.receivedtime) ??
      numberValue(value.sentDateInGMT) ??
      0;
    const summary: ZohoMessageSummary = {
      messageId,
      ...(threadId ? { threadId } : {}),
      folderId,
      folder: requestedFolder,
      sender: participantFromAddress(fromAddress, senderName),
      recipients: [
        ...participantsFromAddresses(value.toAddress),
        ...participantsFromAddresses(value.ccAddress),
      ],
      subject: optionalText(value.subject, 998),
      summary: htmlToPlainText(optionalText(value.summary, 100_000)),
      timestamp,
      unread: isUnreadStatus(value.status),
      starred: isFlagged(value.flagid),
      hasAttachment: truthyProviderValue(value.hasAttachment),
      hasInline: truthyProviderValue(value.hasInline),
    };
    this.messageReferences.set(messageId, {
      messageId,
      ...(threadId ? { threadId } : {}),
      folderId,
      folder: requestedFolder,
      summary,
    });
    return summary;
  }

  private summarizeThreads(
    summaries: ZohoMessageSummary[],
    requestedFolder: MailFolderId,
  ): MailThread[] {
    const groups = new Map<string, ZohoMessageSummary[]>();
    for (const summary of summaries) {
      const groupId = summary.threadId ?? summary.messageId;
      const group = groups.get(groupId) ?? [];
      group.push(summary);
      groups.set(groupId, group);
    }

    return Array.from(groups.values())
      .map((group) => {
        const ordered = [...group].sort(
          (left, right) => left.timestamp - right.timestamp,
        );
        const messages = ordered.map((summary) => {
          const timestamp = formatTimestamp(summary.timestamp);
          return {
            id: summary.messageId,
            sender: summary.sender,
            recipients: summary.recipients,
            sentAt: timestamp.short,
            sentAtFull: timestamp.full,
            body: [],
            attachments: [],
          } satisfies ThreadMessage;
        });
        return this.threadFromSummaries(ordered, requestedFolder, messages);
      })
      .sort((left, right) => right.receivedAtMs - left.receivedAtMs);
  }

  private summarizeMessages(
    summaries: ZohoMessageSummary[],
    requestedFolder: MailFolderId,
  ): MailThread[] {
    return summaries
      .map((summary) => {
        const timestamp = formatTimestamp(summary.timestamp);
        return this.threadFromSummaries(
          [summary],
          requestedFolder,
          [
            {
              id: summary.messageId,
              sender: summary.sender,
              recipients: summary.recipients,
              sentAt: timestamp.short,
              sentAtFull: timestamp.full,
              body: [],
              attachments: [],
            },
          ],
          // Draft intent is persisted by the provider-native draft id. Keep that
          // id stable when a draft is reached through search pagination; other
          // message-level results need the folder-qualified marker so that
          // detail and mutation requests do not mistake a message for a thread.
          requestedFolder === "drafts"
            ? summary.messageId
            : listedMessageId(summary),
        );
      })
      .sort((left, right) => right.receivedAtMs - left.receivedAtMs);
  }

  private async fetchThreadSummaries(
    threadId: string,
    fallbackFolder: MailFolderId,
  ): Promise<ZohoMessageSummary[]> {
    this.validateNativeInputId(threadId);
    const query = new URLSearchParams({
      threadId,
      start: "1",
      limit: String(MAX_PAGE_SIZE),
      includeto: "true",
      includesent: "true",
      includearchive: "true",
      sortBy: "date",
      sortorder: "true",
    });
    let data: unknown;
    try {
      data = await this.requestJson<unknown>(
        `/api/accounts/${this.providerAccountId}/messages/view?${query}`,
      );
    } catch (error) {
      if (isMissingZohoResource(error)) return [];
      throw error;
    }
    if (!Array.isArray(data)) {
      throw new ZohoMailApiError("Zoho returned an invalid thread message list");
    }
    if (data.length === 0) return [];

    const folders = await this.getFolderRecords();
    const summaries = data.map((record) => {
      if (!isRecord(record)) {
        throw new ZohoMailApiError("Zoho returned an invalid message summary");
      }
      const folderId = requiredNativeId(record.folderId, "folder id");
      const folder =
        folders.find((candidate) => candidate.folderId === folderId)?.normalized ??
        fallbackFolder;
      return this.parseMessageSummary(record, folder);
    });
    const matching = summaries.filter(
      (summary) =>
        summary.threadId === threadId ||
        (!summary.threadId && summary.messageId === threadId),
    );
    if (matching.length !== summaries.length) {
      throw new ZohoMailApiError("Zoho returned messages from a different thread");
    }
    const latest = [...matching].sort(
      (left, right) => left.timestamp - right.timestamp,
    ).at(-1)!;
    this.threadReferences.set(threadId, {
      threadId,
      latestMessageId: latest.messageId,
      folderId: latest.folderId,
      folder: latest.folder,
    });
    return matching;
  }

  private async resolveMessageReference(
    messageId: string,
  ): Promise<ZohoMessageReference | null> {
    this.validateNativeInputId(messageId);
    const retained = this.messageReferences.get(messageId);
    if (retained) return retained;

    const folders = await this.getFolderRecords();
    for (const folder of folders) {
      let data: unknown;
      try {
        data = await this.requestJson<unknown>(
          `/api/accounts/${this.providerAccountId}/folders/${folder.folderId}/messages/${messageId}/details`,
        );
      } catch (error) {
        if (isMissingZohoResource(error)) continue;
        throw error;
      }
      const normalizedData =
        isRecord(data) && data.messageId === undefined && data.draftId !== undefined
          ? { ...data, messageId: data.draftId }
          : data;
      const summary = this.parseMessageSummary(
        normalizedData,
        folder.normalized ?? "archive",
      );
      if (
        summary.messageId !== messageId ||
        summary.folderId !== folder.folderId
      ) {
        throw new ZohoMailApiError("Zoho returned a different message");
      }
      return this.messageReferences.get(messageId) ?? null;
    }
    return null;
  }

  private async resolveListedMessageReference(
    listed: ZohoListedMessageId,
  ): Promise<ZohoMessageReference | null> {
    const folders = await this.getFolderRecords();
    const folder = folders.find((candidate) => candidate.folderId === listed.folderId);
    if (!folder) return this.resolveMessageReference(listed.messageId);

    let data: unknown;
    try {
      data = await this.requestJson<unknown>(
        `/api/accounts/${this.providerAccountId}/folders/${folder.folderId}/messages/${listed.messageId}/details`,
      );
    } catch (error) {
      if (isMissingZohoResource(error)) {
        // The message may have moved after the list response was produced.
        return this.resolveMessageReference(listed.messageId);
      }
      throw error;
    }
    const summary = this.parseMessageSummary(
      data,
      folder.normalized ?? "archive",
    );
    if (
      summary.messageId !== listed.messageId ||
      summary.folderId !== listed.folderId
    ) {
      throw new ZohoMailApiError("Zoho returned a different message");
    }
    return this.messageReferences.get(listed.messageId) ?? null;
  }

  private async resolveDraftReference(id: string): Promise<{
    record: Record<string, unknown>;
    reference: ZohoMessageReference;
  } | null> {
    this.validateNativeInputId(id);
    const folders = await this.getFolderRecords();
    const folder = folders.find((candidate) => candidate.normalized === "drafts");
    if (!folder) return null;

    let data: unknown;
    try {
      data = await this.requestJson<unknown>(
        `/api/accounts/${this.providerAccountId}/folders/${folder.folderId}/messages/${id}/details`,
      );
    } catch (error) {
      if (isMissingZohoDraft(error)) return null;
      throw error;
    }
    if (!isRecord(data)) {
      throw new ZohoMailApiError("Zoho returned invalid draft information");
    }
    const messageId = requiredNativeId(
      data.messageId ?? data.draftId,
      "draft message id",
    );
    const normalizedRecord = {
      ...data,
      messageId,
      folderId: data.folderId ?? folder.folderId,
    };
    const summary = this.parseMessageSummary(normalizedRecord, "drafts");
    if (messageId !== id || summary.folderId !== folder.folderId) {
      throw new ZohoMailApiError("Zoho returned a different draft");
    }
    const reference = this.messageReferences.get(messageId);
    if (!reference) {
      throw new ZohoMailApiError("Zoho draft reference is unavailable");
    }
    return { record: normalizedRecord, reference };
  }

  private async resolveReplyTarget(id: string): Promise<string> {
    const retainedThread = this.threadReferences.get(id);
    if (retainedThread) return retainedThread.latestMessageId;
    if (this.messageReferences.has(id)) return id;
    const summaries = await this.fetchThreadSummaries(id, "inbox");
    if (summaries.length === 0) return id;
    return [...summaries]
      .sort((left, right) => left.timestamp - right.timestamp)
      .at(-1)!.messageId;
  }

  private async hydrateSingleThread(
    summaries: ZohoMessageSummary[],
  ): Promise<MailThread> {
    const ordered = [...summaries].sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    const requestedFolder = ordered.at(-1)?.folder ?? "inbox";
    const threads = await this.hydrateThreads(ordered, requestedFolder);
    const thread = threads[0];
    if (!thread) {
      throw new ZohoMailApiError("Zoho returned an empty thread");
    }
    return thread;
  }

  private formatParticipant(participant: MailParticipant): string {
    if (!participant.email) return participant.name;
    if (!participant.name || participant.name === participant.email) {
      return participant.email;
    }
    return `${participant.name} <${participant.email}>`;
  }

  private async hydrateThreads(
    summaries: ZohoMessageSummary[],
    requestedFolder: MailFolderId,
  ): Promise<MailThread[]> {
    const groups = new Map<string, ZohoMessageSummary[]>();
    for (const summary of summaries) {
      const groupId = summary.threadId ?? summary.messageId;
      const group = groups.get(groupId) ?? [];
      group.push(summary);
      groups.set(groupId, group);
    }

    const threads = await Promise.all(
      Array.from(groups.values()).map(async (group) => {
        const ordered = [...group].sort((left, right) => left.timestamp - right.timestamp);
        const messages = await Promise.all(
          ordered.map((summary) => this.hydrateMessage(summary)),
        );
        return this.threadFromSummaries(ordered, requestedFolder, messages);
      }),
    );
    return threads.sort((left, right) => right.receivedAtMs - left.receivedAtMs);
  }

  private async hydrateMessage(summary: ZohoMessageSummary): Promise<ThreadMessage> {
    const reference = this.messageReferences.get(summary.messageId);
    if (!reference) {
      throw new ZohoMailApiError("Zoho message reference was not retained");
    }
    const attachments = summary.hasAttachment
      ? await this.fetchAttachments(reference)
      : [];
    const timestamp = formatTimestamp(summary.timestamp);
    return {
      id: summary.messageId,
      sender: summary.sender,
      recipients: summary.recipients,
      sentAt: timestamp.short,
      sentAtFull: timestamp.full,
      body: [],
      attachments,
    };
  }

  private threadFromSummaries(
    summaries: ZohoMessageSummary[],
    requestedFolder: MailFolderId,
    messages: ThreadMessage[],
    idOverride?: string,
  ): MailThread {
    const latest = summaries[summaries.length - 1];
    const timestamp = formatTimestamp(latest.timestamp);
    const threadId = latest.threadId;
    if (threadId && !idOverride) {
      this.threadReferences.set(threadId, {
        threadId,
        latestMessageId: latest.messageId,
        folderId: latest.folderId,
        folder: requestedFolder,
      });
    }
    return {
      id: idOverride ?? threadId ?? latest.messageId,
      provider: "zoho",
      accountId: this.accountId,
      folder: requestedFolder,
      sender: latest.sender,
      subject: latest.subject,
      preview: latest.summary,
      receivedAt: timestamp.short,
      receivedAtFull: timestamp.full,
      receivedAtMs: latest.timestamp,
      unread: summaries.some((summary) => summary.unread),
      starred: summaries.some((summary) => summary.starred),
      labels: requestedFolder === "drafts" ? ["Draft"] : [],
      hasExternalImages: summaries.some((summary) => summary.hasInline),
      messages,
    };
  }

  private async fetchMessageContent(reference: ZohoMessageReference): Promise<string> {
    const data = await this.requestJson<unknown>(
      `/api/accounts/${this.providerAccountId}/folders/${reference.folderId}/messages/${reference.messageId}/content?includeBlockContent=true`,
      { maximumResponseBytes: MAX_MESSAGE_CONTENT_RESPONSE_BYTES },
    );
    if (!isRecord(data) || typeof data.content !== "string") {
      throw new ZohoMailApiError("Zoho returned invalid message content");
    }
    if (new TextEncoder().encode(data.content).byteLength > MAX_MESSAGE_CONTENT_BYTES) {
      throw new ZohoMailApiError("Zoho message content exceeds the safety limit");
    }
    return data.content;
  }

  private async fetchAttachments(
    reference: ZohoMessageReference,
  ): Promise<MailAttachment[]> {
    const data = await this.requestJson<unknown>(
      `/api/accounts/${this.providerAccountId}/folders/${reference.folderId}/messages/${reference.messageId}/attachmentinfo?includeInline=true`,
    );
    if (!isRecord(data)) {
      throw new ZohoMailApiError("Zoho returned invalid attachment information");
    }
    const normal = Array.isArray(data.attachments) ? data.attachments : [];
    const inline = Array.isArray(data.inline) ? data.inline : [];
    return [...normal.map((value) => ({ value, inline: false })), ...inline.map((value) => ({ value, inline: true }))].map(
      ({ value, inline: isInline }) => {
        if (!isRecord(value)) {
          throw new ZohoMailApiError("Zoho returned an invalid attachment");
        }
        const attachmentId = requiredNativeId(value.attachmentId, "attachment id");
        const filename = requiredText(
          value.attachmentName,
          "attachment name",
          255,
        ).replace(/[\\/]/gu, "_");
        const sizeBytes = numberValue(value.attachmentSize);
        if (
          sizeBytes === undefined ||
          !Number.isSafeInteger(sizeBytes) ||
          sizeBytes < 0
        ) {
          throw new ZohoMailApiError("Zoho returned an invalid attachment size");
        }
        const mimeType = attachmentMimeType(filename);
        const attachment: MailAttachment = {
          id: attachmentId,
          name: filename,
          size: formatBytes(sizeBytes),
          kind: attachmentKind(filename, mimeType),
          mimeType,
          sizeBytes,
          inline: isInline,
          ...(isInline && typeof value.cid === "string"
            ? { contentId: value.cid.slice(0, 998) }
            : {}),
        };
        this.attachmentReferences.set(
          this.attachmentKey(reference.messageId, attachmentId),
          {
            messageId: reference.messageId,
            folderId: reference.folderId,
            attachmentId,
            filename,
            mimeType,
            sizeBytes,
          },
        );
        return attachment;
      },
    );
  }

  private async outgoingPayload(
    draft: MailDraft,
  ): Promise<Record<string, unknown>> {
    const account = await this.getBoundAccount();
    const attachments = await Promise.all(
      draft.attachments.map((attachment) => this.prepareAttachment(attachment)),
    );
    return {
      fromAddress: account.address,
      toAddress: draft.to.join(","),
      ...(draft.cc.length > 0 ? { ccAddress: draft.cc.join(",") } : {}),
      ...(draft.bcc.length > 0 ? { bccAddress: draft.bcc.join(",") } : {}),
      subject: draft.subject,
      content: draft.body,
      mailFormat: "plaintext",
      encoding: "UTF-8",
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  private async prepareAttachment(
    attachment: MailAttachment,
  ): Promise<ZohoUploadDescriptor> {
    let data: Uint8Array;
    let mimeType = attachmentMimeType(attachment.name, attachment.mimeType);
    if (attachment.contentBase64) {
      data = bytesFromBase64(attachment.contentBase64);
    } else {
      let source: ZohoAttachmentReference | undefined;
      if (attachment.sourceMessageId) {
        this.validateNativeInputId(attachment.sourceMessageId);
        source = this.attachmentReferences.get(
          this.attachmentKey(attachment.sourceMessageId, attachment.id),
        );
        if (!source) {
          const message = await this.resolveMessageReference(
            attachment.sourceMessageId,
          );
          if (message) await this.fetchAttachments(message);
          source = this.attachmentReferences.get(
            this.attachmentKey(attachment.sourceMessageId, attachment.id),
          );
        }
      } else {
        const sources = Array.from(this.attachmentReferences.values()).filter(
          (candidate) => candidate.attachmentId === attachment.id,
        );
        if (sources.length === 1) source = sources[0];
      }
      if (!source) {
        throw new ZohoMailConfigurationError(
          "Attachment content is unavailable; upload the file again",
        );
      }
      const downloaded = await this.getAttachment(
        source.messageId,
        source.attachmentId,
      );
      if (!downloaded) {
        throw new ZohoMailConfigurationError("Attachment content is unavailable");
      }
      data = downloaded.data;
      mimeType = downloaded.mimeType;
    }
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new ZohoMailConfigurationError("Attachment exceeds the 25 MB safety limit");
    }

    const parameters = new URLSearchParams({
      fileName: attachment.name.replace(/[\\/]/gu, "_").slice(0, 255),
      isInline: String(attachment.inline === true),
    });
    const body = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    const uploaded = await this.requestJson<unknown>(
      `/api/accounts/${this.providerAccountId}/messages/attachments?${parameters}`,
      {
        method: "POST",
        body,
        headers: { "Content-Type": mimeType },
      },
    );
    if (!isRecord(uploaded)) {
      throw new ZohoMailApiError("Zoho returned invalid upload information");
    }
    return {
      storeName: requiredText(uploaded.storeName, "attachment store name", 1_024),
      attachmentPath: requiredText(
        uploaded.attachmentPath,
        "attachment path",
        4_096,
      ),
      attachmentName: requiredText(
        uploaded.attachmentName,
        "attachment name",
        255,
      ),
    };
  }

  private validateDraft(draft: MailDraft, requireRecipient: boolean): void {
    if (draft.accountId !== this.accountId) {
      throw new ZohoMailConfigurationError("Draft belongs to a different mail account");
    }
    if (draft.subject.length > 998 || draft.body.length > 10_000_000) {
      throw new ZohoMailConfigurationError("Draft content is too large");
    }
    const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
    if (requireRecipient && recipients.length === 0) {
      throw new ZohoMailConfigurationError("At least one recipient is required");
    }
    if (recipients.some((address) => !/^\S+@\S+$/u.test(address) || /[\r\n]/u.test(address))) {
      throw new ZohoMailConfigurationError("Draft contains an invalid recipient");
    }
    if (draft.attachments.length > 50) {
      throw new ZohoMailConfigurationError("Too many attachments");
    }
    if (draft.id) {
      this.validateNativeInputId(
        parseListedMessageId(draft.id)?.messageId ?? draft.id,
      );
    }
  }

  private createdMessageId(data: unknown): string {
    if (!isRecord(data)) {
      throw new ZohoMailApiError("Zoho did not return the created message id");
    }
    return requiredNativeId(
      data.messageId ?? data.draftId ?? data.id,
      "created message id",
    );
  }

  private rebaseDraftAttachments(
    requested: MailAttachment[],
    current: MailAttachment[],
    currentMessageId: string,
  ): MailAttachment[] {
    const available = [...current];
    return requested.map((attachment) => {
      if (attachment.contentBase64) return attachment;
      let index = available.findIndex(
        (candidate) => candidate.id === attachment.id,
      );
      if (index < 0) {
        index = available.findIndex(
          (candidate) =>
            candidate.name === attachment.name &&
            candidate.sizeBytes === attachment.sizeBytes &&
            Boolean(candidate.inline) === Boolean(attachment.inline) &&
            (candidate.contentId ?? "") === (attachment.contentId ?? ""),
        );
      }
      if (index < 0) return attachment;
      const [source] = available.splice(index, 1);
      return {
        ...attachment,
        id: source.id,
        sourceMessageId: currentMessageId,
      };
    });
  }

  private async draftWithCurrentAttachments(draft: MailDraft): Promise<MailDraft> {
    if (!draft.id) return draft;
    const current = await this.resolveDraftReference(
      parseListedMessageId(draft.id)?.messageId ?? draft.id,
    );
    if (!current) return draft;
    const currentAttachments =
      current.reference.summary.hasAttachment || current.reference.summary.hasInline
        ? await this.fetchAttachments(current.reference)
        : [];
    return {
      ...draft,
      attachments: this.rebaseDraftAttachments(
        draft.attachments,
        currentAttachments,
        current.reference.messageId,
      ),
    };
  }

  private async discardSupersededDraft(
    previousId: string | undefined,
    createdId: string,
  ): Promise<void> {
    previousId = previousId
      ? (parseListedMessageId(previousId)?.messageId ?? previousId)
      : undefined;
    if (!previousId || previousId === createdId) return;
    let reference = this.messageReferences.get(previousId);
    if (!reference) {
      try {
        reference = (await this.resolveDraftReference(previousId))?.reference;
      } catch {
        return;
      }
    }
    if (!reference || reference.folder !== "drafts") return;
    try {
      await this.requestJson<unknown>(
        `/api/accounts/${this.providerAccountId}/folders/${reference.folderId}/messages/${previousId}`,
        { method: "DELETE" },
      );
      this.messageReferences.delete(previousId);
      for (const [key, attachment] of this.attachmentReferences) {
        if (attachment.messageId === previousId) {
          this.attachmentReferences.delete(key);
        }
      }
    } catch {
      // The new message already exists. A stale draft is safer than retrying a send.
    }
  }

  private async moveMessages(
    ids: string[],
    destination: Exclude<MailFolderId, "starred" | "archive">,
    rememberPrevious: boolean,
  ): Promise<OperationResult> {
    const folders = await this.getFolderRecords();
    const destinationFolder = folders.find(
      (folder) => folder.normalized === destination,
    );
    if (!destinationFolder) {
      return {
        succeeded: [],
        failed: unique(ids).map((id) => ({
          id,
          reason: `Zoho ${destination} folder is unavailable`,
        })),
      };
    }
    return this.updateMessages(ids, "moveMessage", destination, rememberPrevious, {
      destfolderId: destinationFolder.folderId,
    });
  }

  private async updateMessages(
    ids: string[],
    mode: string,
    destination?: MailFolderId,
    rememberPrevious = false,
    extra: Record<string, unknown> = {},
  ): Promise<OperationResult> {
    const requested = unique(ids);
    const valid: Array<{
      inputId: string;
      nativeId: string;
      listed?: ZohoListedMessageId;
    }> = [];
    const failed: OperationResult["failed"] = [];
    for (const id of requested) {
      try {
        const listed = parseListedMessageId(id) ?? undefined;
        const nativeId = listed?.messageId ?? id;
        this.validateNativeInputId(nativeId);
        valid.push({ inputId: id, nativeId, listed });
      } catch (error) {
        failed.push({
          id,
          reason: error instanceof Error ? error.message : "Invalid message id",
        });
      }
    }
    if (valid.length === 0) return { succeeded: [], failed };

    const threadTargets: ZohoUpdateTarget[] = [];
    const messageTargets: ZohoUpdateTarget[] = [];
    for (const target of valid) {
      if (target.listed) {
        if (rememberPrevious) {
          await this.resolveListedMessageReference(target.listed);
        }
        messageTargets.push({
          inputId: target.inputId,
          nativeId: target.nativeId,
          kind: "message",
        });
      } else if (this.threadReferences.has(target.nativeId)) {
        threadTargets.push({
          inputId: target.inputId,
          nativeId: target.nativeId,
          kind: "thread",
        });
      } else if (this.messageReferences.has(target.nativeId)) {
        messageTargets.push({
          inputId: target.inputId,
          nativeId: target.nativeId,
          kind: "message",
        });
      } else {
        const summaries = await this.fetchThreadSummaries(target.nativeId, "inbox");
        if (summaries.length > 0) {
          threadTargets.push({
            inputId: target.inputId,
            nativeId: target.nativeId,
            kind: "thread",
          });
        } else {
          if (rememberPrevious) {
            await this.resolveMessageReference(target.nativeId);
          }
          messageTargets.push({
            inputId: target.inputId,
            nativeId: target.nativeId,
            kind: "message",
          });
        }
      }
    }

    const succeeded: string[] = [];
    const batches: Array<{
      targets: ZohoUpdateTarget[];
      body: Record<string, unknown>;
      endpoint: "updatemessage" | "updatethread";
    }> = [];
    if (messageTargets.length > 0) {
      batches.push({
        targets: messageTargets,
        body: {
          mode,
          messageId: messageTargets.map(({ nativeId }) => nativeId),
          ...extra,
        },
        endpoint: "updatemessage",
      });
    }
    if (threadTargets.length > 0) {
      const threadExtra = { ...extra };
      if (
        mode === "moveMessage" &&
        typeof threadExtra.destfolderId === "string"
      ) {
        threadExtra.folderId = threadExtra.destfolderId;
        threadExtra.isFolderSpecific = true;
        delete threadExtra.destfolderId;
      }
      batches.push({
        targets: threadTargets,
        body: {
          mode,
          threadId: threadTargets.map(({ nativeId }) => nativeId),
          ...threadExtra,
        },
        endpoint: mode === "archiveMails" ? "updatemessage" : "updatethread",
      });
    }

    for (const batch of batches) {
      try {
        await this.requestJson<unknown>(
          `/api/accounts/${this.providerAccountId}/${batch.endpoint}`,
          { method: "PUT", json: batch.body },
        );
        succeeded.push(...batch.targets.map(({ inputId }) => inputId));
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "Zoho rejected the message update";
        failed.push(...batch.targets.map(({ inputId: id }) => ({ id, reason })));
      }
    }

    const previousLocations: MessageLocation[] = [];
    const destinationFolderId =
      typeof extra.destfolderId === "string" ? extra.destfolderId : undefined;
    for (const id of succeeded) {
      const nativeId = parseListedMessageId(id)?.messageId ?? id;
      const threadReference = this.threadReferences.get(nativeId);
      const messageReference = this.messageReferences.get(nativeId);
      const previousFolder = threadReference?.folder ?? messageReference?.folder;
      if (previousFolder && rememberPrevious) {
        this.previousFolders.set(id, previousFolder);
        previousLocations.push({ id, folder: previousFolder });
      }
      if (destination) {
        if (threadReference) {
          threadReference.folder = destination;
          if (destinationFolderId) threadReference.folderId = destinationFolderId;
          for (const reference of this.messageReferences.values()) {
            if (reference.threadId === threadReference.threadId) {
              reference.folder = destination;
              reference.summary.folder = destination;
              if (destinationFolderId) {
                reference.folderId = destinationFolderId;
                reference.summary.folderId = destinationFolderId;
                this.updateAttachmentFolder(
                  reference.messageId,
                  destinationFolderId,
                );
              }
            }
          }
        }
        if (messageReference) {
          messageReference.folder = destination;
          messageReference.summary.folder = destination;
          if (destinationFolderId) {
            messageReference.folderId = destinationFolderId;
            messageReference.summary.folderId = destinationFolderId;
            this.updateAttachmentFolder(messageReference.messageId, destinationFolderId);
          }
        }
      }
    }
    return {
      succeeded,
      failed,
      ...(previousLocations.length > 0 ? { previousLocations } : {}),
    };
  }

  private validateNativeInputId(id: string): void {
    if (!/^\d{1,128}$/u.test(id)) {
      throw new ZohoMailConfigurationError("Invalid Zoho message id");
    }
  }

  private attachmentKey(messageId: string, attachmentId: string): string {
    return `${messageId}:${attachmentId}`;
  }

  private updateAttachmentFolder(messageId: string, folderId: string): void {
    for (const reference of this.attachmentReferences.values()) {
      if (reference.messageId === messageId) reference.folderId = folderId;
    }
  }

  private async resolveAccessToken(forceRefresh = false): Promise<string> {
    const token =
      typeof this.accessToken === "function"
        ? await this.accessToken({ forceRefresh })
        : this.accessToken;
    if (
      typeof token !== "string" ||
      token.length < 10 ||
      token.length > 4_096 ||
      /[\r\n]/u.test(token)
    ) {
      throw new ZohoMailConfigurationError("A valid Zoho access token is required");
    }
    return token;
  }

  private async requestJson<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      json?: Record<string, unknown>;
      body?: BodyInit;
      headers?: HeadersInit;
      maximumResponseBytes?: number;
    } = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    let body = options.body;
    if (options.json) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.json);
    }
    headers.set("Authorization", `Zoho-oauthtoken ${await this.resolveAccessToken()}`);
    const requestInit: RequestInit = {
      method: options.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
    };
    let response = await this.performRequest(path, requestInit);
    if (response.status === 401 && typeof this.accessToken === "function") {
      await response.body?.cancel();
      headers.set(
        "Authorization",
        `Zoho-oauthtoken ${await this.resolveAccessToken(true)}`,
      );
      response = await this.performRequest(path, requestInit);
    }
    const text = await readBoundedResponseText(
      response,
      options.maximumResponseBytes ?? MAX_JSON_RESPONSE_BYTES,
    );
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ZohoMailApiError(
          "Zoho returned a malformed JSON response",
          response.status,
        );
      }
    }
    const envelope = isRecord(payload) ? payload : undefined;
    const status = envelope && isRecord(envelope.status) ? envelope.status : undefined;
    const apiStatus = numberValue(status?.code);
    const successfulApiStatus =
      apiStatus === undefined || (apiStatus >= 200 && apiStatus < 300);
    if (!response.ok || !successfulApiStatus) {
      throw new ZohoMailApiError(
        "Zoho Mail request failed",
        response.status,
        apiStatus,
      );
    }
    return (envelope?.data ?? null) as T;
  }

  private async requestBinary(
    path: string,
  ): Promise<{ data: Uint8Array; headers: Headers }> {
    const headers = new Headers({ Accept: "application/octet-stream" });
    headers.set("Authorization", `Zoho-oauthtoken ${await this.resolveAccessToken()}`);
    const requestInit: RequestInit = {
      method: "GET",
      headers,
    };
    let response = await this.performRequest(path, requestInit);
    if (response.status === 401 && typeof this.accessToken === "function") {
      await response.body?.cancel();
      headers.set(
        "Authorization",
        `Zoho-oauthtoken ${await this.resolveAccessToken(true)}`,
      );
      response = await this.performRequest(path, requestInit);
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the provider error instead of surfacing stream cleanup details.
      }
      throw new ZohoMailApiError(
        "Zoho Mail attachment download failed",
        response.status,
      );
    }
    const contentLengthHeader = response.headers.get("Content-Length");
    const contentLength =
      contentLengthHeader !== null && /^\d+$/u.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : undefined;
    if (
      contentLength !== undefined &&
      Number.isSafeInteger(contentLength) &&
      contentLength > MAX_ATTACHMENT_BYTES
    ) {
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the size-limit error instead of surfacing cancellation details.
      }
      throw new ZohoMailApiError("Zoho Mail attachment exceeds the safety limit");
    }

    if (!response.body) return { data: new Uint8Array(), headers: response.headers };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ATTACHMENT_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // The safety-limit failure is more useful than a cancellation error.
          }
          throw new ZohoMailApiError(
            "Zoho Mail attachment exceeds the safety limit",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { data, headers: response.headers };
  }

  private async performRequest(path: string, init: RequestInit): Promise<Response> {
    if (!path.startsWith("/api/")) {
      throw new ZohoMailConfigurationError("Invalid Zoho Mail API path");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImplementation(new URL(path, this.apiOrigin), {
        ...init,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ZohoMailApiError("Zoho Mail request timed out");
      }
      if (error instanceof ZohoMailApiError) throw error;
      throw new ZohoMailApiError("Zoho Mail request could not be completed");
    } finally {
      clearTimeout(timeout);
    }
  }
}
