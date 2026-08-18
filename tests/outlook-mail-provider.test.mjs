import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let vite;
let OutlookMailProvider;
let OutlookGraphError;

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
  ({ OutlookMailProvider, OutlookGraphError } = await vite.ssrLoadModule(
    "/src/server/mail/outlook-provider.ts",
  ));
});

after(async () => {
  await vite?.close();
});

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function graphMessage(overrides = {}) {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    parentFolderId: "folder-inbox",
    subject: "Outlook subject",
    bodyPreview: "A short preview",
    body: { contentType: "text", content: "First paragraph.\n\nSecond paragraph." },
    from: { emailAddress: { name: "Sender", address: "sender@example.test" } },
    toRecipients: [
      { emailAddress: { name: "Owner", address: "owner@example.test" } },
    ],
    ccRecipients: [],
    bccRecipients: [],
    receivedDateTime: "2026-08-18T08:00:00Z",
    sentDateTime: "2026-08-18T07:59:00Z",
    lastModifiedDateTime: "2026-08-18T08:00:00Z",
    isRead: false,
    isDraft: false,
    flag: { flagStatus: "flagged" },
    categories: ["Reading"],
    hasAttachments: false,
    attachments: [],
    ...overrides,
  };
}

function provider(fetch, overrides = {}) {
  return new OutlookMailProvider({
    accountId: "connection-outlook",
    account: {
      address: "owner@outlook.com",
      label: "Personal Outlook",
      providerAccountId: "microsoft-user-1",
    },
    getAccessToken: () => "secret-access-token",
    graphBaseUrl: "https://graph.test/v1.0/",
    fetch,
    ...overrides,
  });
}

test("lists each Outlook message independently and follows only bound cursors", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init, headers: new Headers(init.headers) });
    if (url.searchParams.get("$skiptoken") === "next-page") {
      return json({
        value: [
          graphMessage({
            id: "message-3",
            conversationId: "conversation-native",
          }),
        ],
      });
    }
    return json({
      value: [
        graphMessage({
          id: "message-1",
          conversationId: "conversation-native",
          receivedDateTime: "2026-08-18T07:00:00Z",
        }),
        graphMessage({
          id: "message-2",
          conversationId: "conversation-native",
          receivedDateTime: "2026-08-18T09:00:00Z",
          subject: "Latest subject",
          attachments: [
            {
              id: "attachment-native",
              name: "notes.pdf",
              size: 2048,
              contentType: "application/pdf",
              isInline: false,
            },
          ],
        }),
      ],
      "@odata.nextLink":
        "https://graph.test/v1.0/me/mailFolders/inbox/messages?$skiptoken=next-page",
    });
  };
  const outlook = provider(fetch);

  assert.deepEqual(await outlook.getAccounts(), [
    {
      id: "connection-outlook",
      provider: "outlook",
      label: "Personal Outlook",
      address: "owner@outlook.com",
      color: "#3f78bd",
      connected: true,
      capabilities: {
        labels: false,
        reliableDraftUpdates: true,
        externalImages: false,
        permanentDelete: false,
      },
    },
  ]);
  assert.equal(calls.length, 0, "seeded connection data avoids an extra profile scope");

  const first = await outlook.getMessagesPage({
    scope: "outlook",
    folder: "inbox",
    pageSize: 2,
  });
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[0].id, "message-2");
  assert.equal(first.messages[0].conversationId, "conversation-native");
  assert.deepEqual(first.messages.map((message) => message.id), [
    "message-2",
    "message-1",
  ]);
  assert.equal(first.messages[0].receivedAtMs, Date.UTC(2026, 7, 18, 9));
  assert.equal(Number.isNaN(Date.parse(first.messages[0].receivedAtFull)), true);
  assert.deepEqual(first.messages[0].messages.map((message) => message.id), [
    "message-2",
  ]);
  assert.deepEqual(first.messages[1].messages.map((message) => message.id), [
    "message-1",
  ]);
  assert.deepEqual(first.messages[0].messages[0].attachments[0], {
    id: "attachment-native",
    name: "notes.pdf",
    size: "2 KB",
    kind: "document",
    mimeType: "application/pdf",
    sizeBytes: 2048,
  });
  assert.ok(first.nextCursor);

  const request = calls[0];
  assert.equal(request.url.pathname, "/v1.0/me/mailFolders/inbox/messages");
  assert.equal(request.url.searchParams.get("$top"), "2");
  assert.equal(
    request.url.searchParams.get("$select").split(",").includes("body"),
    false,
  );
  assert.equal(request.headers.get("authorization"), "Bearer secret-access-token");
  assert.match(request.headers.get("prefer"), /IdType="ImmutableId"/);
  assert.match(request.headers.get("prefer"), /outlook\.body-content-type="text"/);

  const second = await outlook.getMessagesPage({
    scope: "outlook",
    folder: "inbox",
    cursor: first.nextCursor,
  });
  assert.equal(second.messages[0].id, "message-3");
  assert.equal(second.messages[0].conversationId, "conversation-native");
  assert.notEqual(second.messages[0].id, first.messages[0].id);
  assert.equal(calls[1].url.searchParams.get("$skiptoken"), "next-page");

  await assert.rejects(
    outlook.getMessagesPage({
      scope: "outlook",
      folder: "trash",
      cursor: first.nextCursor,
    }),
    /does not match this query/,
  );
});

