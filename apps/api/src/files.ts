import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Phase 3A — safe workspace file operations for one project.
 *
 * Every operation resolves the requested relative path against the project's
 * workspace directory, rejects traversal / protected names up front, then
 * resolves symlinks with realpath and verifies the real path stays inside
 * the workspace immediately before touching disk. Writes are atomic
 * (temp file in the same directory + rename).
 */

export const MAX_FILE_BYTES = 1_048_576; // 1 MiB
export const MAX_TREE_ENTRIES = 2000;
export const MAX_TREE_DEPTH = 12;
export const MAX_PATH_LENGTH = 1024;

/** Directories never shown in the tree and never served. */
export const HIDDEN_DIRS = new Set(["node_modules", ".git", ".omp", "dist", "build", ".next", "coverage", ".cache"]);

/** Extensions that are never served as text (binary content). */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".avif", ".svg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".tar", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".mp3", ".mp4", ".wav", ".mov", ".webm", ".exe", ".dll", ".so", ".wasm",
]);

export class FileError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Validate a user-supplied relative path and normalize it to posix form.
 * Returns "" for the workspace root (only when allowEmpty). Throws FileError
 * 400 on absolute paths, NUL bytes, `.`/`..` segments, empty segments,
 * backslash separators, drive letters, or over-long paths.
 */
export function validateRelPath(relPath: unknown, allowEmpty = false): string {
  if (typeof relPath !== "string") throw new FileError(400, "Path must be a string");
  if (relPath.includes("\0")) throw new FileError(400, "Path must not contain NUL bytes");
  if (relPath.length > MAX_PATH_LENGTH) throw new FileError(400, "Path is too long");
  const trimmed = relPath.trim();
  if (trimmed === "") {
    if (allowEmpty) return "";
    throw new FileError(400, "Path is required");
  }
  if (trimmed !== relPath) throw new FileError(400, "Path must not have leading or trailing whitespace");
  if (path.isAbsolute(relPath) || relPath.startsWith("/") || relPath.startsWith("\\")) {
    throw new FileError(400, "Path must be relative");
  }
  if (/^[a-zA-Z]:/.test(relPath)) throw new FileError(400, "Path must be relative");
  // Treat backslash as a separator too, so `..\foo` cannot slip through.
  const segments = relPath.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new FileError(400, "Path must not contain empty, '.' or '..' segments");
    }
  }
  if (segments.length > MAX_TREE_DEPTH) throw new FileError(400, "Path is too deep");
  return segments.join("/");
}

/** True when any segment of the relative path is a protected name. */
export function isProtectedPath(relPath: string): boolean {
  const segments = relPath === "" ? [] : relPath.split("/");
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (lower === ".env" || lower.startsWith(".env.")) return true;
    if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
    if (lower.includes("credentials")) return true;
    if (lower === ".git" || lower === ".omp" || lower === "node_modules" || lower === "dist" || lower === "build") return true;
  }
  return false;
}

export function assertNotProtected(relPath: string): void {
  if (isProtectedPath(relPath)) throw new FileError(403, "Path is protected and cannot be accessed");
}

