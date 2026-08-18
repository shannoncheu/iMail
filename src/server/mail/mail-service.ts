import "server-only";

import type {
  MailAccount,
  MailAttachment,
  MailAttachmentContent,
  MailDraft,
  MailFolder,
  MailMessageContent,
  MailMessagePage,
  MailProvider,
  MailThread,
  MessageLocation,
  MessageQuery,
  OperationResult,
  ProviderSource,
  ThreadMessage,
} from "../../providers/mail/MailProvider";
import type { AuthConfig } from "../config";
import type { EncryptedSecretEnvelope } from "../auth/types";
import type { StoredMailConnection } from "./connection-types";
import type { MailConnectionRepository } from "./connection-repository";
import type {
  MailDraftIntent,
  MailDraftIntentMode,
  MailDraftIntentSourceType,
} from "./draft-intent-repository";
import { decodeMailPublicId, encodeMailPublicId } from "./public-id";
import { MailPaginationVault } from "./pagination-vault";
import { sha256Base64Url } from "../security/crypto";

const aggregateCursorConnection = "00000000-0000-0000-0000-000000000000";
const maximumAttachmentBytes = 5 * 1_024 * 1_024;
const maximumAggregateAccounts = 5;
const maximumAggregatePageSize = 25;
const aggregateProviderChunkSize = 10;
const maximumEmptyProviderPages = 4;
const maximumAggregateSeenIds = aggregateProviderChunkSize * 3;
const maximumSearchLength = 256;

export type ServerMailAdapterResolver = (
  provider: ProviderSource,
  context: { accountId: string; ownerId: string },
) => Promise<MailProvider>;

export class MailService {
  private paginationVaultPromise?: Promise<MailPaginationVault>;

  constructor(
    private readonly options: {
      config: AuthConfig;
      ownerId: string;
      repository: Pick<
        MailConnectionRepository,
        "findById" | "listConnected"
      >;
      paginationRepository?: MailPaginationRepositoryLike;
      draftIntentRepository?: MailDraftIntentRepositoryLike;
      resolveProvider: ServerMailAdapterResolver;
    },
  ) {}

  async getAccounts(): Promise<MailAccount[]> {
    const connections = await this.options.repository.listConnected(
      this.options.ownerId,
    );
    return connections.map(toMailAccount);
  }

  async getFolders(
    scope: "all" | ProviderSource,
    accountId?: string,
  ): Promise<MailFolder[]> {
    const connections = await this.connectionsForScope(scope, accountId);
    const folderLists = await Promise.all(
      connections.map(async (connection) => {
        const provider = await this.providerFor(connection);
        return provider.getFolders(connection.provider);
      }),
    );
    const folders = new Map<string, MailFolder>();
    for (const list of folderLists) {
      for (const folder of list) {
        const current = folders.get(folder.id);
        folders.set(folder.id, {
          id: folder.id,
          label: current?.label ?? folder.label,
          count:
            current?.count === undefined && folder.count === undefined
              ? undefined
              : (current?.count ?? 0) + (folder.count ?? 0),
        });
      }
    }
    return Array.from(folders.values());
  }

  async getMessages(query: MessageQuery): Promise<MailThread[]> {
    return (await this.getMessagesPage(query)).messages;
  }

  async getMessagesPage(query: MessageQuery): Promise<MailMessagePage> {
    if ((query.search?.trim().length ?? 0) > maximumSearchLength) {
      throw new TypeError(`Mail search is limited to ${maximumSearchLength} characters`);
    }
    const requestedPageSize = Math.min(100, Math.max(1, query.pageSize ?? 50));
    const connections = await this.connectionsForScope(
      query.scope,
      query.accountId,
    );
    if (connections.length === 0) return { messages: [] };
    const pageSize =
      connections.length > 1
        ? Math.min(requestedPageSize, maximumAggregatePageSize)
        : requestedPageSize;
    const connectionIds = connections.map(({ id }) => id).sort();
    const fingerprint = await aggregateQueryFingerprint(
      query,
      requestedPageSize,
      connectionIds,
    );
    if (query.cursor) {
      return this.continueAggregatePage(
        query.cursor,
        fingerprint,
        connections,
        query,
        pageSize,
      );
    }
    const state: AggregateSessionState = {
      version: 1,
      fingerprint,
      accounts: connections.map(({ id }) => ({
        id,
        providerCursor: null,
        buffer: [],
        seenIds: [],
        boundary: null,
        endAfterBuffer: false,
        exhausted: false,
      })),
      excluded: [],
    };
    const produced = await this.produceAggregatePage(
      state,
      connections,
      query,
      pageSize,
      true,
    );
    if (!produced.hasMore) return produced.page;
    const repository = this.requirePaginationRepository();
    const sessionId = crypto.randomUUID();
    const envelope = await this.encryptPaginationState(sessionId, state);
    const session = await repository.create({
      id: sessionId,
      ownerId: this.options.ownerId,
      queryFingerprint: fingerprint,
      stateEnvelope: envelope,
    });
    return {
      ...produced.page,
      nextCursor: await this.encodeAggregateHandle(
        session.id,
        session.revision,
        fingerprint,
      ),
    };
  }

