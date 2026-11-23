import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUp, ChevronDown, Code2, ExternalLink, Folder, GitBranch, LayoutDashboard, MessageSquare, MoreHorizontal, Play, RefreshCw, RotateCcw, Settings2, SplitSquareHorizontal, Terminal, X } from "lucide-react";
import type { BrowserCommand, Project, Provider, SessionEvent } from "@omp-builder/shared";
import { api, ApiError, type PreviewState } from "../api";
import { Button, StatusChip, timeAgo } from "../ui";
import { FileExplorer } from "./FileExplorer";
import { diagnosticDraft } from "../diagnostic-draft";
import { Problems } from "./Problems";
import type { PreviewProblem } from "@omp-builder/shared";
import { MonacoEditor } from "./MonacoEditor";
import { languageForPath } from "../editor-languages";
import type { NavScreen } from "./Sidebar";
import { loadWorkspacePreferences, mobileTabs, saveWorkspacePreferences, type WorkspacePreferences, type WorkspaceTab } from "../workspace-preferences";

type ChatItem = { id: string; role: "user" | "assistant" | "tool" | "status"; text: string; eventType?: string };
type Step = { id: string; label: string; done: boolean; failed: boolean };
/** One open editor tab. `mtimeMs` is the last known on-disk mtime and is
 * sent back as expectedMtime on save, so concurrent edits conflict (409)
 * instead of silently overwriting. */
type OpenFile = { path: string; content: string; size: number; mtime: string; mtimeMs: number; dirty: boolean };

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

const tabLabels: { id: WorkspaceTab; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "code", label: "Code" },
  { id: "files", label: "Files" },
  { id: "problems", label: "Problems" },
  { id: "logs", label: "Logs" },
  { id: "git", label: "Git" },
];

