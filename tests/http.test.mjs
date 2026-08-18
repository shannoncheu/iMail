import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let vite;
let readJsonBody;

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
    server: { middlewareMode: true, hmr: false },
    ssr: { noExternal: ["server-only"] },
  });
  ({ readJsonBody } = await vite.ssrLoadModule("/src/server/http.ts"));
});

after(async () => {
  await vite?.close();
});

test("parses UTF-8 JSON split across request chunks", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ value: "邮箱" }));
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const request = new Request("https://mail.example.test/api/mail/send", {
    method: "POST",
    body: stream,
    duplex: "half",
  });
  assert.deepEqual(await readJsonBody(request, encoded.byteLength), {
    value: "邮箱",
  });
});

test("cancels a chunked request as soon as its byte limit is exceeded", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(6));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("https://mail.example.test/api/mail/send", {
    method: "POST",
    body: stream,
    duplex: "half",
  });
  await assert.rejects(
    readJsonBody(request, 10),
    (error) => error?.code === "body_too_large" && error?.status === 413,
  );
  assert.equal(cancelled, true);
});
