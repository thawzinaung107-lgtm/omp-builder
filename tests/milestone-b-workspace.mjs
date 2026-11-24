import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Milestone B (A3/A2/A5/A6) tests — run on the VPS against the built repo:
//   npm run test:milestone-b        (full build first, then this file)
//   node tests/milestone-b-workspace.mjs
// Part 1 is pure-function tests (line diff stats, change status).
// Part 2 is studio prefs (new fields + panel layouts) and the preview
// path validator, via native .ts imports + a localStorage stub.
// Part 3 spawns a throwaway API (same pattern as
// tests/milestone-a-problems-prefs.mjs) and checks the rebuild route
// wiring (401/404 only — no containers are started here; the real
// rebuild is browser-verified instead).
// Part 4 is static checks on the built bundles.
// No real preview containers, no OMP calls, no live projects touched.

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const shared = await import("../packages/shared/dist/index.js");
const { lineDiffStats, fileChangeStatus } = shared;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

// ---------- Part 1: line diff stats ----------
{
  assert.deepEqual(lineDiffStats("", ""), { added: 0, removed: 0 });
  assert.deepEqual(lineDiffStats("", "a\nb\n"), { added: 2, removed: 0 });
  assert.deepEqual(lineDiffStats("a\nb\n", ""), { added: 0, removed: 2 });
  assert.deepEqual(lineDiffStats("a\nb\nc\n", "a\nx\nc\nd\n"), { added: 2, removed: 1 });
  assert.deepEqual(lineDiffStats("same\n", "same\n"), { added: 0, removed: 0 });
  // A trailing newline does not count as a phantom extra line.
  assert.deepEqual(lineDiffStats("a\n", "a"), { added: 0, removed: 0 });
  // Large files fall back to the multiset comparison (same counts).
  const big1 = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
  const big2 = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
  assert.deepEqual(lineDiffStats(big1, big2), { added: 1, removed: 1 });
  ok("lineDiffStats: empty sides, add/remove counts, trailing newline, large-file fallback");

  assert.equal(fileChangeStatus(false, true), "added");
  assert.equal(fileChangeStatus(true, false), "deleted");
  assert.equal(fileChangeStatus(true, true), "modified");
  assert.equal(fileChangeStatus(false, false), "modified");
  ok("fileChangeStatus: added / deleted / modified");
}

// ---------- Part 2: prefs (new fields) + preview path ----------
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index) => [...store.keys()][index] ?? null,
  };
  // Native .ts imports (Node >= 22.18 type stripping); both modules use
  // only erasable syntax.
  const prefs = await import("../apps/web/src/studio-prefs.ts");
  const { normalizePreviewPath } = await import("../apps/web/src/preview-path.ts");
  const projectId = "22222222-3333-4444-5555-666666666666";

  const saved = {
    ...prefs.defaultStudioPrefs(),
    tab: "code",
    device: "tablet",
    saveOnBlur: true,
    consoleOpen: true,
    chatLayout: { chat: 30, workspace: 70 },
    codeLayout: { "code-tree": 20, "code-editor": 80 },
  };
  prefs.saveStudioPrefs(projectId, saved);
  assert.deepEqual(prefs.loadStudioPrefs(projectId), saved);
  ok("prefs: tablet device, saveOnBlur, consoleOpen, panel layouts round-trip");

  store.set(
    prefs.studioPrefsKey(projectId),
    JSON.stringify({ chatLayout: "wide", codeLayout: { "code-tree": "25", "code-editor": 150, x: -1 } }),
  );
  const fallback = prefs.loadStudioPrefs(projectId);
  assert.equal(fallback.chatLayout, null);
  assert.equal(fallback.codeLayout, null);
  assert.deepEqual(prefs.parsePanelLayout({ a: 30, b: 70, c: "no", d: 101 }), { a: 30, b: 70 });
  assert.equal(prefs.parsePanelLayout("nope"), null);
  assert.equal(prefs.parsePanelLayout({}), null);
  ok("prefs: invalid panel layouts fall back to null; partial layouts keep valid entries");

  assert.equal(normalizePreviewPath(""), "/");
  assert.equal(normalizePreviewPath("/about"), "/about");
  assert.equal(normalizePreviewPath("about"), "/about");
  assert.equal(normalizePreviewPath("  /a/b  "), "/a/b");
  assert.equal(normalizePreviewPath("https://evil.example.com/"), null);
  assert.equal(normalizePreviewPath("//evil.example.com"), null);
  assert.equal(normalizePreviewPath("/../etc/passwd"), null);
  assert.equal(normalizePreviewPath("/a/./b"), null);
  assert.equal(normalizePreviewPath("/a?x=1"), null);
  assert.equal(normalizePreviewPath("/a#b"), null);
  assert.equal(normalizePreviewPath("/a\\b"), null);
  assert.equal(normalizePreviewPath("/a b"), null);
  ok("preview path: absolute paths pass; other origins, traversal, query, hash, backslash rejected");

  delete globalThis.localStorage;
}

