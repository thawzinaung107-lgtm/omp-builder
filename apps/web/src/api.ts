import type { OmpEvent, Project, Provider, PublicUser, SessionEvent } from "@omp-builder/shared";

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
  providers: () => request<{ providers: Provider[] }>("/api/providers"),
  createProvider: (provider: Partial<Provider> & { apiKey?: string }) => request<{ provider: Provider }>("/api/providers", { method: "POST", body: JSON.stringify(provider) }),
  updateProvider: (id: string, provider: Partial<Provider> & { apiKey?: string }) => request<{ provider: Provider }>(`/api/providers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(provider) }),
  deleteProvider: (id: string) => request<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testProvider: (provider: Partial<Provider> & { apiKey?: string }) => request<{ ok: boolean; error?: string }>("/api/providers/test", { method: "POST", body: JSON.stringify(provider) }),
  projectSession: (projectId: string) => request<{ events: OmpEvent[] }>(`/api/projects/${encodeURIComponent(projectId)}/session`),
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
  previewLogs: (projectId: string, tail = 200) =>
    request<{ running: boolean; logs: string }>(`/api/projects/${encodeURIComponent(projectId)}/preview/logs?tail=${tail}`),
};
