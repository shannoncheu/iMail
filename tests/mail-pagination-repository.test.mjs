import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownerId = "22222222-2222-4222-8222-222222222222";
const paginationId = "77777777-7777-4777-8777-777777777777";
const queryFingerprint = "q".repeat(43);
const createdAt = new Date("2026-08-18T12:00:00.000Z");
const expiresAt = new Date("2026-08-18T12:15:00.000Z");
const activeAt = new Date("2026-08-18T12:05:00.000Z");
const ciphertext = Uint8Array.from({ length: 48 }, (_, index) => index + 1);
const iv = Uint8Array.from({ length: 12 }, (_, index) => 100 + index);
const envelope = {
  algorithm: "A256GCM",
  ciphertext: Buffer.from(ciphertext).toString("base64url"),
  iv: Buffer.from(iv).toString("base64url"),
  keyVersion: 3,
};

let MailPaginationRepository;
let MAIL_PAGINATION_SESSION_TTL_MS;
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
  ({ MailPaginationRepository, MAIL_PAGINATION_SESSION_TTL_MS } =
    await vite.ssrLoadModule(
      "/src/server/mail/pagination-repository.ts",
    ));
});

after(async () => {
  await vite?.close();
});

function paginationRow(overrides = {}) {
  return {
    id: paginationId,
    owner_id: ownerId,
    query_fingerprint: queryFingerprint,
    revision: "0",
    state_ciphertext: ciphertext,
    state_iv: iv,
    state_key_version: "3",
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: expiresAt,
    ...overrides,
  };
}

test("creates an owner-bound encrypted pagination session with a fixed 15-minute TTL", async () => {
  const calls = [];
  const repository = new MailPaginationRepository({
    query: async (statement, parameters) => {
      calls.push({ statement, parameters });
      return [paginationRow()];
    },
  });

  const session = await repository.create({
    id: paginationId,
    ownerId,
    queryFingerprint,
    stateEnvelope: envelope,
    createdAt,
  });

  assert.equal(MAIL_PAGINATION_SESSION_TTL_MS, 15 * 60 * 1_000);
  assert.equal(session.id, paginationId);
  assert.equal(session.ownerId, ownerId);
  assert.equal(session.revision, 0);
  assert.deepEqual(session.stateEnvelope, envelope);
  assert.equal(session.expiresAt.getTime() - session.createdAt.getTime(), 900_000);
  assert.match(calls[0].statement, /INSERT INTO mail_pagination_sessions/u);
  assert.match(calls[0].statement, /SELECT \$1, owner\.id, \$3, 0/u);
  assert.match(calls[0].statement, /owner\.disabled_at IS NULL/u);
  assert.doesNotMatch(calls[0].statement, /state(?:_json|_plaintext)/iu);
  assert.deepEqual(calls[0].parameters, [
    paginationId,
    ownerId,
    queryFingerprint,
    ciphertext,
    iv,
    3,
    createdAt,
    expiresAt,
  ]);
  assert.equal(calls[0].parameters.includes("unencrypted-pagination-state"), false);
});

test("find is owner/query-bound and rejects expired rows at the supplied activeAt", async () => {
  const calls = [];
  const repository = new MailPaginationRepository({
    query: async (statement, parameters) => {
      calls.push({ statement, parameters });
      return parameters[3] >= expiresAt ? [] : [paginationRow()];
    },
  });

  const session = await repository.find({
    ownerId,
    id: paginationId,
    queryFingerprint,
    activeAt,
  });

  assert.equal(session?.queryFingerprint, queryFingerprint);
  assert.deepEqual(session?.stateEnvelope, envelope);
  assert.match(calls[0].statement, /session\.owner_id = \$1/u);
  assert.match(calls[0].statement, /session\.id = \$2/u);
  assert.match(calls[0].statement, /session\.query_fingerprint = \$3/u);
  assert.match(calls[0].statement, /session\.expires_at > \$4/u);
  assert.match(calls[0].statement, /session\.expires_at > CURRENT_TIMESTAMP/u);
  assert.match(calls[0].statement, /owner\.disabled_at IS NULL/u);
  assert.deepEqual(calls[0].parameters, [
    ownerId,
    paginationId,
    queryFingerprint,
    activeAt,
  ]);

  assert.equal(
    await repository.find({
      ownerId,
      id: paginationId,
      queryFingerprint,
      activeAt: expiresAt,
    }),
    null,
  );
});

