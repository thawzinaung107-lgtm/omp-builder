import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
// react-resizable-panels v4: PanelGroup is `Group`, PanelResizeHandle is
// `Separator`; there is no autoSaveId — layouts persist via the A7 prefs
// (defaultLayout in, onLayoutChanged out; see studio-prefs.ts).
import { Group, Panel, Separator } from "react-resizable-panels";
import { AlertTriangle, ArrowUp, ChevronDown, Code2, Folder, GitBranch, LayoutDashboard, MessageSquare, MousePointerClick, MoreHorizontal, Play, Plus, RefreshCw, RotateCcw, Settings2, SplitSquareHorizontal, Terminal, X } from "lucide-react";
import type { BrowserCommand, ChatSession, Checkpoint, CheckpointDiffFile, CheckpointFileStat, FileChangeStatus, PickerSelection, Problem, Project, Provider, RepoState, SessionEvent, VersionPreview } from "@omp-builder/shared";
import { MEDIA_ALLOWED_MIME_TYPES, MEDIA_MAX_BYTES, PICKER_MAX_SELECTIONS, buildProblemFixPrompt, fileChangeStatus, lineDiffStats, pickerSelectionLabel, problemKey, samePickedComponent, validatePickerMessage } from "@omp-builder/shared";
import { api, ApiError, type FileTreeEntry, type PreviewState } from "../api";
import { loadStudioPrefs, saveStudioPrefs, type StudioDevice } from "../studio-prefs";
import { normalizePreviewPath } from "../preview-path";
import { Button, StatusChip, timeAgo } from "../ui";
import { FileExplorer } from "./FileExplorer";
import { MediaBrowser } from "./MediaBrowser";
import { MonacoDiffEditor } from "./MonacoDiffEditor";
import { disposeEditorModel, MonacoEditor } from "./MonacoEditor";
import { languageForPath } from "../editor-languages";
import type { NavScreen } from "./Sidebar";

type ChatItem = { id: string; role: "user" | "assistant" | "tool" | "status"; text: string; eventType?: string };
type Step = { id: string; label: string; done: boolean; failed: boolean };
type Tab = "preview" | "code" | "files" | "logs" | "git" | "problems" | "rules";
type MobileTab = "chat" | "preview" | "code" | "files" | "problems" | "git" | "rules";
/** One open editor tab. `mtimeMs` is the last known on-disk mtime and is
 * sent back as expectedMtime on save, so concurrent edits conflict (409)
 * instead of silently overwriting. */
type OpenFile = { path: string; content: string; size: number; mtime: string; mtimeMs: number; dirty: boolean };

/** Milestone B (A2) — one file on a chat "Modified files" card. `original`
 * is the pre-prompt snapshot content ("" for an added file); `modified`
 * is the current on-disk content ("" for a deleted file). Stats come
 * from lineDiffStats in shared. Milestone C (B1) wires Undo/Retry into
 * this card: `prompt` is the turn's user prompt (for Retry) and
 * `checkpointOid` the checkpoint the turn created (for Undo context);
 * `undone` marks a card whose turn was undone. */
type ChangeFile = { path: string; status: FileChangeStatus; added: number; removed: number; original: string; modified: string };
type ChangeCard = { id: string; files: ChangeFile[]; prompt?: string; checkpointOid?: string | null; undone?: boolean };
/** The file whose diff is shown in the Code tab (A2 deep-link target).
 * Milestone C (B1) reuses it for checkpoint diffs, with explicit
 * before/after labels instead of the change-card defaults. */
type DiffView = { path: string; status: FileChangeStatus; added: number; removed: number; original: string; modified: string; originalLabel?: string; modifiedLabel?: string };
/** Milestone E (B7) — an image attached to the next prompt: uploaded to
 * images/ first, then referenced as @<path> in the prompt text. */
type ChatAttachment = { path: string; name: string };

/** Caps for the pre-prompt snapshot (A2): a big workspace must not blow
 * up memory. Files past the caps are left out of the snapshot, and a
 * change card then reports them as modified without line stats. */
export const MAX_SNAPSHOT_FILES = 50;
export const MAX_SNAPSHOT_FILE_CHARS = 200_000;
export const MAX_SNAPSHOT_TOTAL_CHARS = 2_000_000;

function eventText(event: SessionEvent): string {
  if (event.message) return event.message;
  const payload = event.payload ?? {};
  for (const key of ["text", "delta", "content", "message", "error", "status"]) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return event.type.replaceAll("_", " ");
}

function renderText(text: string): ReactNode {
  const lines = text.split("\n");
  return lines.map((line, index) => (
    <span
      key={`${index}-${line.slice(0, 8)}`}
      className={line.trim().startsWith("```") ? "block rounded bg-black/[.06] px-2 py-1 font-mono text-xs text-omp-brand" : "block min-h-[1.25rem]"}
    >
      {line || " "}
    </span>
  ));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const tabLabels: { id: Tab; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "code", label: "Code" },
  { id: "files", label: "Files" },
  { id: "logs", label: "Logs" },
  // Milestone A (A1) — Problems tab shell; the count badge is fed by
  // A4's diagnostics and the panel is built in A4 below.
  { id: "problems", label: "Problems" },
  { id: "git", label: "Git" },
  // Milestone D (B6) — Project rules editor (separate from the file
  // explorer: .omp/RULES.md is never served by the file API).
  { id: "rules", label: "Rules" },
];

/** Milestone A (A7) — validate a persisted tab value; unknown → preview. */
function toTab(value: string): Tab {
  return tabLabels.some((item) => item.id === value) ? (value as Tab) : "preview";
}

