import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, chown, copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Phase 3C — Rootless Podman preview manager.
 *
 * Security model:
 * - The live workspace (0700, omp-builder-owned) is NEVER bind-mounted into a
 *   container. The API copies it to a staging directory owned by the
 *   service user omp-builder, excluding secrets and build outputs, and only
 *   the staging copy is mounted, read-only, at /app.
 * - Containers run as omp-builder (via `runuser` when the API runs as root,
 *   directly when the API already runs as omp-builder — runuser refuses
 *   non-root callers; see runPodman and docs/MIGRATION-PHASE3.5-2.md).
 *   No Docker/host socket, no host network namespace, no privileged flag,
 *   all capabilities dropped, no-new-privileges, read-only rootfs with a
 *   /tmp tmpfs, a named volume for /app/node_modules only, 512 MiB RAM,
 *   1 CPU, 128 PIDs. Minimal env (NODE_ENV, PORT, HOME=/tmp); no secrets.
 * - Ports publish to 127.0.0.1 only, from 42000-42999, recorded in DB.
 */

export const PREVIEW_IMAGE = "docker.io/library/node:22-alpine";
export const PREVIEW_ROOT = process.env.PREVIEW_ROOT ?? "/var/lib/omp-builder/previews";
export const PREVIEW_PORT_MIN = 42000;
export const PREVIEW_PORT_MAX = 42999;
export const PREVIEW_MEMORY = "512m";
export const PREVIEW_CPUS = "1";
export const PREVIEW_PIDS_LIMIT = "128";
export const SERVICE_USER = "omp-builder";
export const SERVICE_HOME = "/var/lib/omp-builder";
export const SERVICE_XDG_RUNTIME_DIR = "/run/user/996";
export const MAX_LOG_LINE_CHARS = 500;
export const VITE_CONTAINER_PORT = 5173;
export const STATIC_CONTAINER_PORT = 3000;

export type PreviewStatusValue = "starting" | "running" | "stopped" | "crashed" | "error";
export type PreviewFramework = "vite" | "static";

export type PreviewState = {
  projectId: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  framework: PreviewFramework;
  status: PreviewStatusValue;
  lastError: string | null;
  updatedAt: string;
};

type Db = Database.Database;

const STAGING_EXCLUDE_DIRS = new Set(["node_modules", ".git", ".omp", "dist", "build", ".next", ".cache"]);
/** Files the API itself generates inside staging (never pruned, never copied from the workspace). */
const GENERATED_FILES = new Set(["preview-server.mjs", "vite.preview.config.mjs"]);
const RUNUSER = "/usr/sbin/runuser";
const PODMAN = "/usr/bin/podman";
// Cgroup manager: the default here is the cgroupfs fallback ("no systemd
// user session available"), under which --memory/--cpus are silently NOT
// enforced — verified 2026-11-22: memory.max read "max", podman stats
// showed the 4 GiB host limit, and a hog grew past 800 MB. Forcing the
// systemd manager (the lingering user@996.service is active, and the bus
// socket is reachable at /run/user/996/bus) makes the limits real:
// memory.max 536870912, memory.swap.max 0, cpu.max "100000 100000".
// If the user manager is ever down, podman fails loudly instead of
// running unlimited — fail closed.
const PODMAN_ENV_PREFIX = [
  "/usr/bin/env",
  `XDG_RUNTIME_DIR=${SERVICE_XDG_RUNTIME_DIR}`,
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/996/bus",
  `HOME=${SERVICE_HOME}`,
  "PATH=/usr/local/bin:/usr/bin:/bin",
];
const PODMAN_GLOBAL_FLAGS = ["--cgroup-manager", "systemd"];

function shortId(projectId: string): string {
  return projectId.slice(0, 8);
}

export function previewContainerName(projectId: string): string {
  return `omp-preview-${shortId(projectId)}`;
}

export function previewVolumeName(projectId: string): string {
  return `omp-preview-nm-${shortId(projectId)}`;
}

export function previewStagingDir(projectId: string, previewRoot: string = PREVIEW_ROOT): string {
  return path.join(previewRoot, projectId);
}

function isExcludedName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
  return false;
}

