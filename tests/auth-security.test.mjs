import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let cookies;
let cryptoHelpers;
let requestSecurity;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    root: projectRoot,
    server: { middlewareMode: true, hmr: false },
  });

  [cryptoHelpers, cookies, requestSecurity] = await Promise.all([
    vite.ssrLoadModule("/src/server/security/crypto.ts"),
    vite.ssrLoadModule("/src/server/security/cookies.ts"),
    vite.ssrLoadModule("/src/server/security/request-security.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

test("random base64url values and SHA-256 are canonical", async () => {
  const first = cryptoHelpers.randomBase64Url(32);
  const second = cryptoHelpers.randomBase64Url(32);

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(cryptoHelpers.decodeBase64Url(first).byteLength, 32);
  assert.equal(
    await cryptoHelpers.sha256Base64Url("abc"),
    "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
  );
  assert.throws(() => cryptoHelpers.decodeBase64Url("YQ=="), /base64url/);
  assert.throws(() => cryptoHelpers.decodeBase64Url("A"), /base64url/);
});

test("purpose-derived HMAC keys are separated", async () => {
  const masterKey = new Uint8Array(32).fill(7);
  const sessionKey = await cryptoHelpers.deriveHmacSha256Key(masterKey, "session");
  const csrfKey = await cryptoHelpers.deriveHmacSha256Key(masterKey, "csrf");
  const firstSessionDigest = await cryptoHelpers.hmacSha256Base64Url(
    sessionKey,
    "opaque-token",
  );
  const secondSessionDigest = await cryptoHelpers.hmacSha256Base64Url(
    sessionKey,
    "opaque-token",
  );
  const csrfDigest = await cryptoHelpers.hmacSha256Base64Url(
    csrfKey,
    "opaque-token",
  );

  assert.equal(firstSessionDigest, secondSessionDigest);
  assert.notEqual(firstSessionDigest, csrfDigest);
  await assert.rejects(
    cryptoHelpers.deriveHmacSha256Key(new Uint8Array(16), "session"),
    /at least 32 bytes/,
  );
});

test("PKCE uses the RFC 7636 S256 transformation", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(
    await cryptoHelpers.pkceS256Challenge(verifier),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );

  const pair = await cryptoHelpers.createPkcePair();
  assert.equal(pair.method, "S256");
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pair.challenge, await cryptoHelpers.pkceS256Challenge(pair.verifier));
  await assert.rejects(cryptoHelpers.pkceS256Challenge("too-short"), /43-128/);
});

test("AES-256-GCM authenticates ciphertext and AAD", async () => {
  const key = await cryptoHelpers.importAes256GcmKey(new Uint8Array(32).fill(11));
  const envelope = await cryptoHelpers.encryptAes256Gcm(
    key,
    "secret token bundle",
    "connection|owner|gmail|v1",
    3,
  );
  const secondEnvelope = await cryptoHelpers.encryptAes256Gcm(
    key,
    "secret token bundle",
    "connection|owner|gmail|v1",
    3,
  );

  assert.equal(envelope.algorithm, "A256GCM");
  assert.equal(envelope.keyVersion, 3);
  assert.notEqual(envelope.iv, secondEnvelope.iv);
  assert.notEqual(envelope.ciphertext, secondEnvelope.ciphertext);
  assert.equal(
    await cryptoHelpers.decryptAes256GcmText(
      key,
      envelope,
      "connection|owner|gmail|v1",
    ),
    "secret token bundle",
  );
  await assert.rejects(
    cryptoHelpers.decryptAes256GcmText(
      key,
      envelope,
      "connection|other-owner|gmail|v1",
    ),
  );

  const tamperedBytes = cryptoHelpers.decodeBase64Url(envelope.ciphertext);
  tamperedBytes[tamperedBytes.length - 1] ^= 1;
  await assert.rejects(
    cryptoHelpers.decryptAes256GcmText(
      key,
      { ...envelope, ciphertext: cryptoHelpers.encodeBase64Url(tamperedBytes) },
      "connection|owner|gmail|v1",
    ),
  );
  await assert.rejects(
    cryptoHelpers.importAes256GcmKey(new Uint8Array(16)),
    /exactly 32 bytes/,
  );
});

test("constant-time comparison handles strings, bytes, and unequal lengths", () => {
  assert.equal(cryptoHelpers.constantTimeEqual("same", "same"), true);
  assert.equal(cryptoHelpers.constantTimeEqual("same", "different"), false);
  assert.equal(
    cryptoHelpers.constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2)),
    true,
  );
  assert.equal(
    cryptoHelpers.constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0)),
    false,
  );
});

