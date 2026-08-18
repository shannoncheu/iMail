import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const now = new Date("2026-08-18T10:00:00.000Z");

let vite;
let createProductionMailProvider;
let MailConnectionUnavailableError;

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
  ({ createProductionMailProvider, MailConnectionUnavailableError } =
    await vite.ssrLoadModule("/src/server/mail/provider-factory.ts"));
});

after(async () => {
  await vite?.close();
});

const authConfig = {
  appUrl: new URL("https://mail.example.test"),
  databaseUrl: "postgres://example.test/mail",
  sessionSecret: "s".repeat(32),
  tokenEncryptionKey: "a".repeat(43),
  github: {
    clientId: "github-client",
    clientSecret: "g".repeat(20),
    allowedIds: new Set(["1"]),
    callbackUrl: "https://mail.example.test/api/auth/github/callback",
  },
};

const providerConfigs = {
  gmail: {
    provider: "gmail",
    clientId: "gmail-client",
    clientSecret: "gmail-secret",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    callbackUrl: "https://mail.example.test/api/mail/connect/gmail/callback",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    scopeSeparator: " ",
    authorizationParameters: {},
    apiBaseUrl: "https://gmail.googleapis.com/gmail/v1",
  },
  outlook: {
    provider: "outlook",
    clientId: "outlook-client",
    clientSecret: "outlook-secret",
    authorizationUrl:
      "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
    callbackUrl: "https://mail.example.test/api/mail/connect/outlook/callback",
    scopes: ["Mail.ReadWrite", "Mail.Send"],
    scopeSeparator: " ",
    authorizationParameters: {},
    apiBaseUrl: "https://graph.microsoft.com/v1.0",
  },
  zoho: {
    provider: "zoho",
    clientId: "zoho-client",
    clientSecret: "zoho-secret",
    authorizationUrl: "https://accounts.zoho.com/oauth/v2/auth",
    tokenUrl: "https://accounts.zoho.com/oauth/v2/token",
    callbackUrl: "https://mail.example.test/api/mail/connect/zoho/callback",
    scopes: ["ZohoMail.messages.ALL"],
    scopeSeparator: ",",
    authorizationParameters: {},
    apiBaseUrl: "https://mail.zoho.com/api",
  },
};

const context = { ownerId: "owner-1", accountId: "connection-1" };

function envelope(name = "stored") {
  return {
    algorithm: "A256GCM",
    ciphertext: name,
    iv: "iv",
    keyVersion: 1,
  };
}

function connection(provider, overrides = {}) {
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
  return {
    id: context.accountId,
    ownerId: context.ownerId,
    provider,
    providerAccountId: provider === "zoho" ? "123456" : `${provider}-subject`,
    emailAddress: `owner@${provider}.example.test`,
    label: `${provider} account`,
    status: "connected",
    scopes: [...providerConfigs[provider].scopes],
    credentials: envelope(),
    accessExpiresAt: expiresAt,
    tokenVersion: 1,
    providerMetadata: {},
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    connectedAt: now,
    lastRefreshedAt: now,
    disconnectedAt: null,
    ...overrides,
  };
}

