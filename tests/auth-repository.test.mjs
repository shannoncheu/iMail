import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let AuthRepository;
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
    resolve: { alias: { "@": projectRoot } },
    ssr: { noExternal: ["server-only"] },
    server: { middlewareMode: true, hmr: false },
  });
  ({ AuthRepository } = await vite.ssrLoadModule(
    "/src/server/auth/repository.ts",
  ));
});

after(async () => {
  await vite?.close();
});

test("OAuth transactions write only digests and an encrypted verifier envelope", async () => {
  let captured;
  const now = new Date("2026-08-18T00:00:00.000Z");
  const expiresAt = new Date("2026-08-18T00:10:00.000Z");
  const query = async (statement, parameters) => {
    captured = { statement, parameters };
    return [
      {
        id: "00000000-0000-4000-8000-000000000001",
        provider: "github",
        state_digest: "s".repeat(43),
        browser_binding_digest: "b".repeat(43),
        code_verifier_ciphertext: "c".repeat(80),
        code_verifier_iv: "i".repeat(16),
        code_verifier_key_version: 1,
        redirect_uri: "https://mail.example.test/api/auth/github/callback",
        return_to: "/",
        created_at: now,
        expires_at: expiresAt,
      },
    ];
  };
  const repository = new AuthRepository({ query });
  const transaction = await repository.createOAuthTransaction({
    id: "00000000-0000-4000-8000-000000000001",
    provider: "github",
    stateDigest: "s".repeat(43),
    browserBindingDigest: "b".repeat(43),
    codeVerifierEnvelope: {
      algorithm: "A256GCM",
      ciphertext: "c".repeat(80),
      iv: "i".repeat(16),
      keyVersion: 1,
    },
    redirectUri: "https://mail.example.test/api/auth/github/callback",
    returnTo: "/",
    createdAt: now,
    expiresAt,
  });

  assert.equal(transaction.codeVerifierEnvelope.algorithm, "A256GCM");
  assert.match(captured.statement, /browser_binding_digest/);
  assert.match(captured.statement, /code_verifier_ciphertext/);
  assert.doesNotMatch(captured.statement, /\bcode_verifier\s+TEXT\b/i);
  assert.equal(captured.parameters.includes("v".repeat(43)), false);
});

test("OAuth consumption is one-time and bound to both state and browser", async () => {
  let captured;
  const query = async (statement, parameters) => {
    captured = { statement, parameters };
    return [];
  };
  const repository = new AuthRepository({ query });
  const result = await repository.consumeOAuthTransaction({
    provider: "github",
    stateDigest: "state-digest",
    browserBindingDigest: "browser-digest",
    consumedAt: new Date("2026-08-18T00:05:00.000Z"),
  });

  assert.equal(result, null);
  assert.match(captured.statement, /DELETE FROM oauth_transactions/);
  assert.match(captured.statement, /browser_binding_digest = \$3/);
  assert.deepEqual(captured.parameters.slice(0, 3), [
    "github",
    "state-digest",
    "browser-digest",
  ]);
});

test("owner identity upsert modifies the singleton owner only once", async () => {
  let statement;
  const now = new Date("2026-08-18T00:00:00.000Z");
  const repository = new AuthRepository({
    query: async (value) => {
      statement = value;
      return [
        {
          owner_id: "00000000-0000-4000-8000-000000000010",
          owner_display_name: "Owner Name",
          owner_created_at: now,
          owner_updated_at: now,
          owner_last_authenticated_at: now,
          owner_disabled_at: null,
          identity_id: "00000000-0000-4000-8000-000000000011",
          identity_provider: "github",
          identity_provider_subject: "123456",
          identity_provider_username: "owner-name",
          identity_email: null,
          identity_avatar_url: null,
          identity_created_at: now,
          identity_updated_at: now,
          identity_last_verified_at: now,
        },
      ];
    },
  });

  const result = await repository.upsertOwnerIdentity({
    provider: "github",
    providerSubject: "123456",
    providerUsername: "owner-name",
    displayName: "Owner Name",
    verifiedAt: now,
  });

  assert.equal(result.owner.displayName, "Owner Name");
  assert.match(statement, /ON CONFLICT \(singleton\) DO UPDATE SET\s+display_name/s);
  assert.match(statement, /FROM ensured_owner AS owner/);
  assert.doesNotMatch(statement, /UPDATE owners AS owner/);
});

test("mail OAuth rechecks the transaction session against its current GitHub identity", async () => {
  let captured;
  const activeAt = new Date("2026-08-18T00:05:00.000Z");
  const repository = new AuthRepository({
    query: async (statement, parameters) => {
      captured = { statement, parameters };
      return [{ id: "33333333-3333-4333-8333-333333333333" }];
    },
  });

  assert.equal(
    await repository.isOwnerSessionAuthorizedForGithubIds({
      sessionId: "33333333-3333-4333-8333-333333333333",
      ownerId: "22222222-2222-4222-8222-222222222222",
      allowedGithubIds: ["1", "2"],
      activeAt,
    }),
    true,
  );
  assert.match(captured.statement, /identity\.id = session\.identity_id/u);
  assert.match(captured.statement, /identity\.owner_id = session\.owner_id/u);
  assert.match(captured.statement, /identity\.provider = 'github'/u);
  assert.match(
    captured.statement,
    /identity\.provider_subject = ANY\(\$3::text\[\]\)/u,
  );
  assert.match(captured.statement, /session\.revoked_at IS NULL/u);
  assert.match(captured.statement, /owner\.disabled_at IS NULL/u);
  assert.deepEqual(captured.parameters, [
    "33333333-3333-4333-8333-333333333333",
    "22222222-2222-4222-8222-222222222222",
    ["1", "2"],
    activeAt,
  ]);
});

test("safe mail connection queries never select credential columns", async () => {
  let statement;
  const repository = new AuthRepository({
    query: async (value) => {
      statement = value;
      return [];
    },
  });
  assert.deepEqual(await repository.listSafeMailConnections("owner-id"), []);
  assert.doesNotMatch(statement, /credentials_(ciphertext|iv|key_version)/i);
});

test("the migration enforces a singleton owner and never stores raw OAuth verifier", async () => {
  const migration = await readFile(
    resolve(projectRoot, "db/migrations/0001_auth_foundation.sql"),
    "utf8",
  );
  assert.match(migration, /CONSTRAINT owners_singleton_unique/);
  assert.match(migration, /code_verifier_ciphertext TEXT NOT NULL/);
  assert.match(migration, /browser_binding_digest TEXT NOT NULL/);
  assert.match(migration, /CONSTRAINT sessions_identity_owner_fk/);
  assert.match(migration, /FOREIGN KEY \(identity_id, owner_id\)/);
  assert.doesNotMatch(migration, /\bcode_verifier TEXT\b/i);
  assert.doesNotMatch(migration, /\btoken\s+TEXT\b/i);
});
