import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const accountId = "11111111-1111-4111-8111-111111111111";
const config = {
  sessionSecret: "s".repeat(64),
  tokenEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  previousTokenEncryptionKeys: new Map(),
};
const connection = {
  id: accountId,
  ownerId,
  provider: "gmail",
  status: "connected",
  credentials: { ciphertext: "encrypted" },
};

let vite;
let MailService;
let encodeMailPublicId;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    root: projectRoot,
    plugins: [
      {
        name: "test-server-only-boundary",
        enforce: "pre",
        resolveId(id) {
          return id === "server-only" ? "\0test-server-only" : null;
        },
        load(id) {
          return id === "\0test-server-only" ? "export {};" : null;
        },
      },
    ],
    resolve: { alias: { "@": projectRoot } },
    ssr: { noExternal: ["server-only"] },
    server: { middlewareMode: true, hmr: false },
  });
  [{ MailService }, { encodeMailPublicId }] = await Promise.all([
    vite.ssrLoadModule("/src/server/mail/mail-service.ts"),
    vite.ssrLoadModule("/src/server/mail/public-id.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

function createFixture(sizeBytes = 1_024) {
  const writes = [];
  const provider = {
    async getDraft(id) {
      assert.equal(id, "native-draft");
      return {
        id,
        accountId,
        to: ["reader@example.test"],
        cc: ["copy@example.test"],
        bcc: [],
        subject: "Saved subject",
        body: "Saved body",
        attachments: [
          {
            id: "native-attachment",
            sourceMessageId: "native-message",
            name: "notes.txt",
            size: `${sizeBytes} bytes`,
            sizeBytes,
            mimeType: "text/plain",
            kind: "document",
          },
        ],
      };
    },
    async saveDraft(draft) {
      writes.push({ operation: "save", draft });
      return { id: draft.id, savedAt: "2026-08-18T12:00:00.000Z" };
    },
    async sendMessage(draft) {
      writes.push({ operation: "send", draft });
      return { id: "native-sent" };
    },
  };
  const repository = {
    async listConnected() {
      return [connection];
    },
    async findById(requestedOwnerId, requestedId) {
      return requestedOwnerId === ownerId && requestedId === accountId
        ? connection
        : null;
    },
  };
  return {
    writes,
    service: new MailService({
      config,
      ownerId,
      repository,
      resolveProvider: async () => provider,
    }),
  };
}

async function publicDraftId() {
  return encodeMailPublicId(config, {
    connectionId: accountId,
    nativeId: "native-draft",
    type: "draft",
  });
}

test("a provider draft round-trips through opaque attachment IDs", async () => {
  const fixture = createFixture();
  const id = await publicDraftId();
  const draft = await fixture.service.getDraft(id);

  assert.equal(draft.id, id);
  assert.equal(draft.accountId, accountId);
  assert.notEqual(draft.attachments[0].id, "native-attachment");
  assert.equal("sourceMessageId" in draft.attachments[0], false);
  assert.equal("contentBase64" in draft.attachments[0], false);
  assert.match(draft.attachments[0].downloadUrl, /^\/api\/mail\/attachment\?id=/u);

  await fixture.service.saveDraft({ ...draft, body: "Edited body" });
  await fixture.service.sendMessage({ ...draft, subject: "Ready to send" });
  assert.deepEqual(
    fixture.writes.map(({ operation }) => operation),
    ["save", "send"],
  );
  for (const { draft: nativeDraft } of fixture.writes) {
    assert.equal(nativeDraft.id, "native-draft");
    assert.equal(nativeDraft.attachments[0].id, "native-attachment");
    assert.equal(
      nativeDraft.attachments[0].sourceMessageId,
      "native-message",
    );
    assert.equal(nativeDraft.attachments[0].contentBase64, undefined);
    assert.equal(nativeDraft.attachments[0].downloadUrl, undefined);
  }
});

test("the signed provider size prevents a client from hiding an oversized draft", async () => {
  const fixture = createFixture(6 * 1_024 * 1_024);
  const draft = await fixture.service.getDraft(await publicDraftId());
  draft.attachments[0].sizeBytes = 1;
  await assert.rejects(
    fixture.service.saveDraft(draft),
    /Attachments are too large/u,
  );
  assert.equal(fixture.writes.length, 0);
});

test("a signed message id cannot be used as a draft id", async () => {
  const fixture = createFixture();
  const messageId = await encodeMailPublicId(config, {
    connectionId: accountId,
    nativeId: "native-message",
    type: "thread",
  });
  await assert.rejects(
    fixture.service.saveDraft({
      id: messageId,
      accountId,
      to: ["reader@example.test"],
      cc: [],
      bcc: [],
      subject: "Not a draft",
      body: "This must not patch a normal message.",
      attachments: [],
    }),
    /Draft and sender account do not match/u,
  );
  assert.equal(fixture.writes.length, 0);
});

function createIntentFixture({ replaceNativeId = false, throwDelete = false } = {}) {
  const intents = new Map();
  const drafts = new Map();
  const writes = [];
  let draftSequence = 0;
  const intentRepository = {
    async find({ ownerId: requestedOwner, connectionId, draftNativeId }) {
      assert.equal(requestedOwner, ownerId);
      assert.equal(connectionId, accountId);
      return intents.get(draftNativeId) ?? null;
    },
    async replace(input) {
      assert.equal(input.ownerId, ownerId);
      assert.equal(input.connectionId, accountId);
      const now = new Date("2026-08-18T12:00:00.000Z");
      const record = {
        ownerId,
        connectionId: accountId,
        draftNativeId: input.draftNativeId,
        mode: input.mode,
        sourceType: input.sourceType,
        sourceNativeId: input.sourceNativeId,
        createdAt: now,
        updatedAt: now,
      };
      intents.set(input.draftNativeId, record);
      if (
        input.previousDraftNativeId &&
        input.previousDraftNativeId !== input.draftNativeId
      ) {
        intents.delete(input.previousDraftNativeId);
      }
      return record;
    },
    async delete({ ownerId: requestedOwner, connectionId, draftNativeId }) {
      assert.equal(requestedOwner, ownerId);
      assert.equal(connectionId, accountId);
      if (throwDelete) throw new Error("intent cleanup unavailable");
      return intents.delete(draftNativeId);
    },
  };
  const provider = {
    async getDraft(id) {
      const draft = drafts.get(id);
      return draft ? structuredClone(draft) : null;
    },
    async saveDraft(draft) {
      assert.equal(draft.composeIntent, undefined);
      const nextId =
        replaceNativeId || !draft.id
          ? `native-intent-draft-${++draftSequence}`
          : draft.id;
      if (draft.id && draft.id !== nextId) drafts.delete(draft.id);
      drafts.set(nextId, structuredClone({ ...draft, id: nextId }));
      writes.push({ operation: "save", draft: structuredClone(draft), nextId });
      return { id: nextId, savedAt: "2026-08-18T12:00:00.000Z" };
    },
    async sendMessage(draft) {
      writes.push({ operation: "send", draft: structuredClone(draft) });
      return { id: "plain-native-sent" };
    },
    async replyMessage(id, draft) {
      writes.push({ operation: "reply", id, draft: structuredClone(draft) });
      if (draft.id) drafts.delete(draft.id);
      return { id: "reply-native-sent" };
    },
    async forwardMessage(id, draft) {
      writes.push({ operation: "forward", id, draft: structuredClone(draft) });
      if (draft.id) drafts.delete(draft.id);
      return { id: "forward-native-sent" };
    },
  };
  const repository = {
    async listConnected() {
      return [connection];
    },
    async findById(requestedOwnerId, requestedId) {
      return requestedOwnerId === ownerId && requestedId === accountId
        ? connection
        : null;
    },
  };
  const createService = () =>
    new MailService({
      config,
      ownerId,
      repository,
      draftIntentRepository: intentRepository,
      resolveProvider: async () => provider,
    });
  return { createService, drafts, intents, writes };
}

async function publicSourceId(nativeId = "native-source") {
  return encodeMailPublicId(config, {
    connectionId: accountId,
    nativeId,
    type: "message",
  });
}

function unsavedIntentDraft(mode, sourceId) {
  return {
    accountId,
    to: ["reader@example.test"],
    cc: [],
    bcc: [],
    subject: mode === "reply" ? "Re: Saved semantics" : "Fwd: Saved semantics",
    body: "This compose window will be closed and reopened.",
    attachments: [],
    composeIntent: { mode, sourceId },
  };
}

test("reply intent survives a cross-request save, load and send", async () => {
  const fixture = createIntentFixture();
  const sourceId = await publicSourceId();
  const saved = await fixture
    .createService()
    .saveDraft(unsavedIntentDraft("reply", sourceId));

  assert.equal(fixture.intents.size, 1);
  assert.equal([...fixture.intents.values()][0].sourceNativeId, "native-source");
  const reopened = await fixture.createService().getDraft(saved.id);
  assert.equal(reopened.composeIntent.mode, "reply");
  assert.equal(reopened.composeIntent.sourceId, sourceId);

  await fixture
    .createService()
    .replyMessage(reopened.composeIntent.sourceId, reopened);
  const reply = fixture.writes.find(({ operation }) => operation === "reply");
  assert.equal(reply.id, "native-source");
  assert.equal(reply.draft.composeIntent, undefined);
  assert.equal(fixture.intents.size, 0);
});

test("stored forward intent cannot be downgraded by omitting the client field", async () => {
  const fixture = createIntentFixture({ replaceNativeId: true });
  const firstSave = await fixture
    .createService()
    .saveDraft(unsavedIntentDraft("forward", await publicSourceId()));
  const firstReopen = await fixture.createService().getDraft(firstSave.id);
  const secondSave = await fixture.createService().saveDraft({
    ...firstReopen,
    body: "Edited after reopening the provider draft.",
  });
  assert.notEqual(secondSave.id, firstSave.id);
  assert.equal(fixture.intents.size, 1);
  assert.equal(
    await fixture.createService().getDraft(firstSave.id),
    null,
  );
  const reopened = await fixture.createService().getDraft(secondSave.id);

  await fixture.createService().sendMessage({
    ...reopened,
    composeIntent: undefined,
  });

  assert.equal(
    fixture.writes.some(({ operation }) => operation === "send"),
    false,
  );
  const forwarded = fixture.writes.find(
    ({ operation }) => operation === "forward",
  );
  assert.equal(forwarded.id, "native-source");
  assert.equal(fixture.intents.size, 0);
});

test("a signed but different source cannot replace a stored compose intent", async () => {
  const fixture = createIntentFixture();
  const saved = await fixture
    .createService()
    .saveDraft(unsavedIntentDraft("reply", await publicSourceId()));
  const reopened = await fixture.createService().getDraft(saved.id);
  reopened.composeIntent.sourceId = await publicSourceId("different-source");

  await assert.rejects(
    fixture.createService().saveDraft(reopened),
    /does not match its saved state/u,
  );
  assert.equal(
    fixture.writes.filter(({ operation }) => operation === "save").length,
    1,
  );
});

test("provider-side draft deletion cleans up its persisted intent", async () => {
  const fixture = createIntentFixture();
  const saved = await fixture
    .createService()
    .saveDraft(unsavedIntentDraft("reply", await publicSourceId()));
  fixture.drafts.clear();

  assert.equal(await fixture.createService().getDraft(saved.id), null);
  assert.equal(fixture.intents.size, 0);
});

test("intent cleanup failure never turns a successful provider send into a retry", async () => {
  const fixture = createIntentFixture({ throwDelete: true });
  const saved = await fixture
    .createService()
    .saveDraft(unsavedIntentDraft("reply", await publicSourceId()));
  const reopened = await fixture.createService().getDraft(saved.id);

  const sent = await fixture
    .createService()
    .replyMessage(reopened.composeIntent.sourceId, reopened);
  assert.match(sent.id, /\./u);
  assert.equal(
    fixture.writes.filter(({ operation }) => operation === "reply").length,
    1,
  );
});

test("ordinary drafts never acquire a reply or forward intent", async () => {
  const fixture = createIntentFixture();
  const saved = await fixture.createService().saveDraft({
    ...unsavedIntentDraft("reply", await publicSourceId()),
    composeIntent: undefined,
  });
  const reopened = await fixture.createService().getDraft(saved.id);
  assert.equal(reopened.composeIntent, undefined);
  assert.equal(fixture.intents.size, 0);
});
