import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const accountA = "11111111-1111-4111-8111-111111111111";
const accountB = "22222222-2222-4222-8222-222222222222";
const config = {
  sessionSecret: "s".repeat(64),
  tokenEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  tokenEncryptionKeyVersion: 1,
  previousTokenEncryptionKeys: new Map(),
};

let vite;
let MailService;

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
  ({ MailService } = await vite.ssrLoadModule(
    "/src/server/mail/mail-service.ts",
  ));
});

after(async () => {
  await vite?.close();
});

function connection(id, provider = "gmail") {
  return {
    id,
    ownerId,
    provider,
    status: "connected",
    credentials: { ciphertext: "encrypted" },
  };
}

function message(accountId, id, timestamp) {
  const receivedAtMs = timestamp * 1_000;
  const displayDate = new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(receivedAtMs));
  return {
    id,
    provider: "gmail",
    accountId,
    folder: "inbox",
    sender: { name: "Sender", email: "sender@example.test" },
    subject: id,
    preview: id,
    receivedAt: displayDate,
    receivedAtFull: displayDate,
    receivedAtMs,
    unread: false,
    starred: false,
    labels: [],
    hasExternalImages: false,
    messages: [],
  };
}

function createFixture({ connections, datasets, shouldFail = () => false }) {
  const reads = [];
  const sessions = new Map();
  const repository = {
    async listConnected(requestedOwnerId) {
      return requestedOwnerId === ownerId ? connections : [];
    },
    async findById(requestedOwnerId, id) {
      if (requestedOwnerId !== ownerId) return null;
      return connections.find((candidate) => candidate.id === id) ?? null;
    },
  };
  const resolveProvider = async (_provider, context) => ({
    async getMessagesPage(query) {
      const start = query.cursor ? Number(query.cursor) : 0;
      reads.push({ accountId: context.accountId, start, query });
      if (shouldFail({ accountId: context.accountId, start, query })) {
        throw new Error("provider unavailable");
      }
      const values = datasets.get(context.accountId) ?? [];
      const end = Math.min(values.length, start + query.pageSize);
      return {
        messages: values.slice(start, end),
        ...(end < values.length ? { nextCursor: String(end) } : {}),
      };
    },
  });
  const paginationRepository = {
    async create(input) {
      const session = {
        id: input.id ?? crypto.randomUUID(),
        ownerId: input.ownerId,
        queryFingerprint: input.queryFingerprint,
        revision: 0,
        stateEnvelope: input.stateEnvelope,
      };
      sessions.set(session.id, session);
      return session;
    },
    async find(input) {
      const session = sessions.get(input.id);
      return session?.ownerId === input.ownerId &&
        session.queryFingerprint === input.queryFingerprint
        ? { ...session }
        : null;
    },
    async advance(input) {
      const session = sessions.get(input.id);
      if (
        !session ||
        session.ownerId !== input.ownerId ||
        session.queryFingerprint !== input.queryFingerprint ||
        session.revision !== input.expectedRevision
      ) {
        return null;
      }
      const advanced = {
        ...session,
        revision: session.revision + 1,
        stateEnvelope: input.stateEnvelope,
      };
      sessions.set(session.id, advanced);
      return { ...advanced };
    },
  };
  return {
    reads,
    service: new MailService({
      config,
      ownerId,
      repository,
      paginationRepository,
      resolveProvider,
    }),
  };
}

