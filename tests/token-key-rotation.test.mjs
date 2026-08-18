import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const previousKey = Buffer.alloc(32, 1).toString("base64url");
const currentKey = Buffer.alloc(32, 2).toString("base64url");
let configModule;
let runtimeEnv;
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
  [configModule, runtimeEnv, { MailTokenVault }] = await Promise.all([
    vite.ssrLoadModule("/src/server/config.ts"),
    vite.ssrLoadModule("/src/server/runtime-env.ts"),
    vite.ssrLoadModule("/src/server/mail/token-vault.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

function raw(overrides = {}) {
  return {
    APP_URL: "https://mail.example.test",
    DATABASE_URL: "postgresql://user:password@example.invalid/imail",
    SESSION_SECRET: "session-secret-that-is-longer-than-thirty-two-bytes",
    TOKEN_ENCRYPTION_KEY: currentKey,
    TOKEN_ENCRYPTION_KEY_VERSION: "2",
    TOKEN_ENCRYPTION_KEY_PREVIOUS: previousKey,
    TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: "1",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-client-secret-long-enough",
    ALLOWED_GITHUB_IDS: "123456",
    ...overrides,
  };
}

test("configuration accepts one distinct previous token key version", () => {
  const config = runtimeEnv.runWithRuntimeEnv(raw(), () =>
    configModule.getAuthConfig(),
  );
  assert.equal(config.tokenEncryptionKeyVersion, 2);
  assert.equal(config.previousTokenEncryptionKeys.get(1), previousKey);

  for (const invalid of [
    { TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: undefined },
    { TOKEN_ENCRYPTION_KEY_PREVIOUS: undefined },
    { TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: "2" },
    { TOKEN_ENCRYPTION_KEY_PREVIOUS: currentKey },
    { TOKEN_ENCRYPTION_KEY_PREVIOUS: "not-a-key" },
    { TOKEN_ENCRYPTION_KEY_VERSION: "32768" },
    { TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: "32768" },
  ]) {
    assert.throws(
      () =>
        runtimeEnv.runWithRuntimeEnv(raw(invalid), () =>
          configModule.getAuthConfig(),
        ),
      { name: "ConfigurationError" },
    );
  }
});

test("mail token vault reads the previous version and writes only the active version", async () => {
  const context = {
    connectionId: "11111111-1111-4111-8111-111111111111",
    ownerId: "22222222-2222-4222-8222-222222222222",
    provider: "gmail",
  };
  const credentials = {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenType: "Bearer",
    scopes: ["mail"],
    expiresAt: null,
  };
  const oldVault = await MailTokenVault.create(previousKey, 1);
  const oldEnvelope = await oldVault.encrypt(credentials, context);
  assert.equal(oldEnvelope.keyVersion, 1);

  const rotatingVault = await MailTokenVault.create(
    currentKey,
    2,
    new Map([[1, previousKey]]),
  );
  assert.deepEqual(await rotatingVault.decrypt(oldEnvelope, context), credentials);
  const newEnvelope = await rotatingVault.encrypt(credentials, context);
  assert.equal(newEnvelope.keyVersion, 2);

  const currentOnlyVault = await MailTokenVault.create(currentKey, 2);
  await assert.rejects(currentOnlyVault.decrypt(oldEnvelope, context), /unavailable/u);
  assert.deepEqual(await currentOnlyVault.decrypt(newEnvelope, context), credentials);
});
