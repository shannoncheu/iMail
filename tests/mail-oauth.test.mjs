import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const currentKey = Buffer.alloc(32, 7).toString("base64url");
const previousKey = Buffer.alloc(32, 6).toString("base64url");
let oauth;
let MailTokenVault;
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
  [oauth, { MailTokenVault }] = await Promise.all([
    vite.ssrLoadModule("/src/server/mail/oauth.ts"),
    vite.ssrLoadModule("/src/server/mail/token-vault.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

const ownerId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const authConfig = {
  appUrl: new URL("https://mail.example.test"),
  databaseUrl: "postgresql://example.invalid/imail",
  sessionSecret: "s".repeat(32),
  tokenEncryptionKey: currentKey,
  tokenEncryptionKeyVersion: 2,
  previousTokenEncryptionKeys: new Map([[1, previousKey]]),
  github: {
    clientId: "github-client",
    clientSecret: "g".repeat(20),
    allowedIds: new Set(["1"]),
    callbackUrl: "https://mail.example.test/api/auth/github/callback",
  },
};
const zohoConfig = {
  provider: "zoho",
  clientId: "zoho-client",
  clientSecret: "zoho-client-secret",
  authorizationUrl: "https://accounts.zoho.com/oauth/v2/auth",
  tokenUrl: "https://accounts.zoho.com/oauth/v2/token",
  callbackUrl: "https://mail.example.test/api/mail/connect/zoho/callback",
  scopes: [
    "ZohoMail.accounts.READ",
    "ZohoMail.folders.READ",
    "ZohoMail.messages.ALL",
    "ZohoMail.attachments.ALL",
  ],
  scopeSeparator: ",",
  authorizationParameters: { access_type: "offline", prompt: "consent" },
  apiBaseUrl: "https://mail.zoho.com/api",
};
const session = {
  rawToken: "r".repeat(43),
  tokenDigest: "d".repeat(43),
  csrfToken: "c".repeat(43),
  viewer: {
    id: ownerId,
    githubId: "1",
    login: "owner",
    displayName: "Owner",
    avatarUrl: null,
  },
  record: {
    owner: { id: ownerId },
    session: { id: sessionId },
    identities: [],
  },
};

test("mail authorization stores only encrypted PKCE state at the active key version", async () => {
  let transaction;
  const started = await oauth.beginMailAuthorization({
    authConfig,
    providerConfig: zohoConfig,
    returnTo: "/?mail_connected=zoho",
    session,
    repository: {
      async createOAuthTransaction(input) {
        transaction = input;
        return input;
      },
    },
  });

  assert.equal(started.authorizationUrl.origin, "https://accounts.zoho.com");
  assert.equal(started.authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    started.authorizationUrl.searchParams.get("scope"),
    zohoConfig.scopes.join(","),
  );
  assert.match(started.browserBinding, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(transaction.stateDigest, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(transaction.browserBindingDigest, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(transaction.codeVerifierEnvelope.keyVersion, 2);
  assert.equal(JSON.stringify(transaction).includes("codeVerifier\":"), false);
});

test("Zoho completion uses its required auth scheme and encrypts refresh credentials", async () => {
  let transaction;
  await oauth.beginMailAuthorization({
    authConfig,
    providerConfig: zohoConfig,
    returnTo: "/",
    session,
    repository: {
      async createOAuthTransaction(input) {
        transaction = {
          ...input,
          createdAt: new Date(),
          expiresAt: input.expiresAt,
        };
        return transaction;
      },
    },
  });

  const calls = [];
  let saved;
  const now = new Date();
  const result = await oauth.completeMailAuthorization({
    authorizeTransaction: async () => true,
    authConfig,
    code: "authorization-code",
    providerConfig: zohoConfig,
    transaction,
    fetcher: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        assert.match(String(init.body), /code_verifier=/u);
        return Response.json({
          access_token: "zoho-access-token",
          refresh_token: "zoho-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: zohoConfig.scopes.join(" "),
        });
      }
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Zoho-oauthtoken zoho-access-token",
      );
      return Response.json({
        data: [
          {
            accountId: "123456789",
            primaryEmailAddress: "owner@example.test",
            displayName: "Owner Mail",
          },
        ],
      });
    },
    repository: {
      async findByProviderAccount() {
        return null;
      },
      async upsertConnection(input) {
        saved = input;
        return {
          ...input,
          status: "connected",
          accessExpiresAt: input.accessExpiresAt,
          tokenVersion: 1,
          providerMetadata: input.providerMetadata,
          lastErrorCode: null,
          createdAt: now,
          updatedAt: now,
          connectedAt: now,
          lastRefreshedAt: now,
          disconnectedAt: null,
        };
      },
    },
  });

  assert.equal(calls[0].url, zohoConfig.tokenUrl);
  assert.equal(calls[1].url, "https://mail.zoho.com/api/accounts");
  assert.equal(result.emailAddress, "owner@example.test");
  assert.equal(saved.credentials.keyVersion, 2);
  const vault = await MailTokenVault.createFromConfig(authConfig);
  const credentials = await vault.decrypt(saved.credentials, {
    connectionId: saved.id,
    ownerId,
    provider: "zoho",
  });
  assert.equal(credentials.accessToken, "zoho-access-token");
  assert.equal(credentials.refreshToken, "zoho-refresh-token");
  assert.equal(JSON.stringify(result).includes("zoho-access-token"), false);
});

test("completion revokes its temporary token when the bound GitHub session loses access", async () => {
  let transaction;
  await oauth.beginMailAuthorization({
    authConfig,
    providerConfig: zohoConfig,
    returnTo: "/",
    session,
    repository: {
      async createOAuthTransaction(input) {
        transaction = { ...input, createdAt: new Date() };
        return transaction;
      },
    },
  });

  const calls = [];
  await assert.rejects(
    oauth.completeMailAuthorization({
      authorizeTransaction: async () => false,
      authConfig,
      code: "authorization-code",
      providerConfig: zohoConfig,
      transaction,
      fetcher: async (input) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return Response.json({
            access_token: "temporary-access-token",
            refresh_token: "temporary-refresh-token",
            token_type: "Bearer",
            scope: zohoConfig.scopes.join(" "),
          });
        }
        return new Response(null, { status: 200 });
      },
      repository: {
        async findByProviderAccount() {
          throw new Error("profile and connection lookup must not run");
        },
        async upsertConnection() {
          throw new Error("credentials must not be persisted");
        },
      },
    }),
    /no longer authorized/u,
  );

  assert.equal(calls.length, 2);
  const revokeUrl = new URL(calls[1]);
  assert.equal(
    revokeUrl.origin + revokeUrl.pathname,
    "https://accounts.zoho.com/oauth/v2/token/revoke",
  );
  assert.equal(revokeUrl.searchParams.get("token"), "temporary-refresh-token");
});

test("a pending disconnect rejects reconnect and revokes the newly issued token", async () => {
  let transaction;
  await oauth.beginMailAuthorization({
    authConfig,
    providerConfig: zohoConfig,
    returnTo: "/",
    session,
    repository: {
      async createOAuthTransaction(input) {
        transaction = { ...input, createdAt: new Date() };
        return transaction;
      },
    },
  });
  const calls = [];
  await assert.rejects(
    oauth.completeMailAuthorization({
      authorizeTransaction: async () => true,
      authConfig,
      code: "authorization-code",
      providerConfig: zohoConfig,
      transaction,
      fetcher: async (input) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return Response.json({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            token_type: "Bearer",
            scope: zohoConfig.scopes.join(" "),
          });
        }
        if (calls.length === 2) {
          return Response.json({
            data: [
              {
                accountId: "123456789",
                primaryEmailAddress: "owner@example.test",
              },
            ],
          });
        }
        return new Response(null, { status: 200 });
      },
      repository: {
        async findByProviderAccount() {
          return {
            id: "11111111-1111-4111-8111-111111111111",
            ownerId,
            provider: "zoho",
            providerAccountId: "123456789",
            emailAddress: "owner@example.test",
            label: "Owner Mail",
            status: "error",
            scopes: [],
            credentials: null,
            accessExpiresAt: null,
            tokenVersion: 4,
            providerMetadata: {},
            lastErrorCode: "revocation_in_progress",
            createdAt: new Date(),
            updatedAt: new Date(),
            connectedAt: new Date(),
            lastRefreshedAt: null,
            disconnectedAt: null,
          };
        },
        async upsertConnection() {
          throw new Error("must not save over a pending revocation");
        },
      },
    }),
    /revocation is still pending/u,
  );
  const revokeUrl = new URL(calls[2]);
  assert.equal(
    revokeUrl.origin + revokeUrl.pathname,
    "https://accounts.zoho.com/oauth/v2/token/revoke",
  );
  assert.equal(revokeUrl.searchParams.get("token"), "new-refresh-token");
});

