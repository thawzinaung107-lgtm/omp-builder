import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

// Phase 3E end-to-end tests — run against the LIVE API on the VPS:
//   node tests/phase3-e2e.mjs
// Mints a throwaway admin session (revoked at the end). Covers ONLY the gaps
// the other Phase 3 suites do not: (1) a full prompt-to-preview run with a
// REAL OMP agent (Kuoai/gpt-6-sol) generating a small React+Vite app, served
// through the gateway, then edited through the file API and re-served;
// (2) a real backend restart (the API process is killed and relaunched) with
// preview-state reconciliation, no orphan containers, no source-file loss,
// and WS event replay. The Phase 2 container is removed externally BEFORE
// the restart so its DB row is genuinely stale — reconcile() must mark it
// stopped. (Without the external kill the container survives the restart
// — PreviewManager.close() only detaches log followers — and reconcile
// correctly leaves the row running.) (3) security re-probes (container isolation incl.
// host-LAN reachability recorded honestly, env/cmdline secret scan,
// unauthorized preview rejection); (4) app.db 0600 hardening holds across
// the restart. The throwaway project is deleted afterwards.
// Env overrides: OMP_BUILDER_API, OMP_BUILDER_DB, OMP_BUILDER_PROJECTS_ROOT,
// OMP_BUILDER_PREVIEW_ROOT, OMP_BUILDER_REPO.
// NOTE: the restart check restarts the whole service with
// `systemctl restart omp-builder` (Phase 3.5 §2: the API + web run as the
// omp-builder service user under one systemd unit running `npm run dev`),
// so the web dev server (5173) restarts too; both must come back healthy.
// Logs go to the journal, not a restart log file.

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const api = process.env.OMP_BUILDER_API ?? "http://127.0.0.1:8787";
const dbPath = process.env.OMP_BUILDER_DB ?? "/var/lib/omp-builder/data/persistent/app.db";
const projectsRoot = process.env.OMP_BUILDER_PROJECTS_ROOT ?? "/var/lib/omp-builder/data/projects";
const previewRoot = process.env.OMP_BUILDER_PREVIEW_ROOT ?? "/var/lib/omp-builder/previews";
const repoRoot = process.env.OMP_BUILDER_REPO ?? "/opt/omp-builder";
const ADMIN_ID = "155e3283-d271-452a-af52-e90f900cd78d";
const PHASE2_ID = "134cc3fe-631f-4755-9839-67af3bfd8ba9";
const GUA_ID = "4f75505f-a2d9-4cc9-b6f8-4e3978c6de9b";