// ---------- Part 3: rebuild route wiring on a throwaway API ----------
{
  const temp = await mkdtemp(path.join(os.tmpdir(), "omp-builder-milestone-b-"));
  const port = 8950 + Math.floor(Math.random() * 400);
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
  };
  new Database(env.DATABASE_PATH).close();
  const adminId = randomUUID();
  const projectId = randomUUID();
  const seed = new Database(env.DATABASE_PATH);
  seed.exec(`
CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, admin_id TEXT NOT NULL REFERENCES admins(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','ready','running','error')), workspace_path TEXT NOT NULL, model_provider TEXT, model_id TEXT, session_dir TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS omp_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preview_state (project_id TEXT PRIMARY KEY, container_name TEXT NOT NULL, host_port INTEGER NOT NULL, container_port INTEGER NOT NULL, framework TEXT NOT NULL, status TEXT NOT NULL, last_error TEXT, updated_at TEXT NOT NULL);
`);
  const now = new Date().toISOString();
  seed.prepare("INSERT INTO admins (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)").run(adminId, "test@example.com", "hash", "salt", now);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  seed.prepare("INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), tokenHash, adminId, new Date(Date.now() + 3600_000).toISOString(), now);
  const workspacePath = path.join(env.PROJECTS_ROOT, projectId);
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  await mkdir(path.join(env.OMP_SESSION_ROOT, projectId), { recursive: true, mode: 0o700 });
  seed.prepare("INSERT INTO projects (id, name, prompt, status, workspace_path, model_provider, model_id, session_dir, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, NULL, NULL, ?, ?, ?)").run(projectId, "Test rebuild", "test", workspacePath, path.join(env.OMP_SESSION_ROOT, projectId), now, now);
  seed.close();

  const child = spawn(process.execPath, [path.join(root, "apps/api/dist/server.js")], { cwd: "/tmp", env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, `throwaway API did not become ready: ${stderr.slice(0, 500)}`);
    const headers = { cookie: `omp_builder_session=${token}`, "content-type": "application/json" };

    const unauth = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/preview/rebuild`, { method: "POST" });
    assert.equal(unauth.status, 401);
    ok("rebuild: 401 without a session");

    const missing = await fetch(`http://127.0.0.1:${port}/api/projects/${randomUUID()}/preview/rebuild`, { method: "POST", headers });
    assert.equal(missing.status, 404);
    ok("rebuild: 404 for an unknown project");

    const status = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/preview/status`, { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).preview, null);
    ok("preview status: null for a project that never started");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(temp, { recursive: true, force: true });
  }
}

// ---------- Part 4: built bundles contain the new UI ----------
{
  const assets = await readdir(path.join(root, "apps/web/dist/assets"));
  const mainJs = assets.find((name) => /^index-.*\.js$/.test(name));
  assert.ok(mainJs, "no built web main bundle found");
  const bundle = await readFile(path.join(root, "apps/web/dist/assets", mainJs), "utf8");
  for (const needle of ["Modified files", "Rebuild", "Save on blur", "Tablet 768px", "Starting preview", "Read-only diff", "Back to editor", "code-tree"]) {
    assert.ok(bundle.includes(needle), `${needle} missing from the built web bundle`);
  }
  assert.ok(bundle.includes("Console"), "console drawer missing from the built web bundle");
  ok("bundle: change card, Rebuild, save-on-blur, tablet, loading screen, diff view, console drawer present in the built web JS");

  const serverJs = await readFile(path.join(root, "apps/api/dist/server.js"), "utf8");
  assert.ok(serverJs.includes("rebuild"), "rebuild route missing from the built API bundle");
  ok("bundle: rebuild route present in the built API JS");
}

console.log(`milestone B checks passed (${passed} checks)`);
