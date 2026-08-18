import assert from "node:assert/strict";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

const assets = {
  fetch: async () => new Response("Not found", { status: 404 }),
};

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

const configuredEnv = {
  ASSETS: assets,
  APP_URL: "http://localhost",
  DATABASE_URL: "postgresql://user:password@example.invalid/imail",
  SESSION_SECRET: "session-secret-that-is-longer-than-thirty-two-bytes",
  TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret-long-enough",
  ALLOWED_GITHUB_IDS: "123456",
};

async function loadWorker(label) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${label}-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

test("renders development preview metadata", async () => {
  const worker = await loadWorker("unconfigured");

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    { ASSETS: assets },
    executionContext,
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const html = await response.text();
  assert.match(html, developmentPreviewMeta);
  assert.match(html, /Continue with GitHub/);
  assert.match(html, /Authentication is not configured/);

  const httpsResponse = await worker.fetch(
    new Request("https://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: assets },
    executionContext,
  );
  assert.equal(
    httpsResponse.headers.get("strict-transport-security"),
    "max-age=31536000",
  );
});

test("request-scoped Worker bindings configure the login page", async () => {
  const worker = await loadWorker("configured");
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    configuredEnv,
    executionContext,
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Continue with GitHub/);
  assert.match(html, /Repository access is not requested/);
  assert.doesNotMatch(html, /Authentication is not configured/);
});

test("auth routes fail closed before touching an unavailable database", async () => {
  const worker = await loadWorker("auth-routes");
  const startResponse = await worker.fetch(
    new Request("http://localhost/api/auth/github/start", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "returnTo=%2F",
    }),
    configuredEnv,
    executionContext,
  );
  assert.equal(startResponse.status, 403);
  assert.match(startResponse.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await startResponse.json(), { error: "missing_origin" });

  const oversizedResponse = await worker.fetch(
    new Request("http://localhost/api/auth/github/start", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
      },
      body: `returnTo=/${"a".repeat(5_000)}`,
    }),
    configuredEnv,
    executionContext,
  );
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), {
    error: "request_too_large",
  });

  const accountsResponse = await worker.fetch(
    new Request("http://localhost/api/mail/accounts"),
    configuredEnv,
    executionContext,
  );
  assert.equal(accountsResponse.status, 401);
  assert.match(accountsResponse.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await accountsResponse.json(), { error: "unauthorized" });
});
