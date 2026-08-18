import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let vite;
let applySecurityHeaders;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    root: projectRoot,
    server: { middlewareMode: true, hmr: false },
  });
  ({ applySecurityHeaders } = await vite.ssrLoadModule(
    "/src/server/security/response-headers.ts",
  ));
});

after(async () => {
  await vite?.close();
});

test("preserves the explicit same-origin frame policy used by mail content", () => {
  const response = new Response("mail", {
    headers: {
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'; sandbox",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
  const secured = applySecurityHeaders(response, "https://mail.example.test/api/mail/content");
  assert.equal(secured.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(secured.headers.get("content-security-policy"), /frame-ancestors 'self'/u);
});

test("keeps denying framing by default", () => {
  const secured = applySecurityHeaders(
    new Response("page"),
    "https://mail.example.test/",
  );
  assert.equal(secured.headers.get("x-frame-options"), "DENY");
  assert.match(secured.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
});