test("keeps searched Outlook pages on Graph's sentDateTime boundary", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.searchParams.get("$skiptoken") === "search-next") {
      return json({
        value: [
          graphMessage({
            id: "search-3",
            sentDateTime: "2026-08-18T10:00:00Z",
            receivedDateTime: "2026-08-19T03:00:00Z",
          }),
          graphMessage({
            id: "search-4",
            sentDateTime: "2026-08-18T09:00:00Z",
            receivedDateTime: "2026-08-19T04:00:00Z",
          }),
        ],
      });
    }
    return json({
      value: [
        graphMessage({
          id: "search-1",
          sentDateTime: "2026-08-18T12:00:00Z",
          receivedDateTime: "2026-08-18T01:00:00Z",
        }),
        graphMessage({
          id: "search-2",
          sentDateTime: "2026-08-18T11:00:00Z",
          receivedDateTime: "2026-08-18T23:00:00Z",
        }),
      ],
      "@odata.nextLink":
        "https://graph.test/v1.0/me/mailFolders/inbox/messages?$skiptoken=search-next",
    });
  };
  const outlook = provider(fetch);

  const first = await outlook.getMessagesPage({
    scope: "outlook",
    folder: "inbox",
    search: "quarterly forecast",
    pageSize: 2,
  });
  assert.deepEqual(first.messages.map(({ id }) => id), ["search-1", "search-2"]);
  assert.deepEqual(first.messages.map(({ receivedAtMs }) => receivedAtMs), [
    Date.UTC(2026, 7, 18, 12),
    Date.UTC(2026, 7, 18, 11),
  ]);
  assert.equal(calls[0].url.searchParams.get("$search"), '"quarterly forecast"');
  assert.equal(calls[0].url.searchParams.has("$orderby"), false);

  const second = await outlook.getMessagesPage({
    scope: "outlook",
    folder: "inbox",
    search: "quarterly forecast",
    cursor: first.nextCursor,
    pageSize: 2,
  });
  assert.deepEqual(second.messages.map(({ id }) => id), ["search-3", "search-4"]);
  assert.deepEqual(
    [...first.messages, ...second.messages].map(({ receivedAtMs }) => receivedAtMs),
    [
      Date.UTC(2026, 7, 18, 12),
      Date.UTC(2026, 7, 18, 11),
      Date.UTC(2026, 7, 18, 10),
      Date.UTC(2026, 7, 18, 9),
    ],
  );
  assert.equal(calls[1].url.searchParams.get("$skiptoken"), "search-next");
});

