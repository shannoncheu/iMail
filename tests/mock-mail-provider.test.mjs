import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let vite;
let MockMailProvider;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    root: projectRoot,
    resolve: {
      alias: { "@": projectRoot },
    },
    server: { middlewareMode: true, hmr: false },
  });
  ({ MockMailProvider } = await vite.ssrLoadModule(
    "/src/providers/mail/MockMailProvider.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const draft = (overrides = {}) => ({
  accountId: "account-gmail",
  to: ["reader@example.test"],
  cc: [],
  bcc: [],
  subject: "A local mock message",
  body: "First paragraph.\n\nSecond paragraph.",
  attachments: [],
  ...overrides,
});

test("sent messages are visible and update folder counts", async () => {
  const provider = new MockMailProvider();
  const beforeFolders = await provider.getFolders("gmail");
  const beforeSent = beforeFolders.find((folder) => folder.id === "sent")?.count;

  const { id } = await provider.sendMessage(draft());
  const sent = await provider.getMessages({
    scope: "gmail",
    folder: "sent",
  });
  const afterFolders = await provider.getFolders("gmail");

  assert.equal(sent[0]?.id, id);
  assert.equal(Number.isSafeInteger(sent[0]?.receivedAtMs), true);
  assert.equal(
    afterFolders.find((folder) => folder.id === "sent")?.count,
    (beforeSent ?? 0) + 1,
  );
});

test("saving the same draft updates it instead of duplicating it", async () => {
  const provider = new MockMailProvider();
  const first = await provider.saveDraft(draft({ subject: "First subject" }));
  await provider.saveDraft(
    draft({
      id: first.id,
      accountId: "account-outlook",
      subject: "Updated subject",
      body: "Updated body",
    }),
  );

  const saved = await provider.getMessage(first.id);
  const editable = await provider.getDraft(first.id);
  const drafts = await provider.getMessages({
    scope: "all",
    folder: "drafts",
  });

  assert.equal(saved?.subject, "Updated subject");
  assert.equal(saved?.accountId, "account-outlook");
  assert.equal(saved?.provider, "outlook");
  assert.equal(editable?.id, first.id);
  assert.equal(editable?.subject, "Updated subject");
  assert.equal(editable?.body, "Updated body");
  assert.equal(
    drafts.filter((thread) => thread.id === first.id).length,
    1,
  );
});

test("replying appends to the thread and removes its autosaved draft", async () => {
  const provider = new MockMailProvider();
  const original = await provider.getMessage("design-review");
  const saved = await provider.saveDraft(draft({ subject: "Re: review" }));

  await provider.replyMessage(
    "design-review",
    draft({ id: saved.id, subject: "Re: review" }),
  );

  const updated = await provider.getMessage("design-review");
  assert.equal(updated?.messages.length, (original?.messages.length ?? 0) + 1);
  assert.equal(await provider.getMessage(saved.id), null);
});

test("move results report failures and restore the original folder", async () => {
  const provider = new MockMailProvider();
  const result = await provider.archiveMessages(["design-review", "missing"]);

  assert.deepEqual(result.succeeded, ["design-review"]);
  assert.deepEqual(result.failed, [
    { id: "missing", reason: "Message not found" },
  ]);
  assert.deepEqual(result.previousLocations, [
    { id: "design-review", folder: "inbox" },
  ]);
  assert.equal((await provider.getMessage("design-review"))?.folder, "archive");

  await provider.restoreMessages(result.previousLocations ?? []);
  assert.equal((await provider.getMessage("design-review"))?.folder, "inbox");
});
