import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const connectionId = "11111111-1111-4111-8111-111111111111";
const updatedAt = new Date("2026-08-18T12:00:00.000Z");
let MailDraftIntentRepository;
let vite;

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
    ssr: { noExternal: ["server-only"] },
    server: { middlewareMode: true, hmr: false },
  });
  ({ MailDraftIntentRepository } = await vite.ssrLoadModule(
    "/src/server/mail/draft-intent-repository.ts",
  ));
});

after(async () => {
  await vite?.close();
});

function row(overrides = {}) {
  return {
    owner_id: ownerId,
    connection_id: connectionId,
    draft_native_id: "draft-new",
    mode: "reply",
    source_type: "message",
    source_native_id: "source-native",
    created_at: updatedAt,
    updated_at: updatedAt,
    ...overrides,
  };
}

test("find binds a draft intent to owner, connection, native draft and active connection", async () => {
  const calls = [];
  const repository = new MailDraftIntentRepository({
    query: async (statement, parameters) => {
      calls.push({ statement, parameters });
      return [row()];
    },
  });

  const intent = await repository.find({
    ownerId,
    connectionId,
    draftNativeId: "draft-new",
  });

  assert.equal(intent?.mode, "reply");
  assert.equal(intent?.sourceNativeId, "source-native");
  assert.match(calls[0].statement, /intent\.owner_id = \$1/u);
  assert.match(calls[0].statement, /intent\.connection_id = \$2/u);
  assert.match(calls[0].statement, /intent\.draft_native_id = \$3/u);
  assert.match(calls[0].statement, /connection\.status = 'connected'/u);
  assert.deepEqual(calls[0].parameters, [ownerId, connectionId, "draft-new"]);
});

test("replace upserts the new native draft and removes the previous ID atomically", async () => {
  const calls = [];
  const repository = new MailDraftIntentRepository({
    query: async (statement, parameters) => {
      calls.push({ statement, parameters });
      return [row({ mode: "forward", source_type: "thread" })];
    },
  });

  const intent = await repository.replace({
    ownerId,
    connectionId,
    previousDraftNativeId: "draft-old",
    draftNativeId: "draft-new",
    mode: "forward",
    sourceType: "thread",
    sourceNativeId: "source-native",
    updatedAt,
  });

  assert.equal(intent.mode, "forward");
  assert.match(calls[0].statement, /WITH eligible_connection AS/u);
  assert.match(calls[0].statement, /owner_id = \$1/u);
  assert.match(calls[0].statement, /id = \$2/u);
  assert.match(calls[0].statement, /ON CONFLICT \(owner_id, connection_id, draft_native_id\)/u);
  assert.match(calls[0].statement, /removed_previous AS/u);
  assert.match(calls[0].statement, /previous\.draft_native_id = \$3/u);
  assert.match(calls[0].statement, /previous\.draft_native_id <> \$4/u);
  assert.match(calls[0].statement, /EXISTS \(SELECT 1 FROM saved\)/u);
  assert.deepEqual(calls[0].parameters, [
    ownerId,
    connectionId,
    "draft-old",
    "draft-new",
    "forward",
    "thread",
    "source-native",
    updatedAt,
  ]);
});

test("delete cannot cross owner or connection boundaries", async () => {
  const calls = [];
  const repository = new MailDraftIntentRepository({
    query: async (statement, parameters) => {
      calls.push({ statement, parameters });
      return [{ draft_native_id: "draft-new" }];
    },
  });
  assert.equal(
    await repository.delete({ ownerId, connectionId, draftNativeId: "draft-new" }),
    true,
  );
  assert.match(calls[0].statement, /owner_id = \$1/u);
  assert.match(calls[0].statement, /connection_id = \$2/u);
  assert.match(calls[0].statement, /draft_native_id = \$3/u);
});

test("migration enforces owner/connection binding and stores only native server metadata", async () => {
  const migration = await readFile(
    resolve(projectRoot, "db/migrations/0004_mail_draft_intents.sql"),
    "utf8",
  );
  assert.match(migration, /UNIQUE \(id, owner_id\)/u);
  assert.match(migration, /PRIMARY KEY \(owner_id, connection_id, draft_native_id\)/u);
  assert.match(
    migration,
    /FOREIGN KEY \(connection_id, owner_id\)[\s\S]*REFERENCES mail_connections\(id, owner_id\)/u,
  );
  assert.match(migration, /mode IN \('reply', 'forward'\)/u);
  assert.match(migration, /source_type IN \('thread', 'message'\)/u);
  assert.doesNotMatch(migration, /public_id|compose_intent|JSONB/iu);
});
