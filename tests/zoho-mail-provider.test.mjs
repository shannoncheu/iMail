import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let vite;
let ZohoMailApiError;
let ZohoMailConfigurationError;
let ZohoMailProvider;

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
  ({
    ZohoMailApiError,
    ZohoMailConfigurationError,
    ZohoMailProvider,
  } = await vite.ssrLoadModule(
    "/src/server/mail/zoho/ZohoMailProvider.ts",
  ));
});

after(async () => {
  await vite?.close();
});

function envelope(data, apiStatus = 200, httpStatus = 200) {
  return Response.json(
    {
      status: { code: apiStatus, description: apiStatus < 300 ? "success" : "error" },
      data,
    },
    { status: httpStatus },
  );
}

const accountData = [
  {
    accountId: "123456789",
    primaryEmailAddress: "owner@example.test",
    displayName: "Owner Mail",
    enabled: true,
    status: true,
  },
];

const folderData = [
  {
    folderId: "10",
    folderName: "Inbox",
    folderType: "Inbox",
    path: "/Inbox",
  },
  {
    folderId: "11",
    folderName: "Sent",
    folderType: "Sent",
    path: "/Sent",
  },
  {
    folderId: "12",
    folderName: "Drafts",
    folderType: "Drafts",
    path: "/Drafts",
  },
  {
    folderId: "13",
    folderName: "Spam",
    folderType: "Spam",
    path: "/Spam",
  },
  {
    folderId: "14",
    folderName: "Trash",
    folderType: "Trash",
    path: "/Trash",
  },
];

function createProvider(fetchImplementation, overrides = {}) {
  return new ZohoMailProvider({
    accountId: "connection-zoho",
    providerAccountId: "123456789",
    accessToken: "test-access-token-123456789",
    fetchImplementation,
    pageSize: 25,
    now: () => new Date("2026-08-18T08:00:00.000Z"),
    ...overrides,
  });
}

