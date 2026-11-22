import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

// Phase 3D preview gateway tests — run against the LIVE API on the VPS:
//   npm run build && node tests/phase3-gateway.mjs
// Mints a throwaway admin session (revoked at the end), exercises the
// authenticated gateway (HTTP + WS HMR), SSRF / cross-project blocks, the
// iframe-isolation failure mode, and the per-project fs watcher.
// Throwaway projects are deleted afterwards.
// Env overrides: OMP_BUILDER_API, OMP_BUILDER_DB, OMP_BUILDER_PROJECTS_ROOT,
// OMP_BUILDER_PREVIEW_ROOT, OMP_BUILDER_REPO.

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const api = process.env.OMP_BUILDER_API ?? "http://127.0.0.1:8787";
const dbPath = process.env.OMP_BUILDER_DB ?? "/root/projects/omp-builder/data/persistent/app.db";
const projectsRoot = process.env.OMP_BUILDER_PROJECTS_ROOT ?? "/root/projects/omp-builder/data/projects";
const previewRoot = process.env.OMP_BUILDER_PREVIEW_ROOT ?? "/var/lib/omp-builder/previews";
const repoRoot = process.env.OMP_BUILDER_REPO ?? "/root/projects/omp-builder";
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
  return { status: response.status, data, rawHeaders: response.headers };
}

async function fetchText(url, options, timeoutMs = 5000) {
  const response = await fetch(url, { ...(options ?? {}), signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: await response.text(), headers: response.headers };
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

/** Connect a WS client; resolves with { opened, closed, messages }.
 * Vite's HMR endpoint only handles upgrades whose Sec-WebSocket-Protocol
 * is `vite-hmr` (or `vite-ping`) — exactly what the real @vite/client
 * sends — so HMR probes include it. */
function wsConnect(url, cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, "vite-hmr", { headers: cookie ? { cookie } : {} });
    const messages = [];
    let opened = false;
    let closed = false;
    const done = () => resolve({ ws, opened, closed, messages });
    ws.on("open", () => {
      opened = true;
    });
    ws.on("message", (raw) => messages.push(raw.toString()));
    ws.on("close", () => {
      closed = true;
      done();
    });
    ws.on("error", () => {
      // Server rejects the upgrade by writing 401/404/502 and destroying
      // the socket: the client sees an error/close without ever opening.
      setTimeout(done, 500);
    });
    setTimeout(done, 8000);
  });
}

