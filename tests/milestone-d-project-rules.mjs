import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Milestone D (B6) tests - run on the VPS against the built repo:
//   npm run test:milestone-d-b6   (full build first, then this file)
//   node tests/milestone-d-project-rules.mjs
// Part 1: rules module unit checks (built dist/rules.js + dist/git.js):
//   validation (NUL / oversize / credential-pattern / @-import rejection;
//   prose and in-workspace imports allowed), atomic write with mode 0600,
//   empty deletes the file, deny-list exception for .omp/RULES.md.
// Part 2: throwaway API: GET/PUT /rules round-trip, validation via HTTP
//   (400s), 401/404 guards, the file API still 403s .omp, rules committed
//   by the checkpoint flow, restore returns the checkpointed rules.
// Part 3: static checks on the built bundles (spawn args, Rules UI).
// No live projects touched; the live API is never used. The real-OMP
// acceptance (Test 2 verbatim: a fresh OMP turn honors .omp/RULES.md,
// and the Test 1 prompt-prefix regression) lives in
// tests/milestone-d-project-rules-browser.mjs, which runs against the
// live API with a real provider.

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Part 1: rules module + deny-list exception ----------
{
  const {
    validateRulesContent,
    readProjectRules,
    writeProjectRules,
    MAX_RULES_CHARS,
  } = await import("../apps/api/dist/rules.js");
  const { isDeniedCheckpointPath } = await import("../apps/api/dist/git.js");

  assert.equal(MAX_RULES_CHARS, 20_000);
  for (const good of [
    "Use TypeScript strict mode.",
    "Never commit secrets to the repo.",
    "Ask @david before changing the pricing page.",
    "Follow @docs/style.md for class names.",
    "",
    "Always start every HTML file with the exact first line <!-- RULE-FILE-TEST -->.",
  ]) {
    assert.equal(
      validateRulesContent(good),
      good,
      `valid rules rejected: ${JSON.stringify(good)}`,
    );
  }
  ok("validation: prose, @mentions and in-workspace @imports are allowed");
  const bad = [
    ["NUL byte", "bad\0byte"],
    ["oversize", "x".repeat(20_001)],
    ["api_key assignment", "api_key: abc123"],
    ["password assignment", "password= hunter2"],
    ["token assignment", "token: abc"],
    ["secret assignment", "my secret: hunter2"],
    ["sk- token", "use sk-abcdefgh12345678 here"],
    ["PEM private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."],
    ["absolute @ import", "See @/etc/passwd for details"],
    ["home @ import", "See @~/keys/id_rsa"],
    ["parent @ import", "See @../shared.md"],
    ["URL @ import", "See @https://example.com/rules.md"],
  ];
  for (const [label, content] of bad) {
    assert.throws(
      () => validateRulesContent(content),
      /Rules must not|too long|NUL/,
      `${label} was not rejected`,
    );
  }
  assert.throws(() => validateRulesContent(42), /must be a string/);
  ok(
    "validation: NUL, oversize, credential patterns and outside-workspace @ imports are rejected",
  );

  assert.equal(
    isDeniedCheckpointPath(".omp/RULES.md"),
    false,
    ".omp/RULES.md must be checkpoint-allowed",
  );
  assert.equal(isDeniedCheckpointPath(".omp/other.md"), true);
  assert.equal(
    isDeniedCheckpointPath(".omp/RULES.md.bak"),
    true,
    "only the exact rules path is allowed",
  );
  assert.equal(isDeniedCheckpointPath(".omp"), true);
  assert.equal(isDeniedCheckpointPath("src/index.html"), false);
  assert.equal(isDeniedCheckpointPath(".env"), true);
  ok("deny-list: .omp/RULES.md is the single allowed .omp path");

  const temp = await mkdtemp(
    path.join(os.tmpdir(), "omp-builder-milestone-d-rules-"),
  );
  try {
    const written = await writeProjectRules(
      temp,
      "Rule one.\nPrefer semantic HTML.\n",
    );
    assert.deepEqual(written, {
      content: "Rule one.\nPrefer semantic HTML.\n",
      deleted: false,
    });
    const rulesPath = path.join(temp, ".omp", "RULES.md");
    assert.equal(
      await readFile(rulesPath, "utf8"),
      "Rule one.\nPrefer semantic HTML.\n",
    );
    assert.equal(
      (await stat(rulesPath)).mode & 0o777,
      0o600,
      "rules file must be mode 0600",
    );
    const read = await readProjectRules(temp);
    assert.deepEqual(read, {
      content: "Rule one.\nPrefer semantic HTML.\n",
      exists: true,
      hasRootAgentsMd: false,
    });
    ok("write/read round-trip: file written with mode 0600, read back exactly");
    await writeFile(path.join(temp, "AGENTS.md"), "# Project notes\n", "utf8");
    assert.equal((await readProjectRules(temp)).hasRootAgentsMd, true);
    ok("read: pre-existing root AGENTS.md is flagged (OMP will load it too)");
    const deleted = await writeProjectRules(temp, "   \n");
    assert.deepEqual(deleted, { content: "", deleted: true });
    assert.deepEqual(await readProjectRules(temp), {
      content: "",
      exists: false,
      hasRootAgentsMd: true,
    });
    await assert.rejects(stat(rulesPath), /ENOENT/);
    assert.ok(
      !(await readdir(temp)).includes(".omp"),
      ".omp dir is removed when it becomes empty",
    );
    ok("empty content deletes the rules file (and the .omp dir when empty)");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

// ---------- Part 2: throwaway API — /rules routes + checkpoint flow ----------
async function spawnThrowawayApi(temp, port, seed) {
  const env = {
    ...process.env,
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    WEB_ORIGINS: "http://localhost:5173",
    DATABASE_PATH: path.join(temp, "app.db"),
    PROJECTS_ROOT: path.join(temp, "projects"),
    OMP_SESSION_ROOT: path.join(temp, "sessions"),
    OMP_CONFIG_DIR: path.join(temp, "config"),
    OMP_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    OMP_BIN: "/usr/local/bin/omp",
    OMP_RUN_AS_USER: "false",
  };
  new Database(env.DATABASE_PATH).close();
  const seedDb = new Database(env.DATABASE_PATH);
  seed(seedDb, env);
  seedDb.close();
  const child = spawn(
    process.execPath,
    [path.join(root, "apps/api/dist/server.js")],
    { cwd: "/tmp", env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) ready = true;
      else await sleep(200);
    } catch {
      await sleep(200);
    }
  }
  assert.equal(
    ready,
    true,
    `throwaway API did not become ready: ${stderr.slice(0, 500)}`,
  );
  return { env, child, stderr };
}

{
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "omp-builder-milestone-d-rules-api-"),
  );
  const port = 8980 + Math.floor(Math.random() * 200);
  const adminId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const seed = (seedDb) => {
    seedDb.exec(`
CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, admin_id TEXT NOT NULL REFERENCES admins(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
`);
    const now = new Date().toISOString();
    seedDb
      .prepare(
        "INSERT INTO admins (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(adminId, "test@example.com", "hash", "salt", now);
    seedDb
      .prepare(
        "INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        tokenHash,
        adminId,
        new Date(Date.now() + 3600_000).toISOString(),
        now,
      );
  };
  const { child } = await spawnThrowawayApi(temp, port, seed);
  try {
    const headers = {
      cookie: `omp_builder_session=${token}`,
      "content-type": "application/json",
    };
    const call = async (method, urlPath, body, useAuth = true) => {
      const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method,
        headers: useAuth ? headers : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return { status: response.status, data };
    };
    const created = await call("POST", "/api/projects", {
      name: "Rules API test",
      prompt: "Throwaway project for the B6 rules routes.",
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const projectId = created.data.project.id;
    // The git init runs async after creation; wait for it before the checkpoint checks.
    let initialized = false;
    for (let attempt = 0; attempt < 60 && !initialized; attempt += 1) {
      const v = await call("GET", `/api/projects/${projectId}/versions`);
      if (v.status === 200 && v.data.status?.initialized) initialized = true;
      else await sleep(500);
    }
    assert.ok(initialized, "project workspace was not git-initialized");
    ok("throwaway project created via the API; workspace git-initialized");

    const noAuth = await call(
      "GET",
      `/api/projects/${projectId}/rules`,
      undefined,
      false,
    );
    assert.equal(
      noAuth.status,
      401,
      "GET /rules without a session must be 401",
    );
    const unknown = await call("GET", `/api/projects/${randomUUID()}/rules`);
    assert.equal(
      unknown.status,
      404,
      "GET /rules for an unknown project must be 404",
    );
    ok("guards: unauthenticated 401, unknown project 404");

    const empty = await call("GET", `/api/projects/${projectId}/rules`);
    assert.equal(empty.status, 200, JSON.stringify(empty.data));
    assert.deepEqual(empty.data, {
      content: "",
      exists: false,
      hasRootAgentsMd: false,
    });
    ok("GET /rules on a fresh project: empty, not exists, no root AGENTS.md");

    const RULES_V1 =
      "Always start every HTML file with the exact first line <!-- RULE-FILE-TEST -->.\nPrefer semantic HTML elements.\n";
    const saved = await call("PUT", `/api/projects/${projectId}/rules`, {
      content: RULES_V1,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.content, RULES_V1);
    assert.equal(saved.data.deleted, false);
    assert.equal(
      saved.data.sessionsRestarted,
      0,
      "no live OMP session existed, so none restarted",
    );
    assert.equal(saved.data.hasRootAgentsMd, false);
    const reread = await call("GET", `/api/projects/${projectId}/rules`);
    assert.deepEqual(reread.data, {
      content: RULES_V1,
      exists: true,
      hasRootAgentsMd: false,
    });
    ok("PUT /rules writes .omp/RULES.md; GET reads it back");

    for (const [label, content] of [
      ["credential assignment", "api_key: abc123"],
      ["outside @ import", "See @/etc/passwd"],
      ["oversize", "x".repeat(20_001)],
      ["NUL byte", "bad\0byte"],
    ]) {
      const rejected = await call("PUT", `/api/projects/${projectId}/rules`, {
        content,
      });
      assert.equal(
        rejected.status,
        400,
        `${label}: expected 400, got ${rejected.status} ${JSON.stringify(rejected.data)}`,
      );
    }
    const wrongType = await call("PUT", `/api/projects/${projectId}/rules`, {
      content: 42,
    });
    assert.equal(wrongType.status, 400, "non-string content must be 400");
    const stillV1 = await call("GET", `/api/projects/${projectId}/rules`);
    assert.equal(
      stillV1.data.content,
      RULES_V1,
      "rejected saves must not change the stored rules",
    );
    ok(
      "PUT /rules validation: credential, @-import, oversize, NUL and non-string content all 400; stored rules unchanged",
    );

    const blockedRead = await call(
      "GET",
      `/api/projects/${projectId}/files/content?path=${encodeURIComponent(".omp/RULES.md")}`,
    );
    assert.equal(blockedRead.status, 403, "file API must still 403 .omp paths");
    const blockedWrite = await call(
      "PUT",
      `/api/projects/${projectId}/files/content`,
      { path: ".omp/RULES.md", content: "x" },
    );
    assert.equal(
      blockedWrite.status,
      403,
      "file API must still refuse writes to .omp",
    );
    ok(
      "file API still 403s .omp/RULES.md (rules go only through the dedicated endpoint)",
    );

    // Rules committed by the checkpoint flow: write a file, checkpoint,
    // and the checkpoint must list .omp/RULES.md.
    const filePut = await call(
      "PUT",
      `/api/projects/${projectId}/files/content`,
      {
        path: "index.html",
        content: "<!doctype html><h1>Rules checkpoint test</h1>\n",
      },
    );
    assert.equal(filePut.status, 200, JSON.stringify(filePut.data));
    const checkpoint = await call(
      "POST",
      `/api/projects/${projectId}/versions/checkpoint`,
      { message: "Rules checkpoint test" },
    );
    assert.equal(checkpoint.status, 200, JSON.stringify(checkpoint.data));
    assert.equal(
      checkpoint.data.checkpoint.created,
      true,
      JSON.stringify(checkpoint.data.checkpoint),
    );
    const oid = checkpoint.data.checkpoint.oid;
    const detail = await call(
      "GET",
      `/api/projects/${projectId}/versions/${oid}`,
    );
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    const detailPaths = (detail.data.files ?? []).map((entry) => entry.path);
    assert.ok(
      detailPaths.includes(".omp/RULES.md"),
      `checkpoint files must include .omp/RULES.md, got ${JSON.stringify(detailPaths)}`,
    );
    assert.ok(
      detailPaths.includes("index.html"),
      `checkpoint files must include index.html, got ${JSON.stringify(detailPaths)}`,
    );
    const gitignore = await call(
      "GET",
      `/api/projects/${projectId}/files/content?path=${encodeURIComponent(".gitignore")}`,
    );
    assert.equal(gitignore.status, 200, JSON.stringify(gitignore.data));
    assert.ok(
      !gitignore.data.content
        .split("\n")
        .some((line) => line.trim() === ".omp/" || line.trim() === ".omp"),
      ".gitignore must not exclude .omp",
    );
    ok(
      "checkpoint flow commits .omp/RULES.md (listed in the checkpoint files; .omp is not gitignored)",
    );

    // Restore returns the checkpointed rules: save different rules, then
    // restore the checkpoint (discarding the uncommitted rules change).
    const RULES_V2 = "Different rules, second version.\n";
    const savedV2 = await call("PUT", `/api/projects/${projectId}/rules`, {
      content: RULES_V2,
    });
    assert.equal(savedV2.status, 200, JSON.stringify(savedV2.data));
    const restored = await call(
      "POST",
      `/api/projects/${projectId}/versions/${oid}/restore`,
      { discardUncommitted: true },
    );
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const afterRestore = await call("GET", `/api/projects/${projectId}/rules`);
    assert.equal(
      afterRestore.data.content,
      RULES_V1,
      "restore must bring back the checkpointed rules",
    );
    ok("restore to the checkpoint restores the rules that produced the code");

    // Empty save deletes the file again.
    const cleared = await call("PUT", `/api/projects/${projectId}/rules`, {
      content: "",
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
    assert.equal(cleared.data.deleted, true);
    assert.deepEqual(
      await call("GET", `/api/projects/${projectId}/rules`).then((r) => r.data),
      { content: "", exists: false, hasRootAgentsMd: false },
    );
    ok("PUT empty content deletes the rules file");

    const deleted = await call("DELETE", `/api/projects/${projectId}`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    ok("throwaway project deleted");
  } finally {
    child.kill("SIGTERM");
    await rm(temp, { recursive: true, force: true });
  }
}

// ---------- Part 3: static checks on the built bundles ----------
{
  const ompRpc = await readFile(
    path.join(root, "apps/api/dist/omp-rpc.js"),
    "utf8",
  );
  const argsLine = ompRpc
    .split("\n")
    .find((line) => line.includes("const args = ["));
  assert.ok(argsLine, "spawn args line not found in built omp-rpc.js");
  assert.ok(
    !argsLine.includes("--no-rules"),
    "built spawn args must not contain --no-rules",
  );
  assert.ok(
    !argsLine.includes("--no-context-files"),
    "built spawn args must not contain --no-context-files",
  );
  assert.ok(
    argsLine.includes("--no-skills"),
    "built spawn args must keep --no-skills",
  );
  assert.ok(
    argsLine.includes("--no-extensions"),
    "built spawn args must keep --no-extensions",
  );
  ok(
    "built OMP spawn args: --no-rules/--no-context-files gone, --no-skills/--no-extensions kept",
  );

  const assetsDir = path.join(root, "apps/web/dist/assets");
  const assets = await readdir(assetsDir);
  const mainBundle = assets.find(
    (name) => name.startsWith("index-") && name.endsWith(".js"),
  );
  assert.ok(mainBundle, "web main bundle not found in dist/assets");
  const bundle = await readFile(path.join(assetsDir, mainBundle), "utf8");
  for (const needle of [
    "Project rules",
    "Save rules",
    "Remove rules",
    "/rules",
    "Always-on instructions for OMP",
  ]) {
    assert.ok(
      bundle.includes(needle),
      `web bundle is missing Rules UI string: ${JSON.stringify(needle)}`,
    );
  }
  ok(
    "built web bundle contains the Rules tab UI (editor, Save/Remove, /rules calls)",
  );
}

console.log(`\n${passed} checks passed (milestone-d-project-rules)`);
