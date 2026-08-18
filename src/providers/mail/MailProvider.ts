export type ProviderSource = "gmail" | "outlook" | "zoho";

export type MailFolderId =
  | "inbox"
  | "starred"
  | "sent"
  | "drafts"
  | "archive"
  | "spam"
  | "trash";

export interface ProviderCapabilities {
  labels: boolean;
  reliableDraftUpdates: boolean;
  externalImages: boolean;
  permanentDelete: boolean;
}

export interface MailAccount {
  id: string;
  provider: ProviderSource;
  label: string;
  address: string;
  color: string;
  connected: boolean;
  capabilities: ProviderCapabilities;
}

export interface MailFolder {
  id: MailFolderId;
  label: string;
  count?: number;
}

export interface MailAttachment {
  id: string;
  name: string;
  size: string;
  kind: "document" | "image" | "archive";
  mimeType?: string;
  sizeBytes?: number;
  downloadUrl?: string;
  inline?: boolean;
  contentId?: string;
  /** Provider message that owns an existing attachment; removed at the BFF. */
  sourceMessageId?: string;
  /** Present only while a newly selected attachment is sent to the BFF. */
  contentBase64?: string;
}

export interface MailAttachmentContent {
  data: Uint8Array;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MailMessageContent {
  content: string;
  contentType: "text/plain" | "text/html";
}

export interface MailParticipant {
  name: string;
  email: string;
}

export interface ThreadMessage {
  id: string;
  sender: MailParticipant;
  recipients: MailParticipant[];
  sentAt: string;
  sentAtFull: string;
  body: string[];
  /** Same-origin URL that renders provider HTML in a CSP-sandboxed document. */
  contentUrl?: string;
  attachments: MailAttachment[];
}

export interface MailThread {
  id: string;
  provider: ProviderSource;
  accountId: string;
  folder: MailFolderId;
  sender: MailParticipant;
  subject: string;
  preview: string;
  receivedAt: string;
  receivedAtFull: string;
  /** Provider timestamp in Unix milliseconds; used for machine ordering only. */
  receivedAtMs: number;
  unread: boolean;
  starred: boolean;
  labels: string[];
  hasExternalImages: boolean;
  messages: ThreadMessage[];
}

export interface MessageQuery {
  scope: "all" | ProviderSource;
  /** Limits a provider scope to one owner-visible connected account. */
  accountId?: string;
  folder: MailFolderId;
  search?: string;
  cursor?: string;
  pageSize?: number;
}

export interface MailMessagePage {
  messages: MailThread[];
  nextCursor?: string;
  partial?: boolean;
  accountErrors?: Array<{
    accountId: string;
    code: "provider_unavailable";
  }>;
}

export interface MailDraft {
  id?: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: MailAttachment[];
  /** Signed BFF resource that preserves reply/forward semantics across saves. */
  composeIntent?: {
    mode: "reply" | "forward";
    sourceId: string;
  };
}

export interface MessageLocation {
  id: string;
  folder: MailFolderId;
}

export interface OperationResult {
  succeeded: string[];
  failed: Array<{ id: string; reason: string }>;
  previousLocations?: MessageLocation[];
}

/**
 * Stable application boundary consumed by the UI. Provider-specific SDK types
 * and OAuth tokens must never cross this interface.
 */
export interface MailProvider {
  getAccounts(): Promise<MailAccount[]>;
  getFolders(
    scope: "all" | ProviderSource,
    accountId?: string,
  ): Promise<MailFolder[]>;
  getMessages(query: MessageQuery): Promise<MailThread[]>;
  getMessage(id: string): Promise<MailThread | null>;
  sendMessage(draft: MailDraft): Promise<{ id: string }>;
  saveDraft(draft: MailDraft): Promise<{ id: string; savedAt: string }>;
  getDraft?(id: string): Promise<MailDraft | null>;
  replyMessage(id: string, draft: MailDraft): Promise<{ id: string }>;
  forwardMessage(id: string, draft: MailDraft): Promise<{ id: string }>;
  archiveMessages(ids: string[]): Promise<OperationResult>;
  moveToTrash(ids: string[]): Promise<OperationResult>;
  restoreFromTrash(ids: string[]): Promise<OperationResult>;
  restoreMessages(locations: MessageLocation[]): Promise<OperationResult>;
  markRead(ids: string[], read: boolean): Promise<OperationResult>;
  setStarred(id: string, starred: boolean): Promise<OperationResult>;
  searchMessages(query: MessageQuery): Promise<MailThread[]>;
  getMessagesPage?(query: MessageQuery): Promise<MailMessagePage>;
  getAttachment?(
    messageId: string,
    attachmentId: string,
  ): Promise<MailAttachmentContent | null>;
  getRawMessageContent?(
    messageId: string,
  ): Promise<MailMessageContent | null>;
}
