import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Milestone A (A7/A1/A4) tests — run on the VPS against the built repo:
//   npm run test:milestone-a        (full build first, then this file)
//   node tests/milestone-a-problems-prefs.mjs
// Part 1 is pure-function tests (log parser, redaction, Fix prompt,
// studio prefs via a localStorage stub + native .ts import).
// Part 2 spawns a throwaway API on a temp DB (same pattern as
// tests/security-regression.mjs) and exercises the real
// GET /api/projects/:id/problems endpoint with seeded preview_log rows.
// Part 3 is static checks on the built bundles (Problems tab + Fix UI
// present in the web bundle, problems route in the API bundle).
// No real preview containers, no OMP calls, no live projects touched.

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const { parseProblemsFromLines, collectProblems } = await import("../apps/api/dist/problems.js");
const shared = await import("../packages/shared/dist/index.js");
const { redactSecrets, buildProblemFixPrompt, problemKey } = shared;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

// ---------- Part 1a: log parser ----------
{
  // esbuild pair: headline line, then the location line.
  const esbuild = parseProblemsFromLines([
    "✘ [ERROR] Could not resolve \"react\"",
    "    src/App.tsx:3:7:",
    "      3 │ import React from \"react\";",
  ]);
  assert.equal(esbuild.length, 1, JSON.stringify(esbuild));
  assert.equal(esbuild[0].file, "src/App.tsx");
  assert.equal(esbuild[0].line, 3);
  assert.equal(esbuild[0].column, 7);
  assert.match(esbuild[0].message, /Could not resolve/);
  assert.equal(esbuild[0].severity, "error");
  ok("parser: esbuild headline + location line pairs into one problem");

  const tsc = parseProblemsFromLines(["src/utils.ts(3,10): error TS2307: Cannot find module './missing'."]);
  assert.equal(tsc.length, 1);
  assert.equal(tsc[0].file, "src/utils.ts");
  assert.equal(tsc[0].line, 3);
  assert.equal(tsc[0].column, 10);
  assert.equal(tsc[0].code, "TS2307");
  ok("parser: tsc file(line,col) format");

  const resolve = parseProblemsFromLines([
    "12:00:00 [vite] Internal server error: Failed to resolve import \"missing-lib\" from \"src/main.tsx\". Does the file exist?",
  ]);
  assert.equal(resolve.length, 1);
  assert.equal(resolve[0].file, "src/main.tsx");
  assert.equal(resolve[0].code, "vite/resolve");
  ok("parser: Vite failed-to-resolve import");

  const runtime = parseProblemsFromLines([
    "Error: request failed",
    "    at fetchData (/app/src/api.ts:8:3)",
    "    at node:internal/process/task_queues:95:5",
  ]);
  assert.equal(runtime.length, 1);
  assert.equal(runtime[0].file, "src/api.ts");
  assert.equal(runtime[0].line, 8);
  assert.equal(runtime[0].column, 3);
  assert.equal(runtime[0].code, "Error");
  ok("parser: Error headline + /app stack frame (prefix stripped)");

  const bare = parseProblemsFromLines(["ReferenceError: foo is not defined"]);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].file, null);
  assert.equal(bare[0].code, "ReferenceError");
  ok("parser: headline without a frame stays a file-less problem");

  const warning = parseProblemsFromLines(["Warning: chunk size exceeds 500 kB"]);
  assert.equal(warning.length, 1);
  assert.equal(warning[0].severity, "warning");
  ok("parser: warning severity");

  const noise = parseProblemsFromLines([
    "Vite ready in 123 ms",
    "  ➜  Local:   http://localhost:5173/",
    "npm notice: something happened",
  ]);
  assert.equal(noise.length, 0, JSON.stringify(noise));
  ok("parser: ready/notice lines produce no problems");

  const dupes = parseProblemsFromLines([
    "src/App.tsx:12:5: ERROR: Cannot find module 'react'",
    "src/App.tsx:12:5: ERROR: Cannot find module 'react'",
    "src/App.tsx:12:5: ERROR: Cannot find module 'react'",
  ]);
  assert.equal(dupes.length, 1);
  ok("parser: identical lines deduped");

  const many = Array.from({ length: 150 }, (_, i) => `src/file${i}.tsx:1:1: ERROR: boom ${i}`);
  assert.equal(parseProblemsFromLines(many).length, 100);
  ok("parser: output capped at 100 problems");

  const crashed = collectProblems(["Vite ready in 1 ms"], { status: "crashed", lastError: "Preview container exited with code 1" });
  assert.equal(crashed.length, 1);
  assert.equal(crashed[0].code, "preview/error");
  const running = collectProblems(["Vite ready in 1 ms"], { status: "running", lastError: null });
  assert.equal(running.length, 0);
  ok("parser: crashed preview lastError becomes a problem; running does not");
}

