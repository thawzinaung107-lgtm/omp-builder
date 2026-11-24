import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  parseGitHubRepoUrl,
  type GitHubImportResult,
  type GitHubImportRulesFile,
  type GitHubRepoRef,
} from "@omp-builder/shared";
import { GIT_AUTHOR_EMAIL, GIT_AUTHOR_NAME } from "./git.js";

export { parseGitHubRepoUrl };

/**
 * Milestone D (B5) — secure public GitHub repository import.
 *
 * Server-side `git clone` of a public github.com repo into a fresh
 * workspace. The security controls, in order:
 *
 * 1. URL: only parseGitHubRepoUrl output is ever cloned — https,
 *    github.com only, no userinfo/query/fragment, exactly
 *    <owner>/<repo>. The clone URL is rebuilt from the validated
 *    segments, never taken from raw user input.
 * 2. Git runs with a clean environment: no inherited credentials, no
 *    credential helpers, no user/system config (GIT_CONFIG_GLOBAL
 *    points at /dev/null), no terminal prompts, no SSH at all
 *    (GIT_SSH_COMMAND=/bin/false), and GIT_ALLOW_PROTOCOL=https so
 *    git itself refuses any non-https transport. No shell: argv
 *    arrays only (execFile). Hooks never execute (core.hooksPath).
 * 3. Clone is shallow (`--depth 1 --single-branch --no-tags`) and
 *    bounded: a 120s timeout and a 500 MiB post-clone size cap.
 *    Oversized clones are rejected and the workspace removed.
 * 4. After clone, secret-bearing files (.env / .env.*, *.pem, *.key,
 *    *credentials* paths) are DELETED from the workspace and listed
 *    in the result. Decision: delete, not just flag — the file API
 *    and the checkpoint deny-list would hide them from the UI, but
 *    OMP (which reads the workspace directly) could otherwise pull a
 *    live secret into model context. Caveat, stated in the result
 *    type: the deleted files may still exist inside the preserved
 *    .git history (shallow, depth 1) — rotate any exposed secret.
 *    Non-secret files are never deleted: node_modules, dist, .omp
 *    and everything else is kept verbatim.
 * 5. The cloned .git is PRESERVED (never re-init, history never
 *    rewritten) and the import records a baseline checkpoint pointing
 *    at the cloned HEAD. The origin remote is removed afterwards, so
 *    no server git operation can ever fetch/push (Milestone C
 *    invariant: no remote is ever configured). Repo-local identity
 *    and hooksPath are set so later checkpoints work. The upstream
 *    .gitignore is left exactly as cloned — the checkpoint deny-list
 *    still keeps secrets out of commits.
 * 6. Rules/context files found at the root (AGENTS.md, CLAUDE.md,
 *    .omp/RULES.md) are reported in the result: OMP loads root
 *    AGENTS.md / .omp/RULES.md on the next turn (B6), so the user
 *    sees what foreign instructions will be honored.
 *
 * The milestone-C/D tests import the built module
 * (apps/api/dist/github-import.js).
 */

export const CLONE_TIMEOUT_MS = 120_000;
export const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
export const MAX_IMPORT_BYTES_LABEL = "500 MB";

/** Rules/context files looked for at the workspace root after import. */
export const IMPORT_RULES_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".omp/RULES.md",
] as const;

export class ImportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type GitRun = {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
};

/** Minimal environment for server-run git: nothing credential-bearing
 * survives, and git cannot reach any transport but https. HOME is
 * deliberately absent (GIT_CONFIG_GLOBAL replaces it). */
function cleanGitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_ASKPASS: "/bin/false",
    GIT_SSH_COMMAND: "/bin/false",
  };
}

function firstLine(stderr: string, fallback: string): string {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)[0];
  if (!line) return fallback;
  return line.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 300);
}

function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitRun> {
  const fullArgs = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      fullArgs,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: cleanGitEnv(),
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new ImportError(500, "git binary not found on this host"));
          return;
        }
        const killed =
          error !== null &&
          typeof error === "object" &&
          "killed" in error &&
          (error as { killed?: unknown }).killed === true;
        const code =
          error !== null && typeof error === "object" && "code" in error
            ? Number((error as { code?: unknown }).code)
            : 0;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code: Number.isInteger(code) ? code : 0,
          timedOut: killed,
        });
      },
    );
    child.on("error", (error) =>
      reject(new ImportError(500, `Unable to run git: ${error.message}`)),
    );
  });
}