test("uses an order-compatible filter for stable Outlook Starred pages", async () => {
  const calls = [];
  const folderIds = {
    inbox: "folder-inbox",
    sentitems: "folder-sent",
    drafts: "folder-drafts",
    archive: "folder-archive",
    junkemail: "folder-spam",
    deleteditems: "folder-trash",
  };
  const fetch = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.endsWith("/me/messages")) return json({ value: [] });
    const folderMatch = url.pathname.match(/\/me\/mailFolders\/([^/]+)$/u);
    if (folderMatch) return json({ id: folderIds[folderMatch[1]] });
    throw new Error(`Unexpected Graph request: ${url}`);
  };
  const outlook = provider(fetch);

  assert.deepEqual(
    await outlook.getMessagesPage({
      scope: "outlook",
      folder: "starred",
      pageSize: 7,
    }),
    { messages: [] },
  );

  const request = calls.find((url) => url.pathname.endsWith("/me/messages"));
  assert.ok(request);
  assert.equal(request.searchParams.get("$top"), "7");
  assert.equal(
    request.searchParams.get("$filter"),
    "receivedDateTime ge 0001-01-01T00:00:00Z and flag/flagStatus eq 'flagged'",
  );
  assert.equal(request.searchParams.get("$orderby"), "receivedDateTime desc");
});

test("rejects Outlook Starred search before it can return a partial match set", async () => {
  let requestCount = 0;
  const outlook = provider(async () => {
    requestCount += 1;
    throw new Error("fetch must not run");
  });

  await assert.rejects(
    outlook.getMessagesPage({
      scope: "outlook",
      folder: "starred",
      search: "contract",
    }),
    (error) => {
      assert.equal(error.name, "OutlookUnsupportedQueryError");
      assert.equal(error.code, "OUTLOOK_STARRED_SEARCH_UNSUPPORTED");
      assert.match(error.message, /without returning incomplete results/u);
      return true;
    },
  );
  assert.equal(requestCount, 0);
});

test("reads one Graph message without fetching the rest of its conversation", async () => {
  const calls = [];
  const fetch = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.endsWith("/me/messages/message-seed")) {
      return json(
        graphMessage({
          id: "message-seed",
          conversationId: "conversation-native",
          parentFolderId: "folder-inbox",
          receivedDateTime: "2026-08-18T09:00:00Z",
          body: undefined,
        }),
      );
    }
    const folderMatch = url.pathname.match(/\/me\/mailFolders\/([^/]+)$/);
    if (folderMatch) {
      const folderIds = {
        inbox: "folder-inbox",
        sentitems: "folder-sent",
        drafts: "folder-drafts",
        archive: "folder-archive",
        junkemail: "folder-spam",
        deleteditems: "folder-trash",
      };
      return json({ id: folderIds[folderMatch[1]] });
    }
    throw new Error(`Unexpected Graph request: ${url}`);
  };
  const outlook = provider(fetch);

  const thread = await outlook.getMessage("message-seed");
  assert.equal(thread.id, "message-seed");
  assert.equal(thread.conversationId, "conversation-native");
  assert.equal(thread.folder, "inbox");
  assert.deepEqual(
    thread.messages.map((message) => message.id),
    ["message-seed"],
  );
  assert.deepEqual(thread.messages[0].body, ["A short preview"]);
  assert.equal(
    calls.some(
      (url) =>
        url.pathname.endsWith("/me/messages") && url.searchParams.has("$filter"),
    ),
    false,
  );
});

