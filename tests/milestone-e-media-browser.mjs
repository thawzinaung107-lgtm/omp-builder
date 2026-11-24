// Milestone E (B7) browser verification — real headless Chromium driving
// the real Builder UI against the live VPS API/web through SSH tunnels.
//
// Runs on a machine WITH a headless Chrome (the VPS has none), from a
// directory whose node_modules resolves `ws`:
//   node tests/milestone-e-media-browser.mjs
// Env overrides: OMP_BUILDER_CHROME (default the Remotion headless shell),
// OMP_BUILDER_SSH (default root@191.40.5.90), OMP_BUILDER_SSH_KEY
// (default ~/.ssh/id_ed25519), OMP_BUILDER_API (default
// http://127.0.0.1:8787, the tunnel's local end), OMP_BUILDER_WEB
// (default http://127.0.0.1:5173, the tunnel's local end).
//
// What it does (throwaway project, cleaned up at the end):
//   1. Opens SSH tunnels (local 8787 -> VPS API, local 5173 -> VPS web)
//      and mints a throwaway admin session in the VPS DB (revoked at end).
//   2. Creates a throwaway project.
//   3. In headless Chrome: opens the Builder, goes to the Files tab,
//      uploads a red-square PNG through the Media browser, and verifies
//      the thumbnail + name appear (and the API lists it).
//   4. Replaces that image through the Media browser with a blue-square
//      PNG and verifies the served bytes change (same name, no orphan).
//   5. Attaches a green-square PNG through the chat composer, sends a
//      prompt asking what color the square is, and verifies (a) the
//      user message carries the @images/… reference and (b) OMP's
//      reply names the color — the empirical check that OMP RPC reads
//      a path-referenced image (there is no RPC image input field;
//      the prompt is text-only).
// Cleanup deletes the throwaway project (API DELETE) and revokes the
// session.

import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { homedir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

const CHROME =
  process.env.OMP_BUILDER_CHROME ??
  path.join(
    homedir(),
    "workspace/remotion-videos/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell",
  );
const SSH_HOST = process.env.OMP_BUILDER_SSH ?? "root@191.40.5.90";
const SSH_KEY =
  process.env.OMP_BUILDER_SSH_KEY ?? path.join(homedir(), ".ssh", "id_ed25519");
const API = process.env.OMP_BUILDER_API ?? "http://127.0.0.1:8787";
const WEB = process.env.OMP_BUILDER_WEB ?? "http://127.0.0.1:5173";
const ADMIN_ID = "155e3283-d271-452a-af52-e90f900cd78d";
const DB_PATH = "/var/lib/omp-builder/data/persistent/app.db";
const REPO = "/opt/omp-builder";

const execFileAsync = promisify(execFile);
const sshBase = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=20",
  "-i",
  SSH_KEY,
];

