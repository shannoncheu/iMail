import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const accountId = "11111111-1111-4111-8111-111111111111";

let vite;
let ApiMailProvider;
let ApiMailProviderError;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    root: projectRoot,
    resolve: { alias: { "@": projectRoot } },
    server: { middlewareMode: true, hmr: false },
  });
  ({ ApiMailProvider, ApiMailProviderError } = await vite.ssrLoadModule(
    "/src/providers/mail/ApiMailProvider.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const threadFixture = {
  id: "thread-1",
  provider: "gmail",
  accountId,
  folder: "inbox",
  sender: { name: "Alice", email: "alice@example.test" },
  subject: "Status",
  preview: "The current status",
  receivedAt: "Aug 18",
  receivedAtFull: "2026-08-18T08:00:00.000Z",
  receivedAtMs: Date.UTC(2026, 7, 18, 8),
  unread: true,
  starred: false,
  labels: ["Work"],
  hasExternalImages: false,
  messages: [
    {
      id: "message-1",
      sender: { name: "Alice", email: "alice@example.test" },
      recipients: [{ name: "Owner", email: "owner@example.test" }],
      sentAt: "Aug 18",
      sentAtFull: "2026-08-18T08:00:00.000Z",
      body: ["The current status"],
      contentUrl: "/api/mail/content?messageId=message-1",
      attachments: [
        {
          id: "attachment-1",
          name: "status.pdf",
          size: "2 KB",
          kind: "document",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          downloadUrl:
            "/api/mail/attachment?messageId=message-1&attachmentId=attachment-1",
          contentBase64: "must-not-cross-the-response-boundary",
        },
      ],
    },
  ],
};

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers });
}

function createProvider(fetchImplementation) {
  return new ApiMailProvider({
    csrfToken: "csrf-token-123456789",
    fetchImplementation,
  });
}