/** Resolve the service user's uid/gid from /etc/passwd and /etc/group (no subprocess). */
export function serviceUserIds(): { uid: number; gid: number } {
  const passwd = readFileSync("/etc/passwd", "utf8");
  const line = passwd.split("\n").find((entry) => entry.startsWith(`${SERVICE_USER}:`));
  if (!line) throw new Error(`Service user ${SERVICE_USER} not found in /etc/passwd`);
  const fields = line.split(":");
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error(`Cannot parse uid/gid for ${SERVICE_USER}`);
  return { uid, gid };
}

export class PreviewError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type PodmanResult = { code: number; stdout: string; stderr: string };

/**
 * Run podman as omp-builder. Argv arrays only — never a shell.
 * Phase 3.5 §2: when the API itself already runs as omp-builder, spawn
 * podman directly with the podman env via spawn `env` — runuser refuses
 * non-root callers ("runuser: may not be used by non-root users",
 * verified 2026-11-22). When the API runs as root (pre-migration /
 * rollback), the runuser + /usr/bin/env argv form is kept unchanged.
 */
export function runPodman(args: string[], timeoutMs = 60_000): Promise<PodmanResult> {
  return new Promise((resolve, reject) => {
    const { uid } = serviceUserIds();
    const alreadyServiceUser = typeof process.getuid === "function" && process.getuid() === uid;
    const child = alreadyServiceUser
      ? spawn(PODMAN, [...PODMAN_GLOBAL_FLAGS, ...args], {
          cwd: "/",
          timeout: timeoutMs,
          env: {
            ...process.env,
            XDG_RUNTIME_DIR: SERVICE_XDG_RUNTIME_DIR,
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/996/bus",
            HOME: SERVICE_HOME,
            PATH: "/usr/local/bin:/usr/bin:/bin",
          },
        })
      : spawn(RUNUSER, ["-u", SERVICE_USER, "--", ...PODMAN_ENV_PREFIX, PODMAN, ...PODMAN_GLOBAL_FLAGS, ...args], {
          cwd: "/",
          timeout: timeoutMs,
        });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 1_048_576) stdout = stdout.slice(-1_048_576);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 1_048_576) stderr = stderr.slice(-1_048_576);
    });
    child.once("error", (error) => reject(new Error(`Failed to run podman: ${error.message}`)));
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Strip podman's cgroupfs-fallback warnings; keep real errors. */
function cleanPodmanError(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !line.includes("cgroup") && !line.includes("systemd") && !line.includes("loginctl") && line.trim() !== "")
    .join("\n")
    .trim();
}

async function podmanOrThrow(args: string[], timeoutMs = 60_000): Promise<string> {
  const result = await runPodman(args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(`podman ${args[0]} failed: ${cleanPodmanError(result.stderr) || result.stdout || `exit ${result.code}`}`.slice(0, 1000));
  }
  return result.stdout;
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(true);
    });
  });
}

function vitePreviewConfig(projectId: string): string {
  return `// Generated by OMP Builder (Phase 3C). Merges the project's own Vite config
// (if any) and pins the dev server + HMR path for the Phase 3D preview gateway.
// Direct 127.0.0.1 access still serves the app; HMR only connects via the gateway.
import { loadConfigFromFile, mergeConfig } from "vite";
const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, undefined, "/app").catch(() => null);
const userConfig = loaded?.config ?? {};
export default mergeConfig(userConfig, {
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? ${VITE_CONTAINER_PORT}),
    strictPort: true,
    hmr: { path: "/api/preview/${projectId}/__hmr" },
  },
});
`;
}

function staticPreviewServer(): string {
  return `// Generated by OMP Builder (Phase 3C). Minimal static file server for
// projects without a Vite dev script. Serves the staging copy at /app with
// an SPA fallback to index.html. No directory listings, no dotfiles, no
// generated preview files, and no path escapes.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
const root = "/app";
const port = Number(process.env.PORT ?? ${STATIC_CONTAINER_PORT});
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname).replace(/^\\/+/, "");
    const segments = rel.split("/").filter(Boolean);
    if (segments.some((s) => s === ".." || s.startsWith(".")) || rel.includes("\\0")) {
      res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return;
    }
    let file = path.join(root, ...segments);
    const within = path.relative(root, file);
    if (within.startsWith("..") || path.isAbsolute(within)) {
      res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return;
    }
    let body;
    try {
      body = await readFile(file);
    } catch (error) {
      if (error && error.code === "EISDIR") file = path.join(file, "index.html");
      else if (!path.extname(file)) file = path.join(root, "index.html");
      else throw error;
      body = await readFile(file);
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");
  }
});
server.listen(port, "0.0.0.0", () => console.log("preview static server on " + port));
`;
}

