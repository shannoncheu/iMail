"use client";

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  AtSign,
  Bold,
  Check,
  CheckCircle2,
  ChevronDown,
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
  Italic,
  Link2,
  List,
  ListOrdered,
  LockKeyhole,
  LogOut,
  Mail,
  MailOpen,
  Menu,
  Monitor,
  Moon,
  MoreHorizontal,
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
  Tag,
  Trash2,
  Underline,
  X,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  createMailProvider,
  type MailAccount,
  type MailDraft,
  type MailFolderId,
  type MailProvider,
  type MailThread,
  type ProviderSource,
  type ThreadMessage,
} from "@/src/providers/mail";

type Scope = "all" | ProviderSource;
type ThemeMode = "light" | "dark" | "system";
type Density = "compact" | "comfortable" | "relaxed";
type AppView = "mail" | "settings" | "login";
type ComposeMode = "new" | "reply" | "forward";

interface ToastState {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
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

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export default function CommunicationHub() {
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
  const [provider] = useState(() => createMailProvider());

  return (
    <QueryClientProvider client={queryClient}>
      <Hub provider={provider} />
    </QueryClientProvider>
  );
}

function Hub({ provider }: { provider: MailProvider }) {
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion();
  const [view, setView] = useState<AppView>("mail");
  const [scope, setScope] = useState<Scope>("all");
  const [folder, setFolder] = useState<MailFolderId>("inbox");
  const [selectedId, setSelectedId] = useState("design-review");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
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
  const [settingsSection, setSettingsSection] = useState("general");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [externalImages, setExternalImages] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const composeButtonRef = useRef<HTMLButtonElement>(null);

  const accountsQuery = useQuery({
    queryKey: ["mail", "accounts"],
    queryFn: () => provider.getAccounts(),
  });
  const foldersQuery = useQuery({
    queryKey: ["mail", "folders", scope],
    queryFn: () => provider.getFolders(scope),
  });
  const messagesQuery = useQuery({
    queryKey: ["mail", "messages", scope, folder, searchTerm],
    queryFn: () =>
      provider.getMessages({
        scope,
        folder,
        search: searchTerm,
      }),
    placeholderData: (previous) => previous,
  });

  const threads = messagesQuery.data ?? [];
  const activeThread =
    threads.find((thread) => thread.id === selectedId) ?? threads[0] ?? null;
  const selectedAccount =
    accountsQuery.data?.find(
      (account) => account.id === activeThread?.accountId,
    ) ?? accountsQuery.data?.[0];

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("hub-theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("hub-density", density);
  }, [density]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "m"
      ) {
        event.preventDefault();
        setComposeMode("new");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const refreshMail = async () => {
    await queryClient.invalidateQueries({ queryKey: ["mail"] });
    setToast({ message: "Mailbox refreshed" });
  };

  const updateMessages = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mail", "messages"] }),
      queryClient.invalidateQueries({ queryKey: ["mail", "folders"] }),
    ]);
  };

  const runMove = async (kind: "archive" | "trash", ids: string[]) => {
    if (ids.length === 0) return;
    if (kind === "archive") {
      await provider.archiveMessages(ids);
    } else {
      await provider.moveToTrash(ids);
    }
    setSelectedIds(new Set());
    await updateMessages();
    setToast({
      message:
        kind === "archive"
          ? `${ids.length} message${ids.length > 1 ? "s" : ""} archived`
          : `${ids.length} message${ids.length > 1 ? "s" : ""} moved to Trash`,
      actionLabel: "Undo",
      onAction: async () => {
        await provider.restoreFromTrash(ids);
        await updateMessages();
        setToast({ message: "Message restored" });
      },
    });
  };

  const markSelected = async (read: boolean) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    await provider.markRead(ids, read);
    setSelectedIds(new Set());
    await updateMessages();
    setToast({ message: read ? "Marked as read" : "Marked as unread" });
  };

  const toggleStar = async (thread: MailThread) => {
    await provider.setStarred(thread.id, !thread.starred);
    await updateMessages();
  };

  const openThread = async (thread: MailThread) => {
    setSelectedId(thread.id);
    setMobilePane("reader");
    if (thread.unread) {
      await provider.markRead([thread.id], true);
      await updateMessages();
    }
  };

  const switchScope = (nextScope: Scope) => {
    setScope(nextScope);
    setSelectedIds(new Set());
    setSidebarOpen(false);
    setMobilePane("list");
  };

  const switchFolder = (nextFolder: MailFolderId) => {
    setFolder(nextFolder);
    setSelectedIds(new Set());
    setSidebarOpen(false);
    setMobilePane("list");
  };

  const closeCompose = () => {
    setComposeMode(null);
    window.setTimeout(() => composeButtonRef.current?.focus(), 0);
  };

  if (view === "login") {
    return <LoginView onEnter={() => setView("mail")} />;
  }

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
            className="mobile-menu-button"
            label="Open navigation"
            onClick={() => setSidebarOpen(true)}
            icon={Menu}
          />
          <button
            className="brand-button"
            type="button"
            onClick={() => {
              setView("mail");
              setMobilePane("list");
            }}
            aria-label="Private Hub home"
          >
            <span className="brand-mark" aria-hidden="true">
              <span />
              <i />
            </span>
            <span className="brand-wordmark">Private Hub</span>
          </button>
        </div>

        {view === "mail" ? (
          <div className="search-wrap">
            <Search size={17} aria-hidden="true" />
            <input
              ref={searchRef}
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={`Search ${scopeLabels[scope]}`}
              aria-label={`Search ${scopeLabels[scope]}`}
            />
            <span className="search-shortcut" aria-hidden="true">
              ⌘ K
            </span>
            {searchTerm ? (
              <button
                type="button"
                className="search-clear"
                onClick={() => setSearchTerm("")}
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
          <div className="account-menu-wrap">
            <button
              className="profile-button"
              type="button"
              onClick={() => setAccountMenuOpen((open) => !open)}
              aria-label="Open account menu"
              aria-expanded={accountMenuOpen}
            >
              PH
              <span className="presence-dot" />
            </button>
            <AnimatePresence>
              {accountMenuOpen ? (
                <motion.div
                  className="account-popover"
                  initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: reduceMotion ? 0 : 0.15 }}
                >
                  <div className="account-popover-head">
                    <strong>Private owner</strong>
                    <span>Owner access</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setView("settings");
                      setSettingsSection("security");
                      setAccountMenuOpen(false);
                    }}
                  >
                    <ShieldCheck size={16} /> Security
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setView("login");
                      setAccountMenuOpen(false);
                    }}
                  >
                    <LogOut size={16} /> Sign out of mock session
                  </button>
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
            onClick={() => setSidebarOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
        ) : null}
      </AnimatePresence>

      {view === "mail" ? (
        <>
          <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
            <button
              ref={composeButtonRef}
              type="button"
              className="compose-primary"
              onClick={() => setComposeMode("new")}
            >
              <PencilLine size={18} />
              <span>Compose</span>
            </button>

            <div className="sidebar-section" aria-label="Mail accounts">
              <p className="sidebar-label">Mail spaces</p>
              <ScopeButton
                scope="all"
                active={scope === "all"}
                onClick={() => switchScope("all")}
              />
              {accountsQuery.data?.map((account) => (
                <ScopeButton
                  key={account.id}
                  scope={account.provider}
                  account={account}
                  active={scope === account.provider}
                  onClick={() => switchScope(account.provider)}
                />
              ))}
            </div>

            <nav className="folder-nav" aria-label="Mail folders">
              {folderConfig.map((item) => {
                const Icon = item.icon;
                const count = foldersQuery.data?.find(
                  (candidate) => candidate.id === item.id,
                )?.count;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={folder === item.id ? "is-active" : ""}
                    aria-current={folder === item.id ? "page" : undefined}
                    onClick={() => switchFolder(item.id)}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{item.label}</span>
                    {count ? <small>{count}</small> : null}
                  </button>
                );
              })}
            </nav>

            <div className="sidebar-section labels-section">
              <p className="sidebar-label">Labels</p>
              {["Design", "Personal", "Receipts"].map((label, index) => (
                <button type="button" className="label-link" key={label}>
                  <span className={`label-dot label-${index + 1}`} />
                  {label}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="sidebar-settings"
              onClick={() => setView("settings")}
            >
              <Settings size={17} />
              <span>Settings</span>
            </button>
          </aside>

          <main className="mail-workspace">
            <section className="list-pane" id="message-list" aria-label="Messages">
              <div className="list-header">
                <div>
                  <p>{scopeLabels[scope]}</p>
                  <h1>{folderConfig.find((item) => item.id === folder)?.label}</h1>
                </div>
                <button className="folder-menu" type="button">
                  <ChevronDown size={16} />
                  <span className="sr-only">Folder options</span>
                </button>
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
                    />
                    <IconButton
                      label="Mark selected as read"
                      icon={MailOpen}
                      onClick={() => markSelected(true)}
                    />
                    <IconButton
                      label="Move selected to Trash"
                      icon={Trash2}
                      onClick={() => runMove("trash", Array.from(selectedIds))}
                    />
                  </div>
                </div>
              ) : (
                <div className="list-toolbar">
                  <button
                    className="select-all"
                    type="button"
                    onClick={() =>
                      setSelectedIds(new Set(threads.map((thread) => thread.id)))
                    }
                    aria-label="Select all loaded messages"
                  >
                    <span />
                  </button>
                  <span>{threads.length} conversations</span>
                  <IconButton label="Filter messages" icon={Tag} />
                </div>
              )}

              <MessageList
                threads={threads}
                activeId={activeThread?.id ?? null}
                selectedIds={selectedIds}
                loading={messagesQuery.isPending}
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
                onTrash={(id) => runMove("trash", [id])}
              />
            </section>

            <ReaderPane
              key={activeThread?.id ?? "empty-reader"}
              thread={activeThread}
              externalImages={externalImages}
              onLoadImages={() => setExternalImages(true)}
              onBack={() => setMobilePane("list")}
              onReply={() => setComposeMode("reply")}
              onForward={() => setComposeMode("forward")}
              onArchive={() =>
                activeThread && runMove("archive", [activeThread.id])
              }
              onTrash={() =>
                activeThread && runMove("trash", [activeThread.id])
              }
            />
          </main>

          <button
            type="button"
            className="compose-fab"
            onClick={() => setComposeMode("new")}
            aria-label="Compose message"
          >
            <PencilLine size={21} />
          </button>
        </>
      ) : (
        <SettingsView
          section={settingsSection}
          setSection={setSettingsSection}
          accounts={accountsQuery.data ?? []}
          theme={theme}
          setTheme={setTheme}
          density={density}
          setDensity={setDensity}
          externalImages={externalImages}
          setExternalImages={setExternalImages}
          onBack={() => setView("mail")}
          onSignOut={() => setView("login")}
        />
      )}

      <AnimatePresence>
        {composeMode ? (
          <ComposeDialog
            key={composeMode}
            mode={composeMode}
            provider={provider}
            accounts={accountsQuery.data ?? []}
            activeThread={activeThread}
            selectedAccount={selectedAccount}
            onClose={closeCompose}
            onSent={() => {
              closeCompose();
              setToast({ message: "Message sent" });
            }}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {toast ? (
          <motion.div
            className="toast"
            role="status"
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
          >
            <CheckCircle2 size={17} />
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
  return (
    <button
      type="button"
      className={`scope-button ${active ? "is-active" : ""}`}
      onClick={onClick}
      aria-pressed={active}
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
    </button>
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

function MessageList({
  threads,
  activeId,
  selectedIds,
  loading,
  density,
  onOpen,
  onToggleSelect,
  onToggleStar,
  onArchive,
  onTrash,
}: {
  threads: MailThread[];
  activeId: string | null;
  selectedIds: Set<string>;
  loading: boolean;
  density: Density;
  onOpen: (thread: MailThread) => void;
  onToggleSelect: (id: string) => void;
  onToggleStar: (thread: MailThread) => void;
  onArchive: (id: string) => void;
  onTrash: (id: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [loadedCount, setLoadedCount] = useState(18);
  const visibleThreads = threads.slice(0, loadedCount);
  const rowHeight =
    density === "compact" ? 58 : density === "relaxed" ? 78 : 68;
  // TanStack Virtual intentionally returns imperative measurement functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visibleThreads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });

  useEffect(() => {
    setLoadedCount(18);
    parentRef.current?.scrollTo({ top: 0 });
  }, [threads]);

  if (loading) {
    return (
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
    );
  }

  if (threads.length === 0) {
    return (
      <div className="empty-list">
        <MailOpen size={24} />
        <h2>No conversations here</h2>
        <p>Try another account, folder, or clear the current search.</p>
      </div>
    );
  }

  return (
    <div className="virtual-list" ref={parentRef}>
      <div
        className="virtual-list-inner"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const thread = visibleThreads[virtualRow.index];
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
                onTrash={() => onTrash(thread.id)}
              />
            </div>
          );
        })}
      </div>
      {loadedCount < threads.length ? (
        <button
          type="button"
          className="load-more"
          onClick={() => setLoadedCount((count) => count + 18)}
        >
          Load more
        </button>
      ) : (
        <div className="list-end">You’re all caught up</div>
      )}
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
  onTrash,
}: {
  thread: MailThread;
  active: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onToggleStar: () => void;
  onArchive: () => void;
  onTrash: () => void;
}) {
  const [swipe, setSwipe] = useState(0);
  const startX = useRef<number | null>(null);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    startX.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (startX.current === null) return;
    const delta = event.clientX - startX.current;
    if (Math.abs(delta) > 12) {
      setSwipe(Math.max(-96, Math.min(96, delta)));
    }
  };
  const pointerUp = () => {
    setSwipe((value) => (Math.abs(value) > 56 ? Math.sign(value) * 88 : 0));
    startX.current = null;
  };

  return (
    <div className="swipe-shell">
      <div className="swipe-actions swipe-actions-left">
        <button type="button" onClick={onArchive}>
          <Archive size={17} /> Archive
        </button>
      </div>
      <div className="swipe-actions swipe-actions-right">
        <button type="button" onClick={onTrash}>
          <Trash2 size={17} /> Trash
        </button>
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
        <button
          type="button"
          className="message-select"
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect();
          }}
          aria-label={`${selected ? "Deselect" : "Select"} message from ${thread.sender.name}`}
        >
          <span className="sender-avatar" aria-hidden="true">
            {initials(thread.sender.name)}
          </span>
          <span className="row-checkbox" aria-hidden="true">
            {selected ? <Check size={13} /> : null}
          </span>
        </button>

        <button
          type="button"
          className="message-open"
          onClick={onOpen}
          aria-current={active ? "true" : undefined}
        >
          <span className="message-line-one">
            <span className="sender-name">
              {thread.unread ? <i className="unread-dot" /> : null}
              {thread.sender.name}
            </span>
            <time dateTime="2026-08-18">{thread.receivedAt}</time>
          </span>
          <span className="message-line-two">
            <strong>{thread.subject}</strong>
            <span className="row-meta">
              {thread.messages.some((message) => message.attachments.length) ? (
                <Paperclip size={13} aria-label="Has attachment" />
              ) : null}
              <ProviderMark provider={thread.provider} />
            </span>
          </span>
          <span className="message-preview">{thread.preview}</span>
        </button>

        <button
          type="button"
          className={`row-star ${thread.starred ? "is-starred" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleStar();
          }}
          aria-label={`${thread.starred ? "Remove star from" : "Star"} ${thread.subject}`}
        >
          <Star size={16} fill={thread.starred ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
  );
}

function ReaderPane({
  thread,
  externalImages,
  onLoadImages,
  onBack,
  onReply,
  onForward,
  onArchive,
  onTrash,
}: {
  thread: MailThread | null;
  externalImages: boolean;
  onLoadImages: () => void;
  onBack: () => void;
  onReply: () => void;
  onForward: () => void;
  onArchive: () => void;
  onTrash: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!thread) {
    return (
      <section className="reader-pane reader-empty" id="reader-pane">
        <div className="reader-empty-mark">
          <Mail size={25} />
        </div>
        <h2>Select a conversation</h2>
        <p>Messages stay with your mail provider and appear here when selected.</p>
      </section>
    );
  }

  return (
    <section className="reader-pane" id="reader-pane" aria-labelledby="mail-subject">
      <div className="reader-toolbar">
        <IconButton
          className="reader-back"
          label="Back to message list"
          icon={ArrowLeft}
          onClick={onBack}
        />
        <div className="reader-toolbar-primary">
          <IconButton label="Archive message" icon={Archive} onClick={onArchive} />
          <IconButton label="Move message to Trash" icon={Trash2} onClick={onTrash} />
          <IconButton label="More message actions" icon={MoreHorizontal} />
        </div>
        <div className="reader-position">1 of 18</div>
      </div>

      <div className="reader-scroll">
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

        {thread.hasExternalImages && !externalImages ? (
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
            const isExpanded = current || expanded.has(message.id);
            return (
              <ThreadArticle
                key={message.id}
                message={message}
                expanded={isExpanded}
                current={current}
                onToggle={() => {
                  setExpanded((items) => {
                    const next = new Set(items);
                    if (next.has(message.id)) next.delete(message.id);
                    else next.add(message.id);
                    return next;
                  });
                }}
              />
            );
          })}
        </div>

        <div className="thread-actions">
          <button type="button" onClick={onReply}>
            <Reply size={17} /> Reply
          </button>
          <button type="button" onClick={onForward}>
            <Forward size={17} /> Forward
          </button>
        </div>
      </div>

      <button className="quick-reply" type="button" onClick={onReply}>
        <span className="quick-avatar">PH</span>
        <span>Reply to {thread.sender.name}…</span>
        <Reply size={17} />
      </button>
    </section>
  );
}

function ThreadArticle({
  message,
  expanded,
  current,
  onToggle,
}: {
  message: ThreadMessage;
  expanded: boolean;
  current: boolean;
  onToggle: () => void;
}) {
  return (
    <article className={`thread-message ${current ? "is-current" : ""}`}>
      <button
        type="button"
        className="thread-message-header"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="thread-avatar" aria-hidden="true">
          {initials(message.sender.name)}
        </span>
        <span className="thread-sender">
          <strong>{message.sender.name}</strong>
          <small>to me</small>
        </span>
        {!expanded ? <span className="collapsed-preview">Message history</span> : null}
        <time title={message.sentAtFull}>{message.sentAt}</time>
        <ChevronRight
          size={16}
          className={expanded ? "chevron-expanded" : ""}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div className="message-body">
          {message.body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {message.attachments.length > 0 ? (
            <div className="attachments" aria-label="Attachments">
              {message.attachments.map((attachment) => {
                const AttachmentIcon =
                  attachment.kind === "image"
                    ? FileImage
                    : attachment.kind === "archive"
                      ? FileArchive
                      : FileText;
                return (
                  <button type="button" className="attachment" key={attachment.id}>
                    <span className="attachment-icon">
                      <AttachmentIcon size={19} />
                    </span>
                    <span>
                      <strong>{attachment.name}</strong>
                      <small>{attachment.size}</small>
                    </span>
                    <Download size={16} />
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function ComposeDialog({
  mode,
  provider,
  accounts,
  activeThread,
  selectedAccount,
  onClose,
  onSent,
}: {
  mode: ComposeMode;
  provider: MailProvider;
  accounts: MailAccount[];
  activeThread: MailThread | null;
  selectedAccount?: MailAccount;
  onClose: () => void;
  onSent: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [accountId, setAccountId] = useState(
    selectedAccount?.id ?? accounts[0]?.id ?? "",
  );
  const [recipient, setRecipient] = useState(
    mode === "reply" ? activeThread?.sender.email ?? "" : "",
  );
  const [subject, setSubject] = useState(
    mode === "reply"
      ? `Re: ${activeThread?.subject ?? ""}`
      : mode === "forward"
        ? `Fwd: ${activeThread?.subject ?? ""}`
        : "",
  );
  const [body, setBody] = useState("");
  const [showCopies, setShowCopies] = useState(false);
  const [sending, setSending] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [attachmentAdded, setAttachmentAdded] = useState(false);
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  const selected = accounts.find((account) => account.id === accountId);
  const displayedSaveState = selected?.capabilities.reliableDraftUpdates
    ? saveState
    : "limited";

  useEffect(() => {
    if (!selected?.capabilities.reliableDraftUpdates) return;
    if (!recipient && !subject && !body) return;
    const timeout = window.setTimeout(async () => {
      await provider.saveDraft({
        accountId,
        to: recipient ? [recipient] : [],
        cc: [],
        bcc: [],
        subject,
        body,
        attachments: [],
      });
      setSaveState("saved");
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [accountId, body, provider, recipient, selected, subject]);

  const sendMessage = async () => {
    if (!recipient || !subject || sending) return;
    setSending(true);
    const draft: MailDraft = {
      accountId,
      to: [recipient],
      cc: [],
      bcc: [],
      subject,
      body,
      attachments: [],
    };
    if (mode === "reply" && activeThread) {
      await provider.replyMessage(activeThread.id, draft);
    } else if (mode === "forward" && activeThread) {
      await provider.forwardMessage(activeThread.id, draft);
    } else {
      await provider.sendMessage(draft);
    }
    setSending(false);
    onSent();
  };

  const toggleFormat = (format: string) => {
    setActiveFormats((current) => {
      const next = new Set(current);
      if (next.has(format)) next.delete(format);
      else next.add(format);
      return next;
    });
  };

  return (
    <motion.div
      className="compose-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.18 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.section
        className="compose-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-title"
        initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
        transition={{ duration: reduceMotion ? 0 : 0.22 }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
          }
        }}
      >
        <header className="compose-header">
          <div>
            <span className="compose-mark" />
            <h2 id="compose-title">
              {mode === "new" ? "New message" : mode === "reply" ? "Reply" : "Forward"}
            </h2>
          </div>
          <div className="draft-state" aria-live="polite">
            {displayedSaveState === "saving" ? (
              <>
                <Clock3 size={13} /> Saving…
              </>
            ) : displayedSaveState === "saved" ? (
              <>
                <Check size={13} /> Saved
              </>
            ) : displayedSaveState === "limited" ? (
              <>
                <AlertCircle size={13} /> Save on close
              </>
            ) : null}
          </div>
          <IconButton label="Close compose" icon={X} onClick={onClose} />
        </header>

        <div className="compose-fields">
          <label className="compose-field">
            <span>From</span>
            <select
              value={accountId}
              onChange={(event) => {
                setSaveState("saving");
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
              value={recipient}
              onChange={(event) => {
                setSaveState("saving");
                setRecipient(event.target.value);
              }}
              placeholder="name@example.test"
            />
            <button type="button" onClick={() => setShowCopies((show) => !show)}>
              Cc / Bcc
            </button>
          </label>
          {showCopies ? (
            <>
              <label className="compose-field">
                <span>Cc</span>
                <input type="email" aria-label="Carbon copy recipients" />
              </label>
              <label className="compose-field">
                <span>Bcc</span>
                <input type="email" aria-label="Blind carbon copy recipients" />
              </label>
            </>
          ) : null}
          <label className="compose-field">
            <span>Subject</span>
            <input
              value={subject}
              onChange={(event) => {
                setSaveState("saving");
                setSubject(event.target.value);
              }}
              placeholder="A clear subject"
            />
          </label>
        </div>

        <div className="format-toolbar" role="toolbar" aria-label="Message formatting">
          {[
            ["bold", Bold, "Bold"],
            ["italic", Italic, "Italic"],
            ["underline", Underline, "Underline"],
            ["list", List, "Bulleted list"],
            ["ordered", ListOrdered, "Numbered list"],
            ["link", Link2, "Add link"],
          ].map(([id, Icon, label]) => (
            <button
              key={id as string}
              type="button"
              className={activeFormats.has(id as string) ? "is-active" : ""}
              onClick={() => toggleFormat(id as string)}
              aria-label={label as string}
              aria-pressed={activeFormats.has(id as string)}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>

        <label className="compose-body">
          <span className="sr-only">Message body</span>
          <textarea
            value={body}
            onChange={(event) => {
              setSaveState("saving");
              setBody(event.target.value);
            }}
            placeholder="Write a message…"
          />
        </label>

        {attachmentAdded ? (
          <div className="compose-attachment">
            <FileText size={18} />
            <span>
              <strong>project-note.pdf</strong>
              <small>248 KB · ready</small>
            </span>
            <button
              type="button"
              onClick={() => setAttachmentAdded(false)}
              aria-label="Remove project-note.pdf"
            >
              <X size={15} />
            </button>
          </div>
        ) : null}

        <footer className="compose-footer">
          <div>
            <button
              type="button"
              className="send-button"
              disabled={!recipient || !subject || sending}
              onClick={sendMessage}
            >
              <Send size={16} /> {sending ? "Sending…" : "Send"}
            </button>
            <button
              type="button"
              className="attach-button"
              onClick={() => setAttachmentAdded(true)}
            >
              <Paperclip size={17} />
              <span className="sr-only">Attach file</span>
            </button>
          </div>
          <span>⌘ Enter shortcut is off</span>
        </footer>
      </motion.section>
    </motion.div>
  );
}

function SettingsView({
  section,
  setSection,
  accounts,
  theme,
  setTheme,
  density,
  setDensity,
  externalImages,
  setExternalImages,
  onBack,
  onSignOut,
}: {
  section: string;
  setSection: (section: string) => void;
  accounts: MailAccount[];
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  density: Density;
  setDensity: (density: Density) => void;
  externalImages: boolean;
  setExternalImages: (value: boolean) => void;
  onBack: () => void;
  onSignOut: () => void;
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
                <SettingRow label="Language" description="Interface language only; message content is untouched.">
                  <button type="button" className="value-button">
                    English <ChevronDown size={15} />
                  </button>
                </SettingRow>
              </SettingsGroup>
            </>
          ) : null}

          {section === "mail" ? (
            <>
              <SettingsHeader
                title="Mail"
                description="Control conversation layout, remote content, and your signature."
              />
              <SettingsGroup title="Reading">
                <SettingRow label="Conversation view" description="Group replies into a single thread.">
                  <Toggle checked label="Conversation view" />
                </SettingRow>
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
              <SettingsGroup title="Writing">
                <label className="signature-field">
                  <span>Signature</span>
                  <textarea defaultValue={"—\nSent from my private communication hub"} />
                </label>
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
                {accounts.map((account) => (
                  <div className="connected-row" key={account.id}>
                    <ProviderMark provider={account.provider} />
                    <span>
                      <strong>{providerLabels[account.provider]}</strong>
                      <small>{account.address}</small>
                    </span>
                    <span className="connected-status">
                      <i /> Connected
                    </span>
                    <button type="button">Manage</button>
                  </div>
                ))}
              </SettingsGroup>
              <SettingsGroup title="Login identities">
                <div className="connected-row">
                  <span className="github-mark" aria-hidden="true">
                    GH
                  </span>
                  <span>
                    <strong>GitHub</strong>
                    <small>Identity only — no notification access</small>
                  </span>
                  <span className="identity-status">Not connected</span>
                  <button type="button">Connect</button>
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
                description="Review active sessions and remove access you no longer recognize."
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
                  detail="Tokyo · Active now"
                  current
                />
                <SessionRow name="Mobile device" detail="Tokyo · 2 hours ago" />
                <SessionRow name="Desktop browser" detail="Osaka · 6 days ago" />
              </SettingsGroup>
              <button type="button" className="danger-button">
                Revoke all other sessions
              </button>
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

function LoginView({ onEnter }: { onEnter: () => void }) {
  const providers = [
    ["Google", "gmail"],
    ["Microsoft", "outlook"],
    ["Zoho", "zoho"],
    ["GitHub", "github"],
  ] as const;
  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-brand">
          <span className="brand-mark large" aria-hidden="true">
            <span />
            <i />
          </span>
          <span>Private Hub</span>
        </div>
        <div className="login-copy">
          <span className="private-badge">
            <LockKeyhole size={13} /> Private access
          </span>
          <h1>Your communication, in one quiet place.</h1>
          <p>Sign in with an approved identity. This application does not offer public registration.</p>
        </div>
        <div className="login-options">
          {providers.map(([label, id]) => (
            <button type="button" key={id} onClick={onEnter}>
              {id === "github" ? (
                <span className="github-mark">GH</span>
              ) : (
                <ProviderMark provider={id} />
              )}
              Continue with {label}
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
        <p className="login-footnote">
          Access is denied by default and checked again after OAuth completes.
        </p>
      </section>
    </main>
  );
}

function IconButton({
  label,
  icon: Icon,
  onClick,
  className = "",
}: {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  );
}