  private async continueAggregatePage(
    encodedCursor: string,
    fingerprint: string,
    connections: StoredMailConnection[],
    query: MessageQuery,
    pageSize: number,
  ): Promise<MailMessagePage> {
    const repository = this.requirePaginationRepository();
    const handle = await this.decodeAggregateHandle(encodedCursor, fingerprint);
    let session = await repository.find({
      id: handle.sessionId,
      ownerId: this.options.ownerId,
      queryFingerprint: fingerprint,
    });
    if (!session) throw new TypeError("Mail cursor has expired");
    let state = await this.decryptPaginationState(session, connections);
    const replay = this.replayedAggregatePage(state, session.revision, handle.revision);
    if (replay) {
      return this.withAggregateCursor(
        replay.page,
        replay.hasMore,
        session.id,
        session.revision,
        fingerprint,
      );
    }
    if (session.revision !== handle.revision) {
      throw new TypeError("Mail cursor is stale");
    }
    state.lastPage = undefined;
    const produced = await this.produceAggregatePage(
      state,
      connections,
      query,
      pageSize,
      false,
    );
    state.lastPage = {
      inputRevision: handle.revision,
      page: produced.page,
      hasMore: produced.hasMore,
    };
    const stateEnvelope = await this.encryptPaginationState(session.id, state);
    const advanced = await repository.advance({
      id: session.id,
      ownerId: this.options.ownerId,
      queryFingerprint: fingerprint,
      expectedRevision: handle.revision,
      stateEnvelope,
    });
    if (advanced) {
      return this.withAggregateCursor(
        produced.page,
        produced.hasMore,
        advanced.id,
        advanced.revision,
        fingerprint,
      );
    }
    session = await repository.find({
      id: session.id,
      ownerId: this.options.ownerId,
      queryFingerprint: fingerprint,
    });
    if (!session) throw new TypeError("Mail cursor has expired");
    state = await this.decryptPaginationState(session, connections);
    const winner = this.replayedAggregatePage(
      state,
      session.revision,
      handle.revision,
    );
    if (!winner) throw new TypeError("Mail cursor is stale");
    return this.withAggregateCursor(
      winner.page,
      winner.hasMore,
      session.id,
      session.revision,
      fingerprint,
    );
  }

  private async produceAggregatePage(
    state: AggregateSessionState,
    connections: StoredMailConnection[],
    query: MessageQuery,
    pageSize: number,
    initial: boolean,
  ): Promise<{ page: MailMessagePage; hasMore: boolean }> {
    const byId = new Map(connections.map((connection) => [connection.id, connection]));
    const active = state.accounts.filter((account) => !account.exhausted);
    const prepared = await Promise.allSettled(
      active.map(async (account): Promise<LoadedAggregateAccount> => {
        const connection = byId.get(account.id);
        if (!connection) throw new Error("Mail cursor account is unavailable");
        const provider = await this.providerFor(connection);
        if (account.buffer.length === 0) {
          await this.fillAggregateBuffer(account, connection, provider, query);
        }
        return { account, connection, provider };
      }),
    );
    const loaded: LoadedAggregateAccount[] = [];
    const transientErrors = new Set<string>();
    const failedInitial = new Set<string>();
    for (let index = 0; index < prepared.length; index += 1) {
      const result = prepared[index];
      if (result.status === "fulfilled") {
        loaded.push(result.value);
      } else if (initial) {
        failedInitial.add(active[index].id);
      } else {
        throw new Error("A mail provider is temporarily unavailable");
      }
    }
    if (failedInitial.size) {
      state.accounts = state.accounts.filter(
        ({ id }) => !failedInitial.has(id),
      );
      state.excluded = Array.from(
        new Set([...state.excluded, ...failedInitial]),
      ).sort();
    }
    if (loaded.length === 0 && failedInitial.size > 0) {
      throw new Error("Mail providers are temporarily unavailable");
    }

    const selected: Array<{
      connection: StoredMailConnection;
      thread: MailThread;
    }> = [];
    while (selected.length < pageSize) {
      const candidates = loaded.filter(
        ({ account }) => account.buffer.length > 0,
      );
      if (candidates.length === 0) break;
      let next = candidates[0];
      for (const candidate of candidates.slice(1)) {
        if (compareAggregateThreads(candidate, next) < 0) next = candidate;
      }
      const thread = next.account.buffer.shift();
      if (!thread) throw new Error("Mail pagination buffer is inconsistent");
      selected.push({ connection: next.connection, thread });
      if (next.account.buffer.length === 0) {
        if (next.account.endAfterBuffer) {
          next.account.exhausted = true;
        } else if (selected.length < pageSize) {
          try {
            await this.fillAggregateBuffer(
              next.account,
              next.connection,
              next.provider,
              query,
            );
          } catch {
            transientErrors.add(next.account.id);
            break;
          }
        }
      }
    }
    const messages = await Promise.all(
      selected.map(({ connection, thread }) =>
        this.publicThread(connection, thread),
      ),
    );
    const accountErrors = Array.from(
      new Set([...state.excluded, ...transientErrors]),
    )
      .sort()
      .map((accountId) => ({
        accountId,
        code: "provider_unavailable" as const,
      }));
    const page: MailMessagePage = {
      messages,
      ...(accountErrors.length ? { partial: true, accountErrors } : {}),
    };
    return {
      page,
      hasMore: state.accounts.some(
        (account) => account.buffer.length > 0 || !account.exhausted,
      ),
    };
  }

  private async fillAggregateBuffer(
    state: AggregateAccountState,
    connection: StoredMailConnection,
    provider: MailProvider,
    query: MessageQuery,
  ): Promise<void> {
    if (state.buffer.length || state.exhausted) return;
    for (let attempt = 0; attempt < maximumEmptyProviderPages; attempt += 1) {
      const requestedCursor = state.providerCursor;
      const providerQuery: MessageQuery = {
        scope: connection.provider,
        folder: query.folder,
        ...(query.search ? { search: query.search } : {}),
        ...(requestedCursor ? { cursor: requestedCursor } : {}),
        pageSize: aggregateProviderChunkSize,
      };
      const page = provider.getMessagesPage
        ? await provider.getMessagesPage(providerQuery)
        : { messages: await provider.getMessages(providerQuery) };
      if (page.messages.length > aggregateProviderChunkSize) {
        throw new Error("Mail provider page is too large");
      }
      if (
        page.nextCursor !== undefined &&
        (!page.nextCursor ||
          page.nextCursor.length > 8_192 ||
          page.nextCursor === requestedCursor)
      ) {
        throw new Error("Mail provider cursor is invalid");
      }
      for (const thread of page.messages) messageTimestamp(thread);
      const seen = new Set(state.seenIds);
      const messages = [...page.messages]
        .sort((left, right) =>
          compareThreadValues(connection.id, left, connection.id, right),
        )
        .filter((thread) => {
          if (!thread.id || thread.id.length > 4_096 || seen.has(thread.id)) {
            return false;
          }
          seen.add(thread.id);
          return true;
        })
        .map((thread) => ({ ...thread, messages: [] }));
      if (
        state.boundary &&
        messages[0] &&
        compareThreadSortKeys(state.boundary, threadSortKey(messages[0])) > 0
      ) {
        throw new Error("Mail provider page order changed");
      }
      state.providerCursor = page.nextCursor ?? null;
      state.endAfterBuffer = !page.nextCursor;
      state.seenIds = [...seen].slice(-maximumAggregateSeenIds);
      if (messages.length) {
        state.buffer = messages;
        state.boundary = threadSortKey(messages[messages.length - 1]);
        return;
      }
      if (!page.nextCursor) {
        state.exhausted = true;
        return;
      }
    }
    throw new Error("Mail provider returned too many empty pages");
  }

