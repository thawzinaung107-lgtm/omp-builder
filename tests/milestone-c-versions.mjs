import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

// Milestone C (B1) tests — run on the VPS against the built repo:
//   npm run test:milestone-c        (full build first, then this file)
//   node tests/milestone-c-versions.mjs
// Part 1 is pure-function tests (gitignore merge, deny-list, porcelain).
// Part 2 exercises git.ts directly on throwaway workspaces: safe init
// (no files lost), already-initialized untouched, corrupt .git surfaced,
// checkpoint per generation, deny-list + hooks, diff, restore refused
// with uncommitted changes, restore with discard, undo, preview-before-
// restore staging. No live projects touched.
// Part 3 spawns a throwaway API (same pattern as
// tests/milestone-b-workspace.mjs) and checks the versions routes over
// HTTP, including the 409-on-dirty restore and the manual checkpoint.
// Part 4 is static checks on the built bundles.
// No real preview containers, no OMP calls.

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const execFileAsync = promisify(execFile);

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd });
  return stdout.trim();
}

// Import the BUILT module (test:milestone-c builds first): a native
// .ts import cannot resolve git.ts's ./files.js import under Node type
// stripping, so the compiled dist is used here, like the throwaway API
// in Part 3.
const gitmod = await import("../apps/api/dist/git.js");
const { mergeGitignore, isDeniedCheckpointPath, parsePorcelainZ, ensureGitRepo, repoState, createCheckpoint, listCheckpoints, checkpointFileStats, checkpointDiff, restoreToCheckpoint, undoLastCheckpoint, previewCheckpoint, GitError } = gitmod;

// ---------- Part 1: pure functions ----------
{
  const merged = mergeGitignore("");
  assert.ok(merged.includes(".env\n"), "canonical .env missing from empty merge");
  assert.ok(merged.includes("node_modules/\n"), "canonical node_modules missing");
  assert.ok(merged.includes("data/\n"), "canonical data/ missing");

  const existing = "# my rules\nnode_modules/\ncustom-dir/\n";
  const merged2 = mergeGitignore(existing);
  assert.ok(merged2.startsWith("# my rules\nnode_modules/\ncustom-dir/\n"), "existing .gitignore content must be preserved verbatim");
  assert.ok(merged2.includes(".env\n"), "missing canonical lines must be appended");
  assert.equal(merged2.split("\n").filter((line) => line === "node_modules/").length, 1, "node_modules must not be duplicated");
  ok("mergeGitignore: empty, preserve-user-content, no duplicates");

  const denied = [".env", ".env.local", "sub/.env.production", "key.pem", "id_rsa.key", "credentials.json", "aws-credentials", "my-secret.txt", "src/secret-sauce.ts", "data/notes.txt", "app.log", "node_modules/pkg/index.js", "dist/bundle.js", ".git/config", ".omp/x"];
  for (const file of denied) assert.equal(isDeniedCheckpointPath(file), true, `${file} must be denied`);
  const allowed = ["src/index.ts", "package.json", "README.md", "src/data.json", "public/app.css", ".gitignore", "src/components/LoginForm.tsx"];
  for (const file of allowed) assert.equal(isDeniedCheckpointPath(file), false, `${file} must be allowed`);
  ok("isDeniedCheckpointPath: secrets, runtime data and protected paths denied; source files allowed");

  const parsed = parsePorcelainZ(" M src/a.ts\0?? new.txt\0R  new-name.ts\0old-name.ts\0");
  assert.deepEqual(parsed, [
    { status: " M", path: "src/a.ts", origPath: null },
    { status: "??", path: "new.txt", origPath: null },
    { status: "R ", path: "new-name.ts", origPath: "old-name.ts" },
  ]);
  ok("parsePorcelainZ: modified, untracked, rename entries");
}

