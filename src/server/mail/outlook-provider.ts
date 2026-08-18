import "server-only";

import type {
  MailAccount,
  MailAttachment,
  MailDraft,
  MailFolder,
  MailFolderId,
  MailParticipant,
  MailProvider,
  MailThread,
  MessageLocation,
  MessageQuery,
  OperationResult,
  ThreadMessage,
} from "../../providers/mail/MailProvider";

const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0/";
const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 256;
const SMALL_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const MAX_ATTACHMENT_SIZE = 150 * 1024 * 1024;
const MAX_INCOMING_ATTACHMENT_SIZE = 25 * 1024 * 1024;
const MAX_GRAPH_JSON_BYTES = 8 * 1024 * 1024;
const MAX_GRAPH_LIST_BYTES = 4 * 1024 * 1024;
const MAX_GRAPH_ERROR_BYTES = 64 * 1024;
const MAX_MESSAGE_CONTENT_CHARACTERS = 2_000_000;
const MIN_GRAPH_DATETIME = "0001-01-01T00:00:00Z";
// Graph requires every non-final upload range to be a multiple of 320 KiB.
const UPLOAD_CHUNK_SIZE = 10 * 320 * 1024;

const OUTLOOK_FOLDERS = {
  inbox: { graphId: "inbox", label: "Inbox" },
  sent: { graphId: "sentitems", label: "Sent" },
  drafts: { graphId: "drafts", label: "Drafts" },
  archive: { graphId: "archive", label: "Archive" },
  spam: { graphId: "junkemail", label: "Spam" },
  trash: { graphId: "deleteditems", label: "Trash" },
} as const satisfies Record<Exclude<MailFolderId, "starred">, {
  graphId: string;
  label: string;
}>;

type ConcreteFolderId = keyof typeof OUTLOOK_FOLDERS;

type Fetch = typeof globalThis.fetch;

type AccessTokenProvider = () => string | Promise<string>;

interface OutlookAccountSeed {
  address: string;
  label: string;
  providerAccountId?: string;
}

export interface OutlookMailProviderOptions {
  accountId: string;
  getAccessToken: AccessTokenProvider;
  account?: Readonly<OutlookAccountSeed>;
  fetch?: Fetch;
  graphBaseUrl?: string;
  pageSize?: number;
  allowedUploadOrigins?: readonly string[];
}

interface PageQuery extends MessageQuery {
  cursor?: string;
  pageSize?: number;
}

interface FutureMailAttachment extends MailAttachment {
  mimeType?: string;
  sizeBytes?: number;
  contentBase64?: string;
  sourceMessageId?: string;
}

export interface OutlookMessagePage {
  messages: MailThread[];
  nextCursor?: string;
}

export interface OutlookAttachmentContent {
  data: Uint8Array;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface OutlookRawMessageContent {
  content: string;
  contentType: "text/plain" | "text/html";
}

export type OutlookMailThread = MailThread & {
  /** Native Microsoft Graph conversation identifier. */
  conversationId: string;
};

interface GraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.count"?: number;
}

interface GraphEmailAddress {
  name?: string | null;
  address?: string | null;
}

interface GraphRecipient {
  emailAddress?: GraphEmailAddress | null;
}

interface GraphBody {
  content?: string | null;
  contentType?: string | null;
}

interface GraphFlag {
  flagStatus?: string | null;
}

interface GraphAttachment {
  id?: string | null;
  name?: string | null;
  size?: number | null;
  contentType?: string | null;
  isInline?: boolean | null;
  contentId?: string | null;
}

interface GraphMessage {
  id?: string | null;
  conversationId?: string | null;
  parentFolderId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: GraphBody | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  bccRecipients?: GraphRecipient[] | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  lastModifiedDateTime?: string | null;
  isRead?: boolean | null;
  isDraft?: boolean | null;
  flag?: GraphFlag | null;
  categories?: string[] | null;
  hasAttachments?: boolean | null;
  attachments?: GraphAttachment[] | null;
}

interface GraphFolder {
  id?: string | null;
  displayName?: string | null;
  totalItemCount?: number | null;
  unreadItemCount?: number | null;
}

interface GraphUser {
  id?: string | null;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

interface GraphUploadSession {
  uploadUrl?: string | null;
}

interface CursorEnvelope {
  version: 1;
  fingerprint: string;
  nextLink: string;
}

type MessageTimestampSource = "received" | "sent";

interface GraphErrorBody {
  error?: {
    code?: string;
  };
}

export class OutlookGraphError extends Error {
  readonly code = "OUTLOOK_GRAPH_ERROR";

  constructor(
    readonly status: number,
    readonly graphCode: string,
    readonly requestId?: string,
    readonly retryAfter?: string,
  ) {
    super(`Microsoft Graph request failed (${status}, ${graphCode})`);
    this.name = "OutlookGraphError";
  }
}

export class OutlookAttachmentContentError extends Error {
  readonly code = "OUTLOOK_ATTACHMENT_CONTENT_REQUIRED";

  constructor(readonly attachmentId: string) {
    super(`Attachment content is required for ${attachmentId}`);
    this.name = "OutlookAttachmentContentError";
  }
}

export class OutlookUnsupportedQueryError extends TypeError {
  readonly code = "OUTLOOK_STARRED_SEARCH_UNSUPPORTED";

