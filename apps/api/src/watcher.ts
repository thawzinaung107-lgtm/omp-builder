import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Phase 3D — per-project workspace watcher.
 *
 * Watches ONLY the workspace directory of a project that is currently open
 * in the Builder (a WebSocket client is connected for it). Never the whole
 * VPS, never another project's workspace. Watching stops when the last
 * client for the project disconnects.
 *
 * - One node:fs watch per directory, built recursively (fs.watch's
 *   `recursive` option is macOS/Windows-only, so directories are walked
 *   explicitly). Ignored directories (node_modules, .git, .omp, dist,
 *   build, .next, .cache) are never watched, and secret file names
 *   (.env*, *.pem, *.key) never produce events.
 * - Events are debounced (750 ms after the last change) and delivered as
 *   one `files_modified` payload with the deduplicated relative paths, so a
 *   save burst or an agent writing several files becomes a single refresh.
 * - Depth is capped at 12, matching the file API's tree cap.
 */

const IGNORED_DIRS = new Set(["node_modules", ".git", ".omp", "dist", "build", ".next", ".cache"]);
const MAX_DEPTH = 12;
/** Debounce window after the last fs event before emitting. */
export const WATCH_DEBOUNCE_MS = 750;

function isIgnoredFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
  return false;
}

type WatchedProject = {
  root: string;
  watchers: Map<string, FSWatcher>;
  timer: NodeJS.Timeout | null;
  pending: Map<string, number>;
  onChanged: (projectId: string, files: string[]) => void;
};

export class WorkspaceWatcher {
  private readonly projects = new Map<string, WatchedProject>();

  get watchedProjectIds(): string[] {
    return [...this.projects.keys()];
  }

  /** Start watching a project's workspace (no-op if already watched). */
  watch(projectId: string, workspacePath: string, onChanged: (projectId: string, files: string[]) => void): void {
    if (this.projects.has(projectId)) return;
    const entry: WatchedProject = { root: workspacePath, watchers: new Map(), timer: null, pending: new Map(), onChanged };
    this.projects.set(projectId, entry);
    void this.scanDirectory(projectId, workspacePath, 0).catch((error) => {
      console.error(`[watcher] initial scan failed for ${projectId}:`, error instanceof Error ? error.message : error);
    });
  }

  /** Stop watching a project and release every handle and timer. */
  unwatch(projectId: string): void {
    const entry = this.projects.get(projectId);
    if (!entry) return;
    this.projects.delete(projectId);
    if (entry.timer) clearTimeout(entry.timer);
    for (const watcher of entry.watchers.values()) watcher.close();
    entry.watchers.clear();
  }

  close(): void {
    for (const projectId of [...this.projects.keys()]) this.unwatch(projectId);
  }

  private addWatch(projectId: string, dir: string): void {
    const entry = this.projects.get(projectId);
    if (!entry || entry.watchers.has(dir)) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { persistent: false }, (eventType, filename) => {
        this.onFsEvent(projectId, dir, eventType, filename);
      });
    } catch (error) {
      console.error(`[watcher] cannot watch ${dir}:`, error instanceof Error ? error.message : error);
      return;
    }
    watcher.on("error", () => {
      entry.watchers.delete(dir);
    });
    entry.watchers.set(dir, watcher);
  }

  /** Walk a directory tree adding watches; prunes watches for vanished dirs. */
  private async scanDirectory(projectId: string, dir: string, depth: number): Promise<void> {
    const entry = this.projects.get(projectId);
    if (!entry || depth > MAX_DEPTH) return;
    this.addWatch(projectId, dir);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const live = new Set<string>();
    for (const name of names) {
      if (IGNORED_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      live.add(full);
      try {
        const entryStat = await stat(full);
        if (entryStat.isDirectory()) await this.scanDirectory(projectId, full, depth + 1);
      } catch {
        // Entry vanished mid-scan; ignore.
      }
    }
    // Prune watches for subdirectories that no longer exist.
    for (const watchedDir of [...entry.watchers.keys()]) {
      if (watchedDir === dir || !watchedDir.startsWith(`${dir}${path.sep}`)) continue;
      const parent = path.dirname(watchedDir);
      if (parent === dir && !live.has(watchedDir)) {
        entry.watchers.get(watchedDir)?.close();
        entry.watchers.delete(watchedDir);
      }
    }
  }

  private onFsEvent(projectId: string, dir: string, eventType: string, filename: string | Buffer | null): void {
    const entry = this.projects.get(projectId);
    if (!entry || filename === null) return;
    const name = filename.toString();
    if (isIgnoredFileName(name)) return;
    const full = path.join(dir, name);
    const rel = path.relative(entry.root, full);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return;
    const top = rel.split(path.sep)[0];
    if (IGNORED_DIRS.has(top)) return;
    entry.pending.set(rel, Date.now());
    // A rename can mean a directory appeared or vanished — rescan so new
    // subdirectories get watches and deleted ones lose them.
    if (eventType === "rename") {
      void this.scanDirectory(projectId, dir, 0).catch(() => undefined);
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const files = [...entry.pending.keys()].sort().slice(0, 100);
      entry.pending.clear();
      if (files.length > 0) entry.onChanged(projectId, files);
    }, WATCH_DEBOUNCE_MS);
  }
}