test("combined pages stay globally ordered, bounded, and duplicate-free", async () => {
  const connections = [connection(accountA), connection(accountB, "outlook")];
  const expected = [
    message(accountA, "a-100", 100),
    message(accountB, "b-95", 95),
    message(accountA, "a-90", 90),
    message(accountB, "b-85", 85),
    message(accountA, "a-80", 80),
    message(accountB, "b-75", 75),
    message(accountA, "a-70", 70),
    message(accountB, "b-65", 65),
    message(accountA, "a-60", 60),
    message(accountB, "b-55", 55),
  ];
  const fixture = createFixture({
    connections,
    datasets: new Map([
      [accountA, expected.filter(({ accountId }) => accountId === accountA)],
      [accountB, expected.filter(({ accountId }) => accountId === accountB)],
    ]),
  });
  const actual = [];
  let cursor;
  do {
    const page = await fixture.service.getMessagesPage({
      scope: "all",
      folder: "inbox",
      pageSize: 3,
      ...(cursor ? { cursor } : {}),
    });
    assert.ok(page.messages.length <= 3);
    actual.push(...page.messages.map(({ subject }) => subject));
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual(actual, expected.map(({ subject }) => subject));
  assert.equal(new Set(actual).size, actual.length);
});

test("aggregate ordering ignores real provider display dates", async () => {
  const gmailOlder = message(accountA, "gmail-older", 100);
  const outlookNewer = message(accountB, "outlook-newer", 200);
  assert.equal(Number.isNaN(Date.parse(gmailOlder.receivedAtFull)), true);
  assert.equal(Number.isNaN(Date.parse(outlookNewer.receivedAtFull)), true);
  const fixture = createFixture({
    connections: [connection(accountA), connection(accountB, "outlook")],
    datasets: new Map([
      [accountA, [gmailOlder]],
      [accountB, [outlookNewer]],
    ]),
  });

  const page = await fixture.service.getMessagesPage({
    scope: "all",
    folder: "inbox",
    pageSize: 2,
  });
  assert.deepEqual(page.messages.map(({ subject }) => subject), [
    "outlook-newer",
    "gmail-older",
  ]);
});

test("an invalid provider timestamp fails closed without hiding healthy mail", async () => {
  const invalid = message(accountA, "invalid", 200);
  invalid.receivedAtMs = 1.5;
  const fixture = createFixture({
    connections: [connection(accountA), connection(accountB, "outlook")],
    datasets: new Map([
      [accountA, [invalid]],
      [accountB, [message(accountB, "healthy", 100)]],
    ]),
  });

  const page = await fixture.service.getMessagesPage({
    scope: "all",
    folder: "inbox",
    pageSize: 2,
  });
  assert.deepEqual(page.messages.map(({ subject }) => subject), ["healthy"]);
  assert.equal(page.partial, true);
  assert.deepEqual(page.accountErrors, [
    { accountId: accountA, code: "provider_unavailable" },
  ]);
});

test("one account can replay and continue full fifty-message pages", async () => {
  const messages = Array.from({ length: 120 }, (_, index) =>
    message(accountA, `single-${index}`, 1_000 - index),
  );
  const fixture = createFixture({
    connections: [connection(accountA)],
    datasets: new Map([[accountA, messages]]),
  });
  const subjects = [];
  let cursor;
  do {
    const page = await fixture.service.getMessagesPage({
      scope: "gmail",
      accountId: accountA,
      folder: "inbox",
      pageSize: 50,
      ...(cursor ? { cursor } : {}),
    });
    assert.ok(page.messages.length <= 50);
    subjects.push(...page.messages.map(({ subject }) => subject));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(subjects, messages.map(({ subject }) => subject));
});

test("a pagination session can traverse more than one thousand messages", async () => {
  const messages = Array.from({ length: 1_025 }, (_, index) =>
    message(accountA, `history-${index}`, 10_000 - index),
  );
  const fixture = createFixture({
    connections: [connection(accountA)],
    datasets: new Map([[accountA, messages]]),
  });
  const subjects = [];
  let cursor;
  do {
    const page = await fixture.service.getMessagesPage({
      scope: "gmail",
      accountId: accountA,
      folder: "inbox",
      pageSize: 100,
      ...(cursor ? { cursor } : {}),
    });
    subjects.push(...page.messages.map(({ subject }) => subject));
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual(subjects, messages.map(({ subject }) => subject));
  assert.equal(new Set(subjects).size, messages.length);
});

test("aggregate cursors are bound to their query", async () => {
  const fixture = createFixture({
    connections: [connection(accountA), connection(accountB)],
    datasets: new Map([
      [accountA, [message(accountA, "a-2", 2), message(accountA, "a-1", 1)]],
      [accountB, [message(accountB, "b-3", 3)]],
    ]),
  });
  const first = await fixture.service.getMessagesPage({
    scope: "all",
    folder: "inbox",
    pageSize: 1,
  });
  assert.ok(first.nextCursor);
  await assert.rejects(
    fixture.service.getMessagesPage({
      scope: "all",
      folder: "trash",
      pageSize: 1,
      cursor: first.nextCursor,
    }),
    /Invalid mail cursor/u,
  );
});

test("an initial provider failure returns an explicit healthy partial page", async () => {
  const fixture = createFixture({
    connections: [connection(accountA), connection(accountB)],
    datasets: new Map([
      [accountA, [message(accountA, "a", 10)]],
      [
        accountB,
        [message(accountB, "b-2", 9), message(accountB, "b-1", 8)],
      ],
    ]),
    shouldFail: ({ accountId: id }) => id === accountA,
  });
  const page = await fixture.service.getMessagesPage({
    scope: "all",
    folder: "inbox",
    pageSize: 1,
  });
  assert.equal(page.partial, true);
  assert.deepEqual(page.accountErrors, [
    { accountId: accountA, code: "provider_unavailable" },
  ]);
  assert.deepEqual(page.messages.map(({ subject }) => subject), ["b-2"]);
  assert.ok(page.nextCursor);
  const next = await fixture.service.getMessagesPage({
    scope: "all",
    folder: "inbox",
    pageSize: 1,
    cursor: page.nextCursor,
  });
  assert.deepEqual(next.messages.map(({ subject }) => subject), ["b-1"]);
  assert.equal(next.partial, true);
});

test("buffered results survive live provider insertions and deletions", async () => {
  const a = [message(accountA, "a-100", 100), message(accountA, "a-80", 80)];
  const b = [message(accountB, "b-90", 90), message(accountB, "b-70", 70)];
  const fixture = createFixture({
    connections: [connection(accountA), connection(accountB)],
    datasets: new Map([
      [accountA, a],
      [accountB, b],
    ]),
  });
  const first = await fixture.service.getMessagesPage({
    scope: "all",
    folder: "inbox",
    pageSize: 2,
  });
  a.unshift(message(accountA, "new-after-page-one", 110));
  a.splice(
    a.findIndex(({ id }) => id === "a-80"),
    1,
  );
  const second = await fixture.service.getMessagesPage({
    scope: "all",
    folder: "inbox",
    pageSize: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    [...first.messages, ...second.messages].map(({ subject }) => subject),
    ["a-100", "b-90", "a-80", "b-70"],
  );
});

test("replaying or concurrently consuming one cursor returns one stable page", async () => {
  const fixture = createFixture({
    connections: [connection(accountA), connection(accountB)],
    datasets: new Map([
      [
        accountA,
        [
          message(accountA, "a-6", 6),
          message(accountA, "a-4", 4),
          message(accountA, "a-2", 2),
        ],
      ],
      [
        accountB,
        [
          message(accountB, "b-5", 5),
          message(accountB, "b-3", 3),
          message(accountB, "b-1", 1),
        ],
      ],
    ]),
  });
  const first = await fixture.service.getMessagesPage({
    scope: "all",
    folder: "inbox",
    pageSize: 2,
  });
  const request = {
    scope: "all",
    folder: "inbox",
    pageSize: 2,
    cursor: first.nextCursor,
  };
  const [winner, concurrentReplay] = await Promise.all([
    fixture.service.getMessagesPage(request),
    fixture.service.getMessagesPage(request),
  ]);
  const laterReplay = await fixture.service.getMessagesPage(request);
  assert.deepEqual(concurrentReplay, winner);
  assert.deepEqual(laterReplay, winner);
});

test("a refill failure returns only the proven prefix and can be retried", async () => {
  let failRefill = true;
  const accountAMessages = Array.from({ length: 15 }, (_, index) =>
    message(accountA, `a-${index}`, 200 - index),
  );
  const accountBMessages = Array.from({ length: 10 }, (_, index) =>
    message(accountB, `b-${index}`, 100 - index),
  );
  const fixture = createFixture({
    connections: [connection(accountA), connection(accountB)],
    datasets: new Map([
      [accountA, accountAMessages],
      [accountB, accountBMessages],
    ]),
    shouldFail: ({ accountId: id, start }) =>
      failRefill && id === accountA && start === 10,
  });
  const first = await fixture.service.getMessagesPage({
    scope: "all",
    folder: "inbox",
    pageSize: 25,
  });
  assert.equal(first.messages.length, 10);
  assert.equal(first.partial, true);
  assert.ok(first.nextCursor);
  failRefill = false;
  const second = await fixture.service.getMessagesPage({
    scope: "all",
    folder: "inbox",
    pageSize: 25,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    [...first.messages, ...second.messages].map(({ subject }) => subject),
    [...accountAMessages, ...accountBMessages].map(({ subject }) => subject),
  );
});

test("more than five combined accounts fail before any provider read", async () => {
  const connections = Array.from({ length: 6 }, (_, index) =>
    connection(`${index + 1}0000000-0000-4000-8000-000000000000`),
  );
  const fixture = createFixture({ connections, datasets: new Map() });
  await assert.rejects(
    fixture.service.getMessagesPage({ scope: "all", folder: "inbox" }),
    /at most 5 accounts/u,
  );
  assert.equal(fixture.reads.length, 0);
});

test("search is bounded to the common provider limit", async () => {
  const fixture = createFixture({
    connections: [connection(accountA)],
    datasets: new Map([[accountA, []]]),
  });
  await assert.rejects(
    fixture.service.getMessagesPage({
      scope: "gmail",
      accountId: accountA,
      folder: "inbox",
      search: "x".repeat(257),
    }),
    /limited to 256 characters/u,
  );
  assert.equal(fixture.reads.length, 0);
});