  private replayedAggregatePage(
    state: AggregateSessionState,
    storedRevision: number,
    inputRevision: number,
  ): AggregateLastPage | null {
    return storedRevision === inputRevision + 1 &&
      state.lastPage?.inputRevision === inputRevision
      ? state.lastPage
      : null;
  }

  private async withAggregateCursor(
    page: MailMessagePage,
    hasMore: boolean,
    sessionId: string,
    revision: number,
    fingerprint: string,
  ): Promise<MailMessagePage> {
    return {
      ...page,
      ...(hasMore
        ? {
            nextCursor: await this.encodeAggregateHandle(
              sessionId,
              revision,
              fingerprint,
            ),
          }
        : {}),
    };
  }

  private async encodeAggregateHandle(
    sessionId: string,
    revision: number,
    fingerprint: string,
  ): Promise<string> {
    return encodeMailPublicId(this.options.config, {
      connectionId: aggregateCursorConnection,
      nativeId: JSON.stringify({ v: 3, s: sessionId, r: revision, q: fingerprint }),
      type: "cursor",
    });
  }

  private async decodeAggregateHandle(
    encoded: string,
    expectedFingerprint: string,
  ): Promise<{ sessionId: string; revision: number }> {
    const cursor = await decodeMailPublicId(this.options.config, encoded);
    if (
      !cursor ||
      cursor.type !== "cursor" ||
      cursor.connectionId !== aggregateCursorConnection
    ) {
      throw new TypeError("Invalid mail cursor");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(cursor.nativeId);
    } catch {
      throw new TypeError("Invalid mail cursor");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Invalid mail cursor");
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.v !== 3 ||
      record.q !== expectedFingerprint ||
      typeof record.s !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        record.s,
      ) ||
      !Number.isSafeInteger(record.r) ||
      (record.r as number) < 0
    ) {
      throw new TypeError("Invalid mail cursor");
    }
    return { sessionId: record.s, revision: record.r as number };
  }

  private async encryptPaginationState(
    sessionId: string,
    state: AggregateSessionState,
  ): Promise<EncryptedSecretEnvelope> {
    const vault = await this.getPaginationVault();
    return vault.encrypt(state, {
      sessionId,
      ownerId: this.options.ownerId,
      queryFingerprint: state.fingerprint,
    });
  }

  private async decryptPaginationState(
    session: MailPaginationSessionLike,
    connections: StoredMailConnection[],
  ): Promise<AggregateSessionState> {
    const vault = await this.getPaginationVault();
    const value = await vault.decrypt(session.stateEnvelope, {
      sessionId: session.id,
      ownerId: this.options.ownerId,
      queryFingerprint: session.queryFingerprint,
    });
    return parseAggregateSessionState(
      value,
      session.queryFingerprint,
      new Set(connections.map(({ id }) => id)),
    );
  }

  private getPaginationVault(): Promise<MailPaginationVault> {
    this.paginationVaultPromise ??= MailPaginationVault.createFromConfig(
      this.options.config,
    );
    return this.paginationVaultPromise;
  }

  private requirePaginationRepository(): MailPaginationRepositoryLike {
    if (!this.options.paginationRepository) {
      throw new Error("Mail pagination storage is unavailable");
    }
    return this.options.paginationRepository;
  }

  async getMessage(publicId: string): Promise<MailThread | null> {
    const resource = await this.decodeOwnedId(publicId, [
      "thread",
      "message",
      "draft",
    ]);
    if (!resource) return null;
    const { connection, nativeId } = resource;
    const provider = await this.providerFor(connection);
    const thread = await provider.getMessage(nativeId);
    return thread ? this.publicThread(connection, thread) : null;
  }

  async getDraft(publicId: string): Promise<MailDraft | null> {
    const resource = await this.decodeOwnedId(publicId, ["draft"]);
    if (!resource) return null;
    const provider = await this.providerFor(resource.connection);
    if (!provider.getDraft) return null;
    const draft = await provider.getDraft(resource.nativeId);
    if (!draft) {
      if (this.options.draftIntentRepository) {
        await this.options.draftIntentRepository.delete({
          ownerId: this.options.ownerId,
          connectionId: resource.connection.id,
          draftNativeId: resource.nativeId,
        });
      }
      return null;
    }
    const intent = this.options.draftIntentRepository
      ? await this.options.draftIntentRepository.find({
          ownerId: this.options.ownerId,
          connectionId: resource.connection.id,
          draftNativeId: resource.nativeId,
        })
      : null;
    const trustedIntent = intent
      ? requireStoredDraftIntent(
          intent,
          this.options.ownerId,
          resource.connection.id,
          resource.nativeId,
        )
      : null;
    const attachments = await Promise.all(
      draft.attachments.map(async (attachment): Promise<MailAttachment> => {
        if (!attachment.sourceMessageId) {
          throw new Error("Draft attachment source is unavailable");
        }
        const sizeBytes = attachment.sizeBytes;
        if (
          sizeBytes === undefined ||
          !Number.isSafeInteger(sizeBytes) ||
          sizeBytes < 0 ||
          sizeBytes > 150 * 1_024 * 1_024
        ) {
          throw new Error("Draft attachment size is invalid");
        }
        const attachmentId = await encodeMailPublicId(this.options.config, {
          connectionId: resource.connection.id,
          nativeId: attachment.id,
          messageId: attachment.sourceMessageId,
          sizeBytes,
          type: "attachment",
        });
        const safeAttachment = { ...attachment };
        delete safeAttachment.sourceMessageId;
        delete safeAttachment.contentBase64;
        return {
          ...safeAttachment,
          id: attachmentId,
          downloadUrl: `/api/mail/attachment?id=${encodeURIComponent(attachmentId)}`,
        };
      }),
    );
    return {
      ...draft,
      id: publicId,
      accountId: resource.connection.id,
      attachments,
      ...(trustedIntent
        ? {
            composeIntent: {
              mode: trustedIntent.mode,
              sourceId: await encodeMailPublicId(this.options.config, {
                connectionId: resource.connection.id,
                nativeId: trustedIntent.sourceNativeId,
                type: trustedIntent.sourceType,
              }),
            },
          }
        : { composeIntent: undefined }),
    };
  }

  async sendMessage(draft: MailDraft): Promise<{ id: string }> {
    return this.writeDraft("send", undefined, draft);
  }

  async saveDraft(draft: MailDraft): Promise<{ id: string; savedAt: string }> {
    const connection = await this.requireConnection(draft.accountId);
    const provider = await this.providerFor(connection);
    const nativeDraft = await this.nativeDraft(connection, draft);
    const intent = await this.resolveDraftIntent(
      connection,
      draft,
      nativeDraft.id,
    );
    const result = await provider.saveDraft(nativeDraft);
    if (intent) {
      await this.requireDraftIntentRepository().replace({
        ownerId: this.options.ownerId,
        connectionId: connection.id,
        previousDraftNativeId: nativeDraft.id,
        draftNativeId: result.id,
        ...intent,
      });
    }
    return {
      id: await encodeMailPublicId(this.options.config, {
        connectionId: connection.id,
        nativeId: result.id,
        type: "draft",
      }),
      savedAt: result.savedAt,
    };
  }

  async replyMessage(
    publicId: string,
    draft: MailDraft,
  ): Promise<{ id: string }> {
    return this.writeDraft("reply", publicId, draft);
  }

  async forwardMessage(
    publicId: string,
    draft: MailDraft,
  ): Promise<{ id: string }> {
    return this.writeDraft("forward", publicId, draft);
  }

  async archiveMessages(ids: string[]): Promise<OperationResult> {
    return this.mutateMessages(ids, (provider, nativeIds) =>
      provider.archiveMessages(nativeIds),
    );
  }

  async moveToTrash(ids: string[]): Promise<OperationResult> {
    return this.mutateMessages(ids, (provider, nativeIds) =>
      provider.moveToTrash(nativeIds),
    );
  }

  async restoreFromTrash(ids: string[]): Promise<OperationResult> {
    return this.mutateMessages(ids, (provider, nativeIds) =>
      provider.restoreFromTrash(nativeIds),
    );
  }

  async restoreMessages(locations: MessageLocation[]): Promise<OperationResult> {
    const decoded = await Promise.all(
      locations.map(async (location) => ({
        location,
        resource: await this.decodeOwnedId(location.id, ["thread", "message"]),
      })),
    );
    const failed: OperationResult["failed"] = decoded
      .filter((item) => !item.resource)
      .map((item) => ({ id: item.location.id, reason: "Invalid message ID" }));
    const groups = groupByConnection(
      decoded.filter((item) => item.resource) as Array<{
        location: MessageLocation;
        resource: OwnedResource;
      }>,
      (item) => item.resource.connection.id,
    );
    const succeeded: string[] = [];
    for (const items of groups.values()) {
      const connection = items[0].resource.connection;
      try {
        const provider = await this.providerFor(connection);
        const result = await provider.restoreMessages(
          items.map((item) => ({
            id: item.resource.nativeId,
            folder: item.location.folder,
          })),
        );
        applyMutationResult(items, result, succeeded, failed);
      } catch {
        failed.push(
          ...items.map((item) => ({
            id: item.location.id,
            reason: "Mail provider is unavailable",
          })),
        );
      }
    }
    return { succeeded, failed };
  }

  async markRead(ids: string[], read: boolean): Promise<OperationResult> {
    return this.mutateMessages(ids, (provider, nativeIds) =>
      provider.markRead(nativeIds, read),
    );
  }

  async setStarred(publicId: string, starred: boolean): Promise<OperationResult> {
    return this.mutateMessages([publicId], (provider, nativeIds) =>
      provider.setStarred(nativeIds[0], starred),
    );
  }

  async getAttachment(publicId: string): Promise<MailAttachmentContent | null> {
    const resource = await this.decodeOwnedId(publicId, ["attachment"]);
    if (!resource?.messageId) return null;
    const provider = await this.providerFor(resource.connection);
    if (!provider.getAttachment) return null;
    return provider.getAttachment(resource.messageId, resource.nativeId);
  }

  async getRawMessageContent(publicId: string): Promise<MailMessageContent | null> {
    const resource = await this.decodeOwnedId(publicId, ["message"]);
    if (!resource) return null;
    const provider = await this.providerFor(resource.connection);
    if (!provider.getRawMessageContent) return null;
    return provider.getRawMessageContent(resource.nativeId);
  }

  private async writeDraft(
    mode: "send" | "reply" | "forward",
    publicId: string | undefined,
    draft: MailDraft,
  ): Promise<{ id: string }> {
    const connection = await this.requireConnection(draft.accountId);
    const provider = await this.providerFor(connection);
    const nativeDraft = await this.nativeDraft(connection, draft);
    const draftIntent = await this.resolveDraftIntent(
      connection,
      draft,
      nativeDraft.id,
    );
    let routeIntent: TrustedDraftIntent | null = null;
    if (mode !== "send") {
      routeIntent = await this.decodeDraftIntentSource(connection, {
        mode,
        sourceId: publicId ?? "",
      });
      if (!routeIntent) {
        throw new Error("Message and sender account do not match");
      }
    }
    if (routeIntent && draftIntent && !sameDraftIntent(routeIntent, draftIntent)) {
      throw new Error("Saved draft intent does not match the source message");
    }
    const effectiveIntent = routeIntent ?? draftIntent;
    let nativeId: string;
    if (!effectiveIntent) {
      nativeId = (await provider.sendMessage(nativeDraft)).id;
    } else {
      nativeId =
        effectiveIntent.mode === "reply"
          ? (
              await provider.replyMessage(
                effectiveIntent.sourceNativeId,
                nativeDraft,
              )
            ).id
          : (
              await provider.forwardMessage(
                effectiveIntent.sourceNativeId,
                nativeDraft,
              )
            ).id;
    }
    if (nativeDraft.id && (effectiveIntent || draftIntent)) {
      try {
        await this.requireDraftIntentRepository().delete({
          ownerId: this.options.ownerId,
          connectionId: connection.id,
          draftNativeId: nativeDraft.id,
        });
      } catch {
        // The provider send is authoritative. A cleanup failure must not invite
        // the user to retry an email that was already delivered.
      }
    }
    return {
      id: await encodeMailPublicId(this.options.config, {
        connectionId: connection.id,
        nativeId,
        type: "message",
      }),
    };
  }

  private async resolveDraftIntent(
    connection: StoredMailConnection,
    draft: MailDraft,
    nativeDraftId: string | undefined,
  ): Promise<TrustedDraftIntent | null> {
    const supplied = draft.composeIntent
      ? await this.decodeDraftIntentSource(connection, draft.composeIntent)
      : null;
    if (draft.composeIntent && !supplied) {
      throw new Error("Draft compose intent is invalid");
    }
    let stored: TrustedDraftIntent | null = null;
    if (nativeDraftId && this.options.draftIntentRepository) {
      const record = await this.options.draftIntentRepository.find({
        ownerId: this.options.ownerId,
        connectionId: connection.id,
        draftNativeId: nativeDraftId,
      });
      stored = record
        ? requireStoredDraftIntent(
            record,
            this.options.ownerId,
            connection.id,
            nativeDraftId,
          )
        : null;
    }
    if (supplied && stored && !sameDraftIntent(supplied, stored)) {
      throw new Error("Draft compose intent does not match its saved state");
    }
    return stored ?? supplied;
  }

  private async decodeDraftIntentSource(
    connection: StoredMailConnection,
    intent: NonNullable<MailDraft["composeIntent"]>,
  ): Promise<TrustedDraftIntent | null> {
    if (intent.mode !== "reply" && intent.mode !== "forward") return null;
    const resource = await this.decodeOwnedId(intent.sourceId, [
      "thread",
      "message",
    ]);
    if (!resource || resource.connection.id !== connection.id) return null;
    return {
      mode: intent.mode,
      sourceType: resource.type === "thread" ? "thread" : "message",
      sourceNativeId: resource.nativeId,
    };
  }

  private requireDraftIntentRepository(): MailDraftIntentRepositoryLike {
    if (!this.options.draftIntentRepository) {
      throw new Error("Mail draft intent storage is unavailable");
    }
    return this.options.draftIntentRepository;
  }

  private async nativeDraft(
    connection: StoredMailConnection,
    draft: MailDraft,
  ): Promise<MailDraft> {
    validateDraft(draft);
    let nativeId: string | undefined;
    if (draft.id) {
      const resource = await this.decodeOwnedId(draft.id, ["draft"]);
      if (!resource || resource.connection.id !== connection.id) {
        throw new Error("Draft and sender account do not match");
      }
      nativeId = resource.nativeId;
    }
    const attachments = await Promise.all(
      draft.attachments.map(async (attachment): Promise<MailAttachment> => {
        if (attachment.contentBase64) {
          return {
            ...attachment,
            downloadUrl: undefined,
            sourceMessageId: undefined,
          };
        }
        const resource = await this.decodeOwnedId(attachment.id, ["attachment"]);
        if (
          !resource ||
          resource.connection.id !== connection.id ||
          !resource.messageId ||
          resource.sizeBytes === undefined
        ) {
          throw new Error("Draft attachment is invalid");
        }
        return {
          ...attachment,
          id: resource.nativeId,
          sourceMessageId: resource.messageId,
          sizeBytes: resource.sizeBytes,
          contentBase64: undefined,
          downloadUrl: undefined,
        };
      }),
    );
    const totalAttachmentBytes = attachments.reduce(
      (total, attachment) =>
        total +
        (attachment.contentBase64
          ? decodedBase64ByteLength(attachment.contentBase64)
          : (attachment.sizeBytes ?? 0)),
      0,
    );
    if (totalAttachmentBytes > maximumAttachmentBytes) {
      throw new TypeError("Attachments are too large");
    }
    return {
      ...draft,
      id: nativeId,
      accountId: connection.id,
      attachments,
      composeIntent: undefined,
    };
  }

  private async mutateMessages(
    publicIds: string[],
    mutation: (provider: MailProvider, nativeIds: string[]) => Promise<OperationResult>,
  ): Promise<OperationResult> {
    const uniqueIds = Array.from(new Set(publicIds));
    const decoded = await Promise.all(
      uniqueIds.map(async (id) => ({
        id,
        resource: await this.decodeOwnedId(id, ["thread", "message"]),
      })),
    );
    const succeeded: string[] = [];
    const failed: OperationResult["failed"] = decoded
      .filter((item) => !item.resource)
      .map((item) => ({ id: item.id, reason: "Invalid message ID" }));
    const previousLocations: MessageLocation[] = [];
    const groups = groupByConnection(
      decoded.filter((item) => item.resource) as Array<{
        id: string;
        resource: OwnedResource;
      }>,
      (item) => item.resource.connection.id,
    );
    for (const items of groups.values()) {
      try {
        const provider = await this.providerFor(items[0].resource.connection);
        const result = await mutation(
          provider,
          items.map((item) => item.resource.nativeId),
        );
        applyMutationResult(items, result, succeeded, failed, previousLocations);
      } catch {
        failed.push(
          ...items.map((item) => ({
            id: item.id,
            reason: "Mail provider is unavailable",
          })),
        );
      }
    }
    return {
      succeeded,
      failed,
      ...(previousLocations.length ? { previousLocations } : {}),
    };
  }

  private async publicThread(
    connection: StoredMailConnection,
    thread: MailThread,
  ): Promise<MailThread> {
    const threadId = await encodeMailPublicId(this.options.config, {
      connectionId: connection.id,
      nativeId: thread.id,
      type: thread.folder === "drafts" ? "draft" : "thread",
    });
    const messages = await Promise.all(
      thread.messages.map((message) => this.publicMessage(connection, message)),
    );
    return {
      ...thread,
      id: threadId,
      provider: connection.provider,
      accountId: connection.id,
      messages,
    };
  }

  private async publicMessage(
    connection: StoredMailConnection,
    message: ThreadMessage,
  ): Promise<ThreadMessage> {
    const messageId = await encodeMailPublicId(this.options.config, {
      connectionId: connection.id,
      nativeId: message.id,
      type: "message",
    });
    const attachments = await Promise.all(
      message.attachments.map(async (attachment): Promise<MailAttachment> => {
        const attachmentId = await encodeMailPublicId(this.options.config, {
          connectionId: connection.id,
          nativeId: attachment.id,
          messageId: message.id,
          ...(attachment.sizeBytes !== undefined
            ? { sizeBytes: attachment.sizeBytes }
            : {}),
          type: "attachment",
        });
        return {
          ...attachment,
          id: attachmentId,
          contentBase64: undefined,
          downloadUrl: `/api/mail/attachment?id=${encodeURIComponent(attachmentId)}`,
        };
      }),
    );
    return {
      ...message,
      id: messageId,
      contentUrl: `/api/mail/content?id=${encodeURIComponent(messageId)}`,
      attachments,
    };
  }

  private async connectionsForScope(
    scope: "all" | ProviderSource,
    accountId?: string,
  ): Promise<StoredMailConnection[]> {
    if (accountId !== undefined) {
      if (scope === "all") {
        throw new TypeError("An account filter requires a provider scope");
      }
      const connection = await this.options.repository.findById(
        this.options.ownerId,
        accountId,
      );
      if (
        !connection ||
        connection.status !== "connected" ||
        !connection.credentials
      ) {
        throw new TypeError("Mail account filter is unavailable");
      }
      if (connection.provider !== scope) {
        throw new TypeError("Mail account filter does not match its provider");
      }
      return [connection];
    }
    const connections = await this.options.repository.listConnected(
      this.options.ownerId,
    );
    const scoped = connections.filter(
      (connection) => scope === "all" || connection.provider === scope,
    );
    if (scoped.length > maximumAggregateAccounts) {
      throw new TypeError(
        `The combined view supports at most ${maximumAggregateAccounts} accounts; select one mailbox`,
      );
    }
    return scoped;
  }

  private async requireConnection(id: string): Promise<StoredMailConnection> {
    const connection = await this.options.repository.findById(
      this.options.ownerId,
      id,
    );
    if (!connection || connection.status !== "connected" || !connection.credentials) {
      throw new Error("Mail connection is not available");
    }
    return connection;
  }

  private providerFor(connection: StoredMailConnection): Promise<MailProvider> {
    return this.options.resolveProvider(connection.provider, {
      accountId: connection.id,
      ownerId: this.options.ownerId,
    });
  }

  private async decodeOwnedId(
    publicId: string,
    allowedTypes: Array<OwnedResource["type"]>,
  ): Promise<OwnedResource | null> {
    const decoded = await decodeMailPublicId(this.options.config, publicId);
    if (!decoded || !allowedTypes.includes(decoded.type as OwnedResource["type"])) {
      return null;
    }
    const connection = await this.options.repository.findById(
      this.options.ownerId,
      decoded.connectionId,
    );
    if (!connection || connection.status !== "connected" || !connection.credentials) {
      return null;
    }
    return {
      connection,
      nativeId: decoded.nativeId,
      messageId: decoded.messageId,
      sizeBytes: decoded.sizeBytes,
      type: decoded.type as OwnedResource["type"],
    };
  }

}

