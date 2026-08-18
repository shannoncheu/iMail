import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let GmailApiError;
let GmailMailProvider;
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
    resolve: { alias: { "@": projectRoot } },
    ssr: { noExternal: ["server-only"] },
    server: { middlewareMode: true, hmr: false },
  });
  ({ GmailApiError, GmailMailProvider } = await vite.ssrLoadModule(
    "/src/server/mail/gmail/GmailMailProvider.ts",
  ));
});

after(async () => {
  await vite?.close();
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeRaw(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function mockFetch(handler) {
  const calls = [];
  const implementation = async (input, init = {}) => {
    const call = {
      url: new URL(String(input)),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body) : undefined,
      redirect: init.redirect,
      cache: init.cache,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  implementation.calls = calls;
  return implementation;
}

function messageFixture({
  id = "message-native-1",
  threadId = "thread-native-1",
  labels = ["INBOX", "UNREAD", "STARRED", "Label_1"],
  subject = "=?UTF-8?B?5pel5pys6KqeIOODhuOCueODiA==?=",
} = {}) {
  return {
    id,
    threadId,
    labelIds: labels,
    internalDate: "1787018400000",
    snippet: "Hello &amp; welcome",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: '"Lina Park" <lina@example.com>' },
        { name: "To", value: "Owner <owner@gmail.com>" },
        { name: "Subject", value: subject },
        { name: "Date", value: "Tue, 18 Aug 2026 10:00:00 +0000" },
        { name: "Message-ID", value: "<message-1@example.com>" },
      ],
      parts: [
        {
          partId: "0",
          mimeType: "multipart/alternative",
          parts: [
            {
              partId: "0.0",
              mimeType: "text/plain",
              headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
              body: { data: base64Url("First paragraph.\n\nSecond paragraph.") },
            },
            {
              partId: "0.1",
              mimeType: "text/html",
              headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
              body: {
                data: base64Url(
                  '<p>First paragraph.</p><img src="https://tracking.example/pixel.png">',
                ),
              },
            },
          ],
        },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "review.pdf",
          headers: [{ name: "Content-Disposition", value: "attachment" }],
          body: { attachmentId: "attachment-native-1", size: 2048 },
        },
      ],
    },
  };
}

function metadataMessageFixture(options = {}) {
  const message = messageFixture(options);
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds,
    internalDate: message.internalDate,
    snippet: message.snippet,
    payload: {
      mimeType: message.payload.mimeType,
      headers: message.payload.headers,
    },
  };
}

function provider(fetchImplementation, overrides = {}) {
  return new GmailMailProvider({
    accountId: "gmail-account-1",
    accessToken: "access-token-for-tests",
    emailAddress: "owner@gmail.com",
    fetchImplementation,
    now: () => new Date("2026-08-18T12:00:00.000Z"),
    ...overrides,
  });
}

test("lists Gmail threads from metadata without loading message bodies", async () => {
  const fetchImplementation = mockFetch((call) => {
    if (call.url.pathname.endsWith("/threads")) {
      assert.equal(call.url.searchParams.get("labelIds"), "INBOX");
      assert.equal(call.url.searchParams.get("q"), "from:lina@example.com");
      assert.equal(call.url.searchParams.get("pageToken"), "page-1");
      assert.equal(call.url.searchParams.get("maxResults"), "25");
      return json({ threads: [{ id: "thread-native-1" }], nextPageToken: "page-2" });
    }
    if (call.url.pathname.endsWith("/labels")) {
      return json({ labels: [{ id: "Label_1", name: "Review", type: "user" }] });
    }
    if (call.url.pathname.endsWith("/threads/thread-native-1")) {
      assert.equal(call.url.searchParams.get("format"), "metadata");
      assert.deepEqual(call.url.searchParams.getAll("metadataHeaders"), [
        "From",
        "To",
        "Cc",
        "Bcc",
        "Subject",
        "Date",
      ]);
      return json({
        id: "thread-native-1",
        snippet: "Thread snippet",
        messages: [metadataMessageFixture()],
      });
    }
    throw new Error(`Unexpected request: ${call.url}`);
  });

  const result = await provider(fetchImplementation).getMessagesPage({
    scope: "gmail",
    folder: "inbox",
    search: "from:lina@example.com",
    cursor: "page-1",
    pageSize: 25,
  });

  assert.equal(result.nextCursor, "page-2");
  assert.equal(result.messages.length, 1);
  const [thread] = result.messages;
  assert.equal(thread.id, "thread-native-1");
  assert.equal(thread.messages[0].id, "message-native-1");
  assert.deepEqual(thread.messages[0].attachments, []);
  assert.deepEqual(thread.messages[0].body, []);
  assert.equal(thread.sender.email, "lina@example.com");
  assert.equal(thread.subject, "日本語 テスト");
  assert.equal(thread.preview, "Hello & welcome");
  assert.equal(thread.receivedAtMs, 1787018400000);
  assert.equal(Number.isNaN(Date.parse(thread.receivedAtFull)), true);
  assert.equal(thread.unread, true);
  assert.equal(thread.starred, true);
  assert.equal(thread.hasExternalImages, false);
  assert.deepEqual(thread.labels, ["Review"]);
  assert.equal(thread.folder, "inbox");
  assert.equal(fetchImplementation.calls[0].headers.get("Authorization"), "Bearer access-token-for-tests");
  assert.equal(fetchImplementation.calls[0].redirect, "error");
  assert.equal(fetchImplementation.calls[0].cache, "no-store");
});

