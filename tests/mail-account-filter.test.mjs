import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const firstGmailId = "11111111-1111-4111-8111-111111111111";
const secondGmailId = "22222222-2222-4222-8222-222222222222";
const outlookId = "33333333-3333-4333-8333-333333333333";
const foreignAccountId = "44444444-4444-4444-8444-444444444444";

let vite;
let MailService;
let mailScopeQuerySchema;

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
  [{ MailService }, { mailScopeQuerySchema }] = await Promise.all([
    vite.ssrLoadModule("/src/server/mail/mail-service.ts"),
    vite.ssrLoadModule("/src/server/mail/api-schemas.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

function connection(id, provider) {
  return {
    id,
    ownerId,
    provider,
    status: "connected",
    credentials: { accessToken: `${id}-token` },
  };
}

function createFixture() {
  const connections = [
    connection(firstGmailId, "gmail"),
    connection(secondGmailId, "gmail"),
    connection(outlookId, "outlook"),
  ];
  const resolutions = [];
  const folderReads = [];
  const messageReads = [];
  const repository = {
    async listConnected(requestedOwnerId) {
      return requestedOwnerId === ownerId ? connections : [];
    },
    async findById(requestedOwnerId, accountId) {
      if (requestedOwnerId !== ownerId) return null;
      return connections.find((candidate) => candidate.id === accountId) ?? null;
    },
  };
  const resolveProvider = async (provider, context) => {
    resolutions.push({ provider, ...context });
    return {
      async getFolders(scope) {
        folderReads.push({ accountId: context.accountId, scope });
        return [{ id: "inbox", label: "Inbox", count: 1 }];
      },
      async getMessagesPage(query) {
        messageReads.push({ accountId: context.accountId, query });
        return { messages: [] };
      },
    };
  };
  return {
    folderReads,
    messageReads,
    resolutions,
    service: new MailService({
      config: {},
      ownerId,
      repository,
      resolveProvider,
    }),
  };
}

test("All aggregates connections while an account filter selects one same-provider account", async () => {
  const fixture = createFixture();

  assert.deepEqual(await fixture.service.getFolders("all"), [
    { id: "inbox", label: "Inbox", count: 3 },
  ]);
  assert.deepEqual(
    fixture.folderReads.map(({ accountId }) => accountId),
    [firstGmailId, secondGmailId, outlookId],
  );

  fixture.folderReads.length = 0;
  assert.deepEqual(
    await fixture.service.getFolders("gmail", secondGmailId),
    [{ id: "inbox", label: "Inbox", count: 1 }],
  );
  assert.deepEqual(fixture.folderReads, [
    { accountId: secondGmailId, scope: "gmail" },
  ]);

  await fixture.service.getMessagesPage({
    scope: "gmail",
    accountId: secondGmailId,
    folder: "inbox",
  });
  assert.equal(fixture.messageReads.length, 1);
  assert.equal(fixture.messageReads[0].accountId, secondGmailId);
  assert.equal(fixture.messageReads[0].query.scope, "gmail");
  assert.equal(fixture.messageReads[0].query.accountId, undefined);
  assert.equal(fixture.resolutions.at(-1).accountId, secondGmailId);
  assert.equal(fixture.resolutions.at(-1).provider, "gmail");
  assert.equal(fixture.resolutions.at(-1).ownerId, ownerId);
});

test("account filters reject All, provider mismatches, and accounts outside the owner", async () => {
  const { service, resolutions } = createFixture();

  await assert.rejects(
    service.getFolders("all", firstGmailId),
    /account filter requires a provider scope/u,
  );
  await assert.rejects(
    service.getMessagesPage({
      scope: "outlook",
      accountId: firstGmailId,
      folder: "inbox",
    }),
    /does not match its provider/u,
  );
  await assert.rejects(
    service.getMessagesPage({
      scope: "gmail",
      accountId: foreignAccountId,
      folder: "inbox",
    }),
    /account filter is unavailable/u,
  );
  assert.equal(resolutions.length, 0);
});

test("the shared BFF scope schema rejects account filters without a provider", () => {
  assert.deepEqual(mailScopeQuerySchema.parse({ scope: "all" }), {
    scope: "all",
  });
  assert.deepEqual(
    mailScopeQuerySchema.parse({ scope: "gmail", accountId: firstGmailId }),
    { scope: "gmail", accountId: firstGmailId },
  );
  assert.throws(
    () =>
      mailScopeQuerySchema.parse({ scope: "all", accountId: firstGmailId }),
    /account filter requires a provider scope/u,
  );
});
