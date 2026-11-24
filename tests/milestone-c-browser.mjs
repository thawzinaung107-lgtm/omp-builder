// Milestone C (B1) browser verification — real headless Chromium driving
// the real Builder UI against the live VPS API/web through SSH tunnels.
//
// Runs on a machine WITH a headless Chrome (the VPS has none), from a
// directory whose node_modules resolves `ws`:
//   node tests/milestone-c-browser.mjs
// Env overrides: OMP_BUILDER_CHROME (default the Remotion headless shell),
// OMP_BUILDER_SSH (default root@191.40.5.90), OMP_BUILDER_SSH_KEY
// (default ~/.ssh/id_ed25519), OMP_BUILDER_API (default
// http://127.0.0.1:8787, the tunnel's local end), OMP_BUILDER_WEB
// (default http://127.0.0.1:5173, the tunnel's local end).
//
// What it does (throwaway project, cleaned up at the end):
//   1. Opens SSH tunnels (local 8787 -> VPS API, local 5173 -> VPS web)
//      and mints a throwaway admin session in the VPS DB (revoked at end).
//   2. Creates a throwaway project with index.html v1 ("Version one").
//   3. In headless Chrome: opens the Builder, sends a real OMP prompt
//      (add a paragraph), waits for the turn to settle and a checkpoint
//      to appear.
//   4. Verifies the change card shows Undo/Retry; the Git tab lists the
//      AI checkpoint; Diff opens in the read-only diff viewer;
//      preview-before-restore shows the baseline WITHOUT mutating the
//      live workspace; restore asks for confirmation (discard checkbox
//      unchecked by default) and restores; Undo brings the change back;
//      Retry re-sends the prompt and a second OMP turn settles.
// Cleanup deletes the throwaway project (API DELETE + direct DB sweep)
// and revokes the session.

import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { homedir } from "node:os";
import path from "node:path";

const CHROME =
  process.env.OMP_BUILDER_CHROME ??
  path.join(homedir(), "workspace/remotion-videos/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell");
const SSH_HOST = process.env.OMP_BUILDER_SSH ?? "root@191.40.5.90";
const SSH_KEY = process.env.OMP_BUILDER_SSH_KEY ?? path.join(homedir(), ".ssh", "id_ed25519");
const API = process.env.OMP_BUILDER_API ?? "http://127.0.0.1:8787";
const WEB = process.env.OMP_BUILDER_WEB ?? "http://127.0.0.1:5173";
const ADMIN_ID = "155e3283-d271-452a-af52-e90f900cd78d";
const DB_PATH = "/var/lib/omp-builder/data/persistent/app.db";
const REPO = "/opt/omp-builder";

const execFileAsync = promisify(execFile);
const sshBase = ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-i", SSH_KEY];
const PROMPT = "Add a paragraph after the heading in index.html that says: Added by the Milestone C browser test.";
const PARAGRAPH = "Added by the Milestone C browser test.";

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

async function versions() {
  const r = await call("GET", `/api/projects/${throwawayId}/versions`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

async function fileContent() {
  const r = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("index.html")}`);
  if (r.status === 404) return null;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.content ?? null;
}

async function waitForApi(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for: ${label} (last: ${JSON.stringify(last)})`);
}