test("maps accounts, folders, native ids, threaded content, and attachments", async () => {
  const calls = [];
  const fetchImplementation = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/api/accounts") return envelope(accountData);
    if (url.pathname === "/api/accounts/123456789/folders") {
      return envelope(folderData);
    }
    if (url.pathname.endsWith("/messages/view")) {
      return envelope([
        {
          messageId: "101",
          threadId: "700",
          folderId: "10",
          sender: "Alice",
          fromAddress: "Alice <alice@example.test>",
          toAddress: "Owner <owner@example.test>",
          ccAddress: "Not Provided",
          subject: "Project update",
          summary: "First &amp; important",
          receivedTime: "1000",
          status: "0",
          flagid: "important",
          hasAttachment: "1",
          hasInline: "false",
        },
        {
          messageId: "102",
          threadId: "700",
          folderId: "10",
          sender: "Owner",
          fromAddress: "owner@example.test",
          toAddress: "Alice <alice@example.test>",
          ccAddress: "Review <review@example.test>",
          subject: "Re: Project update",
          summary: "Second message",
          receivedTime: "2000",
          status: "1",
          flagid: "flag_not_set",
          hasAttachment: "0",
          hasInline: "true",
        },
      ]);
    }
    if (url.pathname.endsWith("/messages/101/content")) {
      return envelope({
        messageId: "101",
        content: "<div>Hello &amp; welcome</div><script>bad()</script><p>First line</p>",
      });
    }
    if (url.pathname.endsWith("/messages/102/content")) {
      return envelope({ messageId: "102", content: "Plain reply\n\nThanks" });
    }
    if (url.pathname.endsWith("/messages/101/attachmentinfo")) {
      return envelope({
        messageId: "101",
        attachments: [
          {
            attachmentId: "501",
            attachmentName: "brief.pdf",
            attachmentSize: 2048,
          },
        ],
        inline: [],
      });
    }
    if (url.pathname.endsWith("/messages/101/attachments/501")) {
      return new Response(Uint8Array.from([1, 2, 3]), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="downloaded.pdf"',
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const provider = createProvider(fetchImplementation);
  assert.deepEqual(await provider.getAccounts(), [
    {
      id: "connection-zoho",
      provider: "zoho",
      label: "Owner Mail",
      address: "owner@example.test",
      color: "#e42527",
      connected: true,
      capabilities: {
        labels: true,
        reliableDraftUpdates: false,
        externalImages: true,
        permanentDelete: true,
      },
    },
  ]);
  assert.deepEqual(
    (await provider.getFolders("zoho")).map((folder) => folder.id),
    ["inbox", "starred", "sent", "drafts", "archive", "spam", "trash"],
  );

  const page = await provider.getMessagesPage({
    scope: "zoho",
    folder: "inbox",
    pageSize: 2,
  });
  assert.equal(page.nextCursor, "3");
  assert.equal(page.messages.length, 1);
  const thread = page.messages[0];
  assert.equal(thread.id, "700");
  assert.equal(thread.provider, "zoho");
  assert.equal(thread.accountId, "connection-zoho");
  assert.equal(thread.receivedAtMs, 2000);
  assert.equal(thread.unread, true);
  assert.equal(thread.starred, true);
  assert.equal(thread.hasExternalImages, true);
  assert.deepEqual(
    thread.messages.map((message) => message.id),
    ["101", "102"],
  );
  assert.deepEqual(thread.messages[0].body, []);
  assert.deepEqual(thread.messages[0].attachments, []);
  assert.equal(
    calls.some(({ url }) =>
      /\/(?:content|attachmentinfo)$/u.test(url.pathname),
    ),
    false,
  );

  const detail = await provider.getMessage("700");
  assert.equal(detail.id, "700");
  assert.deepEqual(detail.messages[0].body, []);
  assert.deepEqual(detail.messages[1].body, []);
  assert.deepEqual(detail.messages[0].attachments[0], {
    id: "501",
    name: "brief.pdf",
    size: "2.0 KB",
    kind: "document",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    inline: false,
  });
  assert.equal(
    calls.some(({ url }) => url.pathname.endsWith("/content")),
    false,
  );

  assert.deepEqual(await provider.getRawMessageContent("101"), {
    content: "<div>Hello &amp; welcome</div><script>bad()</script><p>First line</p>",
    contentType: "text/html",
  });
  const attachment = await provider.getAttachment("101", "501");
  assert.deepEqual(Array.from(attachment.data), [1, 2, 3]);
  assert.equal(attachment.filename, "downloaded.pdf");
  assert.equal(attachment.mimeType, "application/pdf");
  assert.equal(attachment.sizeBytes, 3);

  for (const call of calls) {
    assert.equal(
      new Headers(call.init.headers).get("Authorization"),
      "Zoho-oauthtoken test-access-token-123456789",
    );
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.url.origin, "https://mail.zoho.com");
  }
});

test("resolves native ids after the listing provider instance is discarded", async () => {
  const requests = [];
  const threadRecords = [
    {
      messageId: "101",
      threadId: "700",
      folderId: "10",
      sender: "Alice",
      fromAddress: "Alice <alice@example.test>",
      toAddress: "Owner <owner@example.test>",
      subject: "Project update",
      summary: "First message",
      receivedTime: "1000",
      status: "0",
      flagid: "important",
      hasAttachment: "1",
      hasInline: "0",
    },
    {
      messageId: "102",
      threadId: "700",
      folderId: "10",
      sender: "Owner",
      fromAddress: "owner@example.test",
      toAddress: "Alice <alice@example.test>",
      subject: "Re: Project update",
      summary: "Latest message",
      receivedTime: "2000",
      status: "1",
      flagid: "flag_not_set",
      hasAttachment: "0",
      hasInline: "0",
    },
  ];
  const fetchImplementation = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === "/api/accounts") return envelope(accountData);
    if (url.pathname.endsWith("/folders")) return envelope(folderData);
    if (url.pathname.endsWith("/messages/view")) {
      const threadId = url.searchParams.get("threadId");
      return envelope(
        threadId === null || threadId === "700" ? threadRecords : [],
      );
    }
    if (url.pathname.endsWith("/folders/10/messages/101/details")) {
      return envelope(threadRecords[0]);
    }
    if (url.pathname.endsWith("/folders/10/messages/101/content")) {
      return envelope({ messageId: "101", content: "<p>Lazy body</p>" });
    }
    if (url.pathname.endsWith("/folders/10/messages/101/attachmentinfo")) {
      return envelope({
        messageId: "101",
        attachments: [
          {
            attachmentId: "501",
            attachmentName: "brief.pdf",
            attachmentSize: 3,
          },
        ],
        inline: [],
      });
    }
    if (url.pathname.endsWith("/folders/10/messages/101/attachments/501")) {
      return new Response(Uint8Array.from([7, 8, 9]), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="brief.pdf"',
        },
      });
    }
    if (
      url.pathname.endsWith("/messages/102") &&
      init.method === "POST"
    ) {
      return envelope({ messageId: "903" });
    }
    if (url.pathname.endsWith("/updatethread") && init.method === "PUT") {
      return envelope(null);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const listingProvider = createProvider(fetchImplementation);
  const listed = await listingProvider.getMessagesPage({
    scope: "zoho",
    folder: "inbox",
  });
  assert.equal(listed.messages[0].id, "700");
  assert.deepEqual(listed.messages[0].messages[0].body, []);
  assert.deepEqual(listed.messages[0].messages[0].attachments, []);
  assert.equal(
    requests.some(({ url }) =>
      /\/(?:content|attachmentinfo)$/u.test(url.pathname),
    ),
    false,
  );

  const detail = await createProvider(fetchImplementation).getMessage("700");
  assert.equal(detail.id, "700");
  assert.deepEqual(detail.messages.map(({ id }) => id), ["101", "102"]);
  assert.deepEqual(detail.messages[0].body, []);
  assert.equal(detail.messages[0].attachments[0].id, "501");
  assert.equal(
    requests.some(({ url }) => url.pathname.endsWith("/content")),
    false,
  );

  assert.deepEqual(
    await createProvider(fetchImplementation).getRawMessageContent("101"),
    { content: "<p>Lazy body</p>", contentType: "text/html" },
  );
  const attachment = await createProvider(fetchImplementation).getAttachment(
    "101",
    "501",
  );
  assert.deepEqual(Array.from(attachment.data), [7, 8, 9]);

  const draft = {
    accountId: "connection-zoho",
    to: ["alice@example.test"],
    cc: [],
    bcc: [],
    subject: "Re: Project update",
    body: "Reply from a fresh request",
    attachments: [],
  };
  assert.deepEqual(
    await createProvider(fetchImplementation).replyMessage("700", draft),
    { id: "903" },
  );
  const replyRequest = requests.find(
    ({ url, init }) =>
      url.pathname.endsWith("/messages/102") && init.method === "POST",
  );
  assert.equal(JSON.parse(replyRequest.init.body).action, "reply");

  assert.deepEqual(
    await createProvider(fetchImplementation).moveToTrash(["700"]),
    {
      succeeded: ["700"],
      failed: [],
      previousLocations: [{ id: "700", folder: "inbox" }],
    },
  );
  const moveRequest = requests.find(({ url }) =>
    url.pathname.endsWith("/updatethread"),
  );
  assert.deepEqual(JSON.parse(moveRequest.init.body), {
    mode: "moveMessage",
    threadId: ["700"],
    folderId: "14",
    isFolderSpecific: true,
  });
});

