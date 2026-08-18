import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const now = new Date("2026-08-18T12:00:00.000Z");
const ownerId = "22222222-2222-4222-8222-222222222222";
const connectionId = "11111111-1111-4111-8111-111111111111";
const sessionId = "33333333-3333-4333-8333-333333333333";
let MailConnectionRepository;
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
  ({ MailConnectionRepository } = await vite.ssrLoadModule(
    "/src/server/mail/connection-repository.ts",
  ));
});

after(async () => {
  await vite?.close();
});

function connectionRow(overrides = {}) {
  return {
    id: connectionId,
    owner_id: ownerId,
    provider: "gmail",
    provider_account_id: "provider-account",
    email_address: "owner@example.test",
    label: "Owner Mail",
    status: "connected",
    scopes: ["mail"],
    credentials_ciphertext: Uint8Array.from({ length: 32 }, (_, index) => index),
    credentials_iv: Uint8Array.from({ length: 12 }, (_, index) => index + 1),
    credentials_key_version: 2,
    access_expires_at: new Date(now.getTime() + 3_600_000),
    token_version: 3,
    provider_metadata: { picture: null },
    last_error_code: null,
    created_at: now,
    updated_at: now,
    connected_at: now,
    last_refreshed_at: now,
    disconnected_at: null,
    ...overrides,
  };
}

function oauthRow(overrides = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    owner_id: ownerId,
    session_id: sessionId,
    provider: "gmail",
    state_digest: "s".repeat(43),
    browser_binding_digest: "b".repeat(43),
    code_verifier_ciphertext: "c".repeat(64),
    code_verifier_iv: "i".repeat(16),
    code_verifier_key_version: 2,
    redirect_uri: "https://mail.example.test/api/mail/connect/gmail/callback",
    return_to: "/",
    created_at: now,
    expires_at: new Date(now.getTime() + 600_000),
    ...overrides,
  };
}

test("mail OAuth repository binds encrypted state to the active owner session", async () => {
  const calls = [];
  const repository = new MailConnectionRepository({
    query: async (statement, parameters) => {
      calls.push({ statement, parameters });
      return [oauthRow()];
    },
  });
  const envelope = {
    algorithm: "A256GCM",
    ciphertext: Buffer.alloc(32, 9).toString("base64url"),
    iv: Buffer.alloc(12, 8).toString("base64url"),
    keyVersion: 2,
  };
  const created = await repository.createOAuthTransaction({
    id: oauthRow().id,
    ownerId,
    sessionId,
    provider: "gmail",
    stateDigest: "s".repeat(43),
    browserBindingDigest: "b".repeat(43),
    codeVerifierEnvelope: envelope,
    redirectUri: oauthRow().redirect_uri,
    returnTo: "/",
    createdAt: now,
    expiresAt: oauthRow().expires_at,
  });

  assert.equal(created.codeVerifierEnvelope.keyVersion, 2);
  assert.match(calls[0].statement, /JOIN owners AS owner/u);
  assert.match(calls[0].statement, /session\.revoked_at IS NULL/u);
  assert.doesNotMatch(calls[0].statement, /code_verifier\s+TEXT/iu);
  assert.equal(calls[0].parameters.includes("raw-pkce-verifier"), false);

  calls.length = 0;
  await repository.consumeOAuthTransaction({
    provider: "gmail",
    stateDigest: "s".repeat(43),
    browserBindingDigest: "b".repeat(43),
    consumedAt: now,
  });
  assert.match(calls[0].statement, /DELETE FROM mail_oauth_transactions/u);
  assert.match(calls[0].statement, /browser_binding_digest = \$3/u);
  assert.match(calls[0].statement, /session\.expires_at > \$4/u);
});

