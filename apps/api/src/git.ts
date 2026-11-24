import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProtectedPath } from "./files.js";
import type { Checkpoint, CheckpointDiffFile, CheckpointFileStat, CheckpointResult, RepoState } from "@omp-builder/shared";

/**
 * Milestone C (B1) — Git-backed version history for one project workspace.
 *
 * One real Git repository per project workspace. Every settled OMP turn
 * that changed files becomes a checkpoint commit; restores and undos are
 * new commits (history is never rewritten). The session that made each
 * generation is recorded twice: a commit-message trailer
 * (`Omp-Session: <sessionId>`) — authoritative, travels with the repo —
 * and a `checkpoints` DB row (written by server.ts) so Milestone D
 * (multi-chat) can map commit oid -> chat session without parsing git
 * log. Today there is one chat session per project, so the session id is
 * the project id; Milestone D will pass real chat-session ids here.
 *
 * Safety rules (hard):
 * - Server-run git never executes hooks: every invocation carries
 *   `-c core.hooksPath=/dev/null`, and init also sets it repo-local.
 * - No credential prompts: GIT_TERMINAL_PROMPT=0, no remote is ever
 *   configured, and no fetch/push/clone-from-remote runs here. The only
 *   clone is a local `--no-local` clone of the workspace itself, for
 *   preview-before-restore staging.
 * - Secret-bearing files are never committed: .gitignore excludes the
 *   standard set, and isDeniedCheckpointPath is a server-side deny-list
 *   checked on every file about to be staged (defense in depth — a
 *   denied file is left unstaged and reported, never committed).
 * - No shell: argv arrays only (execFile, shell never enabled).
 * - All paths are validated by the caller (server.ts projectRow) to be
 *   inside the projects root before any function here runs.
 *
 * The milestone-C tests import the built module (apps/api/dist/git.js):
 * a native .ts import cannot resolve this file's ./files.js import under
 * Node type stripping.
 */

export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const GIT_AUTHOR_NAME = "OMP Builder";
export const GIT_AUTHOR_EMAIL = "omp-builder@localhost";
export const MAX_CHECKPOINTS = 50;
export const MAX_DIFF_FILES = 20;
export const MAX_DIFF_FILE_BYTES = 200_000;
export const MAX_STAGING_FILES = 500;
const GIT_TIMEOUT_MS = 30_000;
const GIT_CLONE_TIMEOUT_MS = 60_000;

/** Canonical .gitignore lines for a project workspace. User entries in an
 * existing .gitignore are preserved verbatim; missing canonical lines are
 * appended by mergeGitignore. `data/` covers runtime data; `*.log` covers
 * logs; `*credentials*` / `*secret*` are deliberately NOT here (a source
 * file could legitimately carry those words) — the server-side deny-list
 * below is what keeps secret-named files out of commits. */
export const GITIGNORE_CANONICAL = [
  "# Managed by OMP Builder — version history ignores runtime data and secrets.",
  "# Your own entries are preserved; missing entries from this list are appended automatically.",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.log",
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "coverage/",
  ".cache/",
  "data/",
];

export class GitError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Merge the canonical ignore lines into an existing .gitignore body.
 * Existing content (including comments and user rules) is kept verbatim;
 * only missing canonical non-comment lines are appended. */
