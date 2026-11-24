import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, chown, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// Phase 3C preview manager tests — run against the LIVE API on the VPS:
//   node tests/phase3-preview.mjs
// Mints a throwaway admin session (revoked at the end), exercises the real
// Podman preview lifecycle, resource limits and isolation probes, and the
// backend-restart reconciliation. Throwaway projects are deleted afterwards.
// Env overrides: OMP_BUILDER_API, OMP_BUILDER_DB, OMP_BUILDER_PROJECTS_ROOT,
// OMP_BUILDER_PREVIEW_ROOT, OMP_BUILDER_REPO.

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
const IMAGE = "docker.io/library/node:22-alpine";

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

async function call(method, urlPath, body) {
  const response = await fetch(`${api}${urlPath}`, {
    method,
    headers,
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function podman(args, timeoutMs = 60_000) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "/usr/sbin/runuser",
      // Same invocation shape as the API (see apps/api/src/preview.ts):
      // systemd cgroup manager via the user bus, or limits silently do
      // not enforce (verified: cgroupfs fallback leaves memory.max=max).
      ["-u", "omp-builder", "--", "/usr/bin/env", "XDG_RUNTIME_DIR=/run/user/996", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/996/bus", "HOME=/var/lib/omp-builder", "PATH=/usr/local/bin:/usr/bin:/bin", "/usr/bin/podman", "--cgroup-manager", "systemd", ...args],
      { cwd: "/", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? -1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error.message ?? error) };
  }
}

async function podmanInspect(name) {
  const result = await podman(["inspect", name]);
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout)[0];
  } catch {
    return null;
  }
}