test("production cookies use __Host, Secure, HttpOnly, and intended SameSite modes", () => {
  const context = { appUrl: "https://mail.example.test", production: true };
  const value = cryptoHelpers.randomBase64Url(32);
  const session = cookies.serializeSessionCookie(value, context);
  const oauth = cookies.serializeOAuthCookie(value, context);

  assert.match(session, /^__Host-imail-session=/);
  assert.match(session, /; Path=\//);
  assert.match(session, /; HttpOnly/);
  assert.match(session, /; Secure/);
  assert.match(session, /; SameSite=Strict$/);
  assert.doesNotMatch(session, /Domain=/i);

  assert.match(oauth, /^__Host-imail-oauth=/);
  assert.match(oauth, /; Max-Age=600/);
  assert.match(oauth, /; SameSite=Lax$/);

  const cleared = cookies.clearSessionCookie(context);
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  assert.match(cleared, /SameSite=Strict$/);
});

test("HTTP cookies are supported only for explicit localhost development", () => {
  const context = { appUrl: "http://localhost:3000", production: false };
  const value = cryptoHelpers.randomBase64Url(32);
  const session = cookies.serializeSessionCookie(value, context);

  assert.match(session, /^imail-session=/);
  assert.doesNotMatch(session, /; Secure/);
  assert.match(session, /; SameSite=Strict$/);
  assert.throws(
    () => cookies.serializeSessionCookie(value, { ...context, production: true }),
    /require HTTPS/,
  );
  assert.throws(
    () =>
      cookies.serializeSessionCookie(value, {
        appUrl: "http://mail.example.test",
        production: false,
      }),
    /only on localhost/,
  );
});

test("cookie reads reject ambiguous duplicate names", () => {
  assert.equal(cookies.readCookieValue("a=one; session=token", "session"), "token");
  assert.equal(
    cookies.readCookieValue("session=first; a=one; session=second", "session"),
    null,
  );

  const context = { appUrl: "http://localhost:3000", production: false };
  assert.equal(
    cookies.readSessionCookie(
      new Request("http://localhost:3000", {
        headers: { cookie: "imail-session=not+a+base64url+token" },
      }),
      context,
    ),
    null,
  );
});

function mutationRequest({
  contentType = "application/json; charset=utf-8",
  csrf = "expected-csrf-token",
  fetchSite = "same-origin",
  method = "POST",
  origin = "https://mail.example.test",
  referer,
  url = "https://mail.example.test/api/messages",
} = {}) {
  const headers = new Headers();
  if (contentType !== null) headers.set("content-type", contentType);
  if (csrf !== null) headers.set("x-csrf-token", csrf);
  if (fetchSite !== null) headers.set("sec-fetch-site", fetchSite);
  if (origin !== null) headers.set("origin", origin);
  if (referer !== undefined) headers.set("referer", referer);
  return new Request(url, { headers, method });
}

const csrfOptions = {
  appUrl: "https://mail.example.test",
  expectedCsrfToken: "expected-csrf-token",
};

test("same-origin mutation validation accepts only the canonical target and source", () => {
  assert.deepEqual(
    requestSecurity.validateCsrfProtectedMutation(mutationRequest(), csrfOptions),
    { ok: true },
  );
  assert.equal(
    requestSecurity.validateCsrfProtectedMutation(
      mutationRequest({ url: "https://other.example.test/api/messages" }),
      csrfOptions,
    ).code,
    "invalid_target_origin",
  );
  assert.equal(
    requestSecurity.validateCsrfProtectedMutation(
      mutationRequest({ origin: "https://evil.example" }),
      csrfOptions,
    ).code,
    "invalid_origin",
  );
  assert.equal(
    requestSecurity.validateCsrfProtectedMutation(
      mutationRequest({ origin: null }),
      csrfOptions,
    ).code,
    "missing_origin",
  );
  assert.deepEqual(
    requestSecurity.validateCsrfProtectedMutation(
      mutationRequest({
        origin: null,
        referer: "https://mail.example.test/inbox",
      }),
      { ...csrfOptions, allowRefererFallback: true },
    ),
    { ok: true },
  );
});

test("Fetch Metadata, content type, method, and CSRF failures are explicit", () => {
  assert.equal(
    requestSecurity.validateCsrfProtectedMutation(
      mutationRequest({ fetchSite: "same-site" }),
      csrfOptions,
    ).code,
    "cross_site_request",
  );
  assert.equal(
    requestSecurity.validateCsrfProtectedMutation(
      mutationRequest({ fetchSite: null }),
      { ...csrfOptions, requireFetchMetadata: true },
    ).code,
    "cross_site_request",
  );
  assert.equal(
    requestSecurity.validateCsrfProtectedMutation(
      mutationRequest({ contentType: "text/plain" }),
      csrfOptions,
    ).status,
    415,
  );
  assert.equal(
    requestSecurity.validateCsrfProtectedMutation(
      mutationRequest({ method: "GET" }),
      csrfOptions,
    ).status,
    405,
  );
  assert.equal(
    requestSecurity.validateCsrfProtectedMutation(
      mutationRequest({ csrf: null }),
      csrfOptions,
    ).code,
    "missing_csrf_token",
  );
  assert.equal(
    requestSecurity.validateCsrfProtectedMutation(
      mutationRequest({ csrf: "wrong-token" }),
      csrfOptions,
    ).code,
    "invalid_csrf_token",
  );
  assert.throws(
    () =>
      requestSecurity.assertCsrfProtectedMutation(
        mutationRequest({ csrf: "wrong-token" }),
        csrfOptions,
      ),
    (error) => error.code === "invalid_csrf_token" && error.status === 403,
  );
});

test("OAuth start can reuse the strict same-origin guard without a CSRF token", () => {
  assert.deepEqual(
    requestSecurity.validateSameOriginMutation(mutationRequest({ csrf: null }), {
      appUrl: "https://mail.example.test",
    }),
    { ok: true },
  );
});

test("return paths remain canonical, relative, and within the allowlist", () => {
  assert.equal(
    requestSecurity.requireSafeReturnPath("/mail/inbox?account=gmail", {
      allowedPathPrefixes: ["/mail"],
    }),
    "/mail/inbox?account=gmail",
  );
  assert.equal(requestSecurity.requireSafeReturnPath(undefined), "/");

  for (const unsafePath of [
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/%2f%2fevil.example/",
    "/mail/../admin",
    "/mail#fragment",
    "/mail/%00bad",
    "/%E0%A4%A",
  ]) {
    assert.throws(() => requestSecurity.requireSafeReturnPath(unsafePath));
  }

  assert.throws(() =>
    requestSecurity.requireSafeReturnPath("/admin", {
      allowedPathPrefixes: ["/mail"],
    }),
  );
  assert.throws(() =>
    requestSecurity.requireSafeReturnPath("/mailbox", {
      allowedPathPrefixes: ["/mail"],
    }),
  );
});