test("uses drafts.list and preserves the native draft ID", async () => {
  const draftMessage = metadataMessageFixture({
    id: "draft-message-native",
    threadId: "draft-thread-native",
    labels: ["DRAFT"],
    subject: "Draft subject",
  });
  const fetchImplementation = mockFetch((call) => {
    if (call.url.pathname.endsWith("/drafts")) {
      assert.equal(call.url.searchParams.get("q"), "subject:draft");
      return json({
        drafts: [{ id: "draft-native-1", message: { id: "draft-message-native" } }],
      });
    }
    if (call.url.pathname.endsWith("/labels")) return json({ labels: [] });
    if (call.url.pathname.endsWith("/messages/draft-message-native")) {
      assert.equal(call.url.searchParams.get("format"), "metadata");
      assert.deepEqual(call.url.searchParams.getAll("metadataHeaders"), [
        "From",
        "To",
        "Cc",
        "Bcc",
        "Subject",
        "Date",
      ]);
      return json(draftMessage);
    }
    throw new Error(`Unexpected request: ${call.url}`);
  });

  const drafts = await provider(fetchImplementation).getMessages({
    scope: "all",
    folder: "drafts",
    search: "subject:draft",
  });

  assert.equal(drafts[0].id, "draft-native-1");
  assert.equal(drafts[0].messages[0].id, "draft-message-native");
  assert.deepEqual(drafts[0].messages[0].body, []);
  assert.equal(drafts[0].folder, "drafts");
  assert.equal(drafts[0].receivedAt, "Draft");
});

