// Milestone D (B5) browser verification — real headless Chromium driving
// the real Builder UI against the live VPS API/web through SSH tunnels.
//
// Runs on a machine WITH a headless Chrome (the VPS has none), from a
// directory whose node_modules resolves `ws`:
//   node tests/milestone-d-github-import-browser.mjs
// Env overrides: OMP_BUILDER_CHROME (default the Remotion headless shell),
// OMP_BUILDER_SSH (default root@191.40.5.90), OMP_BUILDER_SSH_KEY
// (default ~/.ssh/id_ed25519), OMP_BUILDER_API (default
// http://127.0.0.1:8787, the tunnel's local end), OMP_BUILDER_WEB
// (default http://127.0.0.1:5173, the tunnel's local end).
//
// What it does (throwaway project, cleaned up at the end):
//   1. Opens SSH tunnels (local 8787 -> VPS API, local 5173 -> VPS web)
//      and mints a throwaway admin session in the VPS DB (revoked at end).
//   2. In headless Chrome: opens New Project, picks "Import from Git",
//      types an SSH URL first and verifies the client-side error, then
//      imports the real tiny public repo octocat/Hello-World end to end
//      through the UI and verifies the import summary.
//   3. Opens the imported project in the Builder and verifies the Code
//      tab lists the cloned README; verifies the same via the API
//      (versions HEAD, file tree, no origin remote).
// Cleanup deletes the throwaway project (API DELETE) and revokes the
// session. No OMP turn is sent (the 2-slot pool is left alone).

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

const PROJECT_NAME = `Milestone D B5 Import Test ${new Date().toISOString()}`;
const GOOD_URL = "https://github.com/octocat/Hello-World";
const BAD_URL = "git@github.com:octocat/Hello-World.git";

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
  cookie: `omp_builder_session=${encodeURIComponent(token)}`,
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

  // (2) Headless Chrome + CDP.
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--remote-debugging-port=9222",
      "--user-data-dir=/tmp/milestone-d-b5-browser-profile",
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
  async function clickButton(label, exact = true) {
    const clicked = await evalJs(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const b = buttons.find((x) => {
        const text = x.textContent.trim();
        return x.offsetParent !== null && ${exact ? "text === " + JSON.stringify(label) : "text.includes(" + JSON.stringify(label) + ")"};
      });
      if (!b) return false;
      b.click();
      return true;
    })()`);
    assert.ok(clicked, `visible button ${JSON.stringify(label)} not found`);
  }
  async function setInput(placeholder, value) {
    const set = await evalJs(`(() => {
      const el = [...document.querySelectorAll('input')].find((x) => x.placeholder === ${JSON.stringify(placeholder)} && x.offsetParent !== null);
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()`);
    assert.ok(
      set !== false,
      `input with placeholder ${JSON.stringify(placeholder)} not found`,
    );
    assert.equal(set, value);
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
    `document.body && document.body.innerText.includes("New project")`,
    "dashboard with New project button",
    60_000,
  );
  ok("dashboard loaded in headless Chrome (minted session)");

  // (3) New Project -> Import from Git.
  await clickButton("New project");
  await waitForPage(
    `document.body && document.body.innerText.includes("Create a new project")`,
    "New Project screen",
    60_000,
  );
  await clickButton("Import from Git", false);
  await waitForPage(
    `!![...document.querySelectorAll('input')].find((x) => x.placeholder === "https://github.com/octocat/Hello-World" && x.offsetParent !== null)`,
    "GitHub URL field",
    60_000,
  );
  const modeText = await bodyText();
  assert.ok(
    modeText.includes("Public repositories only"),
    "import notes (public-only, shallow, secrets) must be shown",
  );
  ok("Import from Git mode selected; URL field + public-only notes shown");

  // (4) Invalid URL first: client-side error, no import started.
  await setInput("my-next-app", PROJECT_NAME);
  await setInput("https://github.com/octocat/Hello-World", BAD_URL);
  await clickButton("Continue");
  await waitForPage(
    `document.body && document.body.innerText.includes("not a valid URL")`,
    "client-side error for the SSH URL",
    60_000,
  );
  const projectsBefore = await call("GET", "/api/projects");
  assert.equal(projectsBefore.status, 200, JSON.stringify(projectsBefore.data));
  assert.ok(
    !projectsBefore.data.projects.some((entry) => entry.name === PROJECT_NAME),
    "no project must be created for the rejected URL",
  );
  ok("SSH URL rejected in the UI with a clear error; no project created");

  // (5) Real import through the UI.
  await setInput("https://github.com/octocat/Hello-World", GOOD_URL);
  await clickButton("Continue");
  await waitForPage(
    `document.body && document.body.innerText.includes("Import repository")`,
    "import review step",
    60_000,
  );
  await clickButton("Import repository");
  await waitForPage(
    `document.body && document.body.innerText.includes("Import complete")`,
    "import summary",
    180_000,
  );
  const summaryText = await bodyText();
  assert.ok(
    summaryText.includes("octocat/Hello-World"),
    "summary must name the imported repo",
  );
  assert.ok(
    summaryText.includes("files from commit"),
    "summary must report the file count and commit",
  );
  assert.ok(
    summaryText.includes("None — no AGENTS.md"),
    "summary must report that no AI rules files were found",
  );
  const listed = await call("GET", "/api/projects");
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  const created = listed.data.projects.find(
    (entry) => entry.name === PROJECT_NAME,
  );
  assert.ok(created, "imported project must be listed via the API");
  throwawayId = created.id;
  ok("octocat/Hello-World imported end to end through the UI; summary shown");

  // (6) Open the project: Code tab lists the cloned README.
  await clickButton("Open project");
  await waitForPage(
    `!![...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null)`,
    "Builder composer",
    120_000,
  );
  await clickButton("Code");
  await waitForPage(
    `document.body && document.body.innerText.includes("README")`,
    "Code tab listing the cloned README",
    60_000,
  );
  ok("imported project opens in the Builder; Code tab lists the cloned README");

  // (7) API cross-checks on the imported project.
  const versions = await call("GET", `/api/projects/${throwawayId}/versions`);
  assert.equal(versions.status, 200, JSON.stringify(versions.data));
  assert.equal(versions.data.status.initialized, true);
  assert.match(versions.data.status.head, /^[0-9a-f]{40}$/);
  const tree = await call("GET", `/api/projects/${throwawayId}/files`);
  assert.equal(tree.status, 200, JSON.stringify(tree.data));
  assert.ok(
    JSON.stringify(tree.data).includes("README"),
    "file tree must list README",
  );
  // The workspace is owned by the omp-builder service user, so a
  // root-run git refuses it ("dubious ownership"); the API itself
  // runs as omp-builder and never hits this. The read-only check
  // below scopes safe.directory to this one workspace.
  const remote = await ssh(
    `git -c safe.directory=/var/lib/omp-builder/data/projects/${throwawayId} -C /var/lib/omp-builder/data/projects/${throwawayId} remote -v`,
  );
  assert.equal(remote.trim(), "", "origin remote must be removed");
  ok(
    "API cross-checks: versions HEAD is the cloned commit, file tree lists README, no origin remote",
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
  passed === 7
    ? `\nmilestone D B5 browser checks passed (${passed} checks)`
    : `\n${passed} browser checks passed before failure`,
);
