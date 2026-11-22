import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { rm, symlink } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

// Phase 3A file API tests — run against the LIVE API on the VPS:
//   node tests/phase3-files.mjs
// Mints a throwaway admin session (revoked at the end), creates a throwaway
// project for mutation tests, and leaves that (empty) project in place.
// Env overrides: OMP_BUILDER_API, OMP_BUILDER_DB, OMP_BUILDER_PROJECTS_ROOT.

const api = process.env.OMP_BUILDER_API ?? "http://127.0.0.1:8787";
const dbPath = process.env.OMP_BUILDER_DB ?? "/var/lib/omp-builder/data/persistent/app.db";
const projectsRoot = process.env.OMP_BUILDER_PROJECTS_ROOT ?? "/var/lib/omp-builder/data/projects";
const ADMIN_ID = "155e3283-d271-452a-af52-e90f900cd78d";
const PHASE2_ID = "134cc3fe-631f-4755-9839-67af3bfd8ba9";
const GUA_ID = "4f75505f-a2d9-4cc9-b6f8-4e3978c6de9b";

const db = new Database(dbPath);
const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const now = new Date().toISOString();
db.prepare("INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
  randomUUID(),
  tokenHash,
  ADMIN_ID,
  new Date(Date.now() + 14 * 86_400_000).toISOString(),
  now,
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

function flatten(entries, out = []) {
  for (const entry of entries) {
    out.push(entry);
    if (entry.children) flatten(entry.children, out);
  }
  return out;
}

let throwawayId = null;
const throwawayWorkspace = () => path.join(projectsRoot, throwawayId);
try {
  // (0) Unauthenticated requests are rejected.
  const anon = await fetch(`${api}/api/projects/${PHASE2_ID}/files`);
  assert.equal(anon.status, 401);
  ok("unauthenticated file listing is rejected (401)");

  // (1) Listing returns the Phase 2 Test fixture tree with index.html.
  const listed = await call("GET", `/api/projects/${PHASE2_ID}/files`);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  const fixtureFiles = flatten(listed.data.tree);
  const indexHtml = fixtureFiles.find((entry) => entry.path === "index.html");
  assert.ok(indexHtml, "index.html missing from fixture tree");
  assert.equal(indexHtml.type, "file");
  assert.equal(typeof indexHtml.size, "number");
  assert.equal(typeof indexHtml.mtime, "string");
  ok("file listing returns the Phase 2 Test fixture tree with index.html");

  // Throwaway project for all mutation tests.
  const created = await call("POST", "/api/projects", {
    name: `Phase 3A Test ${new Date().toISOString()}`,
    prompt: "Throwaway project for Phase 3A file API tests. Do not delete the row.",
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  throwawayId = created.data.project.id;
  console.log(`throwaway project: ${throwawayId}`);
  ok("throwaway test project created");

  // (2) Read + write round-trip on the throwaway project.
  const made = await call("POST", `/api/projects/${throwawayId}/files`, { path: "phase3a-test.txt", type: "file" });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const written = await call("PUT", `/api/projects/${throwawayId}/files/content`, {
    path: "phase3a-test.txt",
    content: "hello phase3a\n",
  });
  assert.equal(written.status, 200, JSON.stringify(written.data));
  const read = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("phase3a-test.txt")}`);
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(read.data.content, "hello phase3a\n");
  assert.equal(read.data.path, "phase3a-test.txt");
  const removed = await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "phase3a-test.txt" });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  const gone = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("phase3a-test.txt")}`);
  assert.equal(gone.status, 404, JSON.stringify(gone.data));
  ok("file read + write round-trip (create, write, read back, delete)");

  // (3) Directory traversal is rejected, including encoded variants.
  // Note: pre-encoded variants are sent raw (no double-encoding) so the
  // server's URL parser decodes them to traversal sequences.
  for (const bad of ["../app.db", "..\\app.db", "/etc/passwd", "sub/../../app.db", "%2e%2e%2fapp.db", "%2e%2e%5capp.db"]) {
    const attempt = await call("GET", `/api/projects/${throwawayId}/files/content?path=${bad}`);
    assert.equal(attempt.status, 400, `${bad} -> ${attempt.status} ${JSON.stringify(attempt.data)}`);
  }
  const traversalWrite = await call("PUT", `/api/projects/${throwawayId}/files/content`, { path: "../evil.txt", content: "x" });
  assert.equal(traversalWrite.status, 400, JSON.stringify(traversalWrite.data));
  const traversalCreate = await call("POST", `/api/projects/${throwawayId}/files`, { path: "../../evil", type: "dir" });
  assert.equal(traversalCreate.status, 400, JSON.stringify(traversalCreate.data));
  ok("directory traversal rejected (../, absolute, encoded %2e%2e%2f, backslash)");

  // (4) Symlink escapes are rejected.
  const etcLink = path.join(throwawayWorkspace(), "link-to-etc");
  const otherLink = path.join(throwawayWorkspace(), "link-to-other");
  try {
    await symlink("/etc", etcLink);
    await symlink(path.join(projectsRoot, PHASE2_ID), otherLink);
    const viaEtc = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("link-to-etc/passwd")}`);
    assert.equal(viaEtc.status, 403, `link-to-etc -> ${viaEtc.status} ${JSON.stringify(viaEtc.data)}`);
    const viaOther = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("link-to-other/index.html")}`);
    assert.equal(viaOther.status, 403, `link-to-other -> ${viaOther.status} ${JSON.stringify(viaOther.data)}`);
    // The tree must not serve symlinked entries either.
    const tree = await call("GET", `/api/projects/${throwawayId}/files`);
    assert.equal(tree.status, 200);
    assert.equal(flatten(tree.data.tree).some((entry) => entry.path.startsWith("link-to-")), false);
    ok("symlink escape rejected (to /etc and to another project; links hidden from tree)");
  } finally {
    await rm(etcLink, { force: true });
    await rm(otherLink, { force: true });
  }

  // (5) Cross-project authorization: one project's files are not reachable
  // through another project's endpoints.
  await call("POST", `/api/projects/${throwawayId}/files`, { path: "secret.txt", type: "file" });
  await call("PUT", `/api/projects/${throwawayId}/files/content`, { path: "secret.txt", content: "throwaway secret" });
  const crossRead = await call(
    "GET",
    `/api/projects/${GUA_ID}/files/content?path=${encodeURIComponent(`../${throwawayId}/secret.txt`)}`,
  );
  assert.equal(crossRead.status, 400, JSON.stringify(crossRead.data));
  const guaTree = await call("GET", `/api/projects/${GUA_ID}/files`);
  assert.equal(guaTree.status, 200);
  assert.equal(flatten(guaTree.data.tree).some((entry) => entry.path === "secret.txt"), false);
  const crossDelete = await call("DELETE", `/api/projects/${GUA_ID}/files`, { path: `../${throwawayId}/secret.txt` });
  assert.equal(crossDelete.status, 400, JSON.stringify(crossDelete.data));
  await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "secret.txt" });
  ok("cross-project access rejected (other project's files not listable or readable via this project)");

  // (6) Protected paths are rejected.
  for (const [method, urlPath, body] of [
    ["PUT", `/api/projects/${throwawayId}/files/content`, { path: ".env", content: "SECRET=x" }],
    ["PUT", `/api/projects/${throwawayId}/files/content`, { path: ".env.local", content: "SECRET=x" }],
    ["PUT", `/api/projects/${throwawayId}/files/content`, { path: "sub/secret.pem", content: "x" }],
    ["PUT", `/api/projects/${throwawayId}/files/content`, { path: "mycredentials.txt", content: "x" }],
    ["POST", `/api/projects/${throwawayId}/files`, { path: ".env", type: "file" }],
    ["POST", `/api/projects/${throwawayId}/files`, { path: "node_modules/evil.js", type: "file" }],
    ["POST", `/api/projects/${throwawayId}/files`, { path: ".git/config", type: "file" }],
  ]) {
    const attempt = await call(method, urlPath, body);
    assert.equal(attempt.status, 403, `${method} ${body.path} -> ${attempt.status} ${JSON.stringify(attempt.data)}`);
  }
  const envGone = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent(".env")}`);
  assert.equal(envGone.status, 403, JSON.stringify(envGone.data));
  ok("protected paths rejected (.env, .env.*, *.pem, *credentials*, node_modules, .git -> 403)");

  // (7) Conflict detection via expectedMtime.
  await call("POST", `/api/projects/${throwawayId}/files`, { path: "conflict.txt", type: "file" });
  await call("PUT", `/api/projects/${throwawayId}/files/content`, { path: "conflict.txt", content: "v1" });
  const current = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("conflict.txt")}`);
  assert.equal(current.status, 200);
  const stale = await call("PUT", `/api/projects/${throwawayId}/files/content`, {
    path: "conflict.txt",
    content: "v2-stale",
    expectedMtime: current.data.mtimeMs - 60_000,
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.error, "conflict");
  assert.equal(typeof stale.data.mtime, "string");
  const fresh = await call("PUT", `/api/projects/${throwawayId}/files/content`, {
    path: "conflict.txt",
    content: "v2",
    expectedMtime: current.data.mtimeMs,
  });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  const reread = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("conflict.txt")}`);
  assert.equal(reread.data.content, "v2");
  await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "conflict.txt" });
  ok("conflict detection works (stale expectedMtime -> 409 {error: conflict, mtime}; fresh write succeeds)");

  // (8) Writes emit a files_modified event visible via the session endpoint.
  await call("POST", `/api/projects/${throwawayId}/files`, { path: "event-test.txt", type: "file" });
  await call("PUT", `/api/projects/${throwawayId}/files/content`, { path: "event-test.txt", content: "event" });
  const session = await call("GET", `/api/projects/${throwawayId}/session`);
  assert.equal(session.status, 200, JSON.stringify(session.data));
  const modified = session.data.events.filter((event) => event.type === "files_modified");
  assert.ok(modified.length > 0, "no files_modified event found");
  assert.ok(
    modified.some((event) => Array.isArray(event.payload?.files) && event.payload.files.includes("event-test.txt")),
    `files_modified payloads did not include event-test.txt: ${JSON.stringify(modified.map((e) => e.payload))}`,
  );
  await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "event-test.txt" });
  ok("write emits a files_modified event visible via GET /api/projects/:id/session");

  // Bonus: rename + directory create/delete round-trip.
  await call("POST", `/api/projects/${throwawayId}/files`, { path: "docs", type: "dir" });
  await call("POST", `/api/projects/${throwawayId}/files`, { path: "docs/old.txt", type: "file" });
  const renamed = await call("PATCH", `/api/projects/${throwawayId}/files/rename`, { from: "docs/old.txt", to: "docs/new.txt" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  const renamedRead = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("docs/new.txt")}`);
  assert.equal(renamedRead.status, 200);
  const clash = await call("PATCH", `/api/projects/${throwawayId}/files/rename`, { from: "docs/new.txt", to: "docs/new.txt" });
  assert.equal(clash.status, 400, JSON.stringify(clash.data));
  const nonEmpty = await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "docs" });
  assert.equal(nonEmpty.status, 409, JSON.stringify(nonEmpty.data));
  const recursive = await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "docs", recursive: true });
  assert.equal(recursive.status, 200, JSON.stringify(recursive.data));
  ok("rename + directory create/delete round-trip (incl. non-empty guard 409, recursive delete)");

  // Bonus: binary content is rejected with 415.
  await call("POST", `/api/projects/${throwawayId}/files`, { path: "pic.png", type: "file" });
  const binary = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("pic.png")}`);
  assert.equal(binary.status, 415, JSON.stringify(binary.data));
  await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "pic.png" });
  ok("binary extension rejected with 415");

  console.log(`phase3 file API checks passed (${passed} checks; throwaway project ${throwawayId} left in place, empty)`);
} finally {
  // Clean up any leftovers in the throwaway workspace (best effort), then
  // revoke the test session and prove it no longer works.
  if (throwawayId) {
    await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "phase3a-test.txt" }).catch(() => undefined);
    await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "conflict.txt" }).catch(() => undefined);
    await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "event-test.txt" }).catch(() => undefined);
    await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "secret.txt" }).catch(() => undefined);
    await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "docs", recursive: true }).catch(() => undefined);
    await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "pic.png" }).catch(() => undefined);
    await rm(path.join(throwawayWorkspace(), "link-to-etc"), { force: true }).catch(() => undefined);
    await rm(path.join(throwawayWorkspace(), "link-to-other"), { force: true }).catch(() => undefined);
  }
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").run(new Date().toISOString(), tokenHash);
  const revoked = await fetch(`${api}/api/projects/${PHASE2_ID}/files`, { headers: { cookie: `omp_builder_session=${token}` } });
  assert.equal(revoked.status, 401, "revoked test session still accepted");
  db.close();
  console.log("test session revoked");
}