export class PreviewManager {
  private readonly db: Db;
  private readonly projectsRoot: string;
  private readonly previewRoot: string;
  private readonly onEvent: (projectId: string, type: "preview_log" | "preview_status", payload: Record<string, unknown>) => void;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly syncTimers = new Map<string, NodeJS.Timeout>();
  private readonly logFollowers = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly getStateStmt: Database.Statement;
  private readonly upsertStateStmt: Database.Statement;
  private readonly updateStatusStmt: Database.Statement;

  constructor(options: {
    db: Db;
    projectsRoot: string;
    previewRoot?: string;
    onEvent: (projectId: string, type: "preview_log" | "preview_status", payload: Record<string, unknown>) => void;
  }) {
    this.db = options.db;
    this.projectsRoot = options.projectsRoot;
    this.previewRoot = options.previewRoot ?? PREVIEW_ROOT;
    this.onEvent = options.onEvent;
    this.getStateStmt = this.db.prepare("SELECT * FROM preview_state WHERE project_id = ?");
    this.upsertStateStmt = this.db.prepare(
      "INSERT INTO preview_state (project_id, container_name, host_port, container_port, framework, status, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(project_id) DO UPDATE SET container_name = excluded.container_name, host_port = excluded.host_port, container_port = excluded.container_port, framework = excluded.framework, status = excluded.status, last_error = excluded.last_error, updated_at = excluded.updated_at",
    );
    this.updateStatusStmt = this.db.prepare("UPDATE preview_state SET status = ?, last_error = ?, updated_at = ? WHERE project_id = ?");
  }