function isWithinDir(rootReal: string, targetReal: string): boolean {
  const relative = path.relative(rootReal, targetReal);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function workspaceDirFor(projectsRoot: string, projectId: string): string {
  return path.resolve(projectsRoot, projectId);
}

/**
 * Resolve a validated relative path to an absolute path inside the project
 * workspace, following symlinks and rejecting escapes. For paths that do not
 * exist yet, the nearest existing ancestor is resolved and the remainder
 * re-appended, so create/write of new files is covered too. The workspace
 * root itself ("") resolves to the workspace directory.
 */
export async function resolveWorkspacePath(projectsRoot: string, projectId: string, relPath: unknown): Promise<string> {
  const rel = validateRelPath(relPath, true);
  assertNotProtected(rel);
  const workspaceDir = workspaceDirFor(projectsRoot, projectId);
  let workspaceReal: string;
  try {
    workspaceReal = await realpath(workspaceDir);
  } catch {
    throw new FileError(404, "Workspace not found");
  }
  const target = rel === "" ? workspaceDir : path.resolve(workspaceDir, ...rel.split("/"));
  // Walk up to the nearest existing ancestor, resolve it, re-append the rest.
  let current = target;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      const resolved = suffix.length ? path.join(real, ...suffix) : real;
      if (!isWithinDir(workspaceReal, resolved)) throw new FileError(403, "Path escapes the project workspace");
      return resolved;
    } catch (error) {
      if (error instanceof FileError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new FileError(404, "Path not found");
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function describeEntry(absolute: string, rel: string): Promise<FileTreeEntry | null> {
  const info = await lstat(absolute);
  // Never follow or serve symlinks from the tree: they are resolved (and
  // escape-checked) only by the direct content endpoints.
  if (info.isSymbolicLink()) return null;
  const mtimeMs = info.mtimeMs;
  if (info.isDirectory()) {
    return { path: rel, name: path.basename(rel), type: "dir", size: 0, mtime: info.mtime.toISOString(), mtimeMs };
  }
  if (info.isFile()) {
    return { path: rel, name: path.basename(rel), type: "file", size: info.size, mtime: info.mtime.toISOString(), mtimeMs };
  }
  return null;
}

async function readTreeDir(dirAbsolute: string, dirRel: string, depth: number, budget: { remaining: number }): Promise<FileTreeEntry[]> {
  const dirents = await readdir(dirAbsolute, { withFileTypes: true });
  dirents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  });
  const entries: FileTreeEntry[] = [];
  for (const dirent of dirents) {
    if (budget.remaining <= 0) throw new FileError(400, `File tree exceeds ${MAX_TREE_ENTRIES} entries`);
    const rel = dirRel === "" ? dirent.name : `${dirRel}/${dirent.name}`;
    if (isProtectedPath(rel)) continue;
    if (dirent.isDirectory() && HIDDEN_DIRS.has(dirent.name)) continue;
    if (dirent.isSymbolicLink()) continue;
    const absolute = path.join(dirAbsolute, dirent.name);
    const entry = await describeEntry(absolute, rel);
    if (!entry) continue;
    budget.remaining -= 1;
    if (entry.type === "dir" && depth < MAX_TREE_DEPTH) {
      entry.children = await readTreeDir(absolute, rel, depth + 1, budget);
    } else if (entry.type === "dir") {
      entry.children = [];
    }
    entries.push(entry);
  }
  return entries;
}

/** Recursive workspace tree, hidden/protected entries excluded. */
export async function listTree(projectsRoot: string, projectId: string): Promise<FileTreeEntry[]> {
  const workspace = await resolveWorkspacePath(projectsRoot, projectId, "");
  return readTreeDir(workspace, "", 1, { remaining: MAX_TREE_ENTRIES });
}

function assertTextContent(buffer: Buffer, rel: string): string {
  const ext = path.extname(rel).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) throw new FileError(415, `Binary file type '${ext}' cannot be read as text`);
  if (buffer.includes(0)) throw new FileError(415, "Binary content cannot be read as text");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new FileError(415, "File is not valid UTF-8 text");
  }
}

export async function readTextFile(
  projectsRoot: string,
  projectId: string,
  relPath: unknown,
): Promise<{ path: string; content: string; size: number; mtime: string; mtimeMs: number }> {
  const rel = validateRelPath(relPath);
  assertNotProtected(rel);
  const absolute = await resolveWorkspacePath(projectsRoot, projectId, rel);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new FileError(404, "File not found");
  }
  if (info.isDirectory()) throw new FileError(400, "Path is a directory");
  if (!info.isFile()) throw new FileError(404, "File not found");
  if (info.size > MAX_FILE_BYTES) throw new FileError(413, "File exceeds the 1 MiB read limit");
  const buffer = await readFile(absolute);
  const content = assertTextContent(buffer, rel);
  return { path: rel, content, size: buffer.length, mtime: info.mtime.toISOString(), mtimeMs: info.mtimeMs };
}

function parseExpectedMtime(expectedMtime: unknown): number | null {
  if (expectedMtime === undefined || expectedMtime === null) return null;
  const ms = typeof expectedMtime === "number" ? expectedMtime : Date.parse(String(expectedMtime));
  if (!Number.isFinite(ms)) throw new FileError(400, "expectedMtime must be a number (ms) or an ISO date string");
  return ms;
}

/**
 * Atomic write (temp file in the same directory + rename). When
 * expectedMtime is given and the file already exists with a different
 * mtime, throws FileError 409 with the current mtime. Parent directories
 * inside the workspace are created as needed.
 */