// ---------- Part 2: git operations on throwaway workspaces ----------
const sessionId = "test-session-c";
{
  const temp = await mkdtemp(path.join(os.tmpdir(), "omp-builder-milestone-c-"));
  try {
    const ws = path.join(temp, "ws");
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, "index.html"), "<h1>v1</h1>\n", "utf8");
    await mkdir(path.join(ws, "src"), { recursive: true });
    await writeFile(path.join(ws, "src", "app.js"), "console.log(1);\n", "utf8");
    await writeFile(path.join(ws, ".env"), "API_KEY=should-never-commit\n", "utf8");
    await mkdir(path.join(ws, "node_modules", "fake"), { recursive: true });
    await writeFile(path.join(ws, "node_modules", "fake", "index.js"), "module.exports = 1;\n", "utf8");
    await writeFile(path.join(ws, "my-secret.txt"), "top secret\n", "utf8");
    await mkdir(path.join(ws, "data"), { recursive: true });
    await writeFile(path.join(ws, "data", "notes.txt"), "runtime\n", "utf8");
    await writeFile(path.join(ws, ".gitignore"), "# user rules\ncustom-dir/\n", "utf8");

    const init = await ensureGitRepo(ws);
    assert.equal(init.status, "initialized");
    assert.ok(init.baselineOid, "baseline commit expected");
    // No files lost: every original file still reads back.
    assert.equal(await readFile(path.join(ws, "index.html"), "utf8"), "<h1>v1</h1>\n");
    assert.equal(await readFile(path.join(ws, ".env"), "utf8"), "API_KEY=should-never-commit\n");
    assert.equal(await readFile(path.join(ws, "my-secret.txt"), "utf8"), "top secret\n");
    // User .gitignore preserved, canonical lines appended.
    const gitignore = await readFile(path.join(ws, ".gitignore"), "utf8");
    assert.ok(gitignore.startsWith("# user rules\ncustom-dir/\n"), "user .gitignore must be preserved");
    assert.ok(gitignore.includes(".env\n"), "canonical .env must be appended");
    // Baseline contains only safe files: no .env, no secrets, no data/, no node_modules.
    const baselineFiles = (await git(ws, ["ls-files"])).split("\n").filter(Boolean).sort();
    assert.deepEqual(baselineFiles, [".gitignore", "index.html", "src/app.js"]);
    const checkpoints = await listCheckpoints(ws);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].subject, "Baseline: initial project state (3 files)");
    assert.equal(checkpoints[0].sessionId, "baseline");
    assert.equal(checkpoints[0].filesChanged, 3);
    ok("safe init: no files lost, user .gitignore preserved, baseline excludes secrets/runtime data");

    // Already-initialized repo is untouched (same HEAD, no new commit).
    const headBefore = await git(ws, ["rev-parse", "HEAD"]);
    const again = await ensureGitRepo(ws);
    assert.equal(again.status, "already");
    assert.equal(await git(ws, ["rev-parse", "HEAD"]), headBefore);
    assert.equal((await listCheckpoints(ws)).length, 1);
    ok("already-initialized repo untouched by a second init");

    // Repo-local identity + hooks disabled.
    assert.equal(await git(ws, ["config", "user.name"]), "OMP Builder");
    assert.equal(await git(ws, ["config", "core.hooksPath"]), "/dev/null");
    ok("repo-local identity and hooksPath set at init");

    // Hooks are never executed: a post-commit hook that would leave a
    // marker must not run on a checkpoint commit.
    await mkdir(path.join(ws, ".git", "hooks"), { recursive: true });
    await writeFile(path.join(ws, ".git", "hooks", "post-commit"), "#!/bin/sh\ntouch " + path.join(temp, "HOOK-RAN") + "\n", "utf8");
    await chmod(path.join(ws, ".git", "hooks", "post-commit"), 0o755);
    await writeFile(path.join(ws, "index.html"), "<h1>v2</h1>\n", "utf8");
    await writeFile(path.join(ws, "src", "new.js"), "console.log(2);\n", "utf8");
    await writeFile(path.join(ws, "other-secret.txt"), "also secret\n", "utf8");
    const cp1 = await createCheckpoint(ws, { promptSummary: "Change the heading and add a file", sessionId, kind: "ai" });
    assert.equal(cp1.created, true);
    assert.equal(cp1.filesChanged, 2);
    // my-secret.txt was already denied at baseline time and is still
    // untracked, so this checkpoint correctly reports skipping it too.
    assert.deepEqual([...cp1.skippedDenied].sort(), ["my-secret.txt", "other-secret.txt"]);
    assert.ok(cp1.message?.startsWith("AI update: Change the heading and add a file (2 files)"), `unexpected subject: ${cp1.message}`);
    assert.ok(cp1.message?.includes(`Omp-Session: ${sessionId}`), "session trailer missing");
    let hookRan = false;
    try { await readFile(path.join(temp, "HOOK-RAN")); hookRan = true; } catch { hookRan = false; }
    assert.equal(hookRan, false, "post-commit hook must not run");
    const afterCp1 = await listCheckpoints(ws);
    assert.equal(afterCp1.length, 2);
    assert.equal(afterCp1[0].sessionId, sessionId);
    assert.equal(afterCp1[0].filesChanged, 2);
    // Denied files never enter the repo.
    assert.ok(!(await git(ws, ["ls-files"])).split("\n").includes("other-secret.txt"));
    assert.ok(!(await git(ws, ["ls-files"])).split("\n").includes(".env"));
    ok("checkpoint per generation: subject + session trailer, denied files skipped, hooks not executed");

    // Diff between checkpoints: content is exact.
    const diff = await checkpointDiff(ws, afterCp1[1].oid, afterCp1[0].oid);
    assert.equal(diff.files.length, 2);
    const indexDiff = diff.files.find((f) => f.path === "index.html");
    assert.equal(indexDiff?.status, "modified");
    assert.equal(indexDiff?.original, "<h1>v1</h1>\n");
    assert.equal(indexDiff?.modified, "<h1>v2</h1>\n");
    const newDiff = diff.files.find((f) => f.path === "src/new.js");
    assert.equal(newDiff?.status, "added");
    assert.equal(newDiff?.original, "");
    assert.equal(newDiff?.modified, "console.log(2);\n");
    // Diff of a checkpoint vs its parent (no `from`).
    const diffParent = await checkpointDiff(ws, null, afterCp1[0].oid);
    assert.equal(diffParent.files.length, 2);
    // Per-file stats for one checkpoint.
    const stats = await checkpointFileStats(ws, afterCp1[0].oid);
    assert.deepEqual(stats.map((f) => f.path).sort(), ["index.html", "src/new.js"]);
    ok("checkpoint diff: vs parent and between two checkpoints, exact contents");

    // Restore REFUSES with uncommitted changes (default).
    await writeFile(path.join(ws, "index.html"), "<h1>uncommitted edit</h1>\n", "utf8");
    await writeFile(path.join(ws, "scratch.txt"), "never committed\n", "utf8");
    let refused = null;
    try { await restoreToCheckpoint(ws, afterCp1[1].oid, { discardUncommitted: false, sessionId, kind: "restore" }); } catch (error) { refused = error; }
    assert.ok(refused instanceof GitError && refused.status === 409, `restore must refuse with 409, got ${refused}`);
    assert.equal(await readFile(path.join(ws, "index.html"), "utf8"), "<h1>uncommitted edit</h1>\n", "refused restore must not touch the workspace");
    ok("restore refused with uncommitted changes (409, workspace untouched)");

    // Restore WITH explicit discard: workspace returns to the baseline,
    // as a NEW commit (history preserved: baseline + cp1 + restore).
    const restored = await restoreToCheckpoint(ws, afterCp1[1].oid, { discardUncommitted: true, sessionId, kind: "restore" });
    assert.equal(restored.created, true);
    assert.equal(restored.restoredOid, afterCp1[1].oid);
    assert.equal(await readFile(path.join(ws, "index.html"), "utf8"), "<h1>v1</h1>\n");
    let scratchGone = false;
    try { await readFile(path.join(ws, "scratch.txt")); } catch { scratchGone = true; }
    assert.equal(scratchGone, true, "discarded restore must remove post-checkpoint files");
    const afterRestore = await listCheckpoints(ws);
    assert.equal(afterRestore.length, 3);
    assert.ok(afterRestore[0].subject.startsWith("Restore to"), `unexpected restore subject: ${afterRestore[0].subject}`);
    assert.equal((await repoState(ws)).dirty, false);
    ok("restore with explicit discard: workspace restored as a new commit, history preserved");

    // Undo: one more generation, then undo back to the pre-generation tree.
    await writeFile(path.join(ws, "index.html"), "<h1>v3</h1>\n", "utf8");
    const cp2 = await createCheckpoint(ws, { promptSummary: "Third version", sessionId, kind: "ai" });
    assert.equal(cp2.created, true);
    const undone = await undoLastCheckpoint(ws, { discardUncommitted: false, sessionId });
    assert.equal(undone.undoneOid, cp2.oid);
    assert.equal(await readFile(path.join(ws, "index.html"), "utf8"), "<h1>v1</h1>\n");
    assert.ok((await listCheckpoints(ws))[0].subject.startsWith("Undo:"), "undo must be a new commit");
    // Nothing left to undo past the single remaining root... (baseline +
    // restore + undo chain still has parents, so undo again works; the
    // refusal case is a single-commit repo — covered below.)
    ok("undo: restores the checkpoint before the last generation as a new commit");

    // Preview-before-restore: staging copy of the first AI checkpoint,
    // live workspace untouched.
    const stagingRoot = path.join(temp, "staging");
    const preview = await previewCheckpoint(ws, stagingRoot, "test-project-c", afterCp1[0].oid);
    assert.equal(preview.oid, afterCp1[0].oid);
    assert.equal(preview.files.some((f) => f.path === "index.html"), true);
    assert.equal(await readFile(path.join(stagingRoot, "test-project-c", preview.stagingId, "index.html"), "utf8"), "<h1>v2</h1>\n");
    assert.equal(await readFile(path.join(ws, "index.html"), "utf8"), "<h1>v1</h1>\n", "preview must not mutate the live workspace");
    assert.ok(preview.diff.some((f) => f.path === "index.html" && f.status === "modified"), "preview diff vs HEAD expected");
    ok("preview-before-restore: detached staging checkout, live workspace untouched");

    // No-op checkpoint: nothing changed.
    const noop = await createCheckpoint(ws, { sessionId, kind: "manual", manualMessage: "nothing new" });
    assert.equal(noop.created, false);
    assert.equal(noop.reason, "no changes");
    ok("checkpoint with no changes is a no-op");

    // Binary file diff: content is not inlined.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    await writeFile(path.join(ws, "logo.bin"), binary);
    const cpBin = await createCheckpoint(ws, { sessionId, kind: "manual", manualMessage: "add binary" });
    assert.equal(cpBin.created, true);
    const binDiff = await checkpointDiff(ws, null, cpBin.oid);
    const binFile = binDiff.files.find((f) => f.path === "logo.bin");
    assert.equal(binFile?.binary, true);
    assert.equal(binFile?.original, "");
    assert.equal(binFile?.modified, "");
    ok("binary files in diffs are flagged, not inlined");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