export function Builder({ project, preferencesKey, onNavigate }: { project: Project; preferencesKey: string; onNavigate: (screen: NavScreen) => void }) {
  const [chat, setChat] = useState("");
  const [fixDraft, setFixDraft] = useState<string | null>(null);
  const draft = fixDraft ?? chat;
  const [editorTarget, setEditorTarget] = useState<PreviewProblem["location"]>();
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
  const [selectedModel, setSelectedModel] = useState("");
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting" | "offline">("connecting");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  // App keys this instance by admin and project so state cannot cross scopes.
  const [preferences, setPreferences] = useState(() => loadWorkspacePreferences(preferencesKey));
  const { tab, mobileTab, split, device } = preferences;
  const updatePreferences = useCallback((patch: Partial<WorkspacePreferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);
  const initialPreferences = useRef(preferences);
  useEffect(() => {
    if (preferences !== initialPreferences.current) saveWorkspacePreferences(preferencesKey, preferences);
  }, [preferencesKey, preferences]);
  const [notice, setNotice] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachNote, setAttachNote] = useState(false);
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
  const [frameKey, setFrameKey] = useState(0);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const retryRef = useRef<number | undefined>(undefined);
  const retryCount = useRef(0);
  const lastEventId = useRef<number | undefined>(undefined);
  const activeAssistantId = useRef<string | undefined>(undefined);
  const stopped = useRef(false);

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
    async (action: "start" | "stop" | "restart") => {
      setPreviewBusy(true);
      setPreviewError("");
      try {
        const result =
          action === "start" ? await api.previewStart(project.id) : action === "stop" ? await api.previewStop(project.id) : await api.previewRestart(project.id);
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

  // Phase 3B — editor actions.
  const openFile = useCallback(
    async (path: string, location?: PreviewProblem["location"]) => {
      setEditorTarget(location);
      setEditorError("");
      if (openFilesRef.current.some((f) => f.path === path)) {
        setActivePath(path);
        updatePreferences({ tab: "code", mobileTab: "code" });
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
        updatePreferences({ tab: "code", mobileTab: "code" });
      } catch (err) {
        // Binary files (415) and missing files land here.
        setEditorError(err instanceof Error ? err.message : "Could not open file");
        updatePreferences({ tab: "code", mobileTab: "code" });
      }
    },
    [project.id, updatePreferences],
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
    const next = openFilesRef.current.filter((f) => f.path !== path);
    setOpenFiles(next);
    if (activePathRef.current === path) setActivePath(next.length ? next[next.length - 1].path : null);
    setConflict((c) => (c?.path === path ? null : c));
  }, []);

  const discardAndClose = useCallback((path: string) => {
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

  const handleEvent = useCallback((event: SessionEvent) => {
    if (event.eventId !== undefined) lastEventId.current = Math.max(lastEventId.current ?? 0, event.eventId);
    // Cap the in-memory list: a long-running preview can emit hundreds of
    // preview_log lines; the DB already caps persisted logs at 200/project.
    setEvents((current) =>
      event.eventId !== undefined && current.some((e) => e.eventId === event.eventId) ? current : [...current, event].slice(-500),
    );
    const text = eventText(event);
    const payload = event.payload ?? {};
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
      return;
    }
    // Phase 3D — preview_log events need no special handling here; they
    // land in `events` and the Logs tab renders them as runtime logs.
    if (["session_settled", "prompt_aborted", "agent_error"].includes(event.type)) setWorking(false);
    if (event.type === "session_settled") setSettled(true);
    if (event.type === "agent_error") setError(text);
    if (event.type === "session_status" || event.type === "model_changed")
      setItems((current) => [...current, { id: `${event.type}-${event.eventId ?? Date.now()}`, role: "status", text }]);
  }, [handleExternalChanges, loadPreviewStatus]);

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
    api
      .projectSession(project.id)
      .then((result) => {
        if (!alive) return;
        result.events.forEach((event) => {
          const session: SessionEvent = { type: event.type, timestamp: event.createdAt, projectId: event.projectId, eventId: event.id, payload: event.payload };
          handleEvent(session);
        });
      })
      .catch(() => undefined);
    // Phase 3D — current preview state for the managed Preview tab.
    void loadPreviewStatus();
    return () => {
      alive = false;
    };
  }, [project.id, handleEvent, loadPreviewStatus]);

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

  const sendCommand = (command: BrowserCommand) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("Session is reconnecting; try again in a moment");
      return false;
    }
    socket.send(JSON.stringify(command));
    return true;
  };
  const sendPrompt = (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || !sendCommand({ type: "prompt", message })) return;
    setItems((current) => [...current, { id: `user-${Date.now()}`, role: "user", text: message }]);
    if (fixDraft !== null) setFixDraft(null);
    else setChat("");
    setWorking(true);
    setSettled(false);
    setError("");
    setAttachNote(false);
  };
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
    setFilesRefreshToken((t) => t + 1);
    setEvents([]);
    lastEventId.current = undefined;
    sendCommand({ type: "replay" });
  };

  const connectionLabel = connection === "connected" ? "Connected" : connection === "reconnecting" ? "Reconnecting…" : connection === "offline" ? "Offline" : "Connecting…";
  const selectedProvider = providers.find((p) => p.id === selectedModel);
  const doneSteps = steps.filter((s) => s.done).length;
  const progress = steps.length ? Math.round((doneSteps / steps.length) * 100) : 0;

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
      {fixDraft !== null && <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span>Review fix draft{chat ? " · Previous draft kept" : ""}</span>
        <button type="button" onClick={() => setFixDraft(null)} className="font-medium text-omp-brand">Cancel fix draft</button>
      </div>}
      <div className="rounded-omp border border-omp-border bg-white focus-within:border-omp-brand focus-within:ring-2 focus-within:ring-omp-brand/15">
        <textarea
          value={draft}
          onChange={(event) => (fixDraft === null ? setChat : setFixDraft)(event.target.value)}
          onKeyDown={(event) => {
            if (fixDraft === null && event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          data-omp-composer
          placeholder="Ask OMP to change anything..."
          rows={3}
          className="w-full resize-none bg-transparent px-3.5 py-3 text-sm text-omp-ink outline-none placeholder:text-omp-muted/70"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setAttachNote((v) => !v)} className="text-xs font-medium text-omp-muted hover:text-omp-ink">
              + Attach
            </button>
            <span className="text-xs text-omp-muted">Context: Project</span>
          </div>
          <div className="flex items-center gap-2">
            {working && (
              <Button variant="outline" className="!px-3 !py-2 !text-xs" onClick={() => { if (sendCommand({ type: "abort" })) setWorking(false); }}>
                <X size={13} /> Stop
              </Button>
            )}
            <Button type="submit" disabled={!draft.trim() || connection !== "connected"} className="!px-4 !py-2">
              Send <ArrowUp size={14} />
            </Button>
          </div>
        </div>
      </div>
      {attachNote && (
        <p className="mt-2 text-xs leading-5 text-omp-muted">File attachments aren't supported yet — describe the file in your message.</p>
      )}
      <p className="mt-2 px-1 text-[11px] text-omp-muted">Agent runs through your configured OMP provider.</p>
    </form>
  );

  // Phase 3D — managed preview. The iframe loads ONLY through the
  // authenticated gateway (never a container port, never a pasted URL), and
  // its sandbox has NO allow-same-origin: the generated page runs in an
  // opaque origin, so its JavaScript cannot read the admin session cookie
  // or call Builder APIs with it.
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
        <span className="min-w-0 flex-1 truncate rounded-omp border border-omp-border bg-omp-canvas px-3 py-1.5 font-mono text-xs text-omp-muted" title={gatewayUrl}>
          {gatewayUrl}
        </span>
        <select
          value={device}
          onChange={(event) => updatePreferences({ device: event.target.value as WorkspacePreferences["device"] })}
          className="shrink-0 rounded-omp border border-omp-border bg-white px-2 py-1.5 text-xs text-omp-ink outline-none"
          aria-label="Preview device"
        >
          <option value="desktop">Desktop</option>
          <option value="mobile">Mobile</option>
        </select>
        <button
          type="button"
          onClick={() => preview?.status === "running" && window.open(gatewayUrl, "_blank", "noopener")}
          disabled={preview?.status !== "running"}
          className="rounded-md p-1.5 text-omp-muted hover:bg-omp-canvas disabled:opacity-40"
          aria-label="Open preview in a new tab"
          title="Open preview in a new tab"
        >
          <ExternalLink size={14} />
        </button>
      </div>
      {/* Preview controls */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-omp-border bg-white px-3 py-2.5">
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${previewStatusTone}`}>{previewStatusLabel}</span>
        {preview && (
          <span className="text-xs text-omp-muted">
            {preview.framework === "vite" ? "Vite dev server" : "Static site"}
            {preview.status === "running" ? ` • container port ${preview.containerPort}` : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={previewBusy || preview?.status === "running" || preview?.status === "starting"} onClick={() => void previewAction("start")}>
            <Play size={13} /> Start
          </Button>
          <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={previewBusy || preview?.status !== "running"} onClick={() => void previewAction("restart")}>
            <RotateCcw size={13} /> Restart
          </Button>
          <Button variant="outline" className="!px-3 !py-1.5 !text-xs" disabled={previewBusy || (preview?.status !== "running" && preview?.status !== "starting")} onClick={() => void previewAction("stop")}>
            <X size={13} /> Stop
          </Button>
        </span>
      </div>
      {previewError && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#f6c6c6] bg-[#fdecec] px-4 py-2 text-xs text-[#a83232]">
          <span>{previewError} <button type="button" className="underline" onClick={() => updatePreferences({ tab: "problems", mobileTab: "problems" })}>View Problems</button></span>
          <button type="button" onClick={() => setPreviewError("")} aria-label="Dismiss" className="text-[#a83232] hover:text-omp-ink">
            <X size={14} />
          </button>
        </div>
      )}
      {/* Preview body */}
      <div className="flex min-h-0 flex-1 items-stretch justify-center overflow-y-auto bg-omp-canvas p-3 md:p-4">
        {preview?.status === "running" ? (
          <iframe
            key={`${gatewayUrl}-${frameKey}`}
            title={`${project.name} preview`}
            src={gatewayUrl}
            sandbox="allow-scripts allow-forms allow-popups"
            className={`min-h-[480px] w-full rounded-omp border border-omp-border bg-white shadow-sm ${device === "mobile" ? "max-w-[390px]" : ""}`}
          />
        ) : (
          <div className="grid w-full max-w-lg place-items-center self-center rounded-omp-lg border border-dashed border-omp-border bg-white px-6 py-12 text-center">
            <div>
              <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">
                <Play size={20} />
              </div>
              <h3 className="font-semibold text-omp-ink">{preview?.status === "starting" ? "Preview is starting…" : preview?.status === "crashed" || preview?.status === "error" ? "Preview crashed" : "Preview is stopped"}</h3>
              <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-omp-muted">
                {preview?.status === "starting"
                  ? "The preview container is starting. It appears here automatically once it is ready."
                  : preview?.status === "crashed" || preview?.status === "error"
                    ? (preview.lastError ?? "The preview container exited unexpectedly. Check the runtime logs, then restart it.")
                    : "Start the preview to run this project in an isolated container and view it here through the secure gateway."}
              </p>
              <Button variant="outline" className="mt-4" disabled={previewBusy || preview?.status === "starting"} onClick={() => void previewAction(preview?.status === "crashed" || preview?.status === "error" ? "restart" : "start")}>
                {previewBusy || preview?.status === "starting" ? "Starting…" : preview?.status === "crashed" || preview?.status === "error" ? "Restart preview" : "Start preview"}
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
        <button type="button" onClick={() => updatePreferences({ tab: "code", mobileTab: "code" })} className="ml-auto font-medium text-omp-brand hover:underline">
          Open in editor ↗
        </button>
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

  // Phase 3B — code editor panel (shared by the desktop Code tab and the
  // mobile Code tab). Ctrl/Cmd+S saves the active file; Ctrl/Cmd+F is
  // Monaco's built-in find.
  const codePanel = (
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
              updatePreferences({ tab: "files", mobileTab: "files" });
            }}
          >
            Browse files
          </Button>
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

      {/* Editor / empty state */}
      {activeFile ? (
        <MonacoEditor
          key={activeFile.path}
          value={activeFile.content}
          language={languageForPath(activeFile.path)}
          target={editorTarget?.path === activeFile.path ? editorTarget : undefined}
          onChange={(next) =>
            setOpenFiles((current) => current.map((f) => (f.path === activeFile.path ? { ...f, content: next, dirty: true } : f)))
          }
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
                updatePreferences({ tab: "files", mobileTab: "files" });
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

  const phaseNote = (icon: ReactNode, title: string, body: string) => (
    <div className="grid flex-1 place-items-center overflow-y-auto p-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">{icon}</div>
        <h3 className="font-semibold text-omp-ink">{title}</h3>
        <p className="mt-1.5 text-sm leading-6 text-omp-muted">{body}</p>
      </div>
    </div>
  );

  const problemsPanel = <Problems
    projectId={project.id}
    onOpen={(location) => void openFile(location.path, location)}
    onFix={(problem) => {
      setFixDraft((current) => current ?? diagnosticDraft(problem));
      updatePreferences({ mobileTab: "chat" });
      // Focus the visible composer after switching the mobile view.
      requestAnimationFrame(() => {
        [...document.querySelectorAll<HTMLTextAreaElement>("textarea[data-omp-composer]")]
          .find((input) => input.getClientRects().length > 0)?.focus();
      });
    }}
  />;

  const tabContent = useMemo(() => {
    if (tab === "preview") return previewPanel;
    if (tab === "problems") return problemsPanel;
    if (tab === "logs") return logsPanel;
    if (tab === "code") return codePanel;
    if (tab === "files")
      return (
        <FileExplorer
          projectId={project.id}
          changedFiles={changedPaths}
          refreshToken={filesRefreshToken}
          onSelectFile={(path) => {
            void openFile(path);
          }}
        />
      );
    return phaseNote(
      <GitBranch size={20} />,
      "Source control arrives in Phase 4",
      "GitHub clone, commit, push and branch history will live here, with confirmation for destructive actions.",
    );
  }, [tab, previewPanel, logsPanel, codePanel, problemsPanel, project.id, changedPaths, filesRefreshToken, openFile]);

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

      {/* Agent panel — desktop */}
      <section className="hidden w-[382px] shrink-0 flex-col border-r border-omp-border bg-white md:flex">
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
        {conversation}
        {composer}
      </section>

      {/* Main workspace — desktop */}
      <section className="hidden min-w-0 flex-1 flex-col bg-omp-canvas md:flex">
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
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-omp-border bg-white px-5 py-2.5">
          <div className="flex items-center gap-1" role="tablist" aria-label="Workspace tabs">
            {tabLabels.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => updatePreferences({ tab: item.id })}
                className={`rounded-omp px-3.5 py-2 text-sm transition ${tab === item.id ? "bg-omp-brandSubtle font-semibold text-omp-brand" : "text-omp-muted hover:bg-omp-canvas hover:text-omp-ink"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPreferences((current) => ({ ...current, split: !current.split }))}
              className={`flex items-center gap-1.5 rounded-omp px-2.5 py-1.5 text-xs font-medium ${split ? "bg-omp-brandSubtle text-omp-brand" : "text-omp-muted hover:bg-omp-canvas"}`}
              title="Split preview and logs"
              aria-pressed={split}
            >
              <SplitSquareHorizontal size={14} /> Split
            </button>
            <button
              type="button"
              onClick={() => {
                if (tab === "preview") setFrameKey((k) => k + 1);
                else if (tab === "logs") api.projectSession(project.id).then((result) => result.events.forEach((event) => handleEvent({ type: event.type, timestamp: event.createdAt, projectId: event.projectId, eventId: event.id, payload: event.payload })));
              }}
              className="flex items-center gap-1.5 rounded-omp px-2.5 py-1.5 text-xs font-medium text-omp-muted hover:bg-omp-canvas"
              title="Refresh"
            >
              <RefreshCw size={14} /> Refresh
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
          <div className="flex min-w-0 flex-1 flex-col">{tabContent}</div>
          {split && tab === "preview" && (
            <div className="hidden w-[380px] shrink-0 flex-col border-l border-omp-border bg-omp-canvas lg:flex">
              <div className="flex items-center gap-2 border-b border-omp-border bg-white px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-omp-muted">
                <Terminal size={14} /> Session logs
              </div>
              {logsPanel}
            </div>
          )}
        </div>
      </section>

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
          <div className="mt-3 flex flex-wrap items-center gap-1" role="tablist" aria-label="Builder tabs">
            {mobileTabs.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mobileTab === item}
                onClick={() => updatePreferences({ mobileTab: item })}
                className={`flex-1 rounded-omp px-2 py-2 text-[13px] capitalize transition ${mobileTab === item ? "bg-omp-brandSubtle font-semibold text-omp-brand" : "text-omp-muted"}`}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        {mobileTab === "chat" ? (
          <div className="flex min-h-0 flex-1 flex-col bg-white">
            <div className="flex items-center gap-2 border-b border-omp-border px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-omp-muted">
              <MessageSquare size={14} /> OMP chat {working && <span className="text-omp-brand">• Working…</span>}
            </div>
            {conversation}
            {composer}
          </div>
        ) : mobileTab === "preview" ? (
          <div className="flex min-h-0 flex-1 flex-col">{previewPanel}</div>
        ) : mobileTab === "problems" ? problemsPanel : mobileTab === "code" ? (
          <div className="flex min-h-0 flex-1 flex-col">{codePanel}</div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col bg-white">
            <FileExplorer
              projectId={project.id}
              changedFiles={changedPaths}
              refreshToken={filesRefreshToken}
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