test("uses Zoho search syntax and native start cursors without query injection", async () => {
  const seen = [];
  const fetchImplementation = async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    if (url.pathname.endsWith("/folders")) return envelope(folderData);
    if (url.pathname.endsWith("/messages/search")) return envelope([]);
    throw new Error(`Unexpected request: ${url}`);
  };
  const provider = createProvider(fetchImplementation);
  const page = await provider.getMessagesPage({
    scope: "zoho",
    folder: "inbox",
    search: 'annual"\nreport',
    cursor: "4",
    pageSize: 3,
  });

  assert.deepEqual(page, { messages: [] });
  const search = seen.find((url) => url.pathname.endsWith("/messages/search"));
  assert.equal(search.searchParams.get("searchKey"), 'entire:"annual report"::in:Inbox');
  assert.equal(search.searchParams.get("start"), "4");
  assert.equal(search.searchParams.get("limit"), "3");
  assert.deepEqual(
    await provider.getMessages({ scope: "gmail", folder: "inbox" }),
    [],
  );
  await assert.rejects(
    provider.getMessagesPage({
      scope: "zoho",
      folder: "inbox",
      cursor: "../2",
    }),
    ZohoMailConfigurationError,
  );
});

test("message-based Zoho search pages do not repeat or lose long-thread results", async () => {
  const sameThread = Array.from({ length: 58 }, (_, index) => ({
    messageId: String(1_000 + index),
    threadId: "700",
    folderId: "10",
    sender: "Alice",
    fromAddress: "alice@example.test",
    toAddress: "owner@example.test",
    subject: `Long thread ${index}`,
    summary: `Long thread message ${index}`,
    receivedTime: String(100_000 - index),
    status: "1",
    flagid: "important",
    hasAttachment: "0",
    hasInline: "0",
  }));
  const otherThreads = Array.from({ length: 7 }, (_, index) => ({
    messageId: String(2_000 + index),
    threadId: String(800 + index),
    folderId: "10",
    sender: "Bob",
    fromAddress: "bob@example.test",
    toAddress: "owner@example.test",
    subject: `Other thread ${index}`,
    summary: `Other message ${index}`,
    receivedTime: String(90_000 - index),
    status: "1",
    flagid: "important",
    hasAttachment: "0",
    hasInline: "0",
  }));
  const records = [...sameThread, ...otherThreads];
  const searches = [];
  const updates = [];
  const fetchImplementation = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/accounts") return envelope(accountData);
    if (url.pathname.endsWith("/folders")) return envelope(folderData);
    if (url.pathname.endsWith("/messages/search")) {
      const start = Number(url.searchParams.get("start"));
      const limit = Number(url.searchParams.get("limit"));
      const key = url.searchParams.get("searchKey");
      searches.push({
        key,
        start,
        limit,
      });
      const searchedRecords = key?.endsWith("::in:Drafts")
        ? records.map((record) => ({ ...record, folderId: "12" }))
        : records;
      return envelope(searchedRecords.slice(start - 1, start - 1 + limit));
    }
    const detailMatch = url.pathname.match(
      /\/folders\/10\/messages\/(\d+)\/details$/u,
    );
    if (detailMatch) {
      return envelope(
        records.find(({ messageId }) => messageId === detailMatch[1]),
      );
    }
    if (url.pathname.endsWith("/updatemessage") && init.method === "PUT") {
      updates.push(JSON.parse(init.body));
      return envelope(null);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const scenarios = [
    {
      query: { scope: "zoho", folder: "inbox", search: "long thread" },
      searchKey: 'entire:"long thread"::in:Inbox',
    },
    {
      query: { scope: "zoho", folder: "starred" },
      searchKey: "has:flags",
    },
    {
      query: { scope: "zoho", folder: "archive" },
      searchKey: "in:Archive",
    },
    {
      query: { scope: "zoho", folder: "drafts", search: "long thread" },
      searchKey: 'entire:"long thread"::in:Drafts',
      usesDraftIds: true,
    },
  ];

  for (const { query, searchKey, usesDraftIds = false } of scenarios) {
    const ids = [];
    let cursor;
    do {
      // Each page uses a new provider, matching separate BFF requests.
      const page = await createProvider(fetchImplementation).getMessagesPage({
        ...query,
        pageSize: 10,
        ...(cursor ? { cursor } : {}),
      });
      assert.ok(page.messages.every((thread) => thread.messages.length === 1));
      ids.push(...page.messages.map(({ id }) => id));
      cursor = page.nextCursor;
    } while (cursor);

    assert.deepEqual(
      ids,
      records.map(({ folderId, messageId }) =>
        usesDraftIds ? messageId : `message:${folderId}:${messageId}`,
      ),
    );
    assert.equal(new Set(ids).size, records.length);
    const scenarioSearches = searches.filter(({ key }) => key === searchKey);
    assert.deepEqual(
      scenarioSearches.map(({ start }) => start),
      [1, 11, 21, 31, 41, 51, 61],
    );
    assert.ok(scenarioSearches.every(({ limit }) => limit === 10));
  }

  const listedId = "message:10:1000";
  const detail = await createProvider(fetchImplementation).getMessage(listedId);
  assert.equal(detail.id, listedId);
  assert.deepEqual(detail.messages.map(({ id }) => id), ["1000"]);

  assert.deepEqual(
    await createProvider(fetchImplementation).markRead([listedId], true),
    { succeeded: [listedId], failed: [] },
  );
  assert.deepEqual(
    await createProvider(fetchImplementation).moveToTrash([listedId]),
    {
      succeeded: [listedId],
      failed: [],
      previousLocations: [{ id: listedId, folder: "inbox" }],
    },
  );
  assert.deepEqual(updates, [
    { mode: "markAsRead", messageId: ["1000"] },
    { mode: "moveMessage", messageId: ["1000"], destfolderId: "14" },
  ]);
});

test("uploads base64 attachments and maps send, draft, reply, and forward payloads", async () => {
  const uploads = [];
  const messages = [];
  let nextMessageId = 900;
  let tokenCalls = 0;
  const fetchImplementation = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/accounts") return envelope(accountData);
    if (url.pathname.endsWith("/folders")) return envelope(folderData);
    if (url.pathname.endsWith("/messages/view")) {
      assert.equal(url.searchParams.get("threadId"), "101");
      return envelope([]);
    }
    if (url.pathname.endsWith("/folders/10/messages/101/details")) {
      return envelope({
        messageId: "101",
        threadId: "700",
        folderId: "10",
        sender: "Alice",
        fromAddress: "Alice <alice@example.test>",
        toAddress: "Owner <owner@example.test>",
        subject: "Original subject",
        summary: "Original summary",
        receivedTime: "1000",
        status: "1",
        flagid: "flag_not_set",
        hasAttachment: "1",
        hasInline: "0",
      });
    }
    if (url.pathname.endsWith("/folders/10/messages/101/content")) {
      return envelope({
        messageId: "101",
        content: "<p>Original body</p>",
      });
    }
    if (url.pathname.endsWith("/folders/10/messages/101/attachmentinfo")) {
      return envelope({
        messageId: "101",
        attachments: [
          {
            attachmentId: "501",
            attachmentName: "original.pdf",
            attachmentSize: 3,
          },
        ],
        inline: [],
      });
    }
    if (url.pathname.endsWith("/folders/10/messages/101/attachments/501")) {
      return new Response(Uint8Array.from([4, 5, 6]), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="forwarded.pdf"',
        },
      });
    }
    if (url.pathname.endsWith("/messages/attachments")) {
      uploads.push({
        url,
        contentType: new Headers(init.headers).get("Content-Type"),
        body: Array.from(new Uint8Array(init.body)),
      });
      const attachmentName = url.searchParams.get("fileName");
      return envelope({
        storeName: `store-${uploads.length}`,
        attachmentPath: `/Mail/${attachmentName}`,
        attachmentName,
      });
    }
    if (url.pathname.endsWith("/messages") || /\/messages\/\d+$/u.test(url.pathname)) {
      messages.push({
        url,
        method: init.method,
        body: JSON.parse(init.body),
      });
      return envelope({ messageId: String(nextMessageId++) });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const provider = createProvider(fetchImplementation, {
    accessToken: async () => {
      tokenCalls += 1;
      return "refreshed-access-token-123456789";
    },
  });
  const baseDraft = {
    accountId: "connection-zoho",
    to: ["reader@example.test"],
    cc: [],
    bcc: [],
    subject: "A message",
    body: "Plain body",
    attachments: [],
  };

  assert.deepEqual(
    await provider.sendMessage({
      ...baseDraft,
      attachments: [
        {
          id: "new-file",
          name: "brief.txt",
          size: "3 B",
          kind: "document",
          mimeType: "text/plain",
          sizeBytes: 3,
          contentBase64: "AQID",
        },
      ],
    }),
    { id: "900" },
  );
  assert.deepEqual(uploads, [
    {
      url: new URL(
        "https://mail.zoho.com/api/accounts/123456789/messages/attachments?fileName=brief.txt&isInline=false",
      ),
      contentType: "text/plain",
      body: [1, 2, 3],
    },
  ]);
  assert.deepEqual(messages[0].body.attachments, [
    {
      storeName: "store-1",
      attachmentPath: "/Mail/brief.txt",
      attachmentName: "brief.txt",
    },
  ]);
  assert.equal(messages[0].body.mailFormat, "plaintext");
  assert.equal(messages[0].body.encoding, "UTF-8");

  assert.deepEqual(await provider.saveDraft(baseDraft), {
    id: "901",
    savedAt: "2026-08-18T08:00:00.000Z",
  });
  assert.equal(messages[1].body.mode, "draft");
  assert.deepEqual(await provider.replyMessage("101", baseDraft), { id: "902" });
  assert.equal(messages[2].body.action, "reply");
  assert.equal(messages[2].url.pathname.endsWith("/messages/101"), true);
  assert.deepEqual(await provider.forwardMessage("101", baseDraft), { id: "903" });
  assert.equal(messages[3].url.pathname.endsWith("/messages"), true);
  assert.match(
    messages[3].body.content,
    /---------- Forwarded message ----------[\s\S]*From: Alice <alice@example\.test>[\s\S]*Original body/u,
  );
  assert.deepEqual(messages[3].body.attachments, [
    {
      storeName: "store-2",
      attachmentPath: "/Mail/forwarded.pdf",
      attachmentName: "forwarded.pdf",
    },
  ]);
  assert.deepEqual(uploads[1], {
    url: new URL(
      "https://mail.zoho.com/api/accounts/123456789/messages/attachments?fileName=forwarded.pdf&isInline=false",
    ),
    contentType: "application/pdf",
    body: [4, 5, 6],
  });
  assert.equal(tokenCalls >= 5, true);

  await assert.rejects(
    provider.sendMessage({ ...baseDraft, to: [] }),
    /At least one recipient is required/u,
  );
  await assert.rejects(
    provider.replyMessage("not-an-id", baseDraft),
    /Invalid Zoho message id/u,
  );
});

