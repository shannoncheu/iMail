import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const encodedKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
let vite;
let MailTokenVault;
let revokeMailConnectionCredentials;

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
  ({ MailTokenVault } = await vite.ssrLoadModule(
    "/src/server/mail/token-vault.ts",
  ));
  ({ revokeMailConnectionCredentials } = await vite.ssrLoadModule(
    "/src/server/mail/revoke-connection.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const config = {
  appUrl: new URL("https://mail.example.test"),
  databaseUrl: "postgresql://example.invalid/imail",
  sessionSecret: "s".repeat(32),
  tokenEncryptionKey: encodedKey,
  github: {
    clientId: "github-client",
    clientSecret: "g".repeat(20),
    allowedIds: new Set(["1"]),
    callbackUrl: "https://mail.example.test/api/auth/github/callback",
  },
};

async function connection(provider) {
  const id = "11111111-1111-4111-8111-111111111111";
  const ownerId = "22222222-2222-4222-8222-222222222222";
  const vault = await MailTokenVault.create(encodedKey);
  const credentials = await vault.encrypt(
    {
      accessToken: `${provider}-access-token`,
      refreshToken: `${provider}-refresh-token`,
      tokenType: "Bearer",
      scopes: ["mail"],
      expiresAt: null,
    },
    { connectionId: id, ownerId, provider },
  );
  const now = new Date();
  return {
    id,
    ownerId,
    provider,
    providerAccountId: "provider-account",
    emailAddress: "owner@example.test",
    label: "Mail",
    status: "connected",
    scopes: ["mail"],
    credentials,
    accessExpiresAt: null,
    tokenVersion: 1,
    providerMetadata: {},
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    connectedAt: now,
    lastRefreshedAt: now,
    disconnectedAt: null,
  };
}

async function withProviderEnvironment(provider, callback) {
  const values = {
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    ZOHO_CLIENT_ID: "zoho-client",
    ZOHO_CLIENT_SECRET: "zoho-secret",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  try {
    return await callback(await connection(provider));
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("revokes Gmail and Zoho refresh tokens at fixed provider endpoints", async () => {
  for (const [provider, expectedUrl] of [
    ["gmail", "https://oauth2.googleapis.com/revoke"],
    ["zoho", "https://accounts.zoho.com/oauth/v2/token/revoke"],
  ]) {
    const calls = [];
    const status = await withProviderEnvironment(provider, (stored) =>
      revokeMailConnectionCredentials({
        config,
        connection: stored,
        fetcher: async (input, init) => {
          calls.push({ input: String(input), init });
          return new Response(null, { status: 200 });
        },
      }),
    );
    assert.equal(status, "revoked");
    const calledUrl = new URL(calls[0].input);
    assert.equal(calledUrl.origin + calledUrl.pathname, expectedUrl);
    assert.equal(calls[0].init.method, "POST");
    const submittedToken =
      provider === "zoho"
        ? calledUrl.searchParams.get("token")
        : new URLSearchParams(calls[0].init.body).get("token");
    assert.equal(submittedToken, `${provider}-refresh-token`);
    if (provider === "zoho") {
      assert.equal(calls[0].init.body, undefined);
      assert.equal(new Headers(calls[0].init.headers).has("authorization"), false);
    }
  }
});

test("uses local-only revocation for Outlook and fails closed on provider errors", async () => {
  assert.equal(
    await revokeMailConnectionCredentials({
      config,
      connection: await connection("outlook"),
      fetcher: async () => {
        throw new Error("must not fetch");
      },
    }),
    "unsupported",
  );

  assert.equal(
    await withProviderEnvironment("gmail", (stored) =>
      revokeMailConnectionCredentials({
        config,
        connection: stored,
        fetcher: async () => new Response(null, { status: 503 }),
      }),
    ),
    "failed",
  );
});

test("accepts only Google's explicit already-revoked response", async () => {
  const stored = await connection("gmail");
  assert.equal(
    await withProviderEnvironment("gmail", () =>
      revokeMailConnectionCredentials({
        config,
        connection: stored,
        fetcher: async () =>
          new Response(JSON.stringify({ error: "invalid_token" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      }),
    ),
    "already_revoked",
  );
  assert.equal(
    await withProviderEnvironment("gmail", () =>
      revokeMailConnectionCredentials({
        config,
        connection: stored,
        fetcher: async () =>
          new Response(JSON.stringify({ error: "invalid_request" }), {
            status: 400,
          }),
      }),
    ),
    "failed",
  );
});

test("accepts Zoho Mail's documented invalid-token response as already revoked", async () => {
  assert.equal(
    await withProviderEnvironment("zoho", (stored) =>
      revokeMailConnectionCredentials({
        config,
        connection: stored,
        fetcher: async () => new Response(null, { status: 400 }),
      }),
    ),
    "already_revoked",
  );
});

test("maintenance retries a retained revocation-pending credential", async () => {
  const calls = [];
  const status = await withProviderEnvironment("gmail", async (stored) =>
    revokeMailConnectionCredentials({
      config,
      connection: {
        ...stored,
        status: "error",
        lastErrorCode: "revocation_pending",
      },
      fetcher: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 200 });
      },
    }),
  );
  assert.equal(status, "revoked");
  assert.deepEqual(calls, ["https://oauth2.googleapis.com/revoke"]);
});