export function mergeGitignore(existing: string): string {
  const present = new Set(
    existing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
  const missing = GITIGNORE_CANONICAL.filter((line) => {
    if (line.startsWith("#")) return false;
    return !present.has(line);
  });
  let body = existing;
  if (body !== "" && !body.endsWith("\n")) body += "\n";
  if (missing.length > 0) {
    if (body !== "") body += "\n";
    body += missing.join("\n") + "\n";
  }
  if (body === "") body = GITIGNORE_CANONICAL.join("\n") + "\n";
  return body;
}

/**
 * Server-side deny-list for checkpoint staging (defense in depth behind
 * .gitignore). A file is denied when it looks secret-bearing or is runtime
 * data: anything files.ts already protects (.env*, *.pem, *.key, names
 * containing "credentials", .git/.omp/node_modules/dist/build), plus *.log,
 * a top-level data/ directory, and any path segment containing "secret".
 * Denied files are left unstaged and reported — never committed.
 * Single exception (Milestone D, B6): .omp/RULES.md is allowed — see
 * isDeniedCheckpointPath.
 */
export function isDeniedCheckpointPath(relPath: string): boolean {
  // Milestone D (B6) - the single exception: .omp/RULES.md is project
  // content the user edits through the dedicated rules endpoint, which
  // already rejects secrets and outside-workspace @ imports before
  // writing. It must be checkpointed so Undo/Restore restores the rules
  // that produced the code. Every other .omp path stays denied.
  if (relPath === ".omp/RULES.md") return false;
  if (isProtectedPath(relPath)) return true;
  const lower = relPath.toLowerCase();
  if (lower.endsWith(".log")) return true;
  const segments = lower.split("/");
  if (segments[0] === "data") return true;
  if (segments.some((segment) => segment === ".next" || segment === "coverage" || segment === ".cache")) return true;
  if (segments.some((segment) => segment.includes("secret"))) return true;
  return false;
}

type GitRun = { stdout: string; stderr: string; code: number };

function runGit(workspacePath: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitRun> {
  const fullArgs = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      fullArgs,
      {
        cwd: workspacePath,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new GitError(500, "git binary not found on this host"));
          return;
        }
        if (error && typeof error === "object" && "killed" in error && (error as { killed?: unknown }).killed) {
          reject(new GitError(500, "git command timed out"));
          return;
        }
        const code = typeof error === "object" && error !== null && "code" in error ? Number((error as { code: unknown }).code) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code: Number.isInteger(code) ? code : 0 });
      },
    );
    child.on("error", (error) => reject(new GitError(500, `Unable to run git: ${error.message}`)));
  });
}

function gitErrorMessage(stderr: string, fallback: string): string {
  const first = stderr.split("\n").map((line) => line.trim()).filter(Boolean)[0];
  return first ? first.slice(0, 300) : fallback;
}

function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

function oneLine(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function parseSessionTrailer(body: string): string | null {
  const match = body.match(/^Omp-Session:\s*(\S+)\s*$/m);
  return match ? match[1] : null;
}

/** Parse `git status --porcelain=v1 -z` output. Rename entries arrive as
 * two NUL-separated fields (new path, then old path). */
export function parsePorcelainZ(output: string): Array<{ status: string; path: string; origPath: string | null }> {
  const fields = output.split("\0").filter((field) => field !== "");
  const entries: Array<{ status: string; path: string; origPath: string | null }> = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const match = field.match(/^([ MADRCU?!]{2}) (.+)$/);
    if (!match) continue;
    const status = match[1];
    const entryPath = match[2];
    if ((status[0] === "R" || status[1] === "R") && i + 1 < fields.length) {
      entries.push({ status, path: entryPath, origPath: fields[i + 1] });
      i += 1;
    } else {
      entries.push({ status, path: entryPath, origPath: null });
    }
  }
  return entries;
}

