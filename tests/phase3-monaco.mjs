import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

// Phase 3B Monaco editor tests — run against the LIVE install on the VPS:
//   node tests/phase3-monaco.mjs
// Verifies (1) monaco-editor is exactly 0.57.0, (2) on-disk dompurify is
// >= 3.4.13 with no older copy anywhere in the tree, (3) the production
// audit is clean, (4) the built bundle contains Monaco and ships only the
// patched dompurify, (5) the editor save path end-to-end via the API
// (read -> write with expectedMtime -> read back, stale write -> 409),
// (6) the extension -> Monaco language mapping.
// Requires `npm run build` to have run first (check 4 reads apps/web/dist).
// Mints a throwaway admin session (revoked at the end) and a throwaway
// project for the save-path checks.
// Env overrides: OMP_BUILDER_API, OMP_BUILDER_DB, OMP_BUILDER_ROOT.

const repoRoot = process.env.OMP_BUILDER_ROOT ?? "/opt/omp-builder";
const api = process.env.OMP_BUILDER_API ?? "http://127.0.0.1:8787";
const dbPath = process.env.OMP_BUILDER_DB ?? "/var/lib/omp-builder/data/persistent/app.db";
const ADMIN_ID = "155e3283-d271-452a-af52-e90f900cd78d";
const EXPECTED_MONACO = "0.57.0";
const MIN_DOMPURIFY = [3, 4, 13];

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

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
function parseVersion(v) {
  const parts = String(v).split(".").map(Number);
  assert.equal(parts.length, 3, `not a semver version: ${v}`);
  assert.ok(parts.every((n) => Number.isInteger(n)), `not a semver version: ${v}`);
  return parts;
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

let throwawayId = null;
try {
  // (1) Installed monaco-editor version is exactly 0.57.0.
  const webPkg = JSON.parse(readFileSync(path.join(repoRoot, "apps/web/package.json"), "utf8"));
  assert.equal(webPkg.dependencies["monaco-editor"], EXPECTED_MONACO, "apps/web/package.json must pin monaco-editor to 0.57.0");
  const monacoPkgPath = path.join(repoRoot, "node_modules/monaco-editor/package.json");
  assert.ok(existsSync(monacoPkgPath), "monaco-editor is not installed");
  const monacoPkg = JSON.parse(readFileSync(monacoPkgPath, "utf8"));
  assert.equal(monacoPkg.version, EXPECTED_MONACO, `installed monaco-editor is ${monacoPkg.version}, expected ${EXPECTED_MONACO}`);
  console.log(`monaco-editor installed: ${monacoPkg.version}`);
  ok("monaco-editor is exactly 0.57.0 (package.json pin + installed copy)");

  // (2) On-disk dompurify >= 3.4.13, and `npm ls dompurify` shows no older copy.
  const purifyPkgPath = path.join(repoRoot, "node_modules/dompurify/package.json");
  assert.ok(existsSync(purifyPkgPath), "dompurify is not installed (expected as a monaco-editor dependency)");
  const purifyPkg = JSON.parse(readFileSync(purifyPkgPath, "utf8"));
  const purifyVersion = parseVersion(purifyPkg.version);
  assert.ok(cmpVersion(purifyVersion, MIN_DOMPURIFY) >= 0, `on-disk dompurify is ${purifyPkg.version}, must be >= 3.4.13`);
  console.log(`dompurify on disk: ${purifyPkg.version}`);
  const ls = execSync("npm ls dompurify --all", { cwd: repoRoot, encoding: "utf8" });
  const listed = [...ls.matchAll(/dompurify@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(listed.length > 0, `npm ls dompurify found no copies:\n${ls}`);
  for (const version of listed) {
    assert.ok(cmpVersion(parseVersion(version), MIN_DOMPURIFY) >= 0, `npm ls shows dompurify@${version} (< 3.4.13)`);
  }
  console.log(`npm ls dompurify copies: ${[...new Set(listed)].join(", ")}`);
  ok("on-disk dompurify >= 3.4.13 and npm ls shows no older copy");

  // (3) Production audit is clean.
  let auditJson;
  try {
    const out = execSync("npm audit --omit=dev --json", { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    auditJson = JSON.parse(out);
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities are found; the JSON is
    // still on stdout.
    auditJson = JSON.parse(err.stdout?.toString() ?? "{}");
  }
  const vulnTotal = auditJson?.metadata?.vulnerabilities?.total;
  assert.equal(vulnTotal, 0, `npm audit --omit=dev reports vulnerabilities: ${JSON.stringify(auditJson?.metadata?.vulnerabilities)}`);
  ok("npm audit --omit=dev reports 0 vulnerabilities");

  // (4) The production build contains the Monaco bundle and only patched
  // DOMPurify. (Run `npm run build` before this test.)
  // NOTE: Monaco's editor core does NOT use the npm `dompurify` package at
  // runtime — it ships a vendored copy at
  // monaco-editor/esm/vs/base/browser/dompurify/dompurify.js. The version
  // that actually ships is the vendored one, so that is what is checked
  // here; the npm package (check 2) is governed by the overrides pin.
  const distDir = path.join(repoRoot, "apps/web/dist");
  const assetsDir = path.join(distDir, "assets");
  assert.ok(existsSync(assetsDir), "apps/web/dist/assets is missing — run `npm run build` first");
  const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
  assert.ok(jsFiles.length > 0, "no JS in apps/web/dist/assets");
  let bundle = "";
  for (const file of jsFiles) bundle += readFileSync(path.join(assetsDir, file), "utf8");
  assert.ok(bundle.includes("monaco"), "built bundle contains no monaco markers");
  assert.ok(/monaco\.editor|vs\/editor/.test(bundle), "built bundle contains no monaco.editor marker");
  const vendoredPath = path.join(repoRoot, "node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js");
  assert.ok(existsSync(vendoredPath), "monaco's vendored dompurify copy is missing");
  const vendoredSrc = readFileSync(vendoredPath, "utf8");
  const vendoredMatch = vendoredSrc.match(/DOMPurify (\d+\.\d+\.\d+)/) ?? vendoredSrc.match(/version = '(\d+\.\d+\.\d+)'/);
  assert.ok(vendoredMatch, "could not read the vendored dompurify version");
  const vendoredVersion = parseVersion(vendoredMatch[1]);
  assert.ok(cmpVersion(vendoredVersion, MIN_DOMPURIFY) >= 0, `vendored dompurify is ${vendoredMatch[1]}, must be >= 3.4.13`);
  console.log(`monaco's vendored dompurify: ${vendoredMatch[1]}`);
  assert.ok(
    bundle.includes(`version:"${vendoredMatch[1]}"`) || bundle.includes(`version="${vendoredMatch[1]}"`),
    `built bundle does not contain the vendored dompurify version ${vendoredMatch[1]}`,
  );
  // No vulnerable 3.4.0–3.4.12 (or 3.3.x) version string may appear as a
  // DOMPurify version assignment in the bundle.
  for (const bad of ["3.3.", "3.4.0", "3.4.1", "3.4.2", "3.4.3", "3.4.4", "3.4.5", "3.4.6", "3.4.7", "3.4.8", "3.4.9", "3.4.10", "3.4.11", "3.4.12"]) {
    assert.ok(!bundle.includes(`version:"${bad}"`) && !bundle.includes(`version="${bad}"`), `built bundle contains vulnerable dompurify ${bad}`);
  }
  console.log(`built bundle ships vendored dompurify ${vendoredMatch[1]} (npm package: ${purifyPkg.version})`);
  ok("production build contains the Monaco editor bundle with only patched dompurify (vendored + npm)");

  // (5) Editor save path end-to-end via the API.
  const created = await call("POST", "/api/projects", {
    name: `Phase 3B Test ${new Date().toISOString()}`,
    prompt: "Throwaway project for Phase 3B Monaco save-path tests. Do not delete the row.",
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  throwawayId = created.data.project.id;
  console.log(`throwaway project: ${throwawayId}`);
  const made = await call("POST", `/api/projects/${throwawayId}/files`, { path: "editor-test.ts", type: "file" });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const written = await call("PUT", `/api/projects/${throwawayId}/files/content`, {
    path: "editor-test.ts",
    content: "export const a = 1;\n",
  });
  assert.equal(written.status, 200, JSON.stringify(written.data));
  const read = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("editor-test.ts")}`);
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(read.data.content, "export const a = 1;\n");
  // Save with the fresh expectedMtime (what the editor sends on Ctrl+S).
  const saved = await call("PUT", `/api/projects/${throwawayId}/files/content`, {
    path: "editor-test.ts",
    content: "export const a = 2;\n",
    expectedMtime: read.data.mtimeMs,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const reread = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("editor-test.ts")}`);
  assert.equal(reread.data.content, "export const a = 2;\n");
  assert.equal(reread.data.mtimeMs, saved.data.mtimeMs);
  // Stale expectedMtime must conflict (409), not silently overwrite.
  const stale = await call("PUT", `/api/projects/${throwawayId}/files/content`, {
    path: "editor-test.ts",
    content: "export const a = 3;\n",
    expectedMtime: read.data.mtimeMs,
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.error, "conflict");
  const afterConflict = await call("GET", `/api/projects/${throwawayId}/files/content?path=${encodeURIComponent("editor-test.ts")}`);
  assert.equal(afterConflict.data.content, "export const a = 2;\n");
  // Overwrite without expectedMtime (the editor's "Overwrite anyway").
  const forced = await call("PUT", `/api/projects/${throwawayId}/files/content`, {
    path: "editor-test.ts",
    content: "export const a = 3;\n",
  });
  assert.equal(forced.status, 200, JSON.stringify(forced.data));
  await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "editor-test.ts" });
  ok("editor save path end-to-end (read -> save with expectedMtime -> read back; stale -> 409; overwrite anyway)");

  // (6) Extension -> Monaco language mapping, compiled from the real
  // helper with tsc and imported (no hand-copied duplicate).
  const outDir = mkdtempSync(path.join(tmpdir(), "phase3-monaco-lang-"));
  execSync(
    `node_modules/.bin/tsc apps/web/src/editor-languages.ts --outDir ${outDir} --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck`,
    { cwd: repoRoot, stdio: "pipe" },
  );
  const { languageForPath } = await import(pathToFileURL(path.join(outDir, "editor-languages.js")).href);
  const cases = [
    ["src/app.ts", "typescript"],
    ["src/App.tsx", "typescript"],
    ["src/app.js", "javascript"],
    ["src/App.jsx", "javascript"],
    ["data.json", "json"],
    ["style.css", "css"],
    ["index.html", "html"],
    ["README.md", "markdown"],
    ["script.sh", "shell"],
    ["config.yml", "yaml"],
    ["config.yaml", "yaml"],
    ["data.xml", "xml"],
    ["query.sql", "sql"],
    ["notes.txt", "plaintext"],
    ["LICENSE", "plaintext"],
    [".gitignore", "plaintext"],
    ["archive.tar.gz", "plaintext"],
  ];
  for (const [file, expected] of cases) {
    assert.equal(languageForPath(file), expected, `${file} -> ${languageForPath(file)}, expected ${expected}`);
  }
  ok("extension -> Monaco language mapping (ts/tsx/js/jsx/json/css/html/md/sh/yml/yaml/xml/sql/plaintext)");

  console.log(`phase3 Monaco checks passed (${passed} checks; throwaway project ${throwawayId} left in place, empty)`);
} finally {
  if (throwawayId) {
    await call("DELETE", `/api/projects/${throwawayId}/files`, { path: "editor-test.ts" }).catch(() => undefined);
  }
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").run(new Date().toISOString(), tokenHash);
  const revoked = await fetch(`${api}/api/projects`, { headers: { cookie: `omp_builder_session=${token}` } });
  assert.equal(revoked.status, 401, "revoked test session still accepted");
  db.close();
  console.log("test session revoked");
}
