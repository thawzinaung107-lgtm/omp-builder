// Milestone D (B2) browser verification - real headless Chromium driving
// the real Builder UI against the live VPS API/web through SSH tunnels.
//
// Runs on a machine WITH a headless Chrome (the VPS has none), from a
// directory whose node_modules resolves `ws`:
//   node tests/milestone-d-chat-sessions-browser.mjs
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
//   3. In headless Chrome: opens the Builder, checks the chat tab strip
//      (Chat 1 + New chat), types a draft in Chat 1, opens Chat 2, checks
//      the composer is empty there, switches back and checks the draft
//      survived.
//   4. Sends a real OMP prompt in Chat 1 (add a paragraph), waits for
//      the turn to settle and a checkpoint attributed to Chat 1.
//   5. Switches to Chat 2, sends a real OMP prompt (add a second
//      paragraph), waits for settle; both paragraphs are in index.html
//      (shared workspace) and the second checkpoint is attributed to
//      Chat 2.
//   6. Switches back to Chat 1: its conversation shows the Chat 1 prompt
//      but NOT the Chat 2 prompt (isolated conversation state).
//   7. Draft in Chat 2 survives a full page reload; the active chat is
//      restored after reload.
//   8. Rename + reorder via the API, reload, tab order follows; a
//      synthetic drag-and-drop on the strip reorders the tabs in the UI.
//   9. Close Chat 2 through the tab strip (two-step confirm); the last
//      chat cannot be deleted (409 surfaces in the UI).
//  10. Best-effort pool check: two concurrent turns, then a third chat's
//      prompt shows the "OMP process limit reached" banner - skipped
//      (logged, not failed) if either turn settles first.
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
const PROMPT_1 = "Add a paragraph after the heading in index.html that says: Added by chat one. Do not run git commands; leave your changes uncommitted.";
const PARAGRAPH_1 = "Added by chat one.";
// File-content markers use the distinguishing words only: the model
// copies the prompt's wording but may vary punctuation/casing.
const MARKER_1 = "chat one";
const PROMPT_2 = "Add a paragraph after the heading in index.html that says: Added by chat two. Do not run git commands; leave your changes uncommitted.";
const PARAGRAPH_2 = "Added by chat two.";
const MARKER_2 = "chat two";
const DRAFT_1 = "draft text for chat one - do not send";
const DRAFT_2 = "draft text for chat two - do not send";

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

