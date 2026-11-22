import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OmpRpcSession, resolveOmpBinary } from "../apps/api/dist/omp-rpc.js";

// Phase 3.5 §2: OMP needs a config dir with a models.yml to pick a default
// model at startup. The API always passes OMP_CONFIG_DIR + a --model, so a
// bare spawn without them only worked as root (ambient /root/.omp config).
// Point the smoke spawn at the real config dir, like the API does.
const configDir = process.env.OMP_BUILDER_CONFIG_DIR ?? "/var/lib/omp-builder/data/omp-config";
process.env.OMP_CONFIG_DIR = configDir;
process.env.PI_CODING_AGENT_DIR = configDir;

const root = await mkdtemp(path.join(os.tmpdir(), "omp-builder-rpc-"));
const events = [];
let exitError;
try {
  assert.equal(resolveOmpBinary("/usr/local/bin/omp"), "/usr/local/bin/omp");
  assert.throws(() => resolveOmpBinary(path.join(root, "missing-omp")), /OMP executable not found/);
  const session = new OmpRpcSession({ projectId: "rpc-smoke", cwd: path.join(root, "project"), sessionDir: path.join(root, "session"), binary: "omp", resume: true }, { onEvent: (type, payload) => events.push({ type, payload }), onExit: (error) => { exitError = error?.message; } });
  await session.start();
  assert.equal(events.some((event) => event.type === "session_status" && event.payload.state === "ready"), true);
  assert.equal(exitError, undefined);
  await session.close();
  const failingBinary = path.join(root, "failing-omp");
  await writeFile(failingBinary, "#!/bin/sh\nexit 17\n");
  await chmod(failingBinary, 0o700);
  let failure;
  const failedSession = new OmpRpcSession({ projectId: "rpc-failure", cwd: path.join(root, "failed-project"), sessionDir: path.join(root, "failed-session"), binary: failingBinary, resume: false }, { onEvent: () => undefined, onExit: (error) => { failure = error; } });
  await assert.rejects(() => failedSession.start(), /OMP exited \(17\)/);
  assert.match(failure?.message ?? "", /OMP exited \(17\)/);
  await failedSession.close();
  console.log("OMP RPC initialization and startup-failure smoke passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