test("advance uses owner/query/revision CAS, filters expiry, and never extends the TTL", async () => {
  const calls = [];
  let returnWinner = true;
  const nextCiphertext = Uint8Array.from(
    { length: 64 },
    (_, index) => 200 - index,
  );
  const nextIv = Uint8Array.from({ length: 12 }, (_, index) => 20 + index);
  const nextEnvelope = {
    algorithm: "A256GCM",
    ciphertext: Buffer.from(nextCiphertext).toString("base64url"),
    iv: Buffer.from(nextIv).toString("base64url"),
    keyVersion: 4,
  };
  const repository = new MailPaginationRepository({
    query: async (statement, parameters) => {
      calls.push({ statement, parameters });
      return returnWinner
        ? [
            paginationRow({
              revision: "5",
              state_ciphertext: nextCiphertext,
              state_iv: nextIv,
              state_key_version: "4",
              updated_at: activeAt,
            }),
          ]
        : [];
    },
  });

  const advanced = await repository.advance({
    ownerId,
    id: paginationId,
    queryFingerprint,
    expectedRevision: 4,
    stateEnvelope: nextEnvelope,
    activeAt,
  });

  assert.equal(advanced?.revision, 5);
  assert.equal(advanced?.expiresAt.toISOString(), expiresAt.toISOString());
  assert.deepEqual(advanced?.stateEnvelope, nextEnvelope);
  assert.match(calls[0].statement, /revision = session\.revision \+ 1/u);
  assert.match(calls[0].statement, /session\.revision = \$4/u);
  assert.match(calls[0].statement, /session\.expires_at > \$8/u);
  assert.match(calls[0].statement, /session\.expires_at > CURRENT_TIMESTAMP/u);
  assert.match(calls[0].statement, /owner\.id = session\.owner_id/u);
  assert.match(calls[0].statement, /owner\.disabled_at IS NULL/u);
  assert.doesNotMatch(calls[0].statement, /SET[\s\S]*expires_at\s*=/u);
  assert.deepEqual(calls[0].parameters, [
    ownerId,
    paginationId,
    queryFingerprint,
    4,
    nextCiphertext,
    nextIv,
    4,
    activeAt,
  ]);

  returnWinner = false;
  const loser = await repository.advance({
    ownerId,
    id: paginationId,
    queryFingerprint,
    expectedRevision: 4,
    stateEnvelope: nextEnvelope,
    activeAt,
  });
  assert.equal(loser, null);
});

test("delete cannot cross the owner boundary", async () => {
  const calls = [];
  const repository = new MailPaginationRepository({
    query: async (statement, parameters) => {
      calls.push({ statement, parameters });
      return [{ id: paginationId }];
    },
  });

  assert.equal(await repository.delete({ ownerId, id: paginationId }), true);
  assert.match(calls[0].statement, /WHERE owner_id = \$1 AND id = \$2/u);
  assert.deepEqual(calls[0].parameters, [ownerId, paginationId]);
});

test("pagination migration stores only bounded ciphertext and indexes owner/expiry cleanup", async () => {
  const migration = await readFile(
    resolve(projectRoot, "db/migrations/0003_mail_pagination_sessions.sql"),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS mail_pagination_sessions/u);
  assert.match(migration, /owner_id UUID NOT NULL REFERENCES owners\(id\)/u);
  assert.match(migration, /query_fingerprint ~ '\^\[A-Za-z0-9_-\]\{43\}\$'/u);
  assert.match(migration, /octet_length\(state_ciphertext\) BETWEEN 16 AND 524304/u);
  assert.match(migration, /octet_length\(state_iv\) = 12/u);
  assert.match(migration, /expires_at = created_at \+ INTERVAL '15 minutes'/u);
  assert.match(migration, /mail_pagination_sessions_owner_active_idx/u);
  assert.match(migration, /mail_pagination_sessions_expires_at_idx/u);
  assert.doesNotMatch(migration, /state_(?:json|plaintext)|JSONB/iu);
});