// ---------- Part 1b: redaction + Fix prompt ----------
{
  const cases = [
    ["xi-api-key: abcdef1234567890", "abcdef1234567890", "[REDACTED]"],
    ["api_key=supersecretvalue", "supersecretvalue", "[REDACTED]"],
    ['"apiKey": "tok-abc-123"', "tok-abc-123", "[REDACTED]"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature", "eyJhbGciOiJIUzI1NiJ9", "Bearer [REDACTED]"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA==", "Basic [REDACTED]"],
    ["password: hunter2", "hunter2", "[REDACTED]"],
    ["token=abc123def456", "abc123def456", "[REDACTED]"],
    ["fetch https://user:s3cr3tpass@example.com/x failed", "s3cr3tpass", "://[REDACTED]@"],
    ["key is sk-ant-api03-abcdefghij1234567890", "sk-ant-api03-abcdefghij1234567890", "[REDACTED]"],
    ["key is ghp_abcdefghij1234567890", "ghp_abcdefghij1234567890", "[REDACTED]"],
  ];
  for (const [input, secret, marker] of cases) {
    const out = redactSecrets(input);
    assert.ok(!out.includes(secret), `secret leaked in: ${out}`);
    assert.ok(out.includes(marker), `marker missing in: ${out}`);
  }
  assert.equal(redactSecrets("Cannot find module './utils'"), "Cannot find module './utils'");
  ok("redaction: secret-bearing keys, Bearer, URL creds, token prefixes blanked; plain text untouched");

  const secretProblem = {
    file: "src/api.ts",
    line: 8,
    column: 3,
    code: "Error",
    message: "request failed with xi-api-key: supersecretvalue123",
    severity: "error",
  };
  const prompt = buildProblemFixPrompt([secretProblem]);
  assert.ok(!prompt.includes("supersecretvalue123"), `secret leaked into Fix prompt: ${prompt}`);
  assert.ok(prompt.includes("[REDACTED]"), "Fix prompt lost the redaction marker");
  assert.ok(prompt.includes("src/api.ts:8:3"), "Fix prompt lost the location");
  ok("Fix prompt: scoped diagnostic content only, secret redacted");

  const many = Array.from({ length: 25 }, (_, i) => ({
    file: `src/f${i}.tsx`,
    line: 1,
    column: 1,
    code: "build/error",
    message: `boom ${i}`,
    severity: "error",
  }));
  const longPrompt = buildProblemFixPrompt(many);
  const numbered = longPrompt.split("\n").filter((line) => /^\d+\. /.test(line));
  assert.equal(numbered.length, 20, `expected 20 problems in prompt, got ${numbered.length}`);
  assert.ok(longPrompt.length <= 8000, `prompt over cap: ${longPrompt.length}`);
  ok("Fix prompt: capped at 20 problems / 8000 chars");

  assert.equal(problemKey(secretProblem), problemKey({ ...secretProblem }));
  assert.notEqual(problemKey(secretProblem), problemKey({ ...secretProblem, message: "different" }));
  ok("problemKey: stable for identical problems, distinct otherwise");
}

// ---------- Part 1c: studio prefs (A7) ----------
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
  // Native .ts import (Node >= 22.18 type stripping); the module uses
  // only erasable syntax.
  const prefs = await import("../apps/web/src/studio-prefs.ts");
  const projectId = "11111111-2222-3333-4444-555555555555";

  const saved = {
    tab: "problems",
    split: true,
    device: "mobile",
    openFiles: ["src/App.tsx", "src/main.tsx"],
    activePath: "src/App.tsx",
    expandedDirs: ["src", "src/components"],
    // Milestone B added these fields; the round-trip must carry them too.
    saveOnBlur: false,
    consoleOpen: false,
    chatLayout: null,
    codeLayout: null,
    // Milestone D (B2) added these fields; the round-trip must carry them too.
    activeChatId: null,
    chatDrafts: {},
  };
  prefs.saveStudioPrefs(projectId, saved);
  assert.deepEqual(prefs.loadStudioPrefs(projectId), saved);
  assert.equal(store.has("omp-builder-studio-prefs:11111111-2222-3333-4444-555555555555"), true);
  assert.equal(store.has("omp-builder-default-provider"), false);
  assert.equal(store.has("omp-builder-remembered-email"), false);
  ok("prefs: round-trip under the per-project key; global keys untouched");

  store.set(prefs.studioPrefsKey(projectId), "{not json");
  assert.deepEqual(prefs.loadStudioPrefs(projectId), prefs.defaultStudioPrefs());
  // Milestone B: "tablet" is now a valid device, so the invalid-device
  // case uses "watch"; invalid panel layouts fall back to null.
  store.set(prefs.studioPrefsKey(projectId), JSON.stringify({ tab: "nope", split: "yes", device: "watch", openFiles: "x", activePath: 42, expandedDirs: [1, null], chatLayout: "wide", codeLayout: { chat: "30" } }));
  const fallback = prefs.loadStudioPrefs(projectId);
  assert.equal(fallback.tab, "preview");
  assert.equal(fallback.split, false);
  assert.equal(fallback.device, "desktop");
  assert.equal(fallback.chatLayout, null);
  assert.equal(fallback.codeLayout, null);
  assert.deepEqual(fallback.openFiles, []);
  assert.equal(fallback.activePath, null);
  assert.deepEqual(fallback.expandedDirs, []);
  ok("prefs: corrupt JSON / wrong-typed fields fall back to defaults");

  const big = { ...prefs.defaultStudioPrefs(), openFiles: Array.from({ length: 60 }, (_, i) => `f${i}.ts`) };
  assert.equal(prefs.parseStudioPrefs(big).openFiles.length, 50);
  ok("prefs: open-file list capped at 50");

  delete globalThis.localStorage;
}