interface AggregateAccountState {
  id: string;
  providerCursor: string | null;
  buffer: MailThread[];
  seenIds: string[];
  boundary: ThreadSortKey | null;
  endAfterBuffer: boolean;
  exhausted: boolean;
}

interface AggregateSessionState {
  version: 1;
  fingerprint: string;
  accounts: AggregateAccountState[];
  excluded: string[];
  lastPage?: AggregateLastPage;
}

interface LoadedAggregateAccount {
  account: AggregateAccountState;
  connection: StoredMailConnection;
  provider: MailProvider;
}

interface AggregateLastPage {
  inputRevision: number;
  page: MailMessagePage;
  hasMore: boolean;
}

interface ThreadSortKey {
  timestamp: number;
  id: string;
}

interface MailPaginationSessionLike {
  id: string;
  ownerId: string;
  queryFingerprint: string;
  revision: number;
  stateEnvelope: EncryptedSecretEnvelope;
}

interface MailPaginationRepositoryLike {
  create(input: {
    id?: string;
    ownerId: string;
    queryFingerprint: string;
    stateEnvelope: EncryptedSecretEnvelope;
    createdAt?: Date;
  }): Promise<MailPaginationSessionLike>;
  find(input: {
    id: string;
    ownerId: string;
    queryFingerprint: string;
    activeAt?: Date;
  }): Promise<MailPaginationSessionLike | null>;
  advance(input: {
    id: string;
    ownerId: string;
    queryFingerprint: string;
    expectedRevision: number;
    stateEnvelope: EncryptedSecretEnvelope;
    activeAt?: Date;
  }): Promise<MailPaginationSessionLike | null>;
}

