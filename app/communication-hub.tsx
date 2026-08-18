"use client";

import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  AtSign,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  FileArchive,
  FileImage,
  FileText,
  FolderArchive,
  Forward,
  ImageOff,
  Inbox,
  List,
  LockKeyhole,
  LogOut,
  Mail,
  MailOpen,
  Menu,
  Monitor,
  Moon,
  Paperclip,
  PencilLine,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Star,
  Sun,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import {
  createMailProvider,
  type MailAccount,
  type MailAttachment,
  type MailDraft,
  type MailFolderId,
  type MailMessagePage,
  type MailParticipant,
  type MailProvider,
  type MailThread,
  type MessageLocation,
  type ProviderSource,
  type ThreadMessage,
} from "@/src/providers/mail";
import type { AuthenticatedViewer } from "@/src/auth/viewer";

type Scope = "all" | ProviderSource;
type ThemeMode = "light" | "dark" | "system";
type Density = "compact" | "comfortable" | "relaxed";
type AppView = "mail" | "settings";
type ComposeMode = "new" | "reply" | "forward" | "draft";

interface ToastState {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: "success" | "error";
}

const folderConfig: Array<{
  id: MailFolderId;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "starred", label: "Starred", icon: Star },
  { id: "sent", label: "Sent", icon: Send },
  { id: "drafts", label: "Drafts", icon: PencilLine },
  { id: "archive", label: "Archive", icon: FolderArchive },
  { id: "spam", label: "Spam", icon: AlertCircle },
  { id: "trash", label: "Trash", icon: Trash2 },
];

const scopeLabels: Record<Scope, string> = {
  all: "All accounts",
  gmail: "Gmail",
  outlook: "Outlook",
  zoho: "Zoho Mail",
};

const providerLabels: Record<ProviderSource, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  zoho: "Zoho",
};

const providerColors: Record<ProviderSource, string> = {
  gmail: "#d96555",
  outlook: "#3f78bd",
  zoho: "#c68a35",
};

function initialMailConnectionToast(): ToastState | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const connectedProvider = url.searchParams.get("mail_connected");
  if (
    connectedProvider === "gmail" ||
    connectedProvider === "outlook" ||
    connectedProvider === "zoho"
  ) {
    return { message: `${providerLabels[connectedProvider]} connected` };
  }
  return url.searchParams.has("mail_error")
    ? {
        message:
          "The mailbox couldn’t be connected. Check its permissions and try again.",
        tone: "error",
      }
    : null;
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

const monthNumbers: Record<string, string> = {
  January: "01",
  February: "02",
  March: "03",
  April: "04",
  May: "05",
  June: "06",
  July: "07",
  August: "08",
  September: "09",
  October: "10",
  November: "11",
  December: "12",
};

