import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { chmodSync, chownSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { config, envFilePath, isAllowedOrigin, startupDiagnostics } from "./config.js";
import { OmpSessionManager } from "./omp-session-manager.js";
import type { OmpRpcSession } from "./omp-rpc.js";
import { credentialEnvName, decryptSecret, encryptSecret, validateProviderUrl } from "./provider-security.js";
import { FileError, createEntry, deleteEntry, listTree, readTextFile, renameEntry, writeTextFile } from "./files.js";
import { listMedia, parseMultipartUpload, readMediaFile, writeMediaFile } from "./media.js";
import { MEDIA_MAX_BYTES, composePromptWithSelections, pickerSelectionSchema } from "@omp-builder/shared";
import { PreviewError, PreviewManager, serviceUserIds } from "./preview.js";
import { terminateWorkspaceProcesses } from "./workspace-sweep.js";
import { collectProblems } from "./problems.js";
import { MAX_RULES_CHARS, readProjectRules, writeProjectRules } from "./rules.js";
import { GitError, checkpointDiff, checkpointFileStats, createCheckpoint, ensureGitRepo, listCheckpoints, previewCheckpoint, repoState, restoreToCheckpoint, undoLastCheckpoint } from "./git.js";
import { ImportError, importGitHubRepo, parseGitHubRepoUrl } from "./github-import.js";
import { proxyPreviewHttp, proxyPreviewUpgrade } from "./gateway.js";
import { clearPickerEnabled, isPickerEnabled, loadPickerScript, setPickerEnabled } from "./picker.js";
import { WorkspaceWatcher } from "./watcher.js";

const scrypt = promisify(scryptCallback);
const { port, host, cookieName, sessionTtlMs, sessionCookieSecure, databasePath, projectsRoot, sessionRoot, configDir, ompBinary, ompMaxProcesses, ompIdleMs } = config;
const dataRoot = path.dirname(databasePath);
console.log("OMP Builder configuration", { ...startupDiagnostics(), environmentFile: envFilePath });
mkdirSync(path.dirname(databasePath), { recursive: true });
mkdirSync(projectsRoot, { recursive: true, mode: 0o700 });
mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
mkdirSync(configDir, { recursive: true, mode: 0o700 });
chmodSync(sessionRoot, 0o700); chmodSync(configDir, 0o700);
// Phase 3C (§6), narrowed in 3.5 §2: when the API runs as root and any
// project runs OMP as the service user, the session root must stay
// traversable by omp-builder — the chmod above would otherwise reset it
// to root-only on every API restart and break opted-in sessions with
// EACCES. Traverse-only (0710, group omp-builder); the per-project
// session dirs themselves stay 0700 omp-builder-owned. When the API
// itself runs as omp-builder (the post-migration default) this is
// unnecessary — the API already owns the tree — and chown to root would
// fail, so it is skipped.
if (process.getuid?.() === 0 && (config.ompRunAsUserAll || config.ompRunAsUserProjectIds.size > 0)) {
  try {
    const { gid } = serviceUserIds();
    chownSync(sessionRoot, 0, gid);
    chmodSync(sessionRoot, 0o710);
    console.log("[omp] OMP-as-service-user active; session root traversable by omp-builder");
  } catch (error) {
    console.error("[omp] could not make session root traversable for omp-builder:", error instanceof Error ? error.message : error);
  }
}

const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, admin_id TEXT NOT NULL REFERENCES admins(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','ready','running','error')), workspace_path TEXT NOT NULL, model_provider TEXT, model_id TEXT, session_dir TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS omp_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS omp_events_project_id_id ON omp_events(project_id, id);
CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL UNIQUE, base_url TEXT NOT NULL, api TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', key_ciphertext TEXT NOT NULL, key_nonce TEXT NOT NULL, key_tag TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preview_state (project_id TEXT PRIMARY KEY, container_name TEXT NOT NULL, host_port INTEGER NOT NULL, container_port INTEGER NOT NULL, framework TEXT NOT NULL, status TEXT NOT NULL, last_error TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (oid TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, message TEXT NOT NULL, files_changed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS checkpoints_project_id ON checkpoints(project_id);
CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, session_dir TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chat_sessions_project_id ON chat_sessions(project_id, position);
`);
function columns(table: string): Set<string> { return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)); }
function addColumn(table: string, name: string, definition: string): void { if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); }
const migrate = db.transaction(() => { addColumn("projects", "model_provider", "TEXT"); addColumn("projects", "model_id", "TEXT"); addColumn("projects", "session_dir", "TEXT"); const now = new Date().toISOString(); db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(now); db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(now); db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(now); db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)").run(now); // Milestone D (B2) - schema v5: chat_sessions + omp_events.chat_session_id
  // + checkpoints.chat_session_id. Backfill: every project gets a default
  // "Chat 1" (its legacy OMP session dir, so --continue history survives);
  // pre-existing chat-scoped events and non-baseline checkpoints belong
  // to that default chat; project-scoped events (files_modified,
  // preview_*, model_changed) stay NULL.
  db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, session_dir TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chat_sessions_project_id ON chat_sessions(project_id, position);`);
  addColumn("omp_events", "chat_session_id", "TEXT");
  addColumn("checkpoints", "chat_session_id", "TEXT");
  for (const project of db.prepare("SELECT id, session_dir FROM projects").all() as Array<{ id: string; session_dir: string | null }>) {
    const existing = db.prepare("SELECT id FROM chat_sessions WHERE project_id = ? ORDER BY position ASC LIMIT 1").get(project.id) as { id: string } | undefined;
    let chatId = existing?.id;
    if (!chatId) { chatId = randomUUID(); db.prepare("INSERT INTO chat_sessions (id, project_id, title, position, session_dir, created_at, updated_at) VALUES (?, ?, 'Chat 1', 0, ?, ?, ?)").run(chatId, project.id, String(project.session_dir ?? `${sessionRoot}${path.sep}${project.id}`), now, now); }
    db.prepare("UPDATE omp_events SET chat_session_id = ? WHERE project_id = ? AND chat_session_id IS NULL AND type IN ('user_message','prompt_accepted','assistant_delta','assistant_completed','tool_started','tool_progress','tool_finished','tool_error','session_settled','session_status','agent_error')").run(chatId, project.id);
    db.prepare("UPDATE checkpoints SET chat_session_id = ? WHERE project_id = ? AND chat_session_id IS NULL AND session_id != 'baseline'").run(chatId, project.id);
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)").run(now); db.pragma("user_version = 5"); });
migrate();
db.prepare("UPDATE projects SET session_dir = ? || id WHERE session_dir IS NULL OR session_dir = ''").run(`${sessionRoot}${path.sep}`);

const setupSchema = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(256) });
const projectSchema = z.object({ name: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(20_000) });
const importSchema = z.object({ name: z.string().trim().min(1).max(80), url: z.string().trim().min(1).max(500) });
const providerSchema = z.object({ providerId: z.string().trim().min(1).max(120), baseUrl: z.string().trim().min(1).max(500), api: z.enum(["openai-completions", "openai-responses"]), modelId: z.string().trim().min(1).max(200), displayName: z.string().trim().min(1).max(200), apiKey: z.string().min(1).max(10_000), metadata: z.record(z.string(), z.unknown()).optional() });
const providerPatchSchema = z.object({ providerId: z.string().trim().min(1).max(120).optional(), baseUrl: z.string().trim().min(1).max(500).optional(), api: z.enum(["openai-completions", "openai-responses"]).optional(), modelId: z.string().trim().min(1).max(200).optional(), displayName: z.string().trim().min(1).max(200).optional(), apiKey: z.string().min(1).max(10_000).optional(), metadata: z.record(z.string(), z.unknown()).optional() });
const providerTestSchema = z.object({ providerId: z.string().trim().min(1).max(120).optional(), baseUrl: z.string().trim().min(1).max(500), apiKey: z.string().max(10_000).optional() });
const fileWriteSchema = z.object({ path: z.string().min(1).max(1024), content: z.string().max(1_048_576), expectedMtime: z.union([z.number(), z.string()]).optional() });
const fileCreateSchema = z.object({ path: z.string().min(1).max(1024), type: z.enum(["file", "dir"]) });
const fileRenameSchema = z.object({ from: z.string().min(1).max(1024), to: z.string().min(1).max(1024) });
const fileDeleteSchema = z.object({ path: z.string().min(1).max(1024), recursive: z.boolean().optional() });
const restoreSchema = z.object({ discardUncommitted: z.boolean().optional(), chatSessionId: z.string().uuid().optional() });
const checkpointSchema = z.object({ message: z.string().trim().min(1).max(200).optional(), chatSessionId: z.string().uuid().optional() });
const chatCreateSchema = z.object({ title: z.string().trim().min(1).max(80).optional() });
const chatRenameSchema = z.object({ title: z.string().trim().min(1).max(80) });
const chatReorderSchema = z.object({ order: z.array(z.string().uuid()).min(1).max(50) });
const rulesSchema = z.object({ content: z.string().max(MAX_RULES_CHARS) });
const browserCommandSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("prompt"), message: z.string().trim().min(1).max(20_000), chatSessionId: z.string().uuid().optional(), selectedComponents: z.array(pickerSelectionSchema).max(50).optional() }), z.object({ type: z.literal("abort"), chatSessionId: z.string().uuid().optional() }), z.object({ type: z.literal("replay"), afterEventId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }), z.object({ type: z.literal("release_chat"), chatSessionId: z.string().uuid() }), z.object({ type: z.literal("set_model"), provider: z.string().trim().min(1).max(120), modelId: z.string().trim().min(1).max(200) })]);
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const sockets = new Map<string, Set<WebSocket>>();
const seenEvents = new WeakMap<WebSocket, Set<number>>();
function corsOrigin(origin: string | undefined): string | null { return origin && isAllowedOrigin(origin) ? origin : null; }
function setCors(req: IncomingMessage, res: ServerResponse): boolean { const origin = req.headers.origin; if (origin && !corsOrigin(origin)) return false; if (origin) res.setHeader("access-control-allow-origin", origin); res.setHeader("access-control-allow-credentials", "true"); res.setHeader("vary", "Origin"); return true; }
function originMessage(req: IncomingMessage): string { const origin = req.headers.origin; return origin ? `Origin not allowed: ${origin}` : "Origin not allowed"; }
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
function parseCookies(value: string | undefined): Record<string, string> { return Object.fromEntries((value ?? "").split(";").flatMap((part) => { const [key, ...rest] = part.trim().split("="); return key && rest.length ? [[key, decodeURIComponent(rest.join("="))]] : []; })); }
function cookieOptions(): string { const secure = sessionCookieSecure ? "; Secure" : ""; return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`; }
function setSessionCookie(res: ServerResponse, token: string): void { const secure = sessionCookieSecure ? "; Secure" : ""; res.setHeader("set-cookie", `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure}`); }
function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
async function hashPassword(password: string): Promise<{ hash: string; salt: string }> { const salt = randomBytes(16).toString("hex"); const derived = (await scrypt(password, salt, 64)) as Buffer; return { hash: derived.toString("hex"), salt }; }
async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> { const derived = (await scrypt(password, salt, 64)) as Buffer; const expected = Buffer.from(hash, "hex"); return expected.length === derived.length && timingSafeEqual(expected, derived); }
async function body(req: IncomingMessage): Promise<unknown> { let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error("request too large"); } try { return JSON.parse(raw || "{}"); } catch { throw new z.ZodError([]); } }
/** Milestone E (B7) — read a request body as raw bytes (multipart uploads), capped. Binary-safe: chunks are kept as Buffers, never decoded as text. */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> { const chunks: Buffer[] = []; let total = 0; for await (const chunk of req) { const buffer = chunk as Buffer; total += buffer.length; if (total > maxBytes) throw new FileError(413, "Upload exceeds the size limit"); chunks.push(buffer); } return Buffer.concat(chunks); }
function limited(ip: string): boolean { const now = Date.now(); const current = rateBuckets.get(ip); if (!current || current.resetAt <= now) { rateBuckets.set(ip, { count: 1, resetAt: now + 900_000 }); return false; } current.count += 1; return current.count > 10; }
function currentAdmin(req: IncomingMessage): { id: string; email: string } | null { const token = parseCookies(req.headers.cookie)[cookieName]; if (!token) return null; const row = db.prepare("SELECT admins.id, admins.email FROM sessions JOIN admins ON admins.id = sessions.admin_id WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ?").get(tokenHash(token), new Date().toISOString()) as { id: string; email: string } | undefined; return row ?? null; }
async function sessionFor(adminId: string): Promise<string> { const token = randomBytes(32).toString("base64url"); db.prepare("INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), tokenHash(token), adminId, new Date(Date.now() + sessionTtlMs).toISOString(), new Date().toISOString()); return token; }
function isWithin(root: string, target: string): boolean { const relative = path.relative(root, path.resolve(target)); return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); }
function projectRow(id: string): Record<string, unknown> { const row = db.prepare("SELECT id, name, prompt, status, workspace_path, model_provider, model_id, session_dir, created_at, updated_at FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined; if (!row) throw new Error("Project not found"); if (!isWithin(projectsRoot, String(row.workspace_path))) throw new Error("Project workspace is outside the projects root"); if (!row.session_dir || !isWithin(sessionRoot, String(row.session_dir))) throw new Error("Project session directory is outside the session root"); return row; }
function projectView(row: Record<string, unknown>): unknown { return { id: row.id, name: row.name, prompt: row.prompt, status: row.status, model: row.model_provider && row.model_id ? `${row.model_provider}/${row.model_id}` : null, createdAt: row.created_at, updatedAt: row.updated_at }; }
// Milestone D (B2) - chat sessions: many chats per project, one shared
// workspace. A chat row owns its OMP session dir (the project's legacy
// dir for the first chat, a per-chat subdir for later chats); the dir is
// stored once at creation and never changes, so tab reordering can never
// re-point a chat at another chat's conversation history.
function chatView(row: Record<string, unknown>): unknown { return { id: row.id, projectId: row.project_id, title: row.title, position: row.position, createdAt: row.created_at, updatedAt: row.updated_at }; }
function listChats(projectId: string): unknown[] { return (db.prepare("SELECT * FROM chat_sessions WHERE project_id = ? ORDER BY position ASC, created_at ASC").all(projectId) as Record<string, unknown>[]).map(chatView); }
function chatRow(projectId: string, chatId: string): Record<string, unknown> { const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ? AND project_id = ?").get(chatId, projectId) as Record<string, unknown> | undefined; if (!row) throw new Error("Chat not found"); return row; }
function defaultChatId(projectId: string): string {
  const row = db.prepare("SELECT id FROM chat_sessions WHERE project_id = ? ORDER BY position ASC, created_at ASC LIMIT 1").get(projectId) as { id: string } | undefined;
  if (row) return row.id;
  // Belt-and-braces: a project with no chat row (created before the v5
  // migration ran) gets its default chat now.
  const project = projectRow(projectId);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO chat_sessions (id, project_id, title, position, session_dir, created_at, updated_at) VALUES (?, ?, 'Chat 1', 0, ?, ?, ?)").run(id, projectId, String(project.session_dir), now, now);
  return id;
}
function resolveChatId(projectId: string, chatSessionId: string | null | undefined): string {
  if (chatSessionId) { chatRow(projectId, chatSessionId); return chatSessionId; }
  return defaultChatId(projectId);
}
function nextChatTitle(projectId: string): string { const count = (db.prepare("SELECT COUNT(*) AS c FROM chat_sessions WHERE project_id = ?").get(projectId) as { c: number }).c; return `Chat ${count + 1}`; }
function projectRows(): unknown[] { return (db.prepare("SELECT id, name, prompt, status, workspace_path, model_provider, model_id, session_dir, created_at, updated_at FROM projects ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map((row) => { projectRow(String(row.id)); return projectView(row); }); }
function maskedProvider(row: Record<string, unknown>): unknown { return { id: row.id, providerId: row.provider_id, baseUrl: row.base_url, api: row.api, modelId: row.model_id, displayName: row.display_name, hasApiKey: Boolean(row.key_ciphertext), createdAt: row.created_at, updatedAt: row.updated_at }; }
function providerRows(): unknown[] { return (db.prepare("SELECT * FROM providers ORDER BY display_name COLLATE NOCASE").all() as Record<string, unknown>[]).map(maskedProvider); }
function providerById(id: string): Record<string, unknown> | undefined { return db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as Record<string, unknown> | undefined; }
function blockedAddress(address: string): boolean { const normalized = address.toLowerCase(); if (isIP(normalized) === 6) return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized === "::"; if (isIP(normalized) !== 4) return false; const parts = normalized.split(".").map(Number); const [a, b] = parts; return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
async function safeProviderUrl(value: string): Promise<string> { const normalized = validateProviderUrl(value); const parsed = new URL(normalized); const hostname = parsed.hostname.toLowerCase(); if (hostname !== "localhost" && (hostname.endsWith(".local") || hostname.endsWith(".internal"))) throw new Error("Provider URL targets a private network address"); if (hostname !== "localhost") { const addresses = await lookup(hostname, { all: true }); if (addresses.some((address) => blockedAddress(address.address))) throw new Error("Provider URL targets a private network address"); } return normalized; }
function writeModelsConfig(): void { const rows = db.prepare("SELECT provider_id, base_url, api, model_id, display_name FROM providers ORDER BY provider_id").all() as Array<Record<string, string>>; const content = ["# Generated by OMP Builder; credentials are environment references.", rows.length ? "providers:" : "providers: {}", ...rows.map((row) => `  ${JSON.stringify(row.provider_id)}:\n    baseUrl: ${JSON.stringify(row.base_url)}\n    api: ${JSON.stringify(row.api)}\n    apiKey: ${JSON.stringify(credentialEnvName(row.provider_id))}\n    models:\n      - id: ${JSON.stringify(row.model_id)}\n        name: ${JSON.stringify(row.display_name)}\n        contextWindow: 128000\n        maxTokens: 16384`), ""].join("\n"); const temporary = path.join(configDir, `.models-${process.pid}-${randomUUID()}.tmp`); const target = path.join(configDir, "models.yml"); writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, target); chmodSync(target, 0o600); }
async function projectOmpEnvironment(): Promise<NodeJS.ProcessEnv> {
  const rows = db.prepare("SELECT provider_id, key_ciphertext, key_nonce, key_tag FROM providers").all() as Array<Record<string, string>>;
  const env: NodeJS.ProcessEnv = { OMP_CONFIG_DIR: configDir, PI_CODING_AGENT_DIR: configDir };
  for (const row of rows) env[credentialEnvName(row.provider_id)] = decryptSecret(row.key_ciphertext, row.key_nonce, row.key_tag);
  writeModelsConfig();
  return env;
}
function broadcast(projectId: string, event: { type: string; eventId: number; projectId: string; chatSessionId: string | null; payload: Record<string, unknown>; timestamp: string }): void { const peers = sockets.get(projectId); if (!peers) return; for (const ws of peers) sendEvent(ws, event); }
function sendEvent(ws: WebSocket, event: { type: string; eventId: number; projectId: string; chatSessionId: string | null; payload: Record<string, unknown>; timestamp: string }): void { if (ws.readyState !== ws.OPEN) return; const seen = seenEvents.get(ws) ?? new Set<number>(); if (seen.has(event.eventId)) return; seen.add(event.eventId); seenEvents.set(ws, seen); ws.send(JSON.stringify(event)); }
function persistEvent(projectId: string, type: string, payload: Record<string, unknown>, chatSessionId: string | null = null): { id: number; createdAt: string } { const createdAt = new Date().toISOString(); const result = db.prepare("INSERT INTO omp_events (project_id, type, payload_json, created_at, chat_session_id) VALUES (?, ?, ?, ?, ?)").run(projectId, type, JSON.stringify(payload), createdAt, chatSessionId); const id = Number(result.lastInsertRowid); if (type === "user_message" && chatSessionId && typeof payload.message === "string" && payload.message.trim()) { const isFirstPrompt = !(db.prepare("SELECT 1 FROM omp_events WHERE chat_session_id = ? AND type = 'user_message' AND id < ?").get(chatSessionId, id)); if (isFirstPrompt) db.prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?").run(payload.message.trim().slice(0, 40), createdAt, chatSessionId); } broadcast(projectId, { type, eventId: id, projectId, chatSessionId, payload, timestamp: createdAt }); return { id, createdAt }; }
function sendError(ws: WebSocket, message: string, chatSessionId: string | null = null): void { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", message, chatSessionId, timestamp: new Date().toISOString() })); }
function replay(ws: WebSocket, projectId: string, afterEventId = 0): void { const rows = db.prepare("SELECT id, type, payload_json, created_at, chat_session_id FROM omp_events WHERE project_id = ? AND id > ? ORDER BY id ASC").all(projectId, afterEventId) as Array<{ id: number; type: string; payload_json: string; created_at: string; chat_session_id: string | null }>; for (const row of rows) { let payload: Record<string, unknown>; try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { payload = { value: "Invalid persisted event" }; } sendEvent(ws, { type: row.type, eventId: Number(row.id), projectId, chatSessionId: row.chat_session_id ?? null, payload, timestamp: row.created_at }); } }
function updateProject(id: string, values: { status?: string; provider?: string | null; modelId?: string | null }): void { const now = new Date().toISOString(); db.prepare("UPDATE projects SET status = COALESCE(?, status), model_provider = COALESCE(?, model_provider), model_id = COALESCE(?, model_id), updated_at = ? WHERE id = ?").run(values.status ?? null, values.provider ?? null, values.modelId ?? null, now, id); }
const manager = new OmpSessionManager({ binary: ompBinary, projectsRoot, sessionRoot, maxProcesses: ompMaxProcesses, idleMs: ompIdleMs, runAsUserFor: (id) => config.ompRunAsUserAll || config.ompRunAsUserProjectIds.has(id), isProjectAlive: (id) => { try { projectRow(id); return true; } catch { return false; } } });
// Phase 3C — rootless Podman preview manager. preview_log events are
// persisted for the Logs tab but capped at the newest 200 per project.
const previewManager = new PreviewManager({
  db,
  projectsRoot,
  onEvent: (projectId, type, payload) => {
    persistEvent(projectId, type, payload);
    // Milestone E (B3) — picker mode ends with the preview: a stopped,
    // crashed, or errored preview clears the server-side flag (review
    // §5.4), so a later restart never resumes injection unasked. The
    // gateway also requires `running`, so a stale flag alone could
    // never inject — this is the belt-and-braces clearing.
    if (type === "preview_status") {
      const status = payload.status;
      if (typeof status === "string" && (status === "stopped" || status === "crashed" || status === "error")) {
        clearPickerEnabled(projectId);
      }
    }
    if (type === "preview_log") {
      db.prepare("DELETE FROM omp_events WHERE id IN (SELECT id FROM omp_events WHERE project_id = ? AND type = 'preview_log' ORDER BY id DESC LIMIT -1 OFFSET 200)").run(projectId);
    }
  },
});
// Milestone E (B3) — picker script, verified once at startup
// (SHA-256 hash-pinned in picker.ts; null when missing/mismatched —
// injection stays disabled, fail closed).
const pickerScript = loadPickerScript();
// Phase 3D — one files_modified emission per real change. The same edit can
// reach the API three ways (file API write, OMP files_modified event, fs
// watcher seeing the write land on disk). The watcher is the redundant
// channel: it observes writes the other two already reported. So ONLY
// watcher-sourced emissions are deduplicated against a recent identical
// emission — file-API and OMP writes always emit, because two genuine
// edits to the same file seconds apart (edit, then restore) must both
// propagate; deduping those broke the 3C re-sync test.
const recentFilesModified = new Map<string, { files: string[]; at: number }>();
// Milestone C (B1) — after a restore/undo the workspace watcher sees the
// restored files land on disk and would emit a spurious files_modified
// (which the UI would turn into a second "Modified files" card). The
// restore/undo handlers set a short quiet window for watcher-sourced
// emissions only; file-API and OMP emissions are unaffected.
const restoreQuietUntil = new Map<string, number>();
function emitFilesModified(projectId: string, files: string[], workspacePath: string, source: "api" | "omp" | "watcher" = "api"): void {
  const now = Date.now();
  if (source === "watcher") {
    const quietUntil = restoreQuietUntil.get(projectId) ?? 0;
    if (Date.now() < quietUntil) return;
    const previous = recentFilesModified.get(projectId);
    const sameSet =
      previous !== undefined &&
      now - previous.at < 5000 &&
      previous.files.length === files.length &&
      files.every((file) => previous.files.includes(file));
    if (sameSet) return;
  }
  recentFilesModified.set(projectId, { files: [...files], at: now });
  persistEvent(projectId, "files_modified", { files });
  previewManager.notifyFilesChanged(projectId, workspacePath);
}
// Milestone C (B1) — durable checkpoint record (oid -> session mapping
// for Milestone D multi-chat; the commit-message trailer is
// authoritative, this table mirrors it for queries).
function recordCheckpoint(projectId: string, oid: string, sessionId: string, message: string, filesChanged: number, chatSessionId: string | null = null): void {
  db.prepare("INSERT OR IGNORE INTO checkpoints (oid, project_id, session_id, message, files_changed, created_at, chat_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(oid, projectId, sessionId, message, filesChanged, new Date().toISOString(), chatSessionId);
}
// Milestone C (B1) — checkpoint a settled OMP turn: the last user prompt
// (from the persisted user_message event) becomes the commit subject.
// No checkpoint when nothing changed; denied (secret-bearing / runtime)
// files are skipped by createCheckpoint and logged, never committed.
async function createCheckpointForSettle(projectId: string, workspacePath: string, chatSessionId: string): Promise<{ oid: string | null; filesChanged: number; skippedDenied: string[] } | null> {
  const row = db.prepare("SELECT payload_json FROM omp_events WHERE project_id = ? AND chat_session_id = ? AND type = 'user_message' ORDER BY id DESC LIMIT 1").get(projectId, chatSessionId) as { payload_json: string } | undefined;
  let promptSummary: string | undefined;
  if (row) { try { const payload = JSON.parse(row.payload_json) as { message?: unknown }; if (typeof payload.message === "string") promptSummary = payload.message; } catch { /* a corrupt prompt row is not fatal */ } }
  const result = await createCheckpoint(workspacePath, { promptSummary, sessionId: chatSessionId, kind: "ai" });
  if (result.created && result.oid && result.message) {
    recordCheckpoint(projectId, result.oid, chatSessionId, result.message, result.filesChanged, chatSessionId);
    if (result.skippedDenied.length > 0) console.log(`[versions] checkpoint ${result.shortOid} for ${projectId} skipped ${result.skippedDenied.length} denied file(s): ${result.skippedDenied.join(", ")}`);
    return { oid: result.oid, filesChanged: result.filesChanged, skippedDenied: result.skippedDenied };
  }
  return null;
}
// Milestone C (B1) — one-time rollout: initialize git (with a baseline
// commit of the current state) in every existing workspace that has
// none. Best-effort per project, never fatal to startup; already-
// initialized repos are skipped untouched, corrupt ones are logged.
async function migrateVersionHistory(): Promise<void> {
  const rows = db.prepare("SELECT id, workspace_path FROM projects").all() as Array<{ id: string; workspace_path: string }>;
  for (const row of rows) {
    try {
      if (!isWithin(projectsRoot, String(row.workspace_path))) continue;
      const result = await ensureGitRepo(String(row.workspace_path));
      if (result.status === "initialized" && result.baselineOid) {
        recordCheckpoint(row.id, result.baselineOid, "baseline", "Baseline: initial project state", 0);
        console.log(`[versions] initialized git for project ${row.id} (baseline ${result.baselineOid.slice(0, 7)})`);
      } else if (result.status === "corrupt") {
        console.error(`[versions] project ${row.id}: ${result.error ?? "corrupt git repository"}`);
      }
    } catch (error) {
      console.error(`[versions] project ${row.id}: git init failed:`, error instanceof Error ? error.message : error);
    }
  }
}

// Phase 3D — per-open-project workspace watcher (see watcher.ts). Started
// when the first WebSocket client opens a project, stopped when the last
// one leaves; never watches the whole VPS.
const workspaceWatcher = new WorkspaceWatcher();
async function getSession(project: Record<string, unknown>, chatSessionId: string): Promise<OmpRpcSession> { const id = String(project.id); const workspacePath = String(project.workspace_path); if (!isWithin(projectsRoot, workspacePath)) throw new Error("Project workspace is outside the projects root"); const chat = chatRow(id, chatSessionId); const sessionDir = String(chat.session_dir); if (!isWithin(sessionRoot, sessionDir)) throw new Error("Chat session directory is outside the session root"); const provider = project.model_provider ? String(project.model_provider) : undefined; const modelId = project.model_id ? String(project.model_id) : undefined; const env = await projectOmpEnvironment(); return manager.get({ chatSessionId, projectId: id, workspacePath, sessionDir, provider, modelId }, async (type, payload) => { if (type === "files_modified") { const files = Array.isArray((payload as { files?: unknown }).files) ? ((payload as { files: unknown[] }).files.filter((file): file is string => typeof file === "string")) : []; if (files.length > 0) { emitFilesModified(id, files, workspacePath, "omp"); return; } persistEvent(id, type, payload); previewManager.notifyFilesChanged(id, workspacePath); return; } if (type === "session_settled") { const checkpoint = await createCheckpointForSettle(id, workspacePath, chatSessionId).catch((error) => { console.error(`[versions] checkpoint failed for ${id}:`, error instanceof Error ? error.message : error); return null; }); persistEvent(id, type, { ...payload, checkpointOid: checkpoint?.oid ?? null, checkpointFilesChanged: checkpoint?.filesChanged ?? 0, checkpointSkippedDenied: checkpoint?.skippedDenied ?? [] }, chatSessionId); return; } persistEvent(id, type, payload, chatSessionId); }, (error) => { persistEvent(id, "agent_error", { error: error?.message ?? "OMP process exited" }, chatSessionId); updateProject(id, { status: "error" }); void manager.closeChat(chatSessionId); }, env); }
async function testProvider(baseUrl: string, apiKey: string | undefined): Promise<{ ok: boolean; status?: number; error?: string }> { const target = `${await safeProviderUrl(baseUrl)}/models`; const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8_000); try { const headers: Record<string, string> = { accept: "application/json" }; if (apiKey) headers.authorization = `Bearer ${apiKey}`; const response = await fetch(target, { headers, redirect: "manual", signal: controller.signal }); if (response.status >= 300 && response.status < 400) return { ok: false, status: response.status, error: "Provider redirected the request; redirects are not followed" }; if (!response.ok) return { ok: false, status: response.status, error: `Provider returned HTTP ${response.status}` }; return { ok: true, status: response.status }; } catch (error) { return { ok: false, error: error instanceof Error && error.name === "AbortError" ? "Provider request timed out" : "Unable to reach provider" }; } finally { clearTimeout(timeout); } }

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!setCors(req, res)) { json(res, 403, { error: originMessage(req) }); return; }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`); const method = req.method ?? "GET"; const ip = req.socket.remoteAddress ?? "unknown";
  if (method === "OPTIONS") { res.writeHead(204, { "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }); res.end(); return; }
  try {
    if (method === "GET" && url.pathname === "/api/health") { json(res, 200, { ok: true, service: "omp-builder-api" }); return; }
    if (method === "GET" && url.pathname === "/api/auth/status") { const admin = currentAdmin(req); json(res, 200, { setupRequired: !(db.prepare("SELECT 1 FROM admins LIMIT 1").get()), user: admin }); return; }
    if (method === "POST" && (url.pathname === "/api/auth/setup" || url.pathname === "/api/auth/login") && limited(ip)) { json(res, 429, { error: "Too many attempts" }); return; }
    if (method === "POST" && url.pathname === "/api/auth/setup") { if (db.prepare("SELECT 1 FROM admins LIMIT 1").get()) { json(res, 409, { error: "Administrator already configured" }); return; } const input = setupSchema.parse(await body(req)); const password = await hashPassword(input.password); const id = randomUUID(); db.prepare("INSERT INTO admins (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)").run(id, input.email, password.hash, password.salt, new Date().toISOString()); setSessionCookie(res, await sessionFor(id)); json(res, 201, { user: { id, email: input.email } }); return; }
    if (method === "POST" && url.pathname === "/api/auth/login") { const input = setupSchema.parse(await body(req)); const row = db.prepare("SELECT id, email, password_hash, password_salt FROM admins WHERE email = ?").get(input.email) as { id: string; email: string; password_hash: string; password_salt: string } | undefined; if (!row || !(await verifyPassword(input.password, row.password_hash, row.password_salt))) { json(res, 401, { error: "Invalid email or password" }); return; } setSessionCookie(res, await sessionFor(row.id)); json(res, 200, { user: { id: row.id, email: row.email } }); return; }
    if (method === "POST" && url.pathname === "/api/auth/logout") { const token = parseCookies(req.headers.cookie)[cookieName]; if (token) db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").run(new Date().toISOString(), tokenHash(token)); res.setHeader("set-cookie", cookieOptions()); json(res, 200, { ok: true }); return; }
    const admin = currentAdmin(req); if (!admin) { json(res, 401, { error: "Authentication required" }); return; }
    if (method === "GET" && url.pathname === "/api/providers") { json(res, 200, { providers: providerRows() }); return; }
    if (method === "POST" && url.pathname === "/api/providers") { const input = providerSchema.parse(await body(req)); const baseUrl = await safeProviderUrl(input.baseUrl); const encrypted = encryptSecret(input.apiKey); const now = new Date().toISOString(); const id = randomUUID(); db.prepare("INSERT INTO providers (id, provider_id, base_url, api, model_id, display_name, metadata_json, key_ciphertext, key_nonce, key_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.providerId, baseUrl, input.api, input.modelId, input.displayName, JSON.stringify(input.metadata ?? {}), encrypted.ciphertext, encrypted.nonce, encrypted.tag, now, now); writeModelsConfig(); json(res, 201, { provider: maskedProvider(providerById(id)!) }); return; }
    if (method === "POST" && url.pathname === "/api/providers/test") { const input = providerTestSchema.parse(await body(req)); json(res, 200, await testProvider(input.baseUrl, input.apiKey)); return; }
    const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
    if (providerMatch && method === "PATCH") { const id = decodeURIComponent(providerMatch[1]); const existing = providerById(id); if (!existing) { json(res, 404, { error: "Provider not found" }); return; } const input = providerPatchSchema.parse(await body(req)); const baseUrl = input.baseUrl === undefined ? String(existing.base_url) : await safeProviderUrl(input.baseUrl); const encrypted = input.apiKey === undefined ? null : encryptSecret(input.apiKey); const now = new Date().toISOString(); db.prepare("UPDATE providers SET provider_id = ?, base_url = ?, api = ?, model_id = ?, display_name = ?, metadata_json = ?, key_ciphertext = COALESCE(?, key_ciphertext), key_nonce = COALESCE(?, key_nonce), key_tag = COALESCE(?, key_tag), updated_at = ? WHERE id = ?").run(input.providerId ?? existing.provider_id, baseUrl, input.api ?? existing.api, input.modelId ?? existing.model_id, input.displayName ?? existing.display_name, JSON.stringify(input.metadata ?? JSON.parse(String(existing.metadata_json))), encrypted?.ciphertext ?? null, encrypted?.nonce ?? null, encrypted?.tag ?? null, now, id); writeModelsConfig(); json(res, 200, { provider: maskedProvider(providerById(id)!) }); return; }
    if (providerMatch && method === "DELETE") { const id = decodeURIComponent(providerMatch[1]); if (!providerById(id)) { json(res, 404, { error: "Provider not found" }); return; } db.prepare("DELETE FROM providers WHERE id = ?").run(id); writeModelsConfig(); json(res, 200, { ok: true }); return; }
    if (method === "GET" && url.pathname === "/api/projects") { json(res, 200, { projects: projectRows() }); return; }
    if (method === "POST" && url.pathname === "/api/projects") { const input = projectSchema.parse(await body(req)); const id = randomUUID(); const now = new Date().toISOString(); const workspacePath = path.resolve(projectsRoot, id); const projectSessionDir = path.resolve(sessionRoot, id); if (!isWithin(projectsRoot, workspacePath) || !isWithin(sessionRoot, projectSessionDir)) throw new Error("Invalid project path"); mkdirSync(workspacePath, { recursive: true, mode: 0o700 }); mkdirSync(projectSessionDir, { recursive: true, mode: 0o700 }); db.prepare("INSERT INTO projects (id, name, prompt, status, workspace_path, session_dir, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)").run(id, input.name, input.prompt, workspacePath, projectSessionDir, now, now); db.prepare("INSERT INTO chat_sessions (id, project_id, title, position, session_dir, created_at, updated_at) VALUES (?, ?, 'Chat 1', 0, ?, ?, ?)").run(randomUUID(), id, projectSessionDir, now, now); void ensureGitRepo(workspacePath).catch((error) => console.error(`[versions] git init failed for new project ${id}:`, error instanceof Error ? error.message : error)); json(res, 201, { project: projectView({ id, name: input.name, prompt: input.prompt, status: "draft", model_provider: null, model_id: null, created_at: now, updated_at: now }) }); return; }

    // Milestone D (B5) — secure public GitHub repository import.
    // POST /api/projects/import { name, url }: validates the URL
    // (github.com https only, no credentials), shallow-clones the
    // public repo into a fresh workspace, deletes secret-bearing
    // files, preserves the cloned .git history and records a baseline
    // checkpoint at the cloned HEAD. The project row is created only
    // after the clone succeeds; on any failure the workspace and
    // session dir are removed so no orphan project remains. A name
    // already in use (case-insensitive) is a 409 — the caller picks
    // another name, never a silent rename.
    if (method === "POST" && url.pathname === "/api/projects/import") {
      const input = importSchema.parse(await body(req));
      let ref;
      try {
        ref = parseGitHubRepoUrl(input.url);
      } catch (error) {
        throw new ImportError(400, error instanceof Error ? error.message : "Invalid GitHub repository URL");
      }
      const conflict = db.prepare("SELECT id FROM projects WHERE name = ? COLLATE NOCASE").get(input.name);
      if (conflict) { json(res, 409, { error: `A project named "${input.name}" already exists. Choose a different name.` }); return; }
      const id = randomUUID();
      const now = new Date().toISOString();
      const workspacePath = path.resolve(projectsRoot, id);
      const projectSessionDir = path.resolve(sessionRoot, id);
      if (!isWithin(projectsRoot, workspacePath) || !isWithin(sessionRoot, projectSessionDir)) throw new Error("Invalid project path");
      mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
      mkdirSync(projectSessionDir, { recursive: true, mode: 0o700 });
      let result;
      try {
        result = await importGitHubRepo(ref, workspacePath);
      } catch (error) {
        await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
        await rm(projectSessionDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      const prompt = `Imported from ${ref.sourceUrl}`;
      db.prepare("INSERT INTO projects (id, name, prompt, status, workspace_path, session_dir, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)").run(id, input.name, prompt, workspacePath, projectSessionDir, now, now);
      db.prepare("INSERT INTO chat_sessions (id, project_id, title, position, session_dir, created_at, updated_at) VALUES (?, ?, 'Chat 1', 0, ?, ?, ?)").run(randomUUID(), id, projectSessionDir, now, now);
      // Baseline checkpoint at the preserved cloned HEAD (the upstream
      // commit message stays the checkpoint subject in git log; this DB
      // row maps the oid to the import for the Milestone D session map).
      recordCheckpoint(id, result.headOid, "baseline", `Imported from ${ref.sourceUrl}`, result.filesImported, null);
      json(res, 201, { project: projectView({ id, name: input.name, prompt, status: "draft", model_provider: null, model_id: null, created_at: now, updated_at: now }), import: result });
      return;
    }
    // Milestone D (B2) — chat sessions: several chats per project sharing
    // one workspace. All routes are admin-session only (see the auth check
    // above); the project id and chat id are the only inputs. Deleting a
    // chat removes its own events and its per-chat OMP session dir; the
    // default chat's legacy session dir is left alone (it also holds the
    // "chats/" subdir for the remaining chats).
    const chatsMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/chats(?:\/([0-9a-f-]+|reorder))?$/);
    if (chatsMatch) {
      const projectId = chatsMatch[1];
      projectRow(projectId);
      const segment = chatsMatch[2] ?? "";
      if (segment === "" && method === "GET") { json(res, 200, { chats: listChats(projectId) }); return; }
      if (segment === "" && method === "POST") {
        const input = chatCreateSchema.parse(await body(req));
        const now = new Date().toISOString();
        const id = randomUUID();
        const existing = listChats(projectId) as Array<{ id: string }>;
        const sessionDir = existing.length === 0 ? path.join(sessionRoot, projectId) : path.join(sessionRoot, projectId, "chats", id);
        const title = input.title?.trim() ? input.title.trim() : nextChatTitle(projectId);
        db.prepare("INSERT INTO chat_sessions (id, project_id, title, position, session_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, projectId, title, existing.length, sessionDir, now, now);
        json(res, 201, { chat: chatView({ id, project_id: projectId, title, position: existing.length, created_at: now, updated_at: now }) }); return;
      }
      if (segment === "reorder" && method === "POST") {
        const input = chatReorderSchema.parse(await body(req));
        const existingIds = (listChats(projectId) as Array<{ id: string }>).map((entry) => entry.id).sort();
        const orderIds = [...input.order].sort();
        if (existingIds.length !== orderIds.length || existingIds.some((entry, index) => entry !== orderIds[index])) { json(res, 400, { error: "Reorder must list every chat exactly once" }); return; }
        const now = new Date().toISOString();
        db.transaction(() => { input.order.forEach((chatId, index) => { db.prepare("UPDATE chat_sessions SET position = ?, updated_at = ? WHERE id = ? AND project_id = ?").run(index, now, chatId, projectId); }); })();
        json(res, 200, { chats: listChats(projectId) }); return;
      }
      if (/^[0-9a-f-]{36}$/.test(segment)) {
        const chatId = segment;
        if (method === "PATCH") {
          const input = chatRenameSchema.parse(await body(req));
          chatRow(projectId, chatId);
          const now = new Date().toISOString();
          db.prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND project_id = ?").run(input.title.trim(), now, chatId, projectId);
          json(res, 200, { chat: chatView(chatRow(projectId, chatId)) }); return;
        }
        if (method === "DELETE") {
          const chats = listChats(projectId) as Array<{ id: string }>;
          if (chats.length <= 1) { json(res, 409, { error: "Cannot delete the last chat of a project" }); return; }
          const chat = chatRow(projectId, chatId);
          const live = manager.peek(chatId);
          if (live?.isBusy) { json(res, 409, { error: "Chat is busy — wait for its turn to finish before deleting it" }); return; }
          await manager.closeChat(chatId);
          db.prepare("DELETE FROM omp_events WHERE project_id = ? AND chat_session_id = ?").run(projectId, chatId);
          db.prepare("DELETE FROM chat_sessions WHERE id = ? AND project_id = ?").run(chatId, projectId);
          const dir = String(chat.session_dir);
          if (dir.includes(`${path.sep}chats${path.sep}`)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
          json(res, 200, { ok: true }); return;
        }
      }
      json(res, 404, { error: "Not found" }); return;
    }
    // Phase 3A — workspace file APIs (admin session required, see above).
    const filesMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/files(?:\/(content|rename))?$/);
    if (filesMatch) {
      const projectId = filesMatch[1];
      const suffix = filesMatch[2] ?? "";
      const project = projectRow(projectId);
      const workspacePath = String(project.workspace_path);
      if (method === "GET" && suffix === "") { json(res, 200, { tree: await listTree(projectsRoot, projectId) }); return; }
      if (method === "GET" && suffix === "content") {
        const relPath = url.searchParams.get("path");
        if (relPath === null) { json(res, 400, { error: "path query parameter is required" }); return; }
        json(res, 200, await readTextFile(projectsRoot, projectId, relPath)); return;
      }
      if (method === "PUT" && suffix === "content") {
        const input = fileWriteSchema.parse(await body(req));
        const result = await writeTextFile(projectsRoot, projectId, input.path, input.content, input.expectedMtime);
        emitFilesModified(projectId, [result.path], workspacePath);
        updateProject(projectId, {});
        json(res, 200, result); return;
      }
      if (method === "POST" && suffix === "") {
        const input = fileCreateSchema.parse(await body(req));
        const entry = await createEntry(projectsRoot, projectId, input.path, input.type);
        emitFilesModified(projectId, [entry.path], workspacePath);
        updateProject(projectId, {});
        json(res, 201, { entry }); return;
      }
      if (method === "PATCH" && suffix === "rename") {
        const input = fileRenameSchema.parse(await body(req));
        const result = await renameEntry(projectsRoot, projectId, input.from, input.to);
        emitFilesModified(projectId, [result.to], workspacePath);
        updateProject(projectId, {});
        json(res, 200, result); return;
      }
      if (method === "DELETE" && suffix === "") {
        const input = fileDeleteSchema.parse(await body(req));
        const result = await deleteEntry(projectsRoot, projectId, input.path, input.recursive);
        emitFilesModified(projectId, [result.path], workspacePath);
        updateProject(projectId, {});
        json(res, 200, { ok: true, ...result }); return;
      }
      json(res, 404, { error: "Not found" }); return;
    }
    // Milestone E (B7) — project media (images under workspace `images/`).
    // Admin session required (see the auth check above); the project id
    // and a single image filename are the only inputs. Uploads are
    // multipart/form-data with a single `file` part; bytes are validated
    // (type allow-list, 5 MB cap, magic-byte check) in media.ts. GET
    // serves bytes with the image content-type and `no-store` — the
    // authenticated thumbnail route (no public URL; the preview gateway
    // cannot serve workspace files when the preview is stopped).
    const mediaMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/media(?:\/([^/]+))?$/);
    if (mediaMatch) {
      const projectId = mediaMatch[1];
      const rawName = mediaMatch[2] === undefined ? "" : mediaMatch[2];
      const project = projectRow(projectId);
      const workspacePath = String(project.workspace_path);
      let name = "";
      if (rawName !== "") {
        try {
          name = decodeURIComponent(rawName);
        } catch {
          json(res, 400, { error: "Invalid image name" });
          return;
        }
      }
      if (method === "GET" && name === "") {
        json(res, 200, { images: await listMedia(projectsRoot, projectId) });
        return;
      }
      if (method === "GET" && name !== "") {
        const file = await readMediaFile(projectsRoot, projectId, name);
        res.writeHead(200, {
          "content-type": file.mimeType,
          "content-length": String(file.size),
          "cache-control": "no-store",
          "content-disposition": `inline; filename="${file.name}"`,
        });
        res.end(file.data);
        return;
      }
      if ((method === "POST" && name === "") || (method === "PUT" && name !== "")) {
        const upload = parseMultipartUpload(await readRawBody(req, MEDIA_MAX_BYTES + 65_536), req.headers["content-type"]);
        const saved = await writeMediaFile(projectsRoot, projectId, upload.filename, upload.data, {
          replace: method === "PUT",
          targetName: name === "" ? undefined : name,
        });
        emitFilesModified(projectId, [saved.path], workspacePath);
        updateProject(projectId, {});
        json(res, method === "POST" ? 201 : 200, { image: saved });
        return;
      }
      json(res, 404, { error: "Not found" });
      return;
    }
    // Phase 3C — rootless Podman preview manager (admin session required).
    const previewMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/preview(?:\/(start|stop|restart|rebuild|status|logs))?$/);
    if (previewMatch) {
      const projectId = previewMatch[1];
      const action = previewMatch[2] ?? "";
      const project = projectRow(projectId);
      const workspacePath = String(project.workspace_path);
      if (method === "POST" && action === "start") { json(res, 200, { preview: await previewManager.start(projectId, workspacePath) }); return; }
      if (method === "POST" && action === "stop") { json(res, 200, { preview: await previewManager.stop(projectId) }); return; }
      if (method === "POST" && action === "restart") { json(res, 200, { preview: await previewManager.restart(projectId, workspacePath) }); return; }
      if (method === "POST" && action === "rebuild") { json(res, 200, { preview: await previewManager.rebuild(projectId, workspacePath) }); return; }
      if (method === "GET" && action === "status") { json(res, 200, { preview: await previewManager.getStatus(projectId) }); return; }
      if (method === "GET" && action === "logs") {
        const tail = Number(url.searchParams.get("tail") ?? 200);
        json(res, 200, await previewManager.logs(projectId, Number.isFinite(tail) ? tail : 200));
        return;
      }
      json(res, 404, { error: "Not found" }); return;
    }
    // Milestone E (B3) — element picker mode: a server-side per-project
    // flag (review §5.4). Authenticated admin only (see the auth check
    // above); the project id is the only path input. GET reports the
    // flag; POST sets it. It is NEVER a query parameter — the iframe
    // could set one itself — and it is cleared when the preview stops,
    // crashes, or errors (preview_status handler above) and on API
    // restart (in-memory by design).
    const pickerMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/preview\/picker$/);
    if (pickerMatch) {
      const projectId = pickerMatch[1];
      projectRow(projectId);
      if (method === "GET") {
        json(res, 200, { enabled: isPickerEnabled(projectId) });
        return;
      }
      if (method === "POST") {
        const input = z.object({ enabled: z.boolean() }).parse(await body(req));
        setPickerEnabled(projectId, input.enabled);
        json(res, 200, { enabled: input.enabled });
        return;
      }
      json(res, 404, { error: "Not found" });
      return;
    }
    // Milestone A (A4) — structured problems. Endpoint (not a second WS
    // event type): the WS channel already streams the raw preview_log
    // lines, so a derived problems_report stream would duplicate that
    // data and need a per-line recompute. The endpoint instead computes
    // the same structured view on demand from the persisted log store
    // the Logs tab already uses (newest 200 preview_log lines), plus
    // the preview_state lastError for a crashed/errored preview. The
    // frontend refreshes it on preview_status events, debounced after
    // preview_log bursts, and on manual refresh. Admin session required
    // (see the auth check above); the project id is the only input.
    const problemsMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/problems$/);
    if (problemsMatch && method === "GET") {
      const projectId = problemsMatch[1];
      projectRow(projectId);
      const rows = db
        .prepare("SELECT payload_json FROM omp_events WHERE project_id = ? AND type = 'preview_log' ORDER BY id DESC LIMIT 200")
        .all(projectId) as Array<{ payload_json: string }>;
      const lines: string[] = [];
      for (const row of rows.reverse()) {
        try {
          const payload = JSON.parse(row.payload_json) as { line?: unknown };
          if (typeof payload.line === "string") lines.push(payload.line);
        } catch {
          // A corrupt persisted line is skipped, not fatal.
        }
      }
      const preview = previewManager.row(projectId);
      json(res, 200, { problems: collectProblems(lines, preview), updatedAt: new Date().toISOString() });
      return;
    }
    // Milestone D (B6) — per-project AI rules, stored as .omp/RULES.md
    // (OMP native always-on rules). Admin session required (see the auth
    // check above); the project id is the only path input. Saving closes
    // every live OMP child of the project: rules are discovered only when
    // OMP builds a new session, so the next prompt spawns a fresh child
    // that reads the new file. A save is refused while a turn is running
    // (closing the child mid-turn would fail the prompt).
    const rulesMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/rules$/);
    if (rulesMatch) {
      const projectId = rulesMatch[1];
      const project = projectRow(projectId);
      const workspacePath = String(project.workspace_path);
      if (method === "GET") {
        json(res, 200, await readProjectRules(workspacePath));
        return;
      }
      if (method === "PUT") {
        const input = rulesSchema.parse(await body(req));
        const live = manager.liveChatSessionIds(projectId);
        for (const chatId of live) {
          if (manager.peek(chatId)?.isBusy) {
            json(res, 409, { error: "An OMP turn is running — wait for it to finish before saving rules" });
            return;
          }
        }
        const result = await writeProjectRules(workspacePath, input.content);
        await manager.closeProject(projectId);
        const after = await readProjectRules(workspacePath);
        json(res, 200, { ...result, sessionsRestarted: live.length, hasRootAgentsMd: after.hasRootAgentsMd });
        return;
      }
      json(res, 404, { error: "Not found" });
      return;
    }
    // Milestone C (B1) — Git-backed version history. All routes are
    // admin-session only (see the auth check above); the project id is
    // the only path input and oids are validated as hex before any git
    // call. Restores/undos refuse on uncommitted changes unless the
    // caller explicitly confirms discarding them.
    const versionsMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/versions(?:\/([^/]+)(?:\/(diff|preview|restore))?)?$/);
    if (versionsMatch) {
      const projectId = versionsMatch[1];
      const segment = versionsMatch[2] ?? "";
      const subAction = versionsMatch[3] ?? "";
      const project = projectRow(projectId);
      const workspacePath = String(project.workspace_path);
      const stagingRoot = path.join(dataRoot, "version-staging");
      if (segment === "" && method === "GET") {
        const state = await repoState(workspacePath);
        const checkpoints = state.initialized ? await listCheckpoints(workspacePath) : [];
        json(res, 200, { status: state, checkpoints });
        return;
      }
      if (segment === "init" && method === "POST") {
        const result = await ensureGitRepo(workspacePath);
        if (result.status === "corrupt") { json(res, 409, { error: result.error ?? "Workspace git repository is corrupt" }); return; }
        if (result.status === "initialized" && result.baselineOid) recordCheckpoint(projectId, result.baselineOid, "baseline", "Baseline: initial project state", 0);
        const state = await repoState(workspacePath);
        json(res, 200, { status: state, init: result.status, baselineOid: result.baselineOid });
        return;
      }
      if (segment === "checkpoint" && method === "POST") {
        const input = checkpointSchema.parse(await body(req));
        const chatId = resolveChatId(projectId, input.chatSessionId ?? null);
        const result = await createCheckpoint(workspacePath, { sessionId: chatId, kind: "manual", manualMessage: input.message });
        if (result.created && result.oid && result.message) recordCheckpoint(projectId, result.oid, chatId, result.message, result.filesChanged, chatId);
        json(res, 200, { checkpoint: result });
        return;
      }
      if (segment === "undo" && method === "POST") {
        const input = restoreSchema.parse(await body(req));
        const chatId = resolveChatId(projectId, input.chatSessionId ?? null);
        const result = await undoLastCheckpoint(workspacePath, { discardUncommitted: input.discardUncommitted === true, sessionId: chatId });
        if (result.created && result.oid && result.message) recordCheckpoint(projectId, result.oid, chatId, result.message, result.filesChanged, chatId);
        restoreQuietUntil.set(projectId, Date.now() + 5000);
        json(res, 200, { undo: result });
        return;
      }
      if (/^[0-9a-f]{7,40}$/.test(segment)) {
        if (method === "GET" && subAction === "") {
          const checkpoints = await listCheckpoints(workspacePath);
          const checkpoint = checkpoints.find((entry) => entry.oid === segment || entry.shortOid === segment);
          if (!checkpoint) { json(res, 404, { error: "Checkpoint not found" }); return; }
          json(res, 200, { checkpoint, files: await checkpointFileStats(workspacePath, checkpoint.oid) });
          return;
        }
        if (method === "GET" && subAction === "diff") {
          const against = url.searchParams.get("against");
          if (against !== null && !/^[0-9a-f]{7,40}$/.test(against)) { json(res, 400, { error: "Invalid against checkpoint" }); return; }
          json(res, 200, await checkpointDiff(workspacePath, against, segment));
          return;
        }
        if (method === "POST" && subAction === "preview") {
          json(res, 200, { preview: await previewCheckpoint(workspacePath, stagingRoot, projectId, segment) });
          return;
        }
        if (method === "POST" && subAction === "restore") {
          const input = restoreSchema.parse(await body(req));
          const chatId = resolveChatId(projectId, input.chatSessionId ?? null);
          const result = await restoreToCheckpoint(workspacePath, segment, { discardUncommitted: input.discardUncommitted === true, sessionId: chatId, kind: "restore" });
          if (result.created && result.oid && result.message) recordCheckpoint(projectId, result.oid, chatId, result.message, result.filesChanged, chatId);
          restoreQuietUntil.set(projectId, Date.now() + 5000);
          json(res, 200, { restore: result });
          return;
        }
      }
      json(res, 404, { error: "Not found" }); return;
    }
    // the auth check above). The ONLY upstream is the container's loopback
    // port from the preview_state DB row for this project — the client
    // supplies no host, port, or target of any kind (no SSRF). Only
    // GET/HEAD are proxied; /api/* is never passed through, so generated
    // preview code cannot reach Builder APIs through the gateway.
    const gatewayMatch = url.pathname.match(/^\/api\/preview\/([0-9a-f-]+)(?:\/(.*))?$/);
    if (gatewayMatch && (method === "GET" || method === "HEAD")) {
      const projectId = gatewayMatch[1];
      projectRow(projectId);
      const rawSub = gatewayMatch[2] ?? "";
      if (rawSub === "" && !url.pathname.endsWith("/")) {
        res.writeHead(302, { location: `${url.pathname}/${url.search}` });
        res.end();
        return;
      }
      let segments: string[];
      try {
        segments = rawSub
          .split("/")
          .filter((segment) => segment !== "")
          .map((segment) => decodeURIComponent(segment));
      } catch {
        json(res, 400, { error: "Invalid preview path" });
        return;
      }
      if (segments.some((segment) => segment === ".." || segment === "." || segment.includes("\0") || segment.includes("\\"))) {
        json(res, 400, { error: "Invalid preview path" });
        return;
      }
      if (segments[0] === "api") {
        json(res, 403, { error: "Preview gateway does not proxy Builder API paths" });
        return;
      }
      const state = previewManager.row(projectId);
      if (!state || state.status !== "running") {
        json(res, 503, { error: "Preview is not running for this project. Start it from the Preview tab first." });
        return;
      }
      const targetPath = `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}${url.search}`;
      // Milestone E (B3) — the gateway injects the verified picker script
      // ONLY when picker mode is on for this project (server-side flag);
      // otherwise the response streams unmodified (see gateway.ts).
      await proxyPreviewHttp(req, res, targetPath, state.hostPort, {
        pickerScript: isPickerEnabled(projectId) ? pickerScript : null,
      });
      return;
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)(?:\/session)?$/);
    // Phase 3.5 (§5 fix) — project deletion. There was no delete route at
    // all: the only deletion path was a direct DB delete in test cleanup,
    // which left the project's OMP child alive holding a pool slot (and
    // any dev-server tree the agent had started). Deleting through the API
    // closes the OMP session first (freeing its pool slot), stops the
    // preview, sweeps any process still rooted in the workspace, and only
    // then removes the DB rows, workspace and session dir. The API runs as
    // omp-builder, so a workspace containing directories owned by another
    // user (e.g. root-owned subdirs written by a root-run test) cannot
    // always be removed by it: the removal result is reported in the
    // response instead of being silently swallowed, so the caller can
    // finish the removal with the privileges it has. Preview staging
    // and the node_modules volume are not removed here (PreviewManager
    // owns those); callers that need a fully clean host remove them too.
    if (projectMatch && method === "DELETE") {
      const id = projectMatch[1];
      const row = projectRow(id);
      const workspacePath = String(row.workspace_path);
      const sessionDir = String(row.session_dir);
      const peers = sockets.get(id);
      if (peers) { for (const ws of peers) { try { ws.close(1000, "Project deleted"); } catch { /* already closed */ } } sockets.delete(id); }
      workspaceWatcher.unwatch(id);
      await previewManager.stop(id).catch(() => undefined);
      await manager.closeProject(id);
      const swept = await terminateWorkspaceProcesses(workspacePath);
      db.prepare("DELETE FROM omp_events WHERE project_id = ?").run(id);
      db.prepare("DELETE FROM checkpoints WHERE project_id = ?").run(id);
      db.prepare("DELETE FROM chat_sessions WHERE project_id = ?").run(id);
      await rm(path.join(dataRoot, "version-staging", id), { recursive: true, force: true }).catch(() => undefined);
      db.prepare("DELETE FROM preview_state WHERE project_id = ?").run(id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
      await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
      const workspaceRemoved = !existsSync(workspacePath);
      const sessionDirRemoved = !existsSync(sessionDir);
      if (swept.killed.length > 0 || swept.survivors.length > 0) console.log(`[project] deleted ${id}; workspace sweep terminated PIDs ${swept.killed.join(", ") || "none"}; survivors: ${swept.survivors.join(", ") || "none"}`);
      if (!workspaceRemoved || !sessionDirRemoved) console.log(`[project] deleted ${id} but could not remove ${[!workspaceRemoved ? "workspace" : "", !sessionDirRemoved ? "session dir" : ""].filter(Boolean).join(" and ")} (owned by another user?)`);
      json(res, 200, { ok: true, sweptProcesses: swept.killed, sweepSurvivors: swept.survivors, workspaceRemoved, sessionDirRemoved });
      return;
    }
    if (projectMatch && method === "GET" && url.pathname.endsWith("/session")) { const row = projectRow(projectMatch[1]); const after = Number(url.searchParams.get("afterEventId") ?? 0); const events = (db.prepare("SELECT id, project_id, type, payload_json, created_at, chat_session_id FROM omp_events WHERE project_id = ? AND id > ? ORDER BY id ASC").all(projectMatch[1], Number.isSafeInteger(after) && after >= 0 ? after : 0) as Array<Record<string, unknown>>).map((event) => ({ id: Number(event.id), projectId: event.project_id, type: event.type, payload: JSON.parse(String(event.payload_json)), createdAt: event.created_at, chatSessionId: (event.chat_session_id as string | null) ?? null })); json(res, 200, { project: projectView(row), events }); return; }
    if (projectMatch && method === "GET") { const row = projectRow(projectMatch[1]); json(res, 200, { project: projectView(row) }); return; }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof PreviewError) {
      json(res, error.status, { error: error.message });
      return;
    }
    if (error instanceof ImportError) {
      json(res, error.status, { error: error.message });
      return;
    }
    if (error instanceof GitError) {
      json(res, error.status, { error: error.message });
      return;
    }
    if (error instanceof FileError) {
      const extra = error as FileError & { mtime?: string; mtimeMs?: number };
      json(res, error.status, { error: error.message, ...(extra.mtime !== undefined ? { mtime: extra.mtime, mtimeMs: extra.mtimeMs } : {}) });
      return;
    }
    const inputError = error instanceof z.ZodError; const message = inputError ? "Invalid request" : error instanceof Error ? error.message : "Request failed"; const badRequest = inputError || message.startsWith("Provider URL") || message.startsWith("Provider URL targets") || message === "request too large"; json(res, badRequest ? 400 : message === "Project not found" || message === "Provider not found" || message === "Chat not found" ? 404 : 500, { error: message }); }
}

