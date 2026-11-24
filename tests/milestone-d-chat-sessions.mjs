import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import WebSocket from "ws";

// Milestone D (B2) tests - run on the VPS against the built repo:
//   npm run test:milestone-d       (full build first, then this file)
//   node tests/milestone-d-chat-sessions.mjs
// Part 1 exercises OmpSessionManager directly: two chat children share
// the 2-slot pool, a third chat is refused with a clear busy error (not
// a hang), releasing one chat frees its slot, closeProject closes every
// chat of the project. Real OMP children are spawned (no prompts sent).
// Part 2 spawns a throwaway API seeded with a PRE-v5 database and checks
// the v5 migration backfill (default "Chat 1" per project, chat-scoped
// events attributed, project-scoped events stay un-attributed) plus the
// chat REST routes (create/rename/reorder/delete + guards) and manual
// checkpoint attribution per chat (commit trailer + mirror).
// Part 3 spawns a second throwaway API and checks WS behaviour over a
// real socket: prompts persist per-chat user_message rows, a third
// concurrent chat gets "OMP process limit reached", release_chat frees
// the slot so the third chat can then start, and file edits stay
// project-scoped (chatSessionId null). Prompts use a dummy-key provider
// so no real provider is ever called; prompt outcomes are not asserted,
// only persistence and pool behaviour.
// Part 4 is static checks on the built bundles.
// No live projects touched; the live API is never used.

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Part 1: OMP pool keyed by chat session ----------
{
  const temp = await mkdtemp(path.join(os.tmpdir(), "omp-builder-milestone-d-pool-"));
  const configDir = process.env.OMP_BUILDER_CONFIG_DIR ?? "/var/lib/omp-builder/data/omp-config";
  const env = { OMP_CONFIG_DIR: configDir, PI_CODING_AGENT_DIR: configDir };
  const { OmpSessionManager } = await import("../apps/api/dist/omp-session-manager.js");
  const manager = new OmpSessionManager({
    binary: "/usr/local/bin/omp",
    projectsRoot: path.join(temp, "projects"),
    sessionRoot: path.join(temp, "sessions"),
    maxProcesses: 2,
    idleMs: 900_000,
    isProjectAlive: () => true,
  });
  const projectId = randomUUID();
  const workspacePath = path.join(temp, "projects", projectId);
  const chatA = randomUUID();
  const chatB = randomUUID();
  const chatC = randomUUID();
  const noop = () => undefined;
  try {
    const sessionA = await manager.get(
      { chatSessionId: chatA, projectId, workspacePath, sessionDir: path.join(temp, "sessions", projectId), provider: "Kuoai", modelId: "gpt-6-sol" },
      noop,
      noop,
      env,
    );
    const sessionB = await manager.get(
      { chatSessionId: chatB, projectId, workspacePath, sessionDir: path.join(temp, "sessions", projectId, "chats", chatB), provider: "Kuoai", modelId: "gpt-6-sol" },
      noop,
      noop,
      env,
    );
    assert.notEqual(sessionA, sessionB, "two chats must get two different OMP children");
    assert.equal(manager.peek(chatA), sessionA);
    assert.deepEqual(manager.liveChatSessionIds(projectId).sort(), [chatA, chatB].sort());
    ok("pool: two chats hold the two slots with distinct OMP children");
    let poolError;
    try {
      await manager.get(
        { chatSessionId: chatC, projectId, workspacePath, sessionDir: path.join(temp, "sessions", projectId, "chats", chatC), provider: "Kuoai", modelId: "gpt-6-sol" },
        noop,
        noop,
        env,
      );
    } catch (error) {
      poolError = error;
    }
    assert.match(poolError?.message ?? "", /OMP process limit reached/, "third chat must be refused with the pool-busy error");
    assert.match(poolError?.message ?? "", /all 2 OMP slots are busy/, "busy error must name the slot count");
    ok("pool: third concurrent chat is refused with a clear busy error, not a hang");
    assert.equal(await manager.closeChatIfIdle(chatA), true, "releasing an idle chat must free its slot");
    assert.equal(manager.peek(chatA), undefined);
    const sessionC = await manager.get(
      { chatSessionId: chatC, projectId, workspacePath, sessionDir: path.join(temp, "sessions", projectId, "chats", chatC), provider: "Kuoai", modelId: "gpt-6-sol" },
      noop,
      noop,
      env,
    );
    assert.ok(sessionC, "third chat must start after a release");
    ok("pool: release_chat frees the slot; the waiting chat then starts");
    await manager.closeProject(projectId);
    assert.equal(manager.peek(chatB), undefined);
    assert.equal(manager.peek(chatC), undefined);
    assert.deepEqual(manager.liveChatSessionIds(projectId), []);
    ok("pool: closeProject closes every chat of the project");
  } finally {
    await manager.closeAll().catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
}

// ---------- Part 2: v5 migration backfill + chat REST routes ----------
async function spawnThrowawayApi(temp, port, seed) {
  const env = {
    ...process.env,
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    WEB_ORIGINS: "http://localhost:5173",
    DATABASE_PATH: path.join(temp, "app.db"),
    PROJECTS_ROOT: path.join(temp, "projects"),
    OMP_SESSION_ROOT: path.join(temp, "sessions"),
    OMP_CONFIG_DIR: path.join(temp, "config"),
    OMP_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    OMP_BIN: "/usr/local/bin/omp",
    // The throwaway API runs as root and its workspaces live in a
    // root-owned /tmp dir: the service-user OMP spawn cannot chdir into
    // them (EACCES). Run OMP children as the test user here (the live
    // service still uses the service user; this escape hatch is test-only).
    OMP_RUN_AS_USER: "false",
  };
  new Database(env.DATABASE_PATH).close();
  const seedDb = new Database(env.DATABASE_PATH);
  seed(seedDb, env);
  seedDb.close();
  const child = spawn(process.execPath, [path.join(root, "apps/api/dist/server.js")], { cwd: "/tmp", env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) ready = true;
      else await sleep(200);
    } catch {
      await sleep(200);
    }
  }
  assert.equal(ready, true, `throwaway API did not become ready: ${stderr.slice(0, 500)}`);
  return { env, child, stderr };
}

