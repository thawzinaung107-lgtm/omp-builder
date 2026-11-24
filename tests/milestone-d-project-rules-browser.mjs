// Milestone D (B6) browser verification — real headless Chromium driving
// the real Builder UI against the live VPS API/web through SSH tunnels.
//
// Runs on a machine WITH a headless Chrome (the VPS has none), from a
// directory whose node_modules resolves `ws`:
//   node tests/milestone-d-project-rules-browser.mjs
// Env overrides: OMP_BUILDER_CHROME (default the Remotion headless shell),
// OMP_BUILDER_SSH (default root@191.40.5.90), OMP_BUILDER_SSH_KEY
// (default ~/.ssh/id_ed25519), OMP_BUILDER_API (default
// http://127.0.0.1:8787, the tunnel's local end), OMP_BUILDER_WEB
// (default http://127.0.0.1:5173, the tunnel's local end).
//
// What it does (throwaway project, cleaned up at the end):
//   1. Opens SSH tunnels (local 8787 -> VPS API, local 5173 -> VPS web)
//      and mints a throwaway admin session in the VPS DB (revoked at end).
//   2. Creates a throwaway project with index.html v1.
//   3. In headless Chrome: opens the Builder, sends a real OMP prompt
//      BEFORE any rules exist (baseline turn; the file must NOT gain the
//      rules marker).
//   4. Opens the Rules tab, types a rule ("every HTML file must start
//      with <!-- RULE-FILE-TEST -->"), saves it, and verifies the
//      restart notice ("The running OMP session was restarted").
//   5. Sends a second plain prompt (no prefix, no mention of the rule)
//      and verifies index.html now STARTS with <!-- RULE-FILE-TEST -->
//      — the investigation's Test 2 verbatim, proving the lifted flags
//      make OMP honor .omp/RULES.md, and proving save restarted the
//      live session (a resumed --continue session would not have
//      picked the new file up).
//   6. Test 1 regression: a prompt-prefix instruction ("start about.html
//      with <!-- PREFIX-TEST -->") is still honored.
//   7. The second turn's AI checkpoint lists .omp/RULES.md.
// Cleanup deletes the throwaway project (API DELETE) and revokes the
// session.

import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { homedir } from "node:os";
import path from "node:path";

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

const RULES =
  "Every HTML file you create or edit must start with the exact first line <!-- RULE-FILE-TEST --> as its very first line, before anything else. Never remove that line.";
const MARKER = "<!-- RULE-FILE-TEST -->";
const PROMPT_BEFORE =
  "Add a paragraph to index.html that says: Before rules paragraph.";
const PROMPT_AFTER =
  "Add a paragraph to index.html that says: After rules paragraph.";
const PROMPT_PREFIX =
  "Create about.html containing only the text Prefix test page, and start it with the exact line <!-- PREFIX-TEST --> as its very first line.";

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