function credential(provider, overrides = {}) {
  return {
    accessToken: `stored-${provider}-access-token`,
    refreshToken: `stored-${provider}-refresh-token`,
    tokenType: "Bearer",
    scopes: [...providerConfigs[provider].scopes],
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function dependencies({
  provider,
  storedConnection = connection(provider),
  storedCredential = credential(provider),
  repository,
  tokenVault,
  exchangeRefresh,
  fetchImplementation = async () => {
    throw new Error("Unexpected provider API request");
  },
} = {}) {
  return {
    authConfig,
    providerConfig: providerConfigs[provider],
    repository:
      repository ??
      {
        async findById() {
          return storedConnection;
        },
        async acquireRefreshLease() {
          throw new Error("Unexpected refresh lease acquisition");
        },
        async releaseRefreshLease() {
          return true;
        },
        async updateCredentials() {
          throw new Error("Unexpected credential update");
        },
      },
    tokenVault:
      tokenVault ??
      {
        async decrypt() {
          return storedCredential;
        },
        async encrypt() {
          return envelope("updated");
        },
      },
    exchangeRefresh:
      exchangeRefresh ??
      (async () => {
        throw new Error("Unexpected token refresh");
      }),
    fetchImplementation,
    now: () => now,
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("constructs each real adapter only from an owner-bound connected row", async () => {
  const expectedNames = {
    gmail: "GmailMailProvider",
    outlook: "OutlookMailProvider",
    zoho: "ZohoMailProvider",
  };
  for (const provider of Object.keys(expectedNames)) {
    const instance = await createProductionMailProvider(
      provider,
      context,
      dependencies({ provider }),
    );
    assert.equal(instance.constructor.name, expectedNames[provider]);
  }
});

test("missing, cross-owner, disconnected, and provider-mismatched rows fail alike", async () => {
  const unavailable = [
    null,
    connection("gmail", { ownerId: "another-owner" }),
    connection("gmail", { status: "disconnected", disconnectedAt: now }),
    connection("outlook"),
    connection("gmail", { credentials: null }),
  ];

  for (const storedConnection of unavailable) {
    await assert.rejects(
      createProductionMailProvider(
        "gmail",
        context,
        dependencies({ provider: "gmail", storedConnection }),
      ),
      (error) => {
        assert.ok(error instanceof MailConnectionUnavailableError);
        assert.equal(error.code, "MAIL_CONNECTION_UNAVAILABLE");
        assert.equal(error.message, "Mail connection is unavailable");
        return true;
      },
    );
  }
});

test("uses an unexpired decrypted token without refreshing it", async () => {
  const authorizations = [];
  const instance = await createProductionMailProvider(
    "gmail",
    context,
    dependencies({
      provider: "gmail",
      fetchImplementation: async (_input, init = {}) => {
        authorizations.push(new Headers(init.headers).get("authorization"));
        return json({ threads: [] });
      },
    }),
  );

  assert.deepEqual(
    await instance.getMessages({ scope: "gmail", folder: "inbox" }),
    [],
  );
  assert.deepEqual(authorizations, [
    "Bearer stored-gmail-access-token",
    "Bearer stored-gmail-access-token",
  ]);
});

test("refreshes sixty seconds early and persists the rotation optimistically", async () => {
  const expiringAt = new Date(now.getTime() + 59_000);
  const initial = connection("gmail", { accessExpiresAt: expiringAt });
  const encrypted = [];
  const updates = [];
  const refreshes = [];
  const authorizations = [];
  const refreshedExpiry = new Date(now.getTime() + 3_600_000);
  const instance = await createProductionMailProvider(
    "gmail",
    context,
    dependencies({
      provider: "gmail",
      storedConnection: initial,
      storedCredential: credential("gmail", {
        expiresAt: expiringAt.toISOString(),
      }),
      tokenVault: {
        async decrypt() {
          return credential("gmail", { expiresAt: expiringAt.toISOString() });
        },
        async encrypt(value, aad) {
          encrypted.push({ value, aad });
          return envelope("refreshed");
        },
      },
      repository: {
        async findById() {
          return initial;
        },
        async acquireRefreshLease() {
          return initial;
        },
        async releaseRefreshLease() {
          return true;
        },
        async updateCredentials(update) {
          updates.push(update);
          return connection("gmail", {
            credentials: envelope("refreshed"),
            tokenVersion: 2,
            accessExpiresAt: refreshedExpiry,
          });
        },
      },
      exchangeRefresh: async (input) => {
        refreshes.push(input);
        return {
          accessToken: "rotated-gmail-access-token",
          refreshToken: "rotated-gmail-refresh-token",
          scopes: [...providerConfigs.gmail.scopes],
          expiresAt: refreshedExpiry,
        };
      },
      fetchImplementation: async (_input, init = {}) => {
        authorizations.push(new Headers(init.headers).get("authorization"));
        return json({ threads: [] });
      },
    }),
  );

  await instance.getMessages({ scope: "gmail", folder: "inbox" });
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].refreshToken, "stored-gmail-refresh-token");
  assert.deepEqual(authorizations, [
    "Bearer rotated-gmail-access-token",
    "Bearer rotated-gmail-access-token",
  ]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].expectedTokenVersion, 1);
  assert.match(updates[0].refreshLeaseId, /^[0-9a-f-]{36}$/u);
  assert.equal(updates[0].ownerId, context.ownerId);
  assert.equal(updates[0].id, context.accountId);
  assert.equal(updates[0].credentials.ciphertext, "refreshed");
  assert.equal(encrypted[0].aad.connectionId, context.accountId);
  assert.equal(encrypted[0].aad.ownerId, context.ownerId);
  assert.equal(encrypted[0].aad.provider, "gmail");
});

test("a distributed refresh lease loser never exchanges and uses the winning token", async () => {
  const expiringAt = new Date(now.getTime() + 30_000);
  const initial = connection("gmail", {
    credentials: envelope("initial"),
    accessExpiresAt: expiringAt,
  });
  const winner = connection("gmail", {
    credentials: envelope("winner"),
    tokenVersion: 2,
    accessExpiresAt: new Date(now.getTime() + 3_600_000),
  });
  let reads = 0;
  let refreshes = 0;
  const authorizations = [];
  const instance = await createProductionMailProvider(
    "gmail",
    context,
    dependencies({
      provider: "gmail",
      repository: {
        async findById() {
          reads += 1;
          return reads <= 2 ? initial : winner;
        },
        async acquireRefreshLease() {
          return null;
        },
        async releaseRefreshLease() {
          throw new Error("A lease loser must not release another request's lease");
        },
        async updateCredentials() {
          throw new Error("A lease loser must not update credentials");
        },
      },
      tokenVault: {
        async decrypt(stored) {
          return stored.ciphertext === "winner"
            ? credential("gmail", { accessToken: "winning-access-token" })
            : credential("gmail", {
                accessToken: "losing-access-token",
                expiresAt: expiringAt.toISOString(),
              });
        },
        async encrypt() {
          throw new Error("A lease loser must not encrypt credentials");
        },
      },
      exchangeRefresh: async () => {
        refreshes += 1;
        return {
          accessToken: "discarded-access-token",
          refreshToken: "discarded-refresh-token",
          scopes: [...providerConfigs.gmail.scopes],
          expiresAt: new Date(now.getTime() + 3_600_000),
        };
      },
      fetchImplementation: async (_input, init = {}) => {
        authorizations.push(new Headers(init.headers).get("authorization"));
        return json({ threads: [] });
      },
    }),
  );

  await instance.getMessages({ scope: "gmail", folder: "inbox" });
  assert.equal(refreshes, 0);
  assert.equal(reads, 3);
  assert.deepEqual(authorizations, [
    "Bearer winning-access-token",
    "Bearer winning-access-token",
  ]);
});

test("Outlook retries one Graph 401 with a forced persisted refresh", async () => {
  const initial = connection("outlook");
  const authorizations = [];
  const updates = [];
  let refreshes = 0;
  const instance = await createProductionMailProvider(
    "outlook",
    context,
    dependencies({
      provider: "outlook",
      storedConnection: initial,
      repository: {
        async findById() {
          return initial;
        },
        async acquireRefreshLease() {
          return initial;
        },
        async releaseRefreshLease() {
          return true;
        },
        async updateCredentials(update) {
          updates.push(update);
          return connection("outlook", {
            credentials: envelope("outlook-refreshed"),
            tokenVersion: 2,
            accessExpiresAt: new Date(now.getTime() + 3_600_000),
          });
        },
      },
      exchangeRefresh: async () => {
        refreshes += 1;
        return {
          accessToken: "rotated-outlook-access-token",
          refreshToken: "rotated-outlook-refresh-token",
          scopes: [...providerConfigs.outlook.scopes],
          expiresAt: new Date(now.getTime() + 3_600_000),
        };
      },
      fetchImplementation: async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.origin, "https://graph.microsoft.com");
        authorizations.push(new Headers(init.headers).get("authorization"));
        return authorizations.length === 1
          ? json({ error: { code: "InvalidAuthenticationToken" } }, 401)
          : json({ value: [] });
      },
    }),
  );

  assert.deepEqual(
    await instance.getMessages({ scope: "outlook", folder: "inbox" }),
    [],
  );
  assert.deepEqual(authorizations, [
    "Bearer stored-outlook-access-token",
    "Bearer rotated-outlook-access-token",
  ]);
  assert.equal(refreshes, 1);
  assert.equal(updates[0].expectedTokenVersion, 1);
});

test("stored credentials missing a required provider scope fail closed", async () => {
  await assert.rejects(
    createProductionMailProvider(
      "outlook",
      context,
      dependencies({
        provider: "outlook",
        storedCredential: credential("outlook", { scopes: ["Mail.Send"] }),
      }),
    ),
    MailConnectionUnavailableError,
  );
});