test("loads native drafts and preserves attachments across replacement saves", async () => {
  const drafts = new Map([
    [
      "901",
      {
        id: "901",
        toAddress:
          "&quot;Reader&quot;&lt;reader@example.test&gt;, second@example.test",
        ccAddress: "copy@example.test",
        bccAddress: "blind@example.test",
        subject: "First draft",
        content:
          "<div>Hello &amp; welcome</div><script>alert(1)</script><p>Second line</p>",
        attachments: [
          {
            id: "501",
            name: "brief.pdf",
            data: Uint8Array.from([1, 2, 3]),
            inline: false,
          },
        ],
      },
    ],
  ]);
  const uploaded = new Map();
  const uploadedBodies = [];
  const deleted = [];
  let nextDraftId = 902;
  let nextAttachmentId = 601;
  let nextUploadId = 1;

  const missing = () =>
    envelope({ moreInfo: "Draft does not exist" }, 404, 404);
  const fetchImplementation = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/accounts") return envelope(accountData);
    if (url.pathname.endsWith("/folders")) return envelope(folderData);

    const detail = url.pathname.match(
      /\/folders\/(\d+)\/messages\/(\d+)\/details$/u,
    );
    if (detail) {
      if (detail[1] !== "12") return missing();
      const draft = drafts.get(detail[2]);
      if (!draft) return missing();
      return envelope({
        draftId: draft.id,
        folderId: "12",
        sender: "Owner",
        fromAddress: "owner@example.test",
        toAddress: draft.toAddress,
        ccAddress: draft.ccAddress,
        bccAddress: draft.bccAddress,
        subject: draft.subject,
        summary: draft.subject,
        receivedTime: "1000",
        status: "1",
        flagid: "flag_not_set",
        hasAttachment: String(Number(draft.attachments.length > 0)),
        hasInline: "0",
      });
    }

    const content = url.pathname.match(
      /\/folders\/12\/messages\/(\d+)\/content$/u,
    );
    if (content) {
      const draft = drafts.get(content[1]);
      return draft
        ? envelope({ draftId: draft.id, content: draft.content })
        : missing();
    }

    const attachmentInfo = url.pathname.match(
      /\/folders\/12\/messages\/(\d+)\/attachmentinfo$/u,
    );
    if (attachmentInfo) {
      const draft = drafts.get(attachmentInfo[1]);
      if (!draft) return missing();
      return envelope({
        draftId: draft.id,
        attachments: draft.attachments.map((attachment) => ({
          attachmentId: attachment.id,
          attachmentName: attachment.name,
          attachmentSize: attachment.data.byteLength,
        })),
        inline: [],
      });
    }

    const attachmentContent = url.pathname.match(
      /\/folders\/12\/messages\/(\d+)\/attachments\/(\d+)$/u,
    );
    if (attachmentContent) {
      const attachment = drafts
        .get(attachmentContent[1])
        ?.attachments.find((candidate) => candidate.id === attachmentContent[2]);
      if (!attachment) return new Response(null, { status: 404 });
      return new Response(attachment.data, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${attachment.name}"`,
        },
      });
    }

    if (url.pathname.endsWith("/messages/attachments")) {
      const storeName = `store-${nextUploadId++}`;
      const data = new Uint8Array(init.body);
      uploadedBodies.push(Array.from(data));
      uploaded.set(storeName, {
        data,
        name: url.searchParams.get("fileName"),
      });
      return envelope({
        storeName,
        attachmentPath: `/Mail/${storeName}`,
        attachmentName: url.searchParams.get("fileName"),
      });
    }

    if (
      url.pathname === "/api/accounts/123456789/messages" &&
      init.method === "POST"
    ) {
      const body = JSON.parse(init.body);
      const id = String(nextDraftId++);
      drafts.set(id, {
        id,
        toAddress: body.toAddress ?? "",
        ccAddress: body.ccAddress ?? "",
        bccAddress: body.bccAddress ?? "",
        subject: body.subject ?? "",
        content: body.content ?? "",
        attachments: (body.attachments ?? []).map((descriptor) => {
          const upload = uploaded.get(descriptor.storeName);
          assert.ok(upload, "created drafts must reference a completed upload");
          return {
            id: String(nextAttachmentId++),
            name: upload.name,
            data: upload.data,
            inline: false,
          };
        }),
      });
      return envelope({ draftId: id });
    }

    const removal = url.pathname.match(
      /\/folders\/12\/messages\/(\d+)$/u,
    );
    if (removal && init.method === "DELETE") {
      if (!drafts.delete(removal[1])) return missing();
      deleted.push(removal[1]);
      return envelope(null);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const restored = await createProvider(fetchImplementation).getDraft("901");
  assert.deepEqual(restored, {
    id: "901",
    accountId: "connection-zoho",
    to: ["reader@example.test", "second@example.test"],
    cc: ["copy@example.test"],
    bcc: ["blind@example.test"],
    subject: "First draft",
    body: "Hello & welcome\nSecond line",
    attachments: [
      {
        id: "501",
        name: "brief.pdf",
        size: "3 B",
        kind: "document",
        mimeType: "application/pdf",
        sizeBytes: 3,
        inline: false,
        sourceMessageId: "901",
      },
    ],
  });
  assert.equal(
    Object.hasOwn(restored.attachments[0], "contentBase64"),
    false,
  );

  const second = await createProvider(fetchImplementation).saveDraft({
    ...restored,
    subject: "Second draft",
  });
  assert.equal(second.id, "902");
  assert.deepEqual(deleted, ["901"]);
  assert.deepEqual(Array.from(drafts.keys()), ["902"]);

  // The browser still holds attachment id/source metadata from draft 901.
  // A fresh BFF provider must reconcile it against draft 902 before replacing it.
  const third = await createProvider(fetchImplementation).saveDraft({
    ...restored,
    id: second.id,
    subject: "Third draft",
  });
  assert.equal(third.id, "903");
  assert.deepEqual(deleted, ["901", "902"]);
  assert.deepEqual(Array.from(drafts.keys()), ["903"]);
  assert.deepEqual(uploadedBodies, [
    [1, 2, 3],
    [1, 2, 3],
  ]);

  const finalDraft = await createProvider(fetchImplementation).getDraft("903");
  assert.equal(finalDraft.subject, "Third draft");
  assert.equal(finalDraft.attachments.length, 1);
  assert.equal(finalDraft.attachments[0].sourceMessageId, "903");
  assert.deepEqual(
    Array.from(
      (
        await createProvider(fetchImplementation).getAttachment(
          "903",
          finalDraft.attachments[0].id,
        )
      ).data,
    ),
    [1, 2, 3],
  );
  assert.equal(await createProvider(fetchImplementation).getDraft("901"), null);
});