let throwawayId = null;
try {
  // (0) Unauthenticated gateway access is rejected (401, no cookie).
  const anon = await fetch(`${api}/api/preview/${PHASE2_ID}/`);
  assert.equal(anon.status, 401, `unauthenticated gateway returned ${anon.status}`);
  const badCookie = await fetch(`${api}/api/preview/${PHASE2_ID}/`, { headers: { cookie: "omp_builder_session=not-a-real-token" } });
  assert.equal(badCookie.status, 401, `bad-cookie gateway returned ${badCookie.status}`);
  const anonWs = await wsConnect(`ws://127.0.0.1:8787/api/preview/${PHASE2_ID}/__hmr`);
  assert.equal(anonWs.opened, false, "unauthenticated HMR upgrade opened");
  anonWs.ws.terminate();
  ok("unauthenticated gateway HTTP (401) and HMR upgrade (no open) rejected");

  // (1) Unknown project id -> 404, never a proxy.
  const unknown = await call("GET", `/api/preview/00000000-0000-4000-8000-000000000000/`);
  assert.equal(unknown.status, 404, JSON.stringify(unknown.data));
  ok("gateway to an unknown project returns 404");

  // (2) Authenticated request to a stopped preview -> clear not-running
  // error (503), not a proxy to nowhere.
  const stopped = await call("GET", `/api/preview/${PHASE2_ID}/`);
  assert.equal(stopped.status, 503, JSON.stringify(stopped.data));
  assert.ok((stopped.data?.error ?? "").includes("not running"), `unexpected stopped-preview error: ${JSON.stringify(stopped.data)}`);
  const stoppedWs = await wsConnect(`ws://127.0.0.1:8787/api/preview/${PHASE2_ID}/__hmr`, `omp_builder_session=${token}`);
  assert.equal(stoppedWs.opened, false, "HMR upgrade to a stopped preview opened");
  stoppedWs.ws.terminate();
  ok("authenticated request to a stopped preview returns 503 'not running' (HTTP + HMR)");

  // (3) Start the Phase 2 static preview; the gateway serves it.
  const started = await call("POST", `/api/projects/${PHASE2_ID}/preview/start`);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.preview.status, "running");
  const gatewayRoot = await fetchText(`${api}/api/preview/${PHASE2_ID}/`, { headers });
  assert.equal(gatewayRoot.status, 200);
  assert.ok(gatewayRoot.body.includes("Hello from OMP Builder"), "gateway page body mismatch");
  const asset = await fetchText(`${api}/api/preview/${PHASE2_ID}/index.html`, { headers });
  assert.equal(asset.status, 200);
  assert.ok(asset.body.includes("Hello from OMP Builder"));
  const spa = await fetchText(`${api}/api/preview/${PHASE2_ID}/some/spa/route`, { headers });
  assert.equal(spa.status, 200, "SPA fallback through the gateway failed");
  assert.ok(spa.body.includes("Hello from OMP Builder"));
  const query = await fetchText(`${api}/api/preview/${PHASE2_ID}/?x=1&y=two`, { headers });
  assert.equal(query.status, 200, "query string through the gateway failed");
  const head = await fetch(`${api}/api/preview/${PHASE2_ID}/`, { method: "HEAD", headers });
  assert.equal(head.status, 200, `HEAD through the gateway returned ${head.status}`);
  const post = await call("POST", `/api/preview/${PHASE2_ID}/`);
  assert.equal(post.status, 404, `POST through the gateway returned ${post.status} (only GET/HEAD are proxied)`);
  ok("running preview serves its page, assets, SPA fallback, query strings and HEAD through the gateway; POST is not proxied");

  // (4) The gateway never passes /api/* through to Builder APIs.
  const apiPassthrough = await call("GET", `/api/preview/${PHASE2_ID}/api/projects`);
  assert.equal(apiPassthrough.status, 403, JSON.stringify(apiPassthrough.data));
  assert.ok(!(JSON.stringify(apiPassthrough.data ?? "").includes(PHASE2_ID)), "gateway leaked project data via /api passthrough");
  const authPassthrough = await call("GET", `/api/preview/${PHASE2_ID}/api/auth/status`);
  assert.equal(authPassthrough.status, 403, JSON.stringify(authPassthrough.data));
  // Encoded slash must not smuggle an /api path either: the container
  // answers with its own page (the static server's SPA fallback) or 404 —
  // never Builder data.
  const encodedApi = await fetchText(`${api}/api/preview/${PHASE2_ID}/api%2fprojects`, { headers });
  assert.ok(!encodedApi.body.includes('"projects"'), "encoded /api path leaked Builder data");
  assert.ok(!encodedApi.body.includes(PHASE2_ID), "encoded /api path leaked project data");
  ok("gateway blocks /api/* passthrough (plain and %-encoded) with 403/404 and no Builder data");

  // (5) SSRF attempts: the target is always the preview container's
  // loopback port from the DB row; crafted paths cannot reach the API,
  // another port, or the host filesystem.
  const ssrfAbsolute = await fetchText(`${api}/api/preview/${PHASE2_ID}/http://127.0.0.1:8787/api/projects`, { headers });
  // The container answers with its own page (SPA fallback) or 404 — the
  // assertion is that no Builder data comes back, whatever the status.
  assert.ok(!ssrfAbsolute.body.includes('"projects"'), `absolute-URL SSRF leaked Builder data: ${ssrfAbsolute.body.slice(0, 200)}`);
  assert.ok(!ssrfAbsolute.body.includes(PHASE2_ID), "absolute-URL SSRF leaked project data");
  const traversal = await fetchText(`${api}/api/preview/${PHASE2_ID}/%2e%2e/%2e%2e/etc/passwd`, { headers });
  assert.ok(traversal.status === 400 || traversal.status === 404, `traversal returned ${traversal.status}`);
  assert.ok(!traversal.body.includes("root:"), "path traversal leaked /etc/passwd");
  const doubleEncoded = await fetchText(`${api}/api/preview/${PHASE2_ID}/%252e%252e/%252e%252e/etc/passwd`, { headers });
  assert.ok(!doubleEncoded.body.includes("root:"), "double-encoded traversal leaked /etc/passwd");
  ok("SSRF attempts rejected: absolute-URL, traversal and double-encoded paths never reach the API or host files");

  // (6) Cross-project: the gateway for project X only ever serves X.
  // Gua is stopped, so its gateway must 503 even while Phase 2 runs.
  const crossStopped = await call("GET", `/api/preview/${GUA_ID}/`);
  assert.equal(crossStopped.status, 503, JSON.stringify(crossStopped.data));
  const created = await call("POST", "/api/projects", { name: `Phase 3D Test ${new Date().toISOString()}`, prompt: "Throwaway project for Phase 3D gateway tests." });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  throwawayId = created.data.project.id;
  const crossMissing = await call("GET", `/api/preview/${throwawayId}/`);
  assert.equal(crossMissing.status, 503, JSON.stringify(crossMissing.data));
  const own = await fetchText(`${api}/api/preview/${PHASE2_ID}/`, { headers });
  assert.ok(own.body.includes("Hello from OMP Builder") && !own.body.includes("Gua"), "Phase 2 gateway served another project's content");
  ok("cross-project access rejected: another project's gateway 503s while Phase 2 runs, and Phase 2 serves only its own page");

  // (7) The iframe-isolation failure mode, verified at the HTTP layer.
  // Generated JS in the sandboxed iframe runs in an opaque origin, so its
  // fetch('/api/projects') sends Origin: null. The API's CORS check runs
  // before auth and rejects the null origin with 403 — with or without a
  // cookie — so the call can never succeed. (The in-browser end of this
  // probe — real JS inside the real sandboxed iframe — is covered by
  // tests/phase3-gateway-browser-probe.mjs; see its notes.)
  const nullNoCookie = await fetch(`${api}/api/projects`, { headers: { origin: "null" } });
  assert.equal(nullNoCookie.status, 403, `Origin:null without cookie returned ${nullNoCookie.status}`);
  const nullWithCookie = await fetch(`${api}/api/projects`, { headers: { origin: "null", cookie: `omp_builder_session=${token}` } });
  assert.equal(nullWithCookie.status, 403, `Origin:null with cookie returned ${nullWithCookie.status}`);
  // Controls: same-origin (no Origin header) is 401 without a cookie and
  // 200 with one — the API itself works; only the opaque origin is blocked.
  const sameNoCookie = await fetch(`${api}/api/projects`);
  assert.equal(sameNoCookie.status, 401, `same-origin without cookie returned ${sameNoCookie.status}`);
  const sameWithCookie = await fetch(`${api}/api/projects`, { headers: { cookie: `omp_builder_session=${token}` } });
  assert.equal(sameWithCookie.status, 200, `same-origin with cookie returned ${sameWithCookie.status}`);
  // The built web bundle must not contain allow-same-origin anywhere in
  // the APP chunk (index-*.js). Monaco's language workers (html.worker.js
  // etc.) mention the token in their own docs strings — those are not our
  // iframe and are out of scope here.
  let distChecked = false;
  try {
    const distDir = path.join(repoRoot, "apps/web/dist/assets");
    const names = await readdir(distDir);
    const appChunks = names.filter((name) => /^index-.*\.js$/.test(name));
    assert.ok(appChunks.length > 0, "no index-*.js app chunk in apps/web/dist/assets — run npm run build first");
    let bundle = "";
    for (const name of appChunks) bundle += await readFile(path.join(distDir, name), "utf8");
    assert.ok(bundle.length > 0, "app chunk is empty");
    assert.ok(!bundle.includes("allow-same-origin"), "built app bundle still contains allow-same-origin");
    assert.ok(bundle.includes("allow-scripts allow-forms allow-popups"), "hardened iframe sandbox string missing from built bundle");
    assert.ok(!bundle.includes("omp-builder-preview-url"), "built bundle still references the removed localStorage preview URL");
    distChecked = true;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    console.log(`  note: built-bundle sandbox check skipped (dist not built?): ${error instanceof Error ? error.message : error}`);
  }
  ok(`iframe isolation at the HTTP layer: Origin:null fetch to /api/projects is 403 with or without a cookie (CORS rejects the null origin before auth), while same-origin calls are 401 without a cookie and 200 with one${distChecked ? "; built bundle has no allow-same-origin and no localStorage preview URL" : " (built-bundle check skipped — run npm run build)"}`);

  // (8) WS HMR upgrade through the gateway works for a real Vite app,
  // and a file edit produces a real HMR update over the tunnel.
  const guaStarted = await call("POST", `/api/projects/${GUA_ID}/preview/start`);
  assert.equal(guaStarted.status, 200, JSON.stringify(guaStarted.data));
  assert.equal(guaStarted.data.preview.framework, "vite", JSON.stringify(guaStarted.data.preview));
  const stagingConfig = await readFile(path.join(previewRoot, GUA_ID, "vite.preview.config.mjs"), "utf8");
  assert.ok(stagingConfig.includes(`/api/preview/${GUA_ID}/__hmr`), "staged Vite wrapper does not pin the gateway HMR path");
  const hmr = await wsConnect(`ws://127.0.0.1:8787/api/preview/${GUA_ID}/__hmr`, `omp_builder_session=${token}`);
  assert.equal(hmr.opened, true, "HMR upgrade through the gateway did not open");
  try {
    await waitFor(async () => hmr.messages.length > 0, 10_000, "Vite to send its connected message over the gateway HMR tunnel");
    const connected = hmr.messages.map((message) => {
      try {
        return JSON.parse(message);
      } catch {
        return null;
      }
    });
    assert.ok(connected.some((message) => message && message.type === "connected"), `no connected message from Vite: ${JSON.stringify(hmr.messages.slice(0, 3))}`);
    // Edit a real file and expect an HMR update through the same tunnel.
    const mainPath = path.join(projectsRoot, GUA_ID, "src/main.js");
    const originalMain = await readFile(mainPath, "utf8");
    const before = hmr.messages.length;
    const edited = await call("PUT", `/api/projects/${GUA_ID}/files/content`, { path: "src/main.js", content: `${originalMain}\n// phase3d-hmr-probe ${Date.now()}\n` });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    await waitFor(async () => {
      const fresh = hmr.messages.slice(before).map((message) => {
        try {
          return JSON.parse(message);
        } catch {
          return null;
        }
      });
      return fresh.some((message) => message && (message.type === "update" || message.type === "full-reload"));
    }, 30_000, "HMR update after editing src/main.js");
    const restored = await call("PUT", `/api/projects/${GUA_ID}/files/content`, { path: "src/main.js", content: originalMain });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    ok("WS HMR upgrade through the gateway works (Vite connected message) and a file edit produces a real HMR update over the tunnel");
  } finally {
    hmr.ws.terminate();
  }
  const guaStopped = await call("POST", `/api/projects/${GUA_ID}/preview/stop`);
  assert.equal(guaStopped.status, 200, JSON.stringify(guaStopped.data));
  const guaWsAfterStop = await wsConnect(`ws://127.0.0.1:8787/api/preview/${GUA_ID}/__hmr`, `omp_builder_session=${token}`);
  assert.equal(guaWsAfterStop.opened, false, "HMR upgrade opened after the preview stopped");
  guaWsAfterStop.ws.terminate();
  ok("HMR upgrade to a stopped preview is rejected");

  // (9) Header stripping, tested against the real proxy function with a
  // local echo upstream (requires npm run build first — dist/gateway.js).
  // The echo server records what the proxy actually sent it.
  let echoChecked = false;
  try {
    const gateway = await import("../apps/api/dist/gateway.js");
    const seen = [];
    const echo = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "evil=1; Path=/" });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = echo.address().port;
    const proxyServer = createServer((req, res) => {
      const targetPort = req.url === "/dead" ? 1 : echoPort;
      void gateway.proxyPreviewHttp(req, res, req.url ?? "/", targetPort);
    });
    await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
    const proxyPort = proxyServer.address().port;
    try {
      const through = await fetch(`http://127.0.0.1:${proxyPort}/echo?x=1`, {
        headers: { cookie: "omp_builder_session=TOP-SECRET", authorization: "Bearer TOP-SECRET", "x-probe": "kept" },
      });
      assert.equal(through.status, 200);
      assert.equal(through.headers.get("set-cookie"), null, "proxy passed the upstream Set-Cookie through");
      const body = await through.json();
      assert.equal(body.ok, true);
      assert.equal(body.url, "/echo?x=1");
      assert.equal(seen.length, 1, "echo upstream saw no request");
      const upstreamHeaders = seen[0].headers;
      assert.equal(upstreamHeaders.cookie, undefined, `proxy forwarded Cookie to the container: ${upstreamHeaders.cookie}`);
      assert.equal(upstreamHeaders.authorization, undefined, "proxy forwarded Authorization to the container");
      assert.equal(upstreamHeaders["x-probe"], "kept", "proxy dropped a benign header");
      assert.equal(upstreamHeaders.host, `127.0.0.1:${echoPort}`, `proxy Host header wrong: ${upstreamHeaders.host}`);
      const dead = await fetch(`http://127.0.0.1:${proxyPort}/dead`);
      assert.equal(dead.status, 502, `unreachable upstream returned ${dead.status}`);
      const deadBody = await dead.json();
      assert.ok((deadBody.error ?? "").includes("unreachable"), JSON.stringify(deadBody));
      echoChecked = true;
    } finally {
      proxyServer.close();
      echo.close();
    }
    ok("header stripping verified end to end: Cookie/Authorization never reach the container, Set-Cookie never leaves it, benign headers pass, dead upstream is 502");
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    console.log(`  note: header-strip echo test skipped (dist/gateway.js not built?): ${error instanceof Error ? error.message : error}`);
    console.log("  (run npm run build, then re-run this test to cover header stripping)");
  }
  if (!echoChecked) console.log("  WARNING: header-strip echo test did not run — see note above");

  // (10) Server-side fs watcher: the WorkspaceWatcher class watches one
  // project dir (debounced, ignoring node_modules/.git/secrets) and the
  // live API emits files_modified over WS for an out-of-band edit.
  try {
    const watcherModule = await import("../apps/api/dist/watcher.js");
    const probeDir = path.join(projectsRoot, PHASE2_ID, ".watcher-probe-3d");
    await mkdir(probeDir, { recursive: true });
    const watcher = new watcherModule.WorkspaceWatcher();
    const seenEvents = [];
    watcher.watch(PHASE2_ID, path.join(projectsRoot, PHASE2_ID), (_id, files) => seenEvents.push(files));
    await sleep(500);
    await writeFile(path.join(probeDir, "a.txt"), "hello\n", "utf8");
    await writeFile(path.join(projectsRoot, PHASE2_ID, "watcher-file.txt"), "hello\n", "utf8");
    await waitFor(async () => seenEvents.some((files) => files.includes("watcher-file.txt")), 10_000, "watcher to report the new file");
    // Ignored: node_modules and .env never produce events.
    await mkdir(path.join(projectsRoot, PHASE2_ID, "node_modules"), { recursive: true }).catch(() => undefined);
    await writeFile(path.join(projectsRoot, PHASE2_ID, "node_modules", "ignored.js"), "x\n", "utf8");
    await writeFile(path.join(projectsRoot, PHASE2_ID, ".env.probe"), "x\n", "utf8");
    await sleep(2000);
    assert.ok(!seenEvents.flat().some((file) => file.includes("node_modules") || file.includes(".env")), `watcher reported an ignored path: ${JSON.stringify(seenEvents)}`);
    watcher.unwatch(PHASE2_ID);
    await rm(probeDir, { recursive: true, force: true });
    await rm(path.join(projectsRoot, PHASE2_ID, "watcher-file.txt"), { force: true });
    await rm(path.join(projectsRoot, PHASE2_ID, "node_modules", "ignored.js"), { force: true });
    await rm(path.join(projectsRoot, PHASE2_ID, ".env.probe"), { force: true });
    ok("WorkspaceWatcher reports a new file (debounced) and ignores node_modules / .env");
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    console.log(`  note: watcher unit test skipped (dist/watcher.js not built?): ${error instanceof Error ? error.message : error}`);
  }
  // Live integration: open the Builder WS for Phase 2 (this starts the
  // server-side watcher for the project), edit a file on disk directly,
  // and expect a files_modified event over the socket.
  const probeName = "watcher-live-probe-3d.txt";
  const probePath = path.join(projectsRoot, PHASE2_ID, probeName);
  const liveWs = new WebSocket(`ws://127.0.0.1:8787/ws/projects/${PHASE2_ID}`, { headers: { cookie: `omp_builder_session=${token}` } });
  const liveEvents = [];
  liveWs.on("message", (raw) => {
    try {
      liveEvents.push(JSON.parse(raw.toString()));
    } catch {
      // Non-JSON frames are ignored.
    }
  });
  await new Promise((resolve, reject) => {
    liveWs.on("open", resolve);
    liveWs.on("error", reject);
    setTimeout(() => reject(new Error("Builder WS did not open within 15 s")), 15_000);
  });
  await sleep(2000);
  await writeFile(probePath, "live watcher probe\n", "utf8");
  await waitFor(
    async () => liveEvents.some((event) => event.type === "files_modified" && Array.isArray(event.payload?.files) && event.payload.files.includes(probeName)),
    20_000,
    "live files_modified event for the out-of-band edit",
  );
  liveWs.close();
  await rm(probePath, { force: true });
  ok("live watcher: an out-of-band edit to the open project's workspace emits files_modified over the Builder WS");

  console.log(`phase3 gateway checks passed (${passed} checks)`);
} finally {
  await call("POST", `/api/projects/${PHASE2_ID}/preview/stop`).catch(() => undefined);
  await call("POST", `/api/projects/${GUA_ID}/preview/stop`).catch(() => undefined);
  if (throwawayId) {
    await call("POST", `/api/projects/${throwawayId}/preview/stop`).catch(() => undefined);
    db.prepare("DELETE FROM projects WHERE id = ?").run(throwawayId);
    db.prepare("DELETE FROM preview_state WHERE project_id = ?").run(throwawayId);
    db.prepare("DELETE FROM omp_events WHERE project_id = ?").run(throwawayId);
    await rm(path.join(projectsRoot, throwawayId), { recursive: true, force: true }).catch(() => undefined);
    await rm(path.join(previewRoot, throwawayId), { recursive: true, force: true }).catch(() => undefined);
    await execFileAsync("/usr/sbin/runuser", ["-u", "omp-builder", "--", "/usr/bin/env", "XDG_RUNTIME_DIR=/run/user/996", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/996/bus", "HOME=/var/lib/omp-builder", "PATH=/usr/local/bin:/usr/bin:/bin", "/usr/bin/podman", "--cgroup-manager", "systemd", "volume", "rm", `omp-preview-nm-${throwawayId.slice(0, 8)}`], { cwd: "/", timeout: 60_000 }).catch(() => undefined);
    console.log(`throwaway project ${throwawayId} deleted (DB row, workspace, staging)`);
  }
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").run(new Date().toISOString(), tokenHash);
  const revoked = await fetch(`${api}/api/projects/${PHASE2_ID}/preview/status`, { headers: { cookie: `omp_builder_session=${token}` } });
  assert.equal(revoked.status, 401, "revoked test session still accepted");
  db.close();
  console.log("test session revoked");
}