async function headOid(workspacePath: string): Promise<string | null> {
  const result = await runGit(workspacePath, ["rev-parse", "--verify", "HEAD"]);
  if (result.code !== 0) return null;
  const oid = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

/** Inspect a workspace's git state. Never writes anything. A workspace
 * with a `.git` that git cannot read is reported corrupt — callers must
 * surface that, never re-init over it. */
export async function repoState(workspacePath: string): Promise<RepoState> {
  const gitDir = path.join(workspacePath, ".git");
  if (!existsSync(gitDir)) {
    return { initialized: false, corrupt: false, head: null, dirty: false, uncommittedFiles: [] };
  }
  const probe = await runGit(workspacePath, ["rev-parse", "--git-dir"]);
  if (probe.code !== 0) {
    return {
      initialized: false,
      corrupt: true,
      head: null,
      dirty: false,
      uncommittedFiles: [],
      error: `The workspace .git directory exists but git cannot read it (${gitErrorMessage(probe.stderr, "invalid git repository")}). It was left untouched — fix or remove it by hand before version history can start.`,
    };
  }
  const head = await headOid(workspacePath);
  const status = await runGit(workspacePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const uncommittedFiles = status.code === 0 ? parsePorcelainZ(status.stdout).map((entry) => entry.path) : [];
  return { initialized: true, corrupt: false, head, dirty: uncommittedFiles.length > 0, uncommittedFiles };
}

/**
 * Safe init for an existing non-Git workspace: writes/merges .gitignore
 * FIRST, then `git init` (repo-local identity, hooks disabled), then a
 * baseline commit of the current state — without touching or losing any
 * file. An empty workspace still gets a baseline commit (it contains the
 * generated .gitignore). Already-initialized repos are
 * returned untouched (never re-initialized, history never rewritten).
 * A bare/corrupt `.git` is reported, never touched.
 */
export async function ensureGitRepo(workspacePath: string): Promise<{
  status: "initialized" | "already" | "corrupt" | "empty";
  head: string | null;
  baselineOid: string | null;
  error?: string;
}> {
  const state = await repoState(workspacePath);
  if (state.corrupt) return { status: "corrupt", head: null, baselineOid: null, error: state.error };
  if (state.initialized) return { status: "already", head: state.head, baselineOid: null };
  const gitignorePath = path.join(workspacePath, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    existing = "";
  }
  await writeFile(gitignorePath, mergeGitignore(existing), { encoding: "utf8", mode: 0o644 });
  const init = await runGit(workspacePath, ["-c", "init.defaultBranch=main", "init"]);
  if (init.code !== 0) throw new GitError(500, `git init failed: ${gitErrorMessage(init.stderr, "git init failed")}`);
  for (const [key, value] of [
    ["user.name", GIT_AUTHOR_NAME],
    ["user.email", GIT_AUTHOR_EMAIL],
    ["core.hooksPath", "/dev/null"],
    ["commit.gpgsign", "false"],
  ] as const) {
    const set = await runGit(workspacePath, ["config", key, value]);
    if (set.code !== 0) throw new GitError(500, `git config ${key} failed: ${gitErrorMessage(set.stderr, "git config failed")}`);
  }
  // Stage per path through the same deny-list as checkpoints: the
  // baseline must not commit secret-bearing or runtime files either,
  // even though .gitignore already excludes the standard set.
  const baselineFiles = await changedFiles(workspacePath);
  const { staged: stagedBaseline } = await stageSafeFiles(workspacePath, baselineFiles);
  if (stagedBaseline.length === 0) return { status: "empty", head: null, baselineOid: null };
  const fileCount = await stagedFileCount(workspacePath);
  if (fileCount === 0) return { status: "empty", head: null, baselineOid: null };
  const subject = `Baseline: initial project state (${fileCount} file${fileCount === 1 ? "" : "s"})`;
  const committed = await runGit(workspacePath, ["commit", "-m", subject, "-m", "Omp-Session: baseline"]);
  if (committed.code !== 0) throw new GitError(500, `baseline commit failed: ${gitErrorMessage(committed.stderr, "baseline commit failed")}`);
  const head = await headOid(workspacePath);
  return { status: "initialized", head, baselineOid: head };
}

type ChangedFile = { path: string; status: string; origPath: string | null };

// NOTE: both status calls in this file use --untracked-files=all. Without it
// git collapses an untracked directory to one `dir/` entry, and the
// deny-list would reject the directory as a whole — which hid
// .omp/RULES.md (Milestone D, B6) inside its parent .omp/ entry.
async function changedFiles(workspacePath: string): Promise<ChangedFile[]> {
  const status = await runGit(workspacePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.code !== 0) throw new GitError(500, `git status failed: ${gitErrorMessage(status.stderr, "git status failed")}`);
  return parsePorcelainZ(status.stdout);
}

async function stageSafeFiles(workspacePath: string, files: ChangedFile[]): Promise<{ staged: ChangedFile[]; skippedDenied: string[] }> {
  const safe: ChangedFile[] = [];
  const skippedDenied: string[] = [];
  for (const file of files) {
    const denied = isDeniedCheckpointPath(file.path) || (file.origPath !== null && isDeniedCheckpointPath(file.origPath));
    if (denied) skippedDenied.push(file.path);
    else safe.push(file);
  }
  if (safe.length === 0) return { staged: [], skippedDenied };
  // Stage per path (not `git add -A`): denied files must never enter the
  // index, even if .gitignore was edited to un-ignore them. `git add`
  // stages deletions of a named path too, so renames/deletes are covered.
  const paths: string[] = [];
  for (const file of safe) {
    paths.push(file.path);
    if (file.origPath !== null) paths.push(file.origPath);
  }
  const unique = [...new Set(paths)];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const added = await runGit(workspacePath, ["add", "--", ...chunk]);
    if (added.code === 0) continue;
    // A restore stages removals itself (read-tree --reset): a removed
    // file is then in neither the index nor the worktree, and `git add`
    // fails that pathspec with "did not match any files" — it is already
    // staged, so that specific error is ignored per path. Any other add
    // failure still throws.
    for (const single of chunk) {
      const one = await runGit(workspacePath, ["add", "--", single]);
      if (one.code !== 0 && !one.stderr.includes("did not match any files")) {
        throw new GitError(500, `git add failed: ${gitErrorMessage(one.stderr, "git add failed")}`);
      }
    }
  }
  return { staged: safe, skippedDenied };
}

async function stagedFileCount(workspacePath: string): Promise<number> {
  const diff = await runGit(workspacePath, ["diff", "--cached", "--name-only"]);
  if (diff.code !== 0) return 0;
  return diff.stdout.split("\n").filter(Boolean).length;
}

async function commitStaged(
  workspacePath: string,
  subject: string,
  sessionId: string,
  extraBody: string[] = [],
): Promise<{ oid: string; message: string }> {
  const body = [`Omp-Session: ${sessionId}`, ...extraBody].join("\n");
  const committed = await runGit(workspacePath, ["commit", "-m", subject, "-m", body]);
  if (committed.code !== 0) throw new GitError(500, `git commit failed: ${gitErrorMessage(committed.stderr, "git commit failed")}`);
  const head = await headOid(workspacePath);
  if (!head) throw new GitError(500, "git commit succeeded but HEAD could not be read");
  return { oid: head, message: `${subject}\n\n${body}` };
}

/**
 * Commit the workspace's current changes as a checkpoint. No-op (created:
 * false) when nothing safe changed. Denied files are skipped and reported,
 * never staged. The caller records the returned oid in the checkpoints DB
 * table (server.ts) for the Milestone D session mapping.
 */
export async function createCheckpoint(
  workspacePath: string,
  options: {
    promptSummary?: string;
    sessionId: string;
    kind: "ai" | "manual" | "restore" | "undo";
    manualMessage?: string;
    restoreTarget?: { oid: string; subject: string };
  },
): Promise<CheckpointResult> {
  const ensured = await ensureGitRepo(workspacePath);
  if (ensured.status === "corrupt") throw new GitError(409, ensured.error ?? "Workspace git repository is corrupt");
  const files = await changedFiles(workspacePath);
  if (files.length === 0) return { created: false, oid: null, shortOid: null, filesChanged: 0, skippedDenied: [], message: null, reason: "no changes" };
  const { staged, skippedDenied } = await stageSafeFiles(workspacePath, files);
  if (staged.length === 0) {
    return {
      created: false,
      oid: null,
      shortOid: null,
      filesChanged: 0,
      skippedDenied,
      message: null,
      reason: "only secret-bearing or runtime files changed — nothing safe to checkpoint",
    };
  }
  const count = await stagedFileCount(workspacePath);
  if (count === 0) return { created: false, oid: null, shortOid: null, filesChanged: 0, skippedDenied, message: null, reason: "no changes" };
  const noun = count === 1 ? "file" : "files";
  let subject: string;
  if (options.kind === "restore" && options.restoreTarget) {
    subject = `Restore to ${shortOid(options.restoreTarget.oid)}: ${oneLine(options.restoreTarget.subject, 80)} (${count} ${noun})`;
  } else if (options.kind === "undo" && options.restoreTarget) {
    subject = `Undo: restore to ${shortOid(options.restoreTarget.oid)} (${oneLine(options.restoreTarget.subject, 60)}) (${count} ${noun})`;
  } else if (options.kind === "manual") {
    const label = options.manualMessage ? oneLine(options.manualMessage, 100) : "Manual checkpoint";
    subject = `${label} (${count} ${noun})`;
  } else if (options.promptSummary) {
    subject = `AI update: ${oneLine(options.promptSummary, 100)} (${count} ${noun})`;
  } else {
    subject = `AI update (${count} ${noun})`;
  }
  const { oid, message } = await commitStaged(workspacePath, subject, options.sessionId, [`Files-Changed: ${count}`]);
  return { created: true, oid, shortOid: shortOid(oid), filesChanged: count, skippedDenied, message };
}

function parseNumstat(output: string): Map<string, { added: number; removed: number }> {
  const stats = new Map<string, { added: number; removed: number }>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? 0 : Number(parts[0]);
    const removed = parts[1] === "-" ? 0 : Number(parts[1]);
    const rawPath = parts.slice(2).join("\t");
    const filePath = rawPath.startsWith('"') && rawPath.endsWith('"') ? rawPath.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : rawPath;
    stats.set(filePath, { added: Number.isFinite(added) ? added : 0, removed: Number.isFinite(removed) ? removed : 0 });
  }
  return stats;
}

