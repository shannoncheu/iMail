import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let vite;
let sanitizeMailHtml;

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
  ({ sanitizeMailHtml } = await vite.ssrLoadModule(
    "/src/server/mail/html-sanitizer.ts",
  ));
});

after(async () => {
  await vite?.close();
});

test("keeps readable formatting while removing active mail content", () => {
  const sanitized = sanitizeMailHtml(`
    <meta http-equiv="refresh" content="0;url=https://tracker.example">
    <style>body{background:url(https://tracker.example/pixel)}</style>
    <script>fetch('https://tracker.example')</script>
    <p onclick="alert(1)" style="background:url(https://tracker.example)">
      Hello <strong>owner</strong>
      <a href="https://tracker.example">open</a>
      <img src="https://tracker.example/pixel" onerror="alert(1)">
    </p>
    <form action="https://attacker.example"><input name="token"></form>
  `);
  assert.match(sanitized, /<p>\s*Hello <strong>owner<\/strong>\s*open\s*<\/p>/u);
  assert.doesNotMatch(sanitized, /meta|script|style=|onclick|href=|src=|form|input/iu);
  assert.doesNotMatch(sanitized, /tracker\.example|attacker\.example/u);
});

test("does not turn malformed tags or quoted greater-than signs into markup", () => {
  const sanitized = sanitizeMailHtml(
    `<p title="1 > 0" onmouseover="bad()">safe</p><svg><script>alert(1)</script></svg><broken`,
  );
  assert.equal(sanitized, "<p>safe</p>&lt;broken");
});

test("loads only explicit HTTPS images after the user opts in", () => {
  const input = `
    <img src="https://images.example.test/pixel?a=1&amp;b=2" alt="Receipt &amp; logo" onerror="bad()">
    <img src="http://insecure.example.test/image.png">
    <img src="javascript:alert(1)">
    <img src="java&#115;cript:alert(1)">
  `;
  assert.equal(sanitizeMailHtml(input).trim(), "");
  const optedIn = sanitizeMailHtml(input, { allowExternalImages: true });
  assert.match(
    optedIn,
    /<img src="https:\/\/images\.example\.test\/pixel\?a=1&amp;b=2" alt="Receipt &amp; logo" loading="lazy" referrerpolicy="no-referrer">/u,
  );
  assert.doesNotMatch(optedIn, /insecure|javascript|onerror|alert/iu);
});
