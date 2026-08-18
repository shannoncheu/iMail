import {
  baseFolders,
  mockAccounts,
  mockThreads,
} from "@/src/mocks/mail";
import type {
  MailAccount,
  MailDraft,
  MailFolder,
  MailParticipant,
  MailProvider,
  MailThread,
  MessageQuery,
  MessageLocation,
  OperationResult,
  ProviderSource,
  ThreadMessage,
} from "./MailProvider";

const wait = (duration = 180) =>
  new Promise<void>((resolve) => setTimeout(resolve, duration));

const clone = <T,>(value: T): T => structuredClone(value);

const participantFromAddress = (email: string): MailParticipant => ({
  name: email.split("@")[0] || email,
  email,
});

const bodyParagraphs = (body: string) =>
  body
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

const previewFromBody = (body: string) => {
  const preview = body.replace(/\s+/g, " ").trim();
  return preview.length > 140 ? `${preview.slice(0, 139)}…` : preview;
};

export class MockMailProvider implements MailProvider {
  private threads = clone(mockThreads);
  private previousFolders = new Map<string, MailThread["folder"]>();
  private draftSnapshots = new Map<string, MailDraft>();
  private sequence = 0;

  async getAccounts() {
    await wait(90);
    return clone(mockAccounts);
  }

  async getFolders(
    scope: "all" | ProviderSource,
    accountId?: string,
  ): Promise<MailFolder[]> {
    await wait(70);
    if (scope === "all" && accountId !== undefined) {
      throw new TypeError("An account filter requires a provider scope");
    }
    const scopedThreads = this.threads.filter(
      (thread) =>
        (scope === "all" || thread.provider === scope) &&
        (!accountId || thread.accountId === accountId),
    );

    return clone(
      baseFolders.map((folder) => ({
        ...folder,
        count:
          folder.id === "starred"
            ? scopedThreads.filter((thread) => thread.starred).length
            : folder.id === "inbox"
              ? scopedThreads.filter(
                  (thread) => thread.folder === "inbox" && thread.unread,
                ).length
              : scopedThreads.filter((thread) => thread.folder === folder.id)
                  .length,
      })),
    );
  }

  async getMessages(query: MessageQuery): Promise<MailThread[]> {
    await wait(180);
    if (query.scope === "all" && query.accountId !== undefined) {
      throw new TypeError("An account filter requires a provider scope");
    }
    const term = query.search?.trim().toLocaleLowerCase();

    return clone(
      this.threads.filter((thread) => {
        const scopeMatches =
          query.scope === "all" || thread.provider === query.scope;
        const accountMatches =
          !query.accountId || thread.accountId === query.accountId;
        const folderMatches =
          query.folder === "starred"
            ? thread.starred
            : thread.folder === query.folder;
        const termMatches =
          !term ||
          thread.sender.name.toLocaleLowerCase().includes(term) ||
          thread.subject.toLocaleLowerCase().includes(term) ||
          thread.preview.toLocaleLowerCase().includes(term);

        return scopeMatches && accountMatches && folderMatches && termMatches;
      }),
    );
  }

  async getMessage(id: string): Promise<MailThread | null> {
    await wait(90);
    return clone(this.threads.find((thread) => thread.id === id) ?? null);
  }

  async sendMessage(draft: MailDraft) {
    await wait(650);
    const timestamp = this.timestamp();
    const id = this.nextId("sent");
    const sentThread = this.outgoingThread(draft, id, "sent", timestamp);

    this.threads = [
      sentThread,
      ...this.threads.filter(
        (thread) =>
          !draft.id || thread.id !== draft.id || thread.folder !== "drafts",
      ),
    ];
    if (draft.id) this.previousFolders.delete(draft.id);
    if (draft.id) this.draftSnapshots.delete(draft.id);

    return { id };
  }

  async saveDraft(draft: MailDraft) {
    await wait(320);
    const timestamp = this.timestamp();
    const id = draft.id ?? this.nextId("draft");
    const existingIndex = this.threads.findIndex((thread) => thread.id === id);

    if (
      existingIndex >= 0 &&
      this.threads[existingIndex].folder !== "drafts"
    ) {
      throw new Error(`Message ${id} is not a draft`);
    }

    const savedDraft = this.outgoingThread(
      { ...draft, id },
      id,
      "drafts",
      timestamp,
    );
    if (existingIndex >= 0) {
      savedDraft.starred = this.threads[existingIndex].starred;
      savedDraft.labels = clone(this.threads[existingIndex].labels);
      this.threads = this.threads.map((thread, index) =>
        index === existingIndex ? savedDraft : thread,
      );
    } else {
      this.threads = [savedDraft, ...this.threads];
    }
    this.draftSnapshots.set(id, clone({ ...draft, id }));

    return { id, savedAt: timestamp.short };
  }

  async getDraft(id: string): Promise<MailDraft | null> {
    await wait(90);
    return clone(this.draftSnapshots.get(id) ?? null);
  }

  async replyMessage(id: string, draft: MailDraft) {
    await wait(650);
    const threadIndex = this.threads.findIndex((thread) => thread.id === id);
    if (threadIndex < 0) throw new Error(`Message ${id} not found`);

    const timestamp = this.timestamp();
    const reply = this.outgoingMessage(draft, "reply", timestamp);
    const current = this.threads[threadIndex];
    const updated: MailThread = {
      ...current,
      subject: draft.subject || current.subject,
      preview: previewFromBody(draft.body),
      receivedAt: timestamp.short,
      receivedAtFull: timestamp.full,
      receivedAtMs: timestamp.atMs,
      unread: false,
      messages: [...current.messages, reply],
    };
    this.threads = this.threads
      .map((thread, index) => (index === threadIndex ? updated : thread))
      .filter(
        (thread) =>
          !draft.id || thread.id !== draft.id || thread.folder !== "drafts",
      );
    if (draft.id) this.previousFolders.delete(draft.id);
    if (draft.id) this.draftSnapshots.delete(draft.id);

    return { id: reply.id };
  }