async function numstatFor(workspacePath: string, oid: string): Promise<Map<string, { added: number; removed: number }>> {
  const parent = await runGit(workspacePath, ["rev-parse", "--verify", `${oid}^`]);
  const base = parent.code === 0 ? `${oid}^` : EMPTY_TREE_OID;
  const diff = await runGit(workspacePath, ["diff", "--numstat", base, oid]);
  if (diff.code !== 0) return new Map();
  return parseNumstat(diff.stdout);
}

/** List checkpoints, newest first. Reads git log (authoritative); the
 * session comes from the commit trailer (the DB table mirrors it). */
export async function listCheckpoints(workspacePath: string, limit = MAX_CHECKPOINTS): Promise<Checkpoint[]> {
  const state = await repoState(workspacePath);
  if (!state.initialized || !state.head) return [];
  const log = await runGit(workspacePath, [
    "log",
    `--max-count=${Math.max(1, Math.min(limit, 200))}`,
    "--pretty=format:%H%x1f%P%x1f%ct%x1f%s%x1f%b%x1e",
  ]);
  if (log.code !== 0) throw new GitError(500, `git log failed: ${gitErrorMessage(log.stderr, "git log failed")}`);
  const checkpoints: Checkpoint[] = [];
  for (const record of log.stdout.split("\x1e")) {
    const trimmed = record.replace(/^\n+/, "").replace(/\n+$/, "");
    if (!trimmed) continue;
    const fields = trimmed.split("\x1f");
    if (fields.length < 5) continue;
    const [oid, parents, createdAtSeconds, subject, body] = fields;
    if (!/^[0-9a-f]{40}$/.test(oid)) continue;
    const stats = await numstatFor(workspacePath, oid);
    let added = 0;
    let removed = 0;
    for (const stat of stats.values()) {
      added += stat.added;
      removed += stat.removed;
    }
    checkpoints.push({
      oid,
      shortOid: shortOid(oid),
      parentOid: parents.trim() ? parents.trim().split(" ")[0] : null,
      subject,
      message: `${subject}${body.trim() ? `\n\n${body.trim()}` : ""}`,
      timestamp: new Date(Number(createdAtSeconds) * 1000).toISOString(),
      sessionId: parseSessionTrailer(body),
      filesChanged: stats.size,
      added,
      removed,
    });
  }
  return checkpoints;
}