test("loads a native draft and updates the same draft with resolved attachments", async () => {
  const draftMessage = messageFixture({
    id: "draft-message-native",
    threadId: "draft-thread-native",
    labels: ["DRAFT"],
  });
  draftMessage.payload.headers.find(
    (header) => header.name.toLowerCase() === "to",
  ).value = '"Primary, Person" <primary@example.com>, secondary@example.com';
  draftMessage.payload.headers.push(
    { name: "Cc", value: "Copy Person <copy@example.com>" },
    { name: "Bcc", value: "blind@example.com" },
  );
  const attachmentBytes = Buffer.from("%PDF existing draft attachment", "utf8");
  const resolvedAttachments = [];
  const fetchImplementation = mockFetch((call) => {
    if (
      call.url.pathname.endsWith("/drafts/draft-native-1") &&
      call.method === "GET"
    ) {
      assert.equal(call.url.searchParams.get("format"), "full");
      const fields = call.url.searchParams.get("fields") ?? "";
      assert.match(fields, /^id,message\(id,payload\(/u);
      assert.match(fields, /body\(attachmentId,size,data\)/u);
      return json({ id: "draft-native-1", message: draftMessage });
    }
    if (
      call.url.pathname.endsWith("/drafts/draft-native-1") &&
      call.method === "PUT"
    ) {
      const raw = decodeRaw(call.body.message.raw);
      assert.match(raw, /To: primary@example\.com, secondary@example\.com/u);
      assert.match(raw, /Cc: copy@example\.com/u);
      assert.match(raw, /Bcc: blind@example\.com/u);
      assert.match(raw, /Subject: =\?UTF-8\?B\?5pel5pys6KqeIOODhuOCueODiA==\?=/u);
      assert.match(raw, /Content-Type: multipart\/mixed/u);
      assert.match(raw, /filename="review\.pdf"/u);
      assert.match(raw, new RegExp(attachmentBytes.toString("base64"), "u"));
      assert.match(
        raw,
        new RegExp(
          Buffer.from(
            "First paragraph.\r\n\r\nSecond paragraph.",
            "utf8",
          ).toString("base64"),
          "u",
        ),
      );
      return json({ id: "draft-native-1", message: { id: "draft-message-native" } });
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });
  const gmail = provider(fetchImplementation, {
    attachmentResolver: async (attachment) => {
      resolvedAttachments.push(attachment);
      return {
        data: attachmentBytes,
        filename: attachment.name,
        mimeType: attachment.mimeType,
      };
    },
  });

  const draft = await gmail.getDraft("draft-native-1");

  assert.deepEqual(draft, {
    id: "draft-native-1",
    accountId: "gmail-account-1",
    to: ["primary@example.com", "secondary@example.com"],
    cc: ["copy@example.com"],
    bcc: ["blind@example.com"],
    subject: "日本語 テスト",
    body: "First paragraph.\n\nSecond paragraph.",
    attachments: [
      {
        id: "attachment-native-1",
        name: "review.pdf",
        size: "2 KB",
        kind: "document",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        sourceMessageId: "draft-message-native",
      },
    ],
  });
  assert.equal("contentBase64" in draft.attachments[0], false);

  const saved = await gmail.saveDraft(draft);

  assert.equal(saved.id, "draft-native-1");
  assert.equal(resolvedAttachments.length, 1);
  assert.equal(resolvedAttachments[0].id, "attachment-native-1");
  assert.equal(resolvedAttachments[0].sourceMessageId, "draft-message-native");
  assert.deepEqual(
    fetchImplementation.calls.map((call) => call.method),
    ["GET", "PUT"],
  );
});

test("returns null when the native Gmail draft no longer exists", async () => {
  const fetchImplementation = mockFetch((call) => {
    assert.equal(call.url.pathname.endsWith("/drafts/missing-draft"), true);
    assert.equal(call.url.searchParams.get("format"), "full");
    return json({ error: { code: 404, message: "Not found" } }, 404);
  });

  assert.equal(await provider(fetchImplementation).getDraft("missing-draft"), null);
  assert.equal(fetchImplementation.calls.length, 1);
});

test("applies Gmail body and attachment limits while loading drafts", async () => {
  const oversizedBody = messageFixture({
    id: "draft-message-body-limit",
    labels: ["DRAFT"],
  });
  oversizedBody.payload.parts[0].parts[0].body.size = 5 * 1024 * 1024 + 1;
  const bodyFetch = mockFetch(() =>
    json({ id: "draft-body-limit", message: oversizedBody }),
  );
  await assert.rejects(
    provider(bodyFetch).getDraft("draft-body-limit"),
    /message body exceeds the safety limit/u,
  );
  assert.equal(bodyFetch.calls.length, 1);

  const oversizedAttachment = messageFixture({
    id: "draft-message-attachment-limit",
    labels: ["DRAFT"],
  });
  oversizedAttachment.payload.parts[1].body.size = 10 * 1024 * 1024 + 1;
  const attachmentFetch = mockFetch(() =>
    json({ id: "draft-attachment-limit", message: oversizedAttachment }),
  );
  await assert.rejects(
    provider(attachmentFetch).getDraft("draft-attachment-limit"),
    /10 MiB safety limit/u,
  );
  assert.equal(attachmentFetch.calls.length, 1);
});

test("reads profile and system-label counts without exposing permanent deletion", async () => {
  const fetchImplementation = mockFetch((call) => {
    if (call.url.pathname.endsWith("/profile")) {
      return json({ emailAddress: "owner@gmail.com" });
    }
    if (call.url.pathname.endsWith("/labels")) {
      return json({
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "SENT", name: "SENT", type: "system" },
        ],
      });
    }
    if (call.url.pathname.endsWith("/labels/INBOX")) {
      return json({ id: "INBOX", name: "INBOX", threadsUnread: 4, threadsTotal: 9 });
    }
    if (call.url.pathname.endsWith("/labels/SENT")) {
      return json({ id: "SENT", name: "SENT", threadsTotal: 12 });
    }
    throw new Error(`Unexpected request: ${call.url}`);
  });
  const gmail = new GmailMailProvider({
    accountId: "gmail-account-1",
    accessToken: "access-token-for-tests",
    fetchImplementation,
  });

  const [account] = await gmail.getAccounts();
  const folders = await gmail.getFolders("gmail");

  assert.equal(account.address, "owner@gmail.com");
  assert.equal(account.capabilities.permanentDelete, false);
  assert.equal(folders.find((folder) => folder.id === "inbox").count, 4);
  assert.equal(folders.find((folder) => folder.id === "sent").count, 12);
  assert.equal(folders.find((folder) => folder.id === "archive").count, undefined);
});

test("creates and replaces drafts, then sends them with MIME attachment bytes", async () => {
  const fetchImplementation = mockFetch((call) => {
    if (call.url.pathname.endsWith("/drafts") && call.method === "POST") {
      assert.match(decodeRaw(call.body.message.raw), /Subject: First draft/);
      return json({ id: "draft-native-2", message: { id: "draft-message-2" } });
    }
    if (call.url.pathname.endsWith("/drafts/draft-native-2") && call.method === "PUT") {
      const raw = decodeRaw(call.body.message.raw);
      assert.match(raw, /Content-Type: multipart\/mixed/);
      assert.match(raw, /filename="notes\.txt"/);
      assert.match(raw, /aGVsbG8=/);
      return json({ id: "draft-native-2", message: { id: "draft-message-2" } });
    }
    if (call.url.pathname.endsWith("/drafts/send")) {
      assert.deepEqual(call.body, { id: "draft-native-2" });
      return json({ id: "sent-message-native", threadId: "sent-thread-native" });
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });
  const gmail = provider(fetchImplementation);

  const saved = await gmail.saveDraft({
    accountId: "gmail-account-1",
    to: [],
    cc: [],
    bcc: [],
    subject: "First draft",
    body: "Draft body",
    attachments: [],
  });
  assert.equal(saved.id, "draft-native-2");

  const sent = await gmail.sendMessage({
    id: saved.id,
    accountId: "gmail-account-1",
    to: ["reader@example.com"],
    cc: [],
    bcc: [],
    subject: "First draft",
    body: "Draft body",
    attachments: [
      {
        id: "upload-1",
        name: "notes.txt",
        size: "5 B",
        sizeBytes: 5,
        mimeType: "text/plain",
        contentBase64: "aGVsbG8=",
        kind: "document",
      },
    ],
  });
  assert.equal(sent.id, "sent-message-native");
});

test("sends replies in the original thread with RFC reply headers", async () => {
  const original = messageFixture({ subject: "Quarterly report" });
  original.payload.headers.push({
    name: "References",
    value: "<older@example.com>",
  });
  const fetchImplementation = mockFetch((call) => {
    if (call.url.pathname.endsWith("/threads/thread-native-1")) {
      assert.equal(call.url.searchParams.get("format"), "metadata");
      assert.deepEqual(call.url.searchParams.getAll("metadataHeaders"), [
        "Message-ID",
        "References",
        "Subject",
      ]);
      return json({ id: "thread-native-1", messages: [original] });
    }
    if (call.url.pathname.endsWith("/messages/send")) {
      assert.equal(call.body.threadId, "thread-native-1");
      const raw = decodeRaw(call.body.raw);
      assert.match(raw, /In-Reply-To: <message-1@example\.com>/);
      assert.match(
        raw,
        /References: <older@example\.com> <message-1@example\.com>/,
      );
      assert.match(raw, /Subject: Re: Quarterly report/);
      return json({ id: "reply-message-native", threadId: "thread-native-1" });
    }
    throw new Error(`Unexpected request: ${call.url}`);
  });

  const result = await provider(fetchImplementation).replyMessage(
    "thread-native-1",
    {
      accountId: "gmail-account-1",
      to: ["lina@example.com"],
      cc: [],
      bcc: [],
      subject: "Re: Quarterly report",
      body: "Thanks, received.",
      attachments: [],
    },
  );
  assert.equal(result.id, "reply-message-native");
});

test("forwards the latest message body and its attachments as a new thread", async () => {
  const original = messageFixture({ subject: "Quarterly report" });
  const fetchImplementation = mockFetch((call) => {
    if (call.url.pathname.endsWith("/threads/thread-native-1")) {
      assert.equal(call.url.searchParams.get("format"), "full");
      assert.doesNotMatch(call.url.searchParams.get("fields") ?? "", /\bdata\b/u);
      return json({ id: "thread-native-1", messages: [original] });
    }
    if (call.url.pathname.endsWith("/messages/message-native-1")) {
      assert.equal(call.url.searchParams.get("format"), "full");
      assert.match(call.url.searchParams.get("fields") ?? "", /\bdata\b/u);
      return json(original);
    }
    if (
      call.url.pathname.endsWith(
        "/messages/message-native-1/attachments/attachment-native-1",
      )
    ) {
      return json({ data: base64Url("PDF"), size: 3 });
    }
    if (call.url.pathname.endsWith("/messages/send")) {
      assert.equal("threadId" in call.body, false);
      const raw = decodeRaw(call.body.raw);
      const encodedBody = raw
        .split("Content-Transfer-Encoding: base64\r\n\r\n")[1]
        .split("\r\n--")[0]
        .replaceAll("\r\n", "");
      assert.match(Buffer.from(encodedBody, "base64").toString("utf8"), /Forwarded message/);
      assert.match(raw, /filename="review\.pdf"/);
      assert.match(raw, /UERG/);
      return json({ id: "forward-message-native", threadId: "forward-thread-native" });
    }
    throw new Error(`Unexpected request: ${call.url}`);
  });

  const result = await provider(fetchImplementation).forwardMessage(
    "thread-native-1",
    {
      accountId: "gmail-account-1",
      to: ["reader@example.com"],
      cc: [],
      bcc: [],
      subject: "Fwd: Quarterly report",
      body: "For reference.",
      attachments: [],
    },
  );
  assert.equal(result.id, "forward-message-native");
});

test("counts draft and inherited attachments in the same 5 MiB forward budget", async () => {
  const original = messageFixture({ subject: "Quarterly report" });
  original.payload.parts[1].body.size = 2 * 1024 * 1024 + 1;
  const fetchImplementation = mockFetch((call) => {
    if (call.url.pathname.endsWith("/threads/thread-native-1")) {
      return json({ id: "thread-native-1", messages: [original] });
    }
    if (call.url.pathname.endsWith("/messages/message-native-1")) {
      return json(original);
    }
    throw new Error(`Inherited attachment must not be downloaded: ${call.url}`);
  });
  let resolverCalls = 0;

  await assert.rejects(
    provider(fetchImplementation, {
      attachmentResolver: async () => {
        resolverCalls += 1;
        return {
          data: new Uint8Array(3 * 1024 * 1024),
          filename: "existing.bin",
          mimeType: "application/octet-stream",
        };
      },
    }).forwardMessage("thread-native-1", {
      accountId: "gmail-account-1",
      to: ["reader@example.com"],
      cc: [],
      bcc: [],
      subject: "Fwd: Quarterly report",
      body: "For reference.",
      attachments: [
        {
          id: "existing-attachment",
          name: "existing.bin",
          size: "3 MiB",
          kind: "archive",
          mimeType: "application/octet-stream",
          sizeBytes: 3 * 1024 * 1024,
        },
      ],
    }),
    /Total attachment content is too large/u,
  );

  assert.equal(resolverCalls, 1);
  assert.equal(
    fetchImplementation.calls.some((call) => call.url.pathname.includes("/attachments/")),
    false,
  );
});

test("downloads inherited forward attachments sequentially and stops at the 5 MiB budget", async () => {
  const firstAttachmentBytes = 2 * 1024 * 1024 + 1;
  const original = messageFixture({ subject: "Quarterly report" });
  original.payload.parts[1].body.size = 0;
  original.payload.parts.push({
    partId: "2",
    mimeType: "application/zip",
    filename: "archive.zip",
    headers: [{ name: "Content-Disposition", value: "attachment" }],
    body: {
      attachmentId: "attachment-native-2",
      size: 3 * 1024 * 1024,
    },
  });
  const fetchImplementation = mockFetch((call) => {
    if (call.url.pathname.endsWith("/threads/thread-native-1")) {
      return json({ id: "thread-native-1", messages: [original] });
    }
    if (call.url.pathname.endsWith("/messages/message-native-1")) {
      return json(original);
    }
    if (
      call.url.pathname.endsWith(
        "/messages/message-native-1/attachments/attachment-native-1",
      )
    ) {
      return json({
        data: Buffer.alloc(firstAttachmentBytes).toString("base64url"),
        size: firstAttachmentBytes,
      });
    }
    throw new Error(`Later attachment must not be downloaded: ${call.url}`);
  });

  await assert.rejects(
    provider(fetchImplementation).forwardMessage("thread-native-1", {
      accountId: "gmail-account-1",
      to: ["reader@example.com"],
      cc: [],
      bcc: [],
      subject: "Fwd: Quarterly report",
      body: "For reference.",
      attachments: [],
    }),
    /Total attachment content is too large/u,
  );

  assert.equal(
    fetchImplementation.calls.filter((call) =>
      call.url.pathname.includes("/attachments/"),
    ).length,
    1,
  );
});

test("applies Gmail thread labels and reports partial operation failures", async () => {
  const fetchImplementation = mockFetch((call) => {
    if (call.url.pathname.endsWith("/threads/thread-native-1") && call.method === "GET") {
      return json({
        id: "thread-native-1",
        messages: [{ id: "message-1", labelIds: ["INBOX"] }],
      });
    }
    if (call.url.pathname.endsWith("/threads/missing") && call.method === "GET") {
      return json({ error: { status: "NOT_FOUND" } }, 404);
    }
    if (call.url.pathname.endsWith("/threads/thread-native-1/modify")) {
      assert.deepEqual(call.body, { addLabelIds: [], removeLabelIds: ["INBOX"] });
      return json({ id: "thread-native-1" });
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });

  const result = await provider(fetchImplementation).archiveMessages([
    "thread-native-1",
    "missing",
    "thread-native-1",
  ]);

  assert.deepEqual(result.succeeded, ["thread-native-1"]);
  assert.deepEqual(result.failed, [{ id: "missing", reason: "Message not found" }]);
  assert.deepEqual(result.previousLocations, [
    { id: "thread-native-1", folder: "inbox" },
  ]);
});

test("loads attachment metadata separately and lazily reads original HTML content", async () => {
  const fixture = messageFixture();
  let messageDetailRequests = 0;
  const fetchImplementation = mockFetch((call) => {
    if (call.url.pathname.endsWith("/labels")) return json({ labels: [] });
    if (call.url.pathname.endsWith("/threads/thread-native-1")) {
      assert.equal(call.url.searchParams.get("format"), "full");
      assert.doesNotMatch(call.url.searchParams.get("fields") ?? "", /\bdata\b/u);
      return json({ id: "thread-native-1", messages: [fixture] });
    }
    if (call.url.pathname.endsWith("/messages/message-native-1")) {
      assert.equal(call.url.searchParams.get("format"), "full");
      const fields = call.url.searchParams.get("fields") ?? "";
      if (messageDetailRequests === 0) assert.doesNotMatch(fields, /\bdata\b/u);
      else assert.match(fields, /\bdata\b/u);
      messageDetailRequests += 1;
      return json(fixture);
    }
    if (
      call.url.pathname.endsWith(
        "/messages/message-native-1/attachments/attachment-native-1",
      )
    ) {
      return json({ data: base64Url("PDF"), size: 3 });
    }
    throw new Error(`Unexpected request: ${call.url}`);
  });
  const gmail = provider(fetchImplementation);

  const detail = await gmail.getMessage("thread-native-1");
  assert.deepEqual(detail.messages[0].body, []);
  assert.equal(detail.messages[0].attachments[0].id, "attachment-native-1");

  const attachment = await gmail.getAttachment(
    "message-native-1",
    "attachment-native-1",
  );
  assert.equal(attachment.filename, "review.pdf");
  assert.equal(attachment.mimeType, "application/pdf");
  assert.equal(Buffer.from(attachment.data).toString("utf8"), "PDF");

  const content = await gmail.getRawMessageContent("message-native-1");
  assert.equal(content.contentType, "text/html");
  assert.match(content.content, /tracking\.example/);
  assert.equal(messageDetailRequests, 2);
});

test("fetches inline attachment bytes only after an explicit attachment request", async () => {
  const fixture = messageFixture();
  fixture.payload.parts[1].body = { data: base64Url("INLINE"), size: 6 };
  const fetchImplementation = mockFetch((call) => {
    if (!call.url.pathname.endsWith("/messages/message-native-1")) {
      throw new Error(`Unexpected request: ${call.url}`);
    }
    const fields = call.url.searchParams.get("fields") ?? "";
    if (fields.includes("data")) return json(fixture);
    const metadataOnly = structuredClone(fixture);
    metadataOnly.payload.parts[1].body = { size: 6 };
    return json(metadataOnly);
  });

  const attachment = await provider(fetchImplementation).getAttachment(
    "message-native-1",
    "1",
  );
  assert.equal(Buffer.from(attachment.data).toString("utf8"), "INLINE");
  assert.equal(fetchImplementation.calls.length, 2);
  assert.doesNotMatch(
    fetchImplementation.calls[0].url.searchParams.get("fields") ?? "",
    /\bdata\b/u,
  );
  assert.match(
    fetchImplementation.calls[1].url.searchParams.get("fields") ?? "",
    /\bdata\b/u,
  );
});

test("refreshes a rejected token once and keeps provider error bodies private", async () => {
  const tokenRequests = [];
  const fetchImplementation = mockFetch((call, index) => {
    if (index === 0) return json({ error: { errors: [{ reason: "authError" }] } }, 401);
    assert.equal(call.headers.get("Authorization"), "Bearer refreshed-token-for-tests");
    return json({ error: { message: "private provider detail" } }, 500);
  });
  const gmail = provider(fetchImplementation, {
    emailAddress: undefined,
    accessToken: async ({ forceRefresh }) => {
      tokenRequests.push(forceRefresh);
      return forceRefresh ? "refreshed-token-for-tests" : "expired-token-for-tests";
    },
  });

  await assert.rejects(gmail.getAccounts(), (error) => {
    assert.equal(error instanceof GmailApiError, true);
    assert.equal(error.status, 500);
    assert.doesNotMatch(error.message, /private provider detail|refreshed-token/u);
    return true;
  });
  assert.deepEqual(tokenRequests, [false, true]);
});

test("rejects JSON responses whose declared or streamed size exceeds the limit", async () => {
  const declaredLengthFetch = mockFetch(() =>
    new Response('{"emailAddress":"owner@gmail.com"}', {
      headers: {
        "Content-Length": "100000000",
        "Content-Type": "application/json; charset=utf-8",
      },
    }),
  );
  await assert.rejects(
    provider(declaredLengthFetch, { emailAddress: undefined }).getAccounts(),
    (error) => {
      assert.equal(error instanceof GmailApiError, true);
      assert.equal(error.reason, "responseTooLarge");
      return true;
    },
  );

  const streamedLengthFetch = mockFetch(() =>
    new Response(" ".repeat(4 * 1024 * 1024 + 1), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }),
  );
  await assert.rejects(
    provider(streamedLengthFetch, { emailAddress: undefined }).getAccounts(),
    (error) => {
      assert.equal(error instanceof GmailApiError, true);
      assert.equal(error.reason, "responseTooLarge");
      return true;
    },
  );
});

test("fails closed before downloading an attachment above the Gmail safety limit", async () => {
  const fixture = messageFixture();
  fixture.payload.parts[1].body.size = 10 * 1024 * 1024 + 1;
  const fetchImplementation = mockFetch((call) => {
    if (call.url.pathname.endsWith("/messages/message-native-1")) {
      return json(fixture);
    }
    throw new Error(`Oversized attachment content must not be requested: ${call.url}`);
  });

  await assert.rejects(
    provider(fetchImplementation).getAttachment(
      "message-native-1",
      "attachment-native-1",
    ),
    /10 MiB safety limit/u,
  );
  assert.equal(fetchImplementation.calls.length, 1);
});

test("blocks header injection before any Gmail request is sent", async () => {
  const fetchImplementation = mockFetch(() => {
    throw new Error("fetch should not be called");
  });
  await assert.rejects(
    provider(fetchImplementation).sendMessage({
      accountId: "gmail-account-1",
      to: ["reader@example.com\r\nBcc: attacker@example.com"],
      cc: [],
      bcc: [],
      subject: "Safe subject",
      body: "Body",
      attachments: [],
    }),
    /invalid header characters/u,
  );
  assert.equal(fetchImplementation.calls.length, 0);
});
