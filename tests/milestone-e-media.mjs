// Milestone E (B7) tests - run on the VPS against the built repo:
//   npm run test:milestone-e-media   (full build first, then this file)
//   node tests/milestone-e-media.mjs
// Part 1: media module + shared sanitizer unit checks (magic bytes,
// filename sanitization, multipart parsing).
// Part 2: throwaway API: upload/list/serve/replace round-trip plus
// adversarial cases (bad type, magic mismatch, oversize, traversal
// filenames, symlink escape, non-image files in images/, 401 guards),
// the text file API still 415s binaries, and images land in Git
// checkpoints. No live projects touched; the live API is never used.
// Part 3: static checks on the built bundles + Builder source.
// Browser verification (real Chromium: upload appears in the Media
// browser, replace swaps bytes, chat attachment references @images/…
// and a real OMP turn reads the file) lives in
// tests/milestone-e-media-browser.mjs.

import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";

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

// ---------- PNG/GIF/JPEG fixtures (valid magic bytes) ----------
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
function makePng(r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Buffer.from([0, r, g, b]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG_RED = makePng(255, 0, 0);
const PNG_BLUE = makePng(0, 0, 255);
const GIF_RED = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0xff, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0x02, 0x02, 0x4c, 0x01, 0x00, 0x3b,
]);
const JPEG_MIN = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const TEXT_BYTES = Buffer.from("this is not an image at all", "utf8");

// ---------- Part 1: unit checks ----------
{
  const { sanitizeMediaFilename, MEDIA_MAX_BYTES } = await import("../packages/shared/dist/index.js");
  const { detectImageType, parseMultipartUpload } = await import("../apps/api/dist/media.js");

  assert.equal(MEDIA_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(sanitizeMediaFilename("My Photo.PNG"), "My_Photo.PNG");
  assert.equal(sanitizeMediaFilename("a-b_c.d.png"), "a-b_c.d.png");
  assert.equal(sanitizeMediaFilename("café.png"), "caf_.png");
  assert.equal(sanitizeMediaFilename("UPPER.JPEG"), "UPPER.JPEG");
  for (const bad of ["", ".png", "..", "x", "x.exe", "x.png ", "a".repeat(97) + ".png", "photo.svg", "a/b/c.png".slice(0, 0) + "."]) {
    assert.throws(() => sanitizeMediaFilename(bad), Error, `should reject ${JSON.stringify(bad)}`);
  }
  // Separators are neutralized, never kept as path segments.
  assert.equal(sanitizeMediaFilename("a/b\\c.png"), "a_b_c.png");
  ok("sanitizeMediaFilename: allow-list + sanitization + rejections");

  assert.equal(detectImageType(PNG_RED), ".png");
  assert.equal(detectImageType(GIF_RED), ".gif");
  assert.equal(detectImageType(JPEG_MIN), ".jpg");
  assert.equal(detectImageType(TEXT_BYTES), null);
  assert.equal(detectImageType(Buffer.alloc(0)), null);
  assert.equal(detectImageType(PNG_RED.subarray(0, 4)), null);
  ok("detectImageType: magic bytes for png/gif/jpeg, null otherwise");

  const BOUNDARY = "----omp-builder-media-unit-boundary";
  const raw = Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="../../evil.png"\r\nContent-Type: image/png\r\n\r\n`, "ascii"),
    PNG_RED,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "ascii"),
  ]);
  const parsed = parseMultipartUpload(raw, `multipart/form-data; boundary=${BOUNDARY}`);
  assert.equal(parsed.filename, "evil.png");
  assert.deepEqual(parsed.data, PNG_RED);
  assert.throws(
    () => parseMultipartUpload(raw, "application/json"),
    (e) => e.status === 400,
  );
  const noFile = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="other"\r\n\r\nx\r\n--${BOUNDARY}--\r\n`, "ascii");
  assert.throws(
    () => parseMultipartUpload(noFile, `multipart/form-data; boundary=${BOUNDARY}`),
    (e) => e.status === 400,
  );
  ok("parseMultipartUpload: file part round-trips, directories stripped, bad bodies rejected");
}

// ---------- Part 2: throwaway API ----------
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
  assert.equal(ready, true, `throwaway API did not become ready: ${stderr.slice(0, 500)}`);
  return { env, child, stderr };
}