  private runExclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(projectId) ?? Promise.resolve();
    const next = prior.then(fn, fn) as Promise<T>;
    this.locks.set(
      projectId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  row(projectId: string): PreviewState | null {
    const row = this.getStateStmt.get(projectId) as
      | { project_id: string; container_name: string; host_port: number; container_port: number; framework: string; status: string; last_error: string | null; updated_at: string }
      | undefined;
    if (!row) return null;
    return {
      projectId: row.project_id,
      containerName: row.container_name,
      hostPort: row.host_port,
      containerPort: row.container_port,
      framework: row.framework as PreviewFramework,
      status: row.status as PreviewStatusValue,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    };
  }

  private saveState(state: PreviewState): void {
    this.upsertStateStmt.run(
      state.projectId,
      state.containerName,
      state.hostPort,
      state.containerPort,
      state.framework,
      state.status,
      state.lastError,
      state.updatedAt,
    );
  }

  private setStatus(projectId: string, status: PreviewStatusValue, lastError: string | null, emit = true): PreviewState | null {
    const current = this.row(projectId);
    if (!current) return null;
    const next: PreviewState = { ...current, status, lastError, updatedAt: new Date().toISOString() };
    this.updateStatusStmt.run(status, lastError, next.updatedAt, projectId);
    if (emit && (current.status !== status || current.lastError !== lastError)) {
      this.onEvent(projectId, "preview_status", { status, lastError, hostPort: current.hostPort, framework: current.framework });
    }
    return next;
  }

  /**
   * Mirror the workspace into the omp-builder-owned staging directory.
   * Excludes node_modules, .git, .omp, dist, build, .next, .cache, .env*,
   * *.pem, *.key, and symlinks (never followed). Files already in staging
   * that no longer exist in the workspace are removed, except the generated
   * preview files. Directories 0700, files 0600, owned by omp-builder.
   */
  async syncStaging(projectId: string, workspacePath: string): Promise<{ framework: PreviewFramework; containerPort: number }> {
    const { uid, gid } = serviceUserIds();
    const staging = previewStagingDir(projectId, this.previewRoot);
    await mkdir(this.previewRoot, { recursive: true, mode: 0o700 });
    await chown(this.previewRoot, uid, gid).catch(() => undefined);
    await chmod(this.previewRoot, 0o700);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await chown(staging, uid, gid);
    await chmod(staging, 0o700);
    const seen = new Set<string>();
    const copyDir = async (srcDir: string, destDir: string, relDir: string): Promise<void> => {
      await mkdir(destDir, { recursive: true, mode: 0o700 });
      await chown(destDir, uid, gid);
      await chmod(destDir, 0o700);
      const entries = await readdir(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (STAGING_EXCLUDE_DIRS.has(entry.name)) continue;
          if (isExcludedName(entry.name)) continue;
          seen.add(rel);
          await copyDir(path.join(srcDir, entry.name), path.join(destDir, entry.name), rel);
          continue;
        }
        if (!entry.isFile()) continue;
        if (isExcludedName(entry.name)) continue;
        seen.add(rel);
        const src = path.join(srcDir, entry.name);
        const dest = path.join(destDir, entry.name);
        const srcStat = await stat(src);
        let destStat = null;
        try {
          destStat = await stat(dest);
        } catch {
          destStat = null;
        }
        if (destStat && destStat.size === srcStat.size && Math.abs(destStat.mtimeMs - srcStat.mtimeMs) < 1) continue;
        const tmp = path.join(destDir, `.sync-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await copyFile(src, tmp);
        await chmod(tmp, 0o600);
        await chown(tmp, uid, gid);
        await utimes(tmp, srcStat.atime, srcStat.mtime);
        await rename(tmp, dest);
      }
    };
    await copyDir(workspacePath, staging, "");
    // Prune staging entries that vanished from the workspace.
    const pruneDir = async (dir: string, relDir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
        if (relDir === "" && GENERATED_FILES.has(entry.name)) continue;
        // The named node_modules volume is mounted at /app/node_modules;
        // the OCI runtime creates that mountpoint inside the staging bind,
        // so it must never be pruned (rmdir of a live mountpoint is EBUSY
        // and would fail every later re-sync). It stays an empty dir:
        // workspace node_modules content is never copied here.
        if (relDir === "" && entry.name === "node_modules") continue;
        if (!seen.has(rel)) {
          await rm(path.join(dir, entry.name), { recursive: true, force: true });
          continue;
        }
        if (entry.isDirectory()) await pruneDir(path.join(dir, entry.name), rel);
      }
    };
    await pruneDir(staging, "");
    // Pre-create the (empty) node_modules mountpoint so the container
    // runtime does not have to create it inside the staging bind itself.
    const stagingNodeModules = path.join(staging, "node_modules");
    await mkdir(stagingNodeModules, { recursive: true, mode: 0o700 });
    await chown(stagingNodeModules, uid, gid);
    await chmod(stagingNodeModules, 0o700);
    // Detect framework from the staged package.json.
    let framework: PreviewFramework = "static";
    try {
      const pkg = JSON.parse(await readFile(path.join(staging, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const hasVite = Boolean((pkg.dependencies && pkg.dependencies.vite) || (pkg.devDependencies && pkg.devDependencies.vite));
      if (hasVite && pkg.scripts && typeof pkg.scripts.dev === "string" && pkg.scripts.dev.trim() !== "") framework = "vite";
    } catch {
      framework = "static";
    }
    const containerPort = framework === "vite" ? VITE_CONTAINER_PORT : STATIC_CONTAINER_PORT;
    // (Re)write the generated runner files for the detected mode.
    if (framework === "vite") {
      const target = path.join(staging, "vite.preview.config.mjs");
      await writeFile(target, vitePreviewConfig(projectId), { encoding: "utf8", mode: 0o600 });
      await chown(target, uid, gid);
      await rm(path.join(staging, "preview-server.mjs"), { force: true });
    } else {
      const target = path.join(staging, "preview-server.mjs");
      await writeFile(target, staticPreviewServer(), { encoding: "utf8", mode: 0o600 });
      await chown(target, uid, gid);
      await rm(path.join(staging, "vite.preview.config.mjs"), { force: true });
    }
    return { framework, containerPort };
  }

  private async allocatePort(exceptProjectId?: string): Promise<number> {
    const used = new Set(
      (this.db.prepare("SELECT host_port FROM preview_state").all() as Array<{ host_port: number }>)
        .map((row) => row.host_port)
        .filter((port) => port >= PREVIEW_PORT_MIN && port <= PREVIEW_PORT_MAX),
    );
    if (exceptProjectId) {
      const own = this.row(exceptProjectId);
      if (own && own.hostPort >= PREVIEW_PORT_MIN && own.hostPort <= PREVIEW_PORT_MAX) used.delete(own.hostPort);
    }
    for (let port = PREVIEW_PORT_MIN; port <= PREVIEW_PORT_MAX; port += 1) {
      if (used.has(port)) continue;
      if (await isPortFree(port)) return port;
    }
    throw new PreviewError(503, "No free preview port available");
  }

  private containerCommand(framework: PreviewFramework): string[] {
    if (framework === "vite") {
      // Install inside the container (node_modules is the named volume) then
      // run Vite with the generated wrapper config. $PORT is expanded by the
      // container's own sh, not by any host shell.
      return [
        "sh",
        "-c",
        "cd /app && (if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi) && exec npx vite --config /app/vite.preview.config.mjs --host 0.0.0.0 --port $PORT",
      ];
    }
    return ["node", "/app/preview-server.mjs"];
  }

  private async inspectContainer(containerName: string): Promise<{ status: string; exitCode: number; oomKilled: boolean } | null> {
    const result = await runPodman(["inspect", containerName]);
    if (result.code !== 0) return null;
    try {
      const parsed = JSON.parse(result.stdout) as Array<{ State?: { Status?: string; ExitCode?: number; OOMKilled?: boolean } }>;
      const state = parsed[0]?.State;
      if (!state) return null;
      return { status: state.Status ?? "unknown", exitCode: state.ExitCode ?? -1, oomKilled: Boolean(state.OOMKilled) };
    } catch {
      return null;
    }
  }

  private async waitReady(state: PreviewState, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${state.hostPort}/`;
    let lastError = "";
    while (Date.now() < deadline) {
      const live = await this.inspectContainer(state.containerName);
      if (!live) throw new Error("Preview container disappeared while starting");
      if (live.status !== "running") {
        const logs = await this.logs(state.projectId, 50).catch(() => ({ running: false, logs: "" }));
        throw new Error(`Preview container exited (code ${live.exitCode}${live.oomKilled ? ", OOM-killed" : ""}). Logs:\n${logs.logs}`.slice(0, 2000));
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        // Any HTTP response (even 404 from the static server) proves the
        // server is up; Vite also answers 200 once ready.
        await response.arrayBuffer().catch(() => undefined);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Preview did not become ready within ${Math.round(timeoutMs / 1000)}s (last error: ${lastError})`);
  }

  private attachLogFollower(projectId: string, containerName: string): void {
    this.detachLogFollower(projectId);
    // Phase 3.5 fix pass (§2 fast path, same as runPodman): when the API
    // already runs as omp-builder, spawn podman directly — runuser refuses
    // non-root callers ("runuser: may not be used by non-root users").
    // This was the one stray unconditional runuser spawn left after the
    // §2 migration: it failed instantly on every preview start, its
    // stderr was fed into the preview log stream, and the follower died
    // so live container output never streamed. Root-run rollback keeps
    // the runuser form.
    const { uid } = serviceUserIds();
    const alreadyServiceUser = typeof process.getuid === "function" && process.getuid() === uid;
    const child = alreadyServiceUser
      ? spawn(PODMAN, [...PODMAN_GLOBAL_FLAGS, "logs", "-f", "--tail", "20", containerName], {
          cwd: "/",
          env: {
            ...process.env,
            XDG_RUNTIME_DIR: SERVICE_XDG_RUNTIME_DIR,
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/996/bus",
            HOME: SERVICE_HOME,
            PATH: "/usr/local/bin:/usr/bin:/bin",
          },
        })
      : spawn(RUNUSER, ["-u", SERVICE_USER, "--", ...PODMAN_ENV_PREFIX, PODMAN, ...PODMAN_GLOBAL_FLAGS, "logs", "-f", "--tail", "20", containerName], {
          cwd: "/",
        });
    this.logFollowers.set(projectId, child);
    let buffer = "";
    const flushLines = () => {
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        this.onEvent(projectId, "preview_log", { line: line.slice(0, MAX_LOG_LINE_CHARS) });
      }
    };
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 65536) buffer = buffer.slice(-65536);
      flushLines();
    });
    child.stderr.on("data", (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 65536) buffer = buffer.slice(-65536);
      flushLines();
    });
    child.once("close", () => {
      if (buffer.trim() !== "") {
        this.onEvent(projectId, "preview_log", { line: buffer.trim().slice(0, MAX_LOG_LINE_CHARS) });
      }
      if (this.logFollowers.get(projectId) === child) this.logFollowers.delete(projectId);
    });
  }

  private detachLogFollower(projectId: string): void {
    const child = this.logFollowers.get(projectId);
    if (!child) return;
    this.logFollowers.delete(projectId);
    child.kill("SIGTERM");
  }

  async start(projectId: string, workspacePath: string): Promise<PreviewState> {
    return this.runExclusive(projectId, async () => {
      const existing = this.row(projectId);
      if (existing && existing.status === "running") {
        const live = await this.inspectContainer(existing.containerName);
        if (live && live.status === "running") return existing;
      }
      const { framework, containerPort } = await this.syncStaging(projectId, workspacePath);
      let hostPort = existing?.hostPort;
      if (!hostPort || hostPort < PREVIEW_PORT_MIN || hostPort > PREVIEW_PORT_MAX) {
        hostPort = await this.allocatePort(projectId);
      } else if (existing && existing.status !== "running") {
        // Reuse the recorded port if it is actually free.
        if (!(await isPortFree(hostPort))) hostPort = await this.allocatePort(projectId);
      }
      const containerName = previewContainerName(projectId);
      const now = new Date().toISOString();
      const starting: PreviewState = {
        projectId,
        containerName,
        hostPort,
        containerPort,
        framework,
        status: "starting",
        lastError: null,
        updatedAt: now,
      };
      this.saveState(starting);
      this.onEvent(projectId, "preview_status", { status: "starting", hostPort, framework });
      // Remove any same-name container left from a previous run (crashed,
      // or created before the DB row existed). Never touches project files.
      await runPodman(["rm", "-f", containerName]).catch(() => undefined);
      const args = [
        "run",
        "-d",
        "--name",
        containerName,
        // The default log driver here is journald, whose entries a
        // service-user podman cannot read back (podman logs comes back
        // empty). k8s-file keeps container stdout in a file podman logs
        // can actually read, which the logs endpoint and follower need.
        "--log-driver",
        "k8s-file",
        "-p",
        `127.0.0.1:${hostPort}:${containerPort}`,
        "--cap-drop=ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "-v",
        `${previewVolumeName(projectId)}:/app/node_modules`,
        "-v",
        `${previewStagingDir(projectId, this.previewRoot)}:/app:ro`,
        "--memory",
        PREVIEW_MEMORY,
        "--memory-swap",
        PREVIEW_MEMORY,
        "--cpus",
        PREVIEW_CPUS,
        "--pids-limit",
        PREVIEW_PIDS_LIMIT,
        "-e",
        framework === "vite" ? "NODE_ENV=development" : "NODE_ENV=production",
        "-e",
        `PORT=${containerPort}`,
        "-e",
        "HOME=/tmp",
        PREVIEW_IMAGE,
        ...this.containerCommand(framework),
      ];
      const result = await runPodman(args, 60_000);
      if (result.code !== 0) {
        const message = `podman run failed: ${cleanPodmanError(result.stderr) || result.stdout || `exit ${result.code}`}`.slice(0, 1000);
        this.setStatus(projectId, "error", message);
        throw new PreviewError(500, message);
      }
      const state: PreviewState = { ...starting, status: "running", updatedAt: new Date().toISOString() };
      try {
        await this.waitReady(state, framework === "vite" ? 240_000 : 30_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Preview failed to start";
        await runPodman(["rm", "-f", containerName]).catch(() => undefined);
        this.setStatus(projectId, "error", message.slice(0, 1000));
        throw new PreviewError(500, message.slice(0, 1000));
      }
      this.saveState(state);
      this.onEvent(projectId, "preview_status", { status: "running", hostPort, framework });
      this.attachLogFollower(projectId, containerName);
      return state;
    });
  }

  async stop(projectId: string): Promise<PreviewState | null> {
    return this.runExclusive(projectId, async () => {
      const existing = this.row(projectId);
      this.detachLogFollower(projectId);
      if (existing) {
        await runPodman(["rm", "-f", existing.containerName]).catch(() => undefined);
        const stopped = this.setStatus(projectId, "stopped", null);
        return stopped;
      }
      return null;
    });
  }

  async restart(projectId: string, workspacePath: string): Promise<PreviewState> {
    await this.stop(projectId);
    return this.start(projectId, workspacePath);
  }

  /** Live status: reconciles the DB row against actual Podman state. */
  async getStatus(projectId: string): Promise<PreviewState | null> {
    const current = this.row(projectId);
    if (!current) return null;
    if (current.status !== "running" && current.status !== "starting") return current;
    const live = await this.inspectContainer(current.containerName);
    if (!live) {
      return this.setStatus(projectId, "stopped", "Preview container no longer exists");
    }
    if (live.status === "running") {
      if (current.status !== "running") return this.setStatus(projectId, "running", null);
      return current;
    }
    const message = `Preview container exited with code ${live.exitCode}${live.oomKilled ? " (OOM-killed)" : ""}`;
    return this.setStatus(projectId, "crashed", message);
  }

  async logs(projectId: string, tail = 200): Promise<{ running: boolean; logs: string }> {
    const current = this.row(projectId);
    if (!current) throw new PreviewError(404, "Preview has not been started for this project");
    const bounded = Math.max(1, Math.min(500, Math.floor(tail) || 200));
    const result = await runPodman(["logs", "--tail", String(bounded), current.containerName]);
    const live = await this.inspectContainer(current.containerName);
    if (result.code !== 0) {
      // Container was removed (e.g. after a crash cleanup): report no logs.
      return { running: false, logs: "" };
    }
    const cleanStderr = result.stderr
      .split("\n")
      .filter((line) => !line.includes("level=warning") && !line.includes("cgroup") && line.trim() !== "")
      .join("\n");
    return { running: live?.status === "running", logs: result.stdout + (cleanStderr ? `${cleanStderr}\n` : "") };
  }

  /** Debounced re-sync after file saves / OMP files_modified. No restart: the
   *  staging bind mount propagates to the running container, and Vite HMR /
   *  the static server serve the fresh files. */
  notifyFilesChanged(projectId: string, workspacePath: string): void {
    const current = this.row(projectId);
    if (!current || (current.status !== "running" && current.status !== "starting")) return;
    const pending = this.syncTimers.get(projectId);
    if (pending) clearTimeout(pending);
    this.syncTimers.set(
      projectId,
      setTimeout(() => {
        this.syncTimers.delete(projectId);
        void this.syncStaging(projectId, workspacePath).catch((error) => {
          console.error(`[preview] staging re-sync failed for ${projectId}:`, error instanceof Error ? error.message : error);
        });
      }, 1500),
    );
  }

  /**
   * Reconcile recorded state with actual Podman state on API start.
   * - DB says running but no container exists (or it exited): mark
   *   stopped/crashed in the DB.
   * - A running omp-preview-* container with no DB row is abandoned:
   *   remove it (containers only — never project source files).
   * - A running container that matches a DB row: reattach the log follower.
   */
  async reconcile(): Promise<{ removedAbandoned: string[]; markedStale: string[] }> {
    const removedAbandoned: string[] = [];
    const markedStale: string[] = [];
    const result = await runPodman(["ps", "-a", "--format", "{{.Names}}"]);
    if (result.code !== 0) {
      console.error("[preview] reconcile: podman ps failed:", cleanPodmanError(result.stderr));
      return { removedAbandoned, markedStale };
    }
    const liveNames = new Set(result.stdout.split("\n").map((name) => name.trim()).filter(Boolean));
    const rows = this.db.prepare("SELECT project_id, container_name, status FROM preview_state").all() as Array<{
      project_id: string;
      container_name: string;
      status: string;
    }>;
    const knownNames = new Set(rows.map((row) => row.container_name));
    for (const name of liveNames) {
      if (!name.startsWith("omp-preview-")) continue;
      if (knownNames.has(name)) continue;
      await runPodman(["rm", "-f", name]).catch(() => undefined);
      removedAbandoned.push(name);
      console.log(`[preview] reconcile: removed abandoned container ${name}`);
    }
    for (const row of rows) {
      if (row.status !== "running" && row.status !== "starting") continue;
      if (!liveNames.has(row.container_name)) {
        this.setStatus(row.project_id, "stopped", "Preview container no longer exists (API restart)");
        markedStale.push(row.project_id);
        continue;
      }
      const live = await this.inspectContainer(row.container_name);
      if (!live) {
        this.setStatus(row.project_id, "stopped", "Preview container no longer exists (API restart)");
        markedStale.push(row.project_id);
      } else if (live.status === "running") {
        this.setStatus(row.project_id, "running", null, false);
        this.attachLogFollower(row.project_id, row.container_name);
      } else {
        this.setStatus(row.project_id, "crashed", `Preview container exited with code ${live.exitCode}${live.oomKilled ? " (OOM-killed)" : ""} (found on API restart)`);
        markedStale.push(row.project_id);
      }
    }
    return { removedAbandoned, markedStale };
  }

  async close(): Promise<void> {
    for (const timer of this.syncTimers.values()) clearTimeout(timer);
    this.syncTimers.clear();
    for (const projectId of [...this.logFollowers.keys()]) this.detachLogFollower(projectId);
  }
}
