import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let cookies;
let callbackResponse;
let configModule;
let github;
let runtimeEnv;
let session;
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

  [cookies, callbackResponse, configModule, github, runtimeEnv, session] =
    await Promise.all([
      vite.ssrLoadModule("/src/server/security/cookies.ts"),
      vite.ssrLoadModule("/src/server/auth/callback-response.ts"),
      vite.ssrLoadModule("/src/server/config.ts"),
      vite.ssrLoadModule("/src/server/auth/github.ts"),
      vite.ssrLoadModule("/src/server/runtime-env.ts"),
      vite.ssrLoadModule("/src/server/auth/session.ts"),
    ]);
});

after(async () => {
  await vite?.close();
});

const config = {
  appUrl: new URL("https://mail.example.test"),
  databaseUrl: "postgresql://example.invalid/imail",
  sessionSecret: "session-secret-that-is-longer-than-thirty-two-bytes",
  tokenEncryptionKey: "ERERERERERERERERERERERERERERERERERERERERERE",
  github: {
    clientId: "github-client-id",
    clientSecret: "github-client-secret-long-enough",
    allowedIds: new Set(["123456"]),
    callbackUrl: "https://mail.example.test/api/auth/github/callback",
  },
};

const rawConfig = {
  APP_URL: "https://mail.example.test",
  DATABASE_URL: "postgresql://user:password@example.invalid/imail",
  SESSION_SECRET: config.sessionSecret,
  TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  GITHUB_CLIENT_ID: config.github.clientId,
  GITHUB_CLIENT_SECRET: config.github.clientSecret,
  ALLOWED_GITHUB_IDS: "123456,789012",
};

test("auth configuration validates keys, origins, and immutable numeric IDs", () => {
  const parsed = runtimeEnv.runWithRuntimeEnv(rawConfig, () =>
    configModule.getAuthConfig(),
  );
  assert.equal(parsed.appUrl.origin, "https://mail.example.test");
  assert.equal(
    parsed.github.callbackUrl,
    "https://mail.example.test/api/auth/github/callback",
  );
  assert.deepEqual([...parsed.github.allowedIds], ["123456", "789012"]);

  for (const invalid of [
    { ALLOWED_GITHUB_IDS: "owner-name" },
    { ALLOWED_GITHUB_IDS: "" },
    { TOKEN_ENCRYPTION_KEY: "A".repeat(42) },
    { APP_URL: "http://mail.example.test" },
    {
      SESSION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  ]) {
    assert.throws(
      () =>
        runtimeEnv.runWithRuntimeEnv({ ...rawConfig, ...invalid }, () =>
          configModule.getAuthConfig(),
        ),
      { name: "ConfigurationError" },
    );
  }
});

test("OAuth completion uses a no-store same-origin HTML handoff for Strict cookies", async () => {
  const response = callbackResponse.createLoginCompletionResponse({
    config,
    returnTo: '/?next="<&',
    sessionToken: "s".repeat(43),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.length, 2);
  assert.match(setCookies[0], /^__Host-imail-oauth=;/);
  assert.match(setCookies[1], /^__Host-imail-session=/);
  assert.match(setCookies[1], /SameSite=Strict/);

  const html = await response.text();
  assert.match(html, /http-equiv="refresh"/);
  assert.match(html, /\?next=&quot;&lt;&amp;/);
  assert.doesNotMatch(html, /\?next="<&/);
});

test("GitHub authorization is fixed to identity-only PKCE parameters", () => {
  const url = github.buildGitHubAuthorizationUrl({
    clientId: config.github.clientId,
    callbackUrl: config.github.callbackUrl,
    state: "state-value",
    codeChallenge: "challenge-value",
  });

  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/login/oauth/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), config.github.callbackUrl);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.has("scope"), false);
});

test("GitHub code exchange returns only a normalized identity", async () => {
  const calls = [];
  const fakeFetch = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    if (calls.length === 1) {
      return Response.json({
        access_token: "github-temporary-access-token",
        token_type: "bearer",
        scope: "",
      });
    }
    if (calls.length === 2) {
      return Response.json({
        id: 123456,
        login: "owner-name",
        name: "Owner Name",
        email: null,
        avatar_url: "https://avatars.githubusercontent.com/u/123456",
      });
    }
    return new Response(null, { status: 204 });
  };

  const identity = await github.exchangeGitHubCodeForIdentity({
    config: config.github,
    code: "temporary-code",
    codeVerifier: "v".repeat(43),
    fetchImplementation: fakeFetch,
  });

  assert.deepEqual(identity, {
    id: "123456",
    login: "owner-name",
    displayName: "Owner Name",
    email: null,
    avatarUrl: "https://avatars.githubusercontent.com/u/123456",
  });
  assert.match(String(calls[0].init.body), /code_verifier=/);
  assert.match(calls[1].init.headers.Authorization, /^Bearer /);
  assert.equal(calls[2].init.method, "DELETE");
  assert.match(calls[2].input, /\/applications\/github-client-id\/token$/);
  assert.doesNotMatch(calls[2].init.headers.Authorization, /github-temporary-access-token/);
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    access_token: "github-temporary-access-token",
  });
  assert.equal(JSON.stringify(identity).includes("access-token"), false);
});

