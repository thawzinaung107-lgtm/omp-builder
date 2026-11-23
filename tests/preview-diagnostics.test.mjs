import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePreviewProblem, PreviewDiagnosticStore, PreviewLogLines, sanitizePreviewOutput } from "../apps/api/dist/preview-diagnostics.js";
import { diagnosticDraft } from "../apps/web/src/diagnostic-draft.ts";

const compile = "12:07:30 PM [vite] Internal server error: Unexpected token\n  Plugin: vite:esbuild\n  File: /app/src/main.ts:4:3";

test("recognizes Vite errors and only uses explicitly reported safe source positions", () => {
  assert.deepEqual(parsePreviewProblem(compile).location, { path: "src/main.ts", line: 4, column: 3 });
  assert.equal(parsePreviewProblem(compile).kind, "compile");
  assert.deepEqual(parsePreviewProblem(compile.replace("main.ts", "Hello World.tsx")).location, { path: "src/Hello World.tsx", line: 4, column: 3 });
  assert.equal(parsePreviewProblem(compile.replace("File: /app/src/main.ts", "Look at src/main.ts")).location, undefined);
  for (const unsafe of ["/etc/main.ts:4:3", "/app/../main.ts:4:3", "/app/.env.local:4:3",
    "/app/node_modules/package/main.js:4:3", "/app/main.ts:0:3", "/app/main.ts:4:0", "/app/main.ts:99999999:3"]) {
    assert.equal(parsePreviewProblem(compile.replace("/app/src/main.ts:4:3", unsafe)).location, undefined, unsafe);
  }
  assert.deepEqual(parsePreviewProblem(compile.replace(":4:3", ":4")).location, { path: "src/main.ts", line: 4, column: undefined });
});

test("separates dependency and startup errors, with plain text fallback only for failed startup", () => {
  assert.equal(parsePreviewProblem("npm error code ERESOLVE", "startup").kind, "dependency");
  assert.equal(parsePreviewProblem(compile + "\n[omp-preview] dependency installation failed", "startup").kind, "dependency");
  assert.equal(parsePreviewProblem("server exited with an unknown message", "startup").detail, "server exited with an unknown message");
  assert.equal(parsePreviewProblem("runtime unavailable", "runtime").kind, "runtime");
  assert.equal(parsePreviewProblem("server listening"), undefined);
});

test("sanitizes control characters, secrets, paths and private addresses", () => {
  const output = "\x1b[31mError\x1b[0m in /home/runner/private/file.ts at C:\\Users\\test\nAPI_KEY=fixture-key Bearer fixture-token https://user:creds@private.internal:1234 192.168.0.1:8080\n-----BEGIN PRIVATE KEY-----\nprivate-contents\n-----END PRIVATE KEY-----";
  const safe = sanitizePreviewOutput(output);
  for (const value of ["\x1b", "fixture-key", "fixture-token", "/home/runner", "Users", "creds", "private.internal", "192.168", "private-contents"]) {
    assert.ok(!safe.includes(value), value);
  }
  assert.match(safe, /Error in/);
  assert.ok(sanitizePreviewOutput("x ".repeat(25_000)).length <= 12_000);
});

test("deduplicates, caps retained data, isolates projects and ignores late runs", () => {
  const store = new PreviewDiagnosticStore();
  const id = store.begin("a");
  store.phase("a", id, "running");
  store.capture("a", id, compile);
  store.capture("a", id, compile.replace("12:07:30", "12:08:30"));
  assert.equal(store.get("a").problems.length, 1);
  store.changed("a");
  assert.equal(store.get("a").problems[0].stale, true);
  store.capture("a", id, compile);
  assert.equal(store.get("a").problems[0].stale, false);
  for (let line = 1; line <= 16; line++) store.capture("a", id, compile.replace(":4:3", `:${line}:3`));
  assert.equal(store.get("a").problems.length, 8);
  store.capture("a", id, "x ".repeat(10_000));
  assert.ok(store.get("a").logs.length <= 12_000);
  assert.deepEqual(store.get("b").problems, []);
  const recovered = store.begin("a");
  store.capture("a", id, compile);
  store.phase("a", id, "failed");
  store.phase("a", recovered, "running");
  assert.equal(store.get("a").phase, "running");
  assert.deepEqual(store.get("a").problems, []);
});

test("waits for complete log records before exposing split secrets", () => {
  const previous = process.env.A4_FIXTURE_TOKEN;
  process.env.A4_FIXTURE_TOKEN = "abc-def-ghi-jkl";
  try {
    const lines = new PreviewLogLines();
    assert.deepEqual(lines.push("Error: abc-def-"), []);
    const complete = lines.push("ghi-jkl\n");
    assert.equal(sanitizePreviewOutput(complete.join("\n")), "Error: [redacted]");
    assert.deepEqual(lines.push("-----BEGIN PRIVATE KEY-----\nprivate-data\n"), []);
    assert.deepEqual(lines.push("more-data\n-----END PRIVATE KEY-----\nready\n"), ["ready"]);
    assert.deepEqual(lines.push("TOKEN=" + " ".repeat(13_000)), []);
    assert.deepEqual(lines.push("sensitive-suffix\n"), []);
  } finally {
    if (previous === undefined) delete process.env.A4_FIXTURE_TOKEN;
    else process.env.A4_FIXTURE_TOKEN = previous;
  }
});

test("drops orphaned base64 key records when capturing a bounded log tail", () => {
  const body = "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD/e8I+SNbpcA==";
  const records = [body, "abcd", "abc=", "-----END PRIVATE KEY-----", "Vite startup failed"];
  assert.equal(sanitizePreviewOutput(records.join("\n")), "Vite startup failed");
  const follower = new PreviewLogLines();
  assert.deepEqual(follower.push(records.join("\n") + "\n"), ["Vite startup failed"]);
  const store = new PreviewDiagnosticStore();
  const run = store.begin("project");
  store.capture("project", run, "line ".repeat(3000) + "\n" + records.join("\n"), "startup");
  assert.doesNotMatch(JSON.stringify(store.get("project")), /MIIEvg|abcd|abc=/);
  assert.match(store.get("project").problems[0].detail, /Vite startup failed/);
});

test("evicts inactive diagnostics without invalidating active runs", () => {
  const store = new PreviewDiagnosticStore();
  const active = store.begin("active");
  store.phase("active", active, "running");
  for (let i = 0; i < 105; i++) {
    const project = `inactive-${i}`;
    const id = store.begin(project);
    store.phase(project, id, "failed");
  }
  assert.equal(store.get("inactive-0").runId, null);
  store.capture("active", active, compile);
  assert.equal(store.get("active").problems.length, 1);
});

test("fix draft contains bounded, labeled output and a verified location", () => {
  const problem = parsePreviewProblem(compile);
  const draft = diagnosticDraft({ ...problem, stale: true, detail: "x".repeat(25_000) });
  assert.match(draft, /src\/main\.ts:4:3/);
  assert.match(draft, /may be stale/);
  assert.match(draft, /Begin untrusted build output/);
  assert.ok(draft.length < 2200);
});