test("connection updates are owner-bound, optimistic, and preserve pending revocations", async () => {
  const calls = [];
  const repository = new MailConnectionRepository({
    query: async (statement, parameters) => {
      calls.push({ statement, parameters });
      if (/WITH candidates AS/u.test(statement)) {
        return [connectionRow({
          status: "error",
          last_error_code: "revocation_in_progress",
          token_version: "4",
        })];
      }
      if (/SET status = 'error',\s*last_error_code = 'revocation_in_progress'/u.test(statement)) {
        return [connectionRow({
          status: "error",
          last_error_code: "revocation_in_progress",
          token_version: "4",
        })];
      }
      if (/SET refresh_lease_id = \$4/u.test(statement)) {
        return [connectionRow()];
      }
      if (/refresh_lease_id = \$11/u.test(statement)) {
        return [];
      }
      if (/RETURNING id/u.test(statement)) return [{ id: connectionId }];
      return [connectionRow()];
    },
  });

  const connected = await repository.findById(ownerId, connectionId);
  assert.equal(connected.ownerId, ownerId);
  assert.equal(connected.credentials.keyVersion, 2);
  assert.deepEqual(connected.providerMetadata, { picture: null });
  assert.match(calls.at(-1).statement, /WHERE owner_id = \$1 AND id = \$2/u);

  const pending = await repository.claimRevocationPending(10);
  assert.equal(pending[0].lastErrorCode, "revocation_in_progress");
  assert.match(calls.at(-1).statement, /credentials_ciphertext IS NOT NULL/u);
  assert.match(calls.at(-1).statement, /FOR UPDATE SKIP LOCKED/u);
  assert.match(calls.at(-1).statement, /INTERVAL '10 minutes'/u);
  assert.match(calls.at(-1).statement, /token_version = connection\.token_version \+ 1/u);
  assert.deepEqual(calls.at(-1).parameters, [10]);

  const update = await repository.updateCredentials({
    id: connectionId,
    ownerId,
    expectedTokenVersion: 3,
    refreshLeaseId: "55555555-5555-4555-8555-555555555555",
    credentials: {
      algorithm: "A256GCM",
      ciphertext: Buffer.alloc(32, 3).toString("base64url"),
      iv: Buffer.alloc(12, 4).toString("base64url"),
      keyVersion: 4,
    },
    scopes: ["mail"],
    accessExpiresAt: new Date(now.getTime() + 3_600_000),
    providerMetadata: {},
    refreshedAt: now,
  });
  assert.equal(update, null, "an optimistic loser must not overwrite the winner");
  assert.match(calls.at(-1).statement, /AND token_version = \$3/u);
  assert.match(calls.at(-1).statement, /AND status = 'connected'/u);
  assert.match(calls.at(-1).statement, /AND refresh_lease_id = \$11/u);

  const lease = await repository.acquireRefreshLease({
    id: connectionId,
    ownerId,
    expectedTokenVersion: 3,
    leaseId: "55555555-5555-4555-8555-555555555555",
  });
  assert.equal(lease.id, connectionId);
  assert.match(calls.at(-1).statement, /INTERVAL '45 seconds'/u);
  assert.match(calls.at(-1).statement, /refresh_lease_expires_at <= CURRENT_TIMESTAMP/u);

  const claimed = await repository.claimConnectionForRevocation(
    ownerId,
    connectionId,
    3,
  );
  assert.equal(claimed.status, "error");
  assert.equal(claimed.lastErrorCode, "revocation_in_progress");
  assert.equal(claimed.tokenVersion, 4);
  assert.match(calls.at(-1).statement, /credentials_ciphertext IS NOT NULL/u);
  assert.match(calls.at(-1).statement, /updated_at = CURRENT_TIMESTAMP/u);
  assert.match(calls.at(-1).statement, /token_version = token_version \+ 1/u);
  assert.deepEqual(calls.at(-1).parameters, [ownerId, connectionId, 3]);

  assert.equal(
    await repository.releaseRevocationClaim(ownerId, connectionId, 3),
    true,
  );
  assert.match(calls.at(-1).statement, /SET last_error_code = 'revocation_pending'/u);
  assert.match(calls.at(-1).statement, /last_error_code = 'revocation_in_progress'/u);
  assert.match(calls.at(-1).statement, /updated_at = CURRENT_TIMESTAMP/u);
  assert.match(calls.at(-1).statement, /AND token_version = \$3/u);
  assert.deepEqual(calls.at(-1).parameters, [ownerId, connectionId, 3]);

  assert.equal(
    await repository.finalizeRevocationClaim(ownerId, connectionId, 3),
    true,
  );
  assert.match(calls.at(-1).statement, /credentials_ciphertext = NULL/u);
  assert.match(calls.at(-1).statement, /last_error_code = 'revocation_in_progress'/u);
  assert.match(calls.at(-1).statement, /disconnected_at = CURRENT_TIMESTAMP/u);
  assert.deepEqual(calls.at(-1).parameters, [ownerId, connectionId, 3]);
});

test("a reconnect cannot replace credentials while revocation is pending", async () => {
  let statement = "";
  const credentials = {
    algorithm: "A256GCM",
    ciphertext: Buffer.alloc(32, 3).toString("base64url"),
    iv: Buffer.alloc(12, 4).toString("base64url"),
    keyVersion: 2,
  };
  const repository = new MailConnectionRepository({
    query: async (value) => {
      statement = value;
      return [];
    },
  });
  await assert.rejects(
    repository.upsertConnection({
      id: connectionId,
      ownerId,
      provider: "gmail",
      providerAccountId: "provider-account",
      emailAddress: "owner@example.test",
      label: "Mail",
      scopes: ["mail"],
      credentials,
      connectedAt: now,
    }),
    /not saved/u,
  );
  assert.match(statement, /ON CONFLICT \(owner_id, provider, provider_account_id\)/u);
  assert.match(statement, /WHERE NOT \(/u);
  assert.match(statement, /'revocation_pending'/u);
  assert.match(statement, /'revocation_in_progress'/u);
  assert.match(statement, /mail_connections\.token_version = \$16/u);
});

test("runtime migration adds mail OAuth, rate limits, refresh metadata, and cleanup indexes", async () => {
  const migration = await readFile(
    resolve(projectRoot, "db/migrations/0002_mail_runtime.sql"),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS mail_oauth_transactions/u);
  assert.match(migration, /browser_binding_digest/u);
  assert.match(migration, /code_verifier_ciphertext/u);
  assert.doesNotMatch(migration, /code_verifier\s+TEXT/iu);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rate_limit_buckets/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS token_version/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS refresh_lease_id UUID/u);
  assert.match(migration, /sessions_expires_at_idx/u);
});