/** Per-file stats for one checkpoint vs its parent (empty tree for root). */
export async function checkpointFileStats(workspacePath: string, oid: string): Promise<CheckpointFileStat[]> {
  const resolved = await runGit(workspacePath, ["rev-parse", "--verify", `${oid}^{commit}`]);
  if (resolved.code !== 0) throw new GitError(404, "Checkpoint not found");
  const fullOid = resolved.stdout.trim();
  const parent = await runGit(workspacePath, ["rev-parse", "--verify", `${fullOid}^`]);
  const base = parent.code === 0 ? `${fullOid}^` : EMPTY_TREE_OID;
  const names = await runGit(workspacePath, ["diff", "--name-status", base, fullOid]);
  if (names.code !== 0) throw new GitError(500, `git diff failed: ${gitErrorMessage(names.stderr, "git diff failed")}`);
  const stats = await numstatFor(workspacePath, fullOid);
  const files: CheckpointFileStat[] = [];
  for (const line of names.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    let filePath = parts[parts.length - 1] ?? "";
    if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
    const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
    const stat = stats.get(filePath) ?? { added: 0, removed: 0 };
    files.push({ path: filePath, status, added: stat.added, removed: stat.removed });
  }
  return files;
}

async function readRevisionFile(workspacePath: string, rev: string, relPath: string): Promise<{ content: string; binary: boolean } | null> {
  const shown = await runGit(workspacePath, ["show", `${rev}:${relPath}`]);
  if (shown.code !== 0) return null;
  const content = shown.stdout;
  if (Buffer.byteLength(content, "utf8") > MAX_DIFF_FILE_BYTES) return { content: "", binary: true };
  if (content.includes("\0")) return { content: "", binary: true };
  return { content, binary: false };
}

