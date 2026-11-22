import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const temp = await mkdtemp(path.join(os.tmpdir(), "omp-builder-security-"));
const port = 8900 + Math.floor(Math.random() * 500);
const secret = "masked-secret-value";
const allowedOrigin = "http://new-lovable.localhost:33295";
const changedOrigin = "http://new-lovable.localhost:45025";
const env = { ...process.env, API_HOST: "127.0.0.1", API_PORT: String(port), WEB_ORIGINS: "http://localhost:5173", DEV_DYNAMIC_FORWARD_ORIGIN: "true", DATABASE_PATH: path.join(temp, "app.db"), PROJECTS_ROOT: path.join(temp, "projects"), OMP_SESSION_ROOT: path.join(temp, "sessions"), OMP_CONFIG_DIR: path.join(temp, "config"), OMP_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), OMP_BIN: "/usr/local/bin/omp" };
new Database(env.DATABASE_PATH).close();
// A regular file cannot be a staging root: deterministic runtime preparation failure.
env.PREVIEW_ROOT = path.join(temp, "unusable-preview-root");
await writeFile(env.PREVIEW_ROOT, "fixture");
const missingEnv = { ...env, API_PORT: String(port + 2), DATABASE_PATH: path.join(temp, "missing", "app.db") };
const missing = spawn(process.execPath, [path.join(root, "apps/api/dist/server.js")], { cwd: "/tmp", env: missingEnv, stdio: ["ignore", "pipe", "pipe"] });
let missingError = "";
missing.stderr.on("data", (chunk) => { missingError += chunk.toString(); });
assert.notEqual(await new Promise((resolve) => missing.once("exit", resolve)), 0);
assert.match(missingError, /DATABASE_PATH does not exist/);
const child = spawn(process.execPath, [path.join(root, "apps/api/dist/server.js")], { cwd: "/tmp", env, stdio: ["ignore", "pipe", "pipe"] });
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch { /* process is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "API did not become ready");
  const trustedStatus = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { headers: { Origin: allowedOrigin } });
  assert.equal(trustedStatus.status, 200);
  assert.equal(trustedStatus.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal(trustedStatus.headers.get("access-control-allow-credentials"), "true");
  const changedPortStatus = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { headers: { Origin: changedOrigin } });
  assert.equal(changedPortStatus.status, 200);
  assert.equal(changedPortStatus.headers.get("access-control-allow-origin"), changedOrigin);
  const freshDatabaseStatus = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { headers: { Origin: allowedOrigin } });
  assert.equal((await freshDatabaseStatus.json()).setupRequired, true);
  const seededPath = path.join(temp, "seeded.db");
  const seeded = new Database(seededPath);
  seeded.exec("CREATE TABLE admins (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL)");
  seeded.prepare("INSERT INTO admins VALUES (?, ?, ?, ?, ?)").run("admin-id", "existing@example.com", "hash", "salt", new Date().toISOString());
  seeded.close();
  const seededEnv = { ...env, API_PORT: String(port + 3), DATABASE_PATH: seededPath };
  const seededChild = spawn(process.execPath, [path.join(root, "apps/api/dist/server.js")], { cwd: "/tmp", env: seededEnv, stdio: ["ignore", "pipe", "pipe"] });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port + 3}/api/health`)).ok) break; } catch { /* process is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const seededStatus = await fetch(`http://127.0.0.1:${port + 3}/api/auth/status`, { headers: { Origin: allowedOrigin } });
  assert.equal((await seededStatus.json()).setupRequired, false);
  seededChild.kill("SIGKILL");
  const productionEnv = { ...env, APP_ENV: "production", API_PORT: String(port + 1) };
  const production = spawn(process.execPath, [path.join(root, "apps/api/dist/server.js")], { cwd: "/tmp", env: productionEnv, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const productionStatus = await fetch(`http://127.0.0.1:${port + 1}/api/auth/status`, { headers: { Origin: allowedOrigin } });
  assert.equal(productionStatus.status, 403);
  production.kill("SIGKILL");
  const rejectedOrigin = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { headers: { Origin: "http://evil.example" } });
  assert.equal(rejectedOrigin.status, 403);
  const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, { method: "POST", headers: { Origin: allowedOrigin, "content-type": "application/json" }, body: JSON.stringify({ email: "security@example.com", password: "correct horse battery staple" }) });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get("set-cookie").split(";", 1)[0];
  const headers = { cookie, Origin: allowedOrigin, "content-type": "application/json" };
  async function createDiagnosticProject(name) {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name, prompt: "Disposable diagnostic test" }) });
    assert.equal(response.status, 201);
    return (await response.json()).project.id;
  }
  const firstProject = await createDiagnosticProject("A4 diagnostic fixture");
  const secondProject = await createDiagnosticProject("A4 isolation fixture");
  const previewUrl = (project, route) => `http://127.0.0.1:${port}/api/projects/${project}/preview/${route}`;
  assert.equal((await fetch(previewUrl(firstProject, "problems"))).status, 401);
  const failedPreview = await fetch(previewUrl(firstProject, "start"), { method: "POST", headers });
  assert.equal(failedPreview.status, 500);
  assert.doesNotMatch(await failedPreview.text(), /unusable-preview-root|\/tmp/);
  const firstProblems = await (await fetch(previewUrl(firstProject, "problems"), { headers })).json();
  const secondProblems = await (await fetch(previewUrl(secondProject, "problems"), { headers })).json();
  assert.equal(firstProblems.phase, "failed");
  assert.equal(firstProblems.problems[0].kind, "runtime");
  assert.doesNotMatch(JSON.stringify(firstProblems), /unusable-preview-root|\/tmp/);
  assert.equal(secondProblems.runId, null);
  assert.deepEqual(secondProblems.problems, []);
  await fetch(previewUrl(firstProject, "restart"), { method: "POST", headers });
  const restartedProblems = await (await fetch(previewUrl(firstProject, "problems"), { headers })).json();
  assert.notEqual(restartedProblems.runId, firstProblems.runId);
  const rejected = await fetch(`http://127.0.0.1:${port}/api/providers`, { method: "POST", headers, body: JSON.stringify({ providerId: "private", baseUrl: "http://10.0.0.1/v1", api: "openai-completions", modelId: "model", displayName: "Private", apiKey: "do-not-store-in-plaintext" }) });
  assert.equal(rejected.status, 500);
  const local = await fetch(`http://127.0.0.1:${port}/api/providers`, { method: "POST", headers, body: JSON.stringify({ providerId: "local", baseUrl: "http://localhost:11434/v1", api: "openai-completions", modelId: "model", displayName: "Local", apiKey: secret }) });
  assert.equal(local.status, 201);
  const created = await local.json();
  assert.equal(created.provider.hasApiKey, true);
  assert.equal(JSON.stringify(created).includes(secret), false);
  assert.equal(JSON.stringify(created).includes("key_ciphertext"), false);
  const providerId = created.provider.id;
  const updated = await fetch(`http://127.0.0.1:${port}/api/providers/${providerId}`, { method: "PATCH", headers, body: JSON.stringify({ modelId: "updated-model", api: "openai-responses" }) });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.provider.modelId, "updated-model");
  assert.equal(updatedBody.provider.api, "openai-responses");
  assert.equal(JSON.stringify(updatedBody).includes(secret), false);
  const listed = await fetch(`http://127.0.0.1:${port}/api/providers`, { headers });
  assert.equal((await listed.json()).providers.length, 1);
  const config = await readFile(path.join(temp, "config", "models.yml"), "utf8").catch(() => "");
  assert.equal(config.includes(secret), false);
  assert.match(config, /OMP_BUILDER_KEY_/);
  const deleted = await fetch(`http://127.0.0.1:${port}/api/providers/${providerId}`, { method: "DELETE", headers });
  assert.equal(deleted.status, 200);
  assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/providers`, { headers })).json()).providers, []);
  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/providers`, { headers: { Origin: allowedOrigin } });
  assert.equal(unauthenticated.status, 401);
  const logout = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, { method: "POST", headers });
  assert.equal(logout.status, 200);
  const revoked = await fetch(`http://127.0.0.1:${port}/api/providers`, { headers });
  assert.equal(revoked.status, 401);
  console.log("provider security and lifecycle regression checks passed");
} finally {
  child.kill("SIGKILL");
  await rm(temp, { recursive: true, force: true });
}
