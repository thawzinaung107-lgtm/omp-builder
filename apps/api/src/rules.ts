import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FileError } from "./files.js";

/**
 * Milestone D (B6) - per-project AI rules, stored as the workspace file
 * `.omp/RULES.md` (the OMP native always-on rules mechanism, per
 * https://omp.sh/docs/context-files). The file IS the storage: OMP only
 * discovers rules from disk at session start, so a DB table would be a
 * second source of truth that OMP never reads.
 *
 * This module is the ONLY writer/reader of that file. The generic file
 * API (files.ts) 403s any path with a `.omp` segment, so rules never go
 * through it and never appear in the file explorer; the Rules tab in the
 * Builder talks to the dedicated GET/PUT /api/projects/:id/rules routes
 * (server.ts) instead.
 *
 * Safety (hard): rules reach the provider on every turn, so they must
 * never carry secrets and must never pull in files from outside the
 * workspace:
 * - Credential-looking content is rejected (a key NAME followed by a
 *   value, known token prefixes, PEM private-key blocks). Plain prose
 *   about secrets ("never commit secrets") is allowed - only a
 *   name/value pair or a token-shaped value is rejected.
 * - `@path` imports are rejected when they escape the workspace (absolute
 *   paths, `~`, any `..` segment, URLs). OMP expands @path imports in
 *   context files, so an outside import would leak host files into the
 *   model context. Plain @mentions (`@david`) and relative in-workspace
 *   imports (`@docs/style.md`) are allowed.
 * - The file is written atomically (temp file in the same directory +
 *   rename), mode 0600. When the API runs as root, the file and its
 *   `.omp` directory are chowned to the omp-builder service user so the
 *   OMP child (which runs as that user) can read them; when the API
 *   already runs as omp-builder this is a no-op. Best-effort: a chown
 *   failure is never fatal here.
 * - Empty content deletes the file (rules off). NUL bytes and content
 *   over MAX_RULES_CHARS are rejected.
 *
 * Lifting `--no-context-files` also enables root AGENTS.md discovery:
 * an imported project AGENTS.md is then honored too. That file is
 * user content (it ships with the project), so it is not blocked - but
 * readProjectRules reports hasRootAgentsMd so the UI can flag it.
 *
 * The milestone-C tests import the built module (apps/api/dist/rules.js):
 * a native .ts import cannot resolve this file ./files.js import
 * under Node type stripping.
 */

export const RULES_REL_PATH = ".omp/RULES.md";
export const RULES_DIR_NAME = ".omp";
export const RULES_FILE_NAME = "RULES.md";
export const MAX_RULES_CHARS = 20_000;

/** A credential NAME followed by an assigned value, e.g. `api_key: abc`. */
const CREDENTIAL_ASSIGNMENT =
  /(?:api[_-]?key|apikey|secret|password|passwd|auth[_-]?token|access[_-]?token|token|bearer|credential)\s*[:=]\s*\S+/i;
/** Token-shaped values and private-key blocks, even without a key name. */
const CREDENTIAL_VALUES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{8,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}/,
  /\bBearer\s+[A-Za-z0-9._\-]{8,}/,
];

/** Resolve the omp-builder service user uid/gid from /etc/passwd. */
function serviceUserIds(): { uid: number; gid: number } {
  const line = readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("omp-builder:"));
  if (!line)
    throw new Error("Service user omp-builder not found in /etc/passwd");
  const fields = line.split(":");
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid))
    throw new Error("Cannot parse uid/gid for omp-builder");
  return { uid, gid };
}

/**
 * Validate rules content. Returns the content unchanged when valid.
 * Throws FileError 400 with a specific reason otherwise.
 */