/** Shallow clone of a validated public repo into an existing empty
 * directory. The caller creates the directory and removes it on error. */
export async function clonePublicRepo(
  ref: GitHubRepoRef,
  targetDir: string,
  timeoutMs = CLONE_TIMEOUT_MS,
): Promise<void> {
  const result = await runGit(
    [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      ref.cloneUrl,
      targetDir,
    ],
    path.dirname(targetDir),
    timeoutMs,
  );
  if (result.timedOut) {
    throw new ImportError(
      504,
      `Clone timed out after ${Math.round(timeoutMs / 1000)} seconds — GitHub may be slow or the repository may be very large. Try again later.`,
    );
  }
  if (result.code !== 0) {
    const stderr = result.stderr.toLowerCase();
    if (
      stderr.includes("repository not found") ||
      stderr.includes("not found") ||
      stderr.includes("does not exist") ||
      stderr.includes("could not be found") ||
      stderr.includes("authentication failed") ||
      stderr.includes("permission denied") ||
      stderr.includes("403") ||
      stderr.includes("401") ||
      // GitHub answers 401 for missing AND private repos, so git asks
      // for credentials; with prompts disabled that surfaces as a
      // "could not read Username" failure instead of "not found".
      stderr.includes("could not read username") ||
      stderr.includes("terminal prompts disabled") ||
      stderr.includes("unable to read askpass")
    ) {
      // GitHub answers identically for missing and private repos, and
      // this message deliberately does not distinguish them either.
      throw new ImportError(
        404,
        `Repository ${ref.owner}/${ref.repo} was not found or is private — only public GitHub repositories can be imported.`,
      );
    }
    if (
      stderr.includes("could not resolve host") ||
      stderr.includes("failed to connect") ||
      stderr.includes("connection timed out") ||
      stderr.includes("network is unreachable") ||
      stderr.includes("unable to access")
    ) {
      throw new ImportError(
        502,
        "Could not reach github.com — check the network and try again.",
      );
    }
    throw new ImportError(
      502,
      `git clone failed: ${firstLine(result.stderr, "git clone failed")}`,
    );
  }
  if (!existsSync(path.join(targetDir, ".git"))) {
    throw new ImportError(
      502,
      "Clone finished but no .git directory was created — the import was aborted.",
    );
  }
}

/** Total on-disk size of a directory tree (.git included), aborting the
 * walk as soon as the cap is exceeded. Symlinks are counted as links,
 * never followed. */
export async function workspaceSizeBytes(
  dir: string,
  maxBytes = MAX_IMPORT_BYTES,
): Promise<{ sizeBytes: number; overLimit: boolean }> {
  let total = 0;
  let overLimit = false;
  async function walk(current: string): Promise<void> {
    if (overLimit) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (overLimit) return;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const info = await lstat(absolute).catch(() => null);
      if (info) {
        total += info.size;
        if (total > maxBytes) overLimit = true;
      }
    }
  }
  await walk(dir);
  return { sizeBytes: total, overLimit };
}

/** Narrow secret test for import only: a file is secret-bearing when a
 * path segment is `.env` / `.env.*`, ends `.pem` / `.key`, or contains
 * `credentials` (case-insensitive). Deliberately narrower than the
 * checkpoint deny-list — node_modules, dist, .omp and other non-secret
 * paths are kept verbatim. */
export function isSecretBearingPath(relPath: string): boolean {
  for (const segment of relPath.split("/")) {
    const lower = segment.toLowerCase();
    if (lower === ".env" || lower.startsWith(".env.")) return true;
    if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
    if (lower.includes("credentials")) return true;
  }
  return false;
}

/**
 * Scan a freshly cloned workspace: delete secret-bearing files and
 * report them, list the rules/context files OMP will honor, and count
 * the remaining files. `.git` is never walked (history is preserved
 * as-is) and symlinks are left in place.
 */
