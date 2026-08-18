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

const GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me/";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_HEADER_LENGTH = 8_192;
const MAX_ID_LENGTH = 512;
const MAX_SEARCH_LENGTH = 2_048;
const MAX_OUTGOING_ATTACHMENT_BYTES = 25 * 1_024 * 1_024;
const MAX_OUTGOING_TOTAL_BYTES = 30 * 1_024 * 1_024;
const MAX_FORWARD_TOTAL_ATTACHMENT_BYTES = 5 * 1_024 * 1_024;
const MAX_JSON_RESPONSE_BYTES = 4 * 1_024 * 1_024;
const MAX_METADATA_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const MAX_MESSAGE_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const MAX_MESSAGE_BODY_BYTES = 5 * 1_024 * 1_024;
const MAX_INCOMING_ATTACHMENT_BYTES = 10 * 1_024 * 1_024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1_024;
const MAX_BODY_RESPONSE_BYTES =
  Math.ceil(MAX_MESSAGE_BODY_BYTES / 3) * 4 + 64 * 1_024;
const MAX_ATTACHMENT_RESPONSE_BYTES =
  Math.ceil(MAX_INCOMING_ATTACHMENT_BYTES / 3) * 4 + 64 * 1_024;
const LIST_METADATA_HEADERS = ["From", "To", "Cc", "Bcc", "Subject", "Date"];
const REPLY_METADATA_HEADERS = ["Message-ID", "References", "Subject"];
const MESSAGE_PART_METADATA_FIELDS = messagePartFields(8, false);
const MESSAGE_PART_CONTENT_FIELDS = messagePartFields(8, true);

const FOLDER_LABELS: Readonly<Partial<Record<MailFolderId, string>>> = {
  inbox: "INBOX",
  starred: "STARRED",
  sent: "SENT",
  drafts: "DRAFT",
  spam: "SPAM",
  trash: "TRASH",
};

const FOLDER_NAMES: Readonly<Record<MailFolderId, string>> = {
  inbox: "Inbox",
  starred: "Starred",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  spam: "Spam",
  trash: "Trash",
};

