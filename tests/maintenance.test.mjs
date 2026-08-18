import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maintenanceSecret = "maintenance-secret-".padEnd(64, "x");
const databaseUrl = "postgres://example.test/imail";
const now = new Date("2026-08-18T12:00:00.000Z");

const cleanupResult = {
  oauthTransactions: 2,
  identityOAuthTransactions: 3,
  paginationSessions: 4,
  sessions: 5,
  rateLimits: 7,
  securityEvents: 11,
  providerRevocations: { attempted: 0, completed: 0, pending: 0 },
};

let maintenance;
let maintenanceRoute;
let workerModule;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    root: projectRoot,
    plugins: [
      {
        name: "test-maintenance-server-boundaries",
        enforce: "pre",
        resolveId(id) {
          if (id === "server-only") return "\0test-server-only";
          if (id === "vinext/server/app-router-entry") {
            return "\0test-app-router-entry";
          }
          if (id === "vinext/server/image-optimization") {
            return "\0test-image-optimization";
          }
          return null;
        },
        load(id) {
          if (id === "\0test-server-only") return "export {};";
          if (id === "\0test-app-router-entry") {
            return 'export default { fetch: async () => new Response("ok") };';
          }
          if (id === "\0test-image-optimization") {
            return `
              export const DEFAULT_DEVICE_SIZES = [];
              export const DEFAULT_IMAGE_SIZES = [];
              export async function handleImageOptimization() {
                return new Response("image");
              }
            `;
          }
          return null;
        },
      },
    ],
    resolve: { alias: { "@": projectRoot } },
    ssr: { noExternal: ["server-only", "vinext"] },
    server: { middlewareMode: true, hmr: false },
  });

  [maintenance, maintenanceRoute, workerModule] = await Promise.all([
    vite.ssrLoadModule("/src/server/maintenance.ts"),
    vite.ssrLoadModule("/app/api/internal/maintenance/route.ts"),
    vite.ssrLoadModule("/worker/index.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

function runtimeValues(values = {}) {
  const bindings = {
    DATABASE_URL: databaseUrl,
    MAINTENANCE_SECRET: maintenanceSecret,
    ...values,
  };
  return (name) => bindings[name];
}

function request(authorization, method = "POST") {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request("https://mail.example.test/api/internal/maintenance", {
    method,
    headers,
  });
}

function assertNoStore(response) {
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
}

test("route module exposes only the supported POST handler and route metadata", () => {
  assert.deepEqual(Object.keys(maintenanceRoute).sort(), ["POST", "dynamic"]);
});

test("maintenance POST fails closed for absent, weak, malformed, and wrong secrets", async () => {
  let cleanupCalls = 0;
  const runCleanup = async () => {
    cleanupCalls += 1;
    return cleanupResult;
  };
  const cases = [
    {
      authorization: undefined,
      getRuntimeValue: runtimeValues(),
    },
    {
      authorization: `Bearer ${maintenanceSecret}`,
      getRuntimeValue: runtimeValues({ MAINTENANCE_SECRET: undefined }),
    },
    {
      authorization: "Bearer too-short",
      getRuntimeValue: runtimeValues({ MAINTENANCE_SECRET: "too-short" }),
    },
    {
      authorization: `Basic ${maintenanceSecret}`,
      getRuntimeValue: runtimeValues(),
    },
    {
      authorization: `Bearer ${"z".repeat(64)}`,
      getRuntimeValue: runtimeValues(),
    },
    {
      authorization: `Bearer ${maintenanceSecret}, Bearer ${maintenanceSecret}`,
      getRuntimeValue: runtimeValues(),
    },
  ];

  for (const scenario of cases) {
    const response = await maintenance.handleMaintenancePost(
      request(scenario.authorization),
      {
        getRuntimeValue: scenario.getRuntimeValue,
        runCleanup,
      },
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(
      response.headers.get("www-authenticate"),
      'Bearer realm="maintenance"',
    );
    assertNoStore(response);
  }

  assert.equal(cleanupCalls, 0);
});

test("maintenance POST runs cleanup once and never caches the result", async () => {
  const calls = [];
  const response = await maintenance.handleMaintenancePost(
    request(`Bearer ${maintenanceSecret}`),
    {
      getRuntimeValue: runtimeValues(),
      now: () => now,
      async runCleanup(options) {
        calls.push(options);
        return cleanupResult;
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, cleaned: cleanupResult });
  assert.deepEqual(calls, [{ databaseUrl, now }]);
  assertNoStore(response);
});

test("maintenance POST reports configuration and cleanup failures without details", async () => {
  const unavailable = await maintenance.handleMaintenancePost(
    request(`Bearer ${maintenanceSecret}`),
    {
      getRuntimeValue: runtimeValues({ DATABASE_URL: "" }),
      runCleanup: async () => cleanupResult,
    },
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: "maintenance_unavailable",
  });
  assertNoStore(unavailable);

  const failed = await maintenance.handleMaintenancePost(
    request(`Bearer ${maintenanceSecret}`),
    {
      getRuntimeValue: runtimeValues(),
      async runCleanup() {
        throw new Error("database host and credentials must not leak");
      },
    },
  );
  assert.equal(failed.status, 503);
  const failedBody = await failed.text();
  assert.deepEqual(JSON.parse(failedBody), { error: "maintenance_unavailable" });
  assert.doesNotMatch(failedBody, /database|credentials/i);
  assertNoStore(failed);
});

test("maintenance helper delegates the exact scheduled time to the repository", async () => {
  const calls = [];
  const result = await maintenance.runMaintenanceCleanup({
    databaseUrl,
    now,
    repository: {
      async cleanupExpired(value) {
        calls.push(value);
        return cleanupResult;
      },
    },
  });

  assert.deepEqual(result, cleanupResult);
  assert.deepEqual(calls, [now]);
  await assert.rejects(
    maintenance.runMaintenanceCleanup({
      databaseUrl,
      now: new Date(Number.NaN),
      repository: { cleanupExpired: async () => cleanupResult },
    }),
    /valid date/,
  );
});

test("maintenance retries pending provider revocations before deleting local secrets", async () => {
  const disconnected = [];
  const pendingConnections = [
    { id: "gmail-id", ownerId: "owner-id", provider: "gmail", tokenVersion: 7 },
    { id: "zoho-id", ownerId: "owner-id", provider: "zoho", tokenVersion: 9 },
  ];
  const result = await maintenance.runMaintenanceCleanup({
    databaseUrl,
    now,
    config: {},
    repository: {
      async cleanupExpired() {
        return {
          oauthTransactions: cleanupResult.oauthTransactions,
          identityOAuthTransactions: cleanupResult.identityOAuthTransactions,
          paginationSessions: cleanupResult.paginationSessions,
          sessions: cleanupResult.sessions,
          rateLimits: cleanupResult.rateLimits,
          securityEvents: cleanupResult.securityEvents,
        };
      },
      async claimRevocationPending(limit) {
        assert.equal(limit, 25);
        return pendingConnections;
      },
      async releaseRevocationClaim(ownerId, id, tokenVersion) {
        disconnected.push({ released: true, ownerId, id, tokenVersion });
        return true;
      },
      async finalizeRevocationClaim(ownerId, id, tokenVersion) {
        disconnected.push({ ownerId, id, tokenVersion });
        return true;
      },
    },
    async revokeCredentials({ connection }) {
      return connection.provider === "gmail" ? "revoked" : "failed";
    },
  });

  assert.deepEqual(result.providerRevocations, {
    attempted: 2,
    completed: 1,
    pending: 1,
  });
  assert.deepEqual(disconnected, [
    { ownerId: "owner-id", id: "gmail-id", tokenVersion: 7 },
    {
      released: true,
      ownerId: "owner-id",
      id: "zoho-id",
      tokenVersion: 9,
    },
  ]);
});

test("non-POST requests are rejected with no-store and an Allow header", async () => {
  const response = await maintenance.handleMaintenancePost(
    request(`Bearer ${maintenanceSecret}`, "GET"),
    { getRuntimeValue: runtimeValues() },
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.deepEqual(await response.json(), { error: "method_not_allowed" });
  assertNoStore(response);
});

test("Worker scheduled handler calls cleanup directly through waitUntil", async () => {
  const calls = [];
  const worker = workerModule.createWorker({
    async maintenanceCleanup(options) {
      calls.push(options);
      return cleanupResult;
    },
  });
  const promises = [];
  const scheduledTime = now.getTime();
  worker.scheduled(
    { cron: "17 3 * * *", scheduledTime, noRetry() {} },
    {
      DATABASE_URL: `  ${databaseUrl}  `,
      ASSETS: { fetch: async () => new Response() },
      IMAGES: {},
    },
    {
      waitUntil(promise) {
        promises.push(promise);
      },
      passThroughOnException() {},
    },
  );

  assert.equal(promises.length, 1);
  assert.deepEqual(await promises[0], cleanupResult);
  assert.deepEqual(calls, [{ databaseUrl, now }]);
});

test("Worker scheduled cleanup fails closed without a database binding", async () => {
  let called = false;
  await assert.rejects(
    workerModule.runScheduledMaintenance(
      {},
      now.getTime(),
      async () => {
        called = true;
        return cleanupResult;
      },
    ),
    /requires DATABASE_URL/,
  );
  assert.equal(called, false);
});
