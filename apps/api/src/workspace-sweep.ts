import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

// Phase 3.5 (§5 fix) — terminate processes rooted in a project's workspace.
//
// When a project is deleted, closing its OMP session is not enough: an
// agent may have started a dev server (vite / shell / omp worker daemon)
// whose processes survive the OMP child's SIGTERM, because their cmdline
// does not contain the `--cwd <workspace>` marker the old test cleanup
// scanned for. Those orphans keep ports and files held and — for the OMP
// child itself, when a project row was deleted out-of-band — keep a pool
// slot occupied. This sweep finds them by /proc instead.
//
// Matching is deliberately narrow: a process matches only when its current
// working directory is the workspace (or inside it), or one of its argv
// elements is exactly the workspace path (or a path inside it, e.g.
// `--cwd <workspace>`). PIDs come from the /proc scan itself — never from a
// shell pattern — so this module can never match its own command line.
// The API process itself is excluded, as is PID 1. Kill failures (already
// exited, or a root-owned leftover the service user may not signal) are
// swallowed and reported as survivors, never thrown.

export type WorkspaceSweepResult = { killed: number[]; survivors: number[] };

export async function findWorkspaceProcesses(workspacePath: string): Promise<number[]> {
  const root = path.resolve(workspacePath);
  const found: number[] = [];
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid || pid === 1) continue;
    let cwd = "";
    try {
      cwd = await readlink(`/proc/${pid}/cwd`);
    } catch {
      // Exited between readdir and readlink, or unreadable: not ours.
    }
    if (cwd === root || cwd.startsWith(`${root}${path.sep}`)) {
      found.push(pid);
      continue;
    }
    try {
      const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
      if (args.some((arg) => arg === root || arg.startsWith(`${root}${path.sep}`))) found.push(pid);
    } catch {
      // Exited between readdir and read, or unreadable: not ours.
    }
  }
  return found;
}

async function signal(pids: number[], signal: NodeJS.Signals): Promise<number[]> {
  const signalled: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signalled.push(pid);
    } catch {
      // Already gone, or not permitted (e.g. a root-owned leftover):
      // the caller reports it as a survivor instead of failing.
    }
  }
  return signalled;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function terminateWorkspaceProcesses(workspacePath: string): Promise<WorkspaceSweepResult> {
  const targets = await findWorkspaceProcesses(workspacePath);
  if (targets.length === 0) return { killed: [], survivors: [] };
  const killed = await signal(targets, "SIGTERM");
  // Grace period for a clean exit (covers the OMP child, which
  // closeProject() SIGTERMs and returns without waiting for the exit).
  // Re-scan each round so processes that only appeared after the first
  // scan are caught too.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await findWorkspaceProcesses(workspacePath)).length === 0) return { killed, survivors: [] };
    await sleep(250);
  }
  const survivors = await findWorkspaceProcesses(workspacePath);
  if (survivors.length > 0) {
    const forceKilled = await signal(survivors, "SIGKILL");
    await sleep(500);
    const remaining = await findWorkspaceProcesses(workspacePath);
    return { killed: [...killed, ...forceKilled], survivors: remaining };
  }
  return { killed, survivors: [] };
}
