import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { chmodSync, chownSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
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
import { PreviewError, PreviewManager, serviceUserIds } from "./preview.js";
import { proxyPreviewHttp, proxyPreviewUpgrade } from "./gateway.js";
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
// Phase 3C (§6): when any project is opted into OMP-as-service-user, the
// session root must stay traversable by omp-builder — the chmod above
// would otherwise reset it to root-only on every API restart and break
// opted-in sessions with EACCES. Traverse-only (0710, group omp-builder);
// the per-project session dirs themselves stay 0700 omp-builder-owned.
if (config.ompRunAsUserProjectIds.size > 0) {
  try {
    const { gid } = serviceUserIds();
    chownSync(sessionRoot, 0, gid);
    chmodSync(sessionRoot, 0o710);
    console.log(`[omp] ${config.ompRunAsUserProjectIds.size} project(s) opted into OMP-as-service-user; session root traversable by omp-builder`);
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
`);
function columns(table: string): Set<string> { return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)); }
function addColumn(table: string, name: string, definition: string): void { if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); }
const migrate = db.transaction(() => { addColumn("projects", "model_provider", "TEXT"); addColumn("projects", "model_id", "TEXT"); addColumn("projects", "session_dir", "TEXT"); const now = new Date().toISOString(); db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(now); db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(now); db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(now); db.pragma("user_version = 3"); });
migrate();
db.prepare("UPDATE projects SET session_dir = ? || id WHERE session_dir IS NULL OR session_dir = ''").run(`${sessionRoot}${path.sep}`);

const setupSchema = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(256) });
const projectSchema = z.object({ name: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(20_000) });
const providerSchema = z.object({ providerId: z.string().trim().min(1).max(120), baseUrl: z.string().trim().min(1).max(500), api: z.enum(["openai-completions", "openai-responses"]), modelId: z.string().trim().min(1).max(200), displayName: z.string().trim().min(1).max(200), apiKey: z.string().min(1).max(10_000), metadata: z.record(z.string(), z.unknown()).optional() });
const providerPatchSchema = z.object({ providerId: z.string().trim().min(1).max(120).optional(), baseUrl: z.string().trim().min(1).max(500).optional(), api: z.enum(["openai-completions", "openai-responses"]).optional(), modelId: z.string().trim().min(1).max(200).optional(), displayName: z.string().trim().min(1).max(200).optional(), apiKey: z.string().min(1).max(10_000).optional(), metadata: z.record(z.string(), z.unknown()).optional() });
const providerTestSchema = z.object({ providerId: z.string().trim().min(1).max(120).optional(), baseUrl: z.string().trim().min(1).max(500), apiKey: z.string().max(10_000).optional() });
const fileWriteSchema = z.object({ path: z.string().min(1).max(1024), content: z.string().max(1_048_576), expectedMtime: z.union([z.number(), z.string()]).optional() });
const fileCreateSchema = z.object({ path: z.string().min(1).max(1024), type: z.enum(["file", "dir"]) });
const fileRenameSchema = z.object({ from: z.string().min(1).max(1024), to: z.string().min(1).max(1024) });
const fileDeleteSchema = z.object({ path: z.string().min(1).max(1024), recursive: z.boolean().optional() });
const browserCommandSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("prompt"), message: z.string().trim().min(1).max(20_000) }), z.object({ type: z.literal("abort") }), z.object({ type: z.literal("replay"), afterEventId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }), z.object({ type: z.literal("set_model"), provider: z.string().trim().min(1).max(120), modelId: z.string().trim().min(1).max(200) })]);
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
function limited(ip: string): boolean { const now = Date.now(); const current = rateBuckets.get(ip); if (!current || current.resetAt <= now) { rateBuckets.set(ip, { count: 1, resetAt: now + 900_000 }); return false; } current.count += 1; return current.count > 10; }
function currentAdmin(req: IncomingMessage): { id: string; email: string } | null { const token = parseCookies(req.headers.cookie)[cookieName]; if (!token) return null; const row = db.prepare("SELECT admins.id, admins.email FROM sessions JOIN admins ON admins.id = sessions.admin_id WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ?").get(tokenHash(token), new Date().toISOString()) as { id: string; email: string } | undefined; return row ?? null; }
async function sessionFor(adminId: string): Promise<string> { const token = randomBytes(32).toString("base64url"); db.prepare("INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), tokenHash(token), adminId, new Date(Date.now() + sessionTtlMs).toISOString(), new Date().toISOString()); return token; }
function isWithin(root: string, target: string): boolean { const relative = path.relative(root, path.resolve(target)); return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); }
function projectRow(id: string): Record<string, unknown> { const row = db.prepare("SELECT id, name, prompt, status, workspace_path, model_provider, model_id, session_dir, created_at, updated_at FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined; if (!row) throw new Error("Project not found"); if (!isWithin(projectsRoot, String(row.workspace_path))) throw new Error("Project workspace is outside the projects root"); if (!row.session_dir || !isWithin(sessionRoot, String(row.session_dir))) throw new Error("Project session directory is outside the session root"); return row; }
function projectView(row: Record<string, unknown>): unknown { return { id: row.id, name: row.name, prompt: row.prompt, status: row.status, model: row.model_provider && row.model_id ? `${row.model_provider}/${row.model_id}` : null, createdAt: row.created_at, updatedAt: row.updated_at }; }
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
function broadcast(projectId: string, event: { type: string; eventId: number; projectId: string; payload: Record<string, unknown>; timestamp: string }): void { const peers = sockets.get(projectId); if (!peers) return; for (const ws of peers) sendEvent(ws, event); }
function sendEvent(ws: WebSocket, event: { type: string; eventId: number; projectId: string; payload: Record<string, unknown>; timestamp: string }): void { if (ws.readyState !== ws.OPEN) return; const seen = seenEvents.get(ws) ?? new Set<number>(); if (seen.has(event.eventId)) return; seen.add(event.eventId); seenEvents.set(ws, seen); ws.send(JSON.stringify(event)); }
function persistEvent(projectId: string, type: string, payload: Record<string, unknown>): { id: number; createdAt: string } { const createdAt = new Date().toISOString(); const result = db.prepare("INSERT INTO omp_events (project_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(projectId, type, JSON.stringify(payload), createdAt); const id = Number(result.lastInsertRowid); broadcast(projectId, { type, eventId: id, projectId, payload, timestamp: createdAt }); return { id, createdAt }; }
function sendError(ws: WebSocket, message: string): void { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", message, timestamp: new Date().toISOString() })); }
function replay(ws: WebSocket, projectId: string, afterEventId = 0): void { const rows = db.prepare("SELECT id, type, payload_json, created_at FROM omp_events WHERE project_id = ? AND id > ? ORDER BY id ASC").all(projectId, afterEventId) as Array<{ id: number; type: string; payload_json: string; created_at: string }>; for (const row of rows) { let payload: Record<string, unknown>; try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { payload = { value: "Invalid persisted event" }; } sendEvent(ws, { type: row.type, eventId: Number(row.id), projectId, payload, timestamp: row.created_at }); } }
function updateProject(id: string, values: { status?: string; provider?: string | null; modelId?: string | null }): void { const now = new Date().toISOString(); db.prepare("UPDATE projects SET status = COALESCE(?, status), model_provider = COALESCE(?, model_provider), model_id = COALESCE(?, model_id), updated_at = ? WHERE id = ?").run(values.status ?? null, values.provider ?? null, values.modelId ?? null, now, id); }
const manager = new OmpSessionManager({ binary: ompBinary, projectsRoot, sessionRoot, maxProcesses: ompMaxProcesses, idleMs: ompIdleMs, runAsUserFor: (id) => config.ompRunAsUserProjectIds.has(id) });
// Phase 3C — rootless Podman preview manager. preview_log events are
// persisted for the Logs tab but capped at the newest 200 per project.
const previewManager = new PreviewManager({
  db,
  projectsRoot,
  onEvent: (projectId, type, payload) => {
    persistEvent(projectId, type, payload);
    if (type === "preview_log") {
      db.prepare("DELETE FROM omp_events WHERE id IN (SELECT id FROM omp_events WHERE project_id = ? AND type = 'preview_log' ORDER BY id DESC LIMIT -1 OFFSET 200)").run(projectId);
    }
  },
});
// Phase 3D — one files_modified emission per real change. The same edit can
// reach the API three ways (file API write, OMP files_modified event, fs
// watcher seeing the write land on disk). The watcher is the redundant
// channel: it observes writes the other two already reported. So ONLY
// watcher-sourced emissions are deduplicated against a recent identical
// emission — file-API and OMP writes always emit, because two genuine
// edits to the same file seconds apart (edit, then restore) must both
// propagate; deduping those broke the 3C re-sync test.
const recentFilesModified = new Map<string, { files: string[]; at: number }>();
function emitFilesModified(projectId: string, files: string[], workspacePath: string, source: "api" | "omp" | "watcher" = "api"): void {
  const now = Date.now();
  if (source === "watcher") {
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
// Phase 3D — per-open-project workspace watcher (see watcher.ts). Started
// when the first WebSocket client opens a project, stopped when the last
// one leaves; never watches the whole VPS.
const workspaceWatcher = new WorkspaceWatcher();
async function getSession(project: Record<string, unknown>): Promise<OmpRpcSession> { const id = String(project.id); const workspacePath = String(project.workspace_path); if (!isWithin(projectsRoot, workspacePath)) throw new Error("Project workspace is outside the projects root"); const provider = project.model_provider ? String(project.model_provider) : undefined; const modelId = project.model_id ? String(project.model_id) : undefined; const env = await projectOmpEnvironment(); return manager.get({ id, workspacePath, provider, modelId }, (type, payload) => { if (type === "files_modified") { const files = Array.isArray((payload as { files?: unknown }).files) ? ((payload as { files: unknown[] }).files.filter((file): file is string => typeof file === "string")) : []; if (files.length > 0) { emitFilesModified(id, files, workspacePath, "omp"); return; } persistEvent(id, type, payload); previewManager.notifyFilesChanged(id, workspacePath); return; } persistEvent(id, type, payload); }, (error) => { persistEvent(id, "agent_error", { error: error?.message ?? "OMP process exited" }); updateProject(id, { status: "error" }); void manager.closeProject(id); }, env); }
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
    if (method === "POST" && url.pathname === "/api/projects") { const input = projectSchema.parse(await body(req)); const id = randomUUID(); const now = new Date().toISOString(); const workspacePath = path.resolve(projectsRoot, id); const projectSessionDir = path.resolve(sessionRoot, id); if (!isWithin(projectsRoot, workspacePath) || !isWithin(sessionRoot, projectSessionDir)) throw new Error("Invalid project path"); mkdirSync(workspacePath, { recursive: true, mode: 0o700 }); mkdirSync(projectSessionDir, { recursive: true, mode: 0o700 }); db.prepare("INSERT INTO projects (id, name, prompt, status, workspace_path, session_dir, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)").run(id, input.name, input.prompt, workspacePath, projectSessionDir, now, now); json(res, 201, { project: projectView({ id, name: input.name, prompt: input.prompt, status: "draft", model_provider: null, model_id: null, created_at: now, updated_at: now }) }); return; }
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
    // Phase 3C — rootless Podman preview manager (admin session required).
    const previewMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/preview(?:\/(start|stop|restart|status|logs))?$/);
    if (previewMatch) {
      const projectId = previewMatch[1];
      const action = previewMatch[2] ?? "";
      const project = projectRow(projectId);
      const workspacePath = String(project.workspace_path);
      if (method === "POST" && action === "start") { json(res, 200, { preview: await previewManager.start(projectId, workspacePath) }); return; }
      if (method === "POST" && action === "stop") { json(res, 200, { preview: await previewManager.stop(projectId) }); return; }
      if (method === "POST" && action === "restart") { json(res, 200, { preview: await previewManager.restart(projectId, workspacePath) }); return; }
      if (method === "GET" && action === "status") { json(res, 200, { preview: await previewManager.getStatus(projectId) }); return; }
      if (method === "GET" && action === "logs") {
        const tail = Number(url.searchParams.get("tail") ?? 200);
        json(res, 200, await previewManager.logs(projectId, Number.isFinite(tail) ? tail : 200));
        return;
      }
      json(res, 404, { error: "Not found" }); return;
    }
    // Phase 3D — authenticated preview gateway (admin session required, see
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
      await proxyPreviewHttp(req, res, targetPath, state.hostPort);
      return;
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)(?:\/session)?$/);
    if (projectMatch && method === "GET" && url.pathname.endsWith("/session")) { const row = projectRow(projectMatch[1]); const after = Number(url.searchParams.get("afterEventId") ?? 0); const events = (db.prepare("SELECT id, project_id, type, payload_json, created_at FROM omp_events WHERE project_id = ? AND id > ? ORDER BY id ASC").all(projectMatch[1], Number.isSafeInteger(after) && after >= 0 ? after : 0) as Array<Record<string, unknown>>).map((event) => ({ id: Number(event.id), projectId: event.project_id, type: event.type, payload: JSON.parse(String(event.payload_json)), createdAt: event.created_at })); json(res, 200, { project: projectView(row), events }); return; }
    if (projectMatch && method === "GET") { const row = projectRow(projectMatch[1]); json(res, 200, { project: projectView(row) }); return; }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof PreviewError) {
      json(res, error.status, { error: error.message });
      return;
    }
    if (error instanceof FileError) {
      const extra = error as FileError & { mtime?: string; mtimeMs?: number };
      json(res, error.status, { error: error.message, ...(extra.mtime !== undefined ? { mtime: extra.mtime, mtimeMs: extra.mtimeMs } : {}) });
      return;
    }
    const inputError = error instanceof z.ZodError; const message = inputError ? "Invalid request" : error instanceof Error ? error.message : "Request failed"; const badRequest = inputError || message.startsWith("Provider URL") || message.startsWith("Provider URL targets") || message === "request too large"; json(res, badRequest ? 400 : message === "Project not found" || message === "Provider not found" ? 404 : 500, { error: message }); }
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
  void (async () => { try { const project = projectRow(projectId); await getSession(project); persistEvent(projectId, "session_status", { state: "connected" }); replay(ws, projectId); } catch (error) { sendError(ws, error instanceof Error ? error.message : "Unable to start OMP session"); } })();
  ws.on("message", (raw) => { let input: unknown; try { input = JSON.parse(raw.toString()); } catch { sendError(ws, "Malformed command"); return; } const parsed = browserCommandSchema.safeParse(input); if (!parsed.success) { sendError(ws, "Unknown or malformed command"); return; } void (async () => { try { const project = projectRow(projectId); const command = parsed.data; if (command.type === "replay") { replay(ws, projectId, command.afterEventId ?? 0); return; } const session = await getSession(project); if (command.type === "prompt") { updateProject(projectId, { status: "running" }); persistEvent(projectId, "user_message", { message: command.message }); await session.prompt(command.message); return; } if (command.type === "abort") { await session.abort(); return; } const provider = db.prepare("SELECT provider_id, model_id FROM providers WHERE provider_id = ? AND model_id = ?").get(command.provider, command.modelId) as { provider_id: string; model_id: string } | undefined; if (!provider) { sendError(ws, "Provider or model is not available"); return; } await session.setModel(provider.provider_id, provider.model_id); updateProject(projectId, { provider: provider.provider_id, modelId: provider.model_id }); } catch (error) { sendError(ws, error instanceof Error ? error.message : "OMP command failed"); } })(); });
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