interface MailDraftIntentRepositoryLike {
  find(input: {
    ownerId: string;
    connectionId: string;
    draftNativeId: string;
  }): Promise<MailDraftIntent | null>;
  replace(input: {
    ownerId: string;
    connectionId: string;
    previousDraftNativeId?: string;
    draftNativeId: string;
    mode: MailDraftIntentMode;
    sourceType: MailDraftIntentSourceType;
    sourceNativeId: string;
    updatedAt?: Date;
  }): Promise<MailDraftIntent>;
  delete(input: {
    ownerId: string;
    connectionId: string;
    draftNativeId: string;
  }): Promise<boolean>;
}

interface TrustedDraftIntent {
  mode: MailDraftIntentMode;
  sourceType: MailDraftIntentSourceType;
  sourceNativeId: string;
}

interface OwnedResource {
  connection: StoredMailConnection;
  nativeId: string;
  messageId?: string;
  sizeBytes?: number;
  type: "thread" | "message" | "attachment" | "draft";
}

function toMailAccount(connection: StoredMailConnection): MailAccount {
  const colors: Record<ProviderSource, string> = {
    gmail: "#d94a3a",
    outlook: "#2472c8",
    zoho: "#d18c21",
  };
  return {
    id: connection.id,
    provider: connection.provider,
    label: connection.label,
    address: connection.emailAddress,
    color: colors[connection.provider],
    connected: connection.status === "connected",
    capabilities: {
      labels: connection.provider === "gmail",
      reliableDraftUpdates: connection.provider !== "zoho",
      externalImages: connection.provider === "gmail",
      permanentDelete: false,
    },
  };
}

