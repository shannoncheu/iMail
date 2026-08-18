import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const accountId = "11111111-1111-4111-8111-111111111111";

let vite;
let mailModule;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    root: projectRoot,
    resolve: { alias: { "@": projectRoot } },
    server: { middlewareMode: true, hmr: false },
  });
  mailModule = await vite.ssrLoadModule("/src/providers/mail/index.ts");
});

after(async () => {
  await vite?.close();
});

test("the production factory creates the BFF provider and keeps the mock explicit", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return Response.json({ id: "draft-1", savedAt: "2026-08-18T09:00:00.000Z" });
  };

  try {
    const provider = mailModule.createMailProvider("factory-csrf-token");
    assert.ok(provider instanceof mailModule.ApiMailProvider);
    assert.ok(new mailModule.MockMailProvider() instanceof mailModule.MockMailProvider);

    await provider.saveDraft({
      accountId,
      to: ["reader@example.test"],
      cc: [],
      bcc: [],
      subject: "Factory boundary",
      body: "Uses the same-origin BFF.",
      attachments: [],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, "/api/mail/drafts");
    assert.equal(calls[0].init.headers.get("x-csrf-token"), "factory-csrf-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the communication hub wires pagination, OAuth, safe content, and real files", async () => {
  const [source, styles] = await Promise.all([
    readFile(resolve(projectRoot, "app/communication-hub.tsx"), "utf8"),
    readFile(resolve(projectRoot, "app/globals.css"), "utf8"),
  ]);

  assert.match(source, /useInfiniteQuery\(\{/u);
  assert.match(source, /provider\.getMessagesPage/u);
  assert.match(
    source,
    /provider\.getFolders\(resolvedScope, resolvedScopeAccountId\)/u,
  );
  assert.match(source, /accountId: resolvedScopeAccountId/u);
  assert.match(
    source,
    /resolvedScope === account\.provider &&[\s\S]*?resolvedScopeAccountId === account\.id/u,
  );
  assert.match(source, /switchScope\(account\.provider, account\.id\)/u);
  assert.match(source, /provider\.getMessage\(activeThreadSummary!\.id\)/u);
  assert.match(
    source,
    /type ComposeMode = "new" \| "reply" \| "forward" \| "draft"/u,
  );
  assert.match(source, /provider\.getDraft\?\.\(thread\.id\)/u);
  assert.match(
    source,
    /folder === "drafts"[\s\S]*?activeThreadQuery\.isError && !hasActiveThreadData/u,
  );
  assert.match(source, /draft\.id !== thread\.id/u);
  assert.match(source, /draft\.accountId !== thread\.accountId/u);
  assert.match(
    source,
    /openCompose\(draft\.composeIntent\?\.mode \?\? "draft", draft, focusTarget\)/u,
  );
  assert.match(source, /draftLoading=\{loadingDraftId !== null\}/u);
  assert.match(source, /draftLoading \? "正在加载草稿…" : "继续编辑"/u);
  assert.match(
    source,
    /const isExpanded = expansionOverrides\.get\(message\.id\) \?\? current/u,
  );
  assert.match(source, /next\.set\(message\.id, !isExpanded\)/u);
  assert.match(source, /message: "草稿暂时无法加载，请重试。"/u);
  assert.match(source, /actionLabel: "重试"/u);
  const draftLoadFlow = source.slice(
    source.indexOf("async function loadDraftForEditing"),
    source.indexOf("async function loadDraftForEditing") + 1_900,
  );
  assert.doesNotMatch(
    draftLoadFlow,
    /error\.message|String\(error\)|JSON\.stringify/u,
  );
  assert.match(source, /messagesQuery\.fetchNextPage\(\)/u);
  assert.match(source, /page\.partial === true/u);
  assert.match(source, /page\.accountErrors/u);
  assert.match(source, /partial=\{hasPartialMessageResults\}/u);
  assert.match(
    source,
    /unavailableAccountCount=\{unavailableAccountIds\.size\}/u,
  );
  assert.match(source, /title="部分账号暂不可用"/u);
  assert.match(source, /已显示其他账号的邮件。/u);
  assert.match(source, /暂时无法显示全部邮件/u);
  const partialWarning = source.slice(
    source.indexOf('title="部分账号暂不可用"'),
    source.indexOf('title="部分账号暂不可用"') + 700,
  );
  assert.doesNotMatch(partialWarning, /accountId|code|reason/u);
  assert.match(source, /sandbox=""/u);
  assert.match(source, /referrerPolicy="no-referrer"/u);
  assert.match(source, /href=\{attachment\.downloadUrl\}/u);
  assert.match(source, /type="file"[\s\S]*?multiple/u);
  assert.match(source, /contentBase64: await fileToBase64\(file\)/u);
  assert.match(source, /initialDraft\?\.to\.join\(", "\)/u);
  assert.match(source, /initialDraft\?\.cc\.join\(", "\)/u);
  assert.match(source, /initialDraft\?\.bcc\.join\(", "\)/u);
  assert.match(source, /initialDraft\?\.body/u);
  assert.match(source, /initialDraft\?\.attachments/u);
  assert.match(source, /draftIdRef = useRef<string \| undefined>\(initialDraft\?\.id\)/u);
  assert.match(source, /to: splitRecipients\(recipient\)/u);
  assert.match(source, /type="email"[\s\S]*?multiple[\s\S]*?value=\{recipient\}/u);
  const fromField = source.slice(
    source.indexOf("<span>From</span>"),
    source.indexOf("<span>From</span>") + 1_000,
  );
  assert.match(
    fromField,
    /disabled=\{composeLocked \|\| accountSelectionLocked\}/u,
  );
  assert.doesNotMatch(fromField, /markDraftDirty/u);
  assert.match(source, /mode !== "new" \|\| Boolean\(initialDraft\?\.id\)/u);
  assert.match(source, /accountSelectionLockedRef\.current = true/u);
  assert.match(source, /composePhaseRef\.current = "closing"/u);
  assert.match(source, /composePhaseRef\.current = "sending"/u);
  assert.match(source, /onExitComplete=\{finishComposeExit\}/u);
  assert.match(
    source,
    /const finishComposeExit = useCallback\(\(\) => \{[\s\S]*?composeModeRef\.current = null;[\s\S]*?returnTarget\.focus/u,
  );
  assert.match(source, /window\.clearTimeout\(autosaveTimerRef\.current\)/u);
  assert.match(
    source,
    /if \(accountIdRef\.current === draft\.accountId\) \{[\s\S]*?draftIdRef\.current = savedDraft\.id/u,
  );
  assert.match(source, /await provider\.sendMessage\(draft\)/u);
  assert.match(source, /onClose=\{\(refreshDrafts = false\) =>/u);
  assert.match(source, /onClose\(true\)/u);
  assert.match(source, /void updateMessages\(\)\.catch/u);
  assert.match(source, /MAX_ATTACHMENT_BYTES = 5 \* 1_024 \* 1_024/u);
  assert.match(source, /MAX_TOTAL_ATTACHMENT_BYTES = 5 \* 1_024 \* 1_024/u);
  assert.match(
    source,
    /existingBytes \+ selectedBytes > MAX_TOTAL_ATTACHMENT_BYTES/u,
  );
  assert.match(source, /method: "POST"[\s\S]*?"x-csrf-token": csrfToken/u);
  assert.match(source, /\/api\/mail\/disconnect/u);
  assert.match(source, /\/api\/mail\/connect\/\$\{mailProvider\}\/start/u);
  assert.match(source, /folder !== "drafts" && thread\.unread/u);
  assert.match(source, /isDraft=\{folder === "drafts"\}/u);
  assert.match(source, /provider\.restoreFromTrash\(ids\)/u);
  assert.match(source, /folder === "trash"[\s\S]*?"Restore selected from Trash"/u);
  assert.match(source, /trashAction=\{folder === "trash" \? "restore" : "trash"\}/u);
  assert.match(source, /label="Restore message from Trash"|"Restore message from Trash"/u);
  assert.match(source, /accountsQuery\.isError/u);
  assert.match(source, /foldersQuery\.isError/u);
  assert.match(source, /messagesQuery\.isError/u);
  assert.match(source, /activeThreadQuery\.isError/u);
  assert.match(source, /accountsQuery\.refetch\(\)/u);
  assert.match(source, /foldersQuery\.refetch\(\)/u);
  assert.match(source, /messagesQuery\.refetch\(\)/u);
  assert.match(source, /activeThreadQuery\.refetch\(\)/u);
  assert.match(source, /retrying \? "Retrying…" : "Retry"/u);
  assert.match(source, /Showing the conversations that were already loaded\./u);
  assert.match(source, /Showing the full details that were already loaded\./u);
  assert.match(styles, /\.query-error/u);
  assert.match(styles, /\.query-error\.is-warning/u);
  assert.match(styles, /\.message-list-region/u);
  assert.match(styles, /\.quick-reply:disabled/u);
  assert.doesNotMatch(source, /compose-project-note|Demo data/u);
});

test("draft editing keeps saves ordered and bound to the original account", async () => {
  const source = await readFile(
    resolve(projectRoot, "app/communication-hub.tsx"),
    "utf8",
  );
  const assertBefore = (value, first, second) => {
    const firstIndex = value.indexOf(first);
    const secondIndex = value.indexOf(second);
    assert.ok(firstIndex >= 0, `Missing source marker: ${first}`);
    assert.ok(secondIndex >= 0, `Missing source marker: ${second}`);
    assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`);
  };

  const loadStart = source.indexOf("async function loadDraftForEditing");
  const loadEnd = source.indexOf("useEffect(() => {", loadStart);
  const loadFlow = source.slice(loadStart, loadEnd);
  assert.ok(loadStart >= 0 && loadEnd > loadStart);
  assert.ok(loadFlow.indexOf("provider.getDraft?.(thread.id)") >= 0);
  assertBefore(
    loadFlow,
    "provider.getDraft?.(thread.id)",
    'openCompose(draft.composeIntent?.mode ?? "draft", draft, focusTarget)',
  );
  assert.doesNotMatch(loadFlow, /saveDraft|sendMessage/u);

  const closeStart = source.indexOf("const requestClose = async () => {");
  const closeEnd = source.indexOf("const sendMessage = async () => {", closeStart);
  const closeFlow = source.slice(closeStart, closeEnd);
  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  assertBefore(
    closeFlow,
    'composePhaseRef.current = "closing"',
    "await pendingSave?.promise",
  );
  assertBefore(
    closeFlow,
    "window.clearTimeout(autosaveTimerRef.current)",
    "await pendingSave?.promise",
  );
  assertBefore(
    closeFlow,
    "await pendingSave?.promise",
    "provider.saveDraft(createDraft())",
  );

  const sendStart = closeEnd;
  const sendEnd = source.indexOf("\n  return (", sendStart);
  const sendFlow = source.slice(sendStart, sendEnd);
  assert.ok(sendEnd > sendStart);
  assertBefore(
    sendFlow,
    'composePhaseRef.current = "sending"',
    "await pendingSave?.promise",
  );
  assertBefore(
    sendFlow,
    "window.clearTimeout(autosaveTimerRef.current)",
    "await pendingSave?.promise",
  );
  assertBefore(
    sendFlow,
    "await pendingSave?.promise",
    "const draft = createDraft()",
  );
  assert.match(sendFlow, /await provider\.sendMessage\(draft\)/u);

  assert.match(
    source,
    /initialDraft\?\.to\.join\(", "\)[\s\S]*?initialDraft\?\.cc\.join\(", "\)[\s\S]*?initialDraft\?\.bcc\.join\(", "\)/u,
  );
  assert.match(source, /to: splitRecipients\(recipient\)/u);
  assert.match(
    source,
    /\(initialDraft\?\.attachments \?\? \[\]\)\.map\(\(attachment\) => \(\{ \.\.\.attachment \}\)\)/u,
  );
  assert.match(
    source,
    /current\.filter\(\(item\) => item\.id !== attachment\.id\)/u,
  );
  assert.match(source, /initialDraft\?\.id \? "saved" : "idle"/u);
  assert.match(
    source,
    /lastSavedRevisionRef = useRef\(initialDraft\?\.id \? 0 : -1\)/u,
  );
  assert.match(
    source,
    /initialDraft\?\.composeIntent\?\.sourceId \?\? activeThread\?\.id/u,
  );
  assert.match(
    source,
    /composeIntent: composeIntentFor\(mode, sourceThreadIdRef\.current\)/u,
  );
  assert.match(
    sendFlow,
    /if \(mode === "reply" \|\| mode === "forward"\)[\s\S]*?if \(!sourceId\) throw new Error/u,
  );
  assert.match(
    source,
    /accountIdRef\.current === draft\.accountId[\s\S]*?draftIdRef\.current = savedDraft\.id/u,
  );
});

test("mobile compose, Outlook Starred search and post-mutation refresh states are guarded", async () => {
  const [source, styles] = await Promise.all([
    readFile(resolve(projectRoot, "app/communication-hub.tsx"), "utf8"),
    readFile(resolve(projectRoot, "app/globals.css"), "utf8"),
  ]);

  const fabStart = source.indexOf('className="compose-fab"');
  const fab = source.slice(fabStart, fabStart + 650);
  assert.ok(fabStart >= 0);
  assert.match(fab, /disabled=\{!accountsQuery\.data\?\.length\}/u);
  assert.match(
    fab,
    /if \(accountsQuery\.data\?\.length\) openCompose\("new"\)/u,
  );
  assert.match(styles, /\.compose-fab:disabled/u);

  assert.match(
    source,
    /folder === "starred" &&[\s\S]*?resolvedScope === "outlook" &&[\s\S]*?Boolean\(resolvedScopeAccountId\)/u,
  );
  assert.match(
    source,
    /nextFolder === "starred" &&[\s\S]*?resolvedScope === "outlook"[\s\S]*?setSearchTerm\(""\);[\s\S]*?setDebouncedSearchTerm\(""\)/u,
  );
  assert.match(source, /disabled=\{outlookStarredSearchDisabled\}/u);
  assert.match(
    source,
    /search: outlookStarredSearchDisabled \? "" : debouncedSearchTerm/u,
  );

  const refreshStart = source.indexOf("const refreshMail = async () => {");
  const refreshEnd = source.indexOf("const updateMessages", refreshStart);
  const refreshFlow = source.slice(refreshStart, refreshEnd);
  assert.match(refreshFlow, /throwOnError: true/u);

  for (const [startMarker, endMarker] of [
    ["const runMove = async", "const restoreTrash = async"],
    ["const markSelected = async", "const toggleStar = async"],
    ["const toggleStar = async", "const openThread = async"],
    ["const openThread = async", "const switchScope ="],
  ]) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    const flow = source.slice(start, end);
    assert.ok(start >= 0 && end > start, `Missing flow ${startMarker}`);
    assert.match(flow, /await updateMessages\(\)/u);
    assert.match(flow, /catch \{/u);
    assert.match(flow, /mailbox list couldn’t refresh/u);
  }

  const runMoveStart = source.indexOf("const runMove = async");
  const runMoveEnd = source.indexOf("const restoreTrash = async", runMoveStart);
  const runMoveFlow = source.slice(runMoveStart, runMoveEnd);
  assert.match(runMoveFlow, /actionLabel: "Undo"/u);
  assert.match(runMoveFlow, /operation completed, but the mailbox list couldn’t refresh/u);
});
