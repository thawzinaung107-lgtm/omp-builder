import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import WebSocket from "ws";

// Phase 3D in-browser probe — real JavaScript inside the real sandboxed
// iframe, proving the generated page cannot reach Builder APIs.
//
// Runs on a machine WITH a headless Chrome, against the VPS API through
// an SSH tunnel (the API is localhost-only on the VPS):
//   node tests/phase3-gateway-browser-probe.mjs
// Env overrides: OMP_BUILDER_CHROME (default /opt/meta-chromium/chrome),
// OMP_BUILDER_SSH (default root@191.40.5.90), OMP_BUILDER_SSH_KEY
// (default ~/.ssh/id_ed25519), OMP_BUILDER_API (default
// http://127.0.0.1:8787, the tunnel's local end).
//
// What it does:
//   1. Opens an SSH tunnel (local 8787 -> VPS 127.0.0.1:8787) and mints a
//      throwaway admin session in the VPS DB (revoked at the end).
//   2. Creates a throwaway project whose index.html is a probe page: its
//      JS does fetch('/api/projects') (plain and with credentials) and
//      reports the outcome to this script's harness server.
//   3. Starts the project's preview and loads a harness page in headless
//      Chrome that embeds the gateway URL in an iframe with EXACTLY the
//      Builder's sandbox (allow-scripts allow-forms allow-popups — NO
//      allow-same-origin).
//   4. Asserts both fetches are blocked (CORS/Origin:null), which is the
//      property the curl-level checks in tests/phase3-gateway.mjs can only
//      approximate. The probe page loading and reporting at all proves the
//      iframe navigation itself works through the gateway.
// Cleanup deletes the throwaway project (DB row, workspace, staging) and
// revokes the session.

import { homedir } from "node:os";
import path from "node:path";

const CHROME =
  process.env.OMP_BUILDER_CHROME ??
  path.join(homedir(), "workspace/remotion-videos/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell");
const SSH_HOST = process.env.OMP_BUILDER_SSH ?? "root@191.40.5.90";
const SSH_KEY = process.env.OMP_BUILDER_SSH_KEY ?? path.join(homedir(), ".ssh", "id_ed25519");
const API = process.env.OMP_BUILDER_API ?? "http://127.0.0.1:8787";
const ADMIN_ID = "155e3283-d271-452a-af52-e90f900cd78d";
const DB_PATH = "/var/lib/omp-builder/data/persistent/app.db";
const REPO = "/opt/omp-builder";

const execFileAsync = promisify(execFile);
const sshBase = ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-i", SSH_KEY];