  async forwardMessage(id: string, draft: MailDraft) {
    if (!this.threads.some((thread) => thread.id === id)) {
      throw new Error(`Message ${id} not found`);
    }
    return this.sendMessage(draft);
  }

  async archiveMessages(ids: string[]) {
    return this.move(ids, "archive");
  }

  async moveToTrash(ids: string[]) {
    return this.move(ids, "trash");
  }

  async restoreFromTrash(ids: string[]) {
    const locations = Array.from(new Set(ids)).map((id) => ({
      id,
      folder: this.previousFolders.get(id) ?? "inbox",
    }));
    return this.restoreMessages(locations);
  }

  async restoreMessages(locations: MessageLocation[]) {
    await wait();
    const byId = new Map(locations.map((location) => [location.id, location]));
    const result = this.resultForIds(Array.from(byId.keys()));

    this.threads = this.threads.map((thread) => {
      const location = byId.get(thread.id);
      return location ? { ...thread, folder: location.folder } : thread;
    });
    result.succeeded.forEach((id) => this.previousFolders.delete(id));

    return result;
  }

  async markRead(ids: string[], read: boolean) {
    await wait();
    const result = this.resultForIds(ids);
    const succeeded = new Set(result.succeeded);
    this.threads = this.threads.map((thread) =>
      succeeded.has(thread.id) ? { ...thread, unread: !read } : thread,
    );
    return result;
  }

  async setStarred(id: string, starred: boolean) {
    await wait(100);
    const result = this.resultForIds([id]);
    const succeeded = new Set(result.succeeded);
    this.threads = this.threads.map((thread) =>
      succeeded.has(thread.id) ? { ...thread, starred } : thread,
    );
    return result;
  }

  async searchMessages(query: MessageQuery) {
    return this.getMessages(query);
  }

  private async move(
    ids: string[],
    folder: MailThread["folder"],
  ): Promise<OperationResult> {
    await wait();
    const result = this.resultForIds(ids);
    const succeeded = new Set(result.succeeded);
    const previousLocations = result.succeeded.map((id) => {
      const thread = this.threads.find((candidate) => candidate.id === id);
      return { id, folder: thread!.folder };
    });

    previousLocations.forEach(({ id, folder: previousFolder }) =>
      this.previousFolders.set(id, previousFolder),
    );
    this.threads = this.threads.map((thread) =>
      succeeded.has(thread.id) ? { ...thread, folder } : thread,
    );
    return { ...result, previousLocations: clone(previousLocations) };
  }

  private resultForIds(ids: string[]): OperationResult {
    const existing = new Set(this.threads.map((thread) => thread.id));
    const succeeded: string[] = [];
    const failed: OperationResult["failed"] = [];

    Array.from(new Set(ids)).forEach((id) => {
      if (existing.has(id)) succeeded.push(id);
      else failed.push({ id, reason: "Message not found" });
    });

    return { succeeded, failed };
  }

  private outgoingThread(
    draft: MailDraft,
    id: string,
    folder: "sent" | "drafts",
    timestamp: { short: string; full: string; atMs: number },
  ): MailThread {
    const account = this.accountFor(draft.accountId);
    const message = this.outgoingMessage(draft, folder, timestamp);

    return {
      id,
      provider: account.provider,
      accountId: account.id,
      folder,
      sender: clone(message.sender),
      subject: draft.subject,
      preview: previewFromBody(draft.body),
      receivedAt: folder === "drafts" ? "Draft" : timestamp.short,
      receivedAtFull:
        folder === "drafts"
          ? `Draft saved ${timestamp.full}`
          : timestamp.full,
      receivedAtMs: timestamp.atMs,
      unread: false,
      starred: false,
      labels: folder === "drafts" ? ["Draft"] : [],
      hasExternalImages: false,
      messages: [message],
    };
  }

  private outgoingMessage(
    draft: MailDraft,
    prefix: string,
    timestamp: { short: string; full: string; atMs: number },
  ): ThreadMessage {
    const account = this.accountFor(draft.accountId);
    const recipients = [...draft.to, ...draft.cc, ...draft.bcc].map(
      participantFromAddress,
    );

    return {
      id: this.nextId(`${prefix}-message`),
      sender: { name: "You", email: account.address },
      recipients,
      sentAt: timestamp.short,
      sentAtFull: timestamp.full,
      body: bodyParagraphs(draft.body),
      attachments: clone(draft.attachments),
    };
  }

  private accountFor(accountId: string): MailAccount {
    const account = mockAccounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error(`Mail account ${accountId} not found`);
    return account;
  }

  private timestamp() {
    const now = new Date();
    return {
      short: new Intl.DateTimeFormat("en", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(now),
      full: new Intl.DateTimeFormat("en", {
        dateStyle: "long",
        timeStyle: "short",
      }).format(now),
      atMs: now.getTime(),
    };
  }

  private nextId(prefix: string) {
    this.sequence += 1;
    return `${prefix}-${Date.now()}-${this.sequence}`;
  }
}