// Corrupt .git is surfaced, never touched; empty workspace inits cleanly.
{
  const temp = await mkdtemp(path.join(os.tmpdir(), "omp-builder-milestone-c-corrupt-"));
  try {
    const ws = path.join(temp, "ws");
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, "keep.txt"), "do not lose me\n", "utf8");
    await writeFile(path.join(ws, ".git"), "not a real git dir\n", "utf8");
    const result = await ensureGitRepo(ws);
    assert.equal(result.status, "corrupt");
    assert.ok((result.error ?? "").length > 0);
    assert.equal(await readFile(path.join(ws, ".git"), "utf8"), "not a real git dir\n", "corrupt .git must not be touched");
    assert.equal(await readFile(path.join(ws, "keep.txt"), "utf8"), "do not lose me\n");
    const state = await repoState(ws);
    assert.equal(state.corrupt, true);
    assert.equal(state.initialized, false);
    ok("corrupt .git surfaced as an error, never re-initialized, files untouched");

    const empty = path.join(temp, "empty");
    await mkdir(empty, { recursive: true });
    const emptyInit = await ensureGitRepo(empty);
    // An empty workspace still gets a baseline (it contains the generated
    // .gitignore) — the repo never sits at an unborn HEAD after init.
    assert.equal(emptyInit.status, "initialized");
    assert.ok(emptyInit.head, "baseline expected for an empty workspace");
    assert.equal((await repoState(empty)).initialized, true);
    assert.equal((await listCheckpoints(empty)).length, 1);
    assert.equal((await listCheckpoints(empty))[0].filesChanged, 1);
    ok("empty workspace inits with a baseline (.gitignore only)");

    // Undo with only one commit (no parent) refuses.
    const single = path.join(temp, "single");
    await mkdir(single, { recursive: true });
    await writeFile(path.join(single, "only.txt"), "one\n", "utf8");
    const singleInit = await ensureGitRepo(single);
    assert.equal(singleInit.status, "initialized");
    assert.equal((await listCheckpoints(single)).length, 1);
    let undoRefused = null;
    try { await undoLastCheckpoint(single, { discardUncommitted: false, sessionId }); } catch (error) { undoRefused = error; }
    assert.ok(undoRefused instanceof GitError && undoRefused.status === 409);
    ok("undo with a single checkpoint (no parent) refuses (409)");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