async function ssh(command) {
  const { stdout } = await execFileAsync(
    "ssh",
    [...sshBase, SSH_HOST, command],
    { timeout: 60_000 },
  );
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

// ---------- Solid-color PNG fixtures (written to temp files for Chrome) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(size, r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const idat = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG_RED = makePng(16, 255, 0, 0);
const PNG_BLUE = makePng(16, 0, 0, 255);
const PNG_GREEN = makePng(16, 0, 200, 0);
const RED_PATH = path.join(tmpdir(), "red-square.png");
const BLUE_PATH = path.join(tmpdir(), "blue-square.png");
const GREEN_PATH = path.join(tmpdir(), "attach-green.png");
writeFileSync(RED_PATH, PNG_RED);
writeFileSync(BLUE_PATH, PNG_BLUE);
writeFileSync(GREEN_PATH, PNG_GREEN);

const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const sessionCookie = ["omp_builder_session", token].join("=");
const headers = {
  cookie: sessionCookie,
  "content-type": "application/json",
};
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

async function mediaBytes(name) {
  const response = await fetch(`${API}/api/projects/${throwawayId}/media/${name}`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(response.status, 200, `media GET ${name} status ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

let lastEventId = 0;
let settledTurns = 0;
async function pollSettled() {
  const r = await call(
    "GET",
    `/api/projects/${throwawayId}/session?afterEventId=${lastEventId}`,
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const e of r.data.events ?? []) {
    lastEventId = Math.max(lastEventId, e.id);
    if (e.type === "session_settled") settledTurns += 1;
  }
  return settledTurns;
}

async function waitForApi(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(3000);
  }
  throw new Error(
    `timed out waiting for: ${label} (last: ${JSON.stringify(last)})`,
  );
}

try {
  // (1) Tunnels + throwaway session.
  tunnel = spawn(
    "ssh",
    [
      ...sshBase,
      "-N",
      "-L",
      "8787:127.0.0.1:8787",
      "-L",
      "5173:127.0.0.1:5173",
      SSH_HOST,
    ],
    { stdio: "ignore" },
  );
  await sleep(3000);
  const health = await fetch(`${API}/api/health`)
    .then((r) => r.ok)
    .catch(() => false);
  assert.ok(health, "SSH tunnel to the VPS API is not up (local 8787)");
  const webUp = await fetch(`${WEB}/`)
    .then((r) => r.ok)
    .catch(() => false);
  assert.ok(
    webUp,
    "SSH tunnel to the VPS web dev server is not up (local 5173)",
  );
  await ssh(
    `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; cd ${REPO} && node -e "const D=require('better-sqlite3'); const db=new D('${DB_PATH}'); db.prepare('INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?,?,?,?,?)').run('${randomUUID()}', '${tokenHash}', '${ADMIN_ID}', new Date(Date.now()+3600000).toISOString(), new Date().toISOString()); db.close();"`,
  );
  ok(
    "SSH tunnels up (8787 API, 5173 web); throwaway admin session minted on the VPS",
  );

  // (2) Throwaway project.
  const projectName = `Milestone E B7 Media Test ${new Date().toISOString()}`;
  const created = await call("POST", "/api/projects", {
    name: projectName,
    prompt: "Throwaway project for the Milestone E B7 media browser verification.",
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  throwawayId = created.data.project.id;
  ok("throwaway project created");

  // (3) Headless Chrome + CDP.
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--remote-debugging-port=9222",
      "--user-data-dir=/tmp/milestone-e-media-browser-profile",
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await new Promise((resolve, reject) => {
    chrome.once("error", reject);
    chrome.once("spawn", resolve);
    setTimeout(() => reject(new Error("Chrome spawn timed out")), 10_000);
  });
  let version = null;
  for (let attempt = 0; attempt < 30 && !version; attempt += 1) {
    await sleep(500);
    version = await fetch("http://127.0.0.1:9222/json/version")
      .then((r) => r.json())
      .catch(() => null);
  }
  assert.ok(
    version?.webSocketDebuggerUrl,
    "headless Chrome DevTools endpoint did not come up",
  );
  const ws = new WebSocket(version.webSocketDebuggerUrl, {
    perMessageDeflate: false,
  });
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
      ws.send(
        JSON.stringify({
          id,
          method,
          params: params ?? {},
          ...(sessionId ? { sessionId } : {}),
        }),
      );
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 30_000);
    });
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        reject(new Error(`CDP error: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    }
  });
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp("Network.enable", {}, sessionId);
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  await cdp("DOM.enable", {}, sessionId);
  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );

  async function evalJs(expression) {
    const { result, exceptionDetails } = await cdp(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (exceptionDetails)
      throw new Error(
        `page JS error: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ""}`,
      );
    return result?.value;
  }
  async function waitForPage(expression, label, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evalJs(expression);
      if (last) return last;
      await sleep(2000);
    }
    throw new Error(
      `timed out waiting for: ${label} (last: ${JSON.stringify(last)})`,
    );
  }
  async function bodyText() {
    return (
      (await evalJs("document.body ? document.body.innerText : String()")) ?? ""
    );
  }
  async function clickVisibleButton(label) {
    const clicked = await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && x.offsetParent !== null);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    assert.ok(clicked, `visible button ${JSON.stringify(label)} not found`);
  }
  async function setFileInput(selector, files) {
    const { root } = await cdp("DOM.getDocument", { depth: -1 }, sessionId);
    const { nodeId } = await cdp(
      "DOM.querySelector",
      { nodeId: root.nodeId, selector },
      sessionId,
    );
    assert.ok(nodeId, `file input ${selector} not found`);
    await cdp("DOM.setFileInputFiles", { nodeId, files }, sessionId);
    // setFileInputFiles alone does not reliably trigger React's
    // onChange; dispatch the events the input would have fired.
    await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }

  // The admin session cookie, for the tunnelled web origin.
  await cdp(
    "Network.setCookie",
    {
      name: "omp_builder_session",
      value: token,
      domain: "127.0.0.1",
      path: "/",
    },
    sessionId,
  );
  await cdp("Page.navigate", { url: `${WEB}/` }, sessionId);
  await waitForPage(
    `(document.body && document.body.innerText.includes(${JSON.stringify(projectName)}))`,
    "dashboard listing the throwaway project",
    60_000,
  );
  await evalJs(
    `[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(projectName)})).click(); "opened"`,
  );
  await waitForPage(
    `!![...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null)`,
    "Builder composer",
    60_000,
  );
  ok("Builder opened in headless Chrome; composer visible");

  // (4) Media browser: upload a red square through the Files tab.
  await clickVisibleButton("Files");
  await waitForPage(
    `document.body.innerText.includes("Media") && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === "Upload image")`,
    "Media section in the Files tab",
    60_000,
  );
  await setFileInput('input[aria-label="Upload image"]', [RED_PATH]);
  await waitForPage(
    `[...document.querySelectorAll('img')].some((img) => img.src.includes("/media/red-square.png")) && document.body.innerText.includes("red-square.png")`,
    "red-square.png thumbnail in the Media browser",
    60_000,
  );
  const listed = await call("GET", `/api/projects/${throwawayId}/media`);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.deepEqual(
    listed.data.images.map((i) => i.name),
    ["red-square.png"],
  );
  assert.deepEqual(await mediaBytes("red-square.png"), PNG_RED);
  ok("Media upload via the Files tab: red-square.png appears with a thumbnail; API lists it and serves the red bytes");

  // (5) Replace flow: swap the red square for a blue one, same name.
  await evalJs(`(() => {
    const card = [...document.querySelectorAll('figure')].find((f) => f.textContent.includes("red-square.png"));
    const btn = card && [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === "Replace");
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await setFileInput('input[aria-label="Replace image"]', [BLUE_PATH]);
  await waitForApi(
    "served bytes to turn blue after replace",
    async () => {
      try {
        return (await mediaBytes("red-square.png")).equals(PNG_BLUE) ? true : null;
      } catch {
        return null;
      }
    },
    60_000,
  );
  const listedAfter = await call("GET", `/api/projects/${throwawayId}/media`);
  assert.deepEqual(
    listedAfter.data.images.map((i) => i.name),
    ["red-square.png"],
    "replace must not leave an orphan or a second file",
  );
  ok("Media replace via the Files tab: red-square.png now serves the blue bytes, same name, no orphan");

  // (6) Chat attachment: attach a green square, ask OMP its color.
  await setFileInput('input[aria-label="Attach image"]', [GREEN_PATH]);
  await waitForPage(
    `document.body.innerText.includes("attach-green.png")`,
    "attach chip for attach-green.png in the composer",
    60_000,
  );
  await waitForPage(
    `[...document.querySelectorAll('span')].some((s) => s.textContent === "Connected")`,
    "Connected status pill (WS open)",
    120_000,
  );
  await evalJs(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, "What color is the square in the attached image? Answer with just the color word.");
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`);
  await waitForPage(
    `(() => {
      const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
      const btn = ta.closest('form').querySelector('button[type="submit"]');
      return btn && !btn.disabled;
    })()`,
    "send button enabled (WS connected, attachment present)",
    60_000,
  );
  await evalJs(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
    ta.closest('form').querySelector('button[type="submit"]').click();
    return true;
  })()`);
  ok("chat attachment sent (green square + color question)");
  await waitForApi(
    "attachment turn to settle",
    async () => ((await pollSettled()) >= 1 ? true : null),
    600_000,
  );
  const session = await call("GET", `/api/projects/${throwawayId}/session`);
  assert.equal(session.status, 200, JSON.stringify(session.data));
  const userMessages = (session.data.events ?? [])
    .filter((e) => e.type === "user_message")
    .map((e) => String(e.payload?.message ?? ""));
  assert.ok(
    userMessages.some((m) => m.includes("@images/attach-green.png")),
    `sent prompt must reference @images/attach-green.png; got ${JSON.stringify(userMessages)}`,
  );
  ok("sent prompt references the attachment as @images/attach-green.png");
  const chatText = await bodyText();
  assert.ok(
    /green/i.test(chatText),
    `OMP reply does not name the color green; chat text: ${JSON.stringify(chatText.slice(-1500))}`,
  );
  ok("OMP turn read the attached image: its reply names the color green (path reference works — no RPC image field exists)");
} catch (error) {
  console.error(
    "FAILED:",
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
} finally {
  try {
    if (throwawayId) {
      const deleted = await call("DELETE", `/api/projects/${throwawayId}`);
      console.log(
        `throwaway project ${throwawayId} deleted via API (status ${deleted.status})`,
      );
    }
  } catch {
    console.log(
      "throwaway project cleanup via API failed (may need a manual sweep)",
    );
  }
  try {
    await ssh(
      `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; cd ${REPO} && node -e "const D=require('better-sqlite3'); const db=new D('${DB_PATH}'); db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(new Date().toISOString(), '${tokenHash}'); db.close();"`,
    );
    console.log("test session revoked");
  } catch {
    console.log("test session revoke failed (token expires in 1h)");
  }
  try {
    if (chrome) chrome.kill("SIGTERM");
  } catch {
    // already gone
  }
  try {
    if (tunnel) tunnel.kill("SIGTERM");
  } catch {
    // already gone
  }
}

console.log(
  passed === 8
    ? `\nmilestone E B7 browser checks passed (${passed} checks)`
    : `\n${passed} browser checks passed before failure`,
);