// Count session events via the API's replay endpoint (GET /session),
// polling incrementally with afterEventId. Tracks how many user_message
// events carried this run's prompt and how many session_settled events
// have arrived, so Retry can be verified by "one more turn settled".
let lastEventId = 0;
let retryPromptMessages = 0;
let settledTurns = 0;
async function pollSessionCounts() {
  const r = await call("GET", `/api/projects/${throwawayId}/session?afterEventId=${lastEventId}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const e of r.data.events ?? []) {
    lastEventId = Math.max(lastEventId, e.id);
    if (e.type === "user_message" && JSON.stringify(e.payload ?? {}).includes("Milestone C browser test")) retryPromptMessages += 1;
    if (e.type === "session_settled") settledTurns += 1;
  }
  return { retryPromptMessages, settledTurns };
}

try {
  // (1) Tunnels + throwaway session.
  tunnel = spawn("ssh", [...sshBase, "-N", "-L", "8787:127.0.0.1:8787", "-L", "5173:127.0.0.1:5173", SSH_HOST], { stdio: "ignore" });
  await sleep(3000);
  const health = await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false);
  assert.ok(health, "SSH tunnel to the VPS API is not up (local 8787)");
  const webUp = await fetch(`${WEB}/`).then((r) => r.ok).catch(() => false);
  assert.ok(webUp, "SSH tunnel to the VPS web dev server is not up (local 5173)");
  await ssh(
    `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; cd ${REPO} && node -e "const D=require('better-sqlite3'); const db=new D('${DB_PATH}'); db.prepare('INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?,?,?,?,?)').run('${randomUUID()}', '${tokenHash}', '${ADMIN_ID}', new Date(Date.now()+3600000).toISOString(), new Date().toISOString()); db.close();"`
  );
  ok("SSH tunnels up (8787 API, 5173 web); throwaway admin session minted on the VPS");

  // (2) Throwaway project with index.html v1.
  const projectName = `Milestone C Browser Test ${new Date().toISOString()}`;
  const created = await call("POST", "/api/projects", { name: projectName, prompt: "Throwaway project for the Milestone C browser verification." });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  throwawayId = created.data.project.id;
  const v1 = `<!doctype html><meta charset="utf-8"><title>Version Test</title><h1>Version one</h1><p>Milestone C browser test.</p>\n`;
  const put = await call("PUT", `/api/projects/${throwawayId}/files/content`, { path: "index.html", content: v1 });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const initial = await versions();
  assert.equal(initial.status.initialized, true, "project workspace was not git-initialized");
  assert.ok(initial.checkpoints.length >= 1, "no baseline checkpoint after project creation");
  ok(`throwaway project created; workspace git-initialized with ${initial.checkpoints.length} baseline checkpoint(s)`);

  // (3) Headless Chrome + CDP.
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=9222", "--user-data-dir=/tmp/milestone-c-browser-profile", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  // A spawn failure is an 'error' event, not a throw — without a listener
  // it crashes the process and skips the finally cleanup. Await the spawn
  // so a bad Chrome path fails inside the try instead.
  await new Promise((resolve, reject) => {
    chrome.once("error", reject);
    chrome.once("spawn", resolve);
    setTimeout(() => reject(new Error("Chrome spawn timed out")), 10_000);
  });
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
      }, 30_000);
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
  await cdp("Runtime.enable", {}, sessionId);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

  async function evalJs(expression) {
    const { result, exceptionDetails } = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (exceptionDetails) throw new Error(`page JS error: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ""}`);
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
    throw new Error(`timed out waiting for: ${label} (last: ${JSON.stringify(last)})`);
  }
  async function bodyText() {
    return (await evalJs("document.body ? document.body.innerText : String()")) ?? "";
  }
  // Click a button by exact label inside ONE checkpoint's row, identified
  // by its unique shortOid (from the API). The subject text alone is NOT
  // a safe row key: it also appears in the diff view's "compare with"
  // section and the preview header, and a walk-up from there can land on
  // a shared ancestor whose first button belongs to a different row
  // (that mis-clicked the AI checkpoint's Restore once: it was already
  // HEAD, so the restore was a no-op and the test timed out).
  async function clickRowButton(shortOid, subjectSnippet, label) {
    // Find the list row itself (a border-b div holding this checkpoint's
    // shortOid + subject), then click the action button inside it. Never
    // walk up from a button: the workspace tab bar has its own "Preview"
    // button whose ancestors contain the shortOid via the list below it,
    // and that mis-click switched tabs instead of previewing.
    const clicked = await evalJs(`(() => {
      const rows = [...document.querySelectorAll('div')].filter((d) => typeof d.className === 'string' && d.className.includes('border-b') && d.textContent.includes(${JSON.stringify(shortOid)}) && d.textContent.includes(${JSON.stringify(subjectSnippet)}));
      for (const row of rows) {
        const b = [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (b) { b.click(); return 'clicked'; }
      }
      return 'no-match';
    })()`);
    assert.equal(clicked, "clicked", `could not click ${label} for checkpoint ${shortOid} (${clicked})`);
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

  // The admin session cookie, for the tunnelled web origin.
  await cdp("Network.setCookie", { name: "omp_builder_session", value: token, domain: "127.0.0.1", path: "/" }, sessionId);
  await cdp("Page.navigate", { url: `${WEB}/` }, sessionId);
  await waitForPage(`(document.body && document.body.innerText.includes(${JSON.stringify(projectName)}))`, "dashboard listing the throwaway project", 60_000);
  await evalJs(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(projectName)})).click(); "opened"`);
  await waitForPage(`!![...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null)`, "Builder composer", 60_000);
  ok("Builder opened in headless Chrome; composer visible");

  // (4) Send a real OMP prompt through the composer.
  // Wait for the Connected pill first: the mount-time chats-load effect
  // (Milestone D) calls setChat(draft ?? "") ~1-2s after mount and would
  // clobber a value set any earlier. The picker browser test waits the
  // same way. (Pre-existing D race: typing in the first ~2s after opening
  // a project can be lost; flagged in the Milestone E report.)
  await waitForPage(
    `[...document.querySelectorAll('span')].some((s) => s.textContent === "Connected")`,
    "Connected status pill (WS open)",
    120_000,
  );
  await evalJs(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`);
  await waitForPage(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
    const btn = ta.closest('form').querySelector('button[type="submit"]');
    return btn && !btn.disabled;
  })()`, "send button enabled (WS connected)", 60_000);
  await evalJs(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
    ta.closest('form').querySelector('button[type="submit"]').click();
    return true;
  })()`);
  ok("real OMP prompt sent through the Builder composer");

  // (5) Wait for the turn to settle and a checkpoint to appear.
  const settled = await waitForApi("AI checkpoint after the real OMP turn", async () => {
    const v = await versions();
    const ai = v.checkpoints.find((c) => c.subject.startsWith("AI update"));
    return ai ? v : null;
  }, 600_000);
  assert.ok(settled.checkpoints.length >= 2, `expected baseline + AI checkpoint, got ${settled.checkpoints.length}`);
  const aiCheckpoint = settled.checkpoints.find((c) => c.subject.startsWith("AI update"));
  assert.ok(aiCheckpoint.sessionId, "AI checkpoint has no session recorded");
  const afterTurn = await fileContent();
  assert.ok(afterTurn && afterTurn.includes(PARAGRAPH), "index.html does not contain the paragraph OMP was asked to add");
  ok(`real OMP turn settled; AI checkpoint ${aiCheckpoint.shortOid} created (session ${aiCheckpoint.sessionId}); paragraph present in index.html`);

  // (6) Change card shows Undo/Retry.
  const cardText = await bodyText();
  assert.ok(cardText.includes("Undo"), "change card does not show Undo");
  assert.ok(cardText.includes("Retry"), "change card does not show Retry");
  const hasUndoBtn = await evalJs(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith("Undo") && b.offsetParent !== null)`);
  const hasRetryBtn = await evalJs(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith("Retry") && b.offsetParent !== null)`);
  assert.ok(hasUndoBtn && hasRetryBtn, "Undo/Retry buttons not present on the change card");
  ok("change card shows Undo and Retry after the real OMP turn");

  // (7) Retry re-sends the prompt and a second OMP turn settles. This runs
  // here, on the fresh card: once a card is undone its buttons are replaced
  // by the Undone note, so there is no Retry button on an undone card.
  // Baseline counts first (initial turn: 1 prompt message, 1 settle),
  // then Retry must add exactly one more of each.
  const baseline = await pollSessionCounts();
  assert.equal(baseline.retryPromptMessages, 1, `expected 1 prompt message before Retry, got ${baseline.retryPromptMessages}`);
  assert.equal(baseline.settledTurns, 1, `expected 1 settled turn before Retry, got ${baseline.settledTurns}`);
  console.log("  retry button state:", await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith("Retry") && x.offsetParent !== null);
    if (!b) return 'no-retry-button';
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
    const sendBtn = ta ? ta.closest('form').querySelector('button[type="submit"]') : null;
    return JSON.stringify({ disabled: b.disabled, title: b.getAttribute('title'), sendDisabled: sendBtn ? sendBtn.disabled : 'no-send' });
  })()`));
  await clickVisibleButton("Retry");
  await sleep(5000);
  console.log("  after retry click:", await evalJs(`(() => {
    const text = document.body ? document.body.innerText : "";
    return JSON.stringify({ hasWorking: text.toLowerCase().includes("working"), hasStop: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === "Stop" && b.offsetParent !== null) });
  })()`));
  await waitForApi("second user_message after Retry", async () => (await pollSessionCounts()).retryPromptMessages >= 2, 120_000);
  await waitForApi("second session_settled after Retry", async () => (await pollSessionCounts()).settledTurns >= 2, 600_000);
  ok("Retry re-sent the last prompt; a second OMP turn settled");

  // (8) Git tab lists the checkpoint; Diff opens.
  await clickVisibleButton("Git");
  console.log("  git tab state after click:", await evalJs(`(() => {
    const tabs = [...document.querySelectorAll('button[role="tab"]')].map((b) => ({ text: b.textContent.trim(), selected: b.getAttribute('aria-selected'), visible: b.offsetParent !== null }));
    return JSON.stringify({ tabs, bodyHasVersionHistory: document.body ? document.body.innerText.toLowerCase().includes("version history") : null, bodyStart: document.body ? document.body.innerText.slice(0, 300) : null });
  })()`));
  await waitForPage(`(document.body && document.body.innerText.toLowerCase().includes("version history"))`, "Version history panel", 30_000);
  await waitForPage(`(document.body && document.body.innerText.toLowerCase().includes("ai update"))`, "AI checkpoint listed in the Git tab", 30_000);
  ok("Git tab renders the checkpoint history (baseline + AI update)");
  await clickRowButton(aiCheckpoint.shortOid, "AI update", "Diff");
  await waitForPage(`(document.body && document.body.innerText.toLowerCase().includes("diff:"))`, "diff view header", 30_000);
  const diffText = await bodyText();
  assert.ok(diffText.includes("index.html"), "diff view does not list index.html");
  assert.ok(diffText.includes(`\u2192 ${aiCheckpoint.shortOid}`), "diff view header does not name the AI checkpoint");
  ok("diff of the AI checkpoint opens in the read-only diff viewer (Diff: … → …)");

  // (9) Preview-before-restore: baseline preview must NOT mutate the live workspace.
  const baselineCheckpoint = settled.checkpoints.find((c) => c.subject.startsWith("Baseline"));
  assert.ok(baselineCheckpoint, "no baseline checkpoint found");
  await clickRowButton(baselineCheckpoint.shortOid, "Baseline: initial project state", "Preview");
  await waitForPage(`(document.body && document.body.innerText.toLowerCase().includes("previewing checkpoint"))`, "preview-before-restore panel", 30_000);
  const liveAfterPreview = await fileContent();
  assert.ok(liveAfterPreview && liveAfterPreview.includes(PARAGRAPH), "LIVE workspace mutated by preview-before-restore (paragraph gone)");
  const previewText = await bodyText();
  assert.ok(previewText.toLowerCase().includes(`previewing checkpoint ${baselineCheckpoint.shortOid}`), "preview panel does not name the baseline checkpoint");
  assert.ok(previewText.toLowerCase().includes("index.html"), "preview panel does not list index.html in the baseline diff");
  ok("preview-before-restore shows the baseline staging copy; live workspace untouched (paragraph still present)");

  // (10) Restore with uncommitted changes: make the workspace dirty, then
  // restore asks for confirmation with the discard checkbox unchecked by
  // default and the confirm button disabled until it is checked.
  const dirtyContent = (await fileContent()) + "\n<!-- dirty edit: restore must refuse unless discard is checked -->\n";
  const dirtyPut = await call("PUT", `/api/projects/${throwawayId}/files/content`, { path: "index.html", content: dirtyContent });
  assert.equal(dirtyPut.status, 200, JSON.stringify(dirtyPut.data));
  await clickVisibleButton("Refresh");
  await waitForPage(`(document.body && document.body.innerText.toLowerCase().includes("uncommitted changes"))`, "dirty banner after out-of-band edit", 30_000);
  await clickRowButton(baselineCheckpoint.shortOid, "Baseline: initial project state", "Restore");
  await waitForPage(`(document.body && document.body.innerText.toLowerCase().includes("restore to"))`, "restore confirmation panel", 30_000);
  const discardChecked = await evalJs(`(() => {
    const cb = [...document.querySelectorAll('input[type="checkbox"]')].find((i) => i.offsetParent !== null && i.closest('label')?.textContent.includes("Discard uncommitted changes"));
    return cb ? cb.checked : 'no-checkbox';
  })()`);
  assert.equal(discardChecked, false, `discard checkbox must be unchecked by default (got ${discardChecked})`);
  const restoreDisabled = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === "Restore this version" && x.offsetParent !== null);
    return b ? b.disabled : 'no-button';
  })()`);
  assert.equal(restoreDisabled, true, `Restore must be disabled while dirty without discard (got ${restoreDisabled})`);
  await evalJs(`(() => {
    const cb = [...document.querySelectorAll('input[type="checkbox"]')].find((i) => i.offsetParent !== null && i.closest('label')?.textContent.includes("Discard uncommitted changes"));
    cb.click();
    return cb.checked;
  })()`);
  await waitForPage(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === "Restore this version" && x.offsetParent !== null);
    return b && !b.disabled;
  })()`, "restore button enabled after checking discard", 30_000);
  await clickVisibleButton("Restore this version");
  await sleep(5000);
  console.log("  restore diag:", await evalJs(`(() => {
    const text = document.body ? document.body.innerText : "";
    return JSON.stringify({ panelStillOpen: text.toLowerCase().includes("restore to"), noticeShown: text.includes("Restored to"), errorShown: text.toLowerCase().includes("restore failed") || text.toLowerCase().includes("uncommitted changes exist"), snippet: text.toLowerCase().split("restor").slice(1, 4).map((part) => "restor" + part.slice(0, 120)) });
  })()`));
  console.log("  checkpoints after restore click:", (await versions()).checkpoints.map((c) => c.subject).join(" | "));
  await waitForApi("index.html reverted after restore", async () => {
    const content = await fileContent();
    return content === null || !content.includes(PARAGRAPH) ? true : null;
  }, 60_000);
  const afterRestore = await versions();
  assert.ok(afterRestore.checkpoints.some((c) => c.subject.startsWith("Restore to")), "no Restore commit in the history after restoring");
  const restoredContent = await fileContent();
  assert.ok(restoredContent === null, `index.html should be gone after restoring to the baseline, got: ${String(restoredContent).slice(0, 120)}`);
  ok("restore with uncommitted changes asked for confirmation (discard unchecked by default, confirm disabled until checked) and restored the baseline as a new commit; index.html reverted");

  // (11) Undo on the change card brings the change back.
  await clickVisibleButton("Undo");
  await waitForApi("index.html back after Undo", async () => {
    const content = await fileContent();
    return content && content.includes(PARAGRAPH) ? true : null;
  }, 60_000);
  // The file reverts on the server before the client's response lands, so
  // poll for the card's Undone note instead of asserting on one read.
  await waitForPage(`(document.body && document.body.innerText.toLowerCase().includes("undone"))`, "change card Undone note", 30_000);
  const undoText = await bodyText();
  assert.ok(undoText.toLowerCase().includes("undone"), "change card does not show the Undone state after Undo");
  const afterUndo = await versions();
  assert.ok(afterUndo.checkpoints.some((c) => c.subject.startsWith("Undo:")), "no Undo commit in the history after undoing");
  ok("Undo on the change card restored the AI checkpoint as a new commit (paragraph back, card shows Undone)");


  ws.close();
} finally {
  if (throwawayId) {
    await call("DELETE", `/api/projects/${throwawayId}`).catch(() => undefined);
  }
  if (chrome) chrome.kill("SIGTERM");
  if (tunnel) tunnel.kill("SIGTERM");
  if (throwawayId) {
    await ssh(
      `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; cd ${REPO} && node -e "const D=require('better-sqlite3'); const db=new D('${DB_PATH}'); db.prepare('DELETE FROM projects WHERE id=?').run('${throwawayId}'); db.prepare('DELETE FROM preview_state WHERE project_id=?').run('${throwawayId}'); db.prepare('DELETE FROM omp_events WHERE project_id=?').run('${throwawayId}'); db.prepare('DELETE FROM checkpoints WHERE project_id=?').run('${throwawayId}'); db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(new Date().toISOString(), '${tokenHash}'); db.close();"`
    ).catch(() => undefined);
    await ssh(`rm -rf ${REPO}/data/projects/${throwawayId} /var/lib/omp-builder/previews/${throwawayId} /var/lib/omp-builder/data/version-staging/${throwawayId}; true`).catch(() => undefined);
    console.log(`throwaway project ${throwawayId} deleted; test session revoked`);
  }
}

console.log(`milestone C browser verification passed (${passed} checks)`);
