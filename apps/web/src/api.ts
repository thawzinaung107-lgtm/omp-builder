import type { ChatSession, Checkpoint, CheckpointDiffFile, CheckpointFileStat, CheckpointResult, GitHubImportResult, OmpEvent, Problem, Project, Provider, PublicUser, RepoState, SessionEvent, VersionPreview } from "@omp-builder/shared";

/** Error thrown by `request` — carries the HTTP status so callers can
 * distinguish e.g. a 409 edit conflict from other failures. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`);
  return data;
}

/** Milestone E (B7) — multipart upload: FormData sets its own
 * content-type (with boundary), so unlike `request` above no JSON
 * content-type header is forced. The session cookie still goes along
 * (credentials: "include"). */
async function uploadRequest<T>(path: string, method: "POST" | "PUT", file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(path, { method, credentials: "include", body: form });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`);
  return data;
}

export type FileTreeEntry = {
  path: string;
  name: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
  mtimeMs: number;
  children?: FileTreeEntry[];
};

export type FileContent = { path: string; content: string; size: number; mtime: string; mtimeMs: number };

export type MediaImage = { path: string; name: string; size: number; mimeType: string; mtime: string; mtimeMs: number };

export type ProjectRules = { content: string; exists: boolean; hasRootAgentsMd: boolean };

export type ProjectRulesSaved = { content: string; deleted: boolean; sessionsRestarted: number; hasRootAgentsMd: boolean };

export type PreviewState = {
  projectId: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  framework: "vite" | "static";
  status: "starting" | "running" | "stopped" | "crashed" | "error";
  lastError: string | null;
  updatedAt: string;
};

export const api = {
  authStatus: () => request<{ setupRequired: boolean; user: PublicUser | null }>("/api/auth/status"),
  setup: (email: string, password: string) => request<{ user: PublicUser }>("/api/auth/setup", { method: "POST", body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) => request<{ user: PublicUser }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  projects: () => request<{ projects: Project[] }>("/api/projects"),
  createProject: (name: string, prompt: string) => request<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify({ name, prompt }) }),
  // Milestone D (B5) — import a public GitHub repository as a project.
  importGitHubProject: (name: string, url: string) =>
    request<{ project: Project; import: GitHubImportResult }>("/api/projects/import", { method: "POST", body: JSON.stringify({ name, url }) }),
  providers: () => request<{ providers: Provider[] }>("/api/providers"),
  createProvider: (provider: Partial<Provider> & { apiKey?: string }) => request<{ provider: Provider }>("/api/providers", { method: "POST", body: JSON.stringify(provider) }),
  updateProvider: (id: string, provider: Partial<Provider> & { apiKey?: string }) => request<{ provider: Provider }>(`/api/providers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(provider) }),
  deleteProvider: (id: string) => request<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testProvider: (provider: Partial<Provider> & { apiKey?: string }) => request<{ ok: boolean; error?: string }>("/api/providers/test", { method: "POST", body: JSON.stringify(provider) }),
  projectSession: (projectId: string) => request<{ events: OmpEvent[] }>(`/api/projects/${encodeURIComponent(projectId)}/session`),
  // Milestone D (B2) — multiple chat sessions per project (shared
  // workspace, isolated conversations). Reorder persists the tab-strip
  // order server-side; drafts and the active chat live in A7 prefs.
  listChats: (projectId: string) =>
    request<{ chats: ChatSession[] }>(`/api/projects/${encodeURIComponent(projectId)}/chats`),
  createChat: (projectId: string, title?: string) =>
    request<{ chat: ChatSession }>(`/api/projects/${encodeURIComponent(projectId)}/chats`, {
      method: "POST",
      body: JSON.stringify({ ...(title ? { title } : {}) }),
    }),
  renameChat: (projectId: string, chatId: string, title: string) =>
    request<{ chat: ChatSession }>(`/api/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  reorderChats: (projectId: string, order: string[]) =>
    request<{ chats: ChatSession[] }>(`/api/projects/${encodeURIComponent(projectId)}/chats/reorder`, {
      method: "POST",
      body: JSON.stringify({ order }),
    }),
  deleteChat: (projectId: string, chatId: string) =>
    request<{ ok: true }>(`/api/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" }),
  listFiles: (projectId: string) => request<{ tree: FileTreeEntry[] }>(`/api/projects/${encodeURIComponent(projectId)}/files`),
  readFile: (projectId: string, path: string) =>
    request<FileContent>(`/api/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(path)}`),
  writeFile: (projectId: string, path: string, content: string, expectedMtime?: number) =>
    request<FileContent>(`/api/projects/${encodeURIComponent(projectId)}/files/content`, {
      method: "PUT",
      body: JSON.stringify({ path, content, ...(expectedMtime === undefined ? {} : { expectedMtime }) }),
    }),
  createEntry: (projectId: string, path: string, type: "file" | "dir") =>
    request<{ entry: FileTreeEntry }>(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: "POST",
      body: JSON.stringify({ path, type }),
    }),
  renameEntry: (projectId: string, from: string, to: string) =>
    request<{ from: string; to: string }>(`/api/projects/${encodeURIComponent(projectId)}/files/rename`, {
      method: "PATCH",
      body: JSON.stringify({ from, to }),
    }),
  deleteEntry: (projectId: string, path: string, recursive?: boolean) =>
    request<{ ok: true; path: string }>(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: "DELETE",
      body: JSON.stringify({ path, ...(recursive === undefined ? {} : { recursive }) }),
    }),
  // Milestone E (B7) — project media (images under workspace images/).
  // Thumbnails use mediaUrl: same-origin, session-cookie auth, no public URL.
  mediaUrl: (projectId: string, name: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(name)}`,
  listMedia: (projectId: string) =>
    request<{ images: MediaImage[] }>(`/api/projects/${encodeURIComponent(projectId)}/media`),
  uploadMedia: (projectId: string, file: File) =>
    uploadRequest<{ image: MediaImage }>(`/api/projects/${encodeURIComponent(projectId)}/media`, "POST", file),
  replaceMedia: (projectId: string, name: string, file: File) =>
    uploadRequest<{ image: MediaImage }>(
      `/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(name)}`,
      "PUT",
      file,
    ),
  // Phase 3D — managed previews (the gateway is the only way a preview is
  // viewed; there is no manual URL anymore).
  previewStatus: (projectId: string) =>
    request<{ preview: PreviewState | null }>(`/api/projects/${encodeURIComponent(projectId)}/preview/status`),
  previewStart: (projectId: string) =>
    request<{ preview: PreviewState }>(`/api/projects/${encodeURIComponent(projectId)}/preview/start`, { method: "POST" }),
  previewStop: (projectId: string) =>
    request<{ preview: PreviewState | null }>(`/api/projects/${encodeURIComponent(projectId)}/preview/stop`, { method: "POST" }),
  previewRestart: (projectId: string) =>
    request<{ preview: PreviewState }>(`/api/projects/${encodeURIComponent(projectId)}/preview/restart`, { method: "POST" }),
  // Milestone B (A5) — Rebuild: stop + clear staging + start, so a
  // startup build error surfaces in the Problems tab.
  previewRebuild: (projectId: string) =>
    request<{ preview: PreviewState }>(`/api/projects/${encodeURIComponent(projectId)}/preview/rebuild`, { method: "POST" }),
  // Milestone E (B3) — element picker mode (server-side per-project
  // flag; the gateway injects the picker script only while it is on).
  pickerMode: (projectId: string) =>
    request<{ enabled: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/preview/picker`),
  setPickerMode: (projectId: string, enabled: boolean) =>
    request<{ enabled: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/preview/picker`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  previewLogs: (projectId: string, tail = 200) =>
    request<{ running: boolean; logs: string }>(`/api/projects/${encodeURIComponent(projectId)}/preview/logs?tail=${tail}`),
  // Milestone A (A4) — structured problems parsed server-side from the
  // preview container logs (see apps/api/src/problems.ts).
  problems: (projectId: string) =>
    request<{ problems: Problem[]; updatedAt: string }>(`/api/projects/${encodeURIComponent(projectId)}/problems`),
  // Milestone D (B6) — per-project AI rules (stored as .omp/RULES.md).
  // Saving restarts the live OMP session(s); sessionsRestarted says how
  // many were restarted (0 when no session was running yet).
  getRules: (projectId: string) =>
    request<ProjectRules>(`/api/projects/${encodeURIComponent(projectId)}/rules`),
  saveRules: (projectId: string, content: string) =>
    request<ProjectRulesSaved>(`/api/projects/${encodeURIComponent(projectId)}/rules`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  // Milestone C (B1) — Git-backed version history (checkpoints). The
  // restore/undo calls refuse with 409 when the workspace has
  // uncommitted changes, unless discardUncommitted is explicitly true.
  versions: (projectId: string) =>
    request<{ status: RepoState; checkpoints: Checkpoint[] }>(`/api/projects/${encodeURIComponent(projectId)}/versions`),
  initVersions: (projectId: string) =>
    request<{ status: RepoState; init: string; baselineOid: string | null }>(`/api/projects/${encodeURIComponent(projectId)}/versions/init`, { method: "POST" }),
  saveCheckpoint: (projectId: string, message?: string, chatSessionId?: string) =>
    request<{ checkpoint: CheckpointResult }>(`/api/projects/${encodeURIComponent(projectId)}/versions/checkpoint`, {
      method: "POST",
      body: JSON.stringify({ ...(message ? { message } : {}), ...(chatSessionId ? { chatSessionId } : {}) }),
    }),
  versionDetail: (projectId: string, oid: string) =>
    request<{ checkpoint: Checkpoint; files: CheckpointFileStat[] }>(`/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(oid)}`),
  versionDiff: (projectId: string, oid: string, against?: string) =>
    request<{ fromOid: string | null; toOid: string; files: CheckpointDiffFile[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(oid)}/diff${against ? `?against=${encodeURIComponent(against)}` : ""}`,
    ),
  versionPreview: (projectId: string, oid: string) =>
    request<{ preview: VersionPreview }>(`/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(oid)}/preview`, { method: "POST" }),
  restoreVersion: (projectId: string, oid: string, discardUncommitted = false, chatSessionId?: string) =>
    request<{ restore: CheckpointResult & { restoredOid: string; alreadyAt: boolean; changedPaths: string[] } }>(
      `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(oid)}/restore`,
      { method: "POST", body: JSON.stringify({ discardUncommitted, ...(chatSessionId ? { chatSessionId } : {}) }) },
    ),
  undoVersion: (projectId: string, discardUncommitted = false, chatSessionId?: string) =>
    request<{ undo: CheckpointResult & { restoredOid: string; undoneOid: string; changedPaths: string[] } }>(
      `/api/projects/${encodeURIComponent(projectId)}/versions/undo`,
      { method: "POST", body: JSON.stringify({ discardUncommitted, ...(chatSessionId ? { chatSessionId } : {}) }) },
    ),
};