test("loads only Outlook drafts as safe plain text with source attachment metadata", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, headers: new Headers(init.headers) });
    if (url.pathname.endsWith("/messages/draft-native")) {
      return json({
        id: "draft-native",
        isDraft: true,
        subject: "Draft subject\u0000",
        body: {
          contentType: "html",
          content:
            "<p>Hello &amp; welcome</p><p>Second<br>line</p><script>alert(1)</script>",
        },
        toRecipients: [
          { emailAddress: { address: "to@example.test" } },
          { emailAddress: { address: "to@example.test" } },
        ],
        ccRecipients: [{ emailAddress: { address: "cc@example.test" } }],
        bccRecipients: [{ emailAddress: { address: "bcc@example.test" } }],
        attachments: [
          {
            id: "attachment-native",
            name: "notes.pdf",
            size: 2048,
            contentType: "application/pdf",
            isInline: false,
          },
        ],
      });
    }
    if (url.pathname.endsWith("/messages/not-a-draft")) {
      return json({ id: "not-a-draft", isDraft: false });
    }
    if (url.pathname.endsWith("/messages/missing-draft")) {
      return json(
        { error: { code: "ErrorItemNotFound" } },
        { status: 404 },
      );
    }
    throw new Error(`Unexpected Graph request: ${url}`);
  };
  const outlook = provider(fetch);

  const draft = await outlook.getDraft("draft-native");
  assert.deepEqual(draft, {
    id: "draft-native",
    accountId: "connection-outlook",
    to: ["to@example.test"],
    cc: ["cc@example.test"],
    bcc: ["bcc@example.test"],
    subject: "Draft subject",
    body: "Hello & welcome\nSecond\nline",
    attachments: [
      {
        id: "attachment-native",
        name: "notes.pdf",
        size: "2 KB",
        kind: "document",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        sourceMessageId: "draft-native",
      },
    ],
  });
  assert.equal("contentBase64" in draft.attachments[0], false);
  assert.equal(calls[0].url.searchParams.get("$select").includes("body"), true);
  assert.equal(
    calls[0].url.searchParams.get("$expand"),
    "attachments($select=id,name,size,contentType,isInline,contentId)",
  );
  assert.match(calls[0].headers.get("prefer"), /body-content-type="text"/u);
  assert.equal(await outlook.getDraft("not-a-draft"), null);
  assert.equal(await outlook.getDraft("missing-draft"), null);
});

test("repeated updates preserve a loaded draft attachment set without duplicates", async () => {
  const calls = [];
  const attachments = new Map([
    [
      "attachment-a",
      {
        id: "attachment-a",
        name: "a.pdf",
        size: 1024,
        contentType: "application/pdf",
        isInline: false,
      },
    ],
    [
      "attachment-b",
      {
        id: "attachment-b",
        name: "b.txt",
        size: 12,
        contentType: "text/plain",
        isInline: false,
      },
    ],
  ]);
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body });
    if (url.pathname.endsWith("/messages/draft-stable") && method === "GET") {
      return json({
        id: "draft-stable",
        isDraft: true,
        subject: "Stable attachments",
        body: { contentType: "text", content: "Body" },
        toRecipients: [{ emailAddress: { address: "to@example.test" } }],
        ccRecipients: [],
        bccRecipients: [],
        attachments: Array.from(attachments.values()),
      });
    }
    if (url.pathname.endsWith("/messages/draft-stable") && method === "PATCH") {
      return json({ id: "draft-stable", isDraft: true });
    }
    if (
      url.pathname.endsWith("/messages/draft-stable/attachments") &&
      method === "GET"
    ) {
      return json({ value: Array.from(attachments.values()) });
    }
    const attachmentMatch = url.pathname.match(
      /\/messages\/draft-stable\/attachments\/([^/]+)$/u,
    );
    if (attachmentMatch && method === "DELETE") {
      attachments.delete(decodeURIComponent(attachmentMatch[1]));
      return new Response(null, { status: 204 });
    }
    if (
      url.pathname.endsWith("/messages/draft-stable/attachments") &&
      method === "POST"
    ) {
      throw new Error("An existing attachment must not be uploaded again");
    }
    throw new Error(`Unexpected Graph request: ${method} ${url}`);
  };

  const loaded = await provider(fetch).getDraft("draft-stable");
  await provider(fetch).saveDraft({ ...loaded, subject: "First update" });
  await provider(fetch).saveDraft({ ...loaded, subject: "Second update" });
  assert.deepEqual(Array.from(attachments.keys()), [
    "attachment-a",
    "attachment-b",
  ]);
  assert.equal(
    calls.some(
      (call) =>
        call.method === "POST" && call.url.pathname.endsWith("/attachments"),
    ),
    false,
  );
  assert.equal(calls.some((call) => call.method === "DELETE"), false);

  const withoutSecondAttachment = {
    ...loaded,
    attachments: [loaded.attachments[0]],
  };
  await provider(fetch).saveDraft(withoutSecondAttachment);
  await provider(fetch).saveDraft(withoutSecondAttachment);
  assert.deepEqual(Array.from(attachments.keys()), ["attachment-a"]);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});

