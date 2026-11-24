// Milestone D (B5) tests — run on the VPS against the built repo:
//   npm run test:milestone-d-b5   (full build first, then this file)
//   node tests/milestone-d-github-import.mjs
// Part 1: github-import module unit checks (built dist/github-import.js
//   + dist/shared via the re-exported parser):
//   URL validation (valid forms; non-github host, SSH, file://, userinfo
//   / token, query/fragment, extra segments, malformed, encoded tricks),
//   secret-bearing path test, size cap, secret scan + rules-file report
//   on a fixture tree, clone timeout path.
// Part 2: throwaway API — POST /api/projects/import end to end against
//   a real tiny public repo (octocat/Hello-World): 401 guard, 400s for
//   invalid URLs, 404 for a missing/private repo, 201 with a full
//   import result, preserved .git (HEAD + no origin remote), baseline
//   checkpoint row in the DB, versions endpoint, file tree + file edit,
//   name-conflict 409 (same name, different case), cleanup via DELETE.
// Part 3: static checks on the built bundles (route + Import UI).
// No live projects touched; the live API is never used.

import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const execFileAsync = promisify(execFile);

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Part 1: URL validation + scan/size helpers ----------
{
  const {
    parseGitHubRepoUrl,
    isSecretBearingPath,
    workspaceSizeBytes,
    scanImportedWorkspace,
    clonePublicRepo,
    MAX_IMPORT_BYTES,
    CLONE_TIMEOUT_MS,
  } = await import("../apps/api/dist/github-import.js");

  assert.equal(MAX_IMPORT_BYTES, 500 * 1024 * 1024);
  assert.equal(CLONE_TIMEOUT_MS, 120_000);

  for (const [raw, owner, repo] of [
    ["https://github.com/octocat/Hello-World", "octocat", "Hello-World"],
    ["https://github.com/octocat/Hello-World.git", "octocat", "Hello-World"],
    ["https://github.com/octocat/Hello-World/", "octocat", "Hello-World"],
    ["https://github.com/octocat/Hello-World.git/", "octocat", "Hello-World"],
    ["https://GITHUB.COM/Owner-1/repo.name_2", "Owner-1", "repo.name_2"],
    ["  https://github.com/octocat/Hello-World  ", "octocat", "Hello-World"],
  ]) {
    const ref = parseGitHubRepoUrl(raw);
    assert.equal(ref.owner, owner, raw);
    assert.equal(ref.repo, repo, raw);
    assert.equal(ref.sourceUrl, `https://github.com/${owner}/${repo}`, raw);
    assert.equal(ref.cloneUrl, `https://github.com/${owner}/${repo}.git`, raw);
  }
  ok(
    "URL validation: plain, .git, trailing slash, uppercase host, trimmed input all parse",
  );

  const bad = [
    ["http URL", "http://github.com/octocat/Hello-World", /Only https/],
    ["SSH URL", "git@github.com:octocat/Hello-World.git", /not a valid URL/],
    [
      "SSH protocol",
      "ssh://git@github.com/octocat/Hello-World.git",
      /Only https/,
    ],
    ["file URL", "file:///etc/passwd", /Only https/],
    ["local path", "/home/user/repo", /not a valid URL/],
    [
      "other host",
      "https://gitlab.com/octocat/Hello-World",
      /Only github\.com/,
    ],
    [
      "www host",
      "https://www.github.com/octocat/Hello-World",
      /Only github\.com/,
    ],
    [
      "subdomain",
      "https://api.github.com/octocat/Hello-World",
      /Only github\.com/,
    ],
    [
      "userinfo",
      "https://user:token123@github.com/octocat/Hello-World",
      /username, password or token/,
    ],
    [
      "user only",
      "https://user@github.com/octocat/Hello-World",
      /username, password or token/,
    ],
    [
      "query token",
      "https://github.com/octocat/Hello-World?token=abc",
      /query string or fragment/,
    ],
    [
      "fragment",
      "https://github.com/octocat/Hello-World#readme",
      /query string or fragment/,
    ],
    ["owner only", "https://github.com/octocat", /repository form/],
    ["bare host", "https://github.com", /repository form/],
    [
      "extra segment",
      "https://github.com/octocat/Hello-World/issues",
      /repository form/,
    ],
    [
      "tree path",
      "https://github.com/octocat/Hello-World/tree/main",
      /repository form/,
    ],
    [
      "encoded dot-dot",
      "https://github.com/%2e%2e/Hello-World",
      /repository form|Invalid/,
    ],
    [
      "encoded slash",
      "https://github.com/octocat/Hello%2fWorld",
      /Invalid repository name/,
    ],
    ["empty", "", /Enter a GitHub repository URL/],
    ["whitespace", "   ", /Enter a GitHub repository URL/],
    [
      "spaces inside",
      "https://github.com/octocat/Hello World",
      /spaces or control/,
    ],
    ["non-string", 42, /Enter a GitHub repository URL/],
  ];
  for (const [label, raw, pattern] of bad) {
    assert.throws(
      () => parseGitHubRepoUrl(raw),
      pattern,
      `${label} was not rejected: ${JSON.stringify(raw)}`,
    );
  }
  ok(
    "URL validation: http/SSH/file/local-path/other-host/userinfo/query/fragment/extra-segments/encoded-tricks all rejected with clear errors",
  );

  for (const p of [
    ".env",
    ".env.local",
    ".env.example",
    ".env.example.bak",
    "a/.env.production",
    "certs/server.pem",
    "keys/id_rsa.key",
    "src/credentials.json",
    "src/my-credentials-store.ts",
    ".ENV",
    "a/b/CREDENTIALS.txt",
  ]) {
    assert.equal(isSecretBearingPath(p), true, `${p} must be secret-bearing`);
  }
  for (const p of [
    "src/index.ts",
    "src/secrets.ts",
    "README.md",
    "AGENTS.md",
    ".omp/RULES.md",
    "docs/guide.md",
    "src/notes.txt",
  ]) {
    assert.equal(
      isSecretBearingPath(p),
      false,
      `${p} must NOT be secret-bearing`,
    );
  }
  ok(
    "secret-bearing path test: .env/.pem/.key/*credentials* flagged; plain names (incl. secrets.ts, .omp/RULES.md) kept",
  );

  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "omp-builder-milestone-d-b5-fixture-"),
  );
  try {
    await writeFile(path.join(fixture, "small.txt"), "x".repeat(100), "utf8");
    const under = await workspaceSizeBytes(fixture, 10_000);
    assert.equal(under.overLimit, false);
    assert.ok(under.sizeBytes >= 100, `size ${under.sizeBytes}`);
    const over = await workspaceSizeBytes(fixture, 50);
    assert.equal(over.overLimit, true);
    assert.ok(over.sizeBytes >= 100);
    ok(
      "size check: under-limit passes, over-limit aborts (tested with a small cap)",
    );

    for (const [rel, content] of [
      ["AGENTS.md", "# Agent notes\n"],
      ["CLAUDE.md", "# Claude notes\n"],
      [".omp/RULES.md", "Prefer semantic HTML.\n"],
      [".env", "API_KEY=hunter2\n"],
      [".env.local", "TOKEN=x\n"],
      ["certs/key.pem", "-----BEGIN PRIVATE KEY-----\n"],
      ["src/app.ts", "export const x = 1;\n"],
      ["data/credentials.json", '{"k":"v"}'],
      ["docs/guide.md", "# Guide\n"],
    ]) {
      const target = path.join(fixture, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    const scanned = await scanImportedWorkspace(fixture);
    assert.deepEqual(scanned.excludedSecrets.sort(), [
      ".env",
      ".env.local",
      "certs/key.pem",
      "data/credentials.json",
    ]);
    assert.deepEqual(scanned.rulesFiles.map((entry) => entry.path).sort(), [
      ".omp/RULES.md",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    assert.ok(scanned.files.includes("src/app.ts"));
    assert.ok(scanned.files.includes("docs/guide.md"));
    assert.ok(scanned.files.includes("AGENTS.md"));
    assert.ok(!scanned.files.includes(".env"));
    await assert.rejects(
      stat(path.join(fixture, ".env")),
      /ENOENT/,
      ".env must be deleted from the workspace",
    );
    await assert.rejects(
      stat(path.join(fixture, "data/credentials.json")),
      /ENOENT/,
    );
    assert.equal(
      await readFile(path.join(fixture, "src/app.ts"), "utf8"),
      "export const x = 1;\n",
    );
    assert.equal(
      await readFile(path.join(fixture, ".omp/RULES.md"), "utf8"),
      "Prefer semantic HTML.\n",
    );
    ok(
      "secret scan: .env/.env.local/*.pem/*credentials* deleted and reported; AGENTS.md/CLAUDE.md/.omp/RULES.md reported; other files kept",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }

  // Timeout path: a real clone with a 1ms budget must fail as a timeout,
  // proving the clone timeout is enforced (the allow-list blocks slow
  // non-GitHub hosts, so no other timeout trigger exists).
  const timeoutDir = await mkdtemp(
    path.join(os.tmpdir(), "omp-builder-milestone-d-b5-timeout-"),
  );
  try {
    const target = path.join(timeoutDir, "clone");
    await mkdir(target, { recursive: true });
    const ref = parseGitHubRepoUrl("https://github.com/octocat/Hello-World");
    await assert.rejects(
      clonePublicRepo(ref, target, 1),
      (error) => error.status === 504 && /timed out/i.test(error.message),
      "1ms clone must reject with a 504 timeout",
    );
    ok("clone timeout: 1ms budget rejects with 504 'timed out'");
  } finally {
    await rm(timeoutDir, { recursive: true, force: true });
  }
}

// ---------- Part 2: throwaway API — real import end to end ----------
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
    path.join(os.tmpdir(), "omp-builder-milestone-d-b5-api-"),
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
      cookie: `omp_builder_session=${encodeURIComponent(token)}`,
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
    const db = new Database(path.join(temp, "app.db"));

    const noAuth = await call(
      "POST",
      "/api/projects/import",
      { name: "x", url: "https://github.com/octocat/Hello-World" },
      false,
    );
    assert.equal(noAuth.status, 401, "import without a session must be 401");
    ok("guard: unauthenticated import is 401");

    for (const [label, url] of [
      ["SSH URL", "git@github.com:octocat/Hello-World.git"],
      ["other host", "https://gitlab.com/octocat/Hello-World"],
      ["userinfo", "https://user:token123@github.com/octocat/Hello-World"],
      ["query token", "https://github.com/octocat/Hello-World?token=abc"],
      ["extra segment", "https://github.com/octocat/Hello-World/issues"],
      ["owner only", "https://github.com/octocat"],
    ]) {
      const rejected = await call("POST", "/api/projects/import", {
        name: `Bad ${label}`,
        url,
      });
      assert.equal(
        rejected.status,
        400,
        `${label}: expected 400, got ${rejected.status} ${JSON.stringify(rejected.data)}`,
      );
      assert.ok(
        typeof rejected.data?.error === "string" &&
          rejected.data.error.length > 10,
        `${label}: error message must be clear`,
      );
    }
    ok(
      "invalid URLs rejected via the API with 400 + clear error (SSH, other host, userinfo, query token, extra segment, owner-only)",
    );

    const missing = await call("POST", "/api/projects/import", {
      name: "B5 Missing Repo",
      url: "https://github.com/octocat/this-repo-does-not-exist-xyz-123",
    });
    assert.equal(
      missing.status,
      404,
      `missing repo: expected 404, got ${missing.status} ${JSON.stringify(missing.data)}`,
    );
    assert.match(missing.data.error, /not found or is private/i);
    ok("missing repo: 404 'not found or is private' (no hang, no stack trace)");

    const name = `B5 Import Test ${Date.now()}`;
    const imported = await call("POST", "/api/projects/import", {
      name,
      url: "https://github.com/octocat/Hello-World",
    });
    assert.equal(imported.status, 201, JSON.stringify(imported.data));
    const projectId = imported.data.project.id;
    const result = imported.data.import;
    assert.equal(result.owner, "octocat");
    assert.equal(result.repo, "Hello-World");
    assert.equal(result.sourceUrl, "https://github.com/octocat/Hello-World");
    assert.match(result.headOid, /^[0-9a-f]{40}$/);
    assert.ok(
      result.filesImported >= 1,
      `filesImported ${result.filesImported}`,
    );
    assert.equal(result.shallow, true);
    assert.equal(result.remoteRemoved, true);
    assert.ok(result.sizeBytes > 0 && result.sizeBytes <= 500 * 1024 * 1024);
    assert.equal(result.sizeLimitBytes, 500 * 1024 * 1024);
    assert.deepEqual(result.excludedSecrets, []);
    assert.deepEqual(result.rulesFiles, []);
    assert.equal(
      imported.data.project.prompt,
      "Imported from https://github.com/octocat/Hello-World",
    );
    ok(
      "real import: 201 with full import result (owner/repo/HEAD/files/shallow/remote-removed/size, no secrets, no rules files)",
    );

    const workspace = path.join(temp, "projects", projectId);
    await access(path.join(workspace, ".git"));
    assert.ok(
      (await readFile(path.join(workspace, "README"), "utf8")).includes(
        "Hello World",
      ),
      "cloned README must be present",
    );
    const { stdout: remoteOut } = await execFileAsync("git", [
      "-C",
      workspace,
      "remote",
      "-v",
    ]);
    assert.equal(
      remoteOut.trim(),
      "",
      "origin remote must be removed after clone",
    );
    const { stdout: headOut } = await execFileAsync("git", [
      "-C",
      workspace,
      "rev-parse",
      "HEAD",
    ]);
    assert.equal(
      headOut.trim(),
      result.headOid,
      "workspace HEAD must equal the reported headOid",
    );
    const { stdout: hooksOut } = await execFileAsync("git", [
      "-C",
      workspace,
      "config",
      "--get",
      "core.hooksPath",
    ]);
    assert.equal(
      hooksOut.trim(),
      "/dev/null",
      "cloned repo must have hooks disabled",
    );
    ok(
      "preserved .git: README present, HEAD matches, origin removed, hooks disabled",
    );

    const checkpointRow = db
      .prepare(
        "SELECT oid, session_id, message FROM checkpoints WHERE project_id = ?",
      )
      .get(projectId);
    assert.ok(checkpointRow, "a checkpoints DB row must exist for the import");
    assert.equal(checkpointRow.oid, result.headOid);
    assert.equal(checkpointRow.session_id, "baseline");
    assert.match(
      checkpointRow.message,
      /Imported from https:\/\/github\.com\/octocat\/Hello-World/,
    );
    ok(
      "baseline checkpoint: DB row points at the cloned HEAD (session baseline, import message)",
    );

    const versions = await call("GET", `/api/projects/${projectId}/versions`);
    assert.equal(versions.status, 200, JSON.stringify(versions.data));
    assert.equal(versions.data.status.initialized, true);
    assert.equal(versions.data.status.head, result.headOid);
    ok("versions endpoint: repo initialized, head is the cloned HEAD");

    const tree = await call("GET", `/api/projects/${projectId}/files`);
    assert.equal(tree.status, 200, JSON.stringify(tree.data));
    const treeText = JSON.stringify(tree.data);
    assert.ok(
      treeText.includes("README"),
      "file tree must list the cloned README",
    );
    ok("file explorer lists the cloned files");

    const written = await call(
      "PUT",
      `/api/projects/${projectId}/files/content`,
      {
        path: "b5-edit-check.txt",
        content: "Monaco edit path works on an imported project.\n",
      },
    );
    assert.equal(written.status, 200, JSON.stringify(written.data));
    assert.equal(
      await readFile(path.join(workspace, "b5-edit-check.txt"), "utf8"),
      "Monaco edit path works on an imported project.\n",
    );
    ok("file edit (Monaco write path) works on the imported project");

    const conflict = await call("POST", "/api/projects/import", {
      name,
      url: "https://github.com/octocat/Hello-World",
    });
    assert.equal(
      conflict.status,
      409,
      `same name: expected 409, got ${conflict.status} ${JSON.stringify(conflict.data)}`,
    );
    assert.match(conflict.data.error, /already exists/i);
    const conflictCase = await call("POST", "/api/projects/import", {
      name: name.toLowerCase(),
      url: "https://github.com/octocat/Hello-World",
    });
    assert.equal(
      conflictCase.status,
      409,
      "same name in different case must also be 409",
    );
    const otherName = await call("POST", "/api/projects/import", {
      name: `${name} again`,
      url: "https://github.com/octocat/Hello-World",
    });
    assert.equal(
      otherName.status,
      201,
      `different name, same repo must succeed: ${JSON.stringify(otherName.data)}`,
    );
    const secondId = otherName.data.project.id;
    ok(
      "name conflict: same name 409, different case 409, different name succeeds (no silent rename)",
    );

    const listed = await call("GET", "/api/projects");
    assert.equal(listed.status, 200);
    assert.ok(
      listed.data.projects.some((entry) => entry.id === projectId),
      "imported project must be listed",
    );
    ok("imported project appears in the project list");

    for (const id of [projectId, secondId]) {
      const deleted = await call("DELETE", `/api/projects/${id}`);
      assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
      assert.equal(
        deleted.data.workspaceRemoved,
        true,
        `workspace for ${id} must be removed`,
      );
    }
    await assert.rejects(stat(workspace), /ENOENT/);
    ok(
      "cleanup: both imported projects deleted via the API, workspaces removed",
    );
    db.close();
  } finally {
    child.kill("SIGTERM");
    await rm(temp, { recursive: true, force: true });
  }
}

// ---------- Part 3: static checks on the built bundles ----------
{
  const serverBundle = await readFile(
    path.join(root, "apps/api/dist/server.js"),
    "utf8",
  );
  assert.ok(
    serverBundle.includes("/api/projects/import"),
    "built API must contain the import route",
  );
  assert.ok(
    serverBundle.includes("github-import"),
    "built API must reference the github-import module",
  );
  const webDir = path.join(root, "apps/web/dist/assets");
  const webFiles = (await readdir(webDir)).filter((entry) =>
    entry.endsWith(".js"),
  );
  assert.ok(webFiles.length > 0, "built web bundle must exist");
  let webBundle = "";
  for (const entry of webFiles)
    webBundle += await readFile(path.join(webDir, entry), "utf8");
  assert.ok(
    webBundle.includes("Import from Git"),
    "built web bundle must contain the Import from Git mode",
  );
  assert.ok(
    webBundle.includes("Import repository"),
    "built web bundle must contain the Import repository button",
  );
  assert.ok(
    webBundle.includes("https://github.com/octocat/Hello-World"),
    "built web bundle must contain the repo URL placeholder",
  );
  assert.ok(
    !webBundle.includes("Git import arrives in Phase 4"),
    "built web bundle must not still say Git import arrives in Phase 4",
  );
  ok(
    "static checks: import route + Import UI present in the built bundles; Phase 4 placeholder gone",
  );
}

console.log(`\nPASS: ${passed} checks`);