const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = {
  cookie: `omp_builder_session=${token}`,
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

async function versions() {
  const r = await call("GET", `/api/projects/${throwawayId}/versions`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

async function fileContent(relPath) {
  const r = await call(
    "GET",
    `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent(relPath)}`,
  );
  if (r.status === 404) return null;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.content ?? null;
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

  // (2) Throwaway project with index.html v1.
  const projectName = `Milestone D B6 Rules Test ${new Date().toISOString()}`;
  const created = await call("POST", "/api/projects", {
    name: projectName,
    prompt:
      "Throwaway project for the Milestone D B6 rules browser verification.",
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  throwawayId = created.data.project.id;
  const v1 = `<!doctype html><meta charset="utf-8"><title>Rules Test</title><h1>Rules test</h1>\n`;
  const put = await call("PUT", `/api/projects/${throwawayId}/files/content`, {
    path: "index.html",
    content: v1,
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  ok("throwaway project created with index.html v1");

  // (3) Headless Chrome + CDP.
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--remote-debugging-port=9222",
      "--user-data-dir=/tmp/milestone-d-rules-browser-profile",
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
  async function sendComposerPrompt(prompt) {
    // The submit button needs connection === "connected" as well as a
    // non-empty draft. Wait for the Connected pill first: right after a
    // service restart the WS can take a while, and without this the
    // button wait below cannot tell a dead WS from an empty draft.
    await waitForPage(
      `[...document.querySelectorAll('span')].some((s) => s.textContent === "Connected")`,
      "Connected status pill (WS open)",
      120_000,
    );
    await evalJs(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(prompt)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value;
    })()`);
    await waitForPage(
      `(() => {
      const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
      const btn = ta.closest('form').querySelector('button[type="submit"]');
      return btn && !btn.disabled;
    })()`,
      "send button enabled (WS connected)",
      60_000,
    );
    await evalJs(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
      ta.closest('form').querySelector('button[type="submit"]').click();
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

  // (4) Baseline turn BEFORE any rules: the marker must NOT appear.
  await sendComposerPrompt(PROMPT_BEFORE);
  ok("baseline OMP prompt sent (before rules)");
  await waitForApi(
    "first turn to settle",
    async () => ((await pollSettled()) >= 1 ? true : null),
    600_000,
  );
  const beforeTurn = await fileContent("index.html");
  assert.ok(
    beforeTurn && beforeTurn.includes("Before rules paragraph"),
    "index.html does not contain the baseline paragraph",
  );
  assert.ok(
    !beforeTurn.includes(MARKER),
    "index.html must not contain the rules marker before any rules exist",
  );
  ok(
    "baseline turn settled; paragraph present, no rules marker (rules were not active)",
  );

  // (5) Rules tab: type the rule, save, verify the restart notice.
  await clickVisibleButton("Rules");
  await waitForPage(
    `!!document.querySelector('textarea[aria-label="Project rules"]')`,
    "Rules editor textarea",
    60_000,
  );
  await evalJs(`(() => {
    const ta = document.querySelector('textarea[aria-label="Project rules"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(RULES)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`);
  await clickVisibleButton("Save rules");
  await waitForPage(
    `document.body.innerText.includes("restarted")`,
    "restart notice after saving rules",
    60_000,
  );
  const noticeText = await bodyText();
  assert.ok(
    noticeText.includes("The running OMP session was restarted"),
    "restart notice does not say the running OMP session was restarted",
  );
  const savedRules = await call("GET", `/api/projects/${throwawayId}/rules`);
  assert.equal(savedRules.status, 200, JSON.stringify(savedRules.data));
  assert.equal(
    savedRules.data.content,
    RULES,
    "saved rules do not round-trip through the API",
  );
  assert.equal(savedRules.data.exists, true);
  ok(
    "rule saved through the Rules tab; restart notice shown; API round-trip matches",
  );

  // (6) Test 2 verbatim: a plain prompt AFTER the save. The marker must
  // now be the first line of index.html.
  await sendComposerPrompt(PROMPT_AFTER);
  ok("second OMP prompt sent (plain prompt, after rules saved)");
  await waitForApi(
    "second turn to settle",
    async () => ((await pollSettled()) >= 2 ? true : null),
    600_000,
  );
  const afterTurn = await fileContent("index.html");
  assert.ok(
    afterTurn && afterTurn.includes("After rules paragraph"),
    "index.html does not contain the second paragraph",
  );
  assert.ok(
    afterTurn && afterTurn.startsWith(MARKER),
    `index.html does not start with the rules marker; first 200 chars: ${JSON.stringify((afterTurn ?? "").slice(0, 200))}`,
  );
  ok(
    "Test 2 PASS: plain prompt after saving rules — index.html starts with <!-- RULE-FILE-TEST --> (rules honored, session restarted on save)",
  );

  // (7) Test 1 regression: prompt-prefix instruction still honored.
  await sendComposerPrompt(PROMPT_PREFIX);
  ok("prefix prompt sent (Test 1 regression)");
  await waitForApi(
    "third turn to settle",
    async () => ((await pollSettled()) >= 3 ? true : null),
    600_000,
  );
  const about = await fileContent("about.html");
  assert.ok(
    about && about.includes("Prefix test page"),
    "about.html does not contain the requested text",
  );
  // The always-on rule still wins the first line (RULE-FILE-TEST), and the
  // prefix instruction is honored on the line right after it: both the
  // rule and the prompt prefix are applied, rule first.
  assert.ok(
    about && about.startsWith(MARKER),
    `about.html must still start with the rules marker; first 200 chars: ${JSON.stringify((about ?? "").slice(0, 200))}`,
  );
  assert.ok(
    about && about.includes("<!-- PREFIX-TEST -->"),
    `about.html does not contain the prefix marker; first 200 chars: ${JSON.stringify((about ?? "").slice(0, 200))}`,
  );
  assert.ok(
    about &&
      about.indexOf("<!-- PREFIX-TEST -->") < about.indexOf("Prefix test page"),
    "prefix marker must come before the requested text",
  );
  ok("Test 1 PASS (regression): prompt-prefix instruction still honored");

  // (8) The second turn's AI checkpoint lists .omp/RULES.md.
  const v = await versions();
  const afterCheckpoint = v.checkpoints.find((c) =>
    c.subject.includes("After rules"),
  );
  assert.ok(
    afterCheckpoint,
    `no AI checkpoint for the after-rules prompt; checkpoints: ${JSON.stringify(v.checkpoints.map((c) => c.subject))}`,
  );
  const detail = await call(
    "GET",
    `/api/projects/${throwawayId}/versions/${afterCheckpoint.oid}`,
  );
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  const detailPaths = (detail.data.files ?? []).map((entry) => entry.path);
  assert.ok(
    detailPaths.includes(".omp/RULES.md"),
    `after-rules checkpoint must list .omp/RULES.md, got ${JSON.stringify(detailPaths)}`,
  );
  ok(
    `after-rules AI checkpoint ${afterCheckpoint.shortOid} lists .omp/RULES.md`,
  );
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
  passed === 11
    ? `\nmilestone D B6 browser checks passed (${passed} checks)`
    : `\n${passed} browser checks passed before failure`,
);