test("creates a draft, uploads supplied file content, and sends the immutable ID", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body });
    if (url.pathname.endsWith("/me/messages") && method === "POST") {
      return json({ id: "draft-native" }, { status: 201 });
    }
    if (
      url.pathname.endsWith("/me/messages/draft-native/attachments") &&
      method === "GET"
    ) {
      return json({ value: [] });
    }
    if (
      url.pathname.endsWith("/me/messages/draft-native/attachments") &&
      method === "POST"
    ) {
      return json({ id: "attachment-native" }, { status: 201 });
    }
    if (url.pathname.endsWith("/me/messages/draft-native/send")) {
      return new Response(null, { status: 202 });
    }
    throw new Error(`Unexpected Graph request: ${method} ${url}`);
  };
  const outlook = provider(fetch);
  const result = await outlook.sendMessage({
    accountId: "connection-outlook",
    to: ["reader@example.test"],
    cc: [],
    bcc: [],
    subject: "Graph draft",
    body: "Plain text body",
    attachments: [
      {
        id: "local-file-1",
        name: "note.txt",
        size: "5 B",
        kind: "document",
        mimeType: "text/plain",
        sizeBytes: 5,
        contentBase64: "aGVsbG8=",
      },
    ],
  });

  assert.deepEqual(result, { id: "draft-native" });
  const createBody = JSON.parse(calls[0].body);
  assert.equal(createBody.body.contentType, "Text");
  assert.equal(createBody.toRecipients[0].emailAddress.address, "reader@example.test");
  const attachmentBody = JSON.parse(calls[2].body);
  assert.equal(attachmentBody["@odata.type"], "#microsoft.graph.fileAttachment");
  assert.equal(attachmentBody.contentBytes, "aGVsbG8=");
  assert.deepEqual(
    calls.map(({ method, url }) => `${method} ${url.pathname}`),
    [
      "POST /v1.0/me/messages",
      "GET /v1.0/me/messages/draft-native/attachments",
      "POST /v1.0/me/messages/draft-native/attachments",
      "POST /v1.0/me/messages/draft-native/send",
    ],
  );
});