const server = createServer((req, res) => { void handle(req, res); });
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  // Phase 3D — Vite HMR upgrade through the preview gateway. The Vite
  // wrapper config pins hmr.path to /api/preview/<projectId>/__hmr, so the
  // browser asks for exactly this path and the container expects it.
  // Origin "null" is the sandboxed preview iframe (no allow-same-origin):
  // it carries no usable credential for a cross-site attacker because the
  // session cookie is HttpOnly + SameSite=Lax, so it is accepted here
  // alongside allowed origins; any other origin is rejected.
  const gatewayMatch = url.pathname.match(/^\/api\/preview\/([0-9a-f-]+)\/__hmr$/);
  if (gatewayMatch) {
    const origin = req.headers.origin;
    if (origin && origin !== "null" && !corsOrigin(origin)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
    const admin = currentAdmin(req);
    if (!admin) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    try { projectRow(gatewayMatch[1]); } catch { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }
    const state = previewManager.row(gatewayMatch[1]);
    if (!state || state.status !== "running") { socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); socket.destroy(); return; }
    proxyPreviewUpgrade(req, socket, head, state.hostPort);
    return;
  }
  const match = url.pathname.match(/^\/ws\/projects\/([0-9a-f-]+)$/); const admin = currentAdmin(req); const origin = req.headers.origin;
  if (origin && !corsOrigin(origin)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; } if (!match || !admin) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
  try { projectRow(match[1]); } catch { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; } wss.handleUpgrade(req, socket, head, (ws) => { wss.emit("connection", ws, req, match[1]); });
});
wss.on("connection", (ws: WebSocket, _req: IncomingMessage, projectId?: string) => {
  if (!projectId) { ws.close(1008, "Project is required"); return; }
  const peers = sockets.get(projectId) ?? new Set<WebSocket>(); peers.add(ws); sockets.set(projectId, peers); seenEvents.set(ws, new Set());
  // Phase 3D — watch this project's workspace while a client has it open.
  // The watcher dedupes against file-API and OMP emissions (see
  // emitFilesModified), so an edit surfaces once, not three times.
  try {
    const project = projectRow(projectId);
    workspaceWatcher.watch(projectId, String(project.workspace_path), (changedProjectId, files) => {
      try {
        const row = projectRow(changedProjectId);
        emitFilesModified(changedProjectId, files, String(row.workspace_path), "watcher");
      } catch {
        // Project deleted while watched; the close handler unwatches.
      }
    });
  } catch {
    // Project row missing; the session start below reports the error.
  }
  // Milestone D (B2) - lazy OMP: opening the Builder no longer starts an
  // OMP child (that would hold a pool slot for every open tab). The child
  // starts on the first prompt for a chat. The persisted "connected"
  // event keeps the client's session-ready wait working.
  void (async () => { try { const project = projectRow(projectId); defaultChatId(projectId); persistEvent(projectId, "session_status", { state: "connected" }); replay(ws, projectId); } catch (error) { sendError(ws, error instanceof Error ? error.message : "Unable to open project session"); } })();
  ws.on("message", (raw) => { let input: unknown; try { input = JSON.parse(raw.toString()); } catch { sendError(ws, "Malformed command"); return; } const parsed = browserCommandSchema.safeParse(input); if (!parsed.success) { sendError(ws, "Unknown or malformed command"); return; } void (async () => { let commandChatId: string | null = null; try { const project = projectRow(projectId); const command = parsed.data; commandChatId = "chatSessionId" in command ? (command.chatSessionId ?? null) : null; if (command.type === "replay") { replay(ws, projectId, command.afterEventId ?? 0); return; } if (command.type === "release_chat") { const chatId = resolveChatId(projectId, command.chatSessionId); await manager.closeChatIfIdle(chatId); return; } if (command.type === "prompt") { const chatId = resolveChatId(projectId, command.chatSessionId ?? null); const session = await getSession(project, chatId); updateProject(projectId, { status: "running" }); const composedMessage = command.selectedComponents?.length ? composePromptWithSelections(command.message, command.selectedComponents.map((selection) => selection.component)) : command.message; persistEvent(projectId, "user_message", { message: composedMessage }, chatId); await session.prompt(composedMessage); return; } if (command.type === "abort") { const chatId = resolveChatId(projectId, command.chatSessionId ?? null); const live = manager.peek(chatId); if (live) await live.abort(); return; } const provider = db.prepare("SELECT provider_id, model_id FROM providers WHERE provider_id = ? AND model_id = ?").get(command.provider, command.modelId) as { provider_id: string; model_id: string } | undefined; if (!provider) { sendError(ws, "Provider or model is not available"); return; } const liveChats = manager.liveChatSessionIds(projectId); for (const chatId of liveChats) { const liveSession = manager.peek(chatId); if (liveSession) await liveSession.setModel(provider.provider_id, provider.model_id); } updateProject(projectId, { provider: provider.provider_id, modelId: provider.model_id }); if (liveChats.length === 0) persistEvent(projectId, "model_changed", { provider: provider.provider_id, modelId: provider.model_id }); } catch (error) { sendError(ws, error instanceof Error ? error.message : "OMP command failed", commandChatId); } })(); });
  ws.on("close", () => { peers.delete(ws); seenEvents.delete(ws); if (!peers.size) { sockets.delete(projectId); workspaceWatcher.unwatch(projectId); } });
});
const idleTimer = setInterval(() => { void manager.closeIdle(); }, Math.min(ompIdleMs, 60_000));
let shuttingDown = false;
async function shutdown(): Promise<void> { if (shuttingDown) return; shuttingDown = true; clearInterval(idleTimer); workspaceWatcher.close(); await previewManager.close(); await manager.closeAll(); await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void shutdown().finally(() => process.exit(0)); });
server.listen(port, host, () => console.log(`OMP Builder API listening on http://${host}:${port}`));
// Phase 3C: reconcile recorded preview state with actual Podman state on
// every API start (stale rows marked, abandoned containers removed).
void previewManager.reconcile().then((result) => {
  if (result.removedAbandoned.length || result.markedStale.length) console.log("[preview] startup reconcile:", result);
}).catch((error) => console.error("[preview] startup reconcile failed:", error instanceof Error ? error.message : error));
// Milestone C (B1) — roll out git init + baseline commits to existing
// workspaces (best-effort, per-project; never blocks startup).
void migrateVersionHistory().catch((error) => console.error("[versions] startup migration failed:", error instanceof Error ? error.message : error));