export function validateRulesContent(content: unknown): string {
  if (typeof content !== "string")
    throw new FileError(400, "Rules content must be a string");
  if (content.includes("\0"))
    throw new FileError(400, "Rules must not contain NUL bytes");
  if (content.length > MAX_RULES_CHARS)
    throw new FileError(
      400,
      `Rules are too long (max ${MAX_RULES_CHARS} characters)`,
    );
  if (CREDENTIAL_ASSIGNMENT.test(content))
    throw new FileError(
      400,
      "Rules must not contain credentials (an API key, token, secret or password value). Rules are sent to the AI model on every turn.",
    );
  for (const pattern of CREDENTIAL_VALUES) {
    if (pattern.test(content))
      throw new FileError(
        400,
        "Rules must not contain credentials (a token or private key). Rules are sent to the AI model on every turn.",
      );
  }
  // OMP expands @path imports in context files. Reject imports that
  // escape the workspace; allow plain mentions and relative in-workspace
  // paths. A token counts as a path import when it contains a slash or
  // backslash, or starts with `.` or `~`.
  const tokens = content.match(/@[^\s"'`]+/g) ?? [];
  for (const raw of tokens) {
    const token = raw.slice(1).replace(/[.,;:!?)\]}]+$/, "");
    if (token === "") continue;
    const looksLikePath =
      token.includes("/") ||
      token.includes("\\") ||
      token.startsWith(".") ||
      token.startsWith("~");
    if (!looksLikePath) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token))
      throw new FileError(400, `Rules must not import a URL (@${token})`);
    if (token.startsWith("/") || token.startsWith("~"))
      throw new FileError(
        400,
        `Rules must not import a path outside the workspace (@${token})`,
      );
    const segments = token.split(/[\\/]/);
    if (segments.some((segment) => segment === ".."))
      throw new FileError(
        400,
        `Rules must not import a path outside the workspace (@${token})`,
      );
  }
  return content;
}

export type ProjectRulesRead = {
  content: string;
  exists: boolean;
  hasRootAgentsMd: boolean;
};

/** Read the project rules file. Missing file -> empty content, exists false. */
export async function readProjectRules(
  workspacePath: string,
): Promise<ProjectRulesRead> {
  const rulesPath = path.join(workspacePath, RULES_DIR_NAME, RULES_FILE_NAME);
  let content = "";
  let exists = false;
  try {
    content = await readFile(rulesPath, "utf8");
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    content,
    exists,
    hasRootAgentsMd: existsSync(path.join(workspacePath, "AGENTS.md")),
  };
}

export type ProjectRulesWrite = { content: string; deleted: boolean };

/**
 * Write (or, when empty, delete) the project rules file. Atomic
 * write via a temp file in the same directory + rename; mode 0600.
 * Returns the stored content and whether the file was deleted.
 */
export async function writeProjectRules(
  workspacePath: string,
  content: string,
): Promise<ProjectRulesWrite> {
  const validated = validateRulesContent(content);
  const dirPath = path.join(workspacePath, RULES_DIR_NAME);
  const rulesPath = path.join(dirPath, RULES_FILE_NAME);
  // Best-effort ownership fix for the root-run API: the OMP child runs
  // as omp-builder and must be able to read this file. When the API
  // already runs as omp-builder this is skipped (chown would fail).
  const fixOwnership = async (target: string): Promise<void> => {
    try {
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        const { uid, gid } = serviceUserIds();
        const { chown } = await import("node:fs/promises");
        await chown(target, uid, gid);
      }
    } catch {
      // Ownership is best-effort; a failure leaves the file owned by the
      // API user, which is correct in the normal (service-user) layout.
    }
  };
  if (validated.trim() === "") {
    await rm(rulesPath, { force: true });
    try {
      // rmdir only succeeds when the dir is empty; other OMP files keep it alive.
      await rmdir(dirPath);
    } catch {
      // .omp is only removed when empty; other OMP files keep it alive.
    }
    return { content: "", deleted: true };
  }
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fixOwnership(dirPath);
  const tempPath = path.join(
    dirPath,
    `.RULES.md.tmp-${process.pid}-${Date.now()}`,
  );
  await writeFile(tempPath, validated, { encoding: "utf8", mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, rulesPath);
  await chmod(rulesPath, 0o600);
  await fixOwnership(rulesPath);
  // Confirm the file landed where OMP will look for it.
  const check = await stat(rulesPath);
  if (!check.isFile())
    throw new FileError(500, "Rules file could not be written");
  return { content: validated, deleted: false };
}