/**
 * Diff between two checkpoints (or a checkpoint vs its parent when `from`
 * is omitted). Returns per-file original/modified content for the
 * read-only Monaco diff viewer. Files over the size cap (or binary) are
 * reported with empty content and binary: true.
 */
export async function checkpointDiff(
  workspacePath: string,
  fromOid: string | null,
  toOid: string,
): Promise<{ fromOid: string | null; toOid: string; files: CheckpointDiffFile[] }> {
  const toResolved = await runGit(workspacePath, ["rev-parse", "--verify", `${toOid}^{commit}`]);
  if (toResolved.code !== 0) throw new GitError(404, "Checkpoint not found");
  const to = toResolved.stdout.trim();
  let from: string | null = null;
  if (fromOid) {
    const fromResolved = await runGit(workspacePath, ["rev-parse", "--verify", `${fromOid}^{commit}`]);
    if (fromResolved.code !== 0) throw new GitError(404, "Comparison checkpoint not found");
    from = fromResolved.stdout.trim();
  } else {
    const parent = await runGit(workspacePath, ["rev-parse", "--verify", `${to}^`]);
    from = parent.code === 0 ? parent.stdout.trim() : EMPTY_TREE_OID;
  }
  const base = from ?? EMPTY_TREE_OID;
  const names = await runGit(workspacePath, ["diff", "--name-status", base, to]);
  if (names.code !== 0) throw new GitError(500, `git diff failed: ${gitErrorMessage(names.stderr, "git diff failed")}`);
  const stats = parseNumstat((await runGit(workspacePath, ["diff", "--numstat", base, to])).stdout);
  const files: CheckpointDiffFile[] = [];
  for (const line of names.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    let filePath = parts[parts.length - 1] ?? "";
    if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
    const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
    const stat = stats.get(filePath) ?? { added: 0, removed: 0 };
    if (files.length >= MAX_DIFF_FILES) {
      files.push({ path: filePath, status, added: stat.added, removed: stat.removed, original: "", modified: "", binary: true });
      continue;
    }
    const original = status === "added" ? { content: "", binary: false } : await readRevisionFile(workspacePath, base, filePath);
    const modified = status === "deleted" ? { content: "", binary: false } : await readRevisionFile(workspacePath, to, filePath);
    const binary = (original?.binary ?? false) || (modified?.binary ?? false);
    files.push({
      path: filePath,
      status,
      added: stat.added,
      removed: stat.removed,
      original: original?.content ?? "",
      modified: modified?.content ?? "",
      binary,
    });
  }
  return { fromOid: from, toOid: to, files };
}

/**
 * Restore the workspace to a checkpoint as a NEW commit (history is never
 * rewritten). Refuses with 409 when the workspace has uncommitted changes
 * unless discardUncommitted is explicitly true — and then only after the
 * caller confirmed discarding (the UI checkbox). Untracked files count
 * as uncommitted changes: restoring deletes files added after the
 * checkpoint, so they must be discarded explicitly too.
 */