const BOUNDARY = "----omp-builder-media-api-boundary";
function rawMultipartBody(filename, contentType, data) {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    "ascii",
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "ascii");
  return { body: Buffer.concat([head, data, tail]), contentType: `multipart/form-data; boundary=${BOUNDARY}` };
}

{
  const temp = await mkdtemp(path.join(os.tmpdir(), "omp-builder-milestone-e-media-api-"));
  const port = 9180 + Math.floor(Math.random() * 200);
  const adminId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const seed = (seedDb) => {
    seedDb.exec(`
CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, admin_id TEXT NOT NULL REFERENCES admins(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
`);
    const now = new Date().toISOString();
    seedDb.prepare("INSERT INTO admins (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)").run(adminId, "test@example.com", "hash", "salt", now);
    seedDb.prepare("INSERT INTO sessions (id, token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), tokenHash, adminId, new Date(Date.now() + 3600_000).toISOString(), now);
  };
  const { child, env } = await spawnThrowawayApi(temp, port, seed);
  try {
    const sessionCookie = ["omp_builder_session", token].join("=");
    const headers = {
cookie: sessionCookie,
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
    const callRaw = async (method, urlPath, rawBody, contentType, useAuth = true) => {
      const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method,
        headers: useAuth
          ? { cookie: `omp_builder_session=${token}`, "content-type": contentType }
          : { "content-type": contentType },
        body: rawBody,
      });
      return response;
    };
    const uploadForm = async (method, urlPath, filename, data, mime) => {
      const form = new FormData();
      form.append("file", new File([data], filename, { type: mime }));
      const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method,
        headers: { cookie: `omp_builder_session=${token}` },
        body: form,
      });
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      return { status: response.status, data: parsed };
    };

    const created = await call("POST", "/api/projects", {
      name: "Media API test",
      prompt: "Throwaway project for the B7 media routes.",
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const projectId = created.data.project.id;
    const workspace = path.join(env.PROJECTS_ROOT, projectId);
    const listEmpty = await call("GET", `/api/projects/${projectId}/media`);
    assert.equal(listEmpty.status, 200, JSON.stringify(listEmpty.data));
    assert.deepEqual(listEmpty.data.images, []);
    ok("media list starts empty for a new project");

    const uploaded = await uploadForm("POST", `/api/projects/${projectId}/media`, "red.png", PNG_RED, "image/png");
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.image.path, "images/red.png");
    assert.equal(uploaded.data.image.mimeType, "image/png");
    assert.equal(uploaded.data.image.size, PNG_RED.length);
    ok("upload: 1x1 red PNG stored as images/red.png (201)");

    const listed = await call("GET", `/api/projects/${projectId}/media`);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.images.length, 1);
    assert.equal(listed.data.images[0].name, "red.png");
    const served = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/media/red.png`, {
      headers: { cookie: `omp_builder_session=${token}` },
    });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG_RED);
    ok("list + serve: thumbnail endpoint returns the exact bytes as image/png, no-store");

    const duplicate = await uploadForm("POST", `/api/projects/${projectId}/media`, "red.png", PNG_BLUE, "image/png");
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.data));
    ok("duplicate upload rejected with 409");

    const badExt = await uploadForm("POST", `/api/projects/${projectId}/media`, "evil.exe", PNG_RED, "image/png");
    assert.equal(badExt.status, 400, JSON.stringify(badExt.data));
    const badMagic = await uploadForm("POST", `/api/projects/${projectId}/media`, "fake.png", TEXT_BYTES, "image/png");
    assert.equal(badMagic.status, 415, JSON.stringify(badMagic.data));
    const wrongMagic = await uploadForm("POST", `/api/projects/${projectId}/media`, "gif-as-png.png", GIF_RED, "image/png");
    assert.equal(wrongMagic.status, 415, JSON.stringify(wrongMagic.data));
    const noFile = await callRaw("POST", `/api/projects/${projectId}/media`, Buffer.from("not multipart", "utf8"), "text/plain");
    assert.equal(noFile.status, 400);
    ok("bad type (400), magic mismatch (415 x2), non-multipart body (400) all rejected");

    const oversize = Buffer.concat([PNG_RED, Buffer.alloc(5 * 1024 * 1024 + 1 - PNG_RED.length)]);
    const tooBig = await uploadForm("POST", `/api/projects/${projectId}/media`, "huge.png", oversize, "image/png");
    assert.equal(tooBig.status, 413, JSON.stringify(tooBig.data));
    ok("oversize upload (>5 MB) rejected with 413");

    // Traversal filenames: separators are neutralized into the images/
    // dir; a name that sanitizes to a hidden file is rejected; and a
    // percent-encoded traversal in the URL never escapes images/.
    const traversal = rawMultipartBody("../../evil.png", "image/png", PNG_RED);
    const travRes = await callRaw("POST", `/api/projects/${projectId}/media`, traversal.body, traversal.contentType);
    assert.equal(travRes.status, 201, `traversal upload status ${travRes.status}`);
    const travTree = await call("GET", `/api/projects/${projectId}/files`);
    assert.equal(travTree.status, 200);
    const topNames = travTree.data.tree.map((e) => e.name);
    assert.ok(!topNames.includes("evil.png"), "traversal file must not land at the workspace root");
    assert.ok(topNames.includes("images"), "images/ dir exists in the tree");
    const hidden = await uploadForm("POST", `/api/projects/${projectId}/media`, ".png", PNG_RED, "image/png");
    assert.equal(hidden.status, 400, JSON.stringify(hidden.data));
    const escapeGet = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/media/..%2F..%2Fapp.db`, {
      headers: { cookie: `omp_builder_session=${token}` },
    });
    assert.ok([400, 404].includes(escapeGet.status), `escape GET status ${escapeGet.status}`);
    const escapeBody = await escapeGet.text();
    assert.ok(!escapeBody.includes("SQLite"), "escape GET must not serve database bytes");
    ok("path traversal neutralized: ../../evil.png lands in images/, hidden names rejected, URL escape blocked");

    // A non-image file placed in images/ by another route is listed
    // nowhere and served never.
    const textInImages = await call("PUT", `/api/projects/${projectId}/files/content`, { path: "images/notes.txt", content: "hello" });
    assert.equal(textInImages.status, 200, JSON.stringify(textInImages.data));
    const listed2 = await call("GET", `/api/projects/${projectId}/media`);
    assert.deepEqual(listed2.data.images.map((i) => i.name).sort(), ["evil.png", "red.png"]);
    const textServed = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/media/notes.txt`, {
      headers: { cookie: `omp_builder_session=${token}` },
    });
    assert.ok([400, 415].includes(textServed.status), `text-in-images GET status ${textServed.status}`);
    ok("non-image files in images/ are skipped by list and refused by serve");

    // Symlink escape: a link inside images/ pointing outside is refused.
    await symlink("/etc/passwd", path.join(workspace, "images", "link.png"));
    const linkServed = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/media/link.png`, {
      headers: { cookie: `omp_builder_session=${token}` },
    });
    assert.equal(linkServed.status, 403, `symlink GET status ${linkServed.status}`);
    const listed3 = await call("GET", `/api/projects/${projectId}/media`);
    assert.ok(!listed3.data.images.some((i) => i.name === "link.png"), "symlink must not appear in the list");
    ok("symlink inside images/ refused (403) and hidden from list");

    // Replace flow: bytes swap in place, same name, no orphan.
    const replaced = await uploadForm("PUT", `/api/projects/${projectId}/media/red.png`, "red.png", PNG_BLUE, "image/png");
    assert.equal(replaced.status, 200, JSON.stringify(replaced.data));
    assert.equal(replaced.data.image.path, "images/red.png");
    const servedAfter = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/media/red.png`, {
      headers: { cookie: `omp_builder_session=${token}` },
    });
    assert.deepEqual(Buffer.from(await servedAfter.arrayBuffer()), PNG_BLUE);
    const listed4 = await call("GET", `/api/projects/${projectId}/media`);
    assert.equal(listed4.data.images.filter((i) => i.name === "red.png").length, 1);
    const replaceMissing = await uploadForm("PUT", `/api/projects/${projectId}/media/ghost.png`, "ghost.png", PNG_RED, "image/png");
    assert.equal(replaceMissing.status, 404, JSON.stringify(replaceMissing.data));
    const replaceWrongExt = await uploadForm("PUT", `/api/projects/${projectId}/media/red.png`, "red.gif", GIF_RED, "image/gif");
    assert.equal(replaceWrongExt.status, 400, JSON.stringify(replaceWrongExt.data));
    const replaceBadMagic = await uploadForm("PUT", `/api/projects/${projectId}/media/red.png`, "red.png", TEXT_BYTES, "image/png");
    assert.equal(replaceBadMagic.status, 415, JSON.stringify(replaceBadMagic.data));
    // The failed replaces left the blue bytes untouched.
    const servedStill = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/media/red.png`, {
      headers: { cookie: `omp_builder_session=${token}` },
    });
    assert.deepEqual(Buffer.from(await servedStill.arrayBuffer()), PNG_BLUE);
    ok("replace: bytes swap in place (200), missing 404, wrong extension 400, bad magic 415, failures leave bytes intact");

    // The text file API still refuses binaries, and media needs auth.
    const textApi = await call("GET", `/api/projects/${projectId}/files/content?path=${encodeURIComponent("images/red.png")}`);
    assert.equal(textApi.status, 415, JSON.stringify(textApi.data));
    const noAuthList = await call("GET", `/api/projects/${projectId}/media`, undefined, false);
    assert.equal(noAuthList.status, 401);
    const noAuthGet = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/media/red.png`);
    assert.equal(noAuthGet.status, 401);
    const noAuthPost = await callRaw("POST", `/api/projects/${projectId}/media`, traversal.body, traversal.contentType, false);
    assert.equal(noAuthPost.status, 401);
    const missingGet = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/media/nope.png`, {
      headers: { cookie: `omp_builder_session=${token}` },
    });
    assert.equal(missingGet.status, 404);
    ok("text file API still 415s binaries; media list/serve/upload all require auth (401); missing image 404");

    // Images are ordinary workspace files: they checkpoint with Git.
    let initialized = false;
    for (let attempt = 0; attempt < 60 && !initialized; attempt += 1) {
      const v = await call("GET", `/api/projects/${projectId}/versions`);
      if (v.status === 200 && v.data.status?.initialized) initialized = true;
      else await sleep(500);
    }
    assert.ok(initialized, "project workspace was not git-initialized");
    const checkpoint = await call("POST", `/api/projects/${projectId}/versions/checkpoint`, { message: "media checkpoint" });
    assert.equal(checkpoint.status, 200, JSON.stringify(checkpoint.data));
    assert.ok(checkpoint.data.checkpoint.created, "checkpoint was not created");
    const detail = await call("GET", `/api/projects/${projectId}/versions/${checkpoint.data.checkpoint.oid}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.ok(detail.data.files.some((f) => f.path === "images/red.png"), "checkpoint does not contain images/red.png");
    ok("uploaded image is checkpointed by the Git version history");

    const deleted = await call("DELETE", `/api/projects/${projectId}`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    ok("throwaway project deleted");
  } finally {
    child.kill("SIGTERM");
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------- Part 3: static checks ----------
{
  const { sanitizeMediaFilename } = await import("../packages/shared/dist/index.js");
  assert.equal(typeof sanitizeMediaFilename, "function");
  const serverBundle = await readFile(path.join(root, "apps/api/dist/server.js"), "utf8");
  assert.ok(serverBundle.includes("/media"), "built API bundle has no /media route");
  assert.ok(serverBundle.includes("parseMultipartUpload"), "built API bundle has no multipart parser");
  const webAssets = await readdir(path.join(root, "apps/web/dist/assets"));
  const mainBundle = webAssets.find((name) => /^index-.*\.js$/.test(name));
  assert.ok(mainBundle, "no built web index bundle");
  const webBundle = await readFile(path.join(root, "apps/web/dist/assets", mainBundle), "utf8");
  assert.ok(webBundle.includes("Upload image"), "built web bundle has no Media upload UI");
  assert.ok(webBundle.includes("Replace"), "built web bundle has no Replace UI");
  const builderSource = await readFile(path.join(root, "apps/web/src/components/Builder.tsx"), "utf8");
  assert.ok(!builderSource.includes("aren't supported yet"), "Builder still claims attachments are unsupported");
  assert.ok(builderSource.includes("@images/"), "Builder never references @images/ attachments");
  assert.ok(builderSource.includes("MediaBrowser"), "Builder does not render the Media browser");
  const mediaFiles = await stat(path.join(root, "apps/api/src/media.ts"));
  assert.ok(mediaFiles.isFile());
  ok("static: built bundles carry the media routes + UI; Builder drops the unsupported-attachments note");
}

console.log(`\nAll ${passed} Milestone E (B7) media checks passed.`);