async function ssh(command) {
  const { stdout } = await execFileAsync("ssh", [...sshBase, SSH_HOST, command], { timeout: 60_000 });
  return stdout;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { cookie: `omp_builder_session=${token}`, "content-type": "application/json" };
let throwawayId = null;
let tunnel = null;
let chrome = null;

async function call(method, urlPath, body) {
  const response = await fetch(`${API}${urlPath}`, {
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

try {
  // (1) Tunnel + throwaway session (minted directly in the VPS DB).
  tunnel = spawn("ssh", [...sshBase, "-N", "-L", "8787:127.0.0.1:8787", SSH_HOST], { stdio: "ignore" });
  await sleep(3000);
  const health = await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false);
  assert.ok(health, "SSH tunnel to the VPS API is not up (local 8787)");
  await ssh(
    `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; cd ${REPO} && node -e "const D=require('better-sqlite3'); const db=new D('${DB_PATH}'); db.prepare('INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?,?,?,?,?)').run('${randomUUID()}', '${tokenHash}', '${ADMIN_ID}', new Date(Date.now()+3600000).toISOString(), new Date().toISOString()); db.close();"`,
  );
  ok("SSH tunnel up; throwaway admin session minted on the VPS");

  // (2) Throwaway project with the probe page.
  const created = await call("POST", "/api/projects", { name: `Phase 3D Browser Probe ${new Date().toISOString()}`, prompt: "Throwaway probe page for the 3D iframe isolation check." });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  throwawayId = created.data.project.id;
  const probeHtml = `<!doctype html><meta charset="utf-8"><title>probe</title><body>probe page
<script>
(async () => {
  const results = {};
  try { const r = await fetch('/api/projects'); results.plain = 'status:' + r.status; }
  catch (e) { results.plain = 'blocked:' + e.name; }
  try { const r = await fetch('/api/projects', { credentials: 'include' }); results.cred = 'status:' + r.status; }
  catch (e) { results.cred = 'blocked:' + e.name; }
  try { const r = await fetch('/api/auth/status', { credentials: 'include' }); results.authStatus = 'status:' + r.status; }
  catch (e) { results.authStatus = 'blocked:' + e.name; }
  document.title = 'PROBE:' + JSON.stringify(results);
  fetch('http://127.0.0.1:9876/report?r=' + encodeURIComponent(JSON.stringify(results)), { mode: 'no-cors' }).catch(() => {});
})();
</script>`;
  const put = await call("PUT", `/api/projects/${throwawayId}/files/content`, { path: "index.html", content: probeHtml });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const started = await call("POST", `/api/projects/${throwawayId}/preview/start`);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.preview.status, "running");
  const gatewayUrl = `${API}/api/preview/${throwawayId}/`;
  const direct = await fetch(gatewayUrl, { headers });
  assert.equal(direct.status, 200, "gateway did not serve the probe page");
  assert.ok((await direct.text()).includes("probe page"));
  ok("probe project created; preview running; gateway serves the probe page");

  // (3) Harness server + headless Chrome. The harness page embeds the
  // gateway URL in an iframe with exactly the Builder's sandbox.
  let report = null;
  const harness = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/report") {
      report = url.searchParams.get("r");
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>harness</title><body><iframe sandbox="allow-scripts allow-forms allow-popups" src="${gatewayUrl}" style="width:800px;height:600px"></iframe>`);
  });
  await new Promise((resolve) => harness.listen(9876, "127.0.0.1", resolve));
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=9222", "--user-data-dir=/tmp/phase3d-probe-profile", "about:blank"], { stdio: "ignore" });
  let version = null;
  for (let attempt = 0; attempt < 30 && !version; attempt += 1) {
    await sleep(500);
    version = await fetch("http://127.0.0.1:9222/json/version").then((r) => r.json()).catch(() => null);
  }
  assert.ok(version?.webSocketDebuggerUrl, "headless Chrome DevTools endpoint did not come up");
  const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    setTimeout(() => reject(new Error("CDP websocket did not open")), 15_000);
  });
  let nextId = 1;
  const pending = new Map();
  const cdp = (method, params, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 15_000);
    });
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`CDP error: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    }
  });
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Network.enable", {}, sessionId);
  await cdp("Page.enable", {}, sessionId);
  // The admin session cookie, for the tunnelled API origin.
  await cdp("Network.setCookie", { name: "omp_builder_session", value: token, domain: "127.0.0.1", path: "/" }, sessionId);
  await cdp("Page.navigate", { url: "http://127.0.0.1:9876/" }, sessionId);
  const deadline = Date.now() + 30_000;
  while (!report && Date.now() < deadline) await sleep(500);
  assert.ok(report, "probe page inside the sandboxed iframe never reported back (iframe did not load or its JS did not run)");
  const results = JSON.parse(report);
  console.log("  probe results from inside the sandboxed iframe:", JSON.stringify(results));
  assert.ok(results.plain.startsWith("blocked:"), `plain fetch('/api/projects') was NOT blocked: ${results.plain}`);
  assert.ok(results.cred.startsWith("blocked:"), `credentialed fetch('/api/projects') was NOT blocked: ${results.cred}`);
  assert.ok(results.authStatus.startsWith("blocked:"), `credentialed fetch('/api/auth/status') was NOT blocked: ${results.authStatus}`);
  ok("in-browser proof: fetch('/api/projects') and fetch('/api/auth/status') from the sandboxed iframe are blocked (plain and credentialed)");
  harness.close();
  ws.close();
} finally {
  // Stop the preview through the API BEFORE killing the tunnel — the stop
  // is what removes the container; killing the tunnel first orphans it
  // (caught the hard way: three probe containers kept running after early
  // probe failures). The SSH cleanup below also removes the container
  // directly as a belt-and-braces fallback.
  if (throwawayId) {
    await call("POST", `/api/projects/${throwawayId}/preview/stop`).catch(() => undefined);
  }
  if (chrome) chrome.kill("SIGTERM");
  if (tunnel) tunnel.kill("SIGTERM");
  if (throwawayId) {
    await ssh(
      `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; cd ${REPO} && node -e "const D=require('better-sqlite3'); const db=new D('${DB_PATH}'); db.prepare('DELETE FROM projects WHERE id=?').run('${throwawayId}'); db.prepare('DELETE FROM preview_state WHERE project_id=?').run('${throwawayId}'); db.prepare('DELETE FROM omp_events WHERE project_id=?').run('${throwawayId}'); db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(new Date().toISOString(), '${tokenHash}'); db.close();"`,
    ).catch(() => undefined);
    await ssh(`rm -rf ${REPO}/data/projects/${throwawayId} /var/lib/omp-builder/previews/${throwawayId}; runuser -u omp-builder -- env XDG_RUNTIME_DIR=/run/user/996 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/996/bus HOME=/var/lib/omp-builder /usr/bin/podman --cgroup-manager=systemd rm -f omp-preview-${throwawayId.slice(0, 8)} 2>/dev/null; runuser -u omp-builder -- env XDG_RUNTIME_DIR=/run/user/996 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/996/bus HOME=/var/lib/omp-builder /usr/bin/podman --cgroup-manager=systemd volume rm omp-preview-nm-${throwawayId.slice(0, 8)} 2>/dev/null; true`).catch(() => undefined);
    console.log(`throwaway project ${throwawayId} deleted; test session revoked`);
  }
}

console.log(`phase3 gateway browser probe passed (${passed} checks)`);