// ---------- Part 2: live endpoint on a throwaway API ----------
{
  const temp = await mkdtemp(path.join(os.tmpdir(), "omp-builder-milestone-a-"));
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
  const emptyProjectId = randomUUID();
  const seed = new Database(env.DATABASE_PATH);
  // The server creates these tables on start; the seed rows must exist
  // BEFORE the server starts, so create them here (same shape as
  // apps/api/src/server.ts; same pattern as security-regression.mjs).
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
  for (const id of [projectId, emptyProjectId]) {
    const workspacePath = path.join(env.PROJECTS_ROOT, id);
    const sessionDir = path.join(env.OMP_SESSION_ROOT, id);
    await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    seed.prepare("INSERT INTO projects (id, name, prompt, status, workspace_path, model_provider, model_id, session_dir, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, NULL, NULL, ?, ?, ?)").run(id, `Test ${id.slice(0, 8)}`, "test", workspacePath, sessionDir, now, now);
  }
  const seedLog = (line) =>
    seed.prepare("INSERT INTO omp_events (project_id, type, payload_json, created_at) VALUES (?, 'preview_log', ?, ?)").run(projectId, JSON.stringify({ line }), now);
  seedLog("src/App.tsx:12:5: ERROR: Cannot find module 'react'");
  seedLog("src/App.tsx:12:5: ERROR: Cannot find module 'react'");
  seedLog("[vite] Internal server error: Failed to resolve import \"missing-lib\" from \"src/main.tsx\". Does the file exist?");
  seedLog("Error: request failed with xi-api-key: endpoint-secret-12345");
  seedLog("    at fetchData (/app/src/api.ts:8:3)");
  seedLog("src/utils.ts(3,10): error TS2307: Cannot find module './missing'.");
  seedLog("Vite ready in 123 ms");
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

    const unauth = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/problems`);
    assert.equal(unauth.status, 401);
    ok("endpoint: 401 without a session");

    const missing = await fetch(`http://127.0.0.1:${port}/api/projects/${randomUUID()}/problems`, { headers });
    assert.equal(missing.status, 404);
    ok("endpoint: 404 for an unknown project");

    const empty = await fetch(`http://127.0.0.1:${port}/api/projects/${emptyProjectId}/problems`, { headers });
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).problems, []);
    ok("endpoint: empty problem list when a project has no preview logs");

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/problems`, { headers });
    assert.equal(res.status, 200, `problems endpoint failed: ${res.status}`);
    const body = await res.json();
    assert.ok(Array.isArray(body.problems), "problems is not an array");
    assert.equal(body.problems.length, 4, JSON.stringify(body.problems, null, 2));
    const byFile = new Map(body.problems.map((p) => [p.file ?? "(none)", p]));
    assert.equal(byFile.get("src/App.tsx").line, 12);
    assert.equal(byFile.get("src/main.tsx").code, "vite/resolve");
    assert.equal(byFile.get("src/utils.ts").code, "TS2307");
    const apiProblem = byFile.get("src/api.ts");
    assert.ok(apiProblem, "api.ts problem missing");
    assert.ok(!JSON.stringify(body).includes("endpoint-secret-12345"), "seeded secret leaked through the endpoint response");
    assert.ok(apiProblem.message.includes("[REDACTED]"), `endpoint problem not redacted: ${apiProblem.message}`);
    ok("endpoint: seeded logs parse to 4 deduped problems; secret redacted in the response");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(temp, { recursive: true, force: true });
  }
}

// ---------- Part 3: built bundles contain the new UI ----------
{
  const assets = await readdir(path.join(root, "apps/web/dist/assets"));
  const mainJs = assets.find((name) => /^index-.*\.js$/.test(name));
  assert.ok(mainJs, "no built web main bundle found");
  const bundle = await readFile(path.join(root, "apps/web/dist/assets", mainJs), "utf8");
  assert.ok(bundle.includes("Problems"), "Problems tab label missing from the built web bundle");
  assert.ok(bundle.includes("/problems"), "problems endpoint path missing from the built web bundle");
  assert.ok(bundle.includes("Fix "), "Fix action label missing from the built web bundle");
  assert.ok(bundle.includes("omp-builder-studio-prefs:"), "studio prefs key missing from the built web bundle");
  ok("bundle: Problems tab, endpoint path, Fix action and prefs key present in the built web JS");

  const serverJs = await readFile(path.join(root, "apps/api/dist/server.js"), "utf8");
  assert.ok(serverJs.includes("/problems"), "problems route missing from the built API bundle");
  ok("bundle: problems route present in the built API JS");
}

console.log(`milestone A checks passed (${passed} checks)`);