export async function restoreToCheckpoint(
  workspacePath: string,
  oid: string,
  options: { discardUncommitted: boolean; sessionId: string; kind: "restore" | "undo" },
): Promise<CheckpointResult & { restoredOid: string; alreadyAt: boolean; changedPaths: string[] }> {
  const resolved = await runGit(workspacePath, ["rev-parse", "--verify", `${oid}^{commit}`]);
  if (resolved.code !== 0) throw new GitError(404, "Checkpoint not found");
  const target = resolved.stdout.trim();
  const ensured = await ensureGitRepo(workspacePath);
  if (ensured.status === "corrupt") throw new GitError(409, ensured.error ?? "Workspace git repository is corrupt");
  const state = await repoState(workspacePath);
  if (state.dirty && !options.discardUncommitted) {
    throw new GitError(
      409,
      `The workspace has uncommitted changes (${state.uncommittedFiles.length} file${state.uncommittedFiles.length === 1 ? "" : "s"}). Restore refused so nothing is lost — confirm discarding them to restore anyway.`,
    );
  }
  if (state.dirty) {
    const reset = await runGit(workspacePath, ["reset", "--hard", "-q", "HEAD"]);
    if (reset.code !== 0) throw new GitError(500, `git reset failed: ${gitErrorMessage(reset.stderr, "git reset failed")}`);
    const clean = await runGit(workspacePath, ["clean", "-fd", "-q"]);
    if (clean.code !== 0) throw new GitError(500, `git clean failed: ${gitErrorMessage(clean.stderr, "git clean failed")}`);
  }
  const head = await headOid(workspacePath);
  if (head === target) {
    return { created: false, oid: head, shortOid: head ? shortOid(head) : null, filesChanged: 0, skippedDenied: [], message: null, restoredOid: target, alreadyAt: true, changedPaths: [] };
  }
  const readTree = await runGit(workspacePath, ["read-tree", "-u", "--reset", target]);
  if (readTree.code !== 0) throw new GitError(500, `git read-tree failed: ${gitErrorMessage(readTree.stderr, "git read-tree failed")}`);
  // Files added after the checkpoint are untracked now (read-tree does not
  // remove them); with uncommitted changes already refused/discarded above
  // this only removes post-checkpoint additions — the restore itself.
  const cleanAfter = await runGit(workspacePath, ["clean", "-fd", "-q"]);
  if (cleanAfter.code !== 0) throw new GitError(500, `git clean failed: ${gitErrorMessage(cleanAfter.stderr, "git clean failed")}`);
  const subjectLog = await runGit(workspacePath, ["log", "-1", "--pretty=format:%s", target]);
  const targetSubject = subjectLog.code === 0 && subjectLog.stdout.trim() ? subjectLog.stdout.trim() : target;
  const result = await createCheckpoint(workspacePath, {
    sessionId: options.sessionId,
    kind: options.kind,
    restoreTarget: { oid: target, subject: targetSubject },
  });
  if (!result.created || !result.oid) {
    // The tree already matched the checkpoint (e.g. restoring to the
    // parent of a no-op turn): nothing new to commit, but the workspace
    // is at the target state.
    return { created: false, oid: head, shortOid: head ? shortOid(head) : null, filesChanged: 0, skippedDenied: [], message: null, restoredOid: target, alreadyAt: true, changedPaths: [] };
  }
  // Files the restore changed, vs the previous HEAD — the UI reloads
  // open editor tabs for exactly these paths.
  const diffNames = await runGit(workspacePath, ["diff", "--name-only", head ?? EMPTY_TREE_OID, result.oid]);
  const changedPaths = diffNames.code === 0 ? diffNames.stdout.split("\n").filter(Boolean) : [];
  return { ...result, restoredOid: target, alreadyAt: false, changedPaths };
}

/** Undo the last generation: restore to the parent of HEAD as a new
 * commit. Refuses when there is no parent (only a baseline / single
 * commit) or no commits at all. */
export async function undoLastCheckpoint(
  workspacePath: string,
  options: { discardUncommitted: boolean; sessionId: string },
): Promise<CheckpointResult & { restoredOid: string; undoneOid: string; changedPaths: string[] }> {
  const state = await repoState(workspacePath);
  if (!state.initialized || !state.head) throw new GitError(409, "Nothing to undo — this project has no checkpoints yet");
  const parent = await runGit(workspacePath, ["rev-parse", "--verify", "HEAD^"]);
  if (parent.code !== 0) throw new GitError(409, "Nothing to undo — there is only one checkpoint");
  const undoneOid = state.head;
  const restored = await restoreToCheckpoint(workspacePath, parent.stdout.trim(), {
    discardUncommitted: options.discardUncommitted,
    sessionId: options.sessionId,
    kind: "undo",
  });
  return { ...restored, undoneOid };
}