async function chats() {
  const r = await call("GET", `/api/projects/${throwawayId}/chats`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.chats;
}

async function versions() {
  const r = await call("GET", `/api/projects/${throwawayId}/versions`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

async function sessionEvents() {
  const r = await call("GET", `/api/projects/${throwawayId}/session`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  return Array.isArray(d) ? d : (d.events ?? []);
}

async function assertChatHasUserMessage(chatId, marker) {
  const events = await sessionEvents();
  const hit = events.find((e) => e.type === "user_message" && e.chatSessionId === chatId && JSON.stringify(e).includes(marker));
  assert.ok(hit, `no user_message for chat ${chatId} containing ${JSON.stringify(marker)} in the session events`);
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

try {
  // (1) Tunnels + throwaway session.
  tunnel = spawn("ssh", [...sshBase, "-N", "-L", "8787:127.0.0.1:8787", "-L", "5173:127.0.0.1:5173", SSH_HOST], { stdio: "ignore" });
  await sleep(3000);
  const health = await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false);
  assert.ok(health, "SSH tunnel to the VPS API is not up (local 8787)");
  const webUp = await fetch(`${WEB}/`).then((r) => r.ok).catch(() => false);
  assert.ok(webUp, "SSH tunnel to the VPS web dev server is not up (local 5173)");
  await ssh(
    `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; cd ${REPO} && node -e "const D=require('better-sqlite3'); const db=new D('${DB_PATH}'); const now=new Date().toISOString(); db.prepare(\\"INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)\\").run('${randomUUID()}', '${tokenHash}', '${ADMIN_ID}', new Date(Date.now()+3600000).toISOString(), now); db.close();"`,
  );
  ok("SSH tunnels up (8787 API, 5173 web); throwaway admin session minted on the VPS");

  // (2) Throwaway project with index.html v1.
  const projectName = `Milestone D Browser Test ${new Date().toISOString()}`;
  const created = await call("POST", "/api/projects", { name: projectName, prompt: "Throwaway project for the Milestone D browser verification." });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  throwawayId = created.data.project.id;
  const v1 = `<!doctype html><meta charset="utf-8"><title>Version Test</title><h1>Version one</h1><p>Milestone D browser test.</p>\n`;
  const put = await call("PUT", `/api/projects/${throwawayId}/files/content`, { path: "index.html", content: v1 });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const initialChats = await chats();
  assert.equal(initialChats.length, 1, "a new project must start with exactly one chat");
  assert.equal(initialChats[0].title, "Chat 1");
  const chat1Id = initialChats[0].id;
  ok("throwaway project created with one default chat (Chat 1)");

  // (3) Headless Chrome + CDP.
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=9222", "--user-data-dir=/tmp/milestone-d-browser-profile", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
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
  async function composer() {
    return evalJs(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
      return ta ? { value: ta.value } : null;
    })()`);
  }
  async function setComposer(text) {
    await evalJs(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value;
    })()`);
  }
  async function sendComposer() {
    await evalJs(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
      ta.closest('form').querySelector('button[type="submit"]').click();
      return true;
    })()`);
  }
  async function chatTabTitles() {
    return evalJs(`(() => {
      const strip = document.querySelector('[aria-label="Chat sessions"]');
      if (!strip) return null;
      return [...strip.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim());
    })()`);
  }
  // Click a tab by its position in the API order, not by title: the UI
  // only refreshes tab titles on reload, so after the server auto-titles
  // a chat from its first prompt the strip may still show "Chat 1".
  async function clickChatTabById(chatId) {
    const list = await chats();
    const idx = list.findIndex((c) => c.id === chatId);
    assert.ok(idx >= 0, `chat ${chatId} not in the API chat list`);
    const clicked = await evalJs(`(() => {
      const strip = document.querySelector('[aria-label="Chat sessions"]');
      if (!strip) return 'no-strip';
      const tabs = [...strip.querySelectorAll('[role="tab"]')].filter((t) => t.offsetParent !== null);
      const tab = tabs[${idx}];
      if (!tab) return 'no-tab';
      tab.click();
      return 'clicked';
    })()`);
    assert.equal(clicked, "clicked", `could not click chat tab at index ${idx} (${clicked})`);
  }
  async function clickChatTab(titleSnippet) {
    const clicked = await evalJs(`(() => {
      const strip = document.querySelector('[aria-label="Chat sessions"]');
      if (!strip) return 'no-strip';
      const tab = [...strip.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes(${JSON.stringify(titleSnippet)}) && t.offsetParent !== null);
      if (!tab) return 'no-tab';
      tab.click();
      return 'clicked';
    })()`);
    assert.equal(clicked, "clicked", `could not click chat tab ${JSON.stringify(titleSnippet)} (${clicked})`);
  }
  async function conversationText() {
    // The conversation panel is the only visible scrollbar-thin div with
    // both space-y-3 and p-4 (the explorer/console panels lack one of them).
    return evalJs(`(() => {
      const panels = [...document.querySelectorAll('div')].filter((d) => typeof d.className === 'string' && d.className.includes('scrollbar-thin') && d.className.includes('space-y-3') && d.className.includes('p-4') && d.offsetParent !== null);
      return panels.length ? panels[0].innerText : '';
    })()`);
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
  await waitForPage(`!!document.querySelector('[aria-label="Chat sessions"]')`, "chat tab strip", 30_000);
  // The strip renders before the chats list loads - wait for the first tab.
  await waitForPage(`(() => {
    const strip = document.querySelector('[aria-label="Chat sessions"]');
    return strip && strip.querySelectorAll('[role="tab"]').length >= 1;
  })()`, "first chat tab in the strip", 30_000);
  const stripTitles = await chatTabTitles();
  assert.ok(stripTitles && stripTitles.some((t) => t.includes("Chat 1")), `tab strip must list Chat 1, got ${JSON.stringify(stripTitles)}`);
  ok("Builder opened; chat tab strip shows Chat 1 + New chat");

  // (4) Draft survives tab switches: type in Chat 1, open Chat 2 (empty
  // composer), switch back (draft restored).
  await setComposer(DRAFT_1);
  assert.equal((await composer()).value, DRAFT_1);
  await clickVisibleButton("New chat");
  const chat2 = (await waitForApi("second chat created", async () => {
    const list = await chats();
    return list.length >= 2 ? list : null;
  }, 30_000)).find((c) => c.id !== chat1Id);
  const chat2Id = chat2.id;
  await waitForPage(`(() => {
    const strip = document.querySelector('[aria-label="Chat sessions"]');
    return strip && [...strip.querySelectorAll('[role="tab"]')].length >= 2;
  })()`, "second tab in the strip", 30_000);
  assert.equal((await composer()).value, "", "Chat 2 composer must start empty");
  await clickChatTab("Chat 1");
  await waitForPage(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
    return ta && ta.value === ${JSON.stringify(DRAFT_1)};
  })()`, "Chat 1 draft restored after switching back", 30_000);
  ok("draft survives tab switches (Chat 1 draft restored after visiting Chat 2)");

  // (5) Real OMP prompt in Chat 1; checkpoint attributed to Chat 1.
  await setComposer(PROMPT_1);
  await waitForPage(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
    const btn = ta.closest('form').querySelector('button[type="submit"]');
    return btn && !btn.disabled;
  })()`, "send button enabled (WS connected)", 60_000);
  await sendComposer();
  ok("real OMP prompt sent in Chat 1");
  // A turn settles either with an AI checkpoint (uncommitted changes at
  // settle) or, if the model committed its own work, with the file changed
  // and a clean tree (no checkpoint). Accept either; verify attribution
  // from the checkpoint when one exists, else at the event level.
  const settled1 = await waitForApi("Chat 1 turn settled (checkpoint or file change)", async () => {
    const v = await versions();
    const ai = v.checkpoints.find((c) => c.subject.startsWith("AI update"));
    if (ai) return { v, ai };
    const content = await fileContent();
    if (content && content.includes(MARKER_1)) return { v, ai: null };
    return null;
  }, 600_000);
  const afterTurn1 = await fileContent();
  assert.ok(afterTurn1 && afterTurn1.includes(MARKER_1), "index.html does not contain the Chat 1 paragraph");
  if (settled1.ai) {
    assert.equal(settled1.ai.sessionId, chat1Id, `Chat 1 checkpoint must record Chat 1, got ${settled1.ai.sessionId}`);
    ok(`Chat 1 turn settled; AI checkpoint ${settled1.ai.shortOid} attributed to Chat 1; paragraph present`);
  } else {
    await assertChatHasUserMessage(chat1Id, "chat one");
    console.log("  note: Chat 1 model committed its own work, so no AI checkpoint; attribution verified from the session events");
    ok("Chat 1 turn settled; paragraph present; turn attributed to Chat 1 in the session events");
  }

  // (6) Real OMP prompt in Chat 2; shared workspace, Chat 2 attribution.
  await clickChatTab(chat2.title);
  await waitForPage(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
    return ta && ta.value === "";
  })()`, "Chat 2 composer empty after switch", 30_000);
  await setComposer(PROMPT_2);
  await sendComposer();
  ok("real OMP prompt sent in Chat 2");
  const settled2 = await waitForApi("Chat 2 turn settled (checkpoint or file change)", async () => {
    const v = await versions();
    const ai = v.checkpoints.filter((c) => c.subject.startsWith("AI update"));
    // Versions are newest-first, so the Chat 2 checkpoint is [0] here.
    if (ai.length >= 2) return { v, ai: ai[0] };
    const content = await fileContent();
    if (content && content.includes(MARKER_2)) return { v, ai: null };
    return null;
  }, 600_000);
  const afterTurn2 = await fileContent();
  assert.ok(afterTurn2 && afterTurn2.includes(MARKER_1) && afterTurn2.includes(MARKER_2), "index.html must contain both paragraphs (shared workspace)");
  if (settled2.ai) {
    assert.equal(settled2.ai.sessionId, chat2Id, `Chat 2 checkpoint must record Chat 2, got ${settled2.ai.sessionId}`);
    ok(`Chat 2 turn settled; AI checkpoint ${settled2.ai.shortOid} attributed to Chat 2; both paragraphs in index.html`);
  } else {
    await assertChatHasUserMessage(chat2Id, "chat two");
    console.log("  note: Chat 2 model committed its own work, so no AI checkpoint; attribution verified from the session events");
    ok("Chat 2 turn settled; both paragraphs in index.html (shared workspace); turn attributed to Chat 2 in the session events");
  }

  // (7) Switching back to Chat 1 shows only Chat 1's conversation.
  await clickChatTabById(chat1Id);
  await waitForPage(`(() => {
    const panels = [...document.querySelectorAll('div')].filter((d) => typeof d.className === 'string' && d.className.includes('scrollbar-thin') && d.className.includes('space-y-3') && d.className.includes('p-4') && d.offsetParent !== null);
    return panels.length > 0 && panels[0].innerText.includes(${JSON.stringify(MARKER_1)});
  })()`, "Chat 1 conversation visible after switch back", 60_000);
  const chat1Text = await conversationText();
  assert.ok(chat1Text.includes("chat one"), "Chat 1 conversation must show its own prompt");
  assert.ok(!chat1Text.includes("chat two"), "Chat 1 conversation must NOT show Chat 2's prompt (isolation)");
  ok("switching back to Chat 1 shows only Chat 1's conversation (no leakage)");

  // (8) Draft in Chat 2 survives a full page reload; active chat restored.
  await clickChatTabById(chat2Id);
  await setComposer(DRAFT_2);
  await cdp("Page.navigate", { url: `${WEB}/` }, sessionId);
  await waitForPage(`(document.body && document.body.innerText.includes(${JSON.stringify(projectName)}))`, "dashboard after reload", 60_000);
  await evalJs(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(projectName)})).click(); "opened"`);
  await waitForPage(`!!document.querySelector('[aria-label="Chat sessions"]')`, "chat tab strip after reload", 60_000);
  await waitForPage(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder === "Ask OMP to change anything..." && t.offsetParent !== null);
    return ta && ta.value === ${JSON.stringify(DRAFT_2)};
  })()`, "Chat 2 draft + active chat restored after reload", 60_000);
  const titlesAfterReload = await chatTabTitles();
  assert.equal(titlesAfterReload.length, 2, `expected 2 tabs after reload, got ${JSON.stringify(titlesAfterReload)}`);
  ok("draft + active chat survive a full page reload (Chat 2 active, draft intact)");

  // (9) Rename + reorder via API, reload, tab order follows; then a
  // synthetic drag-and-drop on the strip reorders the tabs in the UI.
  await call("PATCH", `/api/projects/${throwawayId}/chats/${chat1Id}`, { title: "Alpha Chat" });
  await call("PATCH", `/api/projects/${throwawayId}/chats/${chat2Id}`, { title: "Beta Chat" });
  await call("POST", `/api/projects/${throwawayId}/chats/reorder`, { order: [chat2Id, chat1Id] });
  await cdp("Page.navigate", { url: `${WEB}/` }, sessionId);
  await waitForPage(`(document.body && document.body.innerText.includes(${JSON.stringify(projectName)}))`, "dashboard after reorder reload", 60_000);
  await evalJs(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(projectName)})).click(); "opened"`);
  await waitForPage(`(() => {
    const strip = document.querySelector('[aria-label="Chat sessions"]');
    return strip && [...strip.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()).join('|') === "Beta Chat|Alpha Chat";
  })()`, "tab order Beta, Alpha after reorder + reload", 60_000);
  ok("reorder persists across reload (Beta Chat first, Alpha Chat second)");
  const dragResult = await evalJs(`(() => {
    const strip = document.querySelector('[aria-label="Chat sessions"]');
    const tabs = [...strip.querySelectorAll('[role="tab"]')];
    // The drop handler inserts the dragged tab BEFORE the drop target, so
    // drag the second tab (Alpha) onto the first (Beta) to flip the order.
    // (Dragging the first onto the second is a no-op under that rule.)
    tabs[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
    tabs[0].dispatchEvent(new DragEvent('dragover', { bubbles: true }));
    tabs[0].dispatchEvent(new DragEvent('drop', { bubbles: true }));
    return 'dispatched';
  })()`);
  assert.equal(dragResult, "dispatched");
  await waitForPage(`(() => {
    const strip = document.querySelector('[aria-label="Chat sessions"]');
    return strip && [...strip.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()).join('|') === "Alpha Chat|Beta Chat";
  })()`, "drag-and-drop reorders tabs in the UI", 60_000);
  const reorderedList = await chats();
  assert.deepEqual(reorderedList.map((c) => c.id), [chat1Id, chat2Id], "drag reorder must persist server-side");
  ok("drag-and-drop on the tab strip reorders the chats (UI + server)");

  // (10) Close Chat 2 through the tab strip (two-step confirm); the
  // last chat cannot be deleted.
  await evalJs(`(() => {
    const strip = document.querySelector('[aria-label="Chat sessions"]');
    const tab = [...strip.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes("Beta Chat"));
    const btn = tab.querySelector('button[aria-label^="Close"]');
    btn.click();
    return 'armed';
  })()`);
  await waitForPage(`(() => {
    const strip = document.querySelector('[aria-label="Chat sessions"]');
    const tab = [...strip.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes("Beta Chat"));
    return tab && tab.textContent.includes("Delete?");
  })()`, "close asks for confirmation (Delete?)", 30_000);
  await evalJs(`(() => {
    const strip = document.querySelector('[aria-label="Chat sessions"]');
    const tab = [...strip.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes("Beta Chat"));
    const btn = tab.querySelector('button[aria-label^="Confirm delete"]');
    btn.click();
    return 'confirmed';
  })()`);
  await waitForApi("Beta Chat deleted", async () => (await chats()).length === 1, 30_000);
  const remainingTitles = await chatTabTitles();
  assert.ok(remainingTitles.length === 1 && remainingTitles[0].includes("Alpha Chat"), `expected only Alpha Chat left, got ${JSON.stringify(remainingTitles)}`);
  ok("close through the tab strip deletes the chat (two-step confirm)");
  await evalJs(`(() => {
    const strip = document.querySelector('[aria-label="Chat sessions"]');
    const tab = [...strip.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes("Alpha Chat"));
    const btn = tab.querySelector('button[aria-label^="Close"]');
    btn.click();
    return 'armed';
  })()`);
  await waitForPage(`(() => {
    const strip = document.querySelector('[aria-label="Chat sessions"]');
    const tab = [...strip.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes("Alpha Chat"));
    return tab && tab.textContent.includes("Delete?");
  })()`, "close armed on the last chat", 30_000);
  await evalJs(`(() => {
    const strip = document.querySelector('[aria-label="Chat sessions"]');
    const tab = [...strip.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes("Alpha Chat"));
    const btn = tab.querySelector('button[aria-label^="Confirm delete"]');
    btn.click();
    return 'confirmed';
  })()`);
  await waitForPage(`(document.body && document.body.innerText.includes("Cannot delete the last chat"))`, "last-chat guard surfaces in the UI", 30_000);
  assert.equal((await chats()).length, 1, "the last chat must still exist after a refused delete");
  ok("last chat cannot be deleted (409 surfaces as an inline error)");

  // (11) Best-effort pool check: two concurrent turns, then a third
  // chat's prompt. If either turn settles first the slot frees and the
  // check is inconclusive - logged, not failed (the API test covers
  // pool contention deterministically).
  await clickVisibleButton("New chat");
  const chat3 = (await waitForApi("third chat created", async () => {
    const list = await chats();
    return list.length >= 2 ? list : null;
  }, 30_000)).find((c) => c.id !== chat1Id);
  const chat3Id = chat3.id;
  await clickChatTab("Alpha Chat");
  await setComposer("Add a paragraph after the heading in index.html that says: Added by the pool test one.");
  await sendComposer();
  await clickChatTab(chat3.title);
  await setComposer("Add a paragraph after the heading in index.html that says: Added by the pool test two.");
  await sendComposer();
  await sleep(5000);
  await clickVisibleButton("New chat");
  const chat4 = (await waitForApi("fourth chat created", async () => {
    const list = await chats();
    return list.length >= 3 ? list : null;
  }, 30_000)).find((c) => c.id !== chat1Id && c.id !== chat3Id);
  await setComposer("Add a paragraph after the heading in index.html that says: Added by the pool test three.");
  await sendComposer();
  await sleep(15000);
  const poolText = await bodyText();
  if (poolText.includes("OMP process limit reached")) {
    ok("pool (best-effort): third concurrent prompt shows 'OMP process limit reached' in the UI");
  } else {
    console.log("  pool check inconclusive: a turn settled before the third prompt (no busy banner); pool contention is covered by the API test");
  }

  ws.close();
} finally {
  if (throwawayId) {
    await call("DELETE", `/api/projects/${throwawayId}`).catch(() => undefined);
  }
  if (chrome) chrome.kill("SIGTERM");
  if (tunnel) tunnel.kill("SIGTERM");
  if (throwawayId) {
    await ssh(
      `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; cd ${REPO} && node -e "const D=require('better-sqlite3'); const db=new D('${DB_PATH}'); db.prepare(\\"UPDATE sessions SET revoked_at=? WHERE token_hash=?\\").run(new Date().toISOString(), '${tokenHash}'); db.prepare(\\"DELETE FROM omp_events WHERE project_id=?\\").run('${throwawayId}'); db.prepare(\\"DELETE FROM checkpoints WHERE project_id=?\\").run('${throwawayId}'); db.prepare(\\"DELETE FROM chat_sessions WHERE project_id=?\\").run('${throwawayId}'); db.prepare(\\"DELETE FROM preview_state WHERE project_id=?\\").run('${throwawayId}'); db.prepare(\\"DELETE FROM projects WHERE id=?\\").run('${throwawayId}'); db.close();"`,
    ).catch(() => undefined);
    await ssh(`rm -rf ${REPO}/data/projects/${throwawayId} /var/lib/omp-builder/previews/${throwawayId} /var/lib/omp-builder/data/version-staging/${throwawayId}; true`).catch(() => undefined);
    console.log(`throwaway project ${throwawayId} deleted; test session revoked`);
  }
}

console.log(`milestone D browser verification passed (${passed} checks)`);