function requireStoredDraftIntent(
  intent: MailDraftIntent,
  ownerId: string,
  connectionId: string,
  draftNativeId: string,
): TrustedDraftIntent {
  if (
    intent.ownerId !== ownerId ||
    intent.connectionId !== connectionId ||
    intent.draftNativeId !== draftNativeId ||
    (intent.mode !== "reply" && intent.mode !== "forward") ||
    (intent.sourceType !== "thread" && intent.sourceType !== "message") ||
    !intent.sourceNativeId ||
    intent.sourceNativeId.length > 4_096
  ) {
    throw new Error("Stored mail draft intent is invalid");
  }
  return {
    mode: intent.mode,
    sourceType: intent.sourceType,
    sourceNativeId: intent.sourceNativeId,
  };
}

function sameDraftIntent(
  left: TrustedDraftIntent,
  right: TrustedDraftIntent,
): boolean {
  return (
    left.mode === right.mode &&
    left.sourceType === right.sourceType &&
    left.sourceNativeId === right.sourceNativeId
  );
}

function validateDraft(draft: MailDraft): void {
  if (!draft.accountId || draft.accountId.length > 128) {
    throw new TypeError("Draft account is invalid");
  }
  if (draft.subject.length > 998 || draft.body.length > 1_000_000) {
    throw new TypeError("Draft content is too large");
  }
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
  if (recipients.length > 200 || recipients.some((value) => value.length > 320)) {
    throw new TypeError("Draft recipients are invalid");
  }
  if (draft.attachments.length > 10) {
    throw new TypeError("Too many attachments");
  }
  let totalBytes = 0;
  for (const attachment of draft.attachments) {
    if (!attachment.contentBase64) continue;
    if (
      attachment.contentBase64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        attachment.contentBase64,
      )
    ) {
      throw new TypeError("Attachment content is invalid");
    }
    totalBytes += decodedBase64ByteLength(attachment.contentBase64);
  }
  if (totalBytes > maximumAttachmentBytes) {
    throw new TypeError("Attachments are too large");
  }
}