/**
 * Preview-before-restore: a detached checkout of the checkpoint in a
 * staging copy OUTSIDE the live workspace (never mutates it). Returns
 * the staging file list (capped) and the diff vs the current HEAD so the
 * UI can show what restoring would change. Staging dirs are deterministic
 * per (project, oid) and pruned to the newest few per project.
 */
export async function previewCheckpoint(
  workspacePath: string,
  stagingRoot: string,
  projectId: string,
  oid: string,
): Promise<{
  stagingId: string;
  oid: string;
  subject: string;
  files: Array<{ path: string; size: number }>;
  diff: CheckpointFileStat[];
  headOid: string | null;
}> {
  const resolved = await runGit(workspacePath, ["rev-parse", "--verify", `${oid}^{commit}`]);
  if (resolved.code !== 0) throw new GitError(404, "Checkpoint not found");
  const target = resolved.stdout.trim();
  const checkpoints = await listCheckpoints(workspacePath, MAX_CHECKPOINTS);
  const targetCheckpoint = checkpoints.find((entry) => entry.oid === target);
  if (!targetCheckpoint) throw new GitError(404, "Checkpoint not found");
  const projectStaging = path.join(stagingRoot, projectId);
  await mkdir(projectStaging, { recursive: true, mode: 0o700 });
  const stagingId = shortOid(target);
  const stagingDir = path.join(projectStaging, stagingId);
  const head = await headOid(workspacePath);
  const existingHead = existsSync(path.join(stagingDir, ".git"))
    ? await runGit(stagingDir, ["rev-parse", "HEAD"]).then((result) => (result.code === 0 ? result.stdout.trim() : null))
    : null;
  if (existingHead !== target) {
    await rm(stagingDir, { recursive: true, force: true });
    const cloned = await runGit(stagingRoot, ["clone", "--no-local", "--quiet", workspacePath, stagingDir], GIT_CLONE_TIMEOUT_MS);
    if (cloned.code !== 0) throw new GitError(500, `staging clone failed: ${gitErrorMessage(cloned.stderr, "staging clone failed")}`);
    const detached = await runGit(stagingDir, ["checkout", "--detach", "--quiet", target]);
    if (detached.code !== 0) throw new GitError(500, `staging checkout failed: ${gitErrorMessage(detached.stderr, "staging checkout failed")}`);
  }
  // Prune older staging dirs for this project (keep the 3 newest).
  try {
    const entries = await readdir(projectStaging, { withFileTypes: true });
    const dirs: Array<{ name: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === stagingId) continue;
      const info = await stat(path.join(projectStaging, entry.name)).catch(() => null);
      if (info) dirs.push({ name: entry.name, mtimeMs: info.mtimeMs });
    }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of dirs.slice(3)) await rm(path.join(projectStaging, stale.name), { recursive: true, force: true });
  } catch {
    // Pruning is best-effort; a failed prune never blocks the preview.
  }
  const files: Array<{ path: string; size: number }> = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (files.length >= MAX_STAGING_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const entry of entries) {
      if (files.length >= MAX_STAGING_FILES) return;
      if (entry.name === ".git") continue;
      const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute, entryRel);
      else if (entry.isFile()) {
        const info = await stat(absolute).catch(() => null);
        files.push({ path: entryRel, size: info?.size ?? 0 });
      }
    }
  };
  await walk(stagingDir, "");
  const diff = head && head !== target ? await checkpointDiffFilesBetween(workspacePath, target, head) : [];
  return { stagingId, oid: target, subject: targetCheckpoint.subject, files, diff, headOid: head };
}

async function checkpointDiffFilesBetween(workspacePath: string, fromOid: string, toOid: string): Promise<CheckpointFileStat[]> {
  const names = await runGit(workspacePath, ["diff", "--name-status", fromOid, toOid]);
  if (names.code !== 0) return [];
  const stats = parseNumstat((await runGit(workspacePath, ["diff", "--numstat", fromOid, toOid])).stdout);
  const files: CheckpointFileStat[] = [];
  for (const line of names.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    let filePath = parts[parts.length - 1] ?? "";
    if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
    const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
    const stat = stats.get(filePath) ?? { added: 0, removed: 0 };
    files.push({ path: filePath, status, added: stat.added, removed: stat.removed });
  }
  return files;
}