test("uploads large attachments in Graph-compliant 320 KiB ranges", async () => {
  const chunkSize = 10 * 320 * 1024;
  const bytes = Buffer.alloc(chunkSize + 7, 7);
  const ranges = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    if (url.pathname.endsWith("/me/messages") && method === "POST") {
      return json({ id: "large-draft" }, { status: 201 });
    }
    if (
      url.pathname.endsWith("/me/messages/large-draft/attachments") &&
      method === "GET"
    ) {
      return json({ value: [] });
    }
    if (url.pathname.endsWith("/attachments/createUploadSession")) {
      return json({
        uploadUrl: "https://uploads.example.test/session?opaque=1",
      });
    }
    if (url.origin === "https://uploads.example.test" && method === "PUT") {
      const headers = new Headers(init.headers);
      ranges.push({
        range: headers.get("content-range"),
        length: Number(headers.get("content-length")),
      });
      return new Response(null, {
        status: ranges.length === 1 ? 202 : 201,
        headers:
          ranges.length === 2
            ? {
                location:
                  "https://graph.test/v1.0/me/messages/large-draft/Attachments('native-large-id')",
              }
            : undefined,
      });
    }
    if (url.pathname.endsWith("/me/messages/large-draft/send")) {
      return new Response(null, { status: 202 });
    }
    throw new Error(`Unexpected Graph request: ${method} ${url}`);
  };
  const outlook = provider(fetch, {
    allowedUploadOrigins: ["https://uploads.example.test"],
  });

  await outlook.sendMessage({
    accountId: "connection-outlook",
    to: ["reader@example.test"],
    cc: [],
    bcc: [],
    subject: "Large attachment",
    body: "Attached.",
    attachments: [
      {
        id: "large-local-file",
        name: "large.bin",
        size: `${bytes.byteLength} B`,
        sizeBytes: bytes.byteLength,
        kind: "archive",
        mimeType: "application/octet-stream",
        contentBase64: bytes.toString("base64"),
      },
    ],
  });

  assert.deepEqual(ranges, [
    {
      range: `bytes 0-${chunkSize - 1}/${bytes.byteLength}`,
      length: chunkSize,
    },
    {
      range: `bytes ${chunkSize}-${bytes.byteLength - 1}/${bytes.byteLength}`,
      length: 7,
    },
  ]);
});