test("maps BFF reads and preserves only same-origin content and attachment URLs", async () => {
  const calls = [];
  const provider = createProvider(async (input, init = {}) => {
    const url = new URL(String(input), "https://imail.example");
    calls.push({ input: String(input), url, init });
    if (url.pathname === "/api/mail/accounts") {
      return json({
        accounts: [
          {
            id: accountId,
            provider: "gmail",
            emailAddress: "owner@example.test",
            label: "Personal",
            status: "connected",
          },
        ],
      });
    }
    if (url.pathname === "/api/mail/folders") {
      return json({ folders: [{ id: "inbox", label: "Inbox", count: 3 }] });
    }
    if (url.pathname === "/api/mail/messages") {
      return json({ messages: [threadFixture], nextCursor: "next/page" });
    }
    if (url.pathname === "/api/mail/message") {
      if (url.searchParams.get("id") === "missing") {
        return json({ error: "not_found" }, 404);
      }
      return json({ message: threadFixture });
    }
    if (url.pathname === "/api/mail/draft") {
      if (url.searchParams.get("id") === "missing-draft") {
        return json({ error: "not_found" }, 404);
      }
      return json({
        draft: {
          id: "draft-public-id",
          accountId,
          to: ["reader@example.test"],
          cc: ["copy@example.test"],
          bcc: [],
          subject: "Saved work",
          body: "Continue here",
          attachments: [threadFixture.messages[0].attachments[0]],
          composeIntent: {
            mode: "reply",
            sourceId: "source-public-id",
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  assert.deepEqual(await provider.getAccounts(), [
    {
      id: accountId,
      provider: "gmail",
      label: "Personal",
      address: "owner@example.test",
      color: "#d96555",
      connected: true,
      capabilities: {
        labels: true,
        reliableDraftUpdates: true,
        externalImages: true,
        permanentDelete: false,
      },
    },
  ]);
  assert.deepEqual(await provider.getFolders("all"), [
    { id: "inbox", label: "Inbox", count: 3 },
  ]);
  assert.deepEqual(await provider.getFolders("gmail", accountId), [
    { id: "inbox", label: "Inbox", count: 3 },
  ]);
  const page = await provider.getMessagesPage({
    scope: "gmail",
    accountId,
    folder: "inbox",
    search: "a&b",
    cursor: "cursor/?",
    pageSize: 25,
  });
  assert.equal(page.nextCursor, "next/page");
  assert.equal(page.messages[0].receivedAtMs, threadFixture.receivedAtMs);
  assert.equal(page.messages[0].messages[0].contentUrl, threadFixture.messages[0].contentUrl);
  const attachment = page.messages[0].messages[0].attachments[0];
  assert.equal(attachment.downloadUrl, threadFixture.messages[0].attachments[0].downloadUrl);
  assert.equal("contentBase64" in attachment, false);
  assert.equal((await provider.getMessage("thread-1")).id, "thread-1");
  assert.equal(await provider.getMessage("missing"), null);
  const draft = await provider.getDraft("draft-public-id");
  assert.equal(draft.id, "draft-public-id");
  assert.deepEqual(draft.to, ["reader@example.test"]);
  assert.deepEqual(draft.composeIntent, {
    mode: "reply",
    sourceId: "source-public-id",
  });
  assert.equal(draft.attachments[0].downloadUrl, threadFixture.messages[0].attachments[0].downloadUrl);
  assert.equal(await provider.getDraft("missing-draft"), null);

  const foldersCalls = calls.filter((call) =>
    call.url.pathname.endsWith("/folders"),
  );
  assert.equal(foldersCalls[0].url.searchParams.get("scope"), "all");
  assert.equal(foldersCalls[0].url.searchParams.has("accountId"), false);
  assert.equal(foldersCalls[1].url.searchParams.get("scope"), "gmail");
  assert.equal(foldersCalls[1].url.searchParams.get("accountId"), accountId);
  const messagesCall = calls.find((call) => call.url.pathname.endsWith("/messages"));
  assert.equal(messagesCall.url.searchParams.get("scope"), "gmail");
  assert.equal(messagesCall.url.searchParams.get("accountId"), accountId);
  assert.equal(messagesCall.url.searchParams.get("folder"), "inbox");
  assert.equal(messagesCall.url.searchParams.get("search"), "a&b");
  assert.equal(messagesCall.url.searchParams.get("cursor"), "cursor/?");
  assert.equal(messagesCall.url.searchParams.get("pageSize"), "25");
  const messageCall = calls.find((call) => call.url.pathname.endsWith("/message"));
  assert.equal(messageCall.url.searchParams.get("id"), "thread-1");

  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.credentials, "same-origin");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(headers.has("x-csrf-token"), false);
    assert.match(call.input, /^\/api\/mail\//u);
  }
});

test("sends explicit CSRF-protected command payloads for every mutation", async () => {
  const calls = [];
  let sequence = 0;
  const provider = createProvider(async (input, init = {}) => {
    const url = new URL(String(input), "https://imail.example");
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    if (url.pathname === "/api/mail/drafts") {
      return json({ id: "draft-1", savedAt: "2026-08-18T08:00:00.000Z" });
    }
    if (["/api/mail/send", "/api/mail/reply", "/api/mail/forward"].includes(url.pathname)) {
      sequence += 1;
      return json({ id: `created-${sequence}` });
    }
    if (url.pathname === "/api/mail/mutate") {
      return json({
        succeeded: body.ids ?? body.locations?.map(({ id }) => id) ?? [],
        failed: [],
        ...(body.action === "trash"
          ? { previousLocations: [{ id: "thread-1", folder: "inbox" }] }
          : {}),
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const draft = {
    accountId,
    to: ["reader@example.test"],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: "Body",
    attachments: [
      {
        id: "new-attachment",
        name: "note.txt",
        size: "3 B",
        kind: "document",
        mimeType: "text/plain",
        sizeBytes: 3,
        contentBase64: "AQID",
      },
    ],
    composeIntent: {
      mode: "reply",
      sourceId: "source-public-id",
    },
  };

  assert.deepEqual(await provider.sendMessage(draft), { id: "created-1" });
  assert.deepEqual(await provider.saveDraft(draft), {
    id: "draft-1",
    savedAt: "2026-08-18T08:00:00.000Z",
  });
  assert.deepEqual(await provider.replyMessage("thread-1", draft), {
    id: "created-2",
  });
  assert.deepEqual(await provider.forwardMessage("thread-1", draft), {
    id: "created-3",
  });
  await provider.archiveMessages(["thread-1", "thread-1"]);
  assert.deepEqual(await provider.moveToTrash(["thread-1"]), {
    succeeded: ["thread-1"],
    failed: [],
    previousLocations: [{ id: "thread-1", folder: "inbox" }],
  });
  await provider.restoreFromTrash(["thread-1"]);
  await provider.restoreMessages([{ id: "thread-1", folder: "inbox" }]);
  await provider.markRead(["thread-1"], true);
  await provider.setStarred("thread-1", true);

  assert.equal(calls[0].url.pathname, "/api/mail/send");
  assert.equal(calls[0].body.attachments[0].contentBase64, "AQID");
  assert.deepEqual(calls[0].body.composeIntent, {
    mode: "reply",
    sourceId: "source-public-id",
  });
  assert.equal(calls[1].url.pathname, "/api/mail/drafts");
  assert.deepEqual(calls[2].body.id, "thread-1");
  assert.deepEqual(calls[3].body.id, "thread-1");
  assert.deepEqual(
    calls.slice(4).map(({ body }) => body),
    [
      { action: "archive", ids: ["thread-1"] },
      { action: "trash", ids: ["thread-1"] },
      { action: "restoreTrash", ids: ["thread-1"] },
      {
        action: "restore",
        locations: [{ id: "thread-1", folder: "inbox" }],
      },
      { action: "read", ids: ["thread-1"], read: true },
      { action: "star", id: "thread-1", starred: true },
    ],
  );
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(call.init.method, "POST");
    assert.equal(headers.get("x-csrf-token"), "csrf-token-123456789");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(call.init.credentials, "same-origin");
    assert.equal(call.init.redirect, "error");
  }
});

test("normalizes HTTP, network, and malformed-response failures", async () => {
  const limited = createProvider(async () =>
    json(
      { error: "rate_limited", detail: "sensitive server detail" },
      429,
      { "Retry-After": "12" },
    ),
  );
  await assert.rejects(limited.getAccounts(), (error) => {
    assert.equal(error instanceof ApiMailProviderError, true);
    assert.equal(error.status, 429);
    assert.equal(error.reason, "rate_limited");
    assert.equal(error.retryAfterSeconds, 12);
    assert.equal(error.message, "Too many mail requests were sent");
    assert.doesNotMatch(error.message, /sensitive/u);
    return true;
  });

  const offline = createProvider(async () => {
    throw new Error("browser details must not escape");
  });
  await assert.rejects(offline.getAccounts(), (error) => {
    assert.equal(error.status, 0);
    assert.equal(error.reason, "network_error");
    assert.doesNotMatch(error.message, /browser details/u);
    return true;
  });

  const malformed = createProvider(async () =>
    new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }),
  );
  await assert.rejects(malformed.getAccounts(), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.reason, "invalid_response");
    return true;
  });
});

test("rejects cross-origin response URLs and invalid inputs before fetching", async () => {
  const crossOrigin = structuredClone(threadFixture);
  crossOrigin.messages[0].contentUrl = "https://attacker.example/content";
  const provider = createProvider(async () =>
    json({ messages: [crossOrigin] }),
  );
  await assert.rejects(
    provider.getMessages({ scope: "all", folder: "inbox" }),
    /invalid message content URL/iu,
  );

  const invalidTimestamp = structuredClone(threadFixture);
  invalidTimestamp.receivedAtMs = 1.5;
  const invalidTimestampProvider = createProvider(async () =>
    json({ messages: [invalidTimestamp] }),
  );
  await assert.rejects(
    invalidTimestampProvider.getMessages({ scope: "all", folder: "inbox" }),
    /invalid thread timestamp/iu,
  );

  assert.throws(
    () => new ApiMailProvider({ csrfToken: "bad\r\ntoken" }),
    /valid CSRF token/iu,
  );
  let fetchCalls = 0;
  const guarded = createProvider(async () => {
    fetchCalls += 1;
    return json({ messages: [] });
  });
  await assert.rejects(
    guarded.getMessages({ scope: "all", folder: "inbox", pageSize: 101 }),
    /Invalid message page size/u,
  );
  await assert.rejects(
    guarded.getMessages({ scope: "all", folder: "inbox", search: "x".repeat(257) }),
    /Invalid message search/u,
  );
  await assert.rejects(
    guarded.getFolders("all", accountId),
    /account filter requires a provider scope/u,
  );
  await assert.rejects(
    guarded.getMessages({ scope: "all", accountId, folder: "inbox" }),
    /account filter requires a provider scope/u,
  );
  await assert.rejects(
    guarded.getFolders("gmail", "not-an-account-id"),
    /Invalid mail account filter id/u,
  );
  await assert.rejects(
    guarded.restoreMessages([{ id: "thread-1", folder: "unknown" }]),
    /Invalid mail folder/u,
  );
  await assert.rejects(
    guarded.sendMessage({
      accountId,
      to: [],
      cc: [],
      bcc: [],
      subject: "x".repeat(999),
      body: "",
      attachments: [],
    }),
    /Invalid draft subject/u,
  );
  assert.equal(fetchCalls, 0);
});
