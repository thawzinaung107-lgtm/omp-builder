import { mkdirSync } from "node:fs";
import path from "node:path";
import { OmpRpcSession, resolveOmpBinary } from "./omp-rpc.js";

type SessionRecord = { session: OmpRpcSession; lastUsed: number; projectId: string };

// Milestone D (B2) - the pool is keyed by CHAT session id, not project id:
// several chats share one project workspace, each with its own OMP child
// (its own --continue session dir, so conversations never leak between
// chats). The 2-slot pool is a real constraint: a chat only holds a slot
// while its OMP child is alive. Children are created lazily on the first
// prompt, released explicitly when the user switches away from an idle
// chat (release_chat), and reaped when idle. A third concurrent chat
// gets a clear "OMP process limit reached" error instead of hanging.
export class OmpSessionManager {
  private sessions = new Map<string, SessionRecord>();
  constructor(private readonly options: { binary: string; projectsRoot: string; sessionRoot: string; maxProcesses: number; idleMs: number; runAsUserFor?: (projectId: string) => boolean; isProjectAlive?: (projectId: string) => boolean }) {
    mkdirSync(options.sessionRoot, { recursive: true, mode: 0o700 });
    this.options.binary = resolveOmpBinary(options.binary);
  }
  async get(chat: { chatSessionId: string; projectId: string; workspacePath: string; sessionDir: string; provider?: string; modelId?: string }, onEvent: (type: Parameters<ConstructorParameters<typeof OmpRpcSession>[1]["onEvent"]>[0], payload: Record<string, unknown>) => void, onExit: (error?: Error) => void, env?: NodeJS.ProcessEnv): Promise<OmpRpcSession> {
    const key = chat.chatSessionId;
    let current = this.sessions.get(key);
    if (current) { current.lastUsed = Date.now(); return current.session; }
    if (this.sessions.size >= this.options.maxProcesses) {
      // Phase 3.5 (S5 fix) - defence in depth: a session whose project row
      // is gone (deleted out-of-band, e.g. a direct DB delete) must not
      // hold a pool slot until the 15-minute idle reap. Reap those first,
      // then re-check the limit before refusing a live project.
      await this.closeOrphanedSessions();
      if (this.sessions.size >= this.options.maxProcesses) throw new Error(`OMP process limit reached - all ${this.options.maxProcesses} OMP slots are busy. Wait for another chat to finish, or switch back to it.`);
    }
    const session = new OmpRpcSession({ projectId: chat.projectId, cwd: chat.workspacePath, sessionDir: chat.sessionDir, binary: this.options.binary, provider: chat.provider, modelId: chat.modelId, resume: true, env, runAsUser: this.options.runAsUserFor?.(chat.projectId) ?? false }, { onEvent, onExit });
    current = { session, lastUsed: Date.now(), projectId: chat.projectId }; this.sessions.set(key, current);
    try { await session.start(); } catch (error) { this.sessions.delete(key); await session.close(); throw error; }
    return session;
  }
  /** The live OMP child for a chat, if one is running (never starts one). */
  peek(chatSessionId: string): OmpRpcSession | undefined { return this.sessions.get(chatSessionId)?.session; }
  /** Live chat-session ids holding pool slots for one project. */
  liveChatSessionIds(projectId: string): string[] { return [...this.sessions.entries()].filter(([, record]) => record.projectId === projectId).map(([chatSessionId]) => chatSessionId); }
  async closeChat(chatSessionId: string): Promise<void> { const current = this.sessions.get(chatSessionId); if (!current) return; this.sessions.delete(chatSessionId); await current.session.close(); }
  /** Close an idle chat child (release its pool slot). A busy chat is left alone. Returns true when a child was closed. */
  async closeChatIfIdle(chatSessionId: string): Promise<boolean> { const current = this.sessions.get(chatSessionId); if (!current || current.session.isBusy) return false; await this.closeChat(chatSessionId); return true; }
  async closeProject(projectId: string): Promise<void> { for (const [chatSessionId, record] of [...this.sessions.entries()]) if (record.projectId === projectId) { this.sessions.delete(chatSessionId); await record.session.close(); } }
  /** Close sessions whose project no longer exists (deleted out-of-band). Returns how many were closed. No-op when no liveness check was supplied. */
  async closeOrphanedSessions(): Promise<number> { const isAlive = this.options.isProjectAlive; if (!isAlive) return 0; let closed = 0; for (const [chatSessionId, record] of [...this.sessions.entries()]) { let alive = true; try { alive = isAlive(record.projectId); } catch { alive = false; } if (!alive) { await this.closeChat(chatSessionId); closed += 1; } } return closed; }
  async closeIdle(): Promise<void> { const cutoff = Date.now() - this.options.idleMs; for (const [chatSessionId, current] of this.sessions) if (current.lastUsed < cutoff && !current.session.isBusy) await this.closeChat(chatSessionId); }
  async closeAll(): Promise<void> { for (const chatSessionId of [...this.sessions.keys()]) await this.closeChat(chatSessionId); }
}