function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function messageTimestamp(thread: MailThread): number {
  if (!Number.isSafeInteger(thread.receivedAtMs)) {
    throw new Error("Mail message timestamp is invalid");
  }
  return thread.receivedAtMs;
}

async function aggregateQueryFingerprint(
  query: MessageQuery,
  pageSize: number,
  connectionIds: readonly string[],
): Promise<string> {
  return sha256Base64Url(
    JSON.stringify({
      version: 3,
      scope: query.scope,
      accountId: query.accountId ?? null,
      folder: query.folder,
      search: query.search?.trim() ?? "",
      pageSize,
      connectionIds,
    }),
  );
}

function compareAggregateThreads(
  left: LoadedAggregateAccount,
  right: LoadedAggregateAccount,
): number {
  return compareThreadValues(
    left.connection.id,
    left.account.buffer[0],
    right.connection.id,
    right.account.buffer[0],
  );
}

function threadSortKey(thread: MailThread): ThreadSortKey {
  return { timestamp: messageTimestamp(thread), id: thread.id };
}

function compareThreadSortKeys(left: ThreadSortKey, right: ThreadSortKey): number {
  const timestamp = right.timestamp - left.timestamp;
  return timestamp || left.id.localeCompare(right.id);
}

function compareThreadValues(
  leftConnectionId: string,
  left: MailThread,
  rightConnectionId: string,
  right: MailThread,
): number {
  const timestamp = messageTimestamp(right) - messageTimestamp(left);
  if (timestamp !== 0) return timestamp;
  const connection = leftConnectionId.localeCompare(rightConnectionId);
  if (connection !== 0) return connection;
  return left.id.localeCompare(right.id);
}

