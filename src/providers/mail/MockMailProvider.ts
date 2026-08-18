import {
  baseFolders,
  mockAccounts,
  mockThreads,
} from "@/src/mocks/mail";
import type {
  MailDraft,
  MailFolder,
  MailProvider,
  MailThread,
  MessageQuery,
  OperationResult,
  ProviderSource,
} from "./MailProvider";

const wait = (duration = 180) =>
  new Promise<void>((resolve) => setTimeout(resolve, duration));

const clone = <T,>(value: T): T => structuredClone(value);

export class MockMailProvider implements MailProvider {
  private threads = clone(mockThreads);

  async getAccounts() {
    await wait(90);
    return clone(mockAccounts);
  }

  async getFolders(scope: "all" | ProviderSource): Promise<MailFolder[]> {
    await wait(70);
    return baseFolders.map((folder) => ({
      ...folder,
      count:
        folder.id === "inbox"
          ? this.threads.filter(
              (thread) =>
                thread.folder === "inbox" &&
                thread.unread &&
                (scope === "all" || thread.provider === scope),
            ).length
          : folder.count,
    }));
  }

  async getMessages(query: MessageQuery): Promise<MailThread[]> {
    await wait(180);
    const term = query.search?.trim().toLocaleLowerCase();

    return clone(
      this.threads.filter((thread) => {
        const scopeMatches =
          query.scope === "all" || thread.provider === query.scope;
        const folderMatches =
          query.folder === "starred"
            ? thread.starred
            : thread.folder === query.folder;
        const termMatches =
          !term ||
          thread.sender.name.toLocaleLowerCase().includes(term) ||
          thread.subject.toLocaleLowerCase().includes(term) ||
          thread.preview.toLocaleLowerCase().includes(term);

        return scopeMatches && folderMatches && termMatches;
      }),
    );
  }

  async getMessage(id: string): Promise<MailThread | null> {
    await wait(90);
    return clone(this.threads.find((thread) => thread.id === id) ?? null);
  }

  async sendMessage(_draft: MailDraft) {
    void _draft;
    await wait(650);
    return { id: `sent-${Date.now()}` };
  }

  async saveDraft(_draft: MailDraft) {
    void _draft;
    await wait(320);
    return {
      id: `draft-${Date.now()}`,
      savedAt: new Intl.DateTimeFormat("en", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date()),
    };
  }

  async replyMessage(_id: string, draft: MailDraft) {
    return this.sendMessage(draft);
  }

  async forwardMessage(_id: string, draft: MailDraft) {
    return this.sendMessage(draft);
  }

  async archiveMessages(ids: string[]) {
    return this.move(ids, "archive");
  }

  async moveToTrash(ids: string[]) {
    return this.move(ids, "trash");
  }

  async restoreFromTrash(ids: string[]) {
    return this.move(ids, "inbox");
  }

  async markRead(ids: string[], read: boolean) {
    await wait();
    this.threads = this.threads.map((thread) =>
      ids.includes(thread.id) ? { ...thread, unread: !read } : thread,
    );
    return this.success(ids);
  }

  async setStarred(id: string, starred: boolean) {
    await wait(100);
    this.threads = this.threads.map((thread) =>
      thread.id === id ? { ...thread, starred } : thread,
    );
    return this.success([id]);
  }

  async searchMessages(query: MessageQuery) {
    return this.getMessages(query);
  }

  private async move(
    ids: string[],
    folder: MailThread["folder"],
  ): Promise<OperationResult> {
    await wait();
    this.threads = this.threads.map((thread) =>
      ids.includes(thread.id) ? { ...thread, folder } : thread,
    );
    return this.success(ids);
  }

  private success(ids: string[]): OperationResult {
    return { succeeded: ids, failed: [] };
  }
}