const SYSTEM_LABELS = new Set([
  "INBOX",
  "STARRED",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "UNREAD",
  "IMPORTANT",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

type GmailHeader = {
  name?: unknown;
  value?: unknown;
};

type GmailMessagePartBody = {
  attachmentId?: unknown;
  data?: unknown;
  size?: unknown;
};

type GmailMessagePart = {
  body?: GmailMessagePartBody;
  filename?: unknown;
  headers?: GmailHeader[];
  mimeType?: unknown;
  partId?: unknown;
  parts?: GmailMessagePart[];
};

type GmailMessage = {
  id?: unknown;
  internalDate?: unknown;
  labelIds?: unknown;
  payload?: GmailMessagePart;
  raw?: unknown;
  sizeEstimate?: unknown;
  snippet?: unknown;
  threadId?: unknown;
};

type GmailThread = {
  id?: unknown;
  messages?: GmailMessage[];
  snippet?: unknown;
};

type GmailDraft = {
  id?: unknown;
  message?: GmailMessage;
};

type GmailLabel = {
  id?: unknown;
  messagesTotal?: unknown;
  messagesUnread?: unknown;
  name?: unknown;
  threadsTotal?: unknown;
  threadsUnread?: unknown;
  type?: unknown;
};

type GmailProfile = {
  emailAddress?: unknown;
};

type ExtendedMessageQuery = MessageQuery & {
  cursor?: unknown;
  pageSize?: unknown;
};

type ExtendedMailAttachment = MailAttachment & {
  contentBase64?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
};

type ResolvedOutgoingAttachment = {
  data: Uint8Array;
  filename: string;
  mimeType: string;
};

export interface GmailResolvedAttachment {
  data: Uint8Array | ArrayBuffer;
  filename?: string;
  mimeType: string;
}

export type GmailAttachmentResolver = (
  attachment: Readonly<MailAttachment>,
) => Promise<GmailResolvedAttachment | null>;

export type GmailAccessTokenProvider = (options: {
  forceRefresh: boolean;
}) => Promise<string>;

export interface GmailMailProviderOptions {
  accountId: string;
  accessToken: string | GmailAccessTokenProvider;
  accountLabel?: string;
  accountColor?: string;
  attachmentResolver?: GmailAttachmentResolver;
  emailAddress?: string;
  fetchImplementation?: typeof fetch;
  pageSize?: number;
  now?: () => Date;
}

export class GmailApiError extends Error {
  readonly code = "GMAIL_API_ERROR";

  constructor(
    readonly status: number,
    readonly reason: string | null,
    message = `Gmail request failed with status ${status}`,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export class GmailMailProvider implements MailProvider {
  private readonly accountId: string;
  private readonly accountLabel: string;
  private readonly accountColor: string;
  private readonly attachmentResolver?: GmailAttachmentResolver;
  private readonly configuredEmailAddress?: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly pageSize: number;
  private readonly now: () => Date;
  private readonly accessTokenProvider: GmailAccessTokenProvider;
  private readonly canRefreshAccessToken: boolean;
  private profilePromise: Promise<GmailProfile> | null = null;

  constructor(options: GmailMailProviderOptions) {
    this.accountId = requireBoundedString(options.accountId, "accountId", 512);
    this.accountLabel = optionalBoundedString(options.accountLabel, 200) ?? "Gmail";
    this.accountColor = normalizeColor(options.accountColor ?? "#d96555");
    this.attachmentResolver = options.attachmentResolver;
    this.configuredEmailAddress = options.emailAddress
      ? requireEmailAddress(options.emailAddress, "emailAddress")
      : undefined;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.pageSize = normalizePageSize(options.pageSize ?? DEFAULT_PAGE_SIZE);
    this.now = options.now ?? (() => new Date());
    this.canRefreshAccessToken = typeof options.accessToken === "function";
    this.accessTokenProvider =
      typeof options.accessToken === "function"
        ? options.accessToken
        : async () => options.accessToken as string;
  }

  async getAccounts(): Promise<MailAccount[]> {
    const profile = await this.getProfile();
    const address = requireEmailAddress(profile.emailAddress, "profile.emailAddress");

    return [
      {
        id: this.accountId,
        provider: "gmail",
        label: this.accountLabel,
        address,
        color: this.accountColor,
        connected: true,
        capabilities: {
          labels: true,
          reliableDraftUpdates: true,
          externalImages: true,
          permanentDelete: false,
        },
      },
    ];
  }

  async getFolders(scope: "all" | "gmail" | "outlook" | "zoho"): Promise<MailFolder[]> {
    if (scope !== "all" && scope !== "gmail") return [];

    const listed = await this.requestJson<{ labels?: GmailLabel[] }>("labels");
    const labels = Array.isArray(listed.labels) ? listed.labels : [];
    const systemLabels = new Map<string, GmailLabel>();
    for (const label of labels) {
      const id = optionalString(label.id);
      const name = optionalString(label.name);
      if (id && name && SYSTEM_LABELS.has(name)) systemLabels.set(name, label);
    }

    const detailedEntries = await Promise.all(
      Array.from(systemLabels.entries()).map(async ([name, label]) => {
        const id = requireGmailId(label.id, "label.id");
        try {
          const detailed = await this.requestJson<GmailLabel>(
            `labels/${encodeURIComponent(id)}`,
          );
          return [name, detailed] as const;
        } catch (error) {
          if (error instanceof GmailApiError && error.status === 404) {
            return [name, label] as const;
          }
          throw error;
        }
      }),
    );
    const details = new Map(detailedEntries);

    return (Object.keys(FOLDER_NAMES) as MailFolderId[]).map((folder) => {
      const labelName = FOLDER_LABELS[folder];
      const label = labelName ? details.get(labelName) : undefined;
      const count =
        folder === "inbox"
          ? optionalNonNegativeInteger(label?.threadsUnread)
          : optionalNonNegativeInteger(label?.threadsTotal);

      return {
        id: folder,
        label: FOLDER_NAMES[folder],
        ...(count === undefined ? {} : { count }),
      };
    });
  }

  async getMessages(query: MessageQuery): Promise<MailThread[]> {
    return (await this.getMessagesPage(query)).messages;
  }

  async getMessagesPage(query: MessageQuery): Promise<MailMessagePage> {
    if (query.scope !== "all" && query.scope !== "gmail") {
      return { messages: [] };
    }

    const extended = query as ExtendedMessageQuery;
    const pageSize = normalizePageSize(
      typeof extended.pageSize === "number" ? extended.pageSize : this.pageSize,
    );
    const cursor = normalizeCursor(extended.cursor);
    const search = normalizeSearch(query.search);

    if (query.folder === "drafts") {
      return this.getDraftPage({ cursor, pageSize, search });
    }

    const parameters = new URLSearchParams({ maxResults: String(pageSize) });
    if (cursor) parameters.set("pageToken", cursor);
    const label = FOLDER_LABELS[query.folder];
    if (label) parameters.append("labelIds", label);
    if (query.folder === "spam" || query.folder === "trash") {
      parameters.set("includeSpamTrash", "true");
    }

    const archiveQuery =
      query.folder === "archive"
        ? "-in:inbox -in:sent -in:drafts -in:spam -in:trash"
        : "";
    const gmailQuery = [archiveQuery, search].filter(Boolean).join(" ");
    if (gmailQuery) parameters.set("q", gmailQuery);

    const [list, labelNames] = await Promise.all([
      this.requestJson<{
        nextPageToken?: unknown;
        threads?: Array<{ id?: unknown }>;
      }>(`threads?${parameters.toString()}`),
      this.getUserLabelNames(),
    ]);
    const summaries = Array.isArray(list.threads) ? list.threads : [];
    const messages = await mapWithConcurrency(summaries, 6, async (summary) => {
      const id = requireGmailId(summary.id, "thread.id");
      const thread = await this.requestJson<GmailThread>(
        metadataResource(`threads/${encodeURIComponent(id)}`, LIST_METADATA_HEADERS),
        { maxResponseBytes: MAX_METADATA_RESPONSE_BYTES },
      );
      return this.toMailThread(thread, labelNames, query.folder);
    });

    return {
      messages,
      ...nextCursorResult(list.nextPageToken),
    };
  }

  async getMessage(id: string): Promise<MailThread | null> {
    const resourceId = requireGmailId(id, "message id");
    const labelNamesPromise = this.getUserLabelNames();

    try {
      const thread = await this.requestJson<GmailThread>(
        fullResource(
          `threads/${encodeURIComponent(resourceId)}`,
          `id,snippet,messages(id,threadId,labelIds,internalDate,snippet,payload(${MESSAGE_PART_METADATA_FIELDS}))`,
        ),
      );
      return this.toMailThread(thread, await labelNamesPromise);
    } catch (error) {
      if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
    }

    try {
      const draft = await this.requestJson<GmailDraft>(
        fullResource(
          `drafts/${encodeURIComponent(resourceId)}`,
          `id,message(id,threadId,labelIds,internalDate,snippet,payload(${MESSAGE_PART_METADATA_FIELDS}))`,
        ),
      );
      return this.toDraftThread(draft, await labelNamesPromise);
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return null;
      throw error;
    }
  }

  async sendMessage(draft: MailDraft): Promise<{ id: string }> {
    this.assertDraftAccount(draft);
    const raw = await this.createRawMessage(draft);
    const message = await this.sendRawMessage(raw, draft.id);
    return { id: requireGmailId(message.id, "message.id") };
  }

  async saveDraft(draft: MailDraft): Promise<{ id: string; savedAt: string }> {
    this.assertDraftAccount(draft);
    const raw = await this.createRawMessage(draft, { allowNoRecipients: true });
    const requestBody = { message: { raw } };
    const saved = draft.id
      ? await this.requestJson<GmailDraft>(
          `drafts/${encodeURIComponent(requireGmailId(draft.id, "draft.id"))}`,
          { method: "PUT", json: requestBody },
        )
      : await this.requestJson<GmailDraft>("drafts", {
          method: "POST",
          json: requestBody,
        });

    return {
      id: requireGmailId(saved.id, "draft.id"),
      savedAt: formatShortDate(this.now()),
    };
  }

  async getDraft(id: string): Promise<MailDraft | null> {
    const requestedDraftId = requireGmailId(id, "draft.id");
    let draft: GmailDraft;
    try {
      draft = await this.requestJson<GmailDraft>(
        fullResource(
          `drafts/${encodeURIComponent(requestedDraftId)}`,
          `id,message(id,payload(${MESSAGE_PART_CONTENT_FIELDS}))`,
        ),
        { maxResponseBytes: MAX_MESSAGE_RESPONSE_BYTES },
      );
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return null;
      throw error;
    }

    const draftId = requireGmailId(draft.id, "draft.id");
    if (draftId !== requestedDraftId) {
      throw new TypeError("Gmail returned an unexpected draft ID");
    }
    const message = requireObject(draft.message, "draft.message") as GmailMessage;
    const messageId = requireGmailId(message.id, "draft.message.id");
    const payload = requirePayload(message);
    const attachments = collectAttachmentParts(payload).map((part) => {
      const attachment = toMailAttachment(part);
      assertSafeIncomingAttachmentSize(attachment.sizeBytes ?? 0);
      return {
        ...attachment,
        sourceMessageId: messageId,
      };
    });
    const contents = await this.getBodyContents(message);

    return {
      id: draftId,
      accountId: this.accountId,
      to: draftRecipientEmails(payload, "To"),
      cc: draftRecipientEmails(payload, "Cc"),
      bcc: draftRecipientEmails(payload, "Bcc"),
      subject: decodeMimeHeader(getHeader(payload, "Subject") ?? ""),
      body: plainTextBody(contents),
      attachments,
    };
  }

  async replyMessage(id: string, draft: MailDraft): Promise<{ id: string }> {
    this.assertDraftAccount(draft);
    const threadId = requireGmailId(id, "thread.id");
    const thread = await this.requestJson<GmailThread>(
      metadataResource(
        `threads/${encodeURIComponent(threadId)}`,
        REPLY_METADATA_HEADERS,
      ),
      { maxResponseBytes: MAX_METADATA_RESPONSE_BYTES },
    );
    const messages = requireMessages(thread);
    const latest = messages.at(-1)!;
    const latestPayload = requirePayload(latest);
    const messageId = requireMessageIdHeader(latestPayload);
    const previousReferences = getHeader(latestPayload, "References");
    const originalSubject = decodeMimeHeader(getHeader(latestPayload, "Subject") ?? "");
    const subject = normalizeReplySubject(draft.subject, originalSubject);
    const references = appendReference(previousReferences, messageId);
    const raw = await this.createRawMessage(
      { ...draft, subject },
      {
        inReplyTo: messageId,
        references,
      },
    );
    const sent = await this.sendRawMessage(raw, draft.id, threadId);
    return { id: requireGmailId(sent.id, "message.id") };
  }

  async forwardMessage(id: string, draft: MailDraft): Promise<{ id: string }> {
    this.assertDraftAccount(draft);
    const threadId = requireGmailId(id, "thread.id");
    const thread = await this.requestJson<GmailThread>(
      fullResource(
        `threads/${encodeURIComponent(threadId)}`,
        `id,messages(id,threadId,labelIds,internalDate,snippet,payload(${MESSAGE_PART_METADATA_FIELDS}))`,
      ),
    );
    const source = requireMessages(thread).at(-1)!;
    const sourcePayload = requirePayload(source);
    const sourceContent = await this.getRawMessageContent(
      requireGmailId(source.id, "message.id"),
    );
    const sourceText =
      sourceContent?.contentType === "text/html"
        ? htmlToPlainText(sourceContent.content)
        : sourceContent?.content ?? "";
    const sender = getHeader(sourcePayload, "From") ?? "";
    const recipients = getHeader(sourcePayload, "To") ?? "";
    const sentAt = getHeader(sourcePayload, "Date") ?? "";
    const sourceSubject = decodeMimeHeader(getHeader(sourcePayload, "Subject") ?? "");
    const forwardedBlock = [
      "---------- Forwarded message ----------",
      sender ? `From: ${sender}` : "",
      sentAt ? `Date: ${sentAt}` : "",
      sourceSubject ? `Subject: ${sourceSubject}` : "",
      recipients ? `To: ${recipients}` : "",
      "",
      sourceText,
    ]
      .filter((line, index, lines) => line || index === lines.length - 2)
      .join("\n");
    const body = draft.body.trim()
      ? `${draft.body.trimEnd()}\n\n${forwardedBlock}`
      : forwardedBlock;
    const resolvedDraftAttachments = await this.resolveOutgoingAttachments(
      draft.attachments,
      MAX_FORWARD_TOTAL_ATTACHMENT_BYTES,
    );
    const attachments = [...resolvedDraftAttachments.attachments];
    let totalAttachmentBytes = resolvedDraftAttachments.totalBytes;
    const sourceMessageId = requireGmailId(source.id, "message.id");
    for (const part of collectAttachmentParts(sourcePayload)) {
      const remainingBytes =
        MAX_FORWARD_TOTAL_ATTACHMENT_BYTES - totalAttachmentBytes;
      const metadata = attachmentMetadata(part);
      assertAttachmentFitsBudget(metadata.sizeBytes, remainingBytes);
      const attachment = await this.downloadAttachmentPart(
        sourceMessageId,
        part,
        remainingBytes,
      );
      if (!attachment) continue;
      totalAttachmentBytes += attachment.data.byteLength;
      assertAttachmentFitsBudget(
        totalAttachmentBytes,
        MAX_FORWARD_TOTAL_ATTACHMENT_BYTES,
      );
      attachments.push({
        data: attachment.data,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
      });
    }
    const raw = await this.createRawMessage(
      { ...draft, body },
      {
        maximumTotalAttachmentBytes: MAX_FORWARD_TOTAL_ATTACHMENT_BYTES,
        resolvedAttachments: attachments,
      },
    );
    const sent = await this.sendRawMessage(raw, draft.id);
    return { id: requireGmailId(sent.id, "message.id") };
  }

  async archiveMessages(ids: string[]): Promise<OperationResult> {
    return this.moveThreads(ids, "archive", async (id) => {
      await this.modifyThread(id, [], ["INBOX"]);
    });
  }

  async moveToTrash(ids: string[]): Promise<OperationResult> {
    return this.moveThreads(ids, "trash", async (id) => {
      await this.requestJson<GmailThread>(
        `threads/${encodeURIComponent(id)}/trash`,
        { method: "POST" },
      );
    });
  }

  async restoreFromTrash(ids: string[]): Promise<OperationResult> {
    return this.runThreadOperations(ids, async (id) => {
      await this.requestJson<GmailThread>(
        `threads/${encodeURIComponent(id)}/untrash`,
        { method: "POST" },
      );
    });
  }

  async restoreMessages(locations: MessageLocation[]): Promise<OperationResult> {
    const unique = new Map<string, MessageLocation>();
    for (const location of locations) {
      unique.set(requireGmailId(location.id, "location.id"), location);
    }

    const succeeded: string[] = [];
    const failed: OperationResult["failed"] = [];
    for (const [id, location] of unique) {
      try {
        await this.restoreThreadTo(id, location.folder);
        succeeded.push(id);
      } catch (error) {
        failed.push({ id, reason: operationFailureReason(error) });
      }
    }
    return { succeeded, failed };
  }

  async markRead(ids: string[], read: boolean): Promise<OperationResult> {
    return this.runThreadOperations(ids, async (id) => {
      await this.modifyThread(id, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []);
    });
  }

  async setStarred(id: string, starred: boolean): Promise<OperationResult> {
    return this.runThreadOperations([id], async (threadId) => {
      await this.modifyThread(
        threadId,
        starred ? ["STARRED"] : [],
        starred ? [] : ["STARRED"],
      );
    });
  }

  async searchMessages(query: MessageQuery): Promise<MailThread[]> {
    return this.getMessages(query);
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<MailAttachmentContent | null> {
    const nativeMessageId = requireGmailId(messageId, "messageId");
    const nativeAttachmentId = requireGmailId(attachmentId, "attachmentId");
    let message: GmailMessage;
    try {
      message = await this.requestJson<GmailMessage>(
        fullResource(
          `messages/${encodeURIComponent(nativeMessageId)}`,
          `id,payload(${MESSAGE_PART_METADATA_FIELDS})`,
        ),
      );
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return null;
      throw error;
    }

    const part = findAttachmentPart(requirePayload(message), nativeAttachmentId);
    if (!part) return null;
    if (optionalString(part.body?.data) || optionalString(part.body?.attachmentId)) {
      return this.downloadAttachmentPart(nativeMessageId, part);
    }

    assertSafeIncomingAttachmentSize(attachmentMetadata(part).sizeBytes);
    const messageWithInlineData = await this.requestJson<GmailMessage>(
      fullResource(
        `messages/${encodeURIComponent(nativeMessageId)}`,
        `id,payload(${MESSAGE_PART_CONTENT_FIELDS})`,
      ),
      { maxResponseBytes: MAX_ATTACHMENT_RESPONSE_BYTES },
    );
    const inlinePart = findAttachmentPart(
      requirePayload(messageWithInlineData),
      nativeAttachmentId,
    );
    return inlinePart
      ? this.downloadAttachmentPart(nativeMessageId, inlinePart)
      : null;
  }

  async getRawMessageContent(
    messageId: string,
  ): Promise<MailMessageContent | null> {
    const nativeMessageId = requireGmailId(messageId, "messageId");
    let message: GmailMessage;
    try {
      message = await this.requestJson<GmailMessage>(
        fullResource(
          `messages/${encodeURIComponent(nativeMessageId)}`,
          `id,payload(${MESSAGE_PART_CONTENT_FIELDS})`,
        ),
        { maxResponseBytes: MAX_MESSAGE_RESPONSE_BYTES },
      );
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return null;
      throw error;
    }
    const contents = await this.getBodyContents(message);
    const html = contents.find((item) => item.contentType === "text/html");
    if (html) return html;
    return contents.find((item) => item.contentType === "text/plain") ?? null;
  }

  private async getDraftPage({
    cursor,
    pageSize,
    search,
  }: {
    cursor?: string;
    pageSize: number;
    search?: string;
  }): Promise<MailMessagePage> {
    const parameters = new URLSearchParams({ maxResults: String(pageSize) });
    if (cursor) parameters.set("pageToken", cursor);
    if (search) parameters.set("q", search);

    const [list, labelNames] = await Promise.all([
      this.requestJson<{
        drafts?: GmailDraft[];
        nextPageToken?: unknown;
      }>(`drafts?${parameters.toString()}`),
      this.getUserLabelNames(),
    ]);
    const messages = await mapWithConcurrency(
      Array.isArray(list.drafts) ? list.drafts : [],
      6,
      async (summary) => {
        const id = requireGmailId(summary.id, "draft.id");
        const message = requireObject(summary.message, "draft.message") as GmailMessage;
        const messageId = requireGmailId(message.id, "draft.message.id");
        const metadata = await this.requestJson<GmailMessage>(
          metadataResource(
            `messages/${encodeURIComponent(messageId)}`,
            LIST_METADATA_HEADERS,
          ),
          { maxResponseBytes: MAX_METADATA_RESPONSE_BYTES },
        );
        return this.toDraftThread({ id, message: metadata }, labelNames);
      },
    );

    return {
      messages,
      ...nextCursorResult(list.nextPageToken),
    };
  }

  private toDraftThread(
    draft: GmailDraft,
    labelNames: ReadonlyMap<string, string>,
  ): MailThread {
    const draftId = requireGmailId(draft.id, "draft.id");
    const message = requireObject(draft.message, "draft.message") as GmailMessage;
    const parsed = this.toMailThread(
      {
        id: message.threadId,
        messages: [message],
        snippet: message.snippet,
      },
      labelNames,
      "drafts",
    );
    return { ...parsed, id: draftId, folder: "drafts" };
  }

  private toMailThread(
    thread: GmailThread,
    labelNames: ReadonlyMap<string, string>,
    folderHint?: MailFolderId,
  ): MailThread {
    const id = requireGmailId(thread.id, "thread.id");
    const messages = requireMessages(thread);
    const parsedMessages = messages.map((message) => this.toThreadMessage(message));
    const labels = new Set(messages.flatMap(messageLabelIds));
    const firstPayload = requirePayload(messages[0]);
    const latest = messages.at(-1)!;
    const latestPayload = requirePayload(latest);
    const latestDate = messageDate(latest);
    const subject =
      decodeMimeHeader(getHeader(latestPayload, "Subject") ?? "") || "(no subject)";
    const preview =
      decodeHtmlEntities(optionalString(latest.snippet) ?? optionalString(thread.snippet) ?? "") ||
      parsedMessages.at(-1)?.body.join(" ").slice(0, 160) ||
      "";
    const userLabels = Array.from(labels)
      .map((labelId) => labelNames.get(labelId))
      .filter((label): label is string => Boolean(label));
    return {
      id,
      provider: "gmail",
      accountId: this.accountId,
      folder: folderHint ?? folderFromLabels(labels),
      sender: parseAddressList(getHeader(firstPayload, "From") ?? "")[0] ?? {
        name: "Unknown sender",
        email: "unknown@invalid.local",
      },
      subject,
      preview,
      receivedAt: folderHint === "drafts" ? "Draft" : formatShortDate(latestDate),
      receivedAtFull:
        folderHint === "drafts"
          ? `Draft saved ${formatFullDate(latestDate)}`
          : formatFullDate(latestDate),
      receivedAtMs: latestDate.getTime(),
      unread: labels.has("UNREAD"),
      starred: labels.has("STARRED"),
      labels: Array.from(new Set(userLabels)),
      hasExternalImages: false,
      messages: parsedMessages,
    };
  }

  private toThreadMessage(message: GmailMessage): ThreadMessage {
    const id = requireGmailId(message.id, "message.id");
    const payload = requirePayload(message);
    const sender = parseAddressList(getHeader(payload, "From") ?? "")[0] ?? {
      name: "Unknown sender",
      email: "unknown@invalid.local",
    };
    const recipients = ["To", "Cc", "Bcc"].flatMap((header) =>
      parseAddressList(getHeader(payload, header) ?? ""),
    );
    const sentAt = messageDate(message);

    return {
      id,
      sender,
      recipients,
      sentAt: formatShortDate(sentAt),
      sentAtFull: formatFullDate(sentAt),
      body: [],
      attachments: collectAttachmentParts(payload).map(toMailAttachment),
    };
  }

  private async getBodyContents(
    message: GmailMessage,
  ): Promise<MailMessageContent[]> {
    const messageId = requireGmailId(message.id, "message.id");
    const parts = collectBodyParts(requirePayload(message));
    const contents: MailMessageContent[] = [];
    let totalBytes = 0;
    for (const { contentType, part } of parts) {
      const body = part.body ?? {};
      const declaredSize = optionalNonNegativeInteger(body.size);
      if (
        declaredSize !== undefined &&
        declaredSize > MAX_MESSAGE_BODY_BYTES - totalBytes
      ) {
        throw new TypeError("Gmail message body exceeds the safety limit");
      }
      let data = optionalString(body.data);
      const attachmentId = optionalString(body.attachmentId);
      if (data) {
        data = requireBoundedString(
          data,
          "message body data",
          maximumBase64Length(MAX_MESSAGE_BODY_BYTES - totalBytes),
        );
      }
      if (!data && attachmentId) {
        const response = await this.requestJson<GmailMessagePartBody>(
          `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(
            attachmentId,
          )}`,
          { maxResponseBytes: MAX_BODY_RESPONSE_BYTES },
        );
        data = requireBoundedString(
          response.data,
          "message body data",
          maximumBase64Length(MAX_MESSAGE_BODY_BYTES - totalBytes),
        );
      }
      const decoded = data ? decodeBase64Url(data) : new Uint8Array();
      totalBytes += decoded.byteLength;
      if (totalBytes > MAX_MESSAGE_BODY_BYTES) {
        throw new TypeError("Gmail message body exceeds the safety limit");
      }
      contents.push({
        content: decodePartText(part, decoded),
        contentType,
      });
    }
    return contents;
  }

  private async createRawMessage(
    draft: MailDraft,
    options: {
      allowNoRecipients?: boolean;
      inReplyTo?: string;
      maximumTotalAttachmentBytes?: number;
      references?: string;
      resolvedAttachments?: ReadonlyArray<ResolvedOutgoingAttachment>;
    } = {},
  ): Promise<string> {
    const from = this.configuredEmailAddress ?? requireEmailAddress(
      (await this.getProfile()).emailAddress,
      "profile.emailAddress",
    );
    const to = normalizeRecipientList(draft.to, "to");
    const cc = normalizeRecipientList(draft.cc, "cc");
    const bcc = normalizeRecipientList(draft.bcc, "bcc");
    if (!options.allowNoRecipients && to.length + cc.length + bcc.length === 0) {
      throw new TypeError("At least one recipient is required");
    }
    const subject = requireSafeHeaderValue(draft.subject, "subject", 998);
    const maximumTotalAttachmentBytes =
      options.maximumTotalAttachmentBytes ?? MAX_OUTGOING_TOTAL_BYTES;
    const attachments = options.resolvedAttachments
      ? options.resolvedAttachments.map((attachment) => ({
          data: attachment.data,
          filename: requireSafeHeaderValue(
            attachment.filename,
            "attachment filename",
            255,
          ),
          mimeType: normalizeMimeType(attachment.mimeType),
        }))
      : (
          await this.resolveOutgoingAttachments(
            draft.attachments,
            maximumTotalAttachmentBytes,
          )
        ).attachments;
    const totalAttachmentBytes = attachments.reduce(
      (total, attachment) => total + attachment.data.byteLength,
      0,
    );
    assertAttachmentFitsBudget(
      totalAttachmentBytes,
      maximumTotalAttachmentBytes,
    );
    const boundary = `imail_${crypto.randomUUID().replaceAll("-", "")}`;
    const headers = [
      `From: ${from}`,
      ...(to.length ? [`To: ${to.join(", ")}`] : []),
      ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
      ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
      `Subject: ${encodeMimeHeader(subject)}`,
      `Date: ${this.now().toUTCString()}`,
      "MIME-Version: 1.0",
      ...(options.inReplyTo
        ? [`In-Reply-To: ${requireMessageId(options.inReplyTo, "In-Reply-To")}`]
        : []),
      ...(options.references
        ? [`References: ${requireSafeHeaderValue(options.references, "References")}`]
        : []),
    ];
    const body = normalizeBody(draft.body);

    if (attachments.length === 0) {
      headers.push("Content-Type: text/plain; charset=UTF-8");
      headers.push("Content-Transfer-Encoding: base64");
      return encodeBase64UrlUtf8(
        [...headers, "", wrapBase64(encodeBase64(utf8(body)))].join("\r\n"),
      );
    }

    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const sections = [
      ...headers,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(encodeBase64(utf8(body))),
    ];
    for (const attachment of attachments) {
      const filename = requireSafeHeaderValue(attachment.filename, "attachment filename", 255);
      const encodedFilename = encodeMimeHeader(filename);
      sections.push(
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; name="${escapeQuotedHeader(encodedFilename)}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${escapeQuotedHeader(encodedFilename)}"`,
        "",
        wrapBase64(encodeBase64(attachment.data)),
      );
    }
    sections.push(`--${boundary}--`, "");
    return encodeBase64UrlUtf8(sections.join("\r\n"));
  }

  private async resolveOutgoingAttachments(
    attachments: readonly MailAttachment[],
    maximumTotalBytes: number,
  ): Promise<{
    attachments: ResolvedOutgoingAttachment[];
    totalBytes: number;
  }> {
    const resolved: ResolvedOutgoingAttachment[] = [];
    let totalBytes = 0;
    for (const attachment of attachments) {
      const declaredSize = optionalNonNegativeInteger(
        (attachment as ExtendedMailAttachment).sizeBytes,
      );
      if (declaredSize !== undefined) {
        assertAttachmentFitsBudget(
          declaredSize,
          maximumTotalBytes - totalBytes,
        );
      }
      const next = await this.resolveOutgoingAttachment(attachment);
      totalBytes += next.data.byteLength;
      assertAttachmentFitsBudget(totalBytes, maximumTotalBytes);
      resolved.push(next);
    }
    return { attachments: resolved, totalBytes };
  }

  private async resolveOutgoingAttachment(
    attachment: MailAttachment,
  ): Promise<ResolvedOutgoingAttachment> {
    const extended = attachment as ExtendedMailAttachment;
    const filename = requireSafeHeaderValue(attachment.name, "attachment.name", 255);
    if (typeof extended.contentBase64 === "string") {
      if (extended.contentBase64.length > Math.ceil(MAX_OUTGOING_ATTACHMENT_BYTES / 3) * 4 + 4) {
        throw new TypeError(`Attachment ${filename} is too large`);
      }
      const data = decodeFlexibleBase64(extended.contentBase64);
      if (data.byteLength > MAX_OUTGOING_ATTACHMENT_BYTES) {
        throw new TypeError(`Attachment ${filename} is too large`);
      }
      return {
        data,
        filename,
        mimeType: normalizeMimeType(extended.mimeType),
      };
    }
    if (!this.attachmentResolver) {
      throw new TypeError(
        `Attachment ${filename} has no contentBase64 value and no resolver is configured`,
      );
    }
    const resolved = await this.attachmentResolver(attachment);
    if (!resolved) throw new TypeError(`Attachment ${filename} could not be resolved`);
    const data =
      resolved.data instanceof Uint8Array
        ? Uint8Array.from(resolved.data)
        : new Uint8Array(resolved.data);
    if (data.byteLength > MAX_OUTGOING_ATTACHMENT_BYTES) {
      throw new TypeError(`Attachment ${filename} is too large`);
    }
    return {
      data,
      filename: resolved.filename
        ? requireSafeHeaderValue(resolved.filename, "attachment filename", 255)
        : filename,
      mimeType: normalizeMimeType(resolved.mimeType),
    };
  }

  private async downloadAttachmentPart(
    messageId: string,
    part: GmailMessagePart,
    maximumBytes = MAX_INCOMING_ATTACHMENT_BYTES,
  ): Promise<MailAttachmentContent | null> {
    const metadata = attachmentMetadata(part);
    assertSafeIncomingAttachmentSize(metadata.sizeBytes);
    assertAttachmentFitsBudget(metadata.sizeBytes, maximumBytes);
    const inlineData = optionalString(part.body?.data);
    if (inlineData) {
      const data = decodeBase64Url(
        requireBoundedString(
          inlineData,
          "attachment.data",
          maximumBase64Length(maximumBytes),
        ),
      );
      assertSafeIncomingAttachmentSize(data.byteLength);
      assertAttachmentFitsBudget(data.byteLength, maximumBytes);
      return { ...metadata, data, sizeBytes: data.byteLength };
    }

    const remoteAttachmentId = optionalString(part.body?.attachmentId);
    if (!remoteAttachmentId) return null;
    try {
      const body = await this.requestJson<GmailMessagePartBody>(
        `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(
          remoteAttachmentId,
        )}`,
        {
          maxResponseBytes:
            maximumBase64Length(maximumBytes) + 64 * 1_024,
        },
      );
      const responseSize = optionalNonNegativeInteger(body.size);
      if (responseSize !== undefined) {
        assertSafeIncomingAttachmentSize(responseSize);
        assertAttachmentFitsBudget(responseSize, maximumBytes);
      }
      const data = decodeBase64Url(
        requireBoundedString(
          body.data,
          "attachment.data",
          maximumBase64Length(maximumBytes),
        ),
      );
      assertSafeIncomingAttachmentSize(data.byteLength);
      assertAttachmentFitsBudget(data.byteLength, maximumBytes);
      return { ...metadata, data, sizeBytes: data.byteLength };
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async sendRawMessage(
    raw: string,
    draftId?: string,
    threadId?: string,
  ): Promise<GmailMessage> {
    const message = { raw, ...(threadId ? { threadId } : {}) };
    if (!draftId) {
      return this.requestJson<GmailMessage>("messages/send", {
        method: "POST",
        json: message,
      });
    }

    const nativeDraftId = requireGmailId(draftId, "draft.id");
    await this.requestJson<GmailDraft>(
      `drafts/${encodeURIComponent(nativeDraftId)}`,
      { method: "PUT", json: { id: nativeDraftId, message } },
    );
    return this.requestJson<GmailMessage>("drafts/send", {
      method: "POST",
      json: { id: nativeDraftId },
    });
  }

  private async moveThreads(
    ids: string[],
    destination: "archive" | "trash",
    operation: (id: string) => Promise<void>,
  ): Promise<OperationResult> {
    const uniqueIds = uniqueGmailIds(ids);
    const previousLocations: MessageLocation[] = [];
    const succeeded: string[] = [];
    const failed: OperationResult["failed"] = [];

    for (const id of uniqueIds) {
      try {
        const thread = await this.requestJson<GmailThread>(
          `threads/${encodeURIComponent(id)}?format=minimal`,
        );
        const labels = new Set(requireMessages(thread).flatMap(messageLabelIds));
        previousLocations.push({ id, folder: folderFromLabels(labels) });
        await operation(id);
        succeeded.push(id);
      } catch (error) {
        failed.push({ id, reason: operationFailureReason(error) });
      }
    }

    return {
      succeeded,
      failed,
      previousLocations: previousLocations.filter(({ id }) => succeeded.includes(id)),
    };
  }

  private async runThreadOperations(
    ids: string[],
    operation: (id: string) => Promise<void>,
  ): Promise<OperationResult> {
    const succeeded: string[] = [];
    const failed: OperationResult["failed"] = [];
    for (const id of uniqueGmailIds(ids)) {
      try {
        await operation(id);
        succeeded.push(id);
      } catch (error) {
        failed.push({ id, reason: operationFailureReason(error) });
      }
    }
    return { succeeded, failed };
  }

  private async restoreThreadTo(id: string, folder: MailFolderId): Promise<void> {
    if (folder === "trash") {
      await this.requestJson<GmailThread>(
        `threads/${encodeURIComponent(id)}/trash`,
        { method: "POST" },
      );
      return;
    }

    await this.requestJson<GmailThread>(
      `threads/${encodeURIComponent(id)}/untrash`,
      { method: "POST" },
    );
    if (folder === "inbox") {
      await this.modifyThread(id, ["INBOX"], ["SPAM"]);
    } else if (folder === "archive") {
      await this.modifyThread(id, [], ["INBOX", "SPAM"]);
    } else if (folder === "spam") {
      await this.modifyThread(id, ["SPAM"], ["INBOX"]);
    } else if (folder === "starred") {
      await this.modifyThread(id, ["STARRED"], []);
    }
  }

  private async modifyThread(
    id: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<void> {
    await this.requestJson<GmailThread>(
      `threads/${encodeURIComponent(requireGmailId(id, "thread.id"))}/modify`,
      { method: "POST", json: { addLabelIds, removeLabelIds } },
    );
  }

  private async getUserLabelNames(): Promise<ReadonlyMap<string, string>> {
    const response = await this.requestJson<{ labels?: GmailLabel[] }>("labels");
    const result = new Map<string, string>();
    for (const label of Array.isArray(response.labels) ? response.labels : []) {
      const id = optionalString(label.id);
      const name = optionalString(label.name);
      if (id && name && label.type === "user") result.set(id, name);
    }
    return result;
  }

  private getProfile(): Promise<GmailProfile> {
    if (this.configuredEmailAddress) {
      return Promise.resolve({ emailAddress: this.configuredEmailAddress });
    }
    this.profilePromise ??= this.requestJson<GmailProfile>("profile").catch((error) => {
      this.profilePromise = null;
      throw error;
    });
    return this.profilePromise;
  }

  private assertDraftAccount(draft: MailDraft): void {
    if (draft.accountId !== this.accountId) {
      throw new TypeError(`Mail account ${draft.accountId} is not handled by this provider`);
    }
  }

  private async requestJson<Result>(
    resource: string,
    options: {
      json?: unknown;
      maxResponseBytes?: number;
      method?: "GET" | "POST" | "PUT" | "DELETE";
    } = {},
  ): Promise<Result> {
    const url = gmailApiUrl(resource);
    const method = options.method ?? "GET";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = validateAccessToken(
        await this.accessTokenProvider({ forceRefresh: attempt > 0 }),
      );
      const response = await this.fetchImplementation(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(options.json === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
        cache: "no-store",
        redirect: "error",
      });
      if (response.status === 401 && attempt === 0 && this.canRefreshAccessToken) {
        try {
          await response.body?.cancel();
        } catch {
          // The retry does not depend on draining an untrusted error body.
        }
        continue;
      }
      if (!response.ok) throw await gmailApiError(response);
      if (response.status === 204) return undefined as Result;

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        await cancelResponseBody(response);
        throw new GmailApiError(response.status, "invalidResponse");
      }
      return readJsonResponse<Result>(
        response,
        options.maxResponseBytes ?? MAX_JSON_RESPONSE_BYTES,
      );
    }
    throw new GmailApiError(401, "authError");
  }
}

async function gmailApiError(response: Response): Promise<GmailApiError> {
  let reason: string | null = null;
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
      const payload = await readJsonResponse<{
        error?: { errors?: Array<{ reason?: unknown }>; status?: unknown };
      }>(response, MAX_ERROR_RESPONSE_BYTES);
      const candidate = payload.error?.errors?.[0]?.reason ?? payload.error?.status;
      if (typeof candidate === "string" && candidate.length <= 100) reason = candidate;
    } else {
      await cancelResponseBody(response);
    }
  } catch {
    // An invalid error body must not hide the HTTP status or leak raw response text.
  }
  return new GmailApiError(response.status, reason);
}

async function readJsonResponse<Result>(
  response: Response,
  maximumBytes: number,
): Promise<Result> {
  const text = await readResponseText(response, maximumBytes);
  try {
    return JSON.parse(text) as Result;
  } catch {
    throw new GmailApiError(response.status, "invalidJson");
  }
}

async function readResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      await cancelResponseBody(response);
      throw new GmailApiError(response.status, "invalidResponse");
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) {
      await cancelResponseBody(response);
      throw new GmailApiError(response.status, "invalidResponse");
    }
    if (declaredBytes > maximumBytes) {
      await cancelResponseBody(response);
      throw new GmailApiError(response.status, "responseTooLarge");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is the error reported to the caller.
        }
        throw new GmailApiError(response.status, "responseTooLarge");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Rejection remains based on the response validation error.
  }
}

function metadataResource(resource: string, headers: readonly string[]): string {
  const parameters = new URLSearchParams({ format: "metadata" });
  for (const header of headers) parameters.append("metadataHeaders", header);
  return `${resource}?${parameters.toString()}`;
}

function fullResource(resource: string, fields: string): string {
  const parameters = new URLSearchParams({ format: "full", fields });
  return `${resource}?${parameters.toString()}`;
}

function messagePartFields(depth: number, includeData: boolean): string {
  const bodyFields = includeData ? "attachmentId,size,data" : "attachmentId,size";
  const fields = [
    "partId",
    "mimeType",
    "filename",
    "headers",
    `body(${bodyFields})`,
  ];
  if (depth > 0) fields.push(`parts(${messagePartFields(depth - 1, includeData)})`);
  return fields.join(",");
}

function maximumBase64Length(maximumDecodedBytes: number): number {
  return Math.ceil(Math.max(0, maximumDecodedBytes) / 3) * 4;
}

function assertSafeIncomingAttachmentSize(sizeBytes: number): void {
  if (sizeBytes > MAX_INCOMING_ATTACHMENT_BYTES) {
    throw new TypeError("Gmail attachment exceeds the 10 MiB safety limit");
  }
}

function assertAttachmentFitsBudget(sizeBytes: number, maximumBytes: number): void {
  if (sizeBytes > maximumBytes) {
    throw new TypeError("Total attachment content is too large");
  }
}

function gmailApiUrl(resource: string): URL {
  if (!resource || resource.startsWith("/") || resource.includes("\\")) {
    throw new TypeError("Invalid Gmail API resource path");
  }
  const url = new URL(resource, GMAIL_API_ROOT);
  if (url.origin !== "https://gmail.googleapis.com") {
    throw new TypeError("Invalid Gmail API origin");
  }
  return url;
}

function validateAccessToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 10 ||
    value.length > 4_096 ||
    /[\s\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Gmail access token is invalid");
  }
  return value;
}

function normalizeColor(value: string): string {
  if (!/^#[0-9a-f]{6}$/iu.test(value)) throw new TypeError("Invalid account color");
  return value.toLowerCase();
}

function normalizePageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("pageSize must be a positive integer");
  }
  return Math.min(value, MAX_PAGE_SIZE);
}

function normalizeCursor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireBoundedString(value, "cursor", 2_048);
}

function normalizeSearch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_SEARCH_LENGTH || /[\u0000\r\n]/u.test(normalized)) {
    throw new TypeError("Gmail search query is invalid");
  }
  return normalized;
}

function requireGmailId(value: unknown, field: string): string {
  const result = requireBoundedString(value, field, MAX_ID_LENGTH);
  if (/[\u0000-\u001f\u007f]/u.test(result)) throw new TypeError(`${field} is invalid`);
  return result;
}

function uniqueGmailIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => requireGmailId(id, "thread.id"))));
}

function requireBoundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function optionalBoundedString(value: unknown, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, "value", maximum);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireEmailAddress(value: unknown, field: string): string {
  const address = requireSafeHeaderValue(
    requireBoundedString(value, field, 320),
    field,
    320,
  ).trim();
  if (!/^[^\s<>@,;:]+@[^\s<>@,;:]+\.[^\s<>@,;:]+$/u.test(address)) {
    throw new TypeError(`${field} must be an email address`);
  }
  return address;
}

function requireSafeHeaderValue(
  value: unknown,
  field: string,
  maximum = MAX_HEADER_LENGTH,
): string {
  const result = typeof value === "string" ? value : "";
  if (result.length > maximum || /[\r\n\u0000]/u.test(result)) {
    throw new TypeError(`${field} contains invalid header characters`);
  }
  return result;
}

function normalizeRecipientList(values: string[], field: string): string[] {
  if (!Array.isArray(values) || values.length > 200) {
    throw new TypeError(`${field} contains too many recipients`);
  }
  return values.map((value, index) => {
    const normalized = requireSafeHeaderValue(value, `${field}[${index}]`, 998).trim();
    const entries = splitAddressHeader(normalized);
    if (
      !normalized ||
      entries.length === 0 ||
      parseAddressList(normalized).length !== entries.length
    ) {
      throw new TypeError(`${field}[${index}] is not a valid email address`);
    }
    return normalized;
  });
}

function normalizeBody(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("body must be a string");
  if (value.length > 20_000_000) throw new TypeError("body is too large");
  return value.replace(/\r?\n/gu, "\r\n");
}

function normalizeMimeType(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(value)) {
    return "application/octet-stream";
  }
  return value.toLowerCase();
}

function requireMessages(thread: GmailThread): GmailMessage[] {
  if (!Array.isArray(thread.messages) || thread.messages.length === 0) {
    throw new TypeError("Gmail thread contains no messages");
  }
  return thread.messages;
}

function requirePayload(message: GmailMessage): GmailMessagePart {
  return requireObject(message.payload, "message.payload") as GmailMessagePart;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function messageLabelIds(message: GmailMessage): string[] {
  if (!Array.isArray(message.labelIds)) return [];
  return message.labelIds.filter(
    (label): label is string => typeof label === "string" && label.length > 0,
  );
}

function folderFromLabels(labels: ReadonlySet<string>): MailFolderId {
  if (labels.has("TRASH")) return "trash";
  if (labels.has("SPAM")) return "spam";
  if (labels.has("DRAFT")) return "drafts";
  if (labels.has("INBOX")) return "inbox";
  if (labels.has("SENT")) return "sent";
  return "archive";
}

function getHeader(part: GmailMessagePart, name: string): string | undefined {
  if (!Array.isArray(part.headers)) return undefined;
  const header = part.headers.find(
    (candidate) =>
      typeof candidate.name === "string" &&
      candidate.name.toLowerCase() === name.toLowerCase(),
  );
  return optionalString(header?.value);
}

function requireMessageIdHeader(part: GmailMessagePart): string {
  const messageId = getHeader(part, "Message-ID") ?? getHeader(part, "Message-Id");
  return requireMessageId(messageId, "Message-ID");
}

function requireMessageId(value: unknown, field: string): string {
  const result = requireSafeHeaderValue(value, field, 998).trim();
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/u.test(result)) {
    throw new TypeError(`${field} is not a valid RFC message identifier`);
  }
  return result;
}

function appendReference(previous: string | undefined, messageId: string): string {
  const references = previous
    ? requireSafeHeaderValue(previous, "References").trim().split(/\s+/u)
    : [];
  const result = [...references.filter((reference) => /^<[^<>\s]+>$/u.test(reference)), messageId];
  return result.slice(-20).join(" ");
}

function normalizeReplySubject(requested: string, original: string): string {
  const normalizedRequested = requireSafeHeaderValue(requested, "subject", 998).trim();
  const normalizedOriginal = requireSafeHeaderValue(original, "original subject", 998).trim();
  if (!normalizedOriginal) return normalizedRequested;
  const stripPrefix = (value: string) => value.replace(/^\s*((re|aw|sv):\s*)+/iu, "").trim();
  if (stripPrefix(normalizedRequested) !== stripPrefix(normalizedOriginal)) {
    throw new TypeError("Reply subject must match the original Gmail thread subject");
  }
  return normalizedRequested || `Re: ${normalizedOriginal}`;
}

function messageDate(message: GmailMessage): Date {
  const internalDate = optionalString(message.internalDate);
  if (internalDate && /^\d+$/u.test(internalDate)) {
    const date = new Date(Number(internalDate));
    if (!Number.isNaN(date.getTime())) return date;
  }
  const headerDate = getHeader(requirePayload(message), "Date");
  const date = new Date(headerDate ?? 0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function formatShortDate(date: Date): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

function formatFullDate(date: Date): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function collectBodyParts(
  root: GmailMessagePart,
): Array<{ contentType: "text/plain" | "text/html"; part: GmailMessagePart }> {
  const result: Array<{
    contentType: "text/plain" | "text/html";
    part: GmailMessagePart;
  }> = [];
  walkParts(root, (part) => {
    const mimeType = optionalString(part.mimeType)?.toLowerCase();
    const filename = optionalString(part.filename)?.trim();
    const disposition = getHeader(part, "Content-Disposition")?.toLowerCase() ?? "";
    if (
      (mimeType === "text/plain" || mimeType === "text/html") &&
      !filename &&
      !disposition.startsWith("attachment")
    ) {
      result.push({ contentType: mimeType, part });
    }
  });
  return result;
}

function collectAttachmentParts(root: GmailMessagePart): GmailMessagePart[] {
  const result: GmailMessagePart[] = [];
  walkParts(root, (part) => {
    const filename = optionalString(part.filename)?.trim();
    const disposition = getHeader(part, "Content-Disposition")?.toLowerCase() ?? "";
    if (filename || disposition.startsWith("attachment")) result.push(part);
  });
  return result;
}

function walkParts(part: GmailMessagePart, visit: (part: GmailMessagePart) => void): void {
  visit(part);
  for (const child of Array.isArray(part.parts) ? part.parts : []) walkParts(child, visit);
}

function findAttachmentPart(
  root: GmailMessagePart,
  attachmentId: string,
): GmailMessagePart | null {
  let found: GmailMessagePart | null = null;
  walkParts(root, (part) => {
    if (found) return;
    if (part.body?.attachmentId === attachmentId || part.partId === attachmentId) {
      found = part;
    }
  });
  return found;
}

function attachmentMetadata(part: GmailMessagePart): Omit<MailAttachmentContent, "data"> {
  const filename = optionalString(part.filename)?.trim() || "attachment";
  const mimeType = normalizeMimeType(part.mimeType);
  return {
    filename,
    mimeType,
    sizeBytes: optionalNonNegativeInteger(part.body?.size) ?? 0,
  };
}

function toMailAttachment(part: GmailMessagePart): MailAttachment {
  const metadata = attachmentMetadata(part);
  const id = requireGmailId(
    optionalString(part.body?.attachmentId) ?? part.partId,
    "attachment.id",
  );
  return {
    id,
    name: metadata.filename,
    size: formatFileSize(metadata.sizeBytes),
    kind: attachmentKind(metadata.mimeType, metadata.filename),
    mimeType: metadata.mimeType,
    sizeBytes: metadata.sizeBytes,
  } as MailAttachment;
}

function attachmentKind(
  mimeType: string,
  filename: string,
): MailAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (
    /\.(?:7z|bz2|gz|rar|tar|tgz|xz|zip)$/iu.test(filename) ||
    /^(?:application\/(?:gzip|vnd\.rar|x-7z-compressed|x-tar|zip))$/iu.test(mimeType)
  ) {
    return "archive";
  }
  return "document";
}

function formatFileSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${Math.max(1, Math.round(size / 1_024))} KB`;
  return `${(size / 1_048_576).toFixed(size < 10_485_760 ? 1 : 0)} MB`;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function decodePartText(part: GmailMessagePart, data: Uint8Array): string {
  const contentType = getHeader(part, "Content-Type") ?? optionalString(part.mimeType) ?? "";
  const charset = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false }).decode(data);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(data);
  }
}

function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<\s*(?:script|style)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/giu, "")
      .replace(/<\s*br\s*\/?\s*>/giu, "\n")
      .replace(/<\s*\/(?:p|div|li|tr|h[1-6])\s*>/giu, "\n\n")
      .replace(/<[^>]+>/gu, "")
      .replace(/\u00a0/gu, " ")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
  );
}

function draftRecipientEmails(
  payload: GmailMessagePart,
  header: "To" | "Cc" | "Bcc",
): string[] {
  return parseAddressList(getHeader(payload, header) ?? "").map(
    (participant) => participant.email,
  );
}

function plainTextBody(contents: readonly MailMessageContent[]): string {
  const plain = contents.filter((item) => item.contentType === "text/plain");
  if (plain.length) return plain.map((item) => item.content).join("\n\n");
  return contents
    .filter((item) => item.contentType === "text/html")
    .map((item) => htmlToPlainText(item.content))
    .join("\n\n");
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return safeCodePoint(Number.parseInt(entity.slice(2), 16), match);
    }
    if (entity.startsWith("#")) {
      return safeCodePoint(Number.parseInt(entity.slice(1), 10), match);
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function safeCodePoint(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

function parseAddressList(value: string): MailParticipant[] {
  return splitAddressHeader(value)
    .map((entry) => {
      const angle = /^(.*)<([^<>]+)>\s*$/u.exec(entry);
      const email = (angle?.[2] ?? entry).trim().replace(/^mailto:/iu, "");
      if (!/^[^\s<>@,;:]+@[^\s<>@,;:]+(?:\.[^\s<>@,;:]+)+$/u.test(email)) return null;
      const rawName = angle?.[1]?.trim().replace(/^"|"$/gu, "") ?? "";
      const name = decodeMimeHeader(rawName) || email.split("@")[0] || email;
      return { name, email };
    })
    .filter((participant): participant is MailParticipant => participant !== null);
}

function splitAddressHeader(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && character === "<") angleDepth += 1;
    if (!quoted && character === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (character === "," && !quoted && angleDepth === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function decodeMimeHeader(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/gu, "$1$2")
    .replace(
      /=\?([^?\s]+)\?([bqBQ])\?([^?]*)\?=/gu,
      (match, charset: string, encoding: string, encoded: string) => {
        try {
          const bytes =
            encoding.toUpperCase() === "B"
              ? decodeFlexibleBase64(encoded)
              : decodeQuotedPrintableWord(encoded);
          return new TextDecoder(charset, { fatal: false }).decode(bytes);
        } catch {
          return match;
        }
      },
    );
}

function decodeQuotedPrintableWord(value: string): Uint8Array {
  const normalized = value.replaceAll("_", " ");
  const bytes: number[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] === "=" && /^[0-9a-f]{2}$/iu.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(normalized.charCodeAt(index) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function encodeMimeHeader(value: string): string {
  return /^[\x20-\x7e]*$/u.test(value)
    ? value
    : `=?UTF-8?B?${encodeBase64(utf8(value))}?=`;
}

function escapeQuotedHeader(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function encodeBase64UrlUtf8(value: string): string {
  return encodeBase64(utf8(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("Invalid Gmail base64url data");
  }
  return decodeBase64Binary(
    value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="),
  );
}

function decodeFlexibleBase64(value: string): Uint8Array {
  const normalized = value.trim();
  if (/^[A-Za-z0-9_-]+$/u.test(normalized) && !/[+/=]/u.test(normalized)) {
    return decodeBase64Url(normalized);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)) {
    throw new TypeError("Invalid base64 attachment content");
  }
  return decodeBase64Binary(normalized);
}

function decodeBase64Binary(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError("Invalid base64 data");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/gu)?.join("\r\n") ?? "";
}

function nextCursorResult(value: unknown): { nextCursor?: string } {
  const cursor = optionalString(value);
  return cursor ? { nextCursor: cursor } : {};
}

function operationFailureReason(error: unknown): string {
  if (error instanceof GmailApiError) {
    if (error.status === 404) return "Message not found";
    if (error.status === 403) return "Gmail denied this operation";
    if (error.status === 429) return "Gmail rate limit exceeded";
    return `Gmail request failed (${error.status})`;
  }
  return error instanceof TypeError ? error.message : "Gmail operation failed";
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