export async function writeTextFile(
  projectsRoot: string,
  projectId: string,
  relPath: unknown,
  content: unknown,
  expectedMtime?: unknown,
): Promise<{ path: string; size: number; mtime: string; mtimeMs: number }> {
  const rel = validateRelPath(relPath);
  assertNotProtected(rel);
  if (typeof content !== "string") throw new FileError(400, "content must be a string");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) throw new FileError(413, "Content exceeds the 1 MiB write limit");
  const absolute = await resolveWorkspacePath(projectsRoot, projectId, rel);
  const expected = parseExpectedMtime(expectedMtime);
  let existing: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    existing = await stat(absolute);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isDirectory()) throw new FileError(400, "Path is a directory");
    if (expected !== null && Math.abs(existing.mtimeMs - expected) > 1) {
      const conflict = new FileError(409, "conflict");
      (conflict as FileError & { mtime?: string; mtimeMs?: number }).mtime = existing.mtime.toISOString();
      (conflict as FileError & { mtime?: string; mtimeMs?: number }).mtimeMs = existing.mtimeMs;
      throw conflict;
    }
  } else if (expected !== null) {
    throw new FileError(404, "File not found");
  }
  const dir = path.dirname(absolute);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  // Re-verify the parent chain after mkdir: mkdir follows symlinks, so a
  // swapped parent could have escaped — resolve again before writing.
  await resolveWorkspacePath(projectsRoot, projectId, path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel));
  const temp = path.join(dir, `.${path.basename(absolute)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temp, content, { encoding: "utf8", mode: 0o644 });
    await chmod(temp, 0o644);
    await rename(temp, absolute);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  const info = await stat(absolute);
  return { path: rel, size: info.size, mtime: info.mtime.toISOString(), mtimeMs: info.mtimeMs };
}

export async function createEntry(
  projectsRoot: string,
  projectId: string,
  relPath: unknown,
  type: unknown,
): Promise<FileTreeEntry> {
  const rel = validateRelPath(relPath);
  assertNotProtected(rel);
  if (type !== "file" && type !== "dir") throw new FileError(400, "type must be 'file' or 'dir'");
  const absolute = await resolveWorkspacePath(projectsRoot, projectId, rel);
  let existing: unknown = null;
  try {
    existing = await lstat(absolute);
  } catch {
    existing = null;
  }
  if (existing) throw new FileError(409, "Path already exists");
  if (type === "dir") {
    await mkdir(absolute, { recursive: true, mode: 0o755 });
    await chmod(absolute, 0o755);
  } else {
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o755 });
    await writeFile(absolute, "", { encoding: "utf8", mode: 0o644 });
    await chmod(absolute, 0o644);
  }
  const entry = await describeEntry(absolute, rel);
  if (!entry) throw new FileError(500, "Failed to create entry");
  if (entry.type === "dir") entry.children = [];
  return entry;
}

export async function renameEntry(
  projectsRoot: string,
  projectId: string,
  from: unknown,
  to: unknown,
): Promise<{ from: string; to: string }> {
  const fromRel = validateRelPath(from);
  const toRel = validateRelPath(to);
  assertNotProtected(fromRel);
  assertNotProtected(toRel);
  if (fromRel === toRel) throw new FileError(400, "Source and destination are the same");
  const fromAbsolute = await resolveWorkspacePath(projectsRoot, projectId, fromRel);
  const toAbsolute = await resolveWorkspacePath(projectsRoot, projectId, toRel);
  try {
    await lstat(fromAbsolute);
  } catch {
    throw new FileError(404, "Source not found");
  }
  try {
    await lstat(toAbsolute);
    throw new FileError(409, "Destination already exists");
  } catch (error) {
    if (error instanceof FileError) throw error;
    // ENOENT: destination is free — proceed.
  }
  await mkdir(path.dirname(toAbsolute), { recursive: true, mode: 0o755 });
  await rename(fromAbsolute, toAbsolute);
  return { from: fromRel, to: toRel };
}

export async function deleteEntry(
  projectsRoot: string,
  projectId: string,
  relPath: unknown,
  recursive: unknown,
): Promise<{ path: string }> {
  const rel = validateRelPath(relPath);
  assertNotProtected(rel);
  if (rel === "") throw new FileError(400, "Cannot delete the workspace root");
  const absolute = await resolveWorkspacePath(projectsRoot, projectId, rel);
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    throw new FileError(404, "Path not found");
  }
  if (info.isSymbolicLink()) {
    // Remove the link itself, never its target.
    await rm(absolute, { force: true });
    return { path: rel };
  }
  if (info.isDirectory()) {
    if (recursive === true) {
      await rm(absolute, { recursive: true, force: false });
    } else {
      try {
        await rmdir(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
          throw new FileError(409, "Directory is not empty; pass recursive: true to delete it");
        }
        throw error;
      }
    }
    return { path: rel };
  }
  if (info.isFile()) {
    await rm(absolute, { force: true });
    return { path: rel };
  }
  throw new FileError(400, "Path cannot be deleted");
}