export async function scanImportedWorkspace(workspacePath: string): Promise<{
  files: string[];
  excludedSecrets: string[];
  rulesFiles: GitHubImportRulesFile[];
}> {
  const files: string[] = [];
  const excludedSecrets: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" && rel === "") continue;
      const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, entryRel);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (isSecretBearingPath(entryRel)) {
        await unlink(absolute).catch(() => undefined);
        excludedSecrets.push(entryRel);
        continue;
      }
      files.push(entryRel);
    }
  }
  await walk(workspacePath, "");
  const rulesFiles: GitHubImportRulesFile[] = [];
  for (const candidate of IMPORT_RULES_FILES) {
    const absolute = path.join(workspacePath, candidate);
    const info = await stat(absolute).catch(() => null);
    if (info?.isFile())
      rulesFiles.push({ path: candidate, sizeBytes: info.size });
  }
  return { files, excludedSecrets, rulesFiles };
}

/**
 * Harden a cloned repo for the builder: repo-local identity and
 * hooks-off (same values as Milestone C init), remove the origin
 * remote, then read the preserved HEAD and tracked-file count.
 * Removing origin is best-effort — a failure is reported, not fatal.
 */
export async function finalizeClonedRepo(workspacePath: string): Promise<{
  headOid: string;
  fileCount: number;
  remoteRemoved: boolean;
}> {
  for (const [key, value] of [
    ["user.name", GIT_AUTHOR_NAME],
    ["user.email", GIT_AUTHOR_EMAIL],
    ["core.hooksPath", "/dev/null"],
    ["commit.gpgsign", "false"],
  ] as const) {
    const set = await runGit(["config", key, value], workspacePath, 30_000);
    if (set.code !== 0) {
      throw new ImportError(
        500,
        `git config ${key} failed: ${firstLine(set.stderr, "git config failed")}`,
      );
    }
  }
  const remote = await runGit(
    ["remote", "remove", "origin"],
    workspacePath,
    30_000,
  );
  const rev = await runGit(["rev-parse", "HEAD"], workspacePath, 30_000);
  if (rev.code !== 0) {
    throw new ImportError(500, "Could not read the cloned repository HEAD");
  }
  const headOid = rev.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(headOid)) {
    throw new ImportError(500, "Could not read the cloned repository HEAD");
  }
  const ls = await runGit(["ls-files"], workspacePath, 30_000);
  if (ls.code !== 0) {
    throw new ImportError(500, "Could not list the cloned repository files");
  }
  return {
    headOid,
    fileCount: ls.stdout.split("\n").filter(Boolean).length,
    remoteRemoved: remote.code === 0,
  };
}

/**
 * Clone + size-cap + secret scan + finalize. `workspacePath` must be
 * an existing empty directory owned by the API process; the caller
 * removes it (and any DB rows) when this throws. The returned result
 * is what the API hands back with the created project.
 */
export async function importGitHubRepo(
  ref: GitHubRepoRef,
  workspacePath: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<GitHubImportResult> {
  const maxBytes = opts?.maxBytes ?? MAX_IMPORT_BYTES;
  await clonePublicRepo(
    ref,
    workspacePath,
    opts?.timeoutMs ?? CLONE_TIMEOUT_MS,
  );
  const { sizeBytes, overLimit } = await workspaceSizeBytes(
    workspacePath,
    maxBytes,
  );
  if (overLimit) {
    throw new ImportError(
      413,
      `Repository is larger than the ${MAX_IMPORT_BYTES_LABEL} import limit (cloned size ${(sizeBytes / 1024 / 1024).toFixed(1)} MB). Clone a smaller repository, or import only the files you need.`,
    );
  }
  const { excludedSecrets, rulesFiles } =
    await scanImportedWorkspace(workspacePath);
  const { headOid, fileCount, remoteRemoved } =
    await finalizeClonedRepo(workspacePath);
  return {
    owner: ref.owner,
    repo: ref.repo,
    sourceUrl: ref.sourceUrl,
    headOid,
    filesImported: fileCount,
    sizeBytes,
    sizeLimitBytes: maxBytes,
    shallow: true,
    remoteRemoved,
    excludedSecrets,
    rulesFiles,
  };
}