test("an optimistic reconnect loser revokes its uncommitted token", async () => {
  let transaction;
  await oauth.beginMailAuthorization({
    authConfig,
    providerConfig: zohoConfig,
    returnTo: "/",
    session,
    repository: {
      async createOAuthTransaction(input) {
        transaction = { ...input, createdAt: new Date() };
        return transaction;
      },
    },
  });
  const calls = [];
  await assert.rejects(
    oauth.completeMailAuthorization({
      authorizeTransaction: async () => true,
      authConfig,
      code: "authorization-code",
      providerConfig: zohoConfig,
      transaction,
      fetcher: async (input) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return Response.json({
            access_token: "race-access-token",
            refresh_token: "race-refresh-token",
            token_type: "Bearer",
            scope: zohoConfig.scopes.join(" "),
          });
        }
        if (calls.length === 2) {
          return Response.json({
            data: [
              {
                accountId: "987654321",
                primaryEmailAddress: "owner@example.test",
              },
            ],
          });
        }
        return new Response(null, { status: 200 });
      },
      repository: {
        async findByProviderAccount() {
          return null;
        },
        async upsertConnection() {
          throw new Error("connection changed");
        },
      },
    }),
    /connection changed/u,
  );
  assert.equal(new URL(calls[2]).searchParams.get("token"), "race-refresh-token");
});
