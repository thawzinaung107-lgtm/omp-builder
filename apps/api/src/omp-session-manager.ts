import { mkdirSync } from "node:fs";
import path from "node:path";
import { OmpRpcSession, resolveOmpBinary } from "./omp-rpc.js";

type SessionRecord = { session: OmpRpcSession; lastUsed: number };

export class OmpSessionManager {
  private sessions = new Map<string, SessionRecord>();
  constructor(private readonly options: { binary: string; projectsRoot: string; sessionRoot: string; maxProcesses: number; idleMs: number; runAsUserFor?: (projectId: string) => boolean; isProjectAlive?: (projectId: string) => boolean }) {
    mkdirSync(options.sessionRoot, { recursive: true, mode: 0o700 });
    this.options.binary = resolveOmpBinary(options.binary);
  }
  async get(project: { id: string; workspacePath: string; provider?: string; modelId?: string }, onEvent: (type: Parameters<ConstructorParameters<typeof OmpRpcSession>[1]["onEvent"]>[0], payload: Record<string, unknown>) => void, onExit: (error?: Error) => void, env?: NodeJS.ProcessEnv): Promise<OmpRpcSession> {
    let current = this.sessions.get(project.id);
    if (current) { current.lastUsed = Date.now(); return current.session; }
    if (this.sessions.size >= this.options.maxProcesses) {
      // Phase 3.5 (§5 fix) — defence in depth: a session whose project row
      // is gone (deleted out-of-band, e.g. a direct DB delete) must not
      // hold a pool slot until the 15-minute idle reap. Reap those first,
      // then re-check the limit before refusing a live project.
      await this.closeOrphanedSessions();
      if (this.sessions.size >= this.options.maxProcesses) throw new Error("OMP process limit reached");
    }
    const session = new OmpRpcSession({ projectId: project.id, cwd: project.workspacePath, sessionDir: path.join(this.options.sessionRoot, project.id), binary: this.options.binary, provider: project.provider, modelId: project.modelId, resume: true, env, runAsUser: this.options.runAsUserFor?.(project.id) ?? false }, { onEvent, onExit });
    current = { session, lastUsed: Date.now() }; this.sessions.set(project.id, current);
    try { await session.start(); } catch (error) { this.sessions.delete(project.id); await session.close(); throw error; }
    return session;
  }
  async closeProject(projectId: string): Promise<void> { const current = this.sessions.get(projectId); if (!current) return; this.sessions.delete(projectId); await current.session.close(); }
  /** Close sessions whose project no longer exists (deleted out-of-band). Returns how many were closed. No-op when no liveness check was supplied. */
  async closeOrphanedSessions(): Promise<number> { const isAlive = this.options.isProjectAlive; if (!isAlive) return 0; let closed = 0; for (const projectId of [...this.sessions.keys()]) { let alive = true; try { alive = isAlive(projectId); } catch { alive = false; } if (!alive) { await this.closeProject(projectId); closed += 1; } } return closed; }
  async closeIdle(): Promise<void> { const cutoff = Date.now() - this.options.idleMs; for (const [projectId, current] of this.sessions) if (current.lastUsed < cutoff && !current.session.isBusy) await this.closeProject(projectId); }
  async closeAll(): Promise<void> { for (const projectId of [...this.sessions.keys()]) await this.closeProject(projectId); }
}