test("reply creates a linked draft and cleans up a standalone autosave", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    calls.push({ method, path: url.pathname, body: init.body });
    if (url.pathname.endsWith("/message-source/createReply")) {
      return json({ id: "reply-draft" }, { status: 201 });
    }
    if (url.pathname.endsWith("/messages/reply-draft") && method === "PATCH") {
      return json({ id: "reply-draft", isDraft: true });
    }
    if (url.pathname.endsWith("/messages/reply-draft/attachments")) {
      return json({ value: [] });
    }
    if (url.pathname.endsWith("/messages/reply-draft/send")) {
      return new Response(null, { status: 202 });
    }
    if (url.pathname.endsWith("/messages/standalone-autosave")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected Graph request: ${method} ${url}`);
  };
  const outlook = provider(fetch);
  const result = await outlook.replyMessage("message-source", {
    id: "standalone-autosave",
    accountId: "connection-outlook",
    to: ["sender@example.test"],
    cc: [],
    bcc: [],
    subject: "Re: Outlook subject",
    body: "Reply body",
    attachments: [],
  });

  assert.deepEqual(result, { id: "reply-draft" });
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    "POST /v1.0/me/messages/message-source/createReply",
    "PATCH /v1.0/me/messages/reply-draft",
    "GET /v1.0/me/messages/reply-draft/attachments",
    "POST /v1.0/me/messages/reply-draft/send",
    "DELETE /v1.0/me/messages/standalone-autosave",
  ]);
  assert.deepEqual(JSON.parse(calls[0].body), { comment: "Reply body" });
  assert.equal("body" in JSON.parse(calls[1].body), false);
});

test("forward uses a Graph comment without overwriting the original body", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    calls.push({ method, path: url.pathname, body: init.body });
    if (url.pathname.endsWith("/message-source/createForward")) {
      return json({ id: "forward-draft" }, { status: 201 });
    }
    if (url.pathname.endsWith("/messages/forward-draft") && method === "PATCH") {
      return json({ id: "forward-draft", isDraft: true });
    }
    if (url.pathname.endsWith("/messages/forward-draft/attachments")) {
      return json({ value: [{ id: "original-attachment", name: "original.pdf" }] });
    }
    if (url.pathname.endsWith("/messages/forward-draft/send")) {
      return new Response(null, { status: 202 });
    }
    throw new Error(`Unexpected Graph request: ${method} ${url}`);
  };
  const outlook = provider(fetch);
  await outlook.forwardMessage("message-source", {
    accountId: "connection-outlook",
    to: ["reader@example.test"],
    cc: [],
    bcc: [],
    subject: "Fwd: Outlook subject",
    body: "Please see below.",
    attachments: [],
  });

  assert.deepEqual(JSON.parse(calls[0].body), { comment: "Please see below." });
  const patch = JSON.parse(calls[1].body);
  assert.equal("body" in patch, false);
  assert.equal(patch.toRecipients[0].emailAddress.address, "reader@example.test");
  assert.equal(calls.some((call) => call.method === "DELETE"), false);
});

test("moves, marks read, and flags only the selected Outlook message", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body });
    if (url.pathname.endsWith("/mailFolders/inbox/messages")) {
      return json({ value: [graphMessage({ id: "message-action" })] });
    }
    if (url.pathname.endsWith("/move")) {
      return json({ id: "message-action" }, { status: 201 });
    }
    if (method === "PATCH" && url.pathname.endsWith("/messages/message-action")) {
      return json({ id: url.pathname.split("/").at(-1) });
    }
    if (url.pathname.endsWith("/messages/missing")) {
      return json(
        { error: { code: "ErrorItemNotFound", message: "not found" } },
        { status: 404 },
      );
    }
    throw new Error(`Unexpected Graph request: ${method} ${url}`);
  };
  const outlook = provider(fetch);
  await outlook.getMessages({ scope: "outlook", folder: "inbox" });

  const moved = await outlook.archiveMessages(["message-action", "missing"]);
  assert.deepEqual(moved.succeeded, ["message-action"]);
  assert.deepEqual(moved.previousLocations, [
    { id: "message-action", folder: "inbox" },
  ]);
  assert.equal(moved.failed[0].id, "missing");
  assert.match(moved.failed[0].reason, /404, ErrorItemNotFound/);

  assert.deepEqual(await outlook.markRead(["message-action"], true), {
    succeeded: ["message-action"],
    failed: [],
  });
  assert.deepEqual(await outlook.setStarred("message-action", true), {
    succeeded: ["message-action"],
    failed: [],
  });

  const moveBody = JSON.parse(
    calls.find((call) => call.url.pathname.endsWith("/move")).body,
  );
  assert.deepEqual(moveBody, { destinationId: "archive" });
  const patches = calls
    .filter((call) => call.method === "PATCH")
    .map((call) => JSON.parse(call.body));
  assert.deepEqual(patches, [
    { isRead: true },
    { flag: { flagStatus: "flagged" } },
  ]);
  const movedIds = calls
    .filter((call) => call.url.pathname.endsWith("/move"))
    .map((call) => call.url.pathname.split("/").at(-2));
  assert.deepEqual(movedIds, ["message-action"]);
});

test("moves a starred message from a custom folder without inventing an Inbox undo", async () => {
  const calls = [];
  const folderIds = {
    inbox: "folder-inbox",
    sentitems: "folder-sent",
    drafts: "folder-drafts",
    archive: "folder-archive",
    junkemail: "folder-spam",
    deleteditems: "folder-trash",
  };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body });
    const folderMatch = url.pathname.match(/\/me\/mailFolders\/([^/]+)$/u);
    if (folderMatch) return json({ id: folderIds[folderMatch[1]] });
    if (
      url.pathname.endsWith("/me/messages") &&
      url.searchParams.get("$filter") ===
        "receivedDateTime ge 0001-01-01T00:00:00Z and flag/flagStatus eq 'flagged'"
    ) {
      return json({
        value: [
          graphMessage({
            id: "message-custom",
            parentFolderId: "folder-user-created",
          }),
        ],
      });
    }
    if (url.pathname.endsWith("/messages/message-custom") && method === "GET") {
      return json({
        id: "message-custom",
        parentFolderId: "folder-user-created",
      });
    }
    if (url.pathname.endsWith("/messages/message-custom/move")) {
      return json({ id: "message-custom" }, { status: 201 });
    }
    throw new Error(`Unexpected Graph request: ${method} ${url}`);
  };
  const outlook = provider(fetch);

  const starred = await outlook.getMessagesPage({
    scope: "outlook",
    folder: "starred",
  });
  assert.equal(starred.messages[0].id, "message-custom");
  assert.equal(starred.messages[0].folder, "starred");

  const moved = await outlook.archiveMessages(["message-custom"]);
  assert.deepEqual(moved, {
    succeeded: ["message-custom"],
    failed: [],
    previousLocations: [],
  });
  assert.equal(
    calls.filter((call) => call.url.pathname.endsWith("/move")).length,
    1,
  );
});

test("downloads attachment bytes and returns the provider HTML body separately", async () => {
  const fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/attachments/attachment-native/$value")) {
      return new Response(Uint8Array.from([1, 2, 3]), {
        headers: { "content-type": "application/pdf" },
      });
    }
    if (url.pathname.endsWith("/attachments/attachment-native")) {
      return json({
        id: "attachment-native",
        name: "document.pdf",
        size: 3,
        contentType: "application/pdf",
        isInline: false,
      });
    }
    if (url.pathname.endsWith("/messages/message-native")) {
      return json({ body: { contentType: "html", content: "<p>Hello</p>" } });
    }
    throw new Error(`Unexpected Graph request: ${url}`);
  };
  const outlook = provider(fetch);

  const attachment = await outlook.getAttachment(
    "message-native",
    "attachment-native",
  );
  assert.deepEqual(Array.from(attachment.data), [1, 2, 3]);
  assert.equal(attachment.filename, "document.pdf");
  assert.equal(attachment.mimeType, "application/pdf");
  assert.equal(attachment.sizeBytes, 3);
  assert.deepEqual(await outlook.getRawMessageContent("message-native"), {
    content: "<p>Hello</p>",
    contentType: "text/html",
  });
});

test("rejects oversized Graph list and attachment responses before buffering", async () => {
  const oversizedList = provider(async () =>
    new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": String(4 * 1024 * 1024 + 1),
      },
    }),
  );
  await assert.rejects(
    oversizedList.getMessagesPage({ scope: "outlook", folder: "inbox" }),
    (error) => error instanceof OutlookGraphError && error.graphCode === "GraphResponseTooLarge",
  );

  const oversizedAttachment = provider(async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/attachments/attachment-native")) {
      return json({
        id: "attachment-native",
        name: "large.bin",
        size: 26 * 1024 * 1024,
        contentType: "application/octet-stream",
      });
    }
    if (url.pathname.endsWith("/attachments/attachment-native/$value")) {
      return new Response("x", {
        headers: { "content-length": String(26 * 1024 * 1024) },
      });
    }
    throw new Error(`Unexpected Graph request: ${url}`);
  });
  await assert.rejects(
    oversizedAttachment.getAttachment("message-native", "attachment-native"),
    (error) => error instanceof OutlookGraphError && error.graphCode === "AttachmentTooLarge",
  );
});

test("Graph failures expose safe metadata without response bodies or tokens", async () => {
  const fetch = async () =>
    json(
      {
        error: {
          code: "ErrorAccessDenied",
          message: "sensitive provider detail",
        },
      },
      {
        status: 403,
        headers: { "request-id": "request-1", "retry-after": "7" },
      },
    );
  const outlook = provider(fetch);

  await assert.rejects(
    outlook.getMessages({ scope: "outlook", folder: "inbox" }),
    (error) => {
      assert.ok(error instanceof OutlookGraphError);
      assert.equal(error.status, 403);
      assert.equal(error.graphCode, "ErrorAccessDenied");
      assert.equal(error.requestId, "request-1");
      assert.equal(error.retryAfter, "7");
      assert.doesNotMatch(error.message, /sensitive provider detail|secret-access-token/);
      return true;
    },
  );
});