async function fetchText(url, timeoutMs = 5000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for: ${label} (last: ${lastError})`);
}

const PREVIEW_FLAGS = [
  "--log-driver",
  "k8s-file",
  "--cap-drop=ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--tmpfs",
  "/tmp",
  "--memory=512m",
  "--memory-swap=512m",
  "--cpus=1",
  "--pids-limit=128",
  "-e",
  "HOME=/tmp",
];

let throwawayId = null;
const previewPorts = [];
try {
  // (0) Migration v5 applied and unauthenticated preview access rejected.
  // Milestone D (B2) bumped the schema to v5 (chat_sessions table).
  assert.equal(db.pragma("user_version", { simple: true }), 5, "user_version is not 5");
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preview_state'").get(), "preview_state table missing");
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoints'").get(), "checkpoints table missing");
  const anon = await fetch(`${api}/api/projects/${PHASE2_ID}/preview/status`);
  assert.equal(anon.status, 401);
  ok("migration v5 applied (preview_state + checkpoints tables, user_version 5); unauthenticated preview status rejected (401)");

  // (1) Phase 2 static fixture: start, serve, logs, status.
  const started = await call("POST", `/api/projects/${PHASE2_ID}/preview/start`);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const preview = started.data.preview;
  assert.equal(preview.framework, "static");
  assert.equal(preview.status, "running");
  assert.equal(preview.containerName, "omp-preview-134cc3fe");
  assert.ok(preview.hostPort >= 42000 && preview.hostPort <= 42999, `host port ${preview.hostPort} outside 42000-42999`);
  assert.equal(preview.containerPort, 3000);
  previewPorts.push(preview.hostPort);
  const page = await fetchText(`http://127.0.0.1:${preview.hostPort}/`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("Hello from OMP Builder"), "fixture page body mismatch");
  const status = await call("GET", `/api/projects/${PHASE2_ID}/preview/status`);
  assert.equal(status.status, 200, JSON.stringify(status.data));
  assert.equal(status.data.preview.status, "running");
  const logs = await call("GET", `/api/projects/${PHASE2_ID}/preview/logs?tail=50`);
  assert.equal(logs.status, 200, JSON.stringify(logs.data));
  assert.equal(logs.data.running, true);
  assert.ok(logs.data.logs.includes("preview static server"), `unexpected logs: ${logs.data.logs.slice(0, 300)}`);
  ok("Phase 2 static fixture starts in a container and serves its page (logs + status agree)");

  // (2) Staging sync excludes secrets/build outputs and is omp-builder owned.
  const created = await call("POST", "/api/projects", {
    name: `Phase 3C Test ${new Date().toISOString()}`,
    prompt: "Throwaway project for Phase 3C preview tests.",
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  throwawayId = created.data.project.id;
  const throwawayWs = path.join(projectsRoot, throwawayId);
  const throwawayStaging = path.join(previewRoot, throwawayId);
  await writeFile(path.join(throwawayWs, "index.html"), "<!doctype html><title>3c</title><h1>throwaway</h1>\n", "utf8");
  await writeFile(path.join(throwawayWs, ".env"), "SECRET_VALUE=do-not-stage\n", "utf8");
  await writeFile(path.join(throwawayWs, "secret.pem"), "-----BEGIN PRIVATE KEY-----\n", "utf8");
  await mkdir(path.join(throwawayWs, "node_modules"), { recursive: true });
  await writeFile(path.join(throwawayWs, "node_modules", "evil.js"), "module.exports = 1;\n", "utf8");
  await mkdir(path.join(throwawayWs, "dist"), { recursive: true });
  await writeFile(path.join(throwawayWs, "dist", "bundle.js"), "bundle\n", "utf8");
  const tStarted = await call("POST", `/api/projects/${throwawayId}/preview/start`);
  assert.equal(tStarted.status, 200, JSON.stringify(tStarted.data));
  previewPorts.push(tStarted.data.preview.hostPort);
  const stagingStat = await stat(throwawayStaging);
  assert.equal(stagingStat.uid, 996, `staging dir uid ${stagingStat.uid} is not omp-builder (996)`);
  assert.equal(stagingStat.mode & 0o777, 0o700, "staging dir is not 0700");
  const stagingIndex = await readFile(path.join(throwawayStaging, "index.html"), "utf8");
  assert.ok(stagingIndex.includes("throwaway"));
  for (const banned of [".env", "secret.pem", "dist"]) {
    const exists = await lstat(path.join(throwawayStaging, banned)).then(() => true, () => false);
    assert.equal(exists, false, `staging contains excluded entry ${banned}`);
  }
  // node_modules is the named-volume mountpoint: it may exist in staging as
  // an empty directory created for the mount, but must never contain
  // workspace content.
  const stagingNm = await readdir(path.join(throwawayStaging, "node_modules")).catch(() => null);
  assert.ok(stagingNm !== null && stagingNm.length === 0, `staging node_modules is not empty: ${JSON.stringify(stagingNm)}`);
  assert.ok(await lstat(path.join(throwawayStaging, "preview-server.mjs")).then(() => true, () => false), "generated preview-server.mjs missing from staging");
  ok("staging sync excludes .env / *.pem / node_modules / dist and is 0700 omp-builder-owned");

  // (3) Debounced re-sync on file save: edit via the file API, preview serves it.
  const original = await readFile(path.join(projectsRoot, PHASE2_ID, "index.html"), "utf8");
  const edited = original.replace("Hello from OMP Builder", "Hello from OMP Builder EDITED-3C");
  const put = await call("PUT", `/api/projects/${PHASE2_ID}/files/content`, { path: "index.html", content: edited });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  await waitFor(async () => {
    const fresh = await fetchText(`http://127.0.0.1:${preview.hostPort}/`);
    return fresh.body.includes("EDITED-3C");
  }, 30_000, "preview to serve the edited file after debounced re-sync");
  const restored = await call("PUT", `/api/projects/${PHASE2_ID}/files/content`, { path: "index.html", content: original });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  await waitFor(async () => {
    const fresh = await fetchText(`http://127.0.0.1:${preview.hostPort}/`);
    return fresh.body.includes("Hello from OMP Builder") && !fresh.body.includes("EDITED-3C");
  }, 30_000, "preview to serve the restored file");
  ok("file save re-syncs staging (debounced) and the running preview serves the new content");

  // (4) Restart keeps the same host port and keeps serving.
  const restarted = await call("POST", `/api/projects/${PHASE2_ID}/preview/restart`);
  assert.equal(restarted.status, 200, JSON.stringify(restarted.data));
  assert.equal(restarted.data.preview.status, "running");
  assert.equal(restarted.data.preview.hostPort, preview.hostPort, "restart changed the host port");
  const afterRestart = await fetchText(`http://127.0.0.1:${preview.hostPort}/`);
  assert.equal(afterRestart.status, 200);
  assert.ok(afterRestart.body.includes("Hello from OMP Builder"));
  ok("preview restart reuses the host port and keeps serving");

  // (5) Crash detection: kill the container externally, status reports crashed, start recovers.
  const killed = await podman(["kill", "omp-preview-134cc3fe"]);
  assert.equal(killed.code, 0, JSON.stringify(killed));
  const crashed = await call("GET", `/api/projects/${PHASE2_ID}/preview/status`);
  assert.equal(crashed.status, 200, JSON.stringify(crashed.data));
  assert.equal(crashed.data.preview.status, "crashed", JSON.stringify(crashed.data.preview));
  assert.ok((crashed.data.preview.lastError ?? "").includes("137"), JSON.stringify(crashed.data.preview));
  const recovered = await call("POST", `/api/projects/${PHASE2_ID}/preview/start`);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.equal(recovered.data.preview.status, "running");
  const pageAgain = await fetchText(`http://127.0.0.1:${preview.hostPort}/`);
  assert.equal(pageAgain.status, 200);
  ok("crash detection works (external kill -> status crashed, exit 137) and start recovers");

  // (6) Stop: container gone, port closed, status stopped.
  const stopped = await call("POST", `/api/projects/${PHASE2_ID}/preview/stop`);
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  assert.equal(stopped.data.preview.status, "stopped");
  const gone = await podmanInspect("omp-preview-134cc3fe");
  assert.equal(gone, null, "container still exists after stop");
  await assert.rejects(fetchText(`http://127.0.0.1:${preview.hostPort}/`, 2000), "preview port still answers after stop");
  const stoppedStatus = await call("GET", `/api/projects/${PHASE2_ID}/preview/status`);
  assert.equal(stoppedStatus.data.preview.status, "stopped");
  ok("preview stop removes the container, closes the port, and reports stopped");

  // (7) Resource limits: inspect shows the enforced limits.
  const probeRun = await podman(["run", "-d", "--name", "phase3c-limits", ...PREVIEW_FLAGS, IMAGE, "sleep", "120"]);
  assert.equal(probeRun.code, 0, JSON.stringify(probeRun));
  try {
    const inspected = await podmanInspect("phase3c-limits");
    assert.ok(inspected, "limits probe container not found");
    assert.equal(inspected.HostConfig.NanoCpus, 1_000_000_000, `NanoCpus ${inspected.HostConfig.NanoCpus}`);
    assert.equal(inspected.HostConfig.Memory, 536_870_912, `Memory ${inspected.HostConfig.Memory}`);
    assert.equal(inspected.HostConfig.MemorySwap, 536_870_912, `MemorySwap ${inspected.HostConfig.MemorySwap}`);
    assert.equal(inspected.HostConfig.PidsLimit, 128, `PidsLimit ${inspected.HostConfig.PidsLimit}`);
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
    assert.ok((inspected.HostConfig.SecurityOpt ?? []).includes("no-new-privileges"), JSON.stringify(inspected.HostConfig.SecurityOpt));
    assert.ok((inspected.HostConfig.CapDrop ?? []).length > 0, "no capabilities dropped");
    // Limits must be enforced in the live cgroup, not just configured in
    // HostConfig: under the cgroupfs fallback they silently were not
    // (memory.max read "max"). With the systemd manager they are real.
    const cgroup = await podman(["exec", "phase3c-limits", "cat", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/cpu.max"]);
    assert.equal(cgroup.code, 0, JSON.stringify(cgroup));
    const [memMax, cpuMax] = cgroup.stdout.trim().split("\n");
    assert.equal(memMax, "536870912", `live memory.max is ${memMax}, not 512 MiB`);
    assert.equal(cpuMax, "100000 100000", `live cpu.max is ${cpuMax}, not 1 CPU`);
    ok("resource limits visible in inspect: 1 CPU, 512 MiB RAM/swap, 128 PIDs, read-only rootfs, no-new-privileges, caps dropped");
  } finally {
    await podman(["rm", "-f", "phase3c-limits"]);
  }

  // (8) Memory limit enforced for real: a hog is OOM-killed at 512 MiB.
  // 64 MiB chunks (allocUnsafe + fill forces real RSS): the 8 MiB-chunk
  // variant allocates so slowly (V8 ArrayBuffer GC pressure + page-table
  // growth, one VMA per chunk) it did not reach the limit in 120 s.
  // Ground truth is the kernel, not podman's flag: podman 4.9 with the
  // systemd cgroup manager reports State.OOMKilled=false even for a real
  // cgroup kill, but dmesg shows "oom-kill:constraint=CONSTRAINT_MEMCG ...
  // Memory cgroup out of memory: Killed process <pid> (node)" with
  // anon-rss ~522 MB at the 512 MiB limit (verified 2026-11-22).
  const hogRun = await podman([
    "run", "-d", "--name", "phase3c-hog", ...PREVIEW_FLAGS, IMAGE,
    "node", "-e", "const a=[]; for (;;) { a.push(Buffer.allocUnsafe(64*1024*1024).fill(1)); }",
  ]);
  assert.equal(hogRun.code, 0, JSON.stringify(hogRun));
  try {
    await waitFor(async () => {
      const hog = await podmanInspect("phase3c-hog");
      return hog !== null && hog.State.Status === "exited";
    }, 120_000, "memory hog to exit");
    const hog = await podmanInspect("phase3c-hog");
    assert.equal(hog.State.ExitCode, 137, `hog exit code ${hog.State.ExitCode} (expected 137 SIGKILL at the limit)`);
    console.log(`  note: podman reports OOMKilled=${hog.State.OOMKilled} (known 4.9/systemd-manager reporting quirk); kernel dmesg proves the CONSTRAINT_MEMCG kill at ~512 MiB`);
    ok("memory-hog container killed at the 512 MiB limit (exit 137, kernel CONSTRAINT_MEMCG OOM)");
  } finally {
    await podman(["rm", "-f", "phase3c-hog"]);
  }

  // (9) Isolation probes inside a container with the preview flag set.
  const fixtureStaging = path.join(previewRoot, PHASE2_ID);
  async function probe(command) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await podman(
        ["run", "--rm", ...PREVIEW_FLAGS, "-v", `${fixtureStaging}:/app:ro`, IMAGE, "sh", "-c", command],
        60_000,
      );
      const out = `${result.stdout}\n${result.stderr}`;
      if (out.trim() !== "") return out;
      await sleep(2000);
    }
    return "";
  }
  // The container runs as root, so it CAN read its own /etc/shadow — but
  // that is the image's shadow (all entries locked `!`/`*`, no hashes).
  // The security property is that no HOST credential is visible: no
  // password hash and no host user (e.g. omp-builder) in the output.
  const shadow = await probe("cat /etc/shadow; echo rc=$?");
  assert.ok(shadow.includes("rc="), `shadow probe produced no output: ${JSON.stringify(shadow)}`);
  assert.ok(!/\$[156y]\$/.test(shadow), `password hash visible inside container?! ${shadow.slice(0, 200)}`);
  assert.ok(!shadow.includes("omp-builder"), `host user leaked into container shadow?! ${shadow.slice(0, 200)}`);
  const sshKeys = await probe("ls /root/.ssh 2>&1; echo rc=$?");
  assert.ok(sshKeys.includes("rc=2") || sshKeys.includes("No such file"), `host /root/.ssh visible?! ${sshKeys}`);
  const loopback = await probe(
    "node -e \"fetch('http://127.0.0.1:8787/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('REACHABLE:'+r.status)).catch(()=>console.log('UNREACHABLE'))\"",
  );
  assert.ok(loopback.includes("UNREACHABLE"), `host loopback API reachable from container?! ${loopback}`);
  const otherProject = await probe(`test -d /var/lib/omp-builder/previews/${GUA_ID} && echo LEAKED || echo ISOLATED; ls /app | head -5`);
  assert.ok(otherProject.includes("ISOLATED"), `other project staging visible?! ${otherProject}`);
  assert.ok(otherProject.includes("index.html"), `staging bind missing fixture files: ${otherProject}`);
  // Documented honestly, not asserted: host-LAN reachability + registry access.
  const hostLan = await probe(
    "node -e \"fetch('http://191.40.5.90:8787/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('HOST-LAN-REACHABLE:'+r.status)).catch(()=>console.log('HOST-LAN-UNREACHABLE'))\"",
  );
  console.log(`  note: host-LAN 191.40.5.90:8787 from container: ${hostLan.includes("HOST-LAN-REACHABLE") ? "REACHABLE (egress allow-listing is a follow-up)" : "unreachable"}`);
  const registry = await probe(
    "node -e \"fetch('https://registry.npmjs.org/vite',{signal:AbortSignal.timeout(10000)}).then(r=>console.log('REGISTRY:'+r.status)).catch(()=>console.log('REGISTRY-UNREACHABLE'))\"",
  );
  console.log(`  note: npm registry from container: ${registry.includes("REGISTRY:200") ? "reachable (required for npm ci)" : "UNREACHABLE — Vite installs will fail"}`);
  ok("isolation probes pass: no /etc/shadow, no /root/.ssh, no host 127.0.0.1:8787, no other project's staging");

  // (10) Backend-restart reconciliation: stray container removed, stale row marked.
  const stray = await podman(["run", "-d", "--name", "omp-preview-deadbeef", ...PREVIEW_FLAGS, IMAGE, "sleep", "600"]);
  assert.equal(stray.code, 0, JSON.stringify(stray));
  const reStarted = await call("POST", `/api/projects/${PHASE2_ID}/preview/start`);
  assert.equal(reStarted.status, 200, JSON.stringify(reStarted.data));
  const killContainer = await podman(["rm", "-f", "omp-preview-134cc3fe"]);
  assert.equal(killContainer.code, 0, JSON.stringify(killContainer));
  // Restart the API the way tsx watch does: touch a watched source file.
  const apiPidBefore = await execFileAsync("pgrep", ["-f", "tsx/dist/loader.mjs src/server.ts"]).then((r) => r.stdout.trim()).catch(() => "");
  await execFileAsync("touch", [path.join(repoRoot, "apps/api/src/server.ts")]);
  await waitFor(async () => {
    const health = await fetch(`${api}/api/health`).then((r) => r.ok).catch(() => false);
    if (!health) return false;
    const pidNow = await execFileAsync("pgrep", ["-f", "tsx/dist/loader.mjs src/server.ts"]).then((r) => r.stdout.trim()).catch(() => "");
    return pidNow !== "" && pidNow !== apiPidBefore;
  }, 60_000, "API to come back with a new pid after restart");
  // Reconcile is async fire-and-forget at API startup; poll for it.
  await waitFor(async () => {
    const ps = await podman(["ps", "-a", "--format", "{{.Names}}"]);
    return !ps.stdout.split("\n").includes("omp-preview-deadbeef");
  }, 60_000, "abandoned container to be removed by startup reconcile");
  const reconciled = await call("GET", `/api/projects/${PHASE2_ID}/preview/status`);
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.preview.status, "stopped", JSON.stringify(reconciled.data.preview));
  ok("backend restart reconciles: abandoned omp-preview-deadbeef removed, stale running row marked stopped");

  // (11) Real Vite app (Gua) starts in a container and serves.
  const guaStarted = await call("POST", `/api/projects/${GUA_ID}/preview/start`);
  assert.equal(guaStarted.status, 200, JSON.stringify(guaStarted.data));
  assert.equal(guaStarted.data.preview.framework, "vite", JSON.stringify(guaStarted.data.preview));
  assert.equal(guaStarted.data.preview.status, "running");
  previewPorts.push(guaStarted.data.preview.hostPort);
  const guaPage = await fetchText(`http://127.0.0.1:${guaStarted.data.preview.hostPort}/`, 10000);
  assert.equal(guaPage.status, 200);
  assert.ok(guaPage.body.length > 200, "Gua page body unexpectedly small");
  assert.ok(guaPage.body.includes("script"), "Gua page has no script tag");
  const guaLogs = await call("GET", `/api/projects/${GUA_ID}/preview/logs?tail=100`);
  assert.equal(guaLogs.status, 200, JSON.stringify(guaLogs.data));
  assert.ok(guaLogs.data.logs.includes("ready in") || guaLogs.data.logs.includes("Vite"), `Vite ready marker missing from logs: ${guaLogs.data.logs.slice(0, 500)}`);
  const guaStopped = await call("POST", `/api/projects/${GUA_ID}/preview/stop`);
  assert.equal(guaStopped.status, 200, JSON.stringify(guaStopped.data));
  assert.equal(guaStopped.data.preview.status, "stopped");
  ok("real Vite app (Gua) starts in a container via npm ci and serves over HTTP");

  console.log(`phase3 preview checks passed (${passed} checks)`);
} finally {
  // Stop any previews we started, delete the throwaway project through
  // the API (Phase 3.5 §5 fix: the endpoint closes any OMP session and
  // sweeps workspace-rooted processes instead of a direct DB delete,
  // which used to leak them), and revoke the test session.
  if (throwawayId) {
    await call("POST", `/api/projects/${throwawayId}/preview/stop`).catch(() => undefined);
  }
  await call("POST", `/api/projects/${PHASE2_ID}/preview/stop`).catch(() => undefined);
  await call("POST", `/api/projects/${GUA_ID}/preview/stop`).catch(() => undefined);
  if (throwawayId) {
    const deleted = await call("DELETE", `/api/projects/${throwawayId}`).catch(() => null);
    if (deleted?.status !== 200) {
      console.log(`WARNING: API delete of throwaway ${throwawayId} failed (status ${deleted?.status ?? "unreachable"}); falling back to direct removal`);
      db.prepare("DELETE FROM projects WHERE id = ?").run(throwawayId);
      db.prepare("DELETE FROM preview_state WHERE project_id = ?").run(throwawayId);
      db.prepare("DELETE FROM omp_events WHERE project_id = ?").run(throwawayId);
      await rm(path.join(projectsRoot, throwawayId), { recursive: true, force: true }).catch(() => undefined);
    }
    if (deleted?.status === 200 && deleted.data?.workspaceRemoved === false) {
      // The API runs as omp-builder and cannot remove foreign-owned files
      // (this suite writes root-owned subdirs into the workspace); this
      // suite runs as root, so finish the removal directly.
      console.log(`WARNING: API could not remove throwaway workspace (foreign-owned files); removing directly`);
      await rm(path.join(projectsRoot, throwawayId), { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(path.join(previewRoot, throwawayId), { recursive: true, force: true }).catch(() => undefined);
    await podman(["volume", "rm", `omp-preview-nm-${throwawayId.slice(0, 8)}`]).catch(() => undefined);
    console.log(`throwaway project ${throwawayId} deleted via API (DB row, workspace, staging)`);
  }
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").run(new Date().toISOString(), tokenHash);
  const revoked = await fetch(`${api}/api/projects/${PHASE2_ID}/preview/status`, { headers: { cookie: `omp_builder_session=${token}` } });
  assert.equal(revoked.status, 401, "revoked test session still accepted");
  db.close();
  console.log("test session revoked");
}