  constructor() {
    super("Outlook cannot search within Starred without returning incomplete results");
    this.name = "OutlookUnsupportedQueryError";
  }
}

const messageSummarySelect = [
  "id",
  "conversationId",
  "parentFolderId",
  "subject",
  "bodyPreview",
  "from",
  "sender",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "receivedDateTime",
  "sentDateTime",
  "lastModifiedDateTime",
  "isRead",
  "isDraft",
  "flag",
  "categories",
  "hasAttachments",
].join(",");

const attachmentExpand =
  "attachments($select=id,name,size,contentType,isInline,contentId)";

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new TypeError("Microsoft Graph base URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("Microsoft Graph base URL must not contain credentials or a query");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function participant(recipient?: GraphRecipient | null): MailParticipant {
  const email = recipient?.emailAddress?.address?.trim() || "unknown@invalid";
  return {
    name: recipient?.emailAddress?.name?.trim() || email,
    email,
  };
}

function participants(recipients?: GraphRecipient[] | null): MailParticipant[] {
  return (recipients ?? []).map(participant);
}

function paragraphs(content?: string | null): string[] {
  const normalized = (content ?? "").replace(/\u0000/g, "").trim();
  if (!normalized) return [];
  return normalized
    .split(/\r?\n\s*\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function formatBytes(value?: number | null): string {
  const bytes = Number.isFinite(value) && (value ?? 0) > 0 ? value! : 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

function attachmentKind(
  contentType?: string | null,
  filename?: string | null,
): MailAttachment["kind"] {
  if (contentType?.toLowerCase().startsWith("image/")) return "image";
  const extension = filename?.split(".").at(-1)?.toLowerCase();
  if (
    extension &&
    ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(extension)
  ) {
    return "archive";
  }
  return "document";
}

function mapAttachment(
  value: GraphAttachment,
  sourceMessageId?: string,
): FutureMailAttachment | null {
  const id = value.id?.trim();
  if (!id) return null;
  const name = value.name?.trim() || "attachment";
  const sizeBytes =
    typeof value.size === "number" && Number.isFinite(value.size)
      ? Math.max(0, value.size)
      : 0;
  return {
    id,
    name,
    size: formatBytes(sizeBytes),
    kind: attachmentKind(value.contentType, name),
    mimeType: value.contentType?.trim() || "application/octet-stream",
    sizeBytes,
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(value.isInline ? { inline: true } : {}),
    ...(value.contentId?.trim() ? { contentId: value.contentId.trim() } : {}),
  };
}

function draftRecipientAddresses(recipients?: GraphRecipient[] | null): string[] {
  const addresses: string[] = [];
  for (const recipient of recipients ?? []) {
    const address = recipient.emailAddress?.address?.trim() ?? "";
    if (
      !address ||
      address.length > 320 ||
      !address.includes("@") ||
      /[\r\n\u0000]/u.test(address)
    ) {
      throw new OutlookGraphError(502, "InvalidDraftRecipient");
    }
    addresses.push(address);
  }
  return unique(addresses);
}

function draftBodyText(body?: GraphBody | null): string {
  const content = body?.content ?? "";
  if (content.length > MAX_MESSAGE_CONTENT_CHARACTERS) {
    throw new OutlookGraphError(502, "MessageContentTooLarge");
  }
  return body?.contentType?.toLowerCase() === "html"
    ? htmlToPlainText(content)
    : normalizePlainText(content);
}

function htmlToPlainText(content: string): string {
  const withoutRawContent = content.replace(
    /<(script|style|template|title)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
    "",
  );
  const withLineBreaks = withoutRawContent
    .replace(/<br\b[^>]*>/giu, "\n")
    .replace(/<\/(?:address|blockquote|div|h[1-6]|li|ol|p|pre|table|tr|ul)\s*>/giu, "\n");
  const withoutTags = withLineBreaks
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<[^>]*>/gu, "");
  return normalizePlainText(decodeHtmlText(withoutTags));
}

function decodeHtmlText(value: string): string {
  return value.replace(
    /&(?:amp|quot|apos|lt|gt|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/giu,
    (entity) => {
      const normalized = entity.toLowerCase();
      const named: Record<string, string> = {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
        "&nbsp;": " ",
      };
      if (named[normalized] !== undefined) return named[normalized];
      const numeric = normalized.startsWith("&#x")
        ? Number.parseInt(normalized.slice(3, -1), 16)
        : Number.parseInt(normalized.slice(2, -1), 10);
      return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : "";
    },
  );
}

function normalizePlainText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function messageTimestamp(
  message: GraphMessage,
  source: MessageTimestampSource = "received",
): string {
  const preferred =
    source === "sent" ? message.sentDateTime : message.receivedDateTime;
  const fallback =
    source === "sent" ? message.receivedDateTime : message.sentDateTime;
  return preferred ?? fallback ?? message.lastModifiedDateTime ?? new Date(0).toISOString();
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatShortTimestamp(value: string, draft: boolean): string {
  if (draft) return "Draft";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(parsed);
}

function formatFullTimestamp(value: string, draft: boolean): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const formatted = new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(parsed);
  return draft ? `Draft saved ${formatted}` : formatted;
}

function encodeCursor(envelope: CursorEnvelope): string {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeCursor(cursor: string): CursorEnvelope {
  if (!/^[A-Za-z0-9_-]{1,16384}$/u.test(cursor)) {
    throw new TypeError("Invalid Outlook page cursor");
  }
  const standard = cursor.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  let parsed: unknown;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TypeError("Invalid Outlook page cursor");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as Partial<CursorEnvelope>).version !== 1 ||
    typeof (parsed as Partial<CursorEnvelope>).fingerprint !== "string" ||
    typeof (parsed as Partial<CursorEnvelope>).nextLink !== "string"
  ) {
    throw new TypeError("Invalid Outlook page cursor");
  }
  return parsed as CursorEnvelope;
}

function decodeBase64(content: string): Uint8Array {
  const normalized = content.replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    normalized.length > Math.ceil((MAX_ATTACHMENT_SIZE * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)
  ) {
    throw new TypeError("Attachment content must be valid base64");
  }
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new TypeError("Attachment content must be valid base64");
  }
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  if (bytes.byteLength > MAX_ATTACHMENT_SIZE) {
    throw new RangeError("Outlook attachments cannot exceed 150 MB");
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function graphRecipients(values: readonly string[]): GraphRecipient[] {
  return unique(values).map((address) => {
    if (
      address.length > 320 ||
      !address.includes("@") ||
      /[\r\n\u0000]/u.test(address)
    ) {
      throw new TypeError(`Invalid email recipient: ${address}`);
    }
    return { emailAddress: { address } };
  });
}

function draftPayload(draft: MailDraft) {
  return {
    subject: draft.subject,
    body: { contentType: "Text", content: draft.body },
    toRecipients: graphRecipients(draft.to),
    ccRecipients: graphRecipients(draft.cc),
    bccRecipients: graphRecipients(draft.bcc),
  };
}

function linkedDraftPayload(draft: MailDraft) {
  return {
    subject: draft.subject,
    toRecipients: graphRecipients(draft.to),
    ccRecipients: graphRecipients(draft.cc),
    bccRecipients: graphRecipients(draft.bcc),
  };
}

function failureReason(error: unknown): string {
  if (error instanceof OutlookGraphError) {
    return `Microsoft Graph rejected the operation (${error.status}, ${error.graphCode})`;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Microsoft Graph operation failed";
}

/**
 * Microsoft Graph-backed Outlook.com adapter. Access tokens are requested only
 * inside the server-only adapter, and every returned Graph identifier opts into
 * the provider's ImmutableId format.
 */
export class OutlookMailProvider implements MailProvider {
  private readonly accountId: string;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly account?: Readonly<OutlookAccountSeed>;
  private readonly fetchImpl: Fetch;
  private readonly graphBaseUrl: URL;
  private readonly defaultPageSize: number;
  private readonly allowedUploadOrigins: ReadonlySet<string>;
  private readonly messageFolderHints = new Map<string, MailFolderId>();
  private readonly attachmentAliases = new Map<string, string>();
  private folderIdMapPromise?: Promise<Map<string, ConcreteFolderId>>;

  constructor(options: Readonly<OutlookMailProviderOptions>) {
    const accountId = options.accountId.trim();
    if (!accountId) throw new TypeError("An Outlook account ID is required");
    if (typeof options.getAccessToken !== "function") {
      throw new TypeError("An Outlook access-token provider is required");
    }
    if (options.account) {
      if (!options.account.address.trim() || !options.account.label.trim()) {
        throw new TypeError("The seeded Outlook account must have an address and label");
      }
    }

    this.accountId = accountId;
    this.getAccessToken = options.getAccessToken;
    this.account = options.account;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.graphBaseUrl = normalizeBaseUrl(
      options.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL,
    );
    this.defaultPageSize = this.normalizePageSize(
      options.pageSize ?? DEFAULT_PAGE_SIZE,
    );
    this.allowedUploadOrigins = new Set(
      options.allowedUploadOrigins ?? ["https://outlook.office.com"],
    );
  }

  async getAccounts(): Promise<MailAccount[]> {
    let address = this.account?.address.trim();
    let label = this.account?.label.trim();

    if (!address || !label) {
      const profile = await this.graphJson<GraphUser>(
        this.withQuery("me", {
          $select: "id,displayName,mail,userPrincipalName",
        }),
      );
      if (
        this.account?.providerAccountId &&
        profile.id !== this.account.providerAccountId
      ) {
        throw new OutlookGraphError(403, "AccountIdentityMismatch");
      }
      address = profile.mail?.trim() || profile.userPrincipalName?.trim();
      label = profile.displayName?.trim() || address;
    }

    if (!address || !label) {
      throw new OutlookGraphError(502, "AccountProfileIncomplete");
    }

    return [
      {
        id: this.accountId,
        provider: "outlook",
        label,
        address,
        color: "#3f78bd",
        connected: true,
        capabilities: {
          labels: false,
          reliableDraftUpdates: true,
          externalImages: false,
          permanentDelete: false,
        },
      },
    ];
  }

  async getFolders(scope: MessageQuery["scope"]): Promise<MailFolder[]> {
    if (scope !== "all" && scope !== "outlook") return [];

    const folderEntries = Object.entries(OUTLOOK_FOLDERS) as Array<
      [ConcreteFolderId, (typeof OUTLOOK_FOLDERS)[ConcreteFolderId]]
    >;
    const resources = await Promise.all(
      folderEntries.map(async ([id, folder]) => {
        try {
          const resource = await this.graphJson<GraphFolder>(
            this.withQuery(`me/mailFolders/${folder.graphId}`, {
              $select: "id,displayName,totalItemCount,unreadItemCount",
            }),
          );
          return [id, resource] as const;
        } catch (error) {
          if (error instanceof OutlookGraphError && error.status === 404) {
            return [id, null] as const;
          }
          throw error;
        }
      }),
    );

    const idMap = new Map<string, ConcreteFolderId>();
    for (const [id, resource] of resources) {
      if (resource?.id) idMap.set(resource.id, id);
    }
    this.folderIdMapPromise = Promise.resolve(idMap);

    let starredCount: number | undefined;
    try {
      const starred = await this.graphJson<GraphCollection<GraphMessage>>(
        this.withQuery("me/messages", {
          $select: "id",
          $filter: "flag/flagStatus eq 'flagged'",
          $count: "true",
          $top: "1",
        }),
        { headers: { ConsistencyLevel: "eventual" } },
      );
      if (typeof starred["@odata.count"] === "number") {
        starredCount = starred["@odata.count"];
      }
    } catch (error) {
      if (!(error instanceof OutlookGraphError && error.status === 400)) {
        throw error;
      }
    }

    const folders: MailFolder[] = resources.map(([id, resource]) => ({
      id,
      label: OUTLOOK_FOLDERS[id].label,
      count:
        id === "inbox"
          ? resource?.unreadItemCount ?? 0
          : resource?.totalItemCount ?? 0,
    }));
    folders.splice(1, 0, {
      id: "starred",
      label: "Starred",
      ...(starredCount === undefined ? {} : { count: starredCount }),
    });
    return folders;
  }

  async getMessages(query: MessageQuery): Promise<MailThread[]> {
    return (await this.getMessagesPage(query)).messages;
  }

  async getMessagesPage(query: PageQuery): Promise<OutlookMessagePage> {
    if (query.scope !== "all" && query.scope !== "outlook") {
      return { messages: [] };
    }

    const search = query.search?.trim() ?? "";
    if (search.length > MAX_SEARCH_LENGTH) {
      throw new RangeError(`Outlook search is limited to ${MAX_SEARCH_LENGTH} characters`);
    }
    if (query.folder === "starred" && search) {
      throw new OutlookUnsupportedQueryError();
    }
    const fingerprint = `${query.folder}\n${search}`;
    const requestedUrl = query.cursor
      ? this.urlFromCursor(query.cursor, fingerprint, query.folder)
      : this.messageListUrl(query, search);
    const page = await this.graphJson<GraphCollection<GraphMessage>>(
      requestedUrl,
      {},
      MAX_GRAPH_LIST_BYTES,
    );
    let values = (page.value ?? []).filter(
      (message): message is GraphMessage & { id: string } =>
        typeof message.id === "string" && message.id.length > 0,
    );

    if (query.folder === "starred") {
      values = values.filter(
        (message) => message.flag?.flagStatus?.toLowerCase() === "flagged",
      );
    }

    const folderMap =
      query.folder === "starred" ? await this.ensureFolderIdMap() : undefined;
    // Graph orders message-collection $search results by sentDateTime.
    const timestampSource: MessageTimestampSource = search ? "sent" : "received";
    const messages = values
      .map((message) => {
        const folder =
          query.folder === "starred"
            ? (this.folderFromProviderId(message.parentFolderId, folderMap) ??
              "starred")
            : query.folder;
        return {
          thread: this.toThread(message.id!, [message], folder, timestampSource),
          timestamp: timestampValue(messageTimestamp(message, timestampSource)),
        };
      })
      .sort((left, right) => right.timestamp - left.timestamp)
      .map(({ thread }) => thread);

    return {
      messages,
      ...(page["@odata.nextLink"]
        ? {
            nextCursor: encodeCursor({
              version: 1,
              fingerprint,
              nextLink: this.resolveGraphUrl(page["@odata.nextLink"]).toString(),
            }),
          }
        : {}),
    };
  }

  async getMessage(id: string): Promise<MailThread | null> {
    const messageId = this.requireId(id, "message");
    let seed: GraphMessage;
    try {
      seed = await this.graphJson<GraphMessage>(this.messageUrl(messageId));
    } catch (error) {
      if (error instanceof OutlookGraphError && error.status === 404) return null;
      throw error;
    }
    if (!seed.id) return null;

    const hintedFolder = this.messageFolderHints.get(messageId);
    const folder =
      hintedFolder ??
      this.folderFromProviderId(seed.parentFolderId, await this.ensureFolderIdMap()) ??
      "starred";
    return this.toThread(messageId, [seed], folder);
  }

  async getDraft(id: string): Promise<MailDraft | null> {
    const draftId = this.requireId(id, "draft");
    let message: GraphMessage;
    try {
      message = await this.graphJson<GraphMessage>(
        this.withQuery(`me/messages/${encodeURIComponent(draftId)}`, {
          $select:
            "id,isDraft,subject,body,toRecipients,ccRecipients,bccRecipients",
          $expand: attachmentExpand,
        }),
        {
          headers: {
            Prefer:
              'IdType="ImmutableId", outlook.body-content-type="text"',
          },
        },
      );
    } catch (error) {
      if (error instanceof OutlookGraphError && error.status === 404) return null;
      throw error;
    }
    if (message.isDraft !== true) return null;
    if (message.id?.trim() !== draftId) {
      throw new OutlookGraphError(502, "DraftIdentityMismatch");
    }

    return {
      id: draftId,
      accountId: this.accountId,
      to: draftRecipientAddresses(message.toRecipients),
      cc: draftRecipientAddresses(message.ccRecipients),
      bcc: draftRecipientAddresses(message.bccRecipients),
      subject: (message.subject ?? "").replace(/\u0000/gu, "").slice(0, 998),
      body: draftBodyText(message.body),
      attachments: (message.attachments ?? [])
        .map((attachment) => mapAttachment(attachment, draftId))
        .filter(
          (attachment): attachment is FutureMailAttachment => Boolean(attachment),
        ),
    };
  }

  async sendMessage(draft: MailDraft): Promise<{ id: string }> {
    const draftId = draft.id
      ? await this.updateDraft(draft)
      : await this.createDraft(draft);
    await this.graphVoid(`me/messages/${encodeURIComponent(draftId)}/send`, {
      method: "POST",
    });
    return { id: draftId };
  }

  async saveDraft(draft: MailDraft): Promise<{ id: string; savedAt: string }> {
    const id = draft.id
      ? await this.updateDraft(draft)
      : await this.createDraft(draft);
    const now = new Date().toISOString();
    return { id, savedAt: formatShortTimestamp(now, false) };
  }

  async replyMessage(id: string, draft: MailDraft): Promise<{ id: string }> {
    return this.createLinkedDraftAndSend("createReply", id, draft);
  }

  async forwardMessage(id: string, draft: MailDraft): Promise<{ id: string }> {
    return this.createLinkedDraftAndSend("createForward", id, draft);
  }

  async archiveMessages(ids: string[]): Promise<OperationResult> {
    return this.moveMessages(ids, "archive");
  }

  async moveToTrash(ids: string[]): Promise<OperationResult> {
    return this.moveMessages(ids, "trash");
  }

  async restoreFromTrash(ids: string[]): Promise<OperationResult> {
    return this.restoreMessages(unique(ids).map((id) => ({ id, folder: "inbox" })));
  }

  async restoreMessages(locations: MessageLocation[]): Promise<OperationResult> {
    const deduplicated = new Map<string, MailFolderId>();
    for (const location of locations) deduplicated.set(location.id, location.folder);

    const succeeded: string[] = [];
    const failed: OperationResult["failed"] = [];
    const previousLocations: MessageLocation[] = [];
    for (const [rawId, folder] of deduplicated) {
      const id = rawId.trim();
      try {
        const target = this.concreteFolder(folder);
        const previous = await this.locationForMessage(id);
        if (previous !== target) {
          await this.moveMessage(id, target);
        }
        succeeded.push(id);
        if (previous) previousLocations.push({ id, folder: previous });
        this.messageFolderHints.set(id, target);
      } catch (error) {
        failed.push({ id, reason: failureReason(error) });
      }
    }
    return { succeeded, failed, previousLocations };
  }

  async markRead(ids: string[], read: boolean): Promise<OperationResult> {
    return this.patchMessages(ids, { isRead: read });
  }

  async setStarred(id: string, starred: boolean): Promise<OperationResult> {
    return this.patchMessages([id], {
      flag: { flagStatus: starred ? "flagged" : "notFlagged" },
    });
  }

  async searchMessages(query: MessageQuery): Promise<MailThread[]> {
    return this.getMessages(query);
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<OutlookAttachmentContent | null> {
    const safeMessageId = this.requireId(messageId, "message");
    const requestedAttachmentId = this.requireId(attachmentId, "attachment");
    const safeAttachmentId =
      this.attachmentAliases.get(`${safeMessageId}:${requestedAttachmentId}`) ??
      requestedAttachmentId;
    const base = `me/messages/${encodeURIComponent(safeMessageId)}/attachments/${encodeURIComponent(safeAttachmentId)}`;
    let metadata: GraphAttachment;
    let response: Response;
    try {
      [metadata, response] = await Promise.all([
        this.graphJson<GraphAttachment>(
        this.withQuery(base, {
          $select: "id,name,size,contentType,isInline,contentId",
        }),
        ),
        this.graphFetch(`${base}/$value`),
      ]);
    } catch (error) {
      if (error instanceof OutlookGraphError && error.status === 404) return null;
      throw error;
    }

    const data = await readBytesWithLimit(
      response,
      MAX_INCOMING_ATTACHMENT_SIZE,
      () => new OutlookGraphError(413, "AttachmentTooLarge"),
    );
    return {
      data,
      filename: metadata.name?.trim() || "attachment",
      mimeType:
        metadata.contentType?.trim() ||
        response.headers.get("content-type")?.split(";", 1)[0] ||
        "application/octet-stream",
      sizeBytes:
        typeof metadata.size === "number" && metadata.size >= 0
          ? metadata.size
          : data.byteLength,
    };
  }

  async getRawMessageContent(
    messageId: string,
  ): Promise<OutlookRawMessageContent | null> {
    const id = this.requireId(messageId, "message");
    let message: GraphMessage;
    try {
      message = await this.graphJson<GraphMessage>(
        this.withQuery(`me/messages/${encodeURIComponent(id)}`, {
          $select: "body",
        }),
        { headers: { Prefer: 'IdType="ImmutableId"' } },
        4 * 1024 * 1024,
      );
    } catch (error) {
      if (error instanceof OutlookGraphError && error.status === 404) return null;
      throw error;
    }
    if (typeof message.body?.content !== "string") return null;
    if (message.body.content.length > MAX_MESSAGE_CONTENT_CHARACTERS) {
      throw new OutlookGraphError(502, "MessageContentTooLarge");
    }
    return {
      content: message.body.content,
      contentType:
        message.body.contentType?.toLowerCase() === "html"
          ? "text/html"
          : "text/plain",
    };
  }

  private normalizePageSize(value: number): number {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError("Outlook page size must be a positive integer");
    }
    return Math.min(value, MAX_PAGE_SIZE);
  }

  private messageListUrl(query: PageQuery, search: string): string {
    const pageSize = this.normalizePageSize(query.pageSize ?? this.defaultPageSize);
    const params: Record<string, string> = {
      $select: messageSummarySelect,
      $expand: attachmentExpand,
      $top: String(pageSize),
    };

    let path: string;
    if (query.folder === "starred") {
      path = "me/messages";
      // Graph requires order-by properties to appear first in the filter.
      params.$filter =
        `receivedDateTime ge ${MIN_GRAPH_DATETIME} and flag/flagStatus eq 'flagged'`;
    } else {
      path = `me/mailFolders/${OUTLOOK_FOLDERS[query.folder].graphId}/messages`;
    }

    if (search) {
      const escaped = search.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      params.$search = `"${escaped}"`;
    } else {
      params.$orderby = "receivedDateTime desc";
    }
    return this.withQuery(path, params);
  }

  private urlFromCursor(
    cursor: string,
    fingerprint: string,
    folder: MailFolderId,
  ): string {
    const envelope = decodeCursor(cursor);
    if (envelope.fingerprint !== fingerprint) {
      throw new TypeError("Outlook page cursor does not match this query");
    }
    const url = this.resolveGraphUrl(envelope.nextLink);
    const expectedPath = this.resolveGraphUrl(
      folder === "starred"
        ? "me/messages"
        : `me/mailFolders/${OUTLOOK_FOLDERS[folder].graphId}/messages`,
    ).pathname;
    if (url.pathname !== expectedPath) {
      throw new TypeError("Outlook page cursor target was rejected");
    }
    return url.toString();
  }

  private messageUrl(id: string): string {
    return this.withQuery(`me/messages/${encodeURIComponent(id)}`, {
      $select: messageSummarySelect,
      $expand: attachmentExpand,
    });
  }

  private toThread(
    threadId: string,
    messages: GraphMessage[],
    folder: MailFolderId,
    timestampSource: MessageTimestampSource = "received",
  ): OutlookMailThread {
    const sorted = [...messages].sort(
      (left, right) =>
        timestampValue(messageTimestamp(left, timestampSource)) -
        timestampValue(messageTimestamp(right, timestampSource)),
    );
    const representative = sorted.at(-1) ?? {};
    const timestamp = messageTimestamp(representative, timestampSource);
    const draft = Boolean(representative.isDraft);
    const sender = participant(representative.from ?? representative.sender);
    const conversationId = representative.conversationId?.trim() || threadId;

    this.messageFolderHints.set(threadId, folder);
    for (const message of sorted) {
      if (message.id) this.messageFolderHints.set(message.id, folder);
    }

    return {
      id: threadId,
      conversationId,
      provider: "outlook",
      accountId: this.accountId,
      folder,
      sender,
      subject: representative.subject?.trim() || "(No subject)",
      preview: representative.bodyPreview?.trim() || "",
      receivedAt: formatShortTimestamp(timestamp, draft),
      receivedAtFull: formatFullTimestamp(timestamp, draft),
      receivedAtMs: timestampValue(timestamp),
      unread: sorted.some((message) => message.isRead === false),
      starred: sorted.some(
        (message) => message.flag?.flagStatus?.toLowerCase() === "flagged",
      ),
      labels: unique(sorted.flatMap((message) => message.categories ?? [])),
      hasExternalImages: false,
      messages: sorted.flatMap((message) => {
        const id = message.id?.trim();
        if (!id) return [];
        const value = messageTimestamp(message, timestampSource);
        const isDraft = Boolean(message.isDraft);
        return [
          {
            id,
            sender: participant(message.from ?? message.sender),
            recipients: participants([
              ...(message.toRecipients ?? []),
              ...(message.ccRecipients ?? []),
              ...(message.bccRecipients ?? []),
            ]),
            sentAt: formatShortTimestamp(value, isDraft),
            sentAtFull: formatFullTimestamp(value, isDraft),
            body: paragraphs(message.body?.content ?? message.bodyPreview),
            attachments: (message.attachments ?? [])
              .map((attachment) => mapAttachment(attachment))
              .filter((attachment): attachment is FutureMailAttachment => Boolean(attachment)),
          } satisfies ThreadMessage,
        ];
      }),
    };
  }

  private async createDraft(draft: MailDraft): Promise<string> {
    const created = await this.graphJson<GraphMessage>("me/messages", {
      method: "POST",
      body: JSON.stringify(draftPayload(draft)),
    });
    const id = created.id?.trim();
    if (!id) throw new OutlookGraphError(502, "DraftIdMissing");
    await this.syncAttachments(id, draft.attachments as FutureMailAttachment[]);
    return id;
  }

  private async updateDraft(draft: MailDraft): Promise<string> {
    const id = this.requireId(draft.id ?? "", "draft");
    await this.graphJson<GraphMessage>(
      `me/messages/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(draftPayload(draft)),
      },
    );
    await this.syncAttachments(id, draft.attachments as FutureMailAttachment[]);
    return id;
  }

  private async createLinkedDraftAndSend(
    action: "createReply" | "createForward",
    sourceId: string,
    draft: MailDraft,
  ): Promise<{ id: string }> {
    const id = this.requireId(sourceId, "message");
    const linked = await this.graphJson<GraphMessage>(
      `me/messages/${encodeURIComponent(id)}/${action}`,
      {
        method: "POST",
        body: JSON.stringify({ comment: draft.body }),
      },
    );
    const linkedId = linked.id?.trim();
    if (!linkedId) throw new OutlookGraphError(502, "DraftIdMissing");

    await this.graphJson<GraphMessage>(
      `me/messages/${encodeURIComponent(linkedId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(linkedDraftPayload(draft)),
      },
    );
    const attachments = draft.id
      ? await this.materializeAttachments(
          draft.id,
          draft.attachments as FutureMailAttachment[],
        )
      : (draft.attachments as FutureMailAttachment[]);
    await this.syncAttachments(linkedId, attachments, action === "createForward");
    await this.graphVoid(`me/messages/${encodeURIComponent(linkedId)}/send`, {
      method: "POST",
    });

    if (draft.id && draft.id !== linkedId) {
      try {
        await this.graphVoid(`me/messages/${encodeURIComponent(draft.id)}`, {
          method: "DELETE",
        });
      } catch {
        // The linked message has already been sent; a stale autosave is harmless.
      }
    }
    return { id: linkedId };
  }

  private async syncAttachments(
    messageId: string,
    desired: readonly FutureMailAttachment[],
    preserveExisting = false,
  ): Promise<void> {
    const base = `me/messages/${encodeURIComponent(messageId)}/attachments`;
    const existingPage = await this.graphJson<GraphCollection<GraphAttachment>>(
      this.withQuery(base, {
        $select: "id,name,size,contentType,isInline,contentId",
        $top: "1000",
      }),
    );
    const existing = (existingPage.value ?? []).filter(
      (attachment): attachment is GraphAttachment & { id: string } =>
        typeof attachment.id === "string" && attachment.id.length > 0,
    );
    const existingIds = new Set(existing.map((attachment) => attachment.id));
    const desiredExistingIds = new Set<string>();
    const uploads: Array<{
      attachment: FutureMailAttachment;
      bytes: Uint8Array;
      contentBase64: string;
    }> = [];

    for (const attachment of desired) {
      const alias = this.attachmentAliases.get(`${messageId}:${attachment.id}`);
      const providerId = alias ?? attachment.id;
      if (existingIds.has(providerId)) {
        desiredExistingIds.add(providerId);
        continue;
      }
      if (!attachment.contentBase64) {
        throw new OutlookAttachmentContentError(attachment.id);
      }
      const bytes = decodeBase64(attachment.contentBase64);
      if (
        attachment.sizeBytes !== undefined &&
        attachment.sizeBytes !== bytes.byteLength
      ) {
        throw new TypeError(`Attachment size does not match content: ${attachment.id}`);
      }
      uploads.push({
        attachment,
        bytes,
        contentBase64: attachment.contentBase64.replace(/\s+/g, ""),
      });
    }

    for (const attachment of existing) {
      if (
        !preserveExisting &&
        !attachment.isInline &&
        !desiredExistingIds.has(attachment.id)
      ) {
        await this.graphVoid(`${base}/${encodeURIComponent(attachment.id)}`, {
          method: "DELETE",
        });
      }
    }

    for (const upload of uploads) {
      const providerId = await this.uploadAttachment(
        messageId,
        upload.attachment,
        upload.bytes,
        upload.contentBase64,
      );
      if (providerId) {
        this.attachmentAliases.set(
          `${messageId}:${upload.attachment.id}`,
          providerId,
        );
      }
    }
  }

  private async materializeAttachments(
    sourceMessageId: string,
    attachments: readonly FutureMailAttachment[],
  ): Promise<FutureMailAttachment[]> {
    return Promise.all(
      attachments.map(async (attachment) => {
        if (attachment.contentBase64) return attachment;
        const content = await this.getAttachment(sourceMessageId, attachment.id);
        if (!content) throw new OutlookAttachmentContentError(attachment.id);
        return {
          ...attachment,
          name: content.filename,
          mimeType: content.mimeType,
          sizeBytes: content.sizeBytes,
          contentBase64: encodeBase64(content.data),
        };
      }),
    );
  }

  private async uploadAttachment(
    messageId: string,
    attachment: FutureMailAttachment,
    bytes: Uint8Array,
    contentBase64: string,
  ): Promise<string | undefined> {
    const contentType = attachment.mimeType?.trim() || "application/octet-stream";
    if (bytes.byteLength < SMALL_ATTACHMENT_LIMIT) {
      const created = await this.graphJson<GraphAttachment>(
        `me/messages/${encodeURIComponent(messageId)}/attachments`,
        {
          method: "POST",
          body: JSON.stringify({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: attachment.name,
            contentType,
            contentBytes: contentBase64,
            ...(attachment.inline ? { isInline: true } : {}),
            ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
          }),
        },
      );
      return created.id?.trim() || undefined;
    }

    const session = await this.graphJson<GraphUploadSession>(
      `me/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`,
      {
        method: "POST",
        body: JSON.stringify({
          AttachmentItem: {
            attachmentType: "file",
            name: attachment.name,
            size: bytes.byteLength,
            contentType,
            ...(attachment.inline ? { isInline: true } : {}),
            ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
          },
        }),
      },
    );
    const uploadUrl = this.validateUploadUrl(session.uploadUrl);
    let location: string | null = null;
    for (let start = 0; start < bytes.byteLength; start += UPLOAD_CHUNK_SIZE) {
      const endExclusive = Math.min(start + UPLOAD_CHUNK_SIZE, bytes.byteLength);
      const chunk = bytes.slice(start, endExclusive);
      const response = await this.fetchImpl(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(chunk.byteLength),
          "Content-Range": `bytes ${start}-${endExclusive - 1}/${bytes.byteLength}`,
        },
        body: chunk,
      });
      if (![200, 201, 202].includes(response.status)) {
        throw await this.responseError(response);
      }
      location = response.headers.get("location") ?? location;
    }
    return location ? this.attachmentIdFromLocation(location) : undefined;
  }

  private validateUploadUrl(value?: string | null): string {
    if (!value) throw new OutlookGraphError(502, "UploadUrlMissing");
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !this.allowedUploadOrigins.has(url.origin) ||
      !url.search
    ) {
      throw new OutlookGraphError(502, "UploadUrlRejected");
    }
    return url.toString();
  }

  private attachmentIdFromLocation(location: string): string | undefined {
    try {
      const decoded = decodeURIComponent(new URL(location).pathname);
      const match = decoded.match(/\/Attachments\('([^']+)'\)\/?$/iu);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private async moveMessages(
    ids: readonly string[],
    destination: ConcreteFolderId,
  ): Promise<OperationResult> {
    const succeeded: string[] = [];
    const failed: OperationResult["failed"] = [];
    const previousLocations: MessageLocation[] = [];
    for (const rawId of unique(ids)) {
      const id = rawId.trim();
      try {
        const previous = await this.locationForMessage(id);
        if (previous !== destination) {
          await this.moveMessage(id, destination);
        }
        succeeded.push(id);
        if (previous) previousLocations.push({ id, folder: previous });
        this.messageFolderHints.set(id, destination);
      } catch (error) {
        failed.push({ id, reason: failureReason(error) });
      }
    }
    return { succeeded, failed, previousLocations };
  }

  private async moveMessage(id: string, destination: ConcreteFolderId) {
    await this.graphJson<GraphMessage>(
      `me/messages/${encodeURIComponent(this.requireId(id, "message"))}/move`,
      {
        method: "POST",
        body: JSON.stringify({ destinationId: OUTLOOK_FOLDERS[destination].graphId }),
      },
    );
  }

  private async patchMessages(
    ids: readonly string[],
    patch: Readonly<Record<string, unknown>>,
  ): Promise<OperationResult> {
    const succeeded: string[] = [];
    const failed: OperationResult["failed"] = [];
    for (const rawId of unique(ids)) {
      const id = rawId.trim();
      try {
        await this.graphJson<GraphMessage>(
          `me/messages/${encodeURIComponent(this.requireId(id, "message"))}`,
          { method: "PATCH", body: JSON.stringify(patch) },
        );
        succeeded.push(id);
      } catch (error) {
        failed.push({ id, reason: failureReason(error) });
      }
    }
    return { succeeded, failed };
  }

  private async locationForMessage(id: string): Promise<ConcreteFolderId | null> {
    const hinted = this.messageFolderHints.get(id);
    if (hinted && hinted !== "starred") return hinted;
    const message = await this.graphJson<GraphMessage>(
      this.withQuery(`me/messages/${encodeURIComponent(this.requireId(id, "message"))}`, {
        $select: "id,parentFolderId",
      }),
    );
    return this.folderFromProviderId(
      message.parentFolderId,
      await this.ensureFolderIdMap(),
    );
  }

  private concreteFolder(folder: MailFolderId): ConcreteFolderId {
    if (folder === "starred") {
      throw new TypeError("Starred is a virtual Outlook folder");
    }
    return folder;
  }

  private folderFromProviderId(
    providerId: string | null | undefined,
    map?: ReadonlyMap<string, ConcreteFolderId>,
  ): ConcreteFolderId | null {
    return (providerId && map?.get(providerId)) || null;
  }

  private ensureFolderIdMap(): Promise<Map<string, ConcreteFolderId>> {
    this.folderIdMapPromise ??= (async () => {
      const entries = await Promise.all(
        (Object.entries(OUTLOOK_FOLDERS) as Array<
          [ConcreteFolderId, (typeof OUTLOOK_FOLDERS)[ConcreteFolderId]]
        >).map(async ([id, folder]) => {
          try {
            const resource = await this.graphJson<GraphFolder>(
              this.withQuery(`me/mailFolders/${folder.graphId}`, { $select: "id" }),
            );
            return resource.id ? ([resource.id, id] as const) : null;
          } catch (error) {
            if (error instanceof OutlookGraphError && error.status === 404) return null;
            throw error;
          }
        }),
      );
      return new Map(entries.filter((entry): entry is readonly [string, ConcreteFolderId] => Boolean(entry)));
    })();
    return this.folderIdMapPromise;
  }

  private requireId(value: string, kind: string): string {
    const id = value.trim();
    if (!id || id.length > 2048 || /[\r\n\u0000]/u.test(id)) {
      throw new TypeError(`Invalid Outlook ${kind} ID`);
    }
    return id;
  }

  private withQuery(path: string, values: Readonly<Record<string, string>>): string {
    const url = this.resolveGraphUrl(path);
    for (const [name, value] of Object.entries(values)) {
      url.searchParams.set(name, value);
    }
    return url.toString();
  }

  private resolveGraphUrl(target: string): URL {
    const url = /^https?:\/\//iu.test(target)
      ? new URL(target)
      : new URL(target.replace(/^\/+/, ""), this.graphBaseUrl);
    if (
      url.origin !== this.graphBaseUrl.origin ||
      !url.pathname.startsWith(this.graphBaseUrl.pathname)
    ) {
      throw new TypeError("Microsoft Graph continuation URL was rejected");
    }
    return url;
  }

  private async graphJson<T>(
    target: string,
    init: RequestInit = {},
    maximumBytes = MAX_GRAPH_JSON_BYTES,
  ): Promise<T> {
    const response = await this.graphFetch(target, init);
    const text = new TextDecoder().decode(
      await readBytesWithLimit(
        response,
        maximumBytes,
        () => new OutlookGraphError(502, "GraphResponseTooLarge"),
      ),
    );
    if (!text) throw new OutlookGraphError(502, "EmptyGraphResponse");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OutlookGraphError(502, "InvalidGraphResponse");
    }
  }

  private async graphVoid(target: string, init: RequestInit = {}): Promise<void> {
    await this.graphFetch(target, init);
  }

  private async graphFetch(target: string, init: RequestInit = {}): Promise<Response> {
    const url = this.resolveGraphUrl(target);
    const token = (await this.getAccessToken()).trim();
    if (!token || /[\r\n\u0000]/u.test(token)) {
      throw new OutlookGraphError(401, "AccessTokenUnavailable");
    }
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (!headers.has("Prefer")) {
      headers.set(
        "Prefer",
        'IdType="ImmutableId", outlook.body-content-type="text"',
      );
    }

    const response = await this.fetchImpl(url, { ...init, headers });
    if (!response.ok) throw await this.responseError(response);
    return response;
  }

  private async responseError(response: Response): Promise<OutlookGraphError> {
    let graphCode = "GraphRequestFailed";
    try {
      const bytes = await readBytesWithLimit(
        response,
        MAX_GRAPH_ERROR_BYTES,
        () => new OutlookGraphError(response.status, "GraphErrorResponseTooLarge"),
      );
      const body = JSON.parse(new TextDecoder().decode(bytes)) as GraphErrorBody;
      if (body.error?.code && /^[A-Za-z0-9_.-]{1,128}$/u.test(body.error.code)) {
        graphCode = body.error.code;
      }
    } catch {
      // Error bodies are not guaranteed to be JSON.
    }
    return new OutlookGraphError(
      response.status,
      graphCode,
      response.headers.get("request-id") ?? undefined,
      response.headers.get("retry-after") ?? undefined,
    );
  }
}

async function readBytesWithLimit(
  response: Response,
  maximumBytes: number,
  tooLarge: () => Error,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