export function Builder({ project, onNavigate }: { project: Project; onNavigate: (screen: NavScreen) => void }) {
  const [chat, setChat] = useState("");
  const [items, setItems] = useState<ChatItem[]>([]);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [filesChanged, setFilesChanged] = useState(0);
  const [changedPaths, setChangedPaths] = useState<string[]>([]);
  const [filesRefreshToken, setFilesRefreshToken] = useState(0);
  const [settled, setSettled] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  // Phase 3B — open editor tabs. Refs mirror the state for the WS
  // `files_modified` handler, which is a stable callback.
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState("");
  const [editorError, setEditorError] = useState("");
  const [conflict, setConflict] = useState<{ path: string; reason: "save" | "external" } | null>(null);
  const [confirmClosePath, setConfirmClosePath] = useState<string | null>(null);
  const openFilesRef = useRef<OpenFile[]>([]);
  const activePathRef = useRef<string | null>(null);
  const savingPathsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);
  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);
  const activeFile = useMemo(() => openFiles.find((f) => f.path === activePath) ?? null, [openFiles, activePath]);
  // Milestone B (A3) — paths with unsaved buffers, for the tree dots.
  const dirtyPaths = useMemo(() => openFiles.filter((f) => f.dirty).map((f) => f.path), [openFiles]);
  const [selectedModel, setSelectedModel] = useState("");
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting" | "offline">("connecting");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  // Milestone A (A7) — per-project studio prefs (localStorage only).
  // The initial values are read synchronously on first mount so the
  // studio opens in its restored state; later project switches go
  // through the hydration effect below. See the persist effects after
  // the preview helpers.
  const [initialPrefs] = useState(() => loadStudioPrefs(project.id));
  const [tab, setTab] = useState<Tab>(() => toTab(initialPrefs.tab));
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
  const [split, setSplit] = useState(() => initialPrefs.split);
  // Milestone B (A3/A6) — persisted per-project view prefs.
  const [saveOnBlur, setSaveOnBlur] = useState(() => initialPrefs.saveOnBlur);
  const [consoleOpen, setConsoleOpen] = useState(() => initialPrefs.consoleOpen);
  const saveOnBlurRef = useRef(saveOnBlur);
  useEffect(() => {
    saveOnBlurRef.current = saveOnBlur;
  }, [saveOnBlur]);
  // Milestone D (B2) — multiple chat sessions per project. `chats` is the
  // tab strip (server order = position); `activeChatId` is the open tab.
  // Conversation state (items/steps/cards/working) is LIVE for the active
  // chat only; switching rebuilds it by replaying the persisted events
  // for the new chat (the same replay a refresh does). Drafts and the
  // active chat persist in A7 prefs; `busyChats`/`unreadChats` track
  // background chats so their tabs can show Working/unread dots.
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(() => initialPrefs.activeChatId);
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>(() => initialPrefs.chatDrafts);
  const [busyChats, setBusyChats] = useState<string[]>([]);
  const [unreadChats, setUnreadChats] = useState<string[]>([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatActionError, setChatActionError] = useState("");
  const [newChatBusy, setNewChatBusy] = useState(false);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteChatId, setConfirmDeleteChatId] = useState<string | null>(null);
  const activeChatIdRef = useRef<string | null>(initialPrefs.activeChatId);
  const defaultChatIdRef = useRef<string | null>(null);
  const eventsRef = useRef<SessionEvent[]>([]);
  const dragChatIdRef = useRef<string | null>(null);
  const chatDraftsRef = useRef<Record<string, string>>(initialPrefs.chatDrafts);
  const busyChatsRef = useRef<string[]>([]);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  useEffect(() => {
    chatDraftsRef.current = chatDrafts;
  }, [chatDrafts]);
  useEffect(() => {
    busyChatsRef.current = busyChats;
  }, [busyChats]);
  const markChatBusy = useCallback((chatId: string) => {
    if (!chatId) return;
    setBusyChats((current) => (current.includes(chatId) ? current : [...current, chatId]));
  }, []);
  const markChatIdle = useCallback((chatId: string) => {
    if (!chatId) return;
    setBusyChats((current) => current.filter((id) => id !== chatId));
  }, []);
  const workingRef = useRef(false);
  useEffect(() => {
    workingRef.current = working;
  }, [working]);
  const [expandedDirs, setExpandedDirs] = useState<string[]>(() => initialPrefs.expandedDirs);
  const [hydratedProject, setHydratedProject] = useState(project.id);
  const [openFilesRestored, setOpenFilesRestored] = useState(false);
  // Milestone A (A4) — structured diagnostics + Fix with OMP.
  const [problems, setProblems] = useState<Problem[]>([]);
  const [problemsLoading, setProblemsLoading] = useState(false);
  const [problemsError, setProblemsError] = useState("");
  const [selectedProblems, setSelectedProblems] = useState<Set<string>>(new Set());
  const [fixNote, setFixNote] = useState("");
  // The preview error banner's Dismiss is per problem-set: it stores the
  // signature of the set it was dismissed for, so new problems re-show it.
  const [bannerDismissedFor, setBannerDismissedFor] = useState("");
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const problemsRefreshTimer = useRef<number | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // Milestone E (B7) — chat attachments: uploaded images referenced by
  // path (@images/<name>) in the prompt. OMP RPC has no image input —
  // the prompt is text-only — so the file is referenced, not pasted;
  // OMP reads it from the workspace (its CLI accepts @image.png the
  // same way). See the composer note below.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [attachBusy, setAttachBusy] = useState(false);
  const attachInputRef = useRef<HTMLInputElement | null>(null);

  // Milestone E (B3/B4) — preview element picker. `pickerMode` is the
  // server-side per-project flag (injection on/off) + the local toggle;
  // `pickerActive` is whether the injected script is currently
  // intercepting clicks in the iframe. Selections are per chat session
  // (B2): `selectionsByChat[chatId]` is that chat's list; switching
  // chats shows that chat's list, never another chat's. Every selection
  // is untrusted preview data (PICKER-SECURITY-REVIEW.md) — UI state
  // only until the admin explicitly sends a prompt. `pickerModeRef` /
  // `pickerActiveRef` mirror the state for the stable message listener
  // and iframe onLoad handler.
  const [pickerMode, setPickerMode] = useState(false);
  const [pickerActive, setPickerActive] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerNotice, setPickerNotice] = useState("");
  const [selectionsByChat, setSelectionsByChat] = useState<Record<string, PickerSelection[]>>({});
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const pickerModeRef = useRef(false);
  const pickerActiveRef = useRef(false);
  const pickerWindowStartRef = useRef(0);
  const pickerMessageCountRef = useRef(0);
  const pickerFloodNoticedRef = useRef(false);
  // Milestone E (B4) — snapshot-at-send / clear-on-accept lifecycle.
  // `selectionEpochRef` increments on every selection change; at send,
  // `pendingSentSelectionsRef` records {chatId, epoch}; the
  // prompt_accepted handler clears the selections ONLY when the epoch
  // is unchanged, so a selection picked after sending is never wiped.
  const selectionEpochRef = useRef(0);
  const pendingSentSelectionsRef = useRef<{ chatId: string; epoch: number } | null>(null);
  // Milestone E (B3) — Builder → iframe commands are exactly three
  // (review §3.1): activate / deactivate / clear-overlays, no payload,
  // sent only to the current iframe's contentWindow. Target origin "*"
  // is unavoidable (the iframe origin is the opaque string "null") and
  // acceptable only because the commands carry no secrets or authority.
  const postPickerCommand = useCallback((command: "omp-picker-activate" | "omp-picker-deactivate" | "omp-picker-clear-overlays") => {
    iframeRef.current?.contentWindow?.postMessage({ type: command }, "*");
  }, []);
  const activeSelections = useMemo(
    () => (activeChatId ? (selectionsByChat[activeChatId] ?? []) : []),
    [selectionsByChat, activeChatId],
  );

  // Phase 3D — managed preview (gateway only; the manual URL bar and the
  // localStorage preview URL are gone). `previewRef` mirrors the state for
  // the stable WebSocket `preview_status` handler.
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const previewRef = useRef<PreviewState | null>(null);
  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);
  const [device, setDevice] = useState<StudioDevice>(() => initialPrefs.device);
  // Milestone B (A5) — editable preview path, always inside the gateway
  // origin (validated by normalizePreviewPath before it is applied).
  const [previewPath, setPreviewPath] = useState("/");
  const [previewPathInput, setPreviewPathInput] = useState("/");
  // Milestone B (A2) — the diff currently shown in the Code tab, and the
  // per-turn "Modified files" cards in the chat.
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [changeCards, setChangeCards] = useState<ChangeCard[]>([]);
  // Milestone C (B1) — Git-backed version history (checkpoints). The
  // list + repo status come from GET /versions; detail/diff/preview are
  // loaded on demand per selected checkpoint; restore needs explicit
  // confirmation (see the confirm panel below).
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [versionsStatus, setVersionsStatus] = useState<RepoState | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState("");
  const [versionsQuery, setVersionsQuery] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<Checkpoint | null>(null);
  const [versionDetail, setVersionDetail] = useState<{ checkpoint: Checkpoint; files: CheckpointFileStat[] } | null>(null);
  const [versionDetailLoading, setVersionDetailLoading] = useState(false);
  const [versionDetailError, setVersionDetailError] = useState("");
  const [versionDiffState, setVersionDiffState] = useState<{ checkpoint: Checkpoint; against: string | null; fromOid: string | null; files: CheckpointDiffFile[] } | null>(null);
  const [versionDiffLoading, setVersionDiffLoading] = useState(false);
  const [versionDiffError, setVersionDiffError] = useState("");
  const [versionPreviewState, setVersionPreviewState] = useState<VersionPreview | null>(null);
  const [versionPreviewLoading, setVersionPreviewLoading] = useState(false);
  const [versionPreviewError, setVersionPreviewError] = useState("");
  // Milestone D (B6) — per-project AI rules (.omp/RULES.md). The editor
  // is separate from the file explorer: the file API never serves .omp.
  const [rulesContent, setRulesContent] = useState("");
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesError, setRulesError] = useState("");
  const [rulesNotice, setRulesNotice] = useState("");
  const [rulesHasRootAgentsMd, setRulesHasRootAgentsMd] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Checkpoint | null>(null);
  const [restoreDiscard, setRestoreDiscard] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  // Milestone C (B1) — Undo confirmation state, per change card. The
  // discard checkbox is a separate, explicit opt-in (never the default).
  const [undoConfirmCardId, setUndoConfirmCardId] = useState<string | null>(null);
  const [undoDiscard, setUndoDiscard] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState("");
  // Milestone B (A2) — pre-prompt snapshot of text-file contents
  // (in-memory only, capped; never sent to any AI provider). The
  // promise lets files_modified compute stats even if the snapshot
  // reads are still in flight when the turn's first change lands.
  const snapshotRef = useRef<Map<string, string> | null>(null);
  const snapshotPromiseRef = useRef<Promise<Map<string, string>> | null>(null);
  // Milestone B (A2) — paths changed during the active turn, flushed
  // into one card at session_settled. The OMP files_modified
  // notification can arrive before the write is visible to a read, so
  // diffing immediately can report 0/0 stats for a real change; by
  // settle time every write has landed.
  const pendingChangePathsRef = useRef<string[]>([]);
  const [frameKey, setFrameKey] = useState(0);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const retryRef = useRef<number | undefined>(undefined);
  const retryCount = useRef(0);
  const lastEventId = useRef<number | undefined>(undefined);
  const activeAssistantId = useRef<string | undefined>(undefined);
  const stopped = useRef(false);
  // Milestone C (B1) — the latest user prompt (from sendPrompt or a
  // replayed user_message event), so a change card can Retry the turn
  // that made it even after a reload.
  const lastUserPromptRef = useRef<string | undefined>(undefined);
  // Milestone C (B1) — when a turn ends, remember when and which
  // checkpoint it made. The filesystem watcher can deliver files_modified
  // AFTER assistant_completed already cleared `working`, and the card
  // created for that late batch still belongs to the just-ended turn:
  // its prompt + checkpoint must not be lost (Retry depends on them).
  // The timestamp is set at assistant_completed (the turn's end) and
  // refreshed at session_settled (when the checkpoint oid is known).
  const lastSettleAtRef = useRef(0);
  const lastSettledCheckpointOidRef = useRef<string | null>(null);

  // Phase 3D — the preview is served only through the authenticated
  // gateway at this relative URL (same origin as the Builder, via the dev
  // proxy in development). Never a container port, never user-entered.
  const gatewayUrl = `/api/preview/${project.id}/`;

  const loadPreviewStatus = useCallback(async () => {
    try {
      const result = await api.previewStatus(project.id);
      setPreview(result.preview);
    } catch {
      setPreview(null);
    }
  }, [project.id]);

  const previewAction = useCallback(
    async (action: "start" | "stop" | "restart" | "rebuild") => {
      setPreviewBusy(true);
      setPreviewError("");
      try {
        const result =
          action === "start"
            ? await api.previewStart(project.id)
            : action === "stop"
              ? await api.previewStop(project.id)
              : action === "rebuild"
                ? await api.previewRebuild(project.id)
                : await api.previewRestart(project.id);
        setPreview(result.preview);
        if (action !== "stop") setFrameKey((k) => k + 1);
      } catch (err) {
        setPreviewError(err instanceof Error ? err.message : "Preview action failed");
      } finally {
        setPreviewBusy(false);
      }
    },
    [project.id],
  );

  // Phase 3B — editor actions. `line` is the Milestone A (A4) Problems
  // deep-link: when given, the editor reveals that line (see
  // MonacoEditor's revealLine prop); otherwise the reveal is cleared.
  const openFile = useCallback(
    async (path: string, line?: number) => {
      setEditorError("");
      setDiffView(null);
      setRevealLine(line ?? null);
      if (openFilesRef.current.some((f) => f.path === path)) {
        setActivePath(path);
        setTab("code");
        setMobileTab("code");
        return;
      }
      try {
        const file = await api.readFile(project.id, path);
        setOpenFiles((current) =>
          current.some((f) => f.path === path)
            ? current
            : [...current, { path: file.path, content: file.content, size: file.size, mtime: file.mtime, mtimeMs: file.mtimeMs, dirty: false }],
        );
        setActivePath(path);
        setTab("code");
        setMobileTab("code");
      } catch (err) {
        // Binary files (415) and missing files land here.
        setEditorError(err instanceof Error ? err.message : "Could not open file");
        setTab("code");
        setMobileTab("code");
      }
    },
    [project.id],
  );

  const saveFile = useCallback(
    async (path: string, force = false) => {
      const file = openFilesRef.current.find((f) => f.path === path);
      if (!file || (!file.dirty && !force)) return;
      setSaving(true);
      setEditorError("");
      savingPathsRef.current.add(path);
      try {
        const saved = await api.writeFile(project.id, path, file.content, force ? undefined : file.mtimeMs);
        setOpenFiles((current) =>
          current.map((f) => (f.path === path ? { ...f, size: saved.size, mtime: saved.mtime, mtimeMs: saved.mtimeMs, dirty: false } : f)),
        );
        setSaveNote("Saved");
        window.setTimeout(() => setSaveNote(""), 2000);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) setConflict({ path, reason: "save" });
        else setEditorError(err instanceof Error ? err.message : "Could not save file");
      } finally {
        savingPathsRef.current.delete(path);
        setSaving(false);
      }
    },
    [project.id],
  );

  const closeFile = useCallback((path: string) => {
    const file = openFilesRef.current.find((f) => f.path === path);
    if (file?.dirty) {
      setConfirmClosePath(path);
      return;
    }
    // Milestone B (A3) — drop the retained model for the closed file.
    disposeEditorModel(path);
    setDiffView((current) => (current?.path === path ? null : current));
    const next = openFilesRef.current.filter((f) => f.path !== path);
    setOpenFiles(next);
    if (activePathRef.current === path) setActivePath(next.length ? next[next.length - 1].path : null);
    setConflict((c) => (c?.path === path ? null : c));
  }, []);

  const discardAndClose = useCallback((path: string) => {
    // Milestone B (A3) — drop the retained model for the closed file.
    disposeEditorModel(path);
    setDiffView((current) => (current?.path === path ? null : current));
    const next = openFilesRef.current.filter((f) => f.path !== path);
    setOpenFiles(next);
    if (activePathRef.current === path) setActivePath(next.length ? next[next.length - 1].path : null);
    setConfirmClosePath(null);
    setConflict((c) => (c?.path === path ? null : c));
  }, []);

  const reloadFromDisk = useCallback(
    async (path: string) => {
      try {
        const file = await api.readFile(project.id, path);
        setOpenFiles((current) =>
          current.map((f) =>
            f.path === path ? { ...f, content: file.content, size: file.size, mtime: file.mtime, mtimeMs: file.mtimeMs, dirty: false } : f,
          ),
        );
        setConflict((c) => (c?.path === path ? null : c));
      } catch (err) {
        setEditorError(err instanceof Error ? err.message : "Could not reload file");
      }
    },
    [project.id],
  );

  // OMP (or another writer) changed a file that is open in the editor.
  // Clean tabs auto-reload; dirty tabs get a warning instead of losing edits.
  // Our own in-flight saves are ignored — the save response updates mtime.
  const handleExternalChanges = useCallback(
    (paths: string[]) => {
      for (const path of paths) {
        if (savingPathsRef.current.has(path)) continue;
        const file = openFilesRef.current.find((f) => f.path === path);
        if (!file) continue;
        if (file.dirty) setConflict({ path, reason: "external" });
        else void reloadFromDisk(path);
      }
    },
    [reloadFromDisk],
  );

  // Milestone A (A4) — load structured problems from the server
  // endpoint (parsed from the persisted preview logs). Auto-select-all
  // on every load, matching the checklist behaviour.
  const loadProblems = useCallback(async () => {
    setProblemsLoading(true);
    setProblemsError("");
    try {
      const result = await api.problems(project.id);
      setProblems(result.problems);
      setSelectedProblems(new Set(result.problems.map((problem) => problemKey(problem))));
    } catch (err) {
      setProblemsError(err instanceof Error ? err.message : "Could not load problems");
    } finally {
      setProblemsLoading(false);
    }
  }, [project.id]);

  // Milestone B (A2) — capture a pre-prompt snapshot of the
  // workspace's text-file contents (in memory, capped). The snapshot is
  // used ONLY locally to diff before/after for the change card's line
  // stats; it is never sent to OMP or any other AI provider.
  const captureSnapshot = useCallback(async (): Promise<Map<string, string>> => {
    const snapshot = new Map<string, string>();
    try {
      const { tree } = await api.listFiles(project.id);
      const paths: string[] = [];
      const walk = (entries: FileTreeEntry[]) => {
        for (const entry of entries) {
          if (entry.type === "file") paths.push(entry.path);
          else walk(entry.children ?? []);
        }
      };
      walk(tree);
      let total = 0;
      for (const path of paths.slice(0, MAX_SNAPSHOT_FILES)) {
        if (total >= MAX_SNAPSHOT_TOTAL_CHARS) break;
        try {
          const file = await api.readFile(project.id, path);
          if (file.content.length > MAX_SNAPSHOT_FILE_CHARS) continue;
          snapshot.set(path, file.content);
          total += file.content.length;
        } catch {
          // Binary / unreadable files are not snapshotted.
        }
      }
    } catch {
      // A failed snapshot means "no stats" for this turn, never a crash.
    }
    snapshotRef.current = snapshot;
    return snapshot;
  }, [project.id]);

  // Milestone B (A2) — build one change card from a files_modified turn:
  // diff each changed path's snapshot content against its current
  // on-disk content for status + line stats. A path missing from the
  // snapshot (capped out, binary, or added mid-turn) is reported as
  // modified with the stats we can compute from what we have.
  const computeChangeCard = useCallback(
    async (paths: string[], opts?: { prompt?: string; checkpointOid?: string | null }) => {
      const snapshot = snapshotRef.current ?? (await snapshotPromiseRef.current?.catch(() => null)) ?? null;
      if (!snapshot) return;
      const files: ChangeFile[] = [];
      for (const path of paths) {
        const hadBefore = snapshot.has(path);
        let current: string | null = null;
        try {
          current = (await api.readFile(project.id, path)).content;
        } catch {
          current = null;
        }
        const hasNow = current !== null;
        if (!hadBefore && !hasNow) continue;
        const original = hadBefore ? snapshot.get(path) ?? "" : "";
        const modified = current ?? "";
        const stats = lineDiffStats(original, modified);
        const entry: ChangeFile = { path, status: fileChangeStatus(hadBefore, hasNow), added: stats.added, removed: stats.removed, original, modified };
        files.push(entry);
        // The OMP files_modified notification can arrive before the
        // write is visible to a read; a modified file diffing to 0/0
        // is suspicious — re-read once after a short delay and use the
        // fresher content if it differs.
        if (entry.status === "modified" && entry.added === 0 && entry.removed === 0) {
          await new Promise((r) => window.setTimeout(r, 750));
          try {
            const again = (await api.readFile(project.id, path)).content;
            if (again !== modified) {
              const stats2 = lineDiffStats(original, again);
              entry.modified = again;
              entry.added = stats2.added;
              entry.removed = stats2.removed;
            }
          } catch {
            // Keep the first read on a re-read failure.
          }
        }
      }
      if (!files.length) return;
      setChangeCards((current) => [...current, { id: `changes-${Date.now()}`, files, prompt: opts?.prompt, checkpointOid: opts?.checkpointOid ?? null }]);
    },
    [project.id],
  );

  // Milestone B (A2) — open a change-card row as a read-only diff in
  // the Code tab (the A3 selectedFile {path, line} deep-link family).
  const openDiff = useCallback((file: ChangeFile) => {
    setDiffView({ path: file.path, status: file.status, added: file.added, removed: file.removed, original: file.original, modified: file.modified });
    setTab("code");
    setMobileTab("code");
  }, []);

  // Milestone C (B1) — version history data. The list is the Git log
  // (newest first); detail/diff/preview load on demand per checkpoint.
  const loadVersions = useCallback(async () => {
    setVersionsLoading(true);
    setVersionsError("");
    try {
      const result = await api.versions(project.id);
      setVersionsStatus(result.status);
      setCheckpoints(result.checkpoints);
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : "Could not load version history");
    } finally {
      setVersionsLoading(false);
    }
  }, [project.id]);

  const loadVersionDetail = useCallback(
    async (checkpoint: Checkpoint) => {
      setSelectedVersion(checkpoint);
      setVersionDetail(null);
      setVersionDetailError("");
      setVersionDiffState(null);
      setVersionPreviewState(null);
      setVersionDetailLoading(true);
      try {
        const result = await api.versionDetail(project.id, checkpoint.oid);
        setVersionDetail(result);
      } catch (err) {
        setVersionDetailError(err instanceof Error ? err.message : "Could not load checkpoint");
      } finally {
        setVersionDetailLoading(false);
      }
    },
    [project.id],
  );

  const loadVersionDiff = useCallback(
    async (checkpoint: Checkpoint, against?: string) => {
      setVersionDiffLoading(true);
      setVersionDiffError("");
      try {
        const result = await api.versionDiff(project.id, checkpoint.oid, against);
        setVersionDiffState({ checkpoint, against: against ?? null, fromOid: result.fromOid, files: result.files });
      } catch (err) {
        setVersionDiffError(err instanceof Error ? err.message : "Could not load diff");
      } finally {
        setVersionDiffLoading(false);
      }
    },
    [project.id],
  );

  const loadVersionPreview = useCallback(
    async (checkpoint: Checkpoint) => {
      setVersionPreviewLoading(true);
      setVersionPreviewError("");
      try {
        const result = await api.versionPreview(project.id, checkpoint.oid);
        setVersionPreviewState(result.preview);
      } catch (err) {
        setVersionPreviewError(err instanceof Error ? err.message : "Could not preview checkpoint");
      } finally {
        setVersionPreviewLoading(false);
      }
    },
    [project.id],
  );

  // Milestone C (B1) — open one checkpoint-diff file in the read-only
  // Monaco diff viewer (same DiffView as the change card, with explicit
  // before/after labels for the checkpoint pair).
  const openVersionDiffFile = useCallback((file: CheckpointDiffFile, checkpoint: Checkpoint, against: string | null) => {
    setDiffView({
      path: file.path,
      status: file.status,
      added: file.added,
      removed: file.removed,
      original: file.original,
      modified: file.modified,
      originalLabel: against ? `Checkpoint ${against.slice(0, 7)}` : "Before this checkpoint",
      modifiedLabel: `Checkpoint ${checkpoint.shortOid}`,
    });
    setTab("code");
    setMobileTab("code");
  }, []);

  // Milestone D (B6) — load the project rules for the Rules tab.
  const loadRules = useCallback(async () => {
    setRulesLoading(true);
    setRulesError("");
    try {
      const result = await api.getRules(project.id);
      setRulesContent(result.content);
      setRulesHasRootAgentsMd(result.hasRootAgentsMd);
      setRulesLoaded(true);
    } catch (err) {
      setRulesError(err instanceof Error ? err.message : "Could not load project rules");
    } finally {
      setRulesLoading(false);
    }
  }, [project.id]);

  // Milestone D (B6) — save rules (empty content removes them). The
  // server restarts the live OMP session(s); the notice says so, and
  // the Git tab is refreshed because the rules file is now an
  // uncommitted change (or a deletion) in version history.
  const saveRules = useCallback(
    async (content: string) => {
      setRulesSaving(true);
      setRulesError("");
      setRulesNotice("");
      try {
        const result = await api.saveRules(project.id, content);
        setRulesContent(result.content);
        setRulesHasRootAgentsMd(result.hasRootAgentsMd);
        setRulesNotice(
          result.deleted
            ? "Rules removed. The running OMP session was restarted, so the next turn starts without rules."
            : result.sessionsRestarted > 0
              ? "Rules saved. The running OMP session was restarted — rules apply from the next turn."
              : "Rules saved. They apply from the next OMP session.",
        );
        void loadVersions();
      } catch (err) {
        setRulesError(err instanceof Error ? err.message : "Could not save project rules");
      } finally {
        setRulesSaving(false);
      }
    },
    [project.id, loadVersions],
  );

  const saveManualCheckpoint = useCallback(async () => {
    setCheckpointBusy(true);
    try {
      const result = await api.saveCheckpoint(project.id, undefined, activeChatIdRef.current ?? undefined);
      if (result.checkpoint.created) {
        setNotice(`Checkpoint saved (${result.checkpoint.shortOid ?? ""}).`);
        void loadVersions();
      } else {
        setNotice(result.checkpoint.reason ?? "Nothing to checkpoint — no changes since the last checkpoint.");
      }
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : "Could not save checkpoint");
    } finally {
      setCheckpointBusy(false);
    }
  }, [project.id, loadVersions]);

  const confirmRestore = useCallback(async () => {
    if (!restoreTarget) return;
    setRestoreBusy(true);
    setRestoreError("");
    try {
      const result = await api.restoreVersion(project.id, restoreTarget.oid, restoreDiscard, activeChatIdRef.current ?? undefined);
      setNotice(
        result.restore.alreadyAt
          ? "Already at that checkpoint — nothing changed."
          : `Restored to ${restoreTarget.shortOid} as a new checkpoint${result.restore.oid ? ` (${result.restore.shortOid})` : ""}. History is preserved.`,
      );
      setRestoreTarget(null);
      setRestoreDiscard(false);
      setVersionPreviewState(null);
      setFilesRefreshToken((t) => t + 1);
      if (result.restore.changedPaths.length) handleExternalChanges(result.restore.changedPaths);
      void loadVersions();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoreBusy(false);
    }
  }, [restoreTarget, restoreDiscard, project.id, handleExternalChanges, loadVersions]);

  // Milestone A (A7) — project switch hydration. The Builder is not
  // keyed by project, so the same instance can receive a new project:
  // apply that project's persisted prefs (and clear the old project's
  // editor state) before any persist effect runs for it. The
  // `hydratedProject` guard is what keeps the persist effects below
  // from writing the previous project's values under the new id.
  useEffect(() => {
    if (hydratedProject === project.id) return;
    const prefs = loadStudioPrefs(project.id);
    setTab(toTab(prefs.tab));
    setSplit(prefs.split);
    setDevice(prefs.device);
    setSaveOnBlur(prefs.saveOnBlur);
    setConsoleOpen(prefs.consoleOpen);
    setExpandedDirs(prefs.expandedDirs);
    // Milestone D (B2) — reset chat state for the new project; the mount
    // effect reloads its chats and rebuilds the active one.
    chatDraftsRef.current = prefs.chatDrafts;
    setChatDrafts(prefs.chatDrafts);
    setChat("");
    activeChatIdRef.current = prefs.activeChatId;
    setActiveChatId(prefs.activeChatId);
    defaultChatIdRef.current = null;
    setChats([]);
    setBusyChats([]);
    setUnreadChats([]);
    setChatsLoading(true);
    setItems([]);
    setSteps([]);
    setChangeCards([]);
    setWorking(false);
    setSettled(false);
    setFilesChanged(0);
    setError("");
    setOpenFiles([]);
    setActivePath(null);
    setOpenFilesRestored(false);
    setHydratedProject(project.id);
  }, [project.id, hydratedProject]);

  // Milestone A (A7) — restore open files for this project. Paths only:
  // contents are re-read from disk, so a file that was deleted (or is
  // binary) since is skipped silently, and unsaved edits are not
  // restored. Runs once per project, after hydration.
  useEffect(() => {
    if (hydratedProject !== project.id || openFilesRestored) return;
    let cancelled = false;
    const prefs = loadStudioPrefs(project.id);
    void (async () => {
      const results = await Promise.allSettled(prefs.openFiles.map((path) => api.readFile(project.id, path)));
      if (cancelled) return;
      const restored: OpenFile[] = [];
      results.forEach((result) => {
        if (result.status !== "fulfilled") return;
        const file = result.value;
        restored.push({ path: file.path, content: file.content, size: file.size, mtime: file.mtime, mtimeMs: file.mtimeMs, dirty: false });
      });
      setOpenFiles(restored);
      setActivePath(prefs.activePath && restored.some((f) => f.path === prefs.activePath) ? prefs.activePath : restored[0]?.path ?? null);
      setOpenFilesRestored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, hydratedProject, openFilesRestored]);

  // Milestone A (A7) — persist view prefs on change. Each save merges
  // over the currently stored object so the two effects never clobber
  // each other's half. The view half needs no restore gate (its values
  // are lazy-initialised from storage on mount).
  useEffect(() => {
    if (hydratedProject !== project.id) return;
    saveStudioPrefs(project.id, { ...loadStudioPrefs(project.id), tab, split, device, expandedDirs, saveOnBlur, consoleOpen, activeChatId, chatDrafts });
  }, [project.id, hydratedProject, tab, split, device, expandedDirs, saveOnBlur, consoleOpen, activeChatId, chatDrafts]);

  // Milestone A (A7) — persist open files only after this project's
  // restore completed, so the mount-time empty list never overwrites
  // the stored paths before they are re-opened.
  useEffect(() => {
    if (hydratedProject !== project.id || !openFilesRestored) return;
    saveStudioPrefs(project.id, {
      ...loadStudioPrefs(project.id),
      openFiles: openFiles.map((f) => f.path),
      activePath,
    });
  }, [project.id, hydratedProject, openFiles, activePath, openFilesRestored]);

  const handleEvent = useCallback((event: SessionEvent) => {
    if (event.eventId !== undefined) lastEventId.current = Math.max(lastEventId.current ?? 0, event.eventId);
    // Cap the in-memory list: a long-running preview can emit hundreds of
    // preview_log lines; the DB already caps persisted logs at 200/project.
    setEvents((current) =>
      event.eventId !== undefined && current.some((e) => e.eventId === event.eventId) ? current : [...current, event].slice(-500),
    );
    const text = eventText(event);
    const payload = event.payload ?? {};
    // Milestone D (B2) — route events to chats. Chat-scoped events carry
    // chatSessionId; legacy rows (pre-v5) have none and belong to the
    // default chat. Events for a background chat only update its tab
    // state (Working/unread dots); the live conversation is the active
    // chat's, rebuilt from `events` on every switch. Project-scoped
    // events (files_modified, preview_*, model_changed, and the
    // connection session_status) apply globally as before.
    if (event.type === "error") {
      const errChat = typeof event.chatSessionId === "string" ? event.chatSessionId : null;
      if (!errChat || errChat === activeChatIdRef.current) {
        setWorking(false);
        setError(text);
        if (errChat) markChatIdle(errChat);
      }
      return;
    }
    const CHAT_SCOPED = ["user_message", "prompt_accepted", "assistant_delta", "assistant_completed", "tool_started", "tool_progress", "tool_finished", "tool_error", "session_settled", "agent_error", "session_status", "prompt_aborted"];
    if (CHAT_SCOPED.includes(event.type)) {
      const eventChatId = typeof event.chatSessionId === "string" && event.chatSessionId ? event.chatSessionId : defaultChatIdRef.current;
      if (eventChatId && eventChatId !== activeChatIdRef.current) {
        if (["user_message", "prompt_accepted", "tool_started", "assistant_delta"].includes(event.type)) markChatBusy(eventChatId);
        if (["assistant_completed", "session_settled", "agent_error", "prompt_aborted"].includes(event.type)) markChatIdle(eventChatId);
        if (event.type !== "assistant_delta") setUnreadChats((current) => (current.includes(eventChatId) ? current : [...current, eventChatId]));
        return;
      }
      if (eventChatId) {
        if (["user_message", "prompt_accepted", "tool_started", "assistant_delta"].includes(event.type)) markChatBusy(eventChatId);
        if (["assistant_completed", "session_settled", "agent_error", "prompt_aborted"].includes(event.type)) markChatIdle(eventChatId);
      }
    }
    // Milestone E (B4) — the turn was accepted: the selections
    // snapshotted at send are now the prompt's context. Clear them ONLY
    // if nothing newer arrived since (epoch identity check, per Dyad's
    // ChatInput): a selection picked after sending belongs to the NEXT
    // prompt, and must never be wiped.
    if (event.type === "prompt_accepted") {
      const pending = pendingSentSelectionsRef.current;
      const acceptedChatId =
        typeof event.chatSessionId === "string" && event.chatSessionId
          ? event.chatSessionId
          : activeChatIdRef.current;
      if (pending && acceptedChatId && pending.chatId === acceptedChatId && pending.epoch === selectionEpochRef.current) {
        pendingSentSelectionsRef.current = null;
        selectionEpochRef.current += 1;
        setSelectionsByChat((current) => ({ ...current, [acceptedChatId]: [] }));
        postPickerCommand("omp-picker-clear-overlays");
      }
      return;
    }
    // Milestone C (B1) — remember the latest user prompt so a change
    // card can Retry its turn (also after a reload, via replay).
    if (event.type === "user_message") {
      const message = payload.message;
      if (typeof message === "string" && message) lastUserPromptRef.current = message;
      return;
    }
    if (event.type === "assistant_delta") {
      const delta = typeof payload.delta === "string" ? payload.delta : text;
      setItems((current) => {
        const id = activeAssistantId.current ?? `assistant-${event.eventId ?? Date.now()}`;
        activeAssistantId.current = id;
        const index = current.findIndex((item) => item.id === id);
        if (index < 0) return [...current, { id, role: "assistant", text: delta }];
        const next = [...current];
        next[index] = { ...next[index], text: next[index].text + delta };
        return next;
      });
      return;
    }
    if (event.type === "assistant_completed") {
      setWorking(false);
      setSettled(true);
      activeAssistantId.current = undefined;
      // The turn ends here (session_settled follows milliseconds later):
      // a files_modified landing in the gap is still this turn's batch.
      lastSettleAtRef.current = Date.now();
      return;
    }
    if (event.type === "tool_started") {
      setWorking(true);
      setSettled(false);
      const id = `step-${event.eventId ?? Date.now()}`;
      setSteps((current) => [...current, { id, label: text, done: false, failed: false }]);
      setItems((current) => [...current, { id: `${event.type}-${event.eventId ?? Date.now()}`, role: "tool", eventType: event.type, text }]);
      return;
    }
    if (event.type === "tool_finished" || event.type === "tool_progress") {
      if (event.type === "tool_finished") {
        setSteps((current) => {
          const next = [...current];
          const index = next.findIndex((s) => !s.done && !s.failed);
          if (index >= 0) next[index] = { ...next[index], done: true };
          return next;
        });
      }
      setItems((current) => [...current, { id: `${event.type}-${event.eventId ?? Date.now()}`, role: "tool", eventType: event.type, text }]);
      return;
    }
    if (event.type === "tool_error") {
      setSteps((current) => {
        const next = [...current];
        const index = next.findIndex((s) => !s.done && !s.failed);
        if (index >= 0) next[index] = { ...next[index], failed: true };
        return next;
      });
      setItems((current) => [...current, { id: `${event.type}-${event.eventId ?? Date.now()}`, role: "tool", eventType: event.type, text }]);
      return;
    }
    if (event.type === "files_modified") {
      const files = payload.files;
      const paths = Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
      setFilesChanged((n) => n + (paths.length || 1));
      if (paths.length) {
        setChangedPaths((current) => [...current, ...paths.filter((p) => !current.includes(p))]);
        setFilesRefreshToken((t) => t + 1);
        handleExternalChanges(paths);
        // Milestone B (A2) — during a turn, accumulate the paths and
        // diff once at settle (see pendingChangePathsRef); outside a
        // turn, diff immediately as before.
        if (workingRef.current) {
          pendingChangePathsRef.current = [...new Set([...pendingChangePathsRef.current, ...paths])];
        } else {
          // A late batch from the just-settled turn: the watcher's debounce
          // can deliver files_modified after assistant_completed cleared
          // `working`, so the card would otherwise be created with no
          // prompt and no checkpoint (Retry disabled). Attribute batches
          // arriving within 5s of a settle to that turn instead.
          const recentSettle = Date.now() - lastSettleAtRef.current < 5000;
          void computeChangeCard(
            paths,
            recentSettle ? { prompt: lastUserPromptRef.current, checkpointOid: lastSettledCheckpointOidRef.current } : undefined,
          );
        }
      }
      setSettled(true);
      return;
    }
    // Phase 3D — preview lifecycle. The payload carries the new status;
    // refresh from the API when we have no state yet (e.g. a replayed
    // event from before this tab mounted).
    if (event.type === "preview_status") {
      const status = typeof payload.status === "string" ? payload.status : "";
      if (["starting", "running", "stopped", "crashed", "error"].includes(status)) {
        if (!previewRef.current) void loadPreviewStatus();
        else {
          setPreview((current) =>
            current
              ? {
                  ...current,
                  status: status as PreviewState["status"],
                  ...(typeof payload.lastError === "string" || payload.lastError === null ? { lastError: payload.lastError as string | null } : {}),
                  ...(typeof payload.hostPort === "number" ? { hostPort: payload.hostPort } : {}),
                  ...(typeof payload.framework === "string" ? { framework: payload.framework as PreviewState["framework"] } : {}),
                }
              : current,
          );
        }
      }
      // Milestone E (B3) — the preview stopped/crashed/errored: the
      // server-side flag is cleared with it (see server.ts), so the
      // local toggle + selections go away too.
      if (status === "stopped" || status === "crashed" || status === "error") {
        pickerModeRef.current = false;
        pickerActiveRef.current = false;
        setPickerMode(false);
        setPickerActive(false);
        const chatId = activeChatIdRef.current;
        if (chatId) setSelectionsByChat((current) => ({ ...current, [chatId]: [] }));
      }
      // Milestone A (A4) — a status change can add or clear problems
      // (notably crashed/error, which carries lastError).
      void loadProblems();
      return;
    }
    // Milestone A (A4) — new container output may contain new problems.
    // Debounced: a log burst (e.g. session replay) collapses to one
    // refresh 2s after the last line.
    if (event.type === "preview_log") {
      if (problemsRefreshTimer.current) window.clearTimeout(problemsRefreshTimer.current);
      problemsRefreshTimer.current = window.setTimeout(() => {
        void loadProblems();
      }, 2000);
      return;
    }
    // Phase 3D — preview_log events need no special handling here; they
    // land in `events` and the Logs tab renders them as runtime logs.
    if (["session_settled", "prompt_aborted", "agent_error"].includes(event.type)) setWorking(false);
    if (event.type === "session_settled" || event.type === "agent_error") {
      if (event.type === "session_settled") {
        lastSettleAtRef.current = Date.now();
        lastSettledCheckpointOidRef.current = typeof payload.checkpointOid === "string" ? payload.checkpointOid : null;
      }
      const pending = pendingChangePathsRef.current;
      pendingChangePathsRef.current = [];
      if (pending.length)
        void computeChangeCard(pending, {
          prompt: lastUserPromptRef.current,
          checkpointOid: typeof payload.checkpointOid === "string" ? payload.checkpointOid : null,
        });
    }
    // Milestone C (B1) — a settled turn may have created a checkpoint;
    // refresh the version list (the settle payload carries its oid).
    if (event.type === "session_settled") {
      setSettled(true);
      void loadVersions();
    }
    if (event.type === "agent_error") setError(text);
    if (event.type === "session_status" || event.type === "model_changed")
      setItems((current) => [...current, { id: `${event.type}-${event.eventId ?? Date.now()}`, role: "status", text }]);
  }, [handleExternalChanges, loadPreviewStatus, loadProblems, loadVersions, computeChangeCard, markChatBusy, markChatIdle]);

  const loadChats = useCallback(async (): Promise<ChatSession[] | null> => {
    try {
      const result = await api.listChats(project.id);
      setChats(result.chats);
      defaultChatIdRef.current = result.chats[0]?.id ?? null;
      return result.chats;
    } catch {
      return null;
    }
  }, [project.id]);

  // Milestone D (B2) — rebuild the live conversation for one chat by
  // replaying the persisted events that belong to it, plus the
  // project-scoped events every chat sees. Live state is reset first;
  // handleEvent's functional setState updates queue in order, so the
  // replay appends onto the reset state. `source` lets the mount effect
  // rebuild from just-fetched events (eventsRef is still stale there).
  const rebuildActiveChat = useCallback(
    (chatId: string, source?: SessionEvent[]) => {
      setItems([]);
      setSteps([]);
      setChangeCards([]);
      setWorking(false);
      setSettled(false);
      setFilesChanged(0);
      setError("");
      lastUserPromptRef.current = undefined;
      lastSettleAtRef.current = 0;
      lastSettledCheckpointOidRef.current = null;
      activeAssistantId.current = undefined;
      pendingChangePathsRef.current = [];
      for (const stored of source ?? eventsRef.current) {
        const storedChatId = typeof stored.chatSessionId === "string" && stored.chatSessionId ? stored.chatSessionId : defaultChatIdRef.current;
        if (stored.type === "files_modified" || stored.type === "preview_status" || stored.type === "preview_log" || stored.type === "model_changed" || storedChatId === chatId || storedChatId === null) {
          handleEvent(stored);
        }
      }
      // A turn still in flight in this chat ends the replay mid-turn
      // (tool_started with no settle yet); busyChats is the record.
      setWorking(busyChatsRef.current.includes(chatId));
    },
    [handleEvent],
  );

  const switchChat = useCallback(
    (chatId: string) => {
      if (chatId === activeChatIdRef.current) return;
      // Release the outgoing chat's OMP child if it is idle (frees a pool
      // slot; a busy child is left alone and the idle reaper closes it
      // later). The outgoing draft is already saved on every keystroke.
      // Direct socket send (not sendCommand): this callback is defined
      // before sendCommand, and TS forbids the forward reference.
      if (activeChatIdRef.current) {
        const socket = socketRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "release_chat", chatSessionId: activeChatIdRef.current }));
      }
      activeChatIdRef.current = chatId;
      setActiveChatId(chatId);
      setUnreadChats((current) => current.filter((id) => id !== chatId));
      setChat(chatDraftsRef.current[chatId] ?? "");
      setConfirmDeleteChatId(null);
      setRenamingChatId(null);
      rebuildActiveChat(chatId);
    },
    [rebuildActiveChat],
  );

  const createChat = useCallback(async () => {
    setNewChatBusy(true);
    setChatActionError("");
    try {
      const result = await api.createChat(project.id);
      setChats((current) => [...current, result.chat]);
      switchChat(result.chat.id);
    } catch (err) {
      setChatActionError(err instanceof Error ? err.message : "Could not create chat");
    } finally {
      setNewChatBusy(false);
    }
  }, [project.id, switchChat]);

  const submitRename = useCallback(async () => {
    if (!renamingChatId) return;
    const title = renameValue.trim();
    if (!title) {
      setRenamingChatId(null);
      return;
    }
    try {
      const result = await api.renameChat(project.id, renamingChatId, title);
      setChats((current) => current.map((entry) => (entry.id === result.chat.id ? result.chat : entry)));
    } catch (err) {
      setChatActionError(err instanceof Error ? err.message : "Could not rename chat");
    } finally {
      setRenamingChatId(null);
    }
  }, [renamingChatId, renameValue, project.id]);

  const deleteChat = useCallback(
    async (chatId: string) => {
      setChatActionError("");
      try {
        await api.deleteChat(project.id, chatId);
        const remaining = chats.filter((entry) => entry.id !== chatId);
        setChats(remaining);
        setChatDrafts((current) => {
          const next = { ...current };
          delete next[chatId];
          return next;
        });
        if (activeChatIdRef.current === chatId) {
          const next = remaining[0]?.id ?? null;
          if (next) switchChat(next);
          else {
            activeChatIdRef.current = null;
            setActiveChatId(null);
          }
        }
      } catch (err) {
        setChatActionError(err instanceof Error ? err.message : "Could not delete chat");
      } finally {
        setConfirmDeleteChatId(null);
      }
    },
    [project.id, chats, switchChat],
  );

  // Milestone D (B2) — reorder the tab strip (drag-and-drop); the order
  // persists server-side. The list is updated optimistically and reverted
  // to the previous order if the save fails.
  const applyChatOrder = useCallback(
    async (order: string[]) => {
      const previous = chats;
      setChats(order.map((id) => chats.find((entry) => entry.id === id)!).filter(Boolean));
      try {
        const result = await api.reorderChats(project.id, order);
        setChats(result.chats);
      } catch (err) {
        setChats(previous);
        setChatActionError(err instanceof Error ? err.message : "Could not reorder chats");
      }
    },
    [chats, project.id],
  );

  useEffect(() => {
    let alive = true;
    api
      .providers()
      .then((result) => {
        if (!alive) return;
        setProviders(result.providers);
        const preferred = localStorage.getItem("omp-builder-default-provider");
        setSelectedModel(result.providers.some((provider) => provider.id === preferred) ? preferred! : result.providers[0]?.id ?? "");
      })
      .catch(() => {
        if (alive) setProviders([]);
      });
    // Milestone D (B2) — chats first: the event stream is per-chat, so
    // the active chat must be known before events are applied live.
    void (async () => {
      const loaded = await loadChats();
      if (!alive) return;
      setChatsLoading(false);
      if (!loaded) return;
      const preferred = activeChatIdRef.current && loaded.some((entry) => entry.id === activeChatIdRef.current) ? activeChatIdRef.current : loaded[0]?.id ?? null;
      activeChatIdRef.current = preferred;
      setActiveChatId(preferred);
      try {
        const result = await api.projectSession(project.id);
        if (!alive) return;
        const mapped: SessionEvent[] = result.events.map((event) => ({ type: event.type, timestamp: event.createdAt, projectId: event.projectId, eventId: event.id, payload: event.payload, chatSessionId: event.chatSessionId ?? null }));
        mapped.forEach((session) => handleEvent(session));
        if (preferred) {
          // Rebuild once so cards/steps are complete even if some events
          // arrived before the active chat was known.
          rebuildActiveChat(preferred, mapped);
          setChat(chatDraftsRef.current[preferred] ?? "");
        }
      } catch {
        // Events load is best-effort; the WS replay covers it.
      }
    })();
    // Phase 3D — current preview state for the managed Preview tab.
    void loadPreviewStatus();
    // Milestone A (A4) — current structured problems for the Problems tab.
    void loadProblems();
    // Milestone C (B1) — version history for the Git tab.
    void loadVersions();
    // Milestone D (B6) — project rules for the Rules tab.
    void loadRules();
    return () => {
      alive = false;
    };
  }, [project.id, handleEvent, loadPreviewStatus, loadProblems, loadVersions, loadRules, loadChats, rebuildActiveChat]);

  useEffect(() => {
    stopped.current = false;
    const connect = () => {
      if (stopped.current) return;
      setConnection(retryCount.current ? "reconnecting" : "connecting");
      const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/projects/${project.id}`);
      socketRef.current = socket;
      socket.onopen = () => {
        retryCount.current = 0;
        setConnection("connected");
        setError("");
        socket.send(JSON.stringify({ type: "replay", ...(lastEventId.current === undefined ? {} : { afterEventId: lastEventId.current }) }));
      };
      socket.onmessage = (message) => {
        try {
          handleEvent(JSON.parse(message.data) as SessionEvent);
        } catch {
          setError("Received an invalid session event");
        }
      };
      socket.onerror = () => setError("Unable to connect to the OMP session");
      socket.onclose = () => {
        socketRef.current = undefined;
        if (stopped.current) return;
        setConnection("reconnecting");
        const delay = Math.min(15_000, 500 * 2 ** retryCount.current++);
        retryRef.current = window.setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      stopped.current = true;
      if (retryRef.current) window.clearTimeout(retryRef.current);
      socketRef.current?.close();
      socketRef.current = undefined;
    };
  }, [project.id, handleEvent]);


  // Milestone E (B3) — postMessage bridge from the preview iframe.
  // Accepts EXACTLY the two selection types, ONLY when event.source is
  // this project's current iframe contentWindow AND event.origin is
  // "null" (the sandboxed opaque origin), ONLY while picker mode is on.
  // Everything else is dropped silently. Every accepted payload is
  // validated by the strict shared schema (validatePickerMessage) and
  // treated as untrusted UI state — never rendered as HTML, never fed
  // into a selector/URL/path, never auto-sent to OMP.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      if (event.origin !== "null") return;
      if (!pickerModeRef.current) return;
      const data: unknown = event.data;
      if (!data || typeof data !== "object") return;
      const type = (data as { type?: unknown }).type;
      if (type !== "omp-component-selected" && type !== "omp-component-deselected") return;
      // Rate cap: at most 10 selection messages/second (review §3.2).
      const now = Date.now();
      if (now - pickerWindowStartRef.current >= 1000) {
        pickerWindowStartRef.current = now;
        pickerMessageCountRef.current = 0;
        pickerFloodNoticedRef.current = false;
      }
      pickerMessageCountRef.current += 1;
      if (pickerMessageCountRef.current > 10) {
        if (!pickerFloodNoticedRef.current) {
          pickerFloodNoticedRef.current = true;
          setPickerNotice("Picker is receiving too many selections — ignoring extras.");
        }
        return;
      }
      const validated = validatePickerMessage(data);
      if (!validated) return;
      const chatId = activeChatIdRef.current;
      if (!chatId) return;
      selectionEpochRef.current += 1;
      if (validated.kind === "selected") {
        setSelectionsByChat((current) => {
          const list = current[chatId] ?? [];
          if (list.length >= PICKER_MAX_SELECTIONS) return current;
          return { ...current, [chatId]: [...list, validated.selection] };
        });
      } else {
        setSelectionsByChat((current) => {
          const list = current[chatId] ?? [];
          const index = list.findIndex((item) => samePickedComponent(item.component, validated.component));
          if (index < 0) return current;
          const next = [...list];
          next.splice(index, 1);
          return { ...current, [chatId]: next };
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Milestone E (B3/B4) — an iframe reload drops the injected script's
  // state: clear this chat's selections so a stale selection can never
  // be sent (review R-12 binding to (projectId, frameKey, chatSessionId)).
  useEffect(() => {
    pickerActiveRef.current = false;
    setPickerActive(false);
    const chatId = activeChatIdRef.current;
    if (chatId) {
      setSelectionsByChat((current) => (current[chatId]?.length ? { ...current, [chatId]: [] } : current));
    }
  }, [frameKey]);

  // Milestone E (B3) — picker state is per project and per browser tab:
  // a project switch resets it (the server flag is per-project too).
  useEffect(() => {
    pickerModeRef.current = false;
    pickerActiveRef.current = false;
    setPickerMode(false);
    setPickerActive(false);
    setSelectionsByChat({});
    setPickerNotice("");
  }, [project.id]);

  const togglePicker = useCallback(async () => {
    if (pickerBusy) return;
    const next = !pickerMode;
    setPickerBusy(true);
    try {
      await api.setPickerMode(project.id, next);
      pickerModeRef.current = next;
      setPickerMode(next);
      setPickerNotice("");
      if (!next) {
        // Off: deactivate in the live iframe and drop this chat's
        // selections (review §5.1 + R-12 binding).
        postPickerCommand("omp-picker-deactivate");
        pickerActiveRef.current = false;
        setPickerActive(false);
        const chatId = activeChatIdRef.current;
        if (chatId) setSelectionsByChat((current) => ({ ...current, [chatId]: [] }));
        selectionEpochRef.current += 1;
      } else {
        // On: the live document was served WITHOUT the script (the flag
        // was off at load), so reload the iframe to get the injected
        // script; onLoad re-activates it. The frameKey effect clears
        // this chat's selections for the new document.
        setFrameKey((k) => k + 1);
      }
    } catch (err) {
      setPickerNotice(err instanceof Error ? err.message : "Could not change picker mode");
    } finally {
      setPickerBusy(false);
    }
  }, [pickerMode, pickerBusy, project.id, postPickerCommand]);

  const clearPickerSelections = useCallback(() => {
    const chatId = activeChatIdRef.current;
    if (!chatId) return;
    selectionEpochRef.current += 1;
    setSelectionsByChat((current) => ({ ...current, [chatId]: [] }));
    postPickerCommand("omp-picker-clear-overlays");
  }, [postPickerCommand]);

  const removePickerSelection = useCallback((index: number) => {
    const chatId = activeChatIdRef.current;
    if (!chatId) return;
    selectionEpochRef.current += 1;
    setSelectionsByChat((current) => {
      const list = current[chatId] ?? [];
      if (index < 0 || index >= list.length) return current;
      const next = [...list];
      next.splice(index, 1);
      return { ...current, [chatId]: next };
    });
    // No per-element overlay removal: the review allows exactly three
    // Builder→iframe commands, and none removes one overlay. The
    // overlay clears with Clear all, on accept, or when the picker
    // turns off; the removed chip is gone from prompt context either way.
  }, []);

  const sendCommand = (command: BrowserCommand) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("Session is reconnecting; try again in a moment");
      return false;
    }
    socket.send(JSON.stringify(command));
    return true;
  };
  // Milestone C (B1) — shared prompt-start for the composer and for
  // Retry on a change card: snapshot first so the change card can diff
  // before/after (Milestone B), then send through the existing WS prompt
  // command. Fire-and-forget snapshot: files_modified awaits the
  // promise, so a slow snapshot never blocks the prompt.
  const startPrompt = useCallback(
    (message: string, selectedComponents?: PickerSelection[]): boolean => {
      snapshotPromiseRef.current = captureSnapshot();
      const promptChatId = activeChatIdRef.current;
      if (
        !sendCommand({
          type: "prompt",
          message,
          ...(promptChatId ? { chatSessionId: promptChatId } : {}),
          ...(selectedComponents && selectedComponents.length > 0 ? { selectedComponents } : {}),
        })
      )
        return false;
      // Milestone E (B4) — snapshot-at-send: remember which selections
      // this turn carries, so prompt_accepted can clear exactly those.
      if (selectedComponents && selectedComponents.length > 0 && promptChatId) {
        pendingSentSelectionsRef.current = { chatId: promptChatId, epoch: selectionEpochRef.current };
      }
      if (activeChatIdRef.current) markChatBusy(activeChatIdRef.current);
      lastUserPromptRef.current = message;
      setItems((current) => [...current, { id: `user-${Date.now()}`, role: "user", text: message }]);
      setWorking(true);
      setSettled(false);
      setError("");
      return true;
    },
    [captureSnapshot, markChatBusy],
  );
  // Milestone E (B7) — attach images to the prompt: each file is
  // uploaded to images/ first (same validation as the Media browser),
  // then referenced as @images/<name> in the prompt text. OMP RPC
  // accepts no image input — only the text prompt — so the reference
  // is the attachment; OMP reads the file from the workspace.
  const handleAttachFiles = async (files: File[] | null) => {
    if (!files || files.length === 0 || attachBusy) return;
    setAttachBusy(true);
    setAttachError("");
    const added: ChatAttachment[] = [];
    for (const file of files) {
      try {
        if (!(MEDIA_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
          throw new Error(`Only jpg, png, gif and webp images can be attached (got ${file.type || "unknown type"}).`);
        }
        if (file.size > MEDIA_MAX_BYTES) throw new Error(`Image is too large — the limit is ${MEDIA_MAX_BYTES / (1024 * 1024)} MB.`);
        const saved = await api.uploadMedia(project.id, file);
        added.push({ path: saved.image.path, name: saved.image.name });
      } catch (err) {
        setAttachError(err instanceof Error ? err.message : `Could not attach ${file.name}`);
      }
    }
    if (added.length) {
      setAttachments((current) => [...current, ...added.filter((item) => !current.some((existing) => existing.path === item.path))]);
      setFilesRefreshToken((t) => t + 1);
    }
    setAttachBusy(false);
  };
  const sendPrompt = (event: FormEvent) => {
    event.preventDefault();
    const text = chat.trim();
    const refs = attachments.map((item) => `@${item.path}`);
    const message =
      refs.length === 0
        ? text
        : text
          ? `${text}\n\n[Attached image${refs.length === 1 ? "" : "s"}: ${refs.join(", ")} — read each file from the project workspace before answering.]`
          : `Use the attached image${refs.length === 1 ? "" : "s"}: ${refs.join(", ")}. Read each file from the project workspace before answering.`;
    if (!message) return;
    if (!startPrompt(message, activeSelections)) return;
    setChat("");
    setAttachments([]);
    if (activeChatIdRef.current) setChatDrafts((current) => ({ ...current, [activeChatIdRef.current as string]: "" }));
  };
  // Milestone E (B4) — Targeted Ask OMP to Edit: sends the typed prompt
  // (or a default one when the composer is empty) with this chat's
  // selections as structured context. The server renders them into the
  // prompt as quoted untrusted data; nothing is auto-sent — this is the
  // admin pressing the button.
  const askToEditSelection = useCallback(() => {
    if (!activeSelections.length) return;
    const text = chat.trim();
    const message = text || "Please edit the selected element(s) in the preview.";
    if (!startPrompt(message, activeSelections)) return;
    setChat("");
    setAttachments([]);
    if (activeChatIdRef.current) setChatDrafts((current) => ({ ...current, [activeChatIdRef.current as string]: "" }));
  }, [activeSelections, chat, startPrompt]);
  // Milestone C (B1) — Undo on a change card: restore the workspace to
  // the checkpoint before the last generation, as a NEW commit (history
  // is preserved). The card is marked undone; its files stay visible.
  const undoCard = useCallback(
    async (card: ChangeCard, discardUncommitted: boolean) => {
      setUndoBusy(true);
      setUndoError("");
      try {
        const result = await api.undoVersion(project.id, discardUncommitted, activeChatIdRef.current ?? undefined);
        setChangeCards((current) => current.map((c) => (c.id === card.id ? { ...c, undone: true } : c)));
        setUndoConfirmCardId(null);
        setUndoDiscard(false);
        setFilesRefreshToken((t) => t + 1);
        if (result.undo.changedPaths.length) handleExternalChanges(result.undo.changedPaths);
        setNotice(
          !result.undo.created
            ? "Already at the previous checkpoint — nothing changed."
            : `Undid the last generation — restored ${result.undo.restoredOid.slice(0, 7)} as a new checkpoint. History is preserved.`,
        );
        void loadVersions();
      } catch (err) {
        setUndoError(err instanceof Error ? err.message : "Undo failed");
      } finally {
        setUndoBusy(false);
      }
    },
    [project.id, handleExternalChanges, loadVersions],
  );
  // Milestone C (B1) — Undo asks first when the workspace has
  // uncommitted changes: the confirm (with its explicit discard
  // checkbox) shows instead of undoing immediately.
  const requestUndo = useCallback(
    (card: ChangeCard) => {
      setUndoError("");
      if (versionsStatus?.dirty) {
        setUndoConfirmCardId(card.id);
        return;
      }
      void undoCard(card, false);
    },
    [versionsStatus, undoCard],
  );
  // Milestone C (B1) — Retry re-sends the turn's prompt to OMP through
  // the existing WS prompt path. Only available when the prompt is
  // recoverable (it is stored on the card at settle time, and replayed
  // user_message events restore it after a reload).
  const retryCard = useCallback(
    (card: ChangeCard) => {
      if (!card.prompt || workingRef.current) return;
      startPrompt(card.prompt);
    },
    [startPrompt],
  );
  const changeModel = (value: string) => {
    const provider = providers.find((item) => item.id === value);
    if (!provider || !sendCommand({ type: "set_model", provider: provider.providerId, modelId: provider.modelId })) return;
    setSelectedModel(value);
    setError("");
  };
  const replay = () => {
    setMenuOpen(false);
    setItems([]);
    setSteps([]);
    setFilesChanged(0);
    setChangedPaths([]);
    setChangeCards([]);
    setDiffView(null);
    setFilesRefreshToken((t) => t + 1);
    setEvents([]);
    lastEventId.current = undefined;
    sendCommand({ type: "replay" });
  };

  // Milestone A (A7) — file-tree expansion reports (stable identity, and
  // it only stores on a real change, so the FileExplorer effect and this
  // callback can't ping-pong each other into a render loop).
  const handleExpandedChange = useCallback((paths: string[]) => {
    setExpandedDirs((current) => (current.join("\n") === [...paths].sort().join("\n") ? current : paths));
  }, []);

  // Milestone A (A4) — "Fix N problems": ONE structured prompt through
  // the EXISTING WebSocket `prompt` command to OMP. No second AI engine.
  // The prompt carries only the selected problems' scoped diagnostic
  // content (file/line/column/code/message, redacted, capped) — never
  // raw log lines or secrets (see buildProblemFixPrompt in shared).
  const fixProblems = useCallback(() => {
    const selected = problems.filter((problem) => selectedProblems.has(problemKey(problem)));
    if (!selected.length) return;
    const message = buildProblemFixPrompt(selected);
    // Milestone B (A2) — snapshot before the Fix turn, like sendPrompt.
    snapshotPromiseRef.current = captureSnapshot();
    if (!sendCommand({ type: "prompt", message, ...(activeChatIdRef.current ? { chatSessionId: activeChatIdRef.current } : {}) })) return;
    if (activeChatIdRef.current) markChatBusy(activeChatIdRef.current);
    setItems((current) => [...current, { id: `user-fix-${Date.now()}`, role: "user", text: message }]);
    setChat("");
    setWorking(true);
    setSettled(false);
    setError("");
    setFixNote(`Asked OMP to fix ${selected.length} problem${selected.length === 1 ? "" : "s"}.`);
    window.setTimeout(() => setFixNote(""), 8000);
  }, [problems, selectedProblems, captureSnapshot, markChatBusy]);

  const problemsSignature = useMemo(() => problems.map((problem) => problemKey(problem)).join("\n"), [problems]);
  const errorProblemCount = useMemo(() => problems.filter((problem) => problem.severity === "error").length, [problems]);
  const selectedProblemCount = useMemo(
    () => problems.filter((problem) => selectedProblems.has(problemKey(problem))).length,
    [problems, selectedProblems],
  );

  const connectionLabel = connection === "connected" ? "Connected" : connection === "reconnecting" ? "Reconnecting…" : connection === "offline" ? "Offline" : "Connecting…";
  const selectedProvider = providers.find((p) => p.id === selectedModel);
  const doneSteps = steps.filter((s) => s.done).length;
  const progress = steps.length ? Math.round((doneSteps / steps.length) * 100) : 0;

  // Milestone D (B2) — chat tab strip. Drag a tab onto another to
  // reorder (persists server-side); double-click to rename; the close
  // button asks once ("Delete?") before deleting the chat and its
  // conversation. A pulsing dot marks a chat with a turn running, an
  // amber dot marks new activity in a background chat.
  const chatTabs = (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-omp-border bg-omp-canvas px-2 py-1.5" role="tablist" aria-label="Chat sessions">
      {chats.map((entry) => {
        const isActive = entry.id === activeChatId;
        const isBusy = busyChats.includes(entry.id);
        const hasUnread = unreadChats.includes(entry.id);
        return (
          <div
            key={entry.id}
            role="tab"
            aria-selected={isActive}
            draggable
            onDragStart={() => {
              dragChatIdRef.current = entry.id;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const dragged = dragChatIdRef.current;
              dragChatIdRef.current = null;
              if (!dragged || dragged === entry.id) return;
              const order = chats.map((c) => c.id).filter((id) => id !== dragged);
              order.splice(order.indexOf(entry.id), 0, dragged);
              void applyChatOrder(order);
            }}
            onClick={() => switchChat(entry.id)}
            onDoubleClick={() => {
              setRenamingChatId(entry.id);
              setRenameValue(entry.title);
            }}
            title={isBusy ? `${entry.title} — working` : entry.title}
            className={`group flex min-w-0 max-w-44 cursor-pointer items-center gap-1.5 rounded-omp px-2.5 py-1.5 text-xs ${isActive ? "bg-white font-semibold text-omp-ink shadow-sm" : "text-omp-muted hover:bg-white/70 hover:text-omp-ink"}`}
          >
            {isBusy ? (
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-omp-brand" aria-label="Working" />
            ) : hasUnread ? (
              <span className="h-2 w-2 shrink-0 rounded-full bg-[#e8a13a]" aria-label="New activity" />
            ) : null}
            {renamingChatId === entry.id ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={() => void submitRename()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitRename();
                  if (event.key === "Escape") setRenamingChatId(null);
                }}
                onClick={(event) => event.stopPropagation()}
                className="w-24 rounded border border-omp-brand bg-white px-1 py-0.5 text-xs text-omp-ink outline-none"
                aria-label="Rename chat"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            )}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (confirmDeleteChatId === entry.id) void deleteChat(entry.id);
                else setConfirmDeleteChatId(entry.id);
              }}
              title={confirmDeleteChatId === entry.id ? "Click again to delete this chat" : "Close chat"}
              aria-label={confirmDeleteChatId === entry.id ? `Confirm delete ${entry.title}` : `Close ${entry.title}`}
              className={`shrink-0 rounded px-1 text-omp-muted hover:bg-[#fdecec] hover:text-[#a83232] ${confirmDeleteChatId === entry.id ? "bg-[#fdecec] font-bold text-[#a83232]" : "opacity-0 group-hover:opacity-100"}`}
            >
              {confirmDeleteChatId === entry.id ? "Delete?" : <X size={12} />}
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => void createChat()}
        disabled={newChatBusy || chatsLoading}
        title="New chat"
        className="flex shrink-0 items-center gap-1 rounded-omp px-2 py-1.5 text-xs font-medium text-omp-brand hover:bg-white"
      >
        <Plus size={13} /> New chat
      </button>
      {chatActionError && <span className="shrink-0 px-1 text-[11px] text-[#a83232]">{chatActionError}</span>}
    </div>
  );

  const conversation = (
    <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      {!items.length && (
        <div className="rounded-omp border border-omp-brand/20 bg-omp-brandSubtle/50 p-4 text-sm leading-6 text-omp-ink">
          Your project workspace is ready. Ask OMP to build or change something.
        </div>
      )}
      {items.map((item) => (
        <div
          key={item.id}
          className={`rounded-omp p-3.5 text-sm leading-6 ${
            item.role === "user"
              ? "bg-[#f2f3f9] text-omp-ink"
              : item.role === "tool"
                ? "border border-[#f5d9a8]/60 bg-[#fff8ea] text-[#7a5b1e]"
                : item.role === "status"
                  ? "bg-transparent px-1 py-0 text-xs text-omp-muted"
                  : "bg-[#efeaff] text-omp-ink"
          }`}
        >
          <div className={`mb-1 text-[10px] font-bold uppercase tracking-[0.12em] ${item.role === "user" ? "text-omp-muted" : item.role === "assistant" ? "text-omp-brand" : "text-omp-muted"}`}>
            {item.role === "tool" ? item.eventType?.replaceAll("_", " ") : item.role === "assistant" ? "Agent" : item.role === "user" ? "You" : item.role}
          </div>
          {renderText(item.text)}
        </div>
      ))}
      {steps.length > 0 && (
        <div className="rounded-omp border border-omp-border bg-white p-4">
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-omp-muted">Work in progress</div>
          <div className="mt-3 space-y-2.5">
            {steps.map((step) => (
              <div key={step.id} className="flex items-start gap-2.5 text-sm text-omp-ink">
                <span
                  className={`mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[11px] ${
                    step.done ? "bg-[#e3f7f0] text-omp-success" : step.failed ? "bg-[#fdecec] text-[#c73e3e]" : "bg-omp-brandSubtle text-omp-brand"
                  }`}
                >
                  {step.done ? "✓" : step.failed ? "✕" : "•"}
                </span>
                <span className="min-w-0 leading-5">{step.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#edf0f6]">
            <div className="h-full rounded-full bg-omp-brand transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      {settled && !working && (filesChanged > 0 || steps.length > 0) && (
        <div className="flex items-center gap-2 px-1 text-xs text-omp-muted">
          <span className="text-omp-brand">✦</span>{" "}
          {filesChanged > 0
            ? `${filesChanged} file${filesChanged === 1 ? "" : "s"} changed • Ready to review`
            : `${doneSteps} step${doneSteps === 1 ? "" : "s"} done • Ready to review`}
        </div>
      )}
      {/* Milestone B (A2) — one "Modified files" card per AI turn: status
          badge + green/red line stats per file; a row opens the read-only
          diff in the Code tab. Milestone C (B1) adds Undo / Retry here:
          Undo restores the checkpoint before this turn as a new commit,
          Retry re-sends the turn's prompt to OMP. */}
      {changeCards.map((card) => (
        <div key={card.id} className="rounded-omp border border-omp-border bg-white p-4" aria-label="Modified files">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-omp-muted">Modified files</div>
            <span className="text-xs text-omp-muted">
              {card.files.length} file{card.files.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mt-1 divide-y divide-omp-border">
            {card.files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => openDiff(file)}
                title={`View diff for ${file.path}`}
                className="flex w-full items-center gap-2 py-2 text-left text-sm hover:opacity-80"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-omp-ink">{file.path}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    file.status === "added" ? "bg-[#e3f7f0] text-omp-success" : file.status === "deleted" ? "bg-[#fdecec] text-[#a83232]" : "bg-[#fef3e2] text-[#9a6b12]"
                  }`}
                >
                  {file.status}
                </span>
                <span className="shrink-0 font-mono text-xs">
                  <span className="text-omp-success">+{file.added}</span> <span className="text-[#c73e3e]">−{file.removed}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-5 text-omp-muted">Select a file to view its diff.</p>
          {card.undone ? (
            <p className="mt-2 rounded-omp bg-omp-brandSubtle px-3 py-2 text-[11px] leading-5 text-omp-brand">
              Undone — the workspace was restored to the checkpoint before this turn (as a new commit; history is preserved).
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                className="!px-3 !py-1.5 !text-xs"
                disabled={working || undoBusy}
                onClick={() => requestUndo(card)}
                title={card.checkpointOid ? `Undo this turn (restore ${card.checkpointOid.slice(0, 7)} as a new commit)` : "Undo this turn"}
              >
                <RotateCcw size={13} /> Undo
              </Button>
              <Button
                variant="outline"
                className="!px-3 !py-1.5 !text-xs"
                disabled={working || !card.prompt}
                onClick={() => retryCard(card)}
                title={card.prompt ? "Re-send this turn's prompt to OMP" : "This turn's prompt is not available to retry"}
              >
                <RefreshCw size={13} /> Retry
              </Button>
              {card.checkpointOid && <span className="font-mono text-[11px] text-omp-muted">checkpoint {card.checkpointOid.slice(0, 7)}</span>}
            </div>
          )}
          {undoConfirmCardId === card.id && !card.undone && (
            <div className="mt-2 rounded-omp border border-[#f5d9a8] bg-[#fff8ea] px-3 py-2.5 text-[11px] leading-5 text-[#7a5b1e]">
              <p>
                <strong>Uncommitted changes exist.</strong> Undo restores the previous checkpoint — your uncommitted changes would be lost
                unless you discard them explicitly.
              </p>
              <label className="mt-1.5 flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={undoDiscard} onChange={(event) => setUndoDiscard(event.target.checked)} className="h-3.5 w-3.5 accent-[#7158ef]" />
                Discard uncommitted changes (including new files never checkpointed)
              </label>
              <span className="mt-2 flex gap-2">
                <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={!undoDiscard || undoBusy} onClick={() => void undoCard(card, undoDiscard)}>
                  {undoBusy ? "Undoing…" : "Undo anyway"}
                </Button>
                <Button
                  variant="ghost"
                  className="!px-3 !py-1.5 !text-xs"
                  onClick={() => {
                    setUndoConfirmCardId(null);
                    setUndoDiscard(false);
                  }}
                >
                  Cancel
                </Button>
              </span>
            </div>
          )}
          {undoConfirmCardId === card.id && undoError && (
            <p className="mt-2 text-[11px] leading-5 text-[#a83232]">{undoError}</p>
          )}
        </div>
      ))}
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-omp border border-[#f6c6c6] bg-[#fdecec] px-3 py-2 text-xs text-[#a83232]">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} className="text-[#a83232] hover:text-omp-ink">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );

  const composer = (
    <form onSubmit={sendPrompt} className="shrink-0 border-t border-omp-border bg-white p-3">
      {/* Milestone E (B4) — selected preview elements for this chat.
          The chips are the admin's preview of exactly what will be sent:
          DOM-only labels (tag + text + class/id hints), rendered as text,
          never as instructions. Per-chip remove, Clear all, and "Ask OMP
          to edit" (sends the typed prompt — or a default one — with the
          selections as quoted untrusted context). */}
      {activeSelections.length > 0 && (
        <div className="mb-2 rounded-omp border border-omp-border bg-omp-canvas px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-omp-ink">
              Selected elements ({activeSelections.length}) — untrusted preview data, sent as labelled context only
            </span>
            <span className="flex items-center gap-2">
              <button type="button" onClick={clearPickerSelections} className="text-xs font-medium text-omp-muted hover:text-omp-ink">
                Clear all
              </button>
              <button
                type="button"
                onClick={askToEditSelection}
                disabled={working || connection !== "connected"}
                className="rounded-omp bg-omp-brand px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                Ask OMP to edit
              </button>
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {activeSelections.map((selection, index) => (
              <span
                key={`${selection.component.tagName}-${index}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-omp border border-omp-border bg-white py-1 pl-2 pr-1 text-xs text-omp-ink"
              >
                <span className="min-w-0 truncate font-mono">{pickerSelectionLabel(selection.component)}</span>
                <button
                  type="button"
                  aria-label={`Remove selected ${pickerSelectionLabel(selection.component)}`}
                  onClick={() => removePickerSelection(index)}
                  className="shrink-0 text-omp-muted hover:text-omp-ink"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="rounded-omp border border-omp-border bg-white focus-within:border-omp-brand focus-within:ring-2 focus-within:ring-omp-brand/15">
        <textarea
          value={chat}
          onChange={(event) => {
            setChat(event.target.value);
            if (activeChatIdRef.current) setChatDrafts((current) => ({ ...current, [activeChatIdRef.current as string]: event.target.value }));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Ask OMP to change anything..."
          rows={3}
          className="w-full resize-none bg-transparent px-3.5 py-3 text-sm text-omp-ink outline-none placeholder:text-omp-muted/70"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => attachInputRef.current?.click()}
              disabled={attachBusy}
              className="text-xs font-medium text-omp-muted hover:text-omp-ink disabled:opacity-50"
            >
              + Attach{attachBusy ? "…" : ""}
            </button>
            <span className="text-xs text-omp-muted">Context: Project</span>
          </div>
          <div className="flex items-center gap-2">
            {working && (
              <Button variant="outline" className="!px-3 !py-2 !text-xs" onClick={() => { if (sendCommand({ type: "abort", ...(activeChatIdRef.current ? { chatSessionId: activeChatIdRef.current } : {}) })) setWorking(false); }}>
                <X size={13} /> Stop
              </Button>
            )}
            <Button type="submit" disabled={(!chat.trim() && attachments.length === 0) || connection !== "connected"} className="!px-4 !py-2">
              Send <ArrowUp size={14} />
            </Button>
          </div>
        </div>
      </div>
      <input
        ref={attachInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        multiple
        className="hidden"
        aria-label="Attach image"
        onChange={(event) => {
          // Copy the files first: clearing input.value below empties
          // the live FileList, so the handler must get a plain array.
          const files = event.target.files ? [...event.target.files] : [];
          event.target.value = "";
          void handleAttachFiles(files);
        }}
      />
      {attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {attachments.map((item) => (
            <span key={item.path} className="inline-flex items-center gap-1.5 rounded-omp border border-omp-border bg-omp-canvas py-1 pl-1 pr-2 text-xs text-omp-ink">
              <img src={api.mediaUrl(project.id, item.name)} alt={item.name} className="h-6 w-6 rounded object-cover" />
              <span className="font-mono">{item.name}</span>
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => setAttachments((current) => current.filter((a) => a.path !== item.path))}
                className="text-omp-muted hover:text-omp-ink"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {attachError && (
        <p role="alert" className="mt-2 text-xs leading-5 text-[#a83232]">
          {attachError}
        </p>
      )}
      {attachments.length > 0 && (
        <p className="mt-2 text-xs leading-5 text-omp-muted">
          Attached images are referenced as @images/… in your prompt — OMP reads the file from the workspace. OMP has no direct image upload, so it
          sees the file by path, not as a pasted picture.
        </p>
      )}
      <p className="mt-2 px-1 text-[11px] text-omp-muted">Agent runs through your configured OMP provider.</p>
    </form>
  );

  // Phase 3D — managed preview. The iframe loads ONLY through the
  // authenticated gateway (never a container port, never a pasted URL), and
  // its sandbox has NO allow-same-origin: the generated page runs in an
  // opaque origin, so its JavaScript cannot read the admin session cookie
  // or call Builder APIs with it.
  // Milestone B (A5) — signature of a problem-free preview error, so
  // the banner's Dismiss can hide it until the error itself changes.
  const previewErrorSignature = useMemo(() => `${preview?.status ?? ""}:${preview?.lastError ?? ""}`, [preview?.status, preview?.lastError]);
  const previewStatusLabel = preview ? preview.status : "stopped";
  const previewStatusTone =
    previewStatusLabel === "running"
      ? "bg-[#e3f7f0] text-omp-success"
      : previewStatusLabel === "starting"
        ? "bg-[#fef3e2] text-[#9a6b12]"
        : previewStatusLabel === "crashed" || previewStatusLabel === "error"
          ? "bg-[#fdecec] text-[#a83232]"
          : "bg-[#edf0f6] text-omp-muted";
  const previewPanel = (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Browser bar — gateway URL is shown read-only, never editable */}
      <div className="flex shrink-0 items-center gap-2 border-b border-omp-border bg-white px-3 py-2.5">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#e8eaf2]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#e8eaf2]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#e8eaf2]" />
        </span>
        <button
          type="button"
          onClick={() => setFrameKey((k) => k + 1)}
          disabled={preview?.status !== "running"}
          className="rounded-md p-1.5 text-omp-muted hover:bg-omp-canvas disabled:opacity-40"
          aria-label="Refresh preview"
          title="Refresh preview"
        >
          <RefreshCw size={14} />
        </button>
        {/* Milestone B (A5) — editable path inside the gateway origin.
            The gateway URL itself is never editable; the path is validated
            by normalizePreviewPath (no other origin is reachable). */}
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const next = normalizePreviewPath(previewPathInput);
            if (next === null) {
              setPreviewPathInput(previewPath);
              return;
            }
            setPreviewPath(next);
            setPreviewPathInput(next);
            setFrameKey((k) => k + 1);
          }}
        >
          <span className="shrink-0 font-mono text-xs text-omp-muted" title={gatewayUrl}>
            {gatewayUrl.replace(/\/$/, "")}
          </span>
          <input
            value={previewPathInput}
            onChange={(event) => setPreviewPathInput(event.target.value)}
            placeholder="/"
            aria-label="Preview path"
            title="Path within the preview (for example /about)"
            className="min-w-0 flex-1 rounded-omp border border-omp-border bg-omp-canvas px-2 py-1.5 font-mono text-xs text-omp-ink outline-none focus:border-omp-brand"
          />
        </form>
        <select
          value={device}
          onChange={(event) => setDevice(event.target.value as StudioDevice)}
          className="shrink-0 rounded-omp border border-omp-border bg-white px-2 py-1.5 text-xs text-omp-ink outline-none"
          aria-label="Preview device"
        >
          <option value="desktop">Desktop</option>
          <option value="tablet">Tablet 768px</option>
          <option value="mobile">Mobile 390px</option>
        </select>
      </div>
      {/* Preview controls */}
      <div className="workspace-toolbar flex shrink-0 flex-wrap items-center gap-2 border-b border-omp-border bg-white px-3 py-2.5">
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${previewStatusTone}`}>{previewStatusLabel}</span>
        {preview && (
          <span className="text-xs text-omp-muted">
            {preview.framework === "vite" ? "Vite dev server" : "Static site"}
            {preview.status === "running" ? ` • container port ${preview.containerPort}` : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {/* Milestone E (B3) — element picker toggle. Turning it on sets
              the server-side flag and reloads the iframe so the gateway
              injects the picker script; turning it off deactivates the
              script and clears this chat's selections. */}
          <Button
            variant="outline"
            className={`!px-3 !py-1.5 !text-xs ${pickerMode ? "!border-omp-brand !text-omp-brand" : ""}`}
            disabled={pickerBusy || preview?.status !== "running"}
            onClick={() => void togglePicker()}
            aria-label={pickerMode ? "Turn off element picker" : "Pick element in preview"}
            title={
              pickerMode
                ? "Picker on — click an element in the preview to select it"
                : "Pick an element in the preview to send it to OMP as context"
            }
          >
            <MousePointerClick size={13} /> <span className="toolbar-label">{pickerMode ? "Picker on" : "Pick element"}</span>
          </Button>
          <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={previewBusy || preview?.status === "running" || preview?.status === "starting"} onClick={() => void previewAction("start")}>
            <Play size={13} /> <span className="toolbar-label">Start</span>
          </Button>
          <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={previewBusy || preview?.status !== "running"} onClick={() => void previewAction("restart")}>
            <RotateCcw size={13} /> <span className="toolbar-label">Restart</span>
          </Button>
          {/* Milestone B (A5) — Rebuild: stop + clear staging + start, so
              a startup build error surfaces in the Problems tab. */}
          <Button
            variant="outline"
            className="!px-3 !py-1.5 !text-xs"
            disabled={previewBusy || preview?.status === "starting"}
            onClick={() => void previewAction("rebuild")}
            title="Stop, clear staging, and start again — surfaces startup build errors"
          >
            <RefreshCw size={13} /> <span className="toolbar-label">Rebuild</span>
          </Button>
          <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={previewBusy || (preview?.status !== "running" && preview?.status !== "starting")} onClick={() => void previewAction("stop")}>
            <X size={13} /> <span className="toolbar-label">Stop</span>
          </Button>
        </span>
      </div>
      {pickerMode && (
        <div className="flex shrink-0 items-center gap-2 border-b border-omp-border bg-[#f3f1ff] px-4 py-2 text-xs text-[#4c3fd6]">
          <MousePointerClick size={13} className="shrink-0" />
          <span>
            Picker on — click an element in the preview to select it. Selections appear above the chat composer and are sent to OMP only
            when you send a prompt, as labelled untrusted data.
          </span>
        </div>
      )}
      {pickerNotice && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[#f6c6c6] bg-[#fdecec] px-4 py-2 text-xs text-[#a83232]" role="alert">
          <span>{pickerNotice}</span>
          <button type="button" onClick={() => setPickerNotice("")} aria-label="Dismiss" className="ml-auto text-[#a83232] hover:text-omp-ink">
            <X size={14} />
          </button>
        </div>
      )}
      {previewError && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#f6c6c6] bg-[#fdecec] px-4 py-2 text-xs text-[#a83232]">
          <span>{previewError}</span>
          <button type="button" onClick={() => setPreviewError("")} aria-label="Dismiss" className="text-[#a83232] hover:text-omp-ink">
            <X size={14} />
          </button>
        </div>
      )}
      {/* Milestone A (A4) — in-preview error banner. Shows while the
          latest diagnostics contain problems; Dismiss hides it until
          the problem set changes. "Fix with AI" is the same Fix action
          as the Problems panel (selected problems → one OMP prompt). */}
      {/* Milestone B (A5) — the banner also shows when the preview
          itself is in error/crashed with no parsed problems (the A4
          banner only fired on problems.length > 0). Dismiss is keyed on
          the problem set or on the preview error, whichever is showing. */}
      {(problems.length > 0 || preview?.status === "error" || preview?.status === "crashed") &&
        bannerDismissedFor !== problemsSignature &&
        bannerDismissedFor !== previewErrorSignature && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#f5d9a8] bg-[#fff8ea] px-4 py-2.5 text-xs leading-5 text-[#7a5b1e]">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">
            {problems.length > 0 ? (
              <>
                <strong>
                  {errorProblemCount > 0
                    ? `${errorProblemCount} error${errorProblemCount === 1 ? "" : "s"}`
                    : `${problems.length} warning${problems.length === 1 ? "" : "s"}`}
                </strong>{" "}
                in the preview — see the Problems tab for details.
              </>
            ) : (
              <>
                <strong>Preview {preview?.status}</strong> — {preview?.lastError ?? "The preview container exited unexpectedly."}
              </>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              className="!px-3 !py-1.5 !text-xs"
              disabled={selectedProblemCount === 0}
              onClick={fixProblems}
            >
              Fix {selectedProblemCount > 1 ? `${selectedProblemCount} errors` : "error"} with AI
            </Button>
            <button
              type="button"
              onClick={() => setBannerDismissedFor(problems.length > 0 ? problemsSignature : previewErrorSignature)}
              className="font-medium hover:text-omp-ink"
            >
              Dismiss
            </button>
          </span>
        </div>
      )}
      {/* Preview body */}
      <div className="flex min-h-0 flex-1 items-stretch justify-center overflow-y-auto bg-omp-canvas p-3 md:p-4">
        {preview?.status === "running" ? (
          <iframe
            ref={iframeRef}
            key={`${gatewayUrl}${previewPath}-${frameKey}`}
            title={`${project.name} preview`}
            src={`${gatewayUrl}${previewPath.slice(1)}`}
            // Milestone E (B3) — the sandbox has NO allow-same-origin:
            // the preview runs in an opaque origin, so its JavaScript
            // cannot read the admin session cookie or call Builder APIs.
            // Never add allow-same-origin (review constraint 1).
            sandbox="allow-scripts allow-forms allow-popups"
            onLoad={() => {
              // A (re)loaded document has the injected script only when
              // picker mode is on; re-activate it then. The picker's own
              // activate() is idempotent, so SPA navigations are safe.
              if (pickerModeRef.current) {
                postPickerCommand("omp-picker-activate");
                pickerActiveRef.current = true;
                setPickerActive(true);
              }
            }}
            className={`min-h-[480px] w-full rounded-omp border border-omp-border bg-white shadow-sm ${device === "mobile" ? "max-w-[390px]" : device === "tablet" ? "max-w-[768px]" : ""}`}
          />
        ) : preview?.status === "starting" ? (
          /* Milestone B (A5) — loading screen while the preview starts,
             replacing the bare "starting…" text. */
          <div className="grid w-full max-w-lg place-items-center self-center rounded-omp-lg border border-omp-border bg-white px-6 py-12 text-center" role="status" aria-label="Preview starting">
            <div>
              <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">
                <RefreshCw size={20} className="animate-spin" />
              </div>
              <h3 className="font-semibold text-omp-ink">Starting preview…</h3>
              <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-omp-muted">
                Starting the isolated container and the dev server. The app appears here automatically once it is ready.
              </p>
              <p className="mt-3 font-mono text-xs text-omp-muted">Container starting → dev server starting → ready</p>
            </div>
          </div>
        ) : (
          <div className="grid w-full max-w-lg place-items-center self-center rounded-omp-lg border border-dashed border-omp-border bg-white px-6 py-12 text-center">
            <div>
              <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">
                <Play size={20} />
              </div>
              <h3 className="font-semibold text-omp-ink">{preview?.status === "crashed" || preview?.status === "error" ? "Preview crashed" : "Preview is stopped"}</h3>
              <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-omp-muted">
                {preview?.status === "crashed" || preview?.status === "error"
                  ? (preview.lastError ?? "The preview container exited unexpectedly. Check the runtime logs, then restart it.")
                  : "Start the preview to run this project in an isolated container and view it here through the secure gateway."}
              </p>
              <Button variant="outline" className="mt-4" disabled={previewBusy} onClick={() => void previewAction(preview?.status === "crashed" || preview?.status === "error" ? "restart" : "start")}>
                {previewBusy ? "Starting…" : preview?.status === "crashed" || preview?.status === "error" ? "Restart preview" : "Start preview"}
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-omp-border bg-white px-4 py-2.5 text-xs text-omp-muted">
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${preview?.status === "running" ? "bg-omp-success" : preview?.status === "starting" ? "bg-[#e8a13a]" : "bg-[#a2aabe]"}`} />
          {preview?.status === "running" ? "Preview running via secure gateway" : "Preview not running"}
        </span>
        <span>{preview ? (preview.framework === "vite" ? "React + Vite" : "Static site") : "No preview yet"}</span>
        <button type="button" onClick={() => setTab("code")} className="ml-auto font-medium text-omp-brand hover:underline">
          Open in editor ↗
        </button>
      </div>
    </div>
  );

  // Milestone A (A4) — Problems panel: checklist of structured
  // diagnostics parsed server-side from the preview logs.
  // Auto-select-all on load; each row deep-links to the file in the Code
  // tab (and reveals the line when one is known); "Fix N problems" sends
  // one structured prompt to OMP through the existing WS prompt command.
  const toggleProblem = (key: string) =>
    setSelectedProblems((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const problemsPanel = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-omp-border bg-white px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-omp-muted">
          <AlertTriangle size={14} /> Problems
        </span>
        <span className="text-xs text-omp-muted">
          {problemsLoading
            ? "Checking preview logs…"
            : problems.length === 0
              ? "No problems found"
              : `${problems.length} problem${problems.length === 1 ? "" : "s"}${errorProblemCount ? ` • ${errorProblemCount} error${errorProblemCount === 1 ? "" : "s"}` : ""}`}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" disabled={problems.length === 0} onClick={() => setSelectedProblems(new Set(problems.map((problem) => problemKey(problem))))}>
            Select all
          </Button>
          <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" disabled={selectedProblemCount === 0} onClick={() => setSelectedProblems(new Set())}>
            Clear all
          </Button>
          <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={problemsLoading} onClick={() => void loadProblems()}>
            <RefreshCw size={13} className={problemsLoading ? "animate-spin" : undefined} /> Refresh
          </Button>
          <Button className="!px-3 !py-1.5 !text-xs" disabled={selectedProblemCount === 0} onClick={fixProblems}>
            Fix {selectedProblemCount} problem{selectedProblemCount === 1 ? "" : "s"}
          </Button>
        </span>
      </div>
      {fixNote && (
        <div className="shrink-0 border-b border-omp-border bg-[#e3f7f0] px-4 py-2 text-xs text-omp-success">{fixNote}</div>
      )}
      {problemsError && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#f6c6c6] bg-[#fdecec] px-4 py-2 text-xs text-[#a83232]">
          <span>{problemsError}</span>
          <button type="button" onClick={() => void loadProblems()} className="font-medium hover:text-omp-ink">
            Retry
          </button>
        </div>
      )}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {problems.length === 0 && !problemsLoading && !problemsError ? (
          <div className="grid place-items-center px-6 py-12">
            <div className="max-w-sm text-center">
              <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">
                <AlertTriangle size={20} />
              </div>
              <h3 className="font-semibold text-omp-ink">No problems found</h3>
              <p className="mt-1.5 text-sm leading-6 text-omp-muted">
                The preview logs show no build or runtime errors. Problems appear here when the preview container reports one — start the
                preview and check again if you expected an error.
              </p>
            </div>
          </div>
        ) : (
          problems.map((problem) => {
            const key = problemKey(problem);
            const location = problem.file
              ? `${problem.file}${problem.line ? `:${problem.line}` : ""}${problem.column ? `:${problem.column}` : ""}`
              : "No file";
            return (
              <div key={key} className="flex items-start gap-3 border-b border-omp-border bg-white px-4 py-3">
                <input
                  type="checkbox"
                  checked={selectedProblems.has(key)}
                  onChange={() => toggleProblem(key)}
                  aria-label={`Select problem: ${location} ${problem.code}`}
                  className="mt-1 h-4 w-4 shrink-0 accent-[#7158ef]"
                />
                <button
                  type="button"
                  disabled={!problem.file}
                  onClick={() => problem.file && void openFile(problem.file, problem.line ?? undefined)}
                  title={problem.file ? `Open ${problem.file}${problem.line ? ` at line ${problem.line}` : ""} in the editor` : "This problem has no file location"}
                  className={`min-w-0 flex-1 text-left ${problem.file ? "hover:opacity-80" : ""}`}
                >
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${problem.severity === "error" ? "bg-[#c73e3e]" : "bg-[#e8a13a]"}`}
                      title={problem.severity}
                    />
                    <span className="min-w-0 truncate font-mono text-xs text-omp-ink">{location}</span>
                    <span className="shrink-0 rounded bg-omp-brandSubtle px-1.5 py-0.5 font-mono text-[11px] text-omp-brand">{problem.code}</span>
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-omp-muted">{problem.severity}</span>
                  </span>
                  <span className="mt-1 block break-words text-sm leading-6 text-omp-ink">{problem.message}</span>
                </button>
              </div>
            );
          })
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-omp-border bg-white px-4 py-2.5 text-xs text-omp-muted">
        <span>Parsed from the preview container logs (latest 200 lines).</span>
        <span>Fix sends only the selected problems to OMP — no raw log lines or secrets.</span>
      </div>
    </div>
  );

  // Phase 3D — Logs tab: runtime logs (preview_log / preview_status) in
  // their own auto-scrolling section, newest at the bottom, capped at the
  // latest 100 lines; session events below, unchanged.
  const runtimeEvents = useMemo(() => events.filter((event) => event.type === "preview_log" || event.type === "preview_status"), [events]);
  const sessionEvents = useMemo(() => events.filter((event) => event.type !== "preview_log" && event.type !== "preview_status"), [events]);
  const runtimeLogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = runtimeLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runtimeEvents]);
  const runtimeText = (event: SessionEvent): string => {
    const payload = event.payload ?? {};
    if (event.type === "preview_log") return typeof payload.line === "string" ? payload.line : eventText(event);
    const status = typeof payload.status === "string" ? payload.status : eventText(event);
    return typeof payload.lastError === "string" && payload.lastError ? `preview ${status}: ${payload.lastError}` : `preview ${status}`;
  };
  // Milestone B (A6) — latest runtime log line, shown in the collapsed
  // console drawer's header.
  const latestLogLine = useMemo(() => {
    const last = runtimeEvents[runtimeEvents.length - 1];
    return last ? runtimeText(last) : "No runtime logs yet — start the preview to see its output here.";
  }, [runtimeEvents]);

  const logsPanel = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Runtime logs */}
      <div className="flex shrink-0 items-center gap-2 border-b border-omp-border bg-white px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-omp-muted">
        <Terminal size={14} /> Runtime logs
        <span className="font-normal normal-case tracking-normal">container stdout/stderr — latest {Math.min(runtimeEvents.length, 100)} shown</span>
      </div>
      <div ref={runtimeLogRef} className="scrollbar-thin max-h-56 min-h-0 shrink-0 overflow-y-auto border-b border-omp-border bg-[#141827] p-3">
        {runtimeEvents.length === 0 ? (
          <p className="py-2 text-center font-mono text-xs text-white/50">No runtime logs yet — start the preview to see its output here.</p>
        ) : (
          <div className="space-y-0.5 font-mono text-xs leading-5 text-white/85">
            {runtimeEvents.slice(-100).map((event, index) => (
              <div key={`${event.eventId ?? index}-${event.type}`} className="flex gap-3">
                <span className="shrink-0 text-white/40">{new Date(event.timestamp).toLocaleTimeString("en-US", { hour12: false })}</span>
                <span className={`shrink-0 ${event.type === "preview_status" ? "text-[#e8a13a]" : "text-white/40"}`}>{event.type === "preview_status" ? "status" : "log"}</span>
                <span className="min-w-0 break-words">{runtimeText(event)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Session events */}
      <div className="flex shrink-0 items-center gap-2 border-b border-omp-border bg-white px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-omp-muted">
        <Terminal size={14} /> Session events
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
        {sessionEvents.length === 0 ? (
          <p className="py-10 text-center text-sm text-omp-muted">No session events yet — send a prompt to start the agent.</p>
        ) : (
          <div className="space-y-1.5 font-mono text-xs leading-5">
            {sessionEvents.map((event, index) => (
              <div key={`${event.eventId ?? index}-${event.type}`} className="flex gap-3 rounded-md bg-white px-3 py-2">
                <span className="shrink-0 text-omp-muted">{new Date(event.timestamp).toLocaleTimeString("en-US", { hour12: false })}</span>
                <span className="shrink-0 rounded bg-omp-brandSubtle px-1.5 py-0.5 font-sans font-semibold text-omp-brand">{event.type}</span>
                <span className="min-w-0 break-words font-sans text-omp-ink">{eventText(event)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  // Phase 3B — editor area (open-file tabs + editor/diff + status bar),
  // shared by the desktop Code tab and the mobile Code tab. Ctrl/Cmd+S
  // saves the active file; Ctrl/Cmd+F is Monaco's built-in find.
  // Milestone B (A3) — this area sits inside the resizable tree|editor
  // split on desktop and on its own on mobile (see codePanel below).
  const editorArea = (
    <div
      className="flex min-h-0 flex-1 flex-col bg-white"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (activePath) void saveFile(activePath);
        }
      }}
    >
      {/* Open-file tabs */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-omp-border bg-white px-2 py-1.5">
        {openFiles.length === 0 ? (
          <span className="px-2 py-1.5 text-xs text-omp-muted">No files open</span>
        ) : (
          openFiles.map((file) => (
            <div
              key={file.path}
              role="tab"
              aria-selected={activePath === file.path}
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs ${
                activePath === file.path ? "bg-omp-brandSubtle font-semibold text-omp-brand" : "text-omp-muted hover:bg-omp-canvas"
              }`}
            >
              <button type="button" onClick={() => setActivePath(file.path)} className="flex items-center gap-1.5" title={file.path}>
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${file.dirty ? "bg-[#e8a13a]" : conflict?.path === file.path ? "bg-[#c73e3e]" : "bg-transparent"}`}
                  title={file.dirty ? "Unsaved changes" : conflict?.path === file.path ? "Changed on disk" : undefined}
                />
                <span className="max-w-[160px] truncate">{file.path.split("/").pop()}</span>
              </button>
              <button type="button" onClick={() => closeFile(file.path)} aria-label={`Close ${file.path}`} className="rounded p-0.5 hover:bg-white">
                <X size={12} />
              </button>
            </div>
          ))
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          <Button
            variant="outline"
            className="!px-3 !py-1.5 !text-xs"
            disabled={!activeFile?.dirty || saving}
            onClick={() => activePath && void saveFile(activePath)}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="ghost"
            className="!px-3 !py-1.5 !text-xs"
            onClick={() => {
              setTab("files");
              setMobileTab("files");
            }}
          >
            Browse files
          </Button>
          {/* Milestone B (A3) — save-on-blur, opt-in, default off. Ctrl+S
              always works either way. Persisted per project. */}
          <label className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-xs text-omp-muted" title="Save the active file when the editor loses focus">
            <input type="checkbox" checked={saveOnBlur} onChange={(event) => setSaveOnBlur(event.target.checked)} className="h-3.5 w-3.5 accent-[#7158ef]" />
            Save on blur
          </label>
        </div>
      </div>

      {/* Edit-conflict / external-change warning (never silently overwrite). */}
      {conflict && openFiles.some((f) => f.path === conflict.path) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#f5d9a8] bg-[#fff8ea] px-4 py-2.5 text-xs leading-5 text-[#7a5b1e]">
          <span className="min-w-0 flex-1">
            <strong>{conflict.path}</strong>{" "}
            {conflict.reason === "save"
              ? "changed on disk since you opened it — your save was not applied."
              : "changed on disk (for example, the agent edited it) while you have unsaved changes."}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Button variant="outline" className="!px-3 !py-1.5 !text-xs" onClick={() => void reloadFromDisk(conflict.path)}>
              Reload from disk
            </Button>
            {conflict.reason === "save" ? (
              <Button
                className="!px-3 !py-1.5 !text-xs"
                onClick={() => {
                  setConflict(null);
                  void saveFile(conflict.path, true);
                }}
              >
                Overwrite anyway
              </Button>
            ) : (
              <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => setConflict(null)}>
                Keep my edits
              </Button>
            )}
          </span>
        </div>
      )}

      {/* Close-with-unsaved-changes confirm (inline, no window.confirm). */}
      {confirmClosePath && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#f6c6c6] bg-[#fdecec] px-4 py-2.5 text-xs leading-5 text-[#a83232]">
          <span className="min-w-0 flex-1">
            Close <strong>{confirmClosePath}</strong> without saving? Your unsaved changes will be lost.
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Button variant="danger" className="!px-3 !py-1.5 !text-xs" onClick={() => discardAndClose(confirmClosePath)}>
              Discard changes
            </Button>
            <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => setConfirmClosePath(null)}>
              Cancel
            </Button>
          </span>
        </div>
      )}

      {editorError && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#f6c6c6] bg-[#fdecec] px-4 py-2 text-xs text-[#a83232]">
          <span>{editorError}</span>
          <button type="button" onClick={() => setEditorError("")} aria-label="Dismiss" className="text-[#a83232] hover:text-omp-ink">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Editor / diff / empty state */}
      {diffView ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-omp-border bg-white px-4 py-2 text-xs">
            <span className="min-w-0 truncate font-mono font-semibold text-omp-ink">{diffView.path}</span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                diffView.status === "added" ? "bg-[#e3f7f0] text-omp-success" : diffView.status === "deleted" ? "bg-[#fdecec] text-[#a83232]" : "bg-[#fef3e2] text-[#9a6b12]"
              }`}
            >
              {diffView.status}
            </span>
            <span className="shrink-0 font-mono">
              <span className="text-omp-success">+{diffView.added}</span> <span className="text-[#c73e3e]">−{diffView.removed}</span>
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <Button variant="outline" className="!px-3 !py-1.5 !text-xs" onClick={() => void openFile(diffView.path)}>
                Open file
              </Button>
              <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => setDiffView(null)}>
                Back to editor
              </Button>
            </span>
          </div>
          <MonacoDiffEditor
            key={`${diffView.path}-${diffView.added}-${diffView.removed}`}
            original={diffView.original}
            modified={diffView.modified}
            language={languageForPath(diffView.path)}
            originalLabel={diffView.originalLabel ?? "Before this AI turn"}
            modifiedLabel={diffView.modifiedLabel ?? "Current file"}
          />
        </div>
      ) : activeFile ? (
        <MonacoEditor
          path={activeFile.path}
          value={activeFile.content}
          language={languageForPath(activeFile.path)}
          revealLine={revealLine}
          onChange={(next) =>
            setOpenFiles((current) => current.map((f) => (f.path === activeFile.path ? { ...f, content: next, dirty: true } : f)))
          }
          onBlur={() => {
            // Milestone B (A3) — save-on-blur, opt-in. Ctrl+S works
            // either way; a clean file is a no-op here.
            // Defer a tick: clicking the toggle steals editor focus, so
            // the blur fires before React has flushed the toggle state
            // change into saveOnBlurRef; checking synchronously would
            // skip the save for the edit in progress, and no later blur
            // fires (the editor is already blurred). The path is the
            // file that was blurred.
            const path = activePathRef.current;
            if (!path) return;
            window.setTimeout(() => {
              if (saveOnBlurRef.current) void saveFile(path);
            }, 0);
          }}
        />
      ) : (
        <div className="grid flex-1 place-items-center overflow-y-auto p-6">
          <div className="max-w-sm text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">
              <Code2 size={20} />
            </div>
            <h3 className="font-semibold text-omp-ink">No file open</h3>
            <p className="mt-1.5 text-sm leading-6 text-omp-muted">Pick a file in the Files tab to open it here and edit it.</p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => {
                setTab("files");
                setMobileTab("files");
              }}
            >
              Browse files
            </Button>
          </div>
        </div>
      )}

      {/* Status bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-omp-border bg-white px-4 py-2 text-xs text-omp-muted">
        {activeFile ? (
          <>
            <span>{languageForPath(activeFile.path)}</span>
            <span>{formatSize(activeFile.size)}</span>
            <span className={activeFile.dirty ? "font-medium text-[#9a6b12]" : ""}>
              {activeFile.dirty ? "● Unsaved changes" : saveNote ? `✓ ${saveNote}` : "✓ Saved"}
            </span>
            <span>Modified {timeAgo(activeFile.mtime)}</span>
          </>
        ) : (
          <span>Select a file to edit</span>
        )}
        <span className="ml-auto">Ctrl/Cmd+S to save • Ctrl/Cmd+F to find</span>
      </div>
    </div>
  );

  // Milestone B (A3/A6) — code panel: a resizable tree|editor split on
  // desktop (react-resizable-panels, sizes persisted per project via
  // autoSaveId), editor-only on mobile (the tree lives in the Files tab
  // there). The split reuses the same FileExplorer as the Files tab.
  const codePanel = (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="hidden min-h-0 flex-1 md:flex">
        <Group
          orientation="horizontal"
          key={project.id}
          defaultLayout={loadStudioPrefs(project.id).codeLayout ?? { "code-tree": 25, "code-editor": 75 }}
          onLayoutChanged={(layout, meta) => {
            if (!meta.isUserInteraction) return;
            saveStudioPrefs(project.id, { ...loadStudioPrefs(project.id), codeLayout: layout });
          }}
          className="flex min-h-0 flex-1"
        >
          <Panel
            id="code-tree"
            defaultSize="25%"
            minSize="15%"
            maxSize="45%"
            className="flex min-h-0 flex-col overflow-hidden border-r border-omp-border bg-white"
          >
            <FileExplorer
              projectId={project.id}
              changedFiles={changedPaths}
              dirtyFiles={dirtyPaths}
              refreshToken={filesRefreshToken}
              initialExpanded={expandedDirs}
              onExpandedChange={handleExpandedChange}
              onSelectFile={(path) => {
                void openFile(path);
              }}
            />
          </Panel>
          <Separator className="w-1.5 shrink-0 bg-omp-border transition hover:bg-omp-brand/50" aria-label="Resize file tree" />
          <Panel id="code-editor" minSize="40%" className="flex min-h-0 min-w-0 flex-col">
            {editorArea}
          </Panel>
        </Group>
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:hidden">{editorArea}</div>
    </div>
  );

  // Milestone C (B1) — initialize version history for this project
  // (safe git init + baseline commit of the current files; no file is
  // changed). Used by the Git tab's empty state.
  const initVersions = useCallback(async () => {
    setVersionsLoading(true);
    setVersionsError("");
    try {
      await api.initVersions(project.id);
      await loadVersions();
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : "Could not initialize version history");
    } finally {
      setVersionsLoading(false);
    }
  }, [project.id, loadVersions]);

  // Milestone C (B1) — open one checkpoint-diff file in the Monaco diff
  // viewer, loading the diff first when it is not already loaded.
  const openCheckpointDiffFile = useCallback(
    async (checkpoint: Checkpoint, filePath: string) => {
      let diff = versionDiffState?.checkpoint.oid === checkpoint.oid ? versionDiffState : null;
      if (!diff) {
        setVersionDiffLoading(true);
        setVersionDiffError("");
        try {
          const result = await api.versionDiff(project.id, checkpoint.oid);
          diff = { checkpoint, against: null, fromOid: result.fromOid, files: result.files };
          setVersionDiffState(diff);
        } catch (err) {
          setVersionDiffError(err instanceof Error ? err.message : "Could not load diff");
          return;
        } finally {
          setVersionDiffLoading(false);
        }
      }
      const file = diff.files.find((f) => f.path === filePath);
      if (file) openVersionDiffFile(file, checkpoint, diff.against);
    },
    [project.id, versionDiffState, openVersionDiffFile],
  );

  // Milestone C (B1) — Version history (Git tab): checkpoint list with
  // search, per-checkpoint diff (vs parent or another checkpoint) in the
  // existing read-only Monaco diff viewer, preview-before-restore via a
  // detached checkout in a staging copy (never the live workspace), and
  // restore with explicit confirmation.
  const checkpointKind = (checkpoint: Checkpoint): string => {
    if (checkpoint.subject.startsWith("Baseline:")) return "Baseline";
    if (checkpoint.subject.startsWith("AI update:")) return "AI turn";
    if (checkpoint.subject.startsWith("Restore to")) return "Restore";
    if (checkpoint.subject.startsWith("Undo:")) return "Undo";
    if (checkpoint.subject.startsWith("Manual")) return "Manual";
    return "Checkpoint";
  };
  const filteredCheckpoints = useMemo(() => {
    const query = versionsQuery.trim().toLowerCase();
    if (!query) return checkpoints;
    return checkpoints.filter(
      (entry) => entry.subject.toLowerCase().includes(query) || entry.oid.toLowerCase().includes(query) || entry.shortOid.toLowerCase().includes(query),
    );
  }, [checkpoints, versionsQuery]);
  const versionsPanel = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-omp-border bg-white px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-omp-muted">
          <GitBranch size={14} /> Version history
        </span>
        <span className="text-xs text-omp-muted">
          {versionsLoading ? "Loading…" : `${checkpoints.length} checkpoint${checkpoints.length === 1 ? "" : "s"}`}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <input
            value={versionsQuery}
            onChange={(event) => setVersionsQuery(event.target.value)}
            placeholder="Search checkpoints…"
            aria-label="Search checkpoints"
            className="w-44 rounded-omp border border-omp-border bg-white px-2 py-1.5 text-xs text-omp-ink outline-none focus:border-omp-brand"
          />
          <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={versionsLoading} onClick={() => void loadVersions()}>
            <RefreshCw size={13} className={versionsLoading ? "animate-spin" : undefined} /> Refresh
          </Button>
          <Button
            className="!px-3 !py-1.5 !text-xs"
            disabled={checkpointBusy || !versionsStatus?.initialized || versionsStatus.corrupt}
            onClick={() => void saveManualCheckpoint()}
            title="Save the current files as a checkpoint"
          >
            {checkpointBusy ? "Saving…" : "Save checkpoint"}
          </Button>
        </span>
      </div>
      {versionsError && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#f6c6c6] bg-[#fdecec] px-4 py-2 text-xs text-[#a83232]">
          <span>{versionsError}</span>
          <button type="button" onClick={() => void loadVersions()} className="font-medium hover:text-omp-ink">
            Retry
          </button>
        </div>
      )}
      {versionsStatus?.corrupt && (
        <div className="shrink-0 border-b border-[#f6c6c6] bg-[#fdecec] px-4 py-2.5 text-xs leading-5 text-[#a83232]">
          <strong>Version history is unavailable:</strong> {versionsStatus.error ?? "the workspace .git directory is unreadable."} It was
          left untouched — fix or remove it by hand before version history can start.
        </div>
      )}
      {versionsStatus?.initialized && versionsStatus.dirty && (
        <div className="shrink-0 border-b border-[#f5d9a8] bg-[#fff8ea] px-4 py-2 text-xs leading-5 text-[#7a5b1e]">
          You have uncommitted changes ({versionsStatus.uncommittedFiles.length} file{versionsStatus.uncommittedFiles.length === 1 ? "" : "s"}).
          Restore and Undo will refuse rather than discard them — unless you explicitly check "Discard uncommitted changes".
        </div>
      )}
      {restoreTarget && (
        <div className="shrink-0 border-b border-[#f5d9a8] bg-[#fff8ea] px-4 py-3 text-xs leading-5 text-[#7a5b1e]" role="alert" aria-label="Confirm restore">
          <p>
            <strong>
              Restore to {restoreTarget.shortOid} — {restoreTarget.subject}?
            </strong>
          </p>
          <p className="mt-1">
            The workspace is replaced with this checkpoint as a <strong>new commit</strong>. History is preserved — nothing is rewritten.
            The preview keeps serving the current files until you restart it.
          </p>
          {versionsStatus?.dirty && (
            <div className="mt-2">
              <p>
                <strong>Uncommitted changes exist ({versionsStatus.uncommittedFiles.length} files).</strong> Restoring would discard them.
              </p>
              <label className="mt-1.5 flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={restoreDiscard} onChange={(event) => setRestoreDiscard(event.target.checked)} className="h-3.5 w-3.5 accent-[#7158ef]" />
                Discard uncommitted changes (including new files never checkpointed)
              </label>
            </div>
          )}
          {restoreError && <p className="mt-2 text-[#a83232]">{restoreError}</p>}
          <span className="mt-2.5 flex gap-2">
            <Button
              variant="outline"
              className="!px-3 !py-1.5 !text-xs"
              disabled={restoreBusy || (!!versionsStatus?.dirty && !restoreDiscard)}
              onClick={() => void confirmRestore()}
            >
              {restoreBusy ? "Restoring…" : "Restore this version"}
            </Button>
            <Button
              variant="ghost"
              className="!px-3 !py-1.5 !text-xs"
              onClick={() => {
                setRestoreTarget(null);
                setRestoreDiscard(false);
                setRestoreError("");
              }}
            >
              Cancel
            </Button>
          </span>
        </div>
      )}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {versionPreviewState && (
          <div className="border-b border-[#f5d9a8] bg-[#fff8ea] px-4 py-3 text-xs leading-5 text-[#7a5b1e]" aria-label="Restore preview">
            <p>
              <strong>
                Previewing checkpoint {versionPreviewState.oid.slice(0, 7)} — {versionPreviewState.subject}
              </strong>
            </p>
            <p className="mt-1">
              This is a staging copy — the live workspace is untouched. {versionPreviewState.files.length} file
              {versionPreviewState.files.length === 1 ? "" : "s"} in this version
              {versionPreviewState.files.length >= 500 ? " (showing first 500)" : ""}.
            </p>
            {versionPreviewState.diff.length > 0 ? (
              <div className="mt-2 space-y-0.5 font-mono text-[11px]">
                {versionPreviewState.diff.slice(0, 10).map((file) => (
                  <div key={file.path} className="flex gap-2">
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase bg-white/70">{file.status}</span>
                    <span className="min-w-0 truncate">{file.path}</span>
                    <span className="ml-auto shrink-0">
                      <span className="text-omp-success">+{file.added}</span> <span className="text-[#c73e3e]">−{file.removed}</span>
                    </span>
                  </div>
                ))}
                {versionPreviewState.diff.length > 10 && <p>…and {versionPreviewState.diff.length - 10} more changed files vs the current version.</p>}
              </div>
            ) : (
              <p className="mt-1">No differences from the current version.</p>
            )}
            <span className="mt-2.5 flex gap-2">
              <Button
                variant="outline"
                className="!px-3 !py-1.5 !text-xs"
                onClick={() => {
                  const checkpoint = checkpoints.find((entry) => entry.oid === versionPreviewState.oid);
                  if (checkpoint) {
                    setRestoreTarget(checkpoint);
                    setRestoreDiscard(false);
                    setRestoreError("");
                  }
                }}
              >
                Restore this version…
              </Button>
              <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => setVersionPreviewState(null)}>
                Close preview
              </Button>
            </span>
          </div>
        )}
        {selectedVersion && (
          <div className="border-b border-omp-border bg-white px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs font-semibold text-omp-brand">{selectedVersion.shortOid}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-omp-ink">{selectedVersion.subject}</span>
              <span className="shrink-0 rounded-full bg-omp-brandSubtle px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-omp-brand">
                {checkpointKind(selectedVersion)}
              </span>
              <button type="button" onClick={() => { setSelectedVersion(null); setVersionDetail(null); setVersionDiffState(null); }} className="shrink-0 rounded p-1 text-omp-muted hover:bg-omp-canvas" aria-label="Close checkpoint details">
                <X size={14} />
              </button>
            </div>
            <p className="mt-1 text-xs text-omp-muted">
              {new Date(selectedVersion.timestamp).toLocaleString()} • {selectedVersion.filesChanged} file{selectedVersion.filesChanged === 1 ? "" : "s"} •{" "}
              <span className="text-omp-success">+{selectedVersion.added}</span> <span className="text-[#c73e3e]">−{selectedVersion.removed}</span>
              {selectedVersion.sessionId && selectedVersion.sessionId !== "baseline" ? ` • session ${selectedVersion.sessionId.slice(0, 8)}` : ""}
            </p>
            <span className="mt-2.5 flex flex-wrap gap-2">
              <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={versionDiffLoading} onClick={() => void loadVersionDiff(selectedVersion)}>
                {versionDiffLoading ? "Loading diff…" : "View diff"}
              </Button>
              <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={versionPreviewLoading} onClick={() => void loadVersionPreview(selectedVersion)}>
                {versionPreviewLoading ? "Previewing…" : "Preview restore"}
              </Button>
              <Button
                variant="outline"
                className="!px-3 !py-1.5 !text-xs"
                onClick={() => {
                  setRestoreTarget(selectedVersion);
                  setRestoreDiscard(false);
                  setRestoreError("");
                }}
              >
                Restore…
              </Button>
            </span>
            {versionDetailLoading && <p className="mt-2 text-xs text-omp-muted">Loading checkpoint…</p>}
            {versionDetailError && <p className="mt-2 text-xs text-[#a83232]">{versionDetailError}</p>}
            {versionDiffError && <p className="mt-2 text-xs text-[#a83232]">{versionDiffError}</p>}
            {versionPreviewError && <p className="mt-2 text-xs text-[#a83232]">{versionPreviewError}</p>}
            {versionDetail && !versionDiffState && (
              <div className="mt-2 divide-y divide-omp-border">
                {versionDetail.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => void openCheckpointDiffFile(selectedVersion, file.path)}
                    title={`View diff for ${file.path}`}
                    className="flex w-full items-center gap-2 py-2 text-left text-sm hover:opacity-80"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-omp-ink">{file.path}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${file.status === "added" ? "bg-[#e3f7f0] text-omp-success" : file.status === "deleted" ? "bg-[#fdecec] text-[#a83232]" : "bg-[#fef3e2] text-[#9a6b12]"}`}>
                      {file.status}
                    </span>
                    <span className="shrink-0 font-mono text-xs">
                      <span className="text-omp-success">+{file.added}</span> <span className="text-[#c73e3e]">−{file.removed}</span>
                    </span>
                  </button>
                ))}
                {versionDetail.files.length === 0 && <p className="py-2 text-xs text-omp-muted">This checkpoint changed no files.</p>}
              </div>
            )}
            {versionDiffState && (
              <div className="mt-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-omp-muted">
                  <span>
                    Diff: {versionDiffState.fromOid ? versionDiffState.fromOid.slice(0, 7) : "—"} → {versionDiffState.checkpoint.shortOid}
                  </span>
                  <label className="flex items-center gap-1.5">
                    Compare with
                    <select
                      value={versionDiffState.against ?? ""}
                      onChange={(event) => void loadVersionDiff(versionDiffState.checkpoint, event.target.value || undefined)}
                      className="rounded-omp border border-omp-border bg-white px-2 py-1 text-xs text-omp-ink outline-none"
                      aria-label="Compare checkpoint with"
                    >
                      <option value="">Parent checkpoint</option>
                      {checkpoints
                        .filter((entry) => entry.oid !== versionDiffState.checkpoint.oid)
                        .map((entry) => (
                          <option key={entry.oid} value={entry.oid}>
                            {entry.shortOid} — {entry.subject.slice(0, 60)}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <div className="mt-1 divide-y divide-omp-border">
                  {versionDiffState.files.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => openVersionDiffFile(file, versionDiffState.checkpoint, versionDiffState.against)}
                      title={file.binary ? `${file.path} (binary or too large to show)` : `View diff for ${file.path}`}
                      className="flex w-full items-center gap-2 py-2 text-left text-sm hover:opacity-80"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-omp-ink">{file.path}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${file.status === "added" ? "bg-[#e3f7f0] text-omp-success" : file.status === "deleted" ? "bg-[#fdecec] text-[#a83232]" : "bg-[#fef3e2] text-[#9a6b12]"}`}>
                        {file.status}
                      </span>
                      <span className="shrink-0 font-mono text-xs">
                        <span className="text-omp-success">+{file.added}</span> <span className="text-[#c73e3e]">−{file.removed}</span>
                      </span>
                    </button>
                  ))}
                  {versionDiffState.files.length === 0 && <p className="py-2 text-xs text-omp-muted">No differences between these checkpoints.</p>}
                </div>
              </div>
            )}
          </div>
        )}
        {!versionsStatus?.initialized && !versionsLoading ? (
          <div className="grid place-items-center px-6 py-12">
            <div className="max-w-sm text-center">
              <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">
                <GitBranch size={20} />
              </div>
              <h3 className="font-semibold text-omp-ink">Version history isn't set up yet</h3>
              <p className="mt-1.5 text-sm leading-6 text-omp-muted">
                Initializing creates a Git repo in this project's workspace and saves the current files as a baseline checkpoint. No files are
                changed, and every later AI turn gets its own checkpoint you can diff, preview, restore, or undo.
              </p>
              <Button className="mt-4" onClick={() => void initVersions()}>
                Initialize version history
              </Button>
            </div>
          </div>
        ) : filteredCheckpoints.length === 0 && !versionsLoading ? (
          <div className="grid place-items-center px-6 py-12">
            <div className="max-w-sm text-center">
              <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">
                <GitBranch size={20} />
              </div>
              <h3 className="font-semibold text-omp-ink">{versionsQuery ? "No checkpoints match" : "No checkpoints yet"}</h3>
              <p className="mt-1.5 text-sm leading-6 text-omp-muted">
                {versionsQuery
                  ? "Try a different search — checkpoints match on their message or id."
                  : "The first settled AI turn that changes files creates a checkpoint here. You can also save one now with “Save checkpoint”."}
              </p>
            </div>
          </div>
        ) : (
          filteredCheckpoints.map((checkpoint) => (
            <div key={checkpoint.oid} className="flex items-start gap-3 border-b border-omp-border bg-white px-4 py-3">
              <button type="button" onClick={() => void loadVersionDetail(checkpoint)} title={`Open ${checkpoint.shortOid}`} className="min-w-0 flex-1 text-left hover:opacity-80">
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="shrink-0 font-mono text-xs font-semibold text-omp-brand">{checkpoint.shortOid}</span>
                  <span className="shrink-0 rounded-full bg-omp-brandSubtle px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-omp-brand">
                    {checkpointKind(checkpoint)}
                  </span>
                  <span className="shrink-0 text-xs text-omp-muted">{timeAgo(checkpoint.timestamp)}</span>
                </span>
                <span className="mt-1 block break-words text-sm leading-6 text-omp-ink">{checkpoint.subject}</span>
                <span className="mt-0.5 block font-mono text-[11px] text-omp-muted">
                  {checkpoint.filesChanged} file{checkpoint.filesChanged === 1 ? "" : "s"} • +{checkpoint.added} −{checkpoint.removed}
                </span>
              </button>
              <span className="flex shrink-0 flex-col gap-1">
                <Button
                  variant="outline"
                  className="!px-2.5 !py-1 !text-[11px]"
                  onClick={() => {
                    void loadVersionDetail(checkpoint).then(() => void loadVersionDiff(checkpoint));
                  }}
                >
                  Diff
                </Button>
                <Button variant="outline" className="!px-2.5 !py-1 !text-[11px]" onClick={() => void loadVersionPreview(checkpoint)}>
                  Preview
                </Button>
                <Button
                  variant="outline"
                  className="!px-2.5 !py-1 !text-[11px]"
                  onClick={() => {
                    setRestoreTarget(checkpoint);
                    setRestoreDiscard(false);
                    setRestoreError("");
                  }}
                >
                  Restore
                </Button>
              </span>
            </div>
          ))
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-omp-border bg-white px-4 py-2.5 text-xs text-omp-muted">
        <span>One checkpoint per AI turn that changes files.</span>
        <span>Restores and undos are new commits — history is never rewritten.</span>
        <span>Secret files (.env, keys, credentials) are never committed.</span>
      </div>
    </div>
  );

  const phaseNote = (icon: ReactNode, title: string, body: string) => (
    <div className="grid flex-1 place-items-center overflow-y-auto p-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">{icon}</div>
        <h3 className="font-semibold text-omp-ink">{title}</h3>
        <p className="mt-1.5 text-sm leading-6 text-omp-muted">{body}</p>
      </div>
    </div>
  );

  // Milestone D (B6) — Project rules editor. Rules are written to
  // .omp/RULES.md and sent to the model on every turn; they must never
  // contain secrets. Saving restarts the live OMP session(s) so the next
  // turn picks the new rules up.
  const rulesPanel = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-omp-border bg-white px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-omp-muted">
          <Settings2 size={14} /> Project rules
        </span>
        <span className="text-xs text-omp-muted">
          {rulesLoading ? "Loading…" : rulesLoaded ? "Always-on instructions for OMP, sent on every turn" : ""}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={rulesLoading} onClick={() => void loadRules()}>
            <RefreshCw size={13} className={rulesLoading ? "animate-spin" : undefined} /> Refresh
          </Button>
          <Button
            variant="outline"
            className="!px-3 !py-1.5 !text-xs"
            disabled={rulesSaving || rulesLoading || rulesContent.trim() === ""}
            onClick={() => void saveRules("")}
            title="Delete the rules file — the next turn starts without rules"
          >
            Remove rules
          </Button>
          <Button className="!px-3 !py-1.5 !text-xs" disabled={rulesSaving || rulesLoading} onClick={() => void saveRules(rulesContent)}>
            {rulesSaving ? "Saving…" : "Save rules"}
          </Button>
        </span>
      </div>
      {rulesError && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#f6c6c6] bg-[#fdecec] px-4 py-2 text-xs text-[#a83232]">
          <span>{rulesError}</span>
          <button type="button" onClick={() => void loadRules()} className="font-medium hover:text-omp-ink">
            Retry
          </button>
        </div>
      )}
      {rulesNotice && (
        <div className="shrink-0 border-b border-[#f5d9a8] bg-[#fff8ea] px-4 py-2 text-xs leading-5 text-[#7a5b1e]">{rulesNotice}</div>
      )}
      {rulesHasRootAgentsMd && (
        <div className="shrink-0 border-b border-[#f5d9a8] bg-[#fff8ea] px-4 py-2 text-xs leading-5 text-[#7a5b1e]">
          This project also has a root <strong>AGENTS.md</strong>, which OMP now loads on every turn alongside these rules.
        </div>
      )}
      <div className="shrink-0 border-b border-omp-border bg-white px-4 py-2 text-xs leading-5 text-omp-muted">
        Rules are stored as <code>.omp/RULES.md</code> and sent to the AI model on every turn. Never put API keys, tokens,
        passwords or other secrets in rules — they are rejected on save. Saving restarts the running OMP session, so
        rules apply from the next turn.
      </div>
      <textarea
        value={rulesContent}
        onChange={(event) => setRulesContent(event.target.value)}
        placeholder="Example:\n- Always use TypeScript strict mode.\n- Prefer small, focused components.\n- Never add a feature I did not ask for."
        aria-label="Project rules"
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-white px-4 py-3 font-mono text-sm leading-6 text-omp-ink outline-none"
      />
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-omp-border bg-white px-4 py-2 text-xs text-omp-muted">
        <span>
          {rulesContent.length.toLocaleString()} / 20,000 characters
        </span>
        <span>Rules are versioned with checkpoints — restoring an older checkpoint restores its rules too.</span>
      </div>
    </div>
  );

  const tabContent = useMemo(() => {
    // Milestone B (A5) — the preview is rendered always-mounted in the
    // desktop workspace body below, so switching tabs never unmounts the
    // iframe; this branch is therefore a placeholder, never shown.
    if (tab === "preview") return <div className="flex min-h-0 flex-1" />;
    if (tab === "logs") return logsPanel;
    if (tab === "code") return codePanel;
    if (tab === "problems") return problemsPanel;
    // Milestone C (B1) — the Git tab is version history now, not a
    // Phase 4 placeholder.
    if (tab === "git") return versionsPanel;
    if (tab === "rules") return rulesPanel;
    if (tab === "files")
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Milestone E (B7) — Media browser sits at the top of the Files
              tab (least invasive fit: no new tab); the tree below is unchanged. */}
          <MediaBrowser projectId={project.id} refreshToken={filesRefreshToken} onChanged={() => setFilesRefreshToken((t) => t + 1)} />
          <FileExplorer
            projectId={project.id}
            changedFiles={changedPaths}
            dirtyFiles={dirtyPaths}
            refreshToken={filesRefreshToken}
            initialExpanded={expandedDirs}
            onExpandedChange={handleExpandedChange}
            onSelectFile={(path) => {
              void openFile(path);
            }}
          />
        </div>
      );
    return phaseNote(<GitBranch size={20} />, "Unknown tab", "This workspace tab does not exist.");
  }, [tab, previewPanel, logsPanel, codePanel, problemsPanel, versionsPanel, rulesPanel, project.id, changedPaths, filesRefreshToken, expandedDirs, handleExpandedChange, openFile]);

  const railItems: { id: NavScreen; label: string; icon: typeof LayoutDashboard; active?: boolean }[] = [
    { id: "dashboard", label: "Overview", icon: LayoutDashboard },
    { id: "builder", label: "Build Studio", icon: Code2, active: true },
    { id: "projects", label: "My Projects", icon: Folder },
    { id: "github", label: "GitHub", icon: GitBranch },
    { id: "settings", label: "Settings", icon: Settings2 },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {/* Desktop: icon rail */}
      <div className="hidden w-[72px] shrink-0 flex-col items-center gap-1 bg-omp-nav py-5 md:flex">
        <span className="mb-6 grid h-9 w-9 place-items-center rounded-xl bg-omp-brand text-lg font-bold text-white">◈</span>
        {railItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              title={item.label}
              aria-label={item.label}
              className={`grid h-11 w-11 place-items-center rounded-xl transition ${item.active ? "bg-white/10 text-white" : "text-[#a2aabe] hover:bg-white/[.06] hover:text-white"}`}
            >
              <Icon size={19} />
            </button>
          );
        })}
      </div>

      {/* Milestone B (A6) — resizable chat/workspace split. Panel sizes
          persist per project in the A7 prefs object (defaultLayout in,
          onLayoutChanged out — v4 has no autoSaveId). The Group remounts
          per project (key) so a project switch loads that project's
          saved layout. */}
      <Group
        orientation="horizontal"
        key={project.id}
        defaultLayout={loadStudioPrefs(project.id).chatLayout ?? { chat: 28, workspace: 72 }}
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction) return;
          saveStudioPrefs(project.id, { ...loadStudioPrefs(project.id), chatLayout: layout });
        }}
        className="hidden min-h-0 flex-1 md:flex"
      >
        <Panel id="chat" defaultSize="28%" minSize="20%" maxSize="45%" className="flex min-h-0 flex-col border-r border-omp-border bg-white">
          {/* Agent panel — desktop */}
        <div className="flex items-center justify-between px-5 pb-1 pt-5">
          <h2 className="text-lg font-bold text-omp-ink">AI Builder</h2>
          <div className="relative">
            <button type="button" onClick={() => setMenuOpen((v) => !v)} className="rounded-lg p-2 text-omp-muted hover:bg-omp-canvas" aria-label="Session actions">
              <MoreHorizontal size={18} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-20 mt-1 w-56 rounded-omp border border-omp-border bg-white py-1 shadow-lg">
                <button
                  type="button"
                  onClick={replay}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-omp-ink hover:bg-omp-canvas"
                >
                  <RotateCcw size={14} /> Replay session events
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="px-5 pb-3 pt-2">
          <label className="block rounded-omp border border-omp-border bg-white px-3 py-2.5">
            <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em] text-omp-muted">
              <span className={`h-2 w-2 rounded-full ${connection === "connected" ? "bg-omp-success" : "bg-[#e8a13a]"}`} /> Default model
            </span>
            <span className="mt-1 flex items-center gap-1">
              <select
                value={selectedModel}
                onChange={(event) => changeModel(event.target.value)}
                disabled={!providers.length}
                className="w-full bg-transparent text-sm font-medium text-omp-ink outline-none"
                aria-label="Default model"
              >
                {providers.length === 0 && <option value="">No models configured</option>}
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName} • {provider.modelId}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="shrink-0 text-omp-muted" />
            </span>
          </label>
        </div>
        {chatTabs}
        {conversation}
        {composer}
        </Panel>
        <Separator className="w-1.5 shrink-0 bg-omp-border transition hover:bg-omp-brand/50" aria-label="Resize chat panel" />

      {/* Main workspace — desktop */}
      <Panel id="workspace" minSize="40%" className="flex min-h-0 min-w-0 flex-col bg-omp-canvas">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-omp-border bg-white px-5 py-3.5">
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold text-omp-ink">{project.name}</h1>
            <p className="text-xs text-omp-muted">Last saved {timeAgo(project.updatedAt)}</p>
          </div>
          <div className="flex items-center gap-2">
            {!working && <span className="hidden items-center gap-1.5 text-xs text-omp-success lg:flex">✓ All changes saved</span>}
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${connection === "connected" ? "bg-[#e3f7f0] text-omp-success" : "bg-[#fef3e2] text-[#9a6b12]"}`}>
              {connectionLabel}
            </span>
            <Button variant="subtle" className="!px-3.5 !py-2" onClick={() => setNotice("Sharing arrives with deployment in Phase 4.")}>
              Share
            </Button>
            <Button className="!px-3.5 !py-2" onClick={() => setNotice("Publishing arrives with deployment in Phase 4.")}>
              Publish ↗
            </Button>
          </div>
        </header>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-omp-border bg-white px-5 py-2.5">
          <div className="flex items-center gap-1" role="tablist" aria-label="Workspace tabs">
            {tabLabels.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
                className={`inline-flex items-center rounded-omp px-3.5 py-2 text-sm transition ${tab === item.id ? "bg-omp-brandSubtle font-semibold text-omp-brand" : "text-omp-muted hover:bg-omp-canvas hover:text-omp-ink"}`}
              >
                {item.label}
                {/* Milestone A (A1/A4) — live Problems count badge, capped at "100+". */}
                {item.id === "problems" && problems.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-[#c73e3e] px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                    {problems.length > 100 ? "100+" : problems.length}
                  </span>
                )}
              </button>
            ))}
          </div>
          {/* Milestone B (A6) — container-query toolbar: the labels hide
              when this toolbar gets narrow (see .workspace-toolbar CSS). */}
          <div className="workspace-toolbar flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSplit((v) => !v)}
              className={`flex items-center gap-1.5 rounded-omp px-2.5 py-1.5 text-xs font-medium ${split ? "bg-omp-brandSubtle text-omp-brand" : "text-omp-muted hover:bg-omp-canvas"}`}
              title="Split preview and logs"
            >
              <SplitSquareHorizontal size={14} /> <span className="toolbar-label">Split</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (tab === "preview") setFrameKey((k) => k + 1);
                else if (tab === "problems") void loadProblems();
                else if (tab === "git") void loadVersions();
                else if (tab === "rules") void loadRules();
                else if (tab === "logs") api.projectSession(project.id).then((result) => result.events.forEach((event) => handleEvent({ type: event.type, timestamp: event.createdAt, projectId: event.projectId, eventId: event.id, payload: event.payload })));
              }}
              className="flex items-center gap-1.5 rounded-omp px-2.5 py-1.5 text-xs font-medium text-omp-muted hover:bg-omp-canvas"
              title="Refresh"
            >
              <RefreshCw size={14} /> <span className="toolbar-label">Refresh</span>
            </button>
          </div>
        </div>
        {notice && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-omp-border bg-[#fff8ea] px-5 py-2 text-xs text-[#7a5b1e]">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice("")} aria-label="Dismiss" className="text-[#7a5b1e] hover:text-omp-ink">
              <X size={14} />
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {/* Milestone B (A5) — the preview stays mounted while other tabs
              are shown, so switching tabs cannot disturb a running
              preview (the iframe keeps its state; the container keeps
              running server-side either way). */}
          <div className={`flex min-w-0 flex-1 flex-col ${tab === "preview" ? "" : "hidden"}`}>{previewPanel}</div>
          {tab !== "preview" && <div className="flex min-w-0 flex-1 flex-col">{tabContent}</div>}
          {split && tab === "preview" && (
            <div className="hidden w-[380px] shrink-0 flex-col border-l border-omp-border bg-omp-canvas lg:flex">
              <div className="flex items-center gap-2 border-b border-omp-border bg-white px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-omp-muted">
                <Terminal size={14} /> Session logs
              </div>
              {logsPanel}
            </div>
          )}
        </div>
        {/* Milestone B (A6) — collapsible console drawer under the
            workspace. Collapsed it shows the latest runtime log line;
            expanded it shows the latest 100 lines. Open state persists
            per project (A7 prefs). */}
        <div className="shrink-0 border-t border-omp-border bg-[#141827] text-white">
          <button
            type="button"
            onClick={() => setConsoleOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs"
            aria-expanded={consoleOpen}
            aria-label="Toggle console drawer"
          >
            <Terminal size={13} className="shrink-0 text-white/60" />
            <span className="shrink-0 font-semibold uppercase tracking-[0.12em] text-white/60">Console</span>
            <span className="min-w-0 flex-1 truncate font-mono text-white/85">{latestLogLine}</span>
            <ChevronDown size={14} className={`shrink-0 text-white/60 transition ${consoleOpen ? "rotate-180" : ""}`} />
          </button>
          {consoleOpen && (
            <div className="scrollbar-thin max-h-52 overflow-y-auto border-t border-white/10 px-4 py-2 font-mono text-xs leading-5 text-white/85">
              {runtimeEvents.length === 0 ? (
                <p className="py-2 text-white/50">No runtime logs yet — start the preview to see its output here.</p>
              ) : (
                runtimeEvents.slice(-100).map((event, index) => (
                  <div key={`${event.eventId ?? index}-${event.type}`} className="flex gap-3">
                    <span className="shrink-0 text-white/40">{new Date(event.timestamp).toLocaleTimeString("en-US", { hour12: false })}</span>
                    <span className={`shrink-0 ${event.type === "preview_status" ? "text-[#e8a13a]" : "text-white/40"}`}>{event.type === "preview_status" ? "status" : "log"}</span>
                    <span className="min-w-0 break-words">{runtimeText(event)}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </Panel>
      </Group>

      {/* Mobile studio */}
      <section className="flex min-h-0 flex-1 flex-col bg-omp-canvas md:hidden">
        <div className="shrink-0 border-b border-omp-border bg-white px-4 pb-3 pt-4">
          <div className="flex items-center justify-between gap-2">
            <h1 className="truncate text-base font-bold text-omp-ink">{project.name}</h1>
            <StatusChip label={connectionLabel} tone={connection === "connected" ? "success" : "warn"} />
          </div>
          <label className="mt-2.5 flex items-center gap-2 rounded-omp border border-omp-border bg-white px-3 py-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${connection === "connected" ? "bg-omp-success" : "bg-[#e8a13a]"}`} />
            <select
              value={selectedModel}
              onChange={(event) => changeModel(event.target.value)}
              disabled={!providers.length}
              className="w-full bg-transparent text-xs font-medium text-omp-ink outline-none"
              aria-label="Default model"
            >
              {providers.length === 0 && <option value="">No models configured</option>}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.displayName} • {provider.modelId}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="shrink-0 text-omp-muted" />
          </label>
          {/* Milestone B — Problems joins the mobile tab bar (it was
              desktop-only in Milestone A), so diagnostics are reachable
              on small screens. Milestone C (B1) — Version history joins
              it too. Milestone D (B6) — Project rules joins it as well.
              Seven tabs share the row; the badge mirrors the
              desktop Problems count. */}
          <div className="mt-3 flex items-center gap-1" role="tablist" aria-label="Builder tabs">
            {(["chat", "preview", "code", "files", "problems", "git", "rules"] as MobileTab[]).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mobileTab === item}
                onClick={() => setMobileTab(item)}
                className={`flex flex-1 items-center justify-center gap-1 rounded-omp px-1 py-2 text-xs capitalize transition ${mobileTab === item ? "bg-omp-brandSubtle font-semibold text-omp-brand" : "text-omp-muted"}`}
              >
                {item}
                {item === "problems" && problems.length > 0 && (
                  <span className="rounded-full bg-[#c73e3e] px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                    {problems.length > 100 ? "100+" : problems.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
        {mobileTab === "chat" ? (
          <div className="flex min-h-0 flex-1 flex-col bg-white">
            <div className="flex items-center gap-2 border-b border-omp-border px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-omp-muted">
              <MessageSquare size={14} /> OMP chat {working && <span className="text-omp-brand">• Working…</span>}
            </div>
            {chatTabs}
            {conversation}
            {composer}
          </div>
        ) : mobileTab === "preview" ? (
          <div className="flex min-h-0 flex-1 flex-col">{previewPanel}</div>
        ) : mobileTab === "code" ? (
          <div className="flex min-h-0 flex-1 flex-col">{codePanel}</div>
        ) : mobileTab === "problems" ? (
          <div className="flex min-h-0 flex-1 flex-col">{problemsPanel}</div>
        ) : mobileTab === "git" ? (
          <div className="flex min-h-0 flex-1 flex-col">{versionsPanel}</div>
        ) : mobileTab === "rules" ? (
          <div className="flex min-h-0 flex-1 flex-col">{rulesPanel}</div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col bg-white">
            <FileExplorer
              projectId={project.id}
              changedFiles={changedPaths}
              dirtyFiles={dirtyPaths}
              refreshToken={filesRefreshToken}
              initialExpanded={expandedDirs}
              onExpandedChange={handleExpandedChange}
              onSelectFile={(path) => {
                void openFile(path);
              }}
            />
          </div>
        )}
      </section>
    </div>
  );
}