const execFileAsync = promisify(execFile);
const db = new Database(dbPath);
const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
db.prepare("INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
  randomUUID(),
  tokenHash,
  ADMIN_ID,
  new Date(Date.now() + 14 * 86_400_000).toISOString(),
  new Date().toISOString(),
);
const headers = { cookie: `omp_builder_session=${token}`, "content-type": "application/json" };

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function call(method, urlPath, body, extraHeaders) {
  const response = await fetch(`${api}${urlPath}`, {
    method,
    headers: { ...headers, ...(extraHeaders ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

async function fetchText(url, options, timeoutMs = 10_000) {
  const response = await fetch(url, { ...(options ?? {}), signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: await response.text() };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // Phase 3.5 (§5 fix): a server-sent error frame (e.g. "OMP process
      // limit reached") names the cause the moment it arrives — fail fast
      // instead of burning the whole timeout and reporting a bare timeout.
      if (lastError.startsWith("OMP session failed over WS:")) {
        throw new Error(`timeout waiting for: ${label} (${lastError})`);
      }
    }
    await sleep(2000);
  }
  throw new Error(`timeout waiting for: ${label}${lastError ? ` (last: ${lastError})` : ""}`);
}

async function podman(args, timeoutMs = 60_000) {
  // cwd "/" (mirroring the API, apps/api/src/preview.ts): podman fails to
  // resolve its working directory when spawned from a cwd the service user
  // cannot traverse (e.g. a shell sitting under /root) — "cannot chdir".
  const result = await execFileAsync(
    "/usr/sbin/runuser",
    [
      "-u",
      "omp-builder",
      "--",
      "/usr/bin/env",
      "XDG_RUNTIME_DIR=/run/user/996",
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/996/bus",
      "HOME=/var/lib/omp-builder",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "/usr/bin/podman",
      "--cgroup-manager",
      "systemd",
      ...args,
    ],
    { cwd: "/", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
  );
  return result.stdout;
}

async function hashTree(rootDir) {
  const out = {};
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs, relPath);
      else if (entry.isFile()) out[relPath] = createHash("sha256").update(await readFile(abs)).digest("hex");
    }
  }
  await walk(rootDir, "");
  return out;
}

// Restart the managed service (Phase 3.5 §2). Killing the concurrently
// process directly would race the unit's Restart=on-failure on the same
// port, so `systemctl restart` is the only restart path in this test.
async function restartService() {
  await execFileAsync("/usr/bin/systemctl", ["restart", "omp-builder.service"]);
}

// Read the unit's recent journal output for the listening-line check.
// Called after health is back, so the listening line has had time to land.
async function restartServiceJournal() {
  try {
    const { stdout } = await execFileAsync("/usr/bin/journalctl", ["-u", "omp-builder.service", "--since", "5 minutes ago", "-n", "300", "--no-pager"]);
    return stdout;
  } catch {
    return "";
  }
}

async function previewStatus(projectId) {
  const res = await call("GET", `/api/projects/${projectId}/preview/status`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.preview;
}

async function startPreviewAndWait(projectId, timeoutMs = 300_000) {
  const started = await call("POST", `/api/projects/${projectId}/preview/start`);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  await waitFor(async () => (await previewStatus(projectId)).status === "running", timeoutMs, `preview ${projectId} running`);
  return previewStatus(projectId);
}

async function stopPreview(projectId) {
  const stopped = await call("POST", `/api/projects/${projectId}/preview/stop`);
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  return stopped.data.preview;
}

let throwawayId = null;
let throwawayWs = null;

try {
  // ---- Check 1: full prompt-to-preview E2E with a real OMP agent. ----
  const prompt =
    "Make a small React + Vite app that shows a counter button. One page: a heading 'Counter', a button that increments a number each click, starting at 0. Keep it tiny - a few files only.";
  const created = await call("POST", "/api/projects", { name: `Phase 3E E2E ${new Date().toISOString()}`, prompt });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  throwawayId = created.data.project.id;
  console.log(`throwaway project: ${throwawayId}`);

  const wsEvents = [];
  throwawayWs = new WebSocket(`ws://127.0.0.1:8787/ws/projects/${throwawayId}`, { headers: { cookie: `omp_builder_session=${token}` } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("project WS did not open in 30s")), 30_000);
    throwawayWs.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    throwawayWs.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  // Phase 3.5 (§5 fix): the server reports a failed session start as an
  // `error` frame (e.g. "OMP process limit reached") the moment the socket
  // opens. Remember it so the wait below names the cause instead of a bare
  // 120 s timeout.
  let wsError = null;
  throwawayWs.on("message", (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      wsEvents.push(event);
      if (event.type === "error" && typeof event.message === "string") wsError = event.message;
    } catch {
      // Ignore non-JSON frames.
    }
  });
  await waitFor(
    async () => {
      if (wsError) throw new Error(`OMP session failed over WS: ${wsError}`);
      return wsEvents.some((e) => e.type === "session_status" && (e.payload?.state === "ready" || e.payload?.state === "connected"));
    },
    120_000,
    "OMP session ready over WS",
  );
  throwawayWs.send(JSON.stringify({ type: "set_model", provider: "Kuoai", modelId: "gpt-6-sol" }));
  await waitFor(async () => wsEvents.some((e) => e.type === "model_changed"), 60_000, "model_changed (Kuoai/gpt-6-sol)");
  throwawayWs.send(JSON.stringify({ type: "prompt", message: prompt }));
  // Wait for the agent to finish: poll the persisted session events.
  await waitFor(
    async () => {
      const session = await call("GET", `/api/projects/${throwawayId}/session`);
      assert.equal(session.status, 200, JSON.stringify(session.data));
      return session.data.events.some((e) => e.type === "session_settled");
    },
    600_000,
    "session_settled for the counter-app prompt",
  );
  const settledAt = Date.now();
  console.log(`  agent settled; checking generated files`);

  const tree = await call("GET", `/api/projects/${throwawayId}/files`);
  assert.equal(tree.status, 200, JSON.stringify(tree.data));
  const flat = [];
  (function flatten(nodes) {
    for (const node of nodes) {
      flat.push(node.path);
      if (node.children) flatten(node.children);
    }
  })(tree.data.tree);
  console.log(`  generated files: ${flat.join(", ")}`);
  assert.ok(flat.includes("package.json"), "generated app has no package.json");
  assert.ok(flat.some((p) => p === "index.html"), "generated app has no index.html");
  // Find the file that carries the Counter UI (Vite: src/App.jsx|tsx; static: index.html).
  const candidates = ["src/App.jsx", "src/App.tsx", "src/App.js", "index.html"];
  let markerPath = null;
  let markerContent = null;
  for (const candidate of candidates) {
    if (!flat.includes(candidate)) continue;
    const read = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent(candidate)}`);
    if (read.status === 200 && typeof read.data.content === "string" && read.data.content.includes("Counter")) {
      markerPath = candidate;
      markerContent = read.data;
      break;
    }
  }
  assert.ok(markerPath, `no generated file contains the 'Counter' UI text (files: ${flat.join(", ")})`);
  const pkg = await call("GET", `/api/projects/${throwawayId}/files/content?path=package.json`);
  assert.equal(pkg.status, 200, JSON.stringify(pkg.data));
  const isVite = pkg.data.content.includes('"vite"') && pkg.data.content.includes('"react"');
  console.log(`  marker file: ${markerPath} (vite+react: ${isVite})`);

  const preview = await startPreviewAndWait(throwawayId);
  assert.equal(preview.framework, isVite ? "vite" : "static", `expected framework ${isVite ? "vite" : "static"}, got ${preview.framework}`);
  const servedPath = markerPath === "index.html" ? "/" : `/${markerPath}`;
  const home = await fetchText(`${api}/api/preview/${throwawayId}/`, { headers: { cookie: `omp_builder_session=${token}` } });
  assert.equal(home.status, 200, `gateway home: ${home.status}`);
  assert.ok(home.body.includes("root") || home.body.includes("Counter"), "gateway home page has no app root/marker");
  const served = await fetchText(`${api}/api/preview/${throwawayId}${servedPath}`, { headers: { cookie: `omp_builder_session=${token}` } });
  assert.equal(served.status, 200, `gateway ${servedPath}: ${served.status}`);
  assert.ok(served.body.includes("Counter"), `served ${servedPath} does not contain the Counter UI`);
  console.log(`  preview serves the generated app through the gateway (${preview.framework}, ${servedPath})`);

  // Edit one file through the file API and confirm the preview serves it.
  const editMarker = `Counter-E2E-${randomBytes(3).toString("hex")}`;
  const edited = markerContent.content.replace("Counter", editMarker);
  assert.notEqual(edited, markerContent.content, "edit did not change the file content");
  const saved = await call("PUT", `/api/projects/${throwawayId}/files/content`, {
    path: markerPath,
    content: edited,
    expectedMtime: markerContent.mtimeMs,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  await waitFor(
    async () => {
      const again = await fetchText(`${api}/api/preview/${throwawayId}${servedPath}`, { headers: { cookie: `omp_builder_session=${token}` } });
      return again.status === 200 && again.body.includes(editMarker);
    },
    90_000,
    `preview serving edited marker ${editMarker}`,
  );
  console.log(`  edit through the file API is live in the preview (${editMarker})`);
  await stopPreview(throwawayId);
  // stop() removes the container, but be explicit so no exited residue can
  // confuse the restart test's "no orphan container" assertion.
  await podman(["rm", "-f", `omp-preview-${throwawayId.slice(0, 8)}`]).catch(() => undefined);
  ok("full prompt-to-preview E2E: real OMP (Kuoai/gpt-6-sol) generated a React+Vite counter app, gateway served it, file-API edit went live in the preview");

  // ---- Check 2: backend restart recovery (real API restart). ----
  // The container is killed EXTERNALLY first, so the DB row is genuinely
  // stale (status running, no container) when the API restarts — that is
  // the case reconcile() must mark stopped. (Without the external kill
  // the container survives the restart — close() only detaches log
  // followers — and reconcile correctly leaves the row running, logging
  // nothing: it only logs when something was removed or marked stale.)
  await startPreviewAndWait(PHASE2_ID);
  const phase2Home = await fetchText(`${api}/api/preview/${PHASE2_ID}/`, { headers: { cookie: `omp_builder_session=${token}` } });
  assert.equal(phase2Home.status, 200, `Phase 2 gateway before restart: ${phase2Home.status}`);
  const beforeHashes = await hashTree(path.join(projectsRoot, PHASE2_ID));
  assert.ok(Object.keys(beforeHashes).length > 0, "Phase 2 workspace hashed to zero files");
  const beforeRow = db.prepare("SELECT * FROM preview_state WHERE project_id = ?").get(PHASE2_ID);
  assert.equal(beforeRow.status, "running", `Phase 2 preview_state before restart: ${beforeRow.status}`);
  const maxEventId = db.prepare("SELECT MAX(id) AS m FROM omp_events WHERE project_id = ?").get(PHASE2_ID).m;
  assert.ok(Number.isFinite(maxEventId) && maxEventId > 0, "Phase 2 has no persisted events to replay");
  await podman(["rm", "-f", "omp-preview-134cc3fe"]);
  const gone = await podman(["ps", "-a", "--format", "{{.Names}}"]);
  assert.ok(!gone.split("\n").some((name) => name.trim() === "omp-preview-134cc3fe"), "Phase 2 container still listed after external rm -f");
  console.log(`  Phase 2 container removed externally; row is now stale (running, no container)`);

  // The service is managed by systemd (Phase 3.5 §2): restart the unit.
  // Killing the concurrently process directly would race the unit's
  // Restart=on-failure on the same port, so the old kill + manual
  // `npm run dev` relaunch is gone — `systemctl restart` is the restart.
  console.log(`  restarting omp-builder.service via systemctl`);
  await restartService();
  await waitFor(
    async () => {
      try {
        const res = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch {
        return false;
      }
    },
    120_000,
    "API health after restart (verify via the journal, not assumed)",
  );
  // The journal is read after health is back, so the listening line has
  // had time to land. reconcile() only logs "[preview] startup
  // reconcile" when it removed or marked something, so that line is NOT
  // required. The restart is proven by the listening line + the DB-row
  // effect asserted below.
  const restartLog = await restartServiceJournal();
  assert.ok(restartLog.includes("OMP Builder API listening"), `journal has no API listening line after restart; tail:\n${restartLog.slice(-2000)}`);
  const webUp = await waitFor(
    async () => {
      try {
        return (await fetch("http://127.0.0.1:5173/", { signal: AbortSignal.timeout(3000) })).ok;
      } catch {
        return false;
      }
    },
    120_000,
    "web dev server 5173 after restart",
  ).then(() => true);
  assert.ok(webUp, "web 5173 did not come back after restart");

  const afterRow = db.prepare("SELECT * FROM preview_state WHERE project_id = ?").get(PHASE2_ID);
  assert.ok(afterRow, "Phase 2 preview_state row vanished across the restart");
  assert.equal(afterRow.status, "stopped", `Phase 2 preview_state after restart: ${afterRow.status} (expected stopped — the container was removed before the restart)`);
  const containers = await podman(["ps", "-a", "--format", "{{.Names}}"]);
  assert.ok(!containers.split("\n").some((name) => name.startsWith("omp-preview-")), `orphan preview container after restart:\n${containers}`);
  const afterHashes = await hashTree(path.join(projectsRoot, PHASE2_ID));
  assert.deepEqual(afterHashes, beforeHashes, "Phase 2 workspace files changed across the restart");
  // Fresh WS connection replays the project's persisted events.
  const replayed = [];
  const replayWs = new WebSocket(`ws://127.0.0.1:8787/ws/projects/${PHASE2_ID}`, { headers: { cookie: `omp_builder_session=${token}` } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("replay WS did not open in 30s")), 30_000);
    replayWs.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    replayWs.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  replayWs.on("message", (raw) => {
    try {
      replayed.push(JSON.parse(raw.toString()));
    } catch {
      // Ignore non-JSON frames.
    }
  });
  await waitFor(async () => replayed.some((e) => typeof e.eventId === "number" && e.eventId <= maxEventId), 60_000, "WS replay of a pre-restart event");
  replayWs.close();
  console.log(`  replayed ${replayed.length} events on a fresh WS (incl. pre-restart id <= ${maxEventId})`);
  ok("backend restart recovery: API killed + relaunched, preview_state reconciled to stopped, no orphan container, workspace files unchanged, fresh WS replays persisted events");

  // ---- Check 3: security re-probes against a live preview container. ----
  await startPreviewAndWait(PHASE2_ID);
  const container = "omp-preview-134cc3fe";
  const execIn = async (args) => {
    try {
      return { ok: true, out: await podman(["exec", container, ...args], 30_000) };
    } catch (error) {
      return { ok: false, out: String(error.stdout ?? error.message ?? error) };
    }
  };
  const shadow = await execIn(["sh", "-c", "cat /etc/shadow; echo rc=$?"]);
  assert.ok(shadow.out.includes("rc="), `shadow probe produced no output: ${JSON.stringify(shadow.out)}`);
  assert.ok(!/\$[156y]\$/.test(shadow.out), `password hash visible inside container?! ${shadow.out.slice(0, 200)}`);
  assert.ok(!shadow.out.includes("omp-builder"), `host user leaked into container shadow?! ${shadow.out.slice(0, 200)}`);
  const rootSsh = await execIn(["sh", "-c", "ls /root/.ssh 2>&1; echo rc=$?"]);
  assert.ok(rootSsh.out.includes("rc=2") || rootSsh.out.includes("No such file"), `host /root/.ssh visible?! ${rootSsh.out}`);
  const loopback = await execIn([
    "node",
    "-e",
    "fetch('http://127.0.0.1:8787/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('REACHABLE:'+r.status)).catch(()=>console.log('UNREACHABLE'))",
  ]);
  assert.ok(loopback.out.includes("UNREACHABLE"), `host loopback API reachable from container?! ${loopback.out}`);
  const hostLan = await execIn([
    "node",
    "-e",
    "fetch('http://191.40.5.90:8787/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('HOST-LAN-REACHABLE:'+r.status)).catch(()=>console.log('HOST-LAN-UNREACHABLE'))",
  ]);
  const hostLanReachable = hostLan.out.includes("HOST-LAN-REACHABLE");
  console.log(`  note: host-LAN 191.40.5.90:8787 from container: ${hostLanReachable ? "REACHABLE" : "unreachable"} (recorded, not asserted — varies between runs)`);
  const otherStaging = await execIn(["sh", "-c", `test -d /var/lib/omp-builder/previews/${GUA_ID} && echo LEAKED || echo ISOLATED`]);
  assert.ok(otherStaging.out.includes("ISOLATED"), `other project staging visible?! ${otherStaging.out}`);
  const envOut = await execIn(["printenv"]);
  assert.ok(envOut.ok, "printenv in container failed");
  const secretNames = envOut.out.split("\n").filter((line) => /^(.*=)?(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(line.split("=")[0] ?? ""));
  assert.deepEqual(secretNames, [], `container env exposes secret-named vars: ${secretNames.join(", ")}`);
  assert.ok(!envOut.out.includes("Kuoai"), "container env mentions the Kuoai provider");
  const cmdline = await execIn(["cat", "/proc/1/cmdline"]);
  assert.ok(!/key\s*=/i.test(cmdline.out.replace(/\0/g, " ")), `container init cmdline carries key material: ${cmdline.out.slice(0, 300)}`);

  const noCookie = await fetchText(`${api}/api/preview/${PHASE2_ID}/`);
  assert.equal(noCookie.status, 401, `gateway without cookie: ${noCookie.status} (expected 401)`);
  const unknown = await call("GET", "/api/preview/00000000-0000-0000-0000-000000000000/");
  assert.equal(unknown.status, 404, `gateway unknown project: ${unknown.status} (expected 404)`);
  const stoppedGua = await call("GET", `/api/preview/${GUA_ID}/`);
  assert.equal(stoppedGua.status, 503, `gateway stopped preview: ${stoppedGua.status} (expected 503)`);
  await stopPreview(PHASE2_ID);
  ok("security re-probes: no host shadow/root/.ssh/loopback-API/other-staging access, no secret-named env vars or key material in cmdline, unauthorized preview 401 / unknown 404 / stopped 503");

  // ---- Check 4: app.db hardening holds across the restart. ----
  for (const name of ["app.db", "app.db-wal", "app.db-shm"]) {
    const mode = (await stat(path.join(path.dirname(dbPath), name))).mode & 0o777;
    assert.equal(mode, 0o600, `${name} mode is ${mode.toString(8)} (expected 600)`);
  }
  ok("app.db hardening holds across the restart: app.db, app.db-wal and app.db-shm are all 0600");
  console.log(`phase3 e2e checks passed (${passed} checks)`);
} finally {
  // Best-effort cleanup: stop previews, delete the throwaway through the
  // API (which closes its OMP session, sweeps any dev-server tree rooted
  // in the workspace, then removes the DB rows, workspace and session
  // dir), remove preview staging + the node_modules volume (not owned by
  // the delete endpoint), revoke the test session.
  try {
    if (throwawayWs) throwawayWs.close();
  } catch {
    // Ignore WS close errors during cleanup.
  }
  await call("POST", `/api/projects/${PHASE2_ID}/preview/stop`).catch(() => undefined);
  await call("POST", `/api/projects/${GUA_ID}/preview/stop`).catch(() => undefined);
  if (throwawayId) {
    // Phase 3.5 (§5 fix): deleting through the API instead of a direct DB
    // delete + cmdline SIGTERM. The old path leaked the OMP child (and
    // any dev-server tree) whenever the cmdline scan missed it, holding
    // a pool slot until the 15-minute idle reap.
    const deleted = await call("DELETE", `/api/projects/${throwawayId}`).catch(() => null);
    if (deleted?.status === 200) {
      console.log(`throwaway project ${throwawayId} deleted via API (DB rows, workspace, session dir; swept PIDs: ${JSON.stringify(deleted.data.sweptProcesses ?? [])})`);
      if (deleted.data.workspaceRemoved === false) {
        // The API runs as omp-builder and cannot remove foreign-owned
        // files; this suite runs as root, so finish the removal directly.
        console.log(`WARNING: API could not remove throwaway workspace (foreign-owned files); removing directly`);
        await rm(path.join(projectsRoot, throwawayId), { recursive: true, force: true }).catch(() => undefined);
      }
    } else {
      console.log(`WARNING: API delete of throwaway ${throwawayId} failed (status ${deleted?.status ?? "unreachable"}); falling back to direct removal`);
      db.prepare("DELETE FROM projects WHERE id = ?").run(throwawayId);
      db.prepare("DELETE FROM preview_state WHERE project_id = ?").run(throwawayId);
      db.prepare("DELETE FROM omp_events WHERE project_id = ?").run(throwawayId);
      await rm(path.join(projectsRoot, throwawayId), { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(path.join(previewRoot, throwawayId), { recursive: true, force: true }).catch(() => undefined);
    await podman(["rm", "-f", `omp-preview-${throwawayId.slice(0, 8)}`]).catch(() => undefined);
    await podman(["volume", "rm", `omp-preview-nm-${throwawayId.slice(0, 8)}`]).catch(() => undefined);
  }
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").run(new Date().toISOString(), tokenHash);
  try {
    const revoked = await fetch(`${api}/api/projects/${PHASE2_ID}/preview/status`, { headers: { cookie: `omp_builder_session=${token}` } });
    assert.equal(revoked.status, 401, "revoked test session still accepted");
    console.log("test session revoked");
  } catch (error) {
    console.log(`WARNING: could not verify session revocation (API may be down): ${error instanceof Error ? error.message : error}`);
    // Last-resort: if the API is down, start the service so the host is not left broken.
    try {
      await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(3000) });
    } catch {
      console.log("API is down after the e2e run — starting the omp-builder service");
      await execFileAsync("/usr/bin/systemctl", ["start", "omp-builder.service"]).catch(() => undefined);
      await sleep(20_000);
    }
  }
  db.close();
}