test("performs thread-aware move, restore, read, and flag updates", async () => {
  const updates = [];
  const fetchImplementation = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/folders")) return envelope(folderData);
    if (url.pathname.endsWith("/messages/view")) {
      if (url.searchParams.get("threadId") === "500") return envelope([]);
      return envelope([
        {
          messageId: "101",
          threadId: "700",
          folderId: "10",
          sender: "Alice",
          fromAddress: "alice@example.test",
          toAddress: "owner@example.test",
          subject: "Move me",
          summary: "Move me",
          receivedTime: "1000",
          status: "1",
          flagid: "flag_not_set",
          hasAttachment: "0",
          hasInline: "0",
        },
      ]);
    }
    if (url.pathname.endsWith("/messages/101/content")) {
      return envelope({ messageId: "101", content: "Body" });
    }
    if (
      url.pathname.endsWith("/updatemessage") ||
      url.pathname.endsWith("/updatethread")
    ) {
      const body = JSON.parse(init.body);
      updates.push({ endpoint: url.pathname.split("/").at(-1), body });
      if (body.messageId?.includes("500")) {
        return envelope({ moreInfo: "Message was rejected" }, 400, 400);
      }
      return envelope(null);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const provider = createProvider(fetchImplementation);
  await provider.getMessages({ scope: "zoho", folder: "inbox" });

  const moved = await provider.moveToTrash(["700"]);
  assert.deepEqual(moved, {
    succeeded: ["700"],
    failed: [],
    previousLocations: [{ id: "700", folder: "inbox" }],
  });
  assert.deepEqual(updates[0], {
    endpoint: "updatethread",
    body: {
      mode: "moveMessage",
      threadId: ["700"],
      folderId: "14",
      isFolderSpecific: true,
    },
  });

  assert.deepEqual(await provider.restoreFromTrash(["700"]), {
    succeeded: ["700"],
    failed: [],
  });
  assert.deepEqual(updates[1], {
    endpoint: "updatethread",
    body: {
      mode: "moveMessage",
      threadId: ["700"],
      folderId: "10",
      isFolderSpecific: true,
    },
  });

  const read = await provider.markRead(["700", "500", "bad"], true);
  assert.deepEqual(read.succeeded, ["700"]);
  assert.deepEqual(
    read.failed.map(({ id }) => id).sort(),
    ["500", "bad"],
  );
  assert.deepEqual(updates[2], {
    endpoint: "updatemessage",
    body: { mode: "markAsRead", messageId: ["500"] },
  });
  assert.deepEqual(updates[3], {
    endpoint: "updatethread",
    body: { mode: "markAsRead", threadId: ["700"] },
  });

  assert.deepEqual(await provider.setStarred("700", true), {
    succeeded: ["700"],
    failed: [],
  });
  assert.deepEqual(updates[4], {
    endpoint: "updatethread",
    body: {
      mode: "setFlag",
      threadId: ["700"],
      flagid: "important",
    },
  });

  assert.deepEqual(await provider.archiveMessages(["700"]), {
    succeeded: ["700"],
    failed: [],
    previousLocations: [{ id: "700", folder: "inbox" }],
  });
  assert.deepEqual(updates[5], {
    endpoint: "updatemessage",
    body: { mode: "archiveMails", threadId: ["700"] },
  });
});

test("rejects oversized lazy message content before buffering it", async () => {
  const fetchImplementation = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/folders")) return envelope(folderData);
    if (url.pathname.endsWith("/folders/10/messages/101/details")) {
      return envelope({
        messageId: "101",
        folderId: "10",
        sender: "Alice",
        fromAddress: "alice@example.test",
        toAddress: "owner@example.test",
        subject: "Large message",
        summary: "Large message",
        receivedTime: "1000",
        status: "1",
        flagid: "flag_not_set",
        hasAttachment: "0",
        hasInline: "0",
      });
    }
    if (url.pathname.endsWith("/folders/10/messages/101/content")) {
      return new Response('{"status":{"code":200},"data":{"content":"x"}}', {
        headers: { "Content-Length": String(64 * 1024 * 1024) },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    createProvider(fetchImplementation).getRawMessageContent("101"),
    /response exceeds the safety limit/u,
  );
});

test("cancels an attachment stream that exceeds 25 MiB without Content-Length", async () => {
  const chunk = new Uint8Array(2 * 1024 * 1024);
  let chunksProduced = 0;
  let cancelled = false;
  const fetchImplementation = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/folders")) return envelope(folderData);
    if (url.pathname.endsWith("/folders/10/messages/101/details")) {
      return envelope({
        messageId: "101",
        folderId: "10",
        sender: "Alice",
        fromAddress: "alice@example.test",
        toAddress: "owner@example.test",
        subject: "Attachment",
        summary: "Attachment",
        receivedTime: "1000",
        status: "1",
        flagid: "flag_not_set",
        hasAttachment: "1",
        hasInline: "0",
      });
    }
    if (url.pathname.endsWith("/folders/10/messages/101/attachmentinfo")) {
      return envelope({
        messageId: "101",
        attachments: [
          {
            attachmentId: "501",
            attachmentName: "large.bin",
            attachmentSize: 3,
          },
        ],
        inline: [],
      });
    }
    if (url.pathname.endsWith("/folders/10/messages/101/attachments/501")) {
      const body = new ReadableStream({
        pull(controller) {
          chunksProduced += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = new Response(body, {
        headers: { "Content-Type": "application/octet-stream" },
      });
      assert.equal(response.headers.has("Content-Length"), false);
      return response;
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    createProvider(fetchImplementation).getAttachment("101", "501"),
    /attachment exceeds the safety limit/u,
  );
  assert.equal(cancelled, true);
  assert.ok(chunksProduced >= 13);
  assert.ok(chunksProduced <= 14);
});

test("fails closed for unsupported origins, unsafe numeric ids, and API errors", async () => {
  assert.throws(
    () =>
      createProvider(async () => envelope(null), {
        apiOrigin: "https://attacker.example",
      }),
    ZohoMailConfigurationError,
  );

  const unsafeIdProvider = createProvider(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/folders")) return envelope(folderData);
    if (url.pathname.endsWith("/messages/view")) {
      return new Response(
        '{"status":{"code":200,"description":"success"},"data":[{"messageId":9000000000000000001,"threadId":0,"folderId":"10","fromAddress":"a@example.test","subject":"unsafe","receivedTime":"1"}]}',
        { headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  await assert.rejects(
    unsafeIdProvider.getMessages({ scope: "zoho", folder: "inbox" }),
    /invalid message id/iu,
  );

  const secret = "secret-access-token-that-must-not-leak";
  const failedProvider = createProvider(
    async () => envelope({ moreInfo: "expired" }, 401, 401),
    { accessToken: secret },
  );
  await assert.rejects(failedProvider.getAccounts(), (error) => {
    assert.equal(error instanceof ZohoMailApiError, true);
    assert.equal(error.httpStatus, 401);
    assert.doesNotMatch(error.message, new RegExp(secret, "u"));
    return true;
  });

  const refreshRequests = [];
  let attempts = 0;
  const refreshedProvider = createProvider(
    async () => {
      attempts += 1;
      return attempts === 1
        ? envelope({ moreInfo: "expired" }, 401, 401)
        : envelope(accountData);
    },
    {
      accessToken: ({ forceRefresh }) => {
        refreshRequests.push(forceRefresh);
        return forceRefresh ? "fresh-access-token-123456789" : secret;
      },
    },
  );
  assert.equal((await refreshedProvider.getAccounts())[0].address, "owner@example.test");
  assert.deepEqual(refreshRequests, [false, true]);
});