function parseAggregateSessionState(
  value: unknown,
  expectedFingerprint: string,
  availableConnectionIds: ReadonlySet<string>,
): AggregateSessionState {
  if (!isRecord(value)) throw new Error("Mail pagination state is invalid");
  if (
    value.version !== 1 ||
    value.fingerprint !== expectedFingerprint ||
    !Array.isArray(value.accounts) ||
    value.accounts.length < 1 ||
    value.accounts.length > maximumAggregateAccounts ||
    !Array.isArray(value.excluded) ||
    value.excluded.length > maximumAggregateAccounts
  ) {
    throw new Error("Mail pagination state is invalid");
  }
  const covered = new Set<string>();
  const accounts = value.accounts.map((candidate): AggregateAccountState => {
    if (!isRecord(candidate)) throw new Error("Mail pagination account is invalid");
    const id = candidate.id;
    if (
      typeof id !== "string" ||
      !availableConnectionIds.has(id) ||
      covered.has(id) ||
      (candidate.providerCursor !== null &&
        (typeof candidate.providerCursor !== "string" ||
          !candidate.providerCursor ||
          candidate.providerCursor.length > 8_192)) ||
      !Array.isArray(candidate.buffer) ||
      candidate.buffer.length > aggregateProviderChunkSize ||
      !Array.isArray(candidate.seenIds) ||
      candidate.seenIds.length > maximumAggregateSeenIds ||
      typeof candidate.endAfterBuffer !== "boolean" ||
      typeof candidate.exhausted !== "boolean"
    ) {
      throw new Error("Mail pagination account is invalid");
    }
    const seenIds = candidate.seenIds.map((seenId) => {
      if (typeof seenId !== "string" || !seenId || seenId.length > 4_096) {
        throw new Error("Mail pagination history is invalid");
      }
      return seenId;
    });
    if (new Set(seenIds).size !== seenIds.length) {
      throw new Error("Mail pagination history is invalid");
    }
    const buffer = candidate.buffer.map((thread) =>
      requireStoredThread(thread, "Mail pagination buffer"),
    );
    if (
      buffer.some(({ id: threadId }) => !seenIds.includes(threadId)) ||
      (candidate.exhausted && buffer.length > 0)
    ) {
      throw new Error("Mail pagination buffer is invalid");
    }
    let boundary: ThreadSortKey | null = null;
    if (candidate.boundary !== null) {
      if (
        !isRecord(candidate.boundary) ||
        typeof candidate.boundary.timestamp !== "number" ||
        !Number.isSafeInteger(candidate.boundary.timestamp) ||
        typeof candidate.boundary.id !== "string" ||
        !candidate.boundary.id ||
        candidate.boundary.id.length > 4_096
      ) {
        throw new Error("Mail pagination boundary is invalid");
      }
      boundary = {
        timestamp: candidate.boundary.timestamp,
        id: candidate.boundary.id,
      };
    }
    covered.add(id);
    return {
      id,
      providerCursor: candidate.providerCursor as string | null,
      buffer,
      seenIds,
      boundary,
      endAfterBuffer: candidate.endAfterBuffer,
      exhausted: candidate.exhausted,
    };
  });
  const excluded = value.excluded.map((id) => {
    if (
      typeof id !== "string" ||
      !availableConnectionIds.has(id) ||
      covered.has(id)
    ) {
      throw new Error("Mail pagination exclusion is invalid");
    }
    covered.add(id);
    return id;
  });
  if (covered.size !== availableConnectionIds.size) {
    throw new Error("Mail pagination account set changed");
  }
  const state: AggregateSessionState = {
    version: 1,
    fingerprint: expectedFingerprint,
    accounts,
    excluded,
  };
  if (value.lastPage !== undefined) {
    if (
      !isRecord(value.lastPage) ||
      !Number.isSafeInteger(value.lastPage.inputRevision) ||
      (value.lastPage.inputRevision as number) < 0 ||
      typeof value.lastPage.hasMore !== "boolean" ||
      !isRecord(value.lastPage.page) ||
      !Array.isArray(value.lastPage.page.messages) ||
      value.lastPage.page.messages.length > 100
    ) {
      throw new Error("Mail pagination replay is invalid");
    }
    const page: MailMessagePage = {
      messages: value.lastPage.page.messages.map((thread) =>
        requireStoredThread(thread, "Mail pagination replay"),
      ),
    };
    if (value.lastPage.page.partial !== undefined) {
      if (typeof value.lastPage.page.partial !== "boolean") {
        throw new Error("Mail pagination replay is invalid");
      }
      page.partial = value.lastPage.page.partial;
    }
    if (value.lastPage.page.accountErrors !== undefined) {
      if (
        !Array.isArray(value.lastPage.page.accountErrors) ||
        value.lastPage.page.accountErrors.length > maximumAggregateAccounts
      ) {
        throw new Error("Mail pagination replay is invalid");
      }
      page.accountErrors = value.lastPage.page.accountErrors.map((error) => {
        if (
          !isRecord(error) ||
          typeof error.accountId !== "string" ||
          !availableConnectionIds.has(error.accountId) ||
          error.code !== "provider_unavailable"
        ) {
          throw new Error("Mail pagination replay is invalid");
        }
        return {
          accountId: error.accountId,
          code: "provider_unavailable" as const,
        };
      });
    }
    state.lastPage = {
      inputRevision: value.lastPage.inputRevision as number,
      page,
      hasMore: value.lastPage.hasMore,
    };
  }
  return state;
}

function requireStoredThread(value: unknown, field: string): MailThread {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 24_000 ||
    typeof value.accountId !== "string" ||
    typeof value.receivedAtFull !== "string" ||
    typeof value.receivedAtMs !== "number" ||
    !Number.isSafeInteger(value.receivedAtMs) ||
    !Array.isArray(value.messages)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return value as unknown as MailThread;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function groupByConnection<T>(
  items: T[],
  key: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    groups.set(value, [...(groups.get(value) ?? []), item]);
  }
  return groups;
}

function applyMutationResult<T extends { resource: OwnedResource }>(
  items: Array<T & ({ id: string } | { location: MessageLocation })>,
  result: OperationResult,
  succeeded: string[],
  failed: OperationResult["failed"],
  previousLocations: MessageLocation[] = [],
): void {
  const byNativeId = new Map(
    items.map((item) => [item.resource.nativeId, publicIdForMutationItem(item)]),
  );
  for (const nativeId of result.succeeded) {
    const publicId = byNativeId.get(nativeId);
    if (publicId) succeeded.push(publicId);
  }
  for (const failure of result.failed) {
    const publicId = byNativeId.get(failure.id);
    if (publicId) failed.push({ id: publicId, reason: failure.reason });
  }
  for (const location of result.previousLocations ?? []) {
    const publicId = byNativeId.get(location.id);
    if (publicId) previousLocations.push({ id: publicId, folder: location.folder });
  }
}

function publicIdForMutationItem(
  item: { id: string } | { location: MessageLocation },
): string {
  return "id" in item ? item.id : item.location.id;
}
