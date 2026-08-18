import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let vite;
let clientMailModule;
let providerRegistryModule;

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
    resolve: {
      alias: { "@": projectRoot },
    },
    ssr: {
      noExternal: ["server-only"],
    },
    server: { middlewareMode: true, hmr: false },
  });

  [providerRegistryModule, clientMailModule] = await Promise.all([
    vite.ssrLoadModule("/src/server/mail/provider-registry.ts"),
    vite.ssrLoadModule("/src/providers/mail/index.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

const context = {
  accountId: "account-1",
  ownerId: "owner-1",
};

test("unknown providers are rejected before registry lookup", async () => {
  for (const provider of ["imap", "__proto__", "constructor"]) {
    await assert.rejects(
      providerRegistryModule.resolveServerMailProvider(provider, context),
      (error) => {
        assert.equal(error.name, "UnknownMailProviderError");
        assert.equal(error.code, "UNKNOWN_MAIL_PROVIDER");
        assert.equal(error.provider, provider);
        return true;
      },
    );
  }
});

test("known but unconfigured providers fail closed", async () => {
  for (const provider of ["gmail", "outlook", "zoho"]) {
    await assert.rejects(
      providerRegistryModule.resolveServerMailProvider(provider, context),
      (error) => {
        assert.equal(error.name, "MailProviderNotConfiguredError");
        assert.equal(error.code, "MAIL_PROVIDER_NOT_CONFIGURED");
        assert.equal(error.provider, provider);
        return true;
      },
    );
  }
});

test("the client mail barrel does not export the server registry", async () => {
  assert.equal("resolveServerMailProvider" in clientMailModule, false);
  assert.equal("UnknownMailProviderError" in clientMailModule, false);
  assert.equal("MailProviderNotConfiguredError" in clientMailModule, false);

  const barrelSource = await readFile(
    resolve(projectRoot, "src/providers/mail/index.ts"),
    "utf8",
  );
  assert.doesNotMatch(barrelSource, /src\/server|server\/mail|provider-registry/);
});

test("server registry entries are static and server-only", async () => {
  const registrySource = await readFile(
    resolve(projectRoot, "src/server/mail/provider-registry.ts"),
    "utf8",
  );
  const typesSource = await readFile(
    resolve(projectRoot, "src/server/mail/types.ts"),
    "utf8",
  );

  assert.match(registrySource, /^import "server-only";/);
  assert.match(typesSource, /^import "server-only";/);
  assert.doesNotMatch(registrySource, /import\s*\(/);
  assert.doesNotMatch(registrySource, /accessToken|refreshToken|clientSecret/i);
});