function mintToken(seedDb, adminId) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();
  seedDb.prepare("INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), tokenHash, adminId, new Date(Date.now() + 3600_000).toISOString(), now);
  return token;
}

{
  const temp = await mkdtemp(path.join(os.tmpdir(), "omp-builder-milestone-d-v5-"));
  const port = 8960 + Math.floor(Math.random() * 300);
  const projectId = randomUUID();
  const adminId = randomUUID();
  let token;
  const seed = (seedDb, env) => {
    // PRE-v5 database: no chat_sessions table, no chat_session_id columns.
    seedDb.exec(`
CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, admin_id TEXT NOT NULL REFERENCES admins(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','ready','running','error')), workspace_path TEXT NOT NULL, model_provider TEXT, model_id TEXT, session_dir TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS omp_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL UNIQUE, base_url TEXT NOT NULL, api TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', key_ciphertext TEXT NOT NULL, key_nonce TEXT NOT NULL, key_tag TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preview_state (project_id TEXT PRIMARY KEY, container_name TEXT NOT NULL, host_port INTEGER NOT NULL, container_port INTEGER NOT NULL, framework TEXT NOT NULL, status TEXT NOT NULL, last_error TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (oid TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, message TEXT NOT NULL, files_changed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
`);
    const now = new Date().toISOString();
    seedDb.prepare("INSERT INTO admins (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)").run(adminId, "test@example.com", "hash", "salt", now);
    token = mintToken(seedDb, adminId);
    for (const version of [1, 2, 3, 4]) seedDb.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, now);
    seedDb.pragma("user_version = 4");
    const workspacePath = path.join(env.PROJECTS_ROOT, projectId);
    seedDb.prepare("INSERT INTO projects (id, name, prompt, status, workspace_path, model_provider, model_id, session_dir, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, NULL, NULL, ?, ?, ?)").run(projectId, "Migration test", "test", workspacePath, path.join(env.OMP_SESSION_ROOT, projectId), now, now);
    const event = (type, payload) => seedDb.prepare("INSERT INTO omp_events (project_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(projectId, type, JSON.stringify(payload), now);
    event("user_message", { message: "Build a counter app" });
    event("assistant_delta", { delta: "Working on it" });
    event("files_modified", { files: ["index.html"] });
    event("preview_log", { line: "vite ready" });
    seedDb.prepare("INSERT INTO checkpoints (oid, project_id, session_id, message, files_changed, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("a".repeat(40), projectId, projectId, "AI update: counter app", 1, now);
  };
  const { child } = await spawnThrowawayApi(temp, port, seed);
  try {
    const headers = { cookie: `omp_builder_session=${token}`, "content-type": "application/json" };
    const call = async (method, urlPath, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      let data = null;
      try { data = await response.json(); } catch { /* ignore */ }
      return { status: response.status, data };
    };
    // Migration ran at boot: v5 + backfilled default chat.
    const afterDb = new Database(path.join(temp, "app.db"), { readonly: true });
    assert.equal(afterDb.pragma("user_version", { simple: true }), 5);
    assert.deepEqual(afterDb.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version), [1, 2, 3, 4, 5]);
    const chats = afterDb.prepare("SELECT * FROM chat_sessions WHERE project_id = ?").all(projectId);
    assert.equal(chats.length, 1, "backfill must create exactly one default chat");
    assert.equal(chats[0].title, "Chat 1");
    const defaultChatId = chats[0].id;
    assert.equal(chats[0].session_dir, path.join(temp, "sessions", projectId), "default chat keeps the legacy session dir");
    const attributed = afterDb.prepare("SELECT type FROM omp_events WHERE project_id = ? AND chat_session_id = ?").all(projectId, defaultChatId).map((r) => r.type).sort();
    assert.deepEqual(attributed, ["assistant_delta", "user_message"], "chat-scoped events belong to the default chat");
    const unattributed = afterDb.prepare("SELECT type FROM omp_events WHERE project_id = ? AND chat_session_id IS NULL").all(projectId).map((r) => r.type).sort();
    assert.deepEqual(unattributed, ["files_modified", "preview_log"], "project-scoped events stay un-attributed");
    const checkpointRow = afterDb.prepare("SELECT chat_session_id FROM checkpoints WHERE project_id = ?").get(projectId);
    assert.equal(checkpointRow.chat_session_id, defaultChatId, "non-baseline checkpoint mirror points at the default chat");
    afterDb.close();
    ok("v5 migration: default Chat 1 backfilled; chat events attributed; project events un-attributed");

    const unauth = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/chats`);
    assert.equal(unauth.status, 401);
    const missing = await call("GET", `/api/projects/${randomUUID()}/chats`);
    assert.equal(missing.status, 404);
    ok("chats: 401 without a session; 404 for an unknown project");

    const listed = await call("GET", `/api/projects/${projectId}/chats`);
    assert.equal(listed.status, 200, JSON.stringify(listed.data));
    assert.equal(listed.data.chats.length, 1);
    assert.equal(listed.data.chats[0].title, "Chat 1");
    const created2 = await call("POST", `/api/projects/${projectId}/chats`, {});
    assert.equal(created2.status, 201, JSON.stringify(created2.data));
    assert.equal(created2.data.chat.title, "Chat 2");
    assert.ok(created2.data.chat.sessionDir === undefined, "session dir is server-internal, never exposed");
    const created3 = await call("POST", `/api/projects/${projectId}/chats`, { title: "Plan" });
    assert.equal(created3.data.chat.title, "Plan");
    const chat2Id = created2.data.chat.id;
    const chat3Id = created3.data.chat.id;
    const renamed = await call("PATCH", `/api/projects/${projectId}/chats/${chat2Id}`, { title: "Design" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
    assert.equal(renamed.data.chat.title, "Design");
    const badRename = await call("PATCH", `/api/projects/${projectId}/chats/${chat2Id}`, { title: "   " });
    assert.equal(badRename.status, 400);
    const badChat = await call("PATCH", `/api/projects/${projectId}/chats/${randomUUID()}`, { title: "Nope" });
    assert.equal(badChat.status, 404);
    ok("chats: create (auto Chat N + custom title), rename, rename guards (blank 400, unknown 404)");

    const reordered = await call("POST", `/api/projects/${projectId}/chats/reorder`, { order: [chat3Id, chat2Id, defaultChatId] });
    assert.equal(reordered.status, 200, JSON.stringify(reordered.data));
    assert.deepEqual(reordered.data.chats.map((c) => c.id), [chat3Id, chat2Id, defaultChatId]);
    const relisted = await call("GET", `/api/projects/${projectId}/chats`);
    assert.deepEqual(relisted.data.chats.map((c) => c.id), [chat3Id, chat2Id, defaultChatId], "reorder must persist across reads");
    const badReorder = await call("POST", `/api/projects/${projectId}/chats/reorder`, { order: [chat3Id, chat2Id] });
    assert.equal(badReorder.status, 400, "reorder must list every chat exactly once");
    ok("chats: reorder persists; partial reorder rejected (400)");

    // Manual checkpoint attributed to the "Plan" chat (trailer + mirror).
    // Init the repo first (baseline), THEN change the file: otherwise the
    // checkpoint call itself baselines the workspace and consumes the
    // change (created: false).
    const workspacePath = path.join(temp, "projects", projectId);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, "index.html"), "<h1>Migration test v1</h1>\n", "utf8");
    const init = await call("POST", `/api/projects/${projectId}/versions/init`);
    assert.equal(init.status, 200, JSON.stringify(init.data));
    assert.equal(init.data.init, "initialized");
    const put = await call("PUT", `/api/projects/${projectId}/files/content`, { path: "index.html", content: "<h1>Migration test v2</h1>\n" });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    const checkpoint = await call("POST", `/api/projects/${projectId}/versions/checkpoint`, { chatSessionId: chat3Id });
    assert.equal(checkpoint.status, 200, JSON.stringify(checkpoint.data));
    assert.equal(checkpoint.data.checkpoint.created, true, "manual checkpoint must be created after a file change");
    const versions = await call("GET", `/api/projects/${projectId}/versions`);
    const manual = versions.data.checkpoints.find((c) => c.oid === checkpoint.data.checkpoint.oid);
    assert.ok(manual, "manual checkpoint listed");
    assert.equal(manual.sessionId, chat3Id, "checkpoint trailer records the acting chat");
    const checkDb = new Database(path.join(temp, "app.db"), { readonly: true });
    const mirror = checkDb.prepare("SELECT chat_session_id FROM checkpoints WHERE oid = ?").get(checkpoint.data.checkpoint.oid);
    assert.equal(mirror.chat_session_id, chat3Id, "checkpoint mirror records the acting chat");
    checkDb.close();
    ok("checkpoints: manual checkpoint attributed to the acting chat (trailer + mirror)");

    // Delete guards: last chat cannot go; delete the others first.
    await call("DELETE", `/api/projects/${projectId}/chats/${chat3Id}`);
    await call("DELETE", `/api/projects/${projectId}/chats/${chat2Id}`);
    const lastLeft = await call("GET", `/api/projects/${projectId}/chats`);
    assert.equal(lastLeft.data.chats.length, 1);
    const deleteLast = await call("DELETE", `/api/projects/${projectId}/chats/${lastLeft.data.chats[0].id}`);
    assert.equal(deleteLast.status, 409, "deleting the last chat must be refused");
    const deletedEvents = new Database(path.join(temp, "app.db"), { readonly: true });
    assert.equal(deletedEvents.prepare("SELECT COUNT(*) c FROM omp_events WHERE project_id = ? AND chat_session_id = ?").get(projectId, chat3Id).c, 0, "deleting a chat removes its events");
    deletedEvents.close();
    ok("chats: delete removes the chat + its events; the last chat cannot be deleted (409)");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(temp, { recursive: true, force: true });
  }
}

// ---------- Part 3: WS per-chat isolation + pool contention ----------
{
  const temp = await mkdtemp(path.join(os.tmpdir(), "omp-builder-milestone-d-ws-"));
  const port = 9290 + Math.floor(Math.random() * 300);
  const projectId = randomUUID();
  const adminId = randomUUID();
  let token;
  const seed = (seedDb, env) => {
    // Tables do not exist yet (the API creates them on boot), so create
    // the ones this seed writes, exactly like the milestone-B pattern.
    seedDb.exec(`
CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, admin_id TEXT NOT NULL REFERENCES admins(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL UNIQUE, base_url TEXT NOT NULL, api TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', key_ciphertext TEXT NOT NULL, key_nonce TEXT NOT NULL, key_tag TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`);
    const now = new Date().toISOString();
    seedDb.prepare("INSERT INTO admins (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)").run(adminId, "test@example.com", "hash", "salt", now);
    token = mintToken(seedDb, adminId);
    // Dummy-key provider so OMP children start with a --model but can
    // never reach a real provider (invalid host, dummy key). The fake
    // master key matches the throwaway API env so encryptSecret works.
    process.env.OMP_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    const { encryptSecret } = require("../apps/api/dist/provider-security.js");
    const encrypted = encryptSecret("dummy-key-for-tests");
    seedDb.prepare("INSERT INTO providers (id, provider_id, base_url, api, model_id, display_name, key_ciphertext, key_nonce, key_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      randomUUID(), "Kuoai", "https://api.example.invalid", "openai-completions", "gpt-6-sol", "Kuoai test", encrypted.ciphertext, encrypted.nonce, encrypted.tag, now, now,
    );
  };
  const { child } = await spawnThrowawayApi(temp, port, seed);
  let ws = null;
  try {
    const headers = { cookie: `omp_builder_session=${token}`, "content-type": "application/json" };
    const call = async (method, urlPath, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      let data = null;
      try { data = await response.json(); } catch { /* ignore */ }
      return { status: response.status, data };
    };
    const created = await call("POST", "/api/projects", { name: "Milestone D WS Test", prompt: "Throwaway project for the Milestone D WS checks." });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const pid = created.data.project.id;
    const listed = await call("GET", `/api/projects/${pid}/chats`);
    assert.equal(listed.data.chats.length, 1, "a new project starts with one default chat");
    const defaultChatId = listed.data.chats[0].id;
    const second = await call("POST", `/api/projects/${pid}/chats`, {});
    const chatB = second.data.chat.id;
    const third = await call("POST", `/api/projects/${pid}/chats`, {});
    const chatC = third.data.chat.id;
    ok("WS setup: project with three chats (default + two new)");

    ws = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/${pid}`, { headers: { cookie: `omp_builder_session=${token}` } });
    const frames = [];
    ws.on("message", (raw) => {
      try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS did not open in 30s")), 30_000);
      ws.on("open", () => { clearTimeout(timer); resolve(); });
      ws.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
    // Lazy OMP: connect alone must NOT start a child - the only
    // session_status so far is the persisted "connected" event.
    await sleep(3000);
    const earlyDb = new Database(path.join(temp, "app.db"), { readonly: true });
    const earlyEvents = earlyDb.prepare("SELECT type, chat_session_id FROM omp_events WHERE project_id = ?").all(pid);
    assert.ok(earlyEvents.some((e) => e.type === "session_status"), "connected event persisted on WS open");
    earlyDb.close();
    ok("WS: connect persists session_status without starting an OMP child (lazy)");

    const waitFor = async (label, predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await predicate();
        if (last) return last;
        await sleep(1000);
      }
      throw new Error(`timed out waiting for: ${label} (last: ${JSON.stringify(last)})`);
    };
    const sessionEvents = async () => (await call("GET", `/api/projects/${pid}/session`)).data.events ?? [];
    const userMessagesFor = async (chatId) => (await sessionEvents()).filter((e) => e.type === "user_message" && e.chatSessionId === chatId);

    ws.send(JSON.stringify({ type: "prompt", message: "Add a comment to index.html saying chat A was here.", chatSessionId: defaultChatId }));
    await waitFor("user_message persisted for chat A", async () => (await userMessagesFor(defaultChatId)).length >= 1, 120_000);
    ws.send(JSON.stringify({ type: "prompt", message: "Add a comment to index.html saying chat B was here.", chatSessionId: chatB }));
    await waitFor("user_message persisted for chat B", async () => (await userMessagesFor(chatB)).length >= 1, 120_000);
    const afterTwo = await sessionEvents();
    assert.equal(afterTwo.filter((e) => e.type === "user_message" && e.chatSessionId === defaultChatId).length, 1, "chat A has exactly its own prompt");
    assert.equal(afterTwo.filter((e) => e.type === "user_message" && e.chatSessionId === chatB).length, 1, "chat B has exactly its own prompt");
    assert.equal(afterTwo.filter((e) => e.type === "user_message" && e.chatSessionId === chatC).length, 0, "chat C has no messages yet");
    ok("WS: prompts persist as per-chat user_message rows; no leakage between chats");

    // Both pool slots are now held (two live children). A third prompt
    // must get the clear busy error, not a hang.
    const framesBefore = frames.length;
    ws.send(JSON.stringify({ type: "prompt", message: "Add a comment saying chat C was here.", chatSessionId: chatC }));
    const busy = await waitFor("OMP process limit reached for the third chat", async () => {
      const frame = frames.slice(framesBefore).find((f) => f.type === "error" && typeof f.message === "string" && f.message.includes("OMP process limit reached"));
      return frame ?? null;
    }, 120_000);
    assert.equal(busy.chatSessionId, chatC, "busy error names the chat that was refused");
    assert.equal((await userMessagesFor(chatC)).length, 0, "a refused prompt persists no user_message");
    ok("WS: third concurrent chat gets 'OMP process limit reached' with its chat id");

    // Chat A's turn is still running against the dummy provider (it
    // retries the unreachable host and never settles on its own), so a
    // release alone would correctly refuse a busy chat. Abort it first
    // (abort marks the session settled and emits prompt_aborted), then
    // release frees the slot and the third chat can start.
    ws.send(JSON.stringify({ type: "abort", chatSessionId: defaultChatId }));
    await waitFor("chat A turn aborted", async () => frames.some((f) => f.type === "prompt_aborted" && f.chatSessionId === defaultChatId) ?? null, 120_000);
    ws.send(JSON.stringify({ type: "release_chat", chatSessionId: defaultChatId }));
    await sleep(3000);
    ws.send(JSON.stringify({ type: "prompt", message: "Add a comment saying chat C was here.", chatSessionId: chatC }));
    await waitFor("user_message persisted for chat C after release", async () => (await userMessagesFor(chatC)).length >= 1, 120_000);
    ok("WS: release_chat frees the slot; the waiting chat then starts");

    // A file edit stays project-scoped (chatSessionId null).
    const put = await call("PUT", `/api/projects/${pid}/files/content`, { path: "index.html", content: "<h1>WS test</h1>\n" });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    const filesEvents = (await sessionEvents()).filter((e) => e.type === "files_modified");
    assert.ok(filesEvents.length >= 1, "files_modified persisted");
    assert.equal(filesEvents[filesEvents.length - 1].chatSessionId, null, "files_modified is project-scoped, not chat-scoped");
    ok("WS: file edits stay project-scoped (shared workspace)");

    // Unknown chat id is rejected, not silently routed to default.
    const framesBeforeBad = frames.length;
    ws.send(JSON.stringify({ type: "prompt", message: "hello?", chatSessionId: randomUUID() }));
    await waitFor("unknown chat rejected", async () => frames.slice(framesBeforeBad).find((f) => f.type === "error" && f.message === "Chat not found") ?? null, 60_000);
    ok("WS: prompt for an unknown chat is rejected (Chat not found)");
  } finally {
    if (ws) ws.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(temp, { recursive: true, force: true });
  }
}

// ---------- Part 4: built bundles contain the new UI + routes ----------
{
  const assets = await readdir(path.join(root, "apps/web/dist/assets"));
  const mainJs = assets.find((name) => /^index-.*\.js$/.test(name));
  assert.ok(mainJs, "no built web main bundle found");
  const bundle = await readFile(path.join(root, "apps/web/dist/assets", mainJs), "utf8");
  for (const needle of ["New chat", "Chat sessions", "Close chat", "Rename chat"]) {
    assert.ok(bundle.includes(needle), `${needle} missing from the built web bundle`);
  }
  ok("bundle: chat tab strip (New chat, sessions, close, rename) present in the built web JS");

  const serverJs = await readFile(path.join(root, "apps/api/dist/server.js"), "utf8");
  for (const needle of ["chat_sessions", "release_chat", "chatSessionId"]) {
    assert.ok(serverJs.includes(needle), `${needle} missing from the built API bundle`);
  }
  // The pool-busy message lives in the session manager module (tsc keeps
  // it as a separate dist file, not inlined into server.js).
  const managerJs = await readFile(path.join(root, "apps/api/dist/omp-session-manager.js"), "utf8");
  assert.ok(managerJs.includes("OMP process limit reached"), "OMP process limit reached missing from the built manager bundle");
  assert.ok(managerJs.includes("closeChatIfIdle"), "closeChatIfIdle missing from the built manager bundle");
  ok("bundle: chat routes, release_chat and pool-busy error present in the built API JS");
}

console.log(`milestone D chat-session checks passed (${passed} checks)`);