function toDateTime(value: string) {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const match = value.match(
    /(?:^|\s)(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+at\s+(\d{2}:\d{2})/,
  );
  if (!match) return undefined;
  const [, day, monthName, year, time] = match;
  const month = monthNumbers[monthName];
  return month ? `${year}-${month}-${day.padStart(2, "0")}T${time}` : undefined;
}

function splitRecipients(value: string) {
  return value
    .split(/[;,]/)
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

function replyRecipient(thread: MailThread | null, account?: MailAccount): string {
  const latest = thread?.messages.at(-1);
  const ownAddress = account?.address.trim().toLowerCase();
  const candidates = [
    latest?.sender,
    ...(latest?.recipients ?? []),
    thread?.sender,
  ].filter((participant): participant is MailParticipant => Boolean(participant));
  return (
    candidates.find(
      ({ email }) => !ownAddress || email.trim().toLowerCase() !== ownAddress,
    ) ?? candidates[0]
  )?.email ?? "";
}

function composeIntentFor(
  mode: ComposeMode,
  sourceId: string | undefined,
): MailDraft["composeIntent"] {
  return (mode === "reply" || mode === "forward") && sourceId
    ? { mode, sourceId }
    : undefined;
}

const MAX_COMPOSE_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 5 * 1_024 * 1_024;
const MAX_TOTAL_ATTACHMENT_BYTES = 5 * 1_024 * 1_024;

const CONTROL_SPRING = {
  type: "spring" as const,
  stiffness: 460,
  damping: 32,
  mass: 0.72,
};

const SURFACE_SPRING = {
  type: "spring" as const,
  stiffness: 360,
  damping: 30,
  mass: 0.82,
};

function controlMotion(reduceMotion: boolean | null, tapScale = 0.96) {
  return {
    whileHover: reduceMotion ? undefined : { y: -1 },
    whileTap: reduceMotion ? undefined : { y: 0, scale: tapScale },
    transition: reduceMotion ? { duration: 0 } : CONTROL_SPRING,
  };
}

function formatFileSize(sizeBytes: number) {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  if (sizeBytes < 1_024 * 1_024) return `${Math.ceil(sizeBytes / 1_024)} KB`;
  const megabytes = sizeBytes / (1_024 * 1_024);
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}

function attachmentKind(file: File): MailAttachment["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (
    /(?:zip|gzip|x-7z-compressed|x-rar-compressed|x-tar)/iu.test(file.type) ||
    /\.(?:7z|gz|rar|tar|tgz|zip)$/iu.test(file.name)
  ) {
    return "archive";
  }
  return "document";
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return window.btoa(chunks.join(""));
}

export default function CommunicationHub({
  viewer,
  csrfToken,
}: {
  viewer: AuthenticatedViewer;
  csrfToken: string;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const [provider] = useState(() => createMailProvider(csrfToken));

  return (
    <QueryClientProvider client={queryClient}>
      <Hub provider={provider} viewer={viewer} csrfToken={csrfToken} />
    </QueryClientProvider>
  );
}

function Hub({
  provider,
  viewer,
  csrfToken,
}: {
  provider: MailProvider;
  viewer: AuthenticatedViewer;
  csrfToken: string;
}) {
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion();
  const [view, setView] = useState<AppView>("mail");
  const [scope, setScope] = useState<Scope>("all");
  const [scopeAccountId, setScopeAccountId] = useState<string>();
  const [folder, setFolder] = useState<MailFolderId>("inbox");
  const [selectedId, setSelectedId] = useState("design-review");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "system";
    const stored = window.localStorage.getItem("hub-theme");
    return stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : "system";
  });
  const [density, setDensity] = useState<Density>(() => {
    if (typeof window === "undefined") return "comfortable";
    const stored = window.localStorage.getItem("hub-density");
    return stored === "compact" ||
      stored === "comfortable" ||
      stored === "relaxed"
      ? stored
      : "comfortable";
  });
  const [mobilePane, setMobilePane] = useState<"list" | "reader">("list");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [composeMode, setComposeMode] = useState<ComposeMode | null>(null);
  const [composeInitialDraft, setComposeInitialDraft] =
    useState<MailDraft | null>(null);
  const [loadingDraftId, setLoadingDraftId] = useState<string | null>(null);
  const [settingsSection, setSettingsSection] = useState("general");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(
    initialMailConnectionToast,
  );
  const [externalImages, setExternalImages] = useState(false);
  const [loadedImageThreadIds, setLoadedImageThreadIds] = useState<Set<string>>(
    new Set(),
  );
  const [pendingMailAction, setPendingMailAction] = useState<string | null>(null);
  const [pendingConnectionAction, setPendingConnectionAction] = useState<
    string | null
  >(null);
  const [signingOut, setSigningOut] = useState(false);
  const mailActionPendingRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const composeButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const accountMenuWrapRef = useRef<HTMLDivElement>(null);
  const accountPopoverRef = useRef<HTMLDivElement>(null);
  const composeReturnFocusRef = useRef<HTMLElement | null>(null);
  const composeModeRef = useRef<ComposeMode | null>(null);
  const loadingDraftIdRef = useRef<string | null>(null);
  const draftLoadGenerationRef = useRef(0);

  const openCompose = useCallback(
    (
      mode: ComposeMode,
      initialDraft?: MailDraft,
      returnFocus?: HTMLElement | null,
    ) => {
      if (composeModeRef.current) return;
      const activeElement = returnFocus ?? document.activeElement;
      composeReturnFocusRef.current =
        activeElement instanceof HTMLElement
          ? activeElement
          : composeButtonRef.current;
      composeModeRef.current = mode;
      setComposeInitialDraft(initialDraft ?? null);
      setComposeMode(mode);
    },
    [],
  );

  const closeCompose = useCallback(() => {
    setComposeMode(null);
    setComposeInitialDraft(null);
  }, []);

  const finishComposeExit = useCallback(() => {
    composeModeRef.current = null;
    const returnTarget = composeReturnFocusRef.current;
    if (returnTarget?.isConnected) returnTarget.focus();
    else composeButtonRef.current?.focus();
  }, []);

  const closeSidebar = useCallback((restoreFocus = false) => {
    setSidebarOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
    }
  }, []);

  const closeAccountMenu = useCallback((restoreFocus = false) => {
    setAccountMenuOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => profileButtonRef.current?.focus());
    }
  }, []);

  const accountsQuery = useQuery({
    queryKey: ["mail", "accounts"],
    queryFn: () => provider.getAccounts(),
  });
  const accountLimitFallback =
    scope === "all" && (accountsQuery.data?.length ?? 0) > 5
      ? accountsQuery.data?.[0]
      : undefined;
  const resolvedScope: Scope = accountLimitFallback?.provider ?? scope;
  const resolvedScopeAccountId = accountLimitFallback?.id ?? scopeAccountId;
  const outlookStarredSearchDisabled =
    folder === "starred" &&
    resolvedScope === "outlook" &&
    Boolean(resolvedScopeAccountId);

  useEffect(() => {
    if (outlookStarredSearchDisabled) return;
    const timeout = window.setTimeout(
      () => setDebouncedSearchTerm(searchTerm.trim()),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [outlookStarredSearchDisabled, searchTerm]);

  const foldersQuery = useQuery({
    queryKey: ["mail", "folders", resolvedScope, resolvedScopeAccountId],
    queryFn: () =>
      provider.getFolders(resolvedScope, resolvedScopeAccountId),
  });
  const messagesQuery = useInfiniteQuery({
    queryKey: [
      "mail",
      "messages",
      resolvedScope,
      resolvedScopeAccountId,
      folder,
      outlookStarredSearchDisabled ? "" : debouncedSearchTerm,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<MailMessagePage> => {
      const query = {
        scope: resolvedScope,
        accountId: resolvedScopeAccountId,
        folder,
        search: outlookStarredSearchDisabled ? "" : debouncedSearchTerm,
        cursor: pageParam,
        pageSize: 50,
      };
      if (provider.getMessagesPage) return provider.getMessagesPage(query);
      return { messages: await provider.getMessages(query) };
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const messagePages = messagesQuery.data?.pages ?? [];
  const threads = Array.from(
    new Map(
      messagePages
        .flatMap((page) => page.messages)
        .map((thread) => [thread.id, thread] as const),
    ).values(),
  );
  const unavailableAccountIds = new Set(
    messagePages.flatMap((page) =>
      (page.accountErrors ?? []).map((error) => error.accountId),
    ),
  );
  const hasPartialMessageResults = messagePages.some(
    (page) =>
      page.partial === true || (page.accountErrors?.length ?? 0) > 0,
  );
  const activeThreadSummary =
    threads.find((thread) => thread.id === selectedId) ?? threads[0] ?? null;
  const activeThreadQuery = useQuery({
    queryKey: ["mail", "message", activeThreadSummary?.id],
    queryFn: () => provider.getMessage(activeThreadSummary!.id),
    enabled: Boolean(activeThreadSummary),
  });
  const hasActiveThreadData = activeThreadQuery.data !== undefined;
  const activeThread =
    folder === "drafts"
      ? (activeThreadQuery.data ?? activeThreadSummary)
      : activeThreadQuery.data === null ||
          (activeThreadQuery.isError && !hasActiveThreadData)
        ? null
        : activeThreadQuery.data === undefined
          ? activeThreadSummary
          : activeThreadQuery.data;
  const activeThreadPosition = activeThread
    ? threads.findIndex((thread) => thread.id === activeThread.id) + 1
    : 0;
  const scopedAccount = accountsQuery.data?.find(
    (account) => account.id === resolvedScopeAccountId,
  );
  const selectedAccount =
    scopedAccount ??
    accountsQuery.data?.find(
      (account) => account.id === activeThread?.accountId,
    ) ??
    accountsQuery.data?.[0];
  const scopeLabel = scopedAccount?.label ?? scopeLabels[resolvedScope];

  async function loadDraftForEditing(
    thread: MailThread,
    returnFocus?: HTMLElement | null,
  ) {
    if (composeModeRef.current || loadingDraftIdRef.current) return;
    const focusTarget =
      returnFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : composeButtonRef.current);
    const generation = ++draftLoadGenerationRef.current;
    loadingDraftIdRef.current = thread.id;
    setLoadingDraftId(thread.id);
    setToast(null);

    const showLoadError = () => {
      if (generation !== draftLoadGenerationRef.current) return;
      setToast({
        message: "草稿暂时无法加载，请重试。",
        tone: "error",
        actionLabel: "重试",
        onAction: () => void loadDraftForEditing(thread, focusTarget),
      });
    };

    try {
      const draft = await provider.getDraft?.(thread.id);
      if (
        generation !== draftLoadGenerationRef.current ||
        composeModeRef.current
      )
        return;
      if (
        !draft ||
        draft.id !== thread.id ||
        draft.accountId !== thread.accountId
      ) {
        showLoadError();
        return;
      }
      openCompose(draft.composeIntent?.mode ?? "draft", draft, focusTarget);
    } catch {
      if (!composeModeRef.current) showLoadError();
    } finally {
      if (
        generation === draftLoadGenerationRef.current &&
        loadingDraftIdRef.current === thread.id
      ) {
        loadingDraftIdRef.current = null;
        setLoadingDraftId(null);
      }
    }
  }

  const cancelDraftLoad = () => {
    draftLoadGenerationRef.current += 1;
    loadingDraftIdRef.current = null;
    setLoadingDraftId(null);
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    if (
      !url.searchParams.has("mail_connected") &&
      !url.searchParams.has("mail_error")
    )
      return;
    url.searchParams.delete("mail_connected");
    url.searchParams.delete("mail_error");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("hub-theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("hub-density", density);
  }, [density]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const commandKey = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const searchShortcut = commandKey && key === "k";
      const composeShortcut = commandKey && event.shiftKey && key === "m";

      if (composeModeRef.current) {
        if (searchShortcut || composeShortcut) event.preventDefault();
        return;
      }
      if (searchShortcut) {
        event.preventDefault();
        if (!outlookStarredSearchDisabled) searchRef.current?.focus();
      }
      if (composeShortcut) {
        event.preventDefault();
        if (accountsQuery.data?.length) openCompose("new");
        else {
          setToast({
            message: "Connect a mail account before composing a message.",
            tone: "error",
          });
        }
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    accountsQuery.data?.length,
    openCompose,
    outlookStarredSearchDisabled,
  ]);

  useEffect(() => {
    if (!accountMenuOpen) return;

    const focusFrame = window.requestAnimationFrame(() => {
      accountPopoverRef.current
        ?.querySelector<HTMLButtonElement>("button:not([disabled])")
        ?.focus();
    });
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !accountMenuWrapRef.current?.contains(event.target)
      ) {
        closeAccountMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAccountMenu(true);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen, closeAccountMenu]);

  useEffect(() => {
    if (!sidebarOpen) return;

    const focusFrame = window.requestAnimationFrame(() => {
      sidebarRef.current
        ?.querySelector<HTMLButtonElement>("button:not([disabled])")
        ?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSidebar(true);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeSidebar, sidebarOpen]);

  const refreshMail = async () => {
    try {
      await queryClient.invalidateQueries(
        { queryKey: ["mail"] },
        { throwOnError: true },
      );
      setToast({ message: "Mailbox refreshed" });
    } catch {
      setToast({
        message: "Mailbox refresh failed. Please try again.",
        tone: "error",
      });
    }
  };

  const updateMessages = async () => {
    await Promise.all([
      queryClient.invalidateQueries(
        { queryKey: ["mail", "messages"] },
        { throwOnError: true },
      ),
      queryClient.invalidateQueries(
        { queryKey: ["mail", "folders"] },
        { throwOnError: true },
      ),
    ]);
  };

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: "{}",
      });
      if (!response.ok) throw new Error("Sign-out failed");
      window.location.assign("/");
    } catch {
      setToast({
        message: "Couldn’t sign out. Please try again.",
        tone: "error",
      });
      setSigningOut(false);
    }
  };

  const connectMailAccount = async (mailProvider: ProviderSource) => {
    if (pendingConnectionAction) return;
    setPendingConnectionAction(`connect:${mailProvider}`);
    try {
      const response = await fetch(`/api/mail/connect/${mailProvider}/start`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ returnTo: `/?mail_connected=${mailProvider}` }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const authorizationUrl =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>).authorizationUrl
          : undefined;
      if (!response.ok || typeof authorizationUrl !== "string") {
        throw new Error("Mail connection could not be started");
      }
      const destination = new URL(authorizationUrl);
      if (
        destination.protocol !== "https:" ||
        destination.username ||
        destination.password
      ) {
        throw new Error("Mail provider returned an invalid authorization URL");
      }
      window.location.assign(destination.href);
    } catch {
      setToast({
        message: `${providerLabels[mailProvider]} couldn’t be connected. Check the server configuration and try again.`,
        tone: "error",
      });
      setPendingConnectionAction(null);
    }
  };

  const disconnectMailAccount = async (account: MailAccount) => {
    if (pendingConnectionAction) return;
    if (!window.confirm(`Disconnect ${account.address} from this workspace?`)) {
      return;
    }
    setPendingConnectionAction(`disconnect:${account.id}`);
    try {
      const response = await fetch("/api/mail/disconnect", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ accountId: account.id }),
      });
      const result = (await response.json()) as {
        disconnected?: unknown;
        providerRevocation?: unknown;
      };
      if (!response.ok || result.disconnected !== true) {
        throw new Error("Mailbox disconnect failed");
      }
      setSelectedIds(new Set());
      if (scopeAccountId === account.id) {
        setScope("all");
        setScopeAccountId(undefined);
        setMobilePane("list");
      }
      await queryClient.invalidateQueries(
        { queryKey: ["mail"] },
        { throwOnError: true },
      );
      if (result.providerRevocation === "pending") {
        setToast({
          message: `${account.address} is disconnected locally. Provider revocation is queued; revoke it manually in the provider console if the warning persists.`,
          tone: "error",
        });
      } else {
        setToast({ message: `${account.address} disconnected` });
      }
    } catch {
      setToast({
        message: `${account.address} couldn’t be disconnected. Please try again.`,
        tone: "error",
      });
    } finally {
      setPendingConnectionAction(null);
    }
  };

  const startMailAction = (action: string) => {
    if (mailActionPendingRef.current) return false;
    mailActionPendingRef.current = true;
    setPendingMailAction(action);
    return true;
  };

  const finishMailAction = () => {
    mailActionPendingRef.current = false;
    setPendingMailAction(null);
  };

  const runMove = async (kind: "archive" | "trash", ids: string[]) => {
    if (ids.length === 0) return;
    const originalLocations: MessageLocation[] = ids.flatMap((id) => {
      const thread = threads.find((candidate) => candidate.id === id);
      return thread ? [{ id, folder: thread.folder }] : [];
    });

    if (originalLocations.length !== ids.length) {
      setToast({
        message: "Couldn’t determine every message’s original folder.",
        tone: "error",
      });
      return;
    }

    if (!startMailAction(kind)) return;
    try {
      const result =
        kind === "archive"
          ? await provider.archiveMessages(ids)
          : await provider.moveToTrash(ids);
      const restoredLocations = originalLocations.filter((location) =>
        result.succeeded.includes(location.id),
      );
      setSelectedIds(new Set());
      let refreshFailed = false;
      try {
        await updateMessages();
      } catch {
        refreshFailed = true;
      }

      const action = kind === "archive" ? "archived" : "moved to Trash";
      const failureNote = result.failed.length
        ? `; ${result.failed.length} failed`
        : "";
      const refreshNote = refreshFailed
        ? "; operation completed, but the mailbox list couldn’t refresh"
        : "";
      setToast({
        message: `${result.succeeded.length} message${
          result.succeeded.length === 1 ? "" : "s"
        } ${action}${failureNote}${refreshNote}`,
        tone: result.failed.length || refreshFailed ? "error" : "success",
        ...(restoredLocations.length
          ? {
              actionLabel: "Undo",
              onAction: () => {
                void (async () => {
                  if (!startMailAction("restore")) return;
                  try {
                    const restoreResult = await provider.restoreMessages(
                      restoredLocations,
                    );
                    let restoreRefreshFailed = false;
                    try {
                      await updateMessages();
                    } catch {
                      restoreRefreshFailed = true;
                    }
                    setToast({
                      message: restoreRefreshFailed
                        ? `${restoreResult.succeeded.length} restored${
                            restoreResult.failed.length
                              ? `; ${restoreResult.failed.length} failed`
                              : ""
                          }; the undo completed, but the mailbox list couldn’t refresh`
                        : restoreResult.failed.length
                          ? `${restoreResult.succeeded.length} restored; ${restoreResult.failed.length} failed`
                        : `${restoreResult.succeeded.length} message${
                            restoreResult.succeeded.length === 1 ? "" : "s"
                          } restored`,
                      tone:
                        restoreResult.failed.length || restoreRefreshFailed
                          ? "error"
                          : "success",
                    });
                  } catch {
                    setToast({
                      message: "Couldn’t undo the move. Please try again.",
                      tone: "error",
                    });
                  } finally {
                    finishMailAction();
                  }
                })();
              },
            }
          : {}),
      });
    } catch {
      setToast({
        message:
          kind === "archive"
            ? "Couldn’t archive the selected messages."
            : "Couldn’t move the selected messages to Trash.",
        tone: "error",
      });
    } finally {
      finishMailAction();
    }
  };

  const restoreTrash = async (ids: string[]) => {
    if (ids.length === 0 || !startMailAction("restoreTrash")) return;
    try {
      const result = await provider.restoreFromTrash(ids);
      setSelectedIds(new Set());
      try {
        await updateMessages();
      } catch {
        setToast({
          message: `${result.succeeded.length} message${
            result.succeeded.length === 1 ? "" : "s"
          } restored${
            result.failed.length ? `; ${result.failed.length} failed` : ""
          }, but the mailbox couldn’t refresh.`,
          tone: "error",
        });
        return;
      }
      setToast({
        message: result.failed.length
          ? `${result.succeeded.length} restored from Trash; ${result.failed.length} failed`
          : `${result.succeeded.length} message${
              result.succeeded.length === 1 ? "" : "s"
            } restored from Trash`,
        tone: result.failed.length ? "error" : "success",
      });
    } catch {
      setToast({
        message: "Couldn’t restore the selected messages from Trash.",
        tone: "error",
      });
    } finally {
      finishMailAction();
    }
  };

  const markSelected = async (read: boolean) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || !startMailAction("read")) return;
    try {
      const result = await provider.markRead(ids, read);
      setSelectedIds(new Set());
      let refreshFailed = false;
      try {
        await updateMessages();
      } catch {
        refreshFailed = true;
      }
      setToast({
        message: refreshFailed
          ? `${result.succeeded.length} updated${
              result.failed.length ? `; ${result.failed.length} failed` : ""
            }; the operation completed, but the mailbox list couldn’t refresh`
          : result.failed.length
          ? `${result.succeeded.length} updated; ${result.failed.length} failed`
          : read
            ? "Marked as read"
            : "Marked as unread",
        tone: result.failed.length || refreshFailed ? "error" : "success",
      });
    } catch {
      setToast({
        message: `Couldn’t mark the selected messages as ${
          read ? "read" : "unread"
        }.`,
        tone: "error",
      });
    } finally {
      finishMailAction();
    }
  };

  const toggleStar = async (thread: MailThread) => {
    if (!startMailAction("star")) return;
    try {
      const starred = !thread.starred;
      const result = await provider.setStarred(thread.id, starred);
      let refreshFailed = false;
      try {
        await updateMessages();
      } catch {
        refreshFailed = true;
      }
      setToast({
        message: result.failed.length
          ? "Couldn’t update the star."
          : refreshFailed
            ? "Star updated, but the mailbox list couldn’t refresh."
            : starred
              ? "Message starred"
              : "Star removed",
        tone: result.failed.length || refreshFailed ? "error" : "success",
      });
    } catch {
      setToast({ message: "Couldn’t update the star.", tone: "error" });
    } finally {
      finishMailAction();
    }
  };

  const openThread = async (thread: MailThread) => {
    cancelDraftLoad();
    setSelectedId(thread.id);
    setMobilePane("reader");
    if (folder !== "drafts" && thread.unread && startMailAction("read")) {
      try {
        const result = await provider.markRead([thread.id], true);
        if (result.failed.length) {
          setToast({
            message: "Message opened, but it couldn’t be marked as read.",
            tone: "error",
          });
        } else {
          try {
            await updateMessages();
          } catch {
            setToast({
              message:
                "Message was marked as read, but the mailbox list couldn’t refresh.",
              tone: "error",
            });
          }
        }
      } catch {
        setToast({
          message: "Message opened, but it couldn’t be marked as read.",
          tone: "error",
        });
      } finally {
        finishMailAction();
      }
    }
  };

  const switchScope = (nextScope: Scope, nextAccountId?: string) => {
    cancelDraftLoad();
    if (
      outlookStarredSearchDisabled ||
      (folder === "starred" && nextScope === "outlook" && nextAccountId)
    ) {
      setSearchTerm("");
      setDebouncedSearchTerm("");
    }
    setScope(nextScope);
    setScopeAccountId(nextAccountId);
    setSelectedIds(new Set());
    closeSidebar(sidebarOpen);
    setMobilePane("list");
  };

  const switchFolder = (nextFolder: MailFolderId) => {
    cancelDraftLoad();
    if (
      outlookStarredSearchDisabled ||
      (nextFolder === "starred" &&
        resolvedScope === "outlook" &&
        resolvedScopeAccountId)
    ) {
      setSearchTerm("");
      setDebouncedSearchTerm("");
    }
    setFolder(nextFolder);
    setSelectedIds(new Set());
    closeSidebar(sidebarOpen);
    setMobilePane("list");
  };

  return (
    <div
      className="hub-shell"
      data-density={density}
      data-mobile-pane={mobilePane}
      data-view={view}
    >
      <a className="skip-link" href="#message-list">
        Skip to message list
      </a>
      <a className="skip-link" href="#reader-pane">
        Skip to message
      </a>

      <header className="topbar">
        <div className="topbar-brand">
          <IconButton
            buttonRef={mobileMenuButtonRef}
            className="mobile-menu-button"
            label={view === "settings" ? "Back to mail" : "Open navigation"}
            ariaExpanded={view === "mail" ? sidebarOpen : undefined}
            ariaControls={view === "mail" ? "mail-sidebar" : undefined}
            onClick={() => {
              if (view === "settings") setView("mail");
              else {
                closeAccountMenu();
                setSidebarOpen(true);
              }
            }}
            icon={view === "settings" ? ArrowLeft : Menu}
          />
          <motion.button
            className="brand-button"
            type="button"
            onClick={() => {
              setView("mail");
              setMobilePane("list");
            }}
            aria-label="iMail home"
            {...controlMotion(reduceMotion, 0.98)}
          >
            <span className="brand-mark" aria-hidden="true">
              <span />
              <i />
            </span>
            <span className="brand-wordmark">iMail</span>
          </motion.button>
        </div>

        {view === "mail" ? (
          <div className="search-wrap">
            <Search size={17} aria-hidden="true" />
            <input
              ref={searchRef}
              value={outlookStarredSearchDisabled ? "" : searchTerm}
              disabled={outlookStarredSearchDisabled}
              onChange={(event) => {
                cancelDraftLoad();
                setSelectedIds(new Set());
                setSearchTerm(event.target.value);
              }}
              placeholder={
                outlookStarredSearchDisabled
                  ? "Search is unavailable in Outlook Starred"
                  : `Search ${scopeLabel}`
              }
              aria-label={`Search ${scopeLabel}`}
            />
            <span className="search-shortcut" aria-hidden="true">
              ⌘ K
            </span>
            {searchTerm && !outlookStarredSearchDisabled ? (
              <button
                type="button"
                className="search-clear"
                onClick={() => {
                  cancelDraftLoad();
                  setSelectedIds(new Set());
                  setSearchTerm("");
                }}
                aria-label="Clear search"
              >
                <X size={15} />
              </button>
            ) : null}
          </div>
        ) : (
          <div className="settings-heading-mobile">Settings</div>
        )}

        <div className="topbar-actions">
          {view === "mail" ? (
            <IconButton
              label="Refresh mailbox"
              onClick={refreshMail}
              icon={RefreshCw}
              className={messagesQuery.isFetching ? "is-spinning" : ""}
            />
          ) : (
            <IconButton
              label="Back to mail"
              onClick={() => setView("mail")}
              icon={Mail}
            />
          )}
          <IconButton
            label="Open settings"
            onClick={() => {
              setView("settings");
              setAccountMenuOpen(false);
            }}
            icon={Settings}
          />
          <div className="account-menu-wrap" ref={accountMenuWrapRef}>
            <motion.button
              ref={profileButtonRef}
              className="profile-button"
              type="button"
              onClick={() => {
                closeSidebar();
                setAccountMenuOpen((open) => !open);
              }}
              aria-label="Open account menu"
              aria-expanded={accountMenuOpen}
              aria-controls="account-popover"
              {...controlMotion(reduceMotion)}
            >
              {initials(viewer.displayName || viewer.login)}
              <span className="presence-dot" />
            </motion.button>
            <AnimatePresence>
              {accountMenuOpen ? (
                <motion.div
                  ref={accountPopoverRef}
                  id="account-popover"
                  className="account-popover"
                  initial={
                    reduceMotion ? false : { opacity: 0, y: -8, scale: 0.97 }
                  }
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={
                    reduceMotion
                      ? { opacity: 0 }
                      : { opacity: 0, y: -5, scale: 0.98 }
                  }
                  transition={reduceMotion ? { duration: 0 } : SURFACE_SPRING}
                  style={{ transformOrigin: "top right" }}
                >
                  <div className="account-popover-head">
                    <strong>{viewer.displayName}</strong>
                    <span>@{viewer.login} · Owner access</span>
                  </div>
                  <motion.button
                    type="button"
                    onClick={() => {
                      setView("settings");
                      setSettingsSection("security");
                      closeAccountMenu(true);
                    }}
                    {...controlMotion(reduceMotion, 0.98)}
                  >
                    <ShieldCheck size={16} /> Security
                  </motion.button>
                  <motion.button
                    type="button"
                    disabled={signingOut}
                    onClick={() => void signOut()}
                    {...controlMotion(reduceMotion, 0.98)}
                  >
                    <LogOut size={16} /> {signingOut ? "Signing out…" : "Sign out"}
                  </motion.button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {sidebarOpen ? (
          <motion.button
            className="sidebar-backdrop"
            aria-label="Close navigation"
            type="button"
            onClick={() => closeSidebar(true)}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
            }
          />
        ) : null}
      </AnimatePresence>

      {view === "mail" ? (
        <>
          <aside
            ref={sidebarRef}
            id="mail-sidebar"
            className={`sidebar ${sidebarOpen ? "is-open" : ""}`}
          >
            <motion.button
              ref={composeButtonRef}
              type="button"
              className="compose-primary"
              disabled={!accountsQuery.data?.length}
              title={
                accountsQuery.data?.length
                  ? "Compose a message"
                  : "Connect a mail account before composing"
              }
              onClick={() => openCompose("new")}
              {...controlMotion(reduceMotion, 0.97)}
            >
              <PencilLine size={18} />
              <span>Compose</span>
            </motion.button>

            <div className="sidebar-section" aria-label="Mail accounts">
              <p className="sidebar-label">Mail spaces</p>
              {(accountsQuery.data?.length ?? 0) <= 5 ? (
                <ScopeButton
                  scope="all"
                  active={resolvedScope === "all" && !resolvedScopeAccountId}
                  onClick={() => switchScope("all")}
                />
              ) : (
                <p className="scope-limit-note">
                  Showing the first mailbox. Choose another mailbox to switch.
                </p>
              )}
              {accountsQuery.isError ? (
                <QueryErrorNotice
                  compact
                  title="Accounts unavailable"
                  description={
                    accountsQuery.data
                      ? "Showing previously loaded accounts."
                      : "Mail accounts couldn’t be loaded."
                  }
                  retrying={accountsQuery.isFetching}
                  onRetry={() => void accountsQuery.refetch()}
                />
              ) : null}
              {accountsQuery.data?.map((account) => (
                <ScopeButton
                  key={account.id}
                  scope={account.provider}
                  account={account}
                  active={
                    resolvedScope === account.provider &&
                    resolvedScopeAccountId === account.id
                  }
                  onClick={() => switchScope(account.provider, account.id)}
                />
              ))}
            </div>

            {foldersQuery.isError ? (
              <QueryErrorNotice
                compact
                title="Folders unavailable"
                description={
                  foldersQuery.data
                    ? "Showing previously loaded folder counts."
                    : "Folder counts couldn’t be loaded."
                }
                retrying={foldersQuery.isFetching}
                onRetry={() => void foldersQuery.refetch()}
              />
            ) : null}

            <nav className="folder-nav" aria-label="Mail folders">
              {folderConfig.map((item) => {
                const Icon = item.icon;
                const count = foldersQuery.data?.find(
                  (candidate) => candidate.id === item.id,
                )?.count;
                return (
                  <motion.button
                    key={item.id}
                    type="button"
                    className={folder === item.id ? "is-active" : ""}
                    aria-current={folder === item.id ? "page" : undefined}
                    onClick={() => switchFolder(item.id)}
                    {...controlMotion(reduceMotion, 0.98)}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{item.label}</span>
                    {count ? <small>{count}</small> : null}
                  </motion.button>
                );
              })}
            </nav>

            <motion.button
              type="button"
              className="sidebar-settings"
              onClick={() => {
                closeSidebar(sidebarOpen);
                setView("settings");
              }}
              {...controlMotion(reduceMotion, 0.98)}
            >
              <Settings size={17} />
              <span>Settings</span>
            </motion.button>
          </aside>

          <main className="mail-workspace">
            <section className="list-pane" id="message-list" aria-label="Messages">
              <div className="list-header">
                <div>
                  <p>{scopeLabel}</p>
                  <h1>{folderConfig.find((item) => item.id === folder)?.label}</h1>
                </div>
              </div>

              {selectedIds.size > 0 ? (
                <div className="bulk-toolbar" aria-label="Bulk message actions">
                  <button
                    type="button"
                    className="select-summary"
                    onClick={() => setSelectedIds(new Set())}
                  >
                    <span className="selection-check">
                      <Check size={13} />
                    </span>
                    {selectedIds.size} selected
                  </button>
                  <div>
                    <IconButton
                      label="Archive selected"
                      icon={Archive}
                      onClick={() => runMove("archive", Array.from(selectedIds))}
                      disabled={
                        Boolean(pendingMailAction) ||
                        (folder !== "inbox" && folder !== "starred")
                      }
                    />
                    <IconButton
                      label="Mark selected as read"
                      icon={MailOpen}
                      onClick={() => markSelected(true)}
                      disabled={Boolean(pendingMailAction) || folder === "drafts"}
                    />
                    <IconButton
                      label={
                        folder === "trash"
                          ? "Restore selected from Trash"
                          : "Move selected to Trash"
                      }
                      icon={folder === "trash" ? RefreshCw : Trash2}
                      onClick={() =>
                        folder === "trash"
                          ? restoreTrash(Array.from(selectedIds))
                          : runMove("trash", Array.from(selectedIds))
                      }
                      disabled={Boolean(pendingMailAction) || folder === "drafts"}
                    />
                  </div>
                </div>
              ) : (
                <div className="list-toolbar">
                  <button
                    className="select-all"
                    type="button"
                    disabled={folder === "drafts"}
                    onClick={() =>
                      setSelectedIds(new Set(threads.map((thread) => thread.id)))
                    }
                    aria-label="Select all loaded messages"
                  >
                    <span />
                  </button>
                  <span>
                    {messagesQuery.isError && !messagesQuery.data
                      ? "Messages unavailable"
                      : `${threads.length} conversations`}
                  </span>
                </div>
              )}

              <MessageList
                key={`${resolvedScope}:${resolvedScopeAccountId ?? "all"}:${folder}:${outlookStarredSearchDisabled ? "" : debouncedSearchTerm}`}
                threads={threads}
                activeId={activeThread?.id ?? null}
                selectedIds={selectedIds}
                loading={messagesQuery.isPending}
                error={messagesQuery.isError}
                hasResolvedData={Boolean(messagesQuery.data)}
                partial={hasPartialMessageResults}
                unavailableAccountCount={unavailableAccountIds.size}
                retrying={messagesQuery.isFetching}
                onRetry={() => void messagesQuery.refetch()}
                density={density}
                onOpen={openThread}
                onToggleSelect={(id) => {
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                }}
                onToggleStar={toggleStar}
                onArchive={(id) => runMove("archive", [id])}
                archiveDisabled={
                  Boolean(pendingMailAction) ||
                  (folder !== "inbox" && folder !== "starred")
                }
                selectionDisabled={folder === "drafts"}
                trashAction={folder === "trash" ? "restore" : "trash"}
                onTrashAction={(id) =>
                  folder === "trash"
                    ? restoreTrash([id])
                    : runMove("trash", [id])
                }
                actionsDisabled={Boolean(pendingMailAction) || folder === "drafts"}
                hasMore={Boolean(messagesQuery.hasNextPage)}
                loadingMore={messagesQuery.isFetchingNextPage}
                onLoadMore={() => void messagesQuery.fetchNextPage()}
              />
            </section>

            <ReaderPane
              key={activeThread?.id ?? "empty-reader"}
              thread={activeThread}
              externalImages={
                externalImages ||
                Boolean(
                  activeThread && loadedImageThreadIds.has(activeThread.id),
                )
              }
              onLoadImages={() => {
                if (!activeThread) return;
                setLoadedImageThreadIds((current) => {
                  const next = new Set(current);
                  next.add(activeThread.id);
                  return next;
                });
              }}
              position={activeThreadPosition}
              total={threads.length}
              actionsDisabled={Boolean(pendingMailAction) || folder === "drafts"}
              archiveDisabled={
                Boolean(pendingMailAction) ||
                (folder !== "inbox" && folder !== "starred")
              }
              isDraft={folder === "drafts"}
              trashAction={folder === "trash" ? "restore" : "trash"}
              loadError={
                folder !== "drafts" &&
                (activeThreadQuery.isError || activeThreadQuery.data === null)
              }
              retrying={activeThreadQuery.isFetching}
              draftLoading={loadingDraftId !== null}
              onRetry={() => void activeThreadQuery.refetch()}
              onBack={() => setMobilePane("list")}
              onEditDraft={() =>
                activeThread && void loadDraftForEditing(activeThread)
              }
              onReply={() => openCompose("reply")}
              onForward={() => openCompose("forward")}
              onArchive={() =>
                activeThread && runMove("archive", [activeThread.id])
              }
              onTrashAction={() =>
                activeThread &&
                (folder === "trash"
                  ? restoreTrash([activeThread.id])
                  : runMove("trash", [activeThread.id]))
              }
            />
          </main>

          <motion.button
            type="button"
            className="compose-fab"
            disabled={!accountsQuery.data?.length}
            title={
              accountsQuery.data?.length
                ? "Compose a message"
                : "Connect a mail account before composing"
            }
            onClick={() => {
              if (accountsQuery.data?.length) openCompose("new");
            }}
            aria-label="Compose message"
            {...controlMotion(reduceMotion, 0.92)}
          >
            <PencilLine size={21} />
          </motion.button>
        </>
      ) : (
        <SettingsView
          section={settingsSection}
          setSection={setSettingsSection}
          accounts={accountsQuery.data ?? []}
          accountsAvailable={accountsQuery.data !== undefined}
          accountsError={accountsQuery.isError}
          accountsRetrying={accountsQuery.isFetching}
          onRetryAccounts={() => void accountsQuery.refetch()}
          viewer={viewer}
          theme={theme}
          setTheme={setTheme}
          density={density}
          setDensity={setDensity}
          externalImages={externalImages}
          setExternalImages={setExternalImages}
          onBack={() => setView("mail")}
          onSignOut={() => void signOut()}
          pendingConnectionAction={pendingConnectionAction}
          onConnect={(mailProvider) => void connectMailAccount(mailProvider)}
          onDisconnect={(account) => void disconnectMailAccount(account)}
        />
      )}

      <AnimatePresence onExitComplete={finishComposeExit}>
        {composeMode ? (
          <ComposeDialog
            key={`${composeMode}:${composeInitialDraft?.id ?? "new"}`}
            mode={composeMode}
            initialDraft={composeInitialDraft ?? undefined}
            provider={provider}
            accounts={accountsQuery.data ?? []}
            activeThread={activeThread}
            selectedAccount={selectedAccount}
            onClose={(refreshDrafts = false) => {
              closeCompose();
              if (refreshDrafts) {
                void updateMessages().catch(() => {
                  setToast({
                    message: "草稿已关闭，但邮件列表暂时无法刷新。",
                    tone: "error",
                  });
                });
              }
            }}
            onSent={async () => {
              setToast({ message: "Message sent. Refreshing mailbox…" });
              try {
                await updateMessages();
                setToast({ message: "Message sent" });
              } catch {
                setToast({
                  message: "Message sent, but the mailbox couldn’t refresh.",
                  tone: "error",
                });
              } finally {
                closeCompose();
              }
            }}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {toast ? (
          <motion.div
            className={`toast ${toast.tone === "error" ? "is-error" : ""}`}
            role={toast.tone === "error" ? "alert" : "status"}
            initial={reduceMotion ? false : { opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={
              reduceMotion
                ? { opacity: 0 }
                : { opacity: 0, y: 9, scale: 0.985 }
            }
            transition={reduceMotion ? { duration: 0 } : SURFACE_SPRING}
          >
            {toast.tone === "error" ? (
              <AlertCircle size={17} />
            ) : (
              <CheckCircle2 size={17} />
            )}
            <span>{toast.message}</span>
            {toast.actionLabel ? (
              <button type="button" onClick={toast.onAction}>
                {toast.actionLabel}
              </button>
            ) : null}
            <button
              type="button"
              className="toast-close"
              onClick={() => setToast(null)}
              aria-label="Dismiss notification"
            >
              <X size={15} />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ScopeButton({
  scope,
  account,
  active,
  onClick,
}: {
  scope: Scope;
  account?: MailAccount;
  active: boolean;
  onClick: () => void;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      type="button"
      className={`scope-button ${active ? "is-active" : ""}`}
      onClick={onClick}
      aria-pressed={active}
      {...controlMotion(reduceMotion, 0.98)}
    >
      {scope === "all" ? (
        <span className="all-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <ProviderMark provider={scope} />
      )}
      <span>
        <strong>{account?.label ?? scopeLabels[scope]}</strong>
        {account ? <small>{providerLabels[account.provider]}</small> : null}
      </span>
      {active ? <Check size={14} aria-hidden="true" /> : null}
    </motion.button>
  );
}

function ProviderMark({ provider }: { provider: ProviderSource }) {
  return (
    <span
      className="provider-mark"
      style={{ "--provider-color": providerColors[provider] } as React.CSSProperties}
      aria-label={providerLabels[provider]}
    >
      {provider === "gmail" ? "G" : provider === "outlook" ? "O" : "Z"}
    </span>
  );
}

function QueryErrorNotice({
  title,
  description,
  retrying,
  onRetry,
  compact = false,
  blocking = false,
  warning = false,
}: {
  title: string;
  description: string;
  retrying: boolean;
  onRetry: () => void;
  compact?: boolean;
  blocking?: boolean;
  warning?: boolean;
}) {
  return (
    <div
      className={`query-error${warning ? " is-warning" : ""}${compact ? " is-compact" : ""}${
        blocking ? " is-blocking" : ""
      }`}
      role={warning ? "status" : "alert"}
    >
      <AlertCircle size={17} aria-hidden="true" />
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <button type="button" disabled={retrying} onClick={onRetry}>
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

function MessageList({
  threads,
  activeId,
  selectedIds,
  loading,
  error,
  hasResolvedData,
  partial,
  unavailableAccountCount,
  retrying,
  onRetry,
  density,
  onOpen,
  onToggleSelect,
  onToggleStar,
  onArchive,
  archiveDisabled,
  selectionDisabled,
  trashAction,
  onTrashAction,
  actionsDisabled,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  threads: MailThread[];
  activeId: string | null;
  selectedIds: Set<string>;
  loading: boolean;
  error: boolean;
  hasResolvedData: boolean;
  partial: boolean;
  unavailableAccountCount: number;
  retrying: boolean;
  onRetry: () => void;
  density: Density;
  onOpen: (thread: MailThread) => void;
  onToggleSelect: (id: string) => void;
  onToggleStar: (thread: MailThread) => void;
  onArchive: (id: string) => void;
  archiveDisabled: boolean;
  selectionDisabled: boolean;
  trashAction: "trash" | "restore";
  onTrashAction: (id: string) => void;
  actionsDisabled: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const parentRef = useRef<HTMLDivElement>(null);
  const rowHeight =
    density === "compact" ? 58 : density === "relaxed" ? 78 : 68;
  // TanStack Virtual intentionally returns imperative measurement functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });

  const retainedDataWarning =
    error && hasResolvedData ? (
      <QueryErrorNotice
        title="Messages couldn’t refresh"
        description="Showing the conversations that were already loaded."
        retrying={retrying}
        onRetry={onRetry}
      />
    ) : null;
  const partialDataWarning = partial ? (
    <QueryErrorNotice
      warning
      title="部分账号暂不可用"
      description={
        unavailableAccountCount > 0
          ? `${unavailableAccountCount} 个账号暂未完成同步，已显示其他账号的邮件。`
          : "部分账号暂未完成同步，已显示其他账号的邮件。"
      }
      retrying={retrying}
      onRetry={onRetry}
    />
  ) : null;

  if (error && !hasResolvedData) {
    return (
      <div className="message-list-region">
        <QueryErrorNotice
          blocking
          title="Messages couldn’t be loaded"
          description="Check the connection and try this mailbox again."
          retrying={retrying}
          onRetry={onRetry}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="message-list-region">
        <div className="message-skeletons" aria-label="Loading messages">
          {Array.from({ length: 8 }, (_, index) => (
            <div className="message-skeleton" key={index}>
              <span />
              <div>
                <i />
                <i />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="message-list-region">
        {retainedDataWarning}
        {partialDataWarning}
        <div className="empty-list">
          <MailOpen size={24} />
          <h2>{partial ? "暂时无法显示全部邮件" : "No conversations here"}</h2>
          <p>
            {partial
              ? "已成功加载的账号中没有匹配邮件；其他账号恢复后请重试。"
              : "Try another account, folder, or clear the current search."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list-region">
      {retainedDataWarning}
      {partialDataWarning}
      <motion.div
        className="virtual-list"
        ref={parentRef}
        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduceMotion ? { duration: 0 } : SURFACE_SPRING}
      >
        <div
          className="virtual-list-inner"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const thread = threads[virtualRow.index];
            return (
              <div
                key={thread.id}
                className="virtual-row"
                style={{
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <MessageRow
                  thread={thread}
                  active={thread.id === activeId}
                  selected={selectedIds.has(thread.id)}
                  onOpen={() => onOpen(thread)}
                  onToggleSelect={() => onToggleSelect(thread.id)}
                  onToggleStar={() => onToggleStar(thread)}
                  onArchive={() => onArchive(thread.id)}
                  archiveDisabled={archiveDisabled}
                  selectionDisabled={selectionDisabled}
                  trashAction={trashAction}
                  onTrashAction={() => onTrashAction(thread.id)}
                  actionsDisabled={actionsDisabled}
                />
              </div>
            );
          })}
        </div>
        {hasMore ? (
          <button
            type="button"
            className="load-more"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : (
          <div className="list-end">You’re all caught up</div>
        )}
      </motion.div>
    </div>
  );
}

function MessageRow({
  thread,
  active,
  selected,
  onOpen,
  onToggleSelect,
  onToggleStar,
  onArchive,
  archiveDisabled,
  selectionDisabled,
  trashAction,
  onTrashAction,
  actionsDisabled,
}: {
  thread: MailThread;
  active: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onToggleStar: () => void;
  onArchive: () => void;
  archiveDisabled: boolean;
  selectionDisabled: boolean;
  trashAction: "trash" | "restore";
  onTrashAction: () => void;
  actionsDisabled: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [swipe, setSwipe] = useState(0);
  const pointerStart = useRef<{
    x: number;
    y: number;
    origin: number;
    intent: "pending" | "horizontal" | "vertical";
  } | null>(null);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerStart.current = {
      x: event.clientX,
      y: event.clientY,
      origin: swipe,
      intent: "pending",
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current;
    if (!start) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (
      start.intent === "pending" &&
      Math.max(Math.abs(deltaX), Math.abs(deltaY)) > 12
    ) {
      start.intent =
        Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
    }
    if (start.intent === "horizontal") {
      setSwipe(Math.max(-96, Math.min(96, start.origin + deltaX)));
    }
  };
  const pointerUp = () => {
    if (pointerStart.current?.intent === "horizontal") {
      setSwipe((value) =>
        Math.abs(value) > 56 ? Math.sign(value) * 88 : 0,
      );
    }
    pointerStart.current = null;
  };

  return (
    <div className="swipe-shell">
      <div className="swipe-actions swipe-actions-left">
        <motion.button
          type="button"
          onClick={onArchive}
          disabled={archiveDisabled}
          {...controlMotion(reduceMotion)}
        >
          <Archive size={17} /> Archive
        </motion.button>
      </div>
      <div
        className={`swipe-actions swipe-actions-right${
          trashAction === "restore" ? " is-restore" : ""
        }`}
      >
        <motion.button
          type="button"
          onClick={onTrashAction}
          disabled={actionsDisabled}
          {...controlMotion(reduceMotion)}
        >
          {trashAction === "restore" ? (
            <>
              <RefreshCw size={17} /> Restore
            </>
          ) : (
            <>
              <Trash2 size={17} /> Trash
            </>
          )}
        </motion.button>
      </div>
      <div
        className={`message-row ${thread.unread ? "is-unread" : ""} ${
          active ? "is-active" : ""
        } ${selected ? "is-selected" : ""}`}
        style={{ "--swipe-x": `${swipe}px` } as React.CSSProperties}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      >
        <motion.button
          type="button"
          className="message-select"
          disabled={selectionDisabled}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect();
          }}
          aria-label={`${selected ? "Deselect" : "Select"} message from ${thread.sender.name}`}
          {...controlMotion(reduceMotion)}
        >
          <span className="sender-avatar" aria-hidden="true">
            {initials(thread.sender.name)}
          </span>
          <span className="row-checkbox" aria-hidden="true">
            {selected ? <Check size={13} /> : null}
          </span>
        </motion.button>

        <motion.button
          type="button"
          className="message-open"
          onClick={onOpen}
          aria-current={active ? "true" : undefined}
          whileTap={reduceMotion ? undefined : { scale: 0.995 }}
          transition={reduceMotion ? { duration: 0 } : CONTROL_SPRING}
        >
          <span className="message-line-one">
            <span className="sender-name">
              {thread.unread ? <i className="unread-dot" /> : null}
              {thread.sender.name}
            </span>
            <time
              dateTime={toDateTime(thread.receivedAtFull)}
              title={thread.receivedAtFull}
            >
              {thread.receivedAt}
            </time>
          </span>
          <span className="message-line-two">
            <strong>{thread.subject}</strong>
            <span className="row-meta">
              <ProviderMark provider={thread.provider} />
            </span>
          </span>
          <span className="message-preview">{thread.preview}</span>
        </motion.button>

        <motion.button
          type="button"
          className={`row-star ${thread.starred ? "is-starred" : ""}`}
          disabled={actionsDisabled}
          onClick={(event) => {
            event.stopPropagation();
            onToggleStar();
          }}
          aria-label={`${thread.starred ? "Remove star from" : "Star"} ${thread.subject}`}
          {...controlMotion(reduceMotion)}
        >
          <Star size={16} fill={thread.starred ? "currentColor" : "none"} />
        </motion.button>
      </div>
    </div>
  );
}

function ReaderPane({
  thread,
  externalImages,
  onLoadImages,
  position,
  total,
  actionsDisabled,
  archiveDisabled,
  isDraft,
  trashAction,
  loadError,
  retrying,
  draftLoading,
  onRetry,
  onBack,
  onEditDraft,
  onReply,
  onForward,
  onArchive,
  onTrashAction,
}: {
  thread: MailThread | null;
  externalImages: boolean;
  onLoadImages: () => void;
  position: number;
  total: number;
  actionsDisabled: boolean;
  archiveDisabled: boolean;
  isDraft: boolean;
  trashAction: "trash" | "restore";
  loadError: boolean;
  retrying: boolean;
  draftLoading: boolean;
  onRetry: () => void;
  onBack: () => void;
  onEditDraft: () => void;
  onReply: () => void;
  onForward: () => void;
  onArchive: () => void;
  onTrashAction: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [expansionOverrides, setExpansionOverrides] = useState<
    Map<string, boolean>
  >(() => new Map());

  if (!thread) {
    if (loadError) {
      return (
        <motion.section
          className="reader-pane reader-empty"
          id="reader-pane"
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduceMotion ? { duration: 0 } : SURFACE_SPRING}
        >
          <QueryErrorNotice
            blocking
            title="Conversation couldn’t be loaded"
            description="The message summary is still in the list. Retry to load its full details."
            retrying={retrying}
            onRetry={onRetry}
          />
        </motion.section>
      );
    }
    return (
      <motion.section
        className="reader-pane reader-empty"
        id="reader-pane"
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduceMotion ? { duration: 0 } : SURFACE_SPRING}
      >
        <div className="reader-empty-mark">
          <Mail size={25} />
        </div>
        <h2>Select a conversation</h2>
        <p>Messages stay with your mail provider and appear here when selected.</p>
      </motion.section>
    );
  }

  return (
    <motion.section
      className="reader-pane"
      id="reader-pane"
      aria-labelledby="mail-subject"
      initial={reduceMotion ? false : { opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={reduceMotion ? { duration: 0 } : SURFACE_SPRING}
    >
      <div className="reader-toolbar">
        <IconButton
          className="reader-back"
          label="Back to message list"
          icon={ArrowLeft}
          onClick={onBack}
        />
        <div className="reader-toolbar-primary">
          <IconButton
            label="Archive message"
            icon={Archive}
            onClick={onArchive}
            disabled={archiveDisabled}
          />
          <IconButton
            label={
              trashAction === "restore"
                ? "Restore message from Trash"
                : "Move message to Trash"
            }
            icon={trashAction === "restore" ? RefreshCw : Trash2}
            onClick={onTrashAction}
            disabled={actionsDisabled}
          />
        </div>
        <div className="reader-position">
          {position > 0 ? `${position} of ${total}` : `${total} conversations`}
        </div>
      </div>

      <div className="reader-scroll">
        {loadError ? (
          <QueryErrorNotice
            title="Conversation couldn’t refresh"
            description="Showing the full details that were already loaded."
            retrying={retrying}
            onRetry={onRetry}
          />
        ) : null}
        <header className="subject-header">
          <div className="subject-meta">
            <ProviderMark provider={thread.provider} />
            <span>{providerLabels[thread.provider]}</span>
            {thread.labels.map((label) => (
              <span className="subject-label" key={label}>
                {label}
              </span>
            ))}
          </div>
          <h1 id="mail-subject">{thread.subject}</h1>
          <div className="participant-summary">
            <span>{thread.messages.length} messages</span>
            <span aria-hidden="true">·</span>
            <span>{thread.sender.name}</span>
          </div>
        </header>

        {thread.messages.some((message) => Boolean(message.contentUrl)) &&
        !externalImages ? (
          <div className="image-guard">
            <ImageOff size={17} />
            <div>
              <strong>External images are hidden</strong>
              <span>Loading them may reveal when this message was opened.</span>
            </div>
            <button type="button" onClick={onLoadImages}>
              Load once
            </button>
          </div>
        ) : null}

        <div className="thread-stack">
          {thread.messages.map((message, index) => {
            const current = index === thread.messages.length - 1;
            const isExpanded = expansionOverrides.get(message.id) ?? current;
            return (
              <ThreadArticle
                key={message.id}
                message={message}
                externalImages={externalImages}
                expanded={isExpanded}
                current={current}
                onToggle={() => {
                  setExpansionOverrides((items) => {
                    const next = new Map(items);
                    next.set(message.id, !isExpanded);
                    return next;
                  });
                }}
              />
            );
          })}
        </div>

        {!isDraft ? (
          <div className="thread-actions">
            <button type="button" onClick={onReply}>
              <Reply size={17} /> Reply
            </button>
            <button type="button" onClick={onForward}>
              <Forward size={17} /> Forward
            </button>
          </div>
        ) : null}
      </div>

      {isDraft ? (
        <button
          className="quick-reply"
          type="button"
          disabled={draftLoading}
          aria-busy={draftLoading}
          onClick={onEditDraft}
        >
          <span className="quick-avatar">
            <PencilLine size={15} aria-hidden="true" />
          </span>
          <span>{draftLoading ? "正在加载草稿…" : "继续编辑"}</span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      ) : (
        <button className="quick-reply" type="button" onClick={onReply}>
          <span className="quick-avatar">PH</span>
          <span>Reply to the latest sender…</span>
          <Reply size={17} />
        </button>
      )}
    </motion.section>
  );
}

function ThreadArticle({
  message,
  externalImages,
  expanded,
  current,
  onToggle,
}: {
  message: ThreadMessage;
  externalImages: boolean;
  expanded: boolean;
  current: boolean;
  onToggle: () => void;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <article className={`thread-message ${current ? "is-current" : ""}`}>
      <motion.button
        type="button"
        className="thread-message-header"
        aria-expanded={expanded}
        onClick={onToggle}
        whileTap={reduceMotion ? undefined : { scale: 0.995 }}
        transition={reduceMotion ? { duration: 0 } : CONTROL_SPRING}
      >
        <span className="thread-avatar" aria-hidden="true">
          {initials(message.sender.name)}
        </span>
        <span className="thread-sender">
          <strong>{message.sender.name}</strong>
          <small>
            {message.recipients.length
              ? `to ${message.recipients
                  .map((recipient) => recipient.name || recipient.email)
                  .join(", ")}`
              : "recipients unavailable"}
          </small>
        </span>
        {!expanded ? <span className="collapsed-preview">Message history</span> : null}
        <time
          dateTime={toDateTime(message.sentAtFull)}
          title={message.sentAtFull}
        >
          {message.sentAt}
        </time>
        <ChevronRight
          size={16}
          className={expanded ? "chevron-expanded" : ""}
          aria-hidden="true"
        />
      </motion.button>
      <AnimatePresence initial={false}>
        {expanded ? (
        <motion.div
          key="message-body"
          className="message-body"
          initial={reduceMotion ? false : { opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={reduceMotion ? { duration: 0 } : SURFACE_SPRING}
        >
          {message.contentUrl ? (
            <iframe
              src={mailContentUrl(message.contentUrl, externalImages)}
              sandbox=""
              referrerPolicy="no-referrer"
              loading="lazy"
              title={`Message from ${message.sender.name}`}
              style={{
                display: "block",
                width: "100%",
                minHeight: 320,
                border: 0,
              }}
            />
          ) : (
            message.body.map((paragraph, index) => (
              <p key={`${index}:${paragraph}`}>{paragraph}</p>
            ))
          )}
          {message.attachments.length > 0 ? (
            <div className="attachments" aria-label="Attachments">
              {message.attachments.map((attachment) => {
                const AttachmentIcon =
                  attachment.kind === "image"
                    ? FileImage
                    : attachment.kind === "archive"
                      ? FileArchive
                      : FileText;
                const attachmentContent = (
                  <>
                    <span className="attachment-icon">
                      <AttachmentIcon size={19} />
                    </span>
                    <span>
                      <strong>{attachment.name}</strong>
                      <small>{attachment.size}</small>
                    </span>
                    <Download size={16} />
                  </>
                );
                return attachment.downloadUrl ? (
                  <a
                    className="attachment"
                    href={attachment.downloadUrl}
                    download={attachment.name}
                    key={attachment.id}
                    style={{ textDecoration: "none" }}
                  >
                    {attachmentContent}
                  </a>
                ) : (
                  <button
                    type="button"
                    className="attachment"
                    disabled
                    title="This attachment is not available for download"
                    key={attachment.id}
                  >
                    {attachmentContent}
                  </button>
                );
              })}
            </div>
          ) : null}
        </motion.div>
        ) : null}
      </AnimatePresence>
    </article>
  );
}

function mailContentUrl(contentUrl: string, externalImages: boolean): string {
  if (!externalImages) return contentUrl;
  return `${contentUrl}${contentUrl.includes("?") ? "&" : "?"}externalImages=1`;
}

function ComposeDialog({
  mode,
  initialDraft,
  provider,
  accounts,
  activeThread,
  selectedAccount,
  onClose,
  onSent,
}: {
  mode: ComposeMode;
  initialDraft?: MailDraft;
  provider: MailProvider;
  accounts: MailAccount[];
  activeThread: MailThread | null;
  selectedAccount?: MailAccount;
  onClose: (refreshDrafts?: boolean) => void;
  onSent: () => Promise<void>;
}) {
  const reduceMotion = useReducedMotion();
  const dialogRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState(
    initialDraft?.accountId ?? selectedAccount?.id ?? accounts[0]?.id ?? "",
  );
  const resolvedAccountId =
    accountId || selectedAccount?.id || accounts[0]?.id || "";
  const [recipient, setRecipient] = useState(
    initialDraft?.to.join(", ") ??
      (mode === "reply" ? replyRecipient(activeThread, selectedAccount) : ""),
  );
  const [cc, setCc] = useState(initialDraft?.cc.join(", ") ?? "");
  const [bcc, setBcc] = useState(initialDraft?.bcc.join(", ") ?? "");
  const [subject, setSubject] = useState(
    initialDraft?.subject ??
      (mode === "reply"
        ? `Re: ${activeThread?.subject ?? ""}`
        : mode === "forward"
          ? `Fwd: ${activeThread?.subject ?? ""}`
          : ""),
  );
  const [body, setBody] = useState(initialDraft?.body ?? "");
  const [showCopies, setShowCopies] = useState(
    Boolean(initialDraft?.cc.length || initialDraft?.bcc.length),
  );
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [addingAttachments, setAddingAttachments] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "dirty" | "saving" | "saved" | "error"
  >(initialDraft?.id ? "saved" : "idle");
  const [attachments, setAttachments] = useState<MailAttachment[]>(() =>
    (initialDraft?.attachments ?? []).map((attachment) => ({ ...attachment })),
  );
  const [accountSelectionLocked, setAccountSelectionLocked] = useState(
    mode !== "new" || Boolean(initialDraft?.id),
  );
  const [composeError, setComposeError] = useState<string | null>(null);
  const draftIdRef = useRef<string | undefined>(initialDraft?.id);
  const draftRevisionRef = useRef(0);
  const lastSavedRevisionRef = useRef(initialDraft?.id ? 0 : -1);
  const accountIdRef = useRef(resolvedAccountId);
  const accountSelectionLockedRef = useRef(
    mode !== "new" || Boolean(initialDraft?.id),
  );
  const composePhaseRef = useRef<"editing" | "closing" | "sending">(
    "editing",
  );
  const autosaveTimerRef = useRef<number | null>(null);
  const attachmentTaskRef = useRef(false);
  const sourceThreadIdRef = useRef(
    initialDraft?.composeIntent?.sourceId ?? activeThread?.id,
  );
  const draftSavePromiseRef = useRef<
    {
      accountId: string;
      promise: Promise<{ id: string; savedAt: string }>;
    } | null
  >(null);
  const selected = accounts.find(
    (account) => account.id === resolvedAccountId,
  );
  const composeLocked = sending || closing || addingAttachments;
  const hasDraftContent = Boolean(
    recipient || cc || bcc || subject || body || attachments.length,
  );

  useEffect(() => {
    accountIdRef.current = resolvedAccountId;
  }, [resolvedAccountId]);

  const markDraftDirty = () => {
    accountSelectionLockedRef.current = true;
    setAccountSelectionLocked(true);
    draftRevisionRef.current += 1;
    setSaveState("dirty");
    setComposeError(null);
  };

  const addAttachments = async (files: File[]) => {
    const resetInput = () => {
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    if (files.length === 0) {
      resetInput();
      return;
    }
    if (composePhaseRef.current !== "editing" || attachmentTaskRef.current) {
      resetInput();
      return;
    }
    if (attachments.length + files.length > MAX_COMPOSE_ATTACHMENTS) {
      setComposeError(`You can attach up to ${MAX_COMPOSE_ATTACHMENTS} files.`);
      resetInput();
      return;
    }
    const invalidName = files.find(
      (file) => !file.name.trim() || file.name.length > 255,
    );
    if (invalidName) {
      setComposeError("Attachment names must be between 1 and 255 characters.");
      resetInput();
      return;
    }
    const emptyFile = files.find((file) => file.size === 0);
    if (emptyFile) {
      setComposeError(`${emptyFile.name} is empty and can’t be attached.`);
      resetInput();
      return;
    }
    const oversizedFile = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversizedFile) {
      setComposeError(
        `${oversizedFile.name} is larger than the 5 MB file limit.`,
      );
      resetInput();
      return;
    }
    const existingBytes = attachments.reduce(
      (total, attachment) => total + (attachment.sizeBytes ?? 0),
      0,
    );
    const selectedBytes = files.reduce((total, file) => total + file.size, 0);
    if (existingBytes + selectedBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      setComposeError("Attachments can’t exceed 5 MB in total.");
      resetInput();
      return;
    }

    attachmentTaskRef.current = true;
    setAddingAttachments(true);
    setComposeError(null);
    try {
      const encoded = await Promise.all(
        files.map(async (file): Promise<MailAttachment> => ({
          id: window.crypto.randomUUID(),
          name: file.name,
          size: formatFileSize(file.size),
          sizeBytes: file.size,
          mimeType:
            file.type && file.type.length <= 255
              ? file.type
              : "application/octet-stream",
          kind: attachmentKind(file),
          contentBase64: await fileToBase64(file),
        })),
      );
      setAttachments((current) => [...current, ...encoded]);
      markDraftDirty();
    } catch {
      setComposeError("The selected files couldn’t be read. Choose them again.");
    } finally {
      attachmentTaskRef.current = false;
      setAddingAttachments(false);
      resetInput();
    }
  };

  const createDraft = (): MailDraft => ({
    id: draftIdRef.current,
    accountId: accountIdRef.current,
    to: splitRecipients(recipient),
    cc: splitRecipients(cc),
    bcc: splitRecipients(bcc),
    subject,
    body,
    attachments,
    composeIntent: composeIntentFor(mode, sourceThreadIdRef.current),
  });

  useEffect(() => {
    if (sending || closing || composePhaseRef.current !== "editing") return;
    if (!selected?.capabilities.reliableDraftUpdates) return;
    if (!hasDraftContent || saveState !== "dirty") return;
    const revision = draftRevisionRef.current;
    const timeout = window.setTimeout(() => {
      if (autosaveTimerRef.current === timeout) autosaveTimerRef.current = null;
      if (
        composePhaseRef.current !== "editing" ||
        revision !== draftRevisionRef.current
      )
        return;
      accountSelectionLockedRef.current = true;
      setAccountSelectionLocked(true);
      const draft: MailDraft = {
        id: draftIdRef.current,
        accountId: accountIdRef.current,
        to: splitRecipients(recipient),
        cc: splitRecipients(cc),
        bcc: splitRecipients(bcc),
        subject,
        body,
        attachments,
        composeIntent: composeIntentFor(mode, sourceThreadIdRef.current),
      };

      void (async () => {
        setSaveState("saving");
        setComposeError(null);
        const previousSave = draftSavePromiseRef.current;
        const savePromise = (async () => {
          let previousDraft: { id: string; savedAt: string } | null = null;
          try {
            previousDraft = (await previousSave?.promise) ?? null;
          } catch {
            // A newer snapshot should still be allowed to retry the save.
          }
          if (accountIdRef.current !== draft.accountId) {
            throw new Error("Draft account changed before save");
          }
          return provider.saveDraft({
            ...draft,
            id:
              draftIdRef.current ??
              (previousSave?.accountId === draft.accountId
                ? previousDraft?.id
                : undefined),
          });
        })();
        const saveEntry = { accountId: draft.accountId, promise: savePromise };
        draftSavePromiseRef.current = saveEntry;
        try {
          const savedDraft = await savePromise;
          if (accountIdRef.current === draft.accountId) {
            draftIdRef.current = savedDraft.id;
            lastSavedRevisionRef.current = revision;
            if (revision === draftRevisionRef.current) setSaveState("saved");
          }
        } catch {
          if (
            accountIdRef.current === draft.accountId &&
            revision === draftRevisionRef.current
          ) {
            setSaveState("error");
            setComposeError(
              "Draft couldn’t be saved automatically. Your text is still here.",
            );
          }
        } finally {
          if (draftSavePromiseRef.current === saveEntry) {
            draftSavePromiseRef.current = null;
          }
        }
      })();
    }, 700);
    autosaveTimerRef.current = timeout;
    return () => {
      window.clearTimeout(timeout);
      if (autosaveTimerRef.current === timeout) autosaveTimerRef.current = null;
    };
  }, [
    resolvedAccountId,
    attachments,
    bcc,
    body,
    cc,
    hasDraftContent,
    mode,
    provider,
    recipient,
    saveState,
    selected?.capabilities.reliableDraftUpdates,
    sending,
    subject,
    closing,
  ]);

  const requestClose = async () => {
    if (
      composePhaseRef.current !== "editing" ||
      attachmentTaskRef.current
    )
      return;
    composePhaseRef.current = "closing";
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const currentRevision = draftRevisionRef.current;
    if (
      currentRevision === 0 ||
      (!hasDraftContent && !draftIdRef.current) ||
      lastSavedRevisionRef.current === currentRevision
    ) {
      onClose(
        currentRevision > 0 &&
          Boolean(draftIdRef.current) &&
          lastSavedRevisionRef.current === currentRevision,
      );
      return;
    }

    accountSelectionLockedRef.current = true;
    setAccountSelectionLocked(true);
    setClosing(true);
    setSaveState("saving");
    setComposeError(null);
    try {
      const pendingSave = draftSavePromiseRef.current;
      try {
        const pendingDraft = await pendingSave?.promise;
        if (
          pendingDraft &&
          pendingSave?.accountId === accountIdRef.current
        ) {
          draftIdRef.current ??= pendingDraft.id;
        }
      } catch {
        // Retry below with the latest complete draft snapshot.
      }
      if (lastSavedRevisionRef.current !== currentRevision) {
        const savedDraft = await provider.saveDraft(createDraft());
        draftIdRef.current = savedDraft.id;
        lastSavedRevisionRef.current = currentRevision;
      }
      setSaveState("saved");
      onClose(true);
    } catch {
      composePhaseRef.current = "editing";
      setSaveState("error");
      setComposeError(
        "Draft couldn’t be saved, so the composer stayed open. Please try again.",
      );
    } finally {
      if (composePhaseRef.current === "editing") setClosing(false);
    }
  };

  const sendMessage = async () => {
    if (
      !resolvedAccountId ||
      !recipient.trim() ||
      !subject.trim() ||
      composePhaseRef.current !== "editing" ||
      attachmentTaskRef.current
    )
      return;
    composePhaseRef.current = "sending";
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    accountSelectionLockedRef.current = true;
    setAccountSelectionLocked(true);
    setSending(true);
    setComposeError(null);
    let sent = false;
    try {
      const pendingSave = draftSavePromiseRef.current;
      try {
        const pendingDraft = await pendingSave?.promise;
        if (
          pendingDraft &&
          pendingSave?.accountId === accountIdRef.current
        ) {
          draftIdRef.current ??= pendingDraft.id;
        }
      } catch {
        // Sending can continue with the current text if auto-save failed.
      }
      const draft = createDraft();
      if (mode === "reply" || mode === "forward") {
        const sourceId = sourceThreadIdRef.current;
        if (!sourceId) throw new Error("Reply or forward source is unavailable");
        if (mode === "reply") await provider.replyMessage(sourceId, draft);
        else await provider.forwardMessage(sourceId, draft);
      } else {
        await provider.sendMessage(draft);
      }
      await onSent();
      sent = true;
    } catch {
      composePhaseRef.current = "editing";
      setComposeError(
        "Message couldn’t be sent. Check the recipients and try again.",
      );
    } finally {
      if (!sent) {
        composePhaseRef.current = "editing";
        setSending(false);
      }
    }
  };

  return (
    <motion.div
      className="compose-backdrop"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }
      }
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void requestClose();
      }}
    >
      <motion.section
        ref={dialogRef}
        className="compose-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-title"
        aria-busy={composeLocked}
        tabIndex={-1}
        initial={reduceMotion ? false : { opacity: 0, y: 22, scale: 0.975 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={
          reduceMotion
            ? { opacity: 0 }
            : { opacity: 0, y: 14, scale: 0.985 }
        }
        transition={reduceMotion ? { duration: 0 } : SURFACE_SPRING}
        onKeyDown={(event) => {
          if (event.key === "Escape") void requestClose();
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
          }
          if (event.key === "Tab") {
            const focusable = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
              ),
            ).filter((element) => !element.hasAttribute("hidden"));
            const first = focusable[0];
            const last = focusable.at(-1);
            if (!first || !last) {
              event.preventDefault();
              event.currentTarget.focus();
            } else if (
              event.shiftKey &&
              (document.activeElement === first ||
                !event.currentTarget.contains(document.activeElement))
            ) {
              event.preventDefault();
              last.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last ||
                !event.currentTarget.contains(document.activeElement))
            ) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header className="compose-header">
          <div>
            <span className="compose-mark" />
            <h2 id="compose-title">
              {mode === "new"
                ? "New message"
                : mode === "reply"
                  ? "Reply"
                  : mode === "forward"
                    ? "Forward"
                    : "Edit draft"}
            </h2>
          </div>
          <div className="draft-state" aria-live="polite">
            {saveState === "saving" ? (
              <>
                <Clock3 size={13} /> Saving…
              </>
            ) : saveState === "saved" ? (
              <>
                <Check size={13} /> Saved
              </>
            ) : saveState === "error" ? (
              <>
                <AlertCircle size={13} /> Not saved
              </>
            ) : !selected?.capabilities.reliableDraftUpdates ? (
              <>
                <AlertCircle size={13} /> Save on close
              </>
            ) : saveState === "dirty" ? (
              <>
                <Clock3 size={13} /> Waiting to save…
              </>
            ) : null}
          </div>
          <IconButton
            label="Close compose"
            icon={X}
            onClick={() => void requestClose()}
            disabled={composeLocked}
          />
        </header>

        <div className="compose-fields">
          <label className="compose-field">
            <span>From</span>
            <select
              value={resolvedAccountId}
              disabled={composeLocked || accountSelectionLocked}
              onChange={(event) => {
                if (accountSelectionLockedRef.current) return;
                accountIdRef.current = event.target.value;
                lastSavedRevisionRef.current = -1;
                draftIdRef.current = undefined;
                setSaveState("idle");
                setComposeError(null);
                setAccountId(event.target.value);
              }}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} — {account.address}
                </option>
              ))}
            </select>
          </label>
          <label className="compose-field recipient-field">
            <span>To</span>
            <input
              autoFocus
              type="email"
              multiple
              value={recipient}
              disabled={composeLocked}
              onChange={(event) => {
                markDraftDirty();
                setRecipient(event.target.value);
              }}
              placeholder="name@example.test"
            />
            <button
              type="button"
              disabled={composeLocked}
              onClick={() => setShowCopies((show) => !show)}
            >
              Cc / Bcc
            </button>
          </label>
          {showCopies ? (
            <>
              <label className="compose-field">
                <span>Cc</span>
                <input
                  type="text"
                  value={cc}
                  disabled={composeLocked}
                  onChange={(event) => {
                    markDraftDirty();
                    setCc(event.target.value);
                  }}
                  aria-label="Carbon copy recipients"
                  placeholder="Separate addresses with commas"
                />
              </label>
              <label className="compose-field">
                <span>Bcc</span>
                <input
                  type="text"
                  value={bcc}
                  disabled={composeLocked}
                  onChange={(event) => {
                    markDraftDirty();
                    setBcc(event.target.value);
                  }}
                  aria-label="Blind carbon copy recipients"
                  placeholder="Separate addresses with commas"
                />
              </label>
            </>
          ) : null}
          <label className="compose-field">
            <span>Subject</span>
            <input
              value={subject}
              disabled={composeLocked}
              onChange={(event) => {
                markDraftDirty();
                setSubject(event.target.value);
              }}
              placeholder="A clear subject"
            />
          </label>
        </div>

        <label className="compose-body">
          <span className="sr-only">Message body</span>
          <textarea
            value={body}
            disabled={composeLocked}
            onChange={(event) => {
              markDraftDirty();
              setBody(event.target.value);
            }}
            placeholder="Write a message…"
          />
        </label>

        {attachments.map((attachment) => (
          <div className="compose-attachment" key={attachment.id}>
            <FileText size={18} />
            <span>
              <strong>{attachment.name}</strong>
              <small>{attachment.size} · ready</small>
            </span>
            <button
              type="button"
              disabled={composeLocked}
              onClick={() => {
                markDraftDirty();
                setAttachments((current) =>
                  current.filter((item) => item.id !== attachment.id),
                );
              }}
              aria-label={`Remove ${attachment.name}`}
            >
              <X size={15} />
            </button>
          </div>
        ))}

        {composeError ? (
          <div className="compose-error" role="alert">
            <AlertCircle size={15} /> {composeError}
          </div>
        ) : null}

        <footer className="compose-footer">
          <div>
            <button
              type="button"
              className="send-button"
              disabled={
                !resolvedAccountId ||
                !recipient.trim() ||
                !subject.trim() ||
                composeLocked
              }
              onClick={sendMessage}
            >
              <Send size={16} /> {sending ? "Sending…" : "Send"}
            </button>
            <button
              type="button"
              className="attach-button"
              disabled={
                attachments.length >= MAX_COMPOSE_ATTACHMENTS || composeLocked
              }
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={17} />
              <span className="sr-only">Attach file</span>
            </button>
            <input
              ref={fileInputRef}
              hidden
              type="file"
              multiple
              disabled={composeLocked}
              onChange={(event) =>
                void addAttachments(Array.from(event.currentTarget.files ?? []))
              }
            />
          </div>
          <span>Up to 10 files · 5 MB each and total</span>
        </footer>
      </motion.section>
    </motion.div>
  );
}

function SettingsView({
  section,
  setSection,
  accounts,
  accountsAvailable,
  accountsError,
  accountsRetrying,
  onRetryAccounts,
  viewer,
  theme,
  setTheme,
  density,
  setDensity,
  externalImages,
  setExternalImages,
  onBack,
  onSignOut,
  pendingConnectionAction,
  onConnect,
  onDisconnect,
}: {
  section: string;
  setSection: (section: string) => void;
  accounts: MailAccount[];
  accountsAvailable: boolean;
  accountsError: boolean;
  accountsRetrying: boolean;
  onRetryAccounts: () => void;
  viewer: AuthenticatedViewer;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  density: Density;
  setDensity: (density: Density) => void;
  externalImages: boolean;
  setExternalImages: (value: boolean) => void;
  onBack: () => void;
  onSignOut: () => void;
  pendingConnectionAction: string | null;
  onConnect: (provider: ProviderSource) => void;
  onDisconnect: (account: MailAccount) => void;
}) {
  const sections = [
    ["general", "General", Settings],
    ["mail", "Mail", Mail],
    ["accounts", "Accounts", AtSign],
    ["security", "Security", ShieldCheck],
  ] as const;

  return (
    <main className="settings-page">
      <aside className="settings-nav">
        <button type="button" className="settings-back" onClick={onBack}>
          <ArrowLeft size={17} /> Back to mail
        </button>
        <h1>Settings</h1>
        <nav aria-label="Settings sections">
          {sections.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              className={section === id ? "is-active" : ""}
              onClick={() => setSection(id)}
            >
              <Icon size={17} /> {label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="settings-content">
        <div className="settings-inner">
          {accountsError ? (
            <QueryErrorNotice
              title="Accounts couldn’t be refreshed"
              description={
                accountsAvailable
                  ? "Showing the accounts that were already loaded."
                  : "Connected mail accounts are temporarily unavailable."
              }
              retrying={accountsRetrying}
              onRetry={onRetryAccounts}
            />
          ) : null}
          {section === "general" ? (
            <>
              <SettingsHeader
                title="General"
                description="Choose how this private workspace looks and feels on this device."
              />
              <SettingsGroup title="Appearance">
                <SettingRow label="Theme" description="Follow your system or choose a fixed theme.">
                  <SegmentedControl
                    value={theme}
                    onChange={(value) => setTheme(value as ThemeMode)}
                    options={[
                      ["light", "Light", Sun],
                      ["dark", "Dark", Moon],
                      ["system", "System", Monitor],
                    ]}
                  />
                </SettingRow>
                <SettingRow label="Density" description="Reading width and type size remain unchanged.">
                  <SegmentedControl
                    value={density}
                    onChange={(value) => setDensity(value as Density)}
                    options={[
                      ["compact", "Compact", List],
                      ["comfortable", "Comfort", Mail],
                      ["relaxed", "Relaxed", Menu],
                    ]}
                  />
                </SettingRow>
              </SettingsGroup>
            </>
          ) : null}

          {section === "mail" ? (
            <>
              <SettingsHeader
                title="Mail"
                description="Control how remote message content is displayed."
              />
              <SettingsGroup title="Reading">
                <SettingRow
                  label="External images"
                  description="Hidden by default to reduce tracking."
                >
                  <Toggle
                    checked={externalImages}
                    onChange={setExternalImages}
                    label="Load external images"
                  />
                </SettingRow>
              </SettingsGroup>
            </>
          ) : null}

          {section === "accounts" ? (
            <>
              <SettingsHeader
                title="Accounts"
                description="Connected services stay separate and can be revoked independently."
              />
              <SettingsGroup title="Mail providers">
                {accounts.length ? (
                  accounts.map((account) => (
                    <div className="connected-row" key={account.id}>
                      <ProviderMark provider={account.provider} />
                      <span>
                        <strong>{providerLabels[account.provider]}</strong>
                        <small>{account.address}</small>
                      </span>
                      <span className="connected-status">
                        <i /> Connected
                      </span>
                      <button
                        type="button"
                        disabled={Boolean(pendingConnectionAction)}
                        onClick={() => onDisconnect(account)}
                      >
                        {pendingConnectionAction === `disconnect:${account.id}`
                          ? "Disconnecting…"
                          : "Disconnect"}
                      </button>
                    </div>
                  ))
                ) : accountsAvailable ? (
                  <p>No mailboxes are connected yet.</p>
                ) : null}
              </SettingsGroup>
              <SettingsGroup title="Connect a mailbox">
                {(["gmail", "outlook", "zoho"] as const).map(
                  (mailProvider) => {
                    const connectedCount = accounts.filter(
                      (account) => account.provider === mailProvider,
                    ).length;
                    return (
                      <div className="connected-row" key={mailProvider}>
                        <ProviderMark provider={mailProvider} />
                        <span>
                          <strong>{providerLabels[mailProvider]}</strong>
                          <small>
                            {connectedCount
                              ? `${connectedCount} mailbox${connectedCount === 1 ? "" : "es"} connected`
                              : "Connect with OAuth"}
                          </small>
                        </span>
                        <button
                          type="button"
                          disabled={Boolean(pendingConnectionAction)}
                          onClick={() => onConnect(mailProvider)}
                        >
                          {pendingConnectionAction === `connect:${mailProvider}`
                            ? "Opening…"
                            : connectedCount
                              ? "Add account"
                              : "Connect"}
                        </button>
                      </div>
                    );
                  },
                )}
              </SettingsGroup>
              <SettingsGroup title="Login identities">
                <div className="connected-row">
                  <span className="github-mark" aria-hidden="true">
                    GH
                  </span>
                  <span>
                    <strong>GitHub</strong>
                    <small>@{viewer.login} · Identity only</small>
                  </span>
                  <span className="identity-status">Verified</span>
                </div>
              </SettingsGroup>
              <button type="button" className="secondary-wide" onClick={onSignOut}>
                <LogOut size={16} /> Sign out of this session
              </button>
            </>
          ) : null}

          {section === "security" ? (
            <>
              <SettingsHeader
                title="Security"
                description="Review the identity and session protecting this browser."
              />
              <div className="security-notice">
                <LockKeyhole size={19} />
                <div>
                  <strong>Owner-only access is active</strong>
                  <span>New identities must pass the server-side allowlist before a session is created.</span>
                </div>
              </div>
              <SettingsGroup title="Current devices">
                <SessionRow
                  name="Current browser"
                  detail={`Signed in as @${viewer.login}`}
                  current
                />
              </SettingsGroup>
              <div className="security-notice">
                <ShieldCheck size={19} />
                <div>
                  <strong>Other-session management is not available yet</strong>
                  <span>Use “Sign out of this session” in Accounts to revoke this browser.</span>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function SettingsHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="settings-content-header">
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-group">
      <h3>{title}</h3>
      <div>{children}</div>
    </section>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      {children}
    </div>
  );
}

function SegmentedControl({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string, LucideIcon]>;
}) {
  return (
    <div className="segmented-control">
      {options.map(([id, label, Icon]) => (
        <button
          type="button"
          key={id}
          className={value === id ? "is-active" : ""}
          onClick={() => onChange(id)}
          aria-pressed={value === id}
        >
          <Icon size={15} /> {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange?: (checked: boolean) => void;
}) {
  const [internal, setInternal] = useState(checked);
  const value = onChange ? checked : internal;
  return (
    <button
      className={`toggle ${value ? "is-on" : ""}`}
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => {
        if (onChange) onChange(!value);
        else setInternal(!value);
      }}
    >
      <span />
    </button>
  );
}

function SessionRow({
  name,
  detail,
  current,
}: {
  name: string;
  detail: string;
  current?: boolean;
}) {
  return (
    <div className="session-row">
      <span className="session-icon">
        <Monitor size={17} />
      </span>
      <span>
        <strong>{name}</strong>
        <small>{detail}</small>
      </span>
      {current ? (
        <span className="current-session">Current</span>
      ) : (
        <button type="button">Revoke</button>
      )}
    </div>
  );
}

function IconButton({
  label,
  icon: Icon,
  onClick,
  className = "",
  disabled = false,
  buttonRef,
  ariaExpanded,
  ariaControls,
}: {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  ariaExpanded?: boolean;
  ariaControls?: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      ref={buttonRef}
      type="button"
      className={`icon-button ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      title={label}
      {...controlMotion(reduceMotion)}
    >
      <Icon size={18} aria-hidden="true" />
    </motion.button>
  );
}