test("GitHub exchange rejects a token carrying delegated scopes", async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    return callCount === 1
      ? Response.json({
          access_token: "github-temporary-access-token",
          token_type: "bearer",
          scope: "repo",
        })
      : new Response(null, { status: 204 });
  };

  await assert.rejects(
    github.exchangeGitHubCodeForIdentity({
      config: config.github,
      code: "temporary-code",
      codeVerifier: "v".repeat(43),
      fetchImplementation: fakeFetch,
    }),
    /identity-only/,
  );
  assert.equal(callCount, 2, "the over-scoped token must be revoked");
});

test("GitHub exchange requires explicit bearer and empty-scope fields", async () => {
  for (const tokenPayload of [
    { access_token: "github-temporary-access-token", scope: "" },
    { access_token: "github-temporary-access-token", token_type: "bearer" },
  ]) {
    let callCount = 0;
    const fakeFetch = async () => {
      callCount += 1;
      return callCount === 1
        ? Response.json(tokenPayload)
        : new Response(null, { status: 204 });
    };
    await assert.rejects(
      github.exchangeGitHubCodeForIdentity({
        config: config.github,
        code: "temporary-code",
        codeVerifier: "v".repeat(43),
        fetchImplementation: fakeFetch,
      }),
      /identity-only/,
    );
    assert.equal(callCount, 2);
  }
});

function authenticatedRecord(providerSubject = "123456") {
  const now = new Date();
  return {
    session: {
      id: "session-id",
      ownerId: "owner-id",
      identityId: "identity-id",
      rotatedFromSessionId: null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null,
      ipHash: null,
      userAgentHash: null,
    },
    owner: {
      id: "owner-id",
      displayName: "Owner Name",
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: now,
      disabledAt: null,
    },
    identities: [
      {
        id: "identity-id",
        ownerId: "owner-id",
        provider: "github",
        providerSubject,
        providerUsername: "owner-name",
        email: null,
        avatarUrl: null,
        createdAt: now,
        updatedAt: now,
        lastVerifiedAt: now,
      },
    ],
  };
}

test("an allowed opaque session yields viewer data and an in-memory CSRF token", async () => {
  let storedDigest;
  const repository = {
    async findSessionByDigest(digest) {
      storedDigest = digest;
      return authenticatedRecord();
    },
    async revokeSessionByDigest() {
      throw new Error("should not revoke an allowed session");
    },
  };
  const rawToken = "a".repeat(43);
  const cookie = cookies.serializeSessionCookie(
    rawToken,
    session.authCookieContext(config),
  );
  const result = await session.authenticateCookieHeader({
    config,
    cookieHeader: cookie,
    repository,
  });

  assert.equal(result.viewer.githubId, "123456");
  assert.equal(result.viewer.login, "owner-name");
  assert.match(result.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(storedDigest, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(storedDigest, rawToken);
  assert.notEqual(result.csrfToken, storedDigest);
});

test("removing an identity revokes its session even when another owner identity stays allowed", async () => {
  let revokedDigest;
  const repository = {
    async findSessionByDigest() {
      const record = authenticatedRecord("999999");
      record.identities.push({
        ...record.identities[0],
        id: "other-identity-id",
        providerSubject: "123456",
        providerUsername: "other-owner-login",
      });
      return record;
    },
    async revokeSessionByDigest(digest) {
      revokedDigest = digest;
      return true;
    },
  };
  const rawToken = "b".repeat(43);
  const cookie = cookies.serializeSessionCookie(
    rawToken,
    session.authCookieContext(config),
  );
  const result = await session.authenticateCookieHeader({
    config,
    cookieHeader: cookie,
    repository,
  });

  assert.equal(result, null);
  assert.match(revokedDigest, /^[A-Za-z0-9_-]{43}$/);
});

test("allowlist revocation failures fail closed instead of reviving an old session", async () => {
  const repository = {
    async findSessionByDigest() {
      return authenticatedRecord("999999");
    },
    async revokeSessionByDigest() {
      throw new Error("database unavailable");
    },
  };
  const cookie = cookies.serializeSessionCookie(
    "c".repeat(43),
    session.authCookieContext(config),
  );

  await assert.rejects(
    session.authenticateCookieHeader({
      config,
      cookieHeader: cookie,
      repository,
    }),
    /database unavailable/,
  );
});

test("session creation stores only a digest", async () => {
  let inserted;
  const repository = {
    async createOwnerSession(input) {
      inserted = input;
      return {
        id: "session-id",
        ownerId: input.ownerId,
        identityId: input.identityId,
        rotatedFromSessionId: null,
        createdAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: input.expiresAt,
        revokedAt: null,
        ipHash: null,
        userAgentHash: null,
      };
    },
  };
  const created = await session.createOwnerSession({
    config,
    identityId: "identity-id",
    ownerId: "owner-id",
    repository,
  });

  assert.match(created.rawToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(inserted.tokenDigest, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(inserted.tokenDigest, created.rawToken);
});