// ---------- Part 3: versions routes on a throwaway API ----------
{
  const temp = await mkdtemp(path.join(os.tmpdir(), "omp-builder-milestone-c-"));
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
  seed.prepare("INSERT INTO projects (id, name, prompt, status, workspace_path, model_provider, model_id, session_dir, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, NULL, NULL, ?, ?, ?)").run(projectId, "Test versions", "test", workspacePath, path.join(env.OMP_SESSION_ROOT, projectId), now, now);
  seed.close();
  await writeFile(path.join(workspacePath, "index.html"), "<h1>api v1</h1>\n", "utf8");
  await writeFile(path.join(workspacePath, ".env"), "API_KEY=never-commit\n", "utf8");

  const child = spawn(process.execPath, [path.join(root, "apps/api/dist/server.js")], { cwd: "/tmp", env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; }
      } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, `throwaway API did not become ready: ${stderr.slice(0, 500)}`);
    const headers = { cookie: `omp_builder_session=${token}`, "content-type": "application/json" };
    const call = async (method, urlPath, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      return { status: response.status, data };
    };

    const unauth = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/versions`);
    assert.equal(unauth.status, 401);
    ok("versions: 401 without a session");

    const missing = await call("GET", `/api/projects/${randomUUID()}/versions`);
    assert.equal(missing.status, 404);
    ok("versions: 404 for an unknown project");

    // Startup migration inits the seeded project (poll: it runs async).
    let listed = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      listed = await call("GET", `/api/projects/${projectId}/versions`);
      if (listed.status === 200 && listed.data.status.initialized && Array.isArray(listed.data.checkpoints) && listed.data.checkpoints.length >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(listed.status, 200);
    assert.equal(listed.data.status.initialized, true);
    assert.equal(listed.data.checkpoints.length, 1);
    assert.ok(listed.data.checkpoints[0].subject.startsWith("Baseline:"), `unexpected baseline: ${listed.data.checkpoints[0].subject}`);
    assert.equal(listed.data.checkpoints[0].filesChanged, 2, "baseline must contain .gitignore + index.html (.env ignored)");
    const baselineOid = listed.data.checkpoints[0].oid;
    ok("versions: startup migration initialized the project with a baseline (secrets excluded)");

    // Manual checkpoint after an edit.
    const put = await call("PUT", `/api/projects/${projectId}/files/content`, { path: "index.html", content: "<h1>api v2</h1>\n" });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    const saved = await call("POST", `/api/projects/${projectId}/versions/checkpoint`, { message: "Second version" });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.checkpoint.created, true);
    assert.equal(saved.data.checkpoint.filesChanged, 1);
    listed = await call("GET", `/api/projects/${projectId}/versions`);
    assert.equal(listed.data.checkpoints.length, 2);
    assert.ok(listed.data.checkpoints[0].subject.startsWith("Second version"), `unexpected subject: ${listed.data.checkpoints[0].subject}`);
    // Milestone D (B2): checkpoints are attributed to the acting chat
    // session; a REST checkpoint with no chatSessionId acts as the
    // project's default chat.
    const chatsList = await call("GET", `/api/projects/${projectId}/chats`);
    assert.equal(chatsList.status, 200, JSON.stringify(chatsList.data));
    assert.equal(listed.data.checkpoints[0].sessionId, chatsList.data.chats[0].id, "session id recorded on the checkpoint");
    ok("versions: manual checkpoint after an edit, session recorded");

    // Diff of the new checkpoint vs its parent.
    const diff = await call("GET", `/api/projects/${projectId}/versions/${listed.data.checkpoints[0].oid}/diff`);
    assert.equal(diff.status, 200);
    assert.equal(diff.data.files.length, 1);
    assert.equal(diff.data.files[0].original, "<h1>api v1</h1>\n");
    assert.equal(diff.data.files[0].modified, "<h1>api v2</h1>\n");
    // Diff between two checkpoints.
    const diff2 = await call("GET", `/api/projects/${projectId}/versions/${listed.data.checkpoints[0].oid}/diff?against=${baselineOid}`);
    assert.equal(diff2.status, 200);
    assert.equal(diff2.data.files.length, 1);
    ok("versions: diff vs parent and between two checkpoints over HTTP");

    // Restore REFUSES with uncommitted changes (409), then succeeds
    // with an explicit discard — and the file reverts.
    await call("PUT", `/api/projects/${projectId}/files/content`, { path: "index.html", content: "<h1>uncommitted</h1>\n" });
    const refused = await call("POST", `/api/projects/${projectId}/versions/${baselineOid}/restore`, {});
    assert.equal(refused.status, 409, JSON.stringify(refused.data));
    assert.ok((refused.data.error ?? "").includes("uncommitted"), "409 must say uncommitted changes");
    const readAfterRefusal = await call("GET", `/api/projects/${projectId}/files/content?path=index.html`);
    assert.equal(readAfterRefusal.data.content, "<h1>uncommitted</h1>\n", "refused restore must not touch files");
    const restored = await call("POST", `/api/projects/${projectId}/versions/${baselineOid}/restore`, { discardUncommitted: true });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal(restored.data.restore.created, true);
    assert.ok(restored.data.restore.changedPaths.includes("index.html"));
    const readAfterRestore = await call("GET", `/api/projects/${projectId}/files/content?path=index.html`);
    assert.equal(readAfterRestore.data.content, "<h1>api v1</h1>\n");
    listed = await call("GET", `/api/projects/${projectId}/versions`);
    assert.ok(listed.data.checkpoints[0].subject.startsWith("Restore to"), `unexpected restore subject: ${listed.data.checkpoints[0].subject}`);
    ok("versions: restore refused (409) with uncommitted changes, succeeds with explicit discard, file reverts as a new commit");

    // Undo the restore (back to the v2 checkpoint).
    const undone = await call("POST", `/api/projects/${projectId}/versions/undo`, {});
    assert.equal(undone.status, 200, JSON.stringify(undone.data));
    const readAfterUndo = await call("GET", `/api/projects/${projectId}/files/content?path=index.html`);
    assert.equal(readAfterUndo.data.content, "<h1>api v2</h1>\n");
    ok("versions: undo restores the previous checkpoint as a new commit");

    // Preview-before-restore via the API (staging copy, live untouched).
    const preview = await call("POST", `/api/projects/${projectId}/versions/${baselineOid}/preview`, {});
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.preview.oid, baselineOid);
    assert.ok(preview.data.preview.files.some((f) => f.path === "index.html"));
    const readAfterPreview = await call("GET", `/api/projects/${projectId}/files/content?path=index.html`);
    assert.equal(readAfterPreview.data.content, "<h1>api v2</h1>\n", "preview must not mutate the live workspace");
    ok("versions: preview-before-restore over HTTP (staging copy, live untouched)");

    // Checkpoint with only denied changes is a no-op, not an error.
    await writeFile(path.join(workspacePath, "another-secret.txt"), "secret\n", "utf8");
    const deniedOnly = await call("POST", `/api/projects/${projectId}/versions/checkpoint`, { message: "only secrets" });
    assert.equal(deniedOnly.status, 200);
    assert.equal(deniedOnly.data.checkpoint.created, false);
    ok("versions: checkpoint with only secret-bearing changes is a no-op");
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
  // Note: the Retry prompt-race fix (recentSettle) is a minified local and
  // cannot be needle-checked in the bundle; the browser test
  // (tests/milestone-c-browser.mjs) is its regression coverage — it Retries
  // a real OMP turn and asserts a second turn settles.
  for (const needle of ["Version history", "Save checkpoint", "Restore this version", "Previewing checkpoint", "Discard uncommitted changes", "Modified files"]) {
    assert.ok(bundle.includes(needle), `${needle} missing from the built web bundle`);
  }
  ok("bundle: VersionPane, restore confirm, preview, undo/redo UI present in the built web JS");

  const serverJs = await readFile(path.join(root, "apps/api/dist/server.js"), "utf8");
  for (const needle of ["versions", "checkpoints", "version-staging"]) {
    assert.ok(serverJs.includes(needle), `${needle} missing from the built API bundle`);
  }
  const gitJs = await readFile(path.join(root, "apps/api/dist/git.js"), "utf8");
  assert.ok(gitJs.includes("core.hooksPath"), "core.hooksPath missing from the built git module");
  ok("bundle: versions routes, checkpoints table, staging, hooksPath guard present in the built API JS");
}

console.log(`milestone C checks passed (${passed} checks)`);
