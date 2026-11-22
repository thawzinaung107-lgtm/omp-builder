import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, mkdirSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { OmpEvent } from "@omp-builder/shared";

type RpcFrame = { id?: string; type?: string; command?: string; success?: boolean; data?: unknown; error?: string; [key: string]: unknown };
type Pending = { resolve: (value: RpcFrame) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const REDACT_KEYS = /(?:api.?key|token|secret|password|authorization|credential)/i;
function safePayload(value: unknown): Record<string, unknown> {
  const redact = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, REDACT_KEYS.test(key) ? "[REDACTED]" : redact(child)]));
    return typeof item === "string" && item.length > 16 && /bearer\s|sk-|api[_-]?key/i.test(item) ? "[REDACTED]" : item;
  };
  const result = redact(value);
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : { value: result };
}

export type OmpSessionOptions = { projectId: string; cwd: string; sessionDir: string; binary: string; provider?: string; modelId?: string; resume?: boolean; env?: NodeJS.ProcessEnv };
const ISOLATED_CREDENTIAL_ENV = /^(?:OMP_BUILDER_KEY_|(?:XPIKI|OPENAI|ANTHROPIC|GOOGLE|GEMINI|DEEPSEEK|OPENROUTER|MISTRAL|GROQ|TOGETHER|FIREWORKS|COHERE|PERPLEXITY|AZURE|AWS)_API_KEY$|(?:API_KEY|API_TOKEN|AUTH_TOKEN))$/i;

function childEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !ISOLATED_CREDENTIAL_ENV.test(name)));
  return { ...inherited, ...overrides, PI_NO_TITLE: "1" };
}
export function resolveOmpBinary(binary: string): string {
  const candidates = binary.includes("/") ? [binary] : [...(process.env.PATH ?? "").split(":").filter(Boolean).map((directory) => `${directory}/${binary}`), `${process.env.HOME ?? ""}/.local/bin/${binary}`];
  for (const candidate of candidates) { try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch { /* try the next configured location */ } }
  throw new Error(`OMP executable not found: ${binary}`);
}
export type OmpSessionCallbacks = { onEvent: (type: OmpEvent["type"], payload: Record<string, unknown>) => void; onExit: (error?: Error) => void };

export class OmpRpcSession {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readyTimer?: NodeJS.Timeout;
  private settled = true;
  private closing = false;
  private failed = false;
  private chunk?: { id: string; count: number; bytes: number; data: string[] };
  constructor(private readonly options: OmpSessionOptions, private readonly callbacks: OmpSessionCallbacks) {}
  get isBusy(): boolean { return !this.settled; }

  async start(): Promise<void> {
    if (this.child) return;
    this.failed = false;
    const binary = resolveOmpBinary(this.options.binary);
    mkdirSync(this.options.sessionDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.options.cwd, { recursive: true, mode: 0o700 });
    const args = ["--mode", "rpc", "--no-ui", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--cwd", this.options.cwd, "--session-dir", this.options.sessionDir];
    if (this.options.resume) args.push("--continue");
    if (this.options.provider && this.options.modelId) args.push("--model", `${this.options.provider}/${this.options.modelId}`);
    this.child = spawn(binary, args, { cwd: this.options.cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnvironment(this.options.env) });
    this.child.stderr.on("data", (chunk) => { const message = String(chunk).trim(); if (message) this.callbacks.onEvent("session_status", { state: "stderr", message: message.slice(0, 500) }); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.receive(line));
    this.child.once("error", (error) => this.fail(new Error(`Unable to start OMP: ${error.message}`)));
    this.child.once("exit", (code, signal) => { if (!this.closing) this.fail(new Error(`OMP exited (${code ?? signal ?? "unknown"})`)); });
    await new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; this.readyTimer = setTimeout(() => reject(new Error(`OMP ready timeout (${binary})`)), 15_000); });
    const ready = await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
    if (!ready.success) throw new Error(String(ready.error ?? "OMP protocol negotiation failed"));
    this.callbacks.onEvent("session_status", { state: "ready", protocolVersion: ready.data });
  }
  private fail(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.callbacks.onExit(error);
    this.readyReject?.(error);
  }
  private receive(line: string): void {
    let frame: RpcFrame;
    try { frame = JSON.parse(line) as RpcFrame; } catch { return; }
    if (frame.type === "ready") { this.readyResolve?.(); this.readyResolve = undefined; return; }
    if (frame.type === "rpc_chunk") { this.receiveChunk(frame); return; }
    if (frame.type === "response" && frame.id) { const item = this.pending.get(frame.id); if (item) { this.pending.delete(frame.id); clearTimeout(item.timer); item.resolve(frame); } return; }
    this.handleEvent(frame);
  }
  private receiveChunk(frame: RpcFrame): void {
    const id = String(frame.chunkId ?? ""); const index = Number(frame.index); const count = Number(frame.count); const data = String(frame.data ?? "");
    if (!id || !Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count || !data) { this.chunk = undefined; return; }
    if (!this.chunk) this.chunk = { id, count, bytes: 0, data: [] };
    if (this.chunk.id !== id || this.chunk.count !== count || index !== this.chunk.data.length) { this.chunk = undefined; return; }
    this.chunk.data.push(data); this.chunk.bytes += Buffer.byteLength(data, "base64");
    if (this.chunk.bytes > 67_108_864) { this.chunk = undefined; return; }
    if (this.chunk.data.length === count) { try { this.handleEvent(JSON.parse(Buffer.concat(this.chunk.data.map((part) => Buffer.from(part, "base64"))).toString("utf8")) as RpcFrame); } finally { this.chunk = undefined; } }
  }
  private handleEvent(frame: RpcFrame): void {
    const type = frame.type ?? "";
    const nested = frame.assistantMessageEvent;
    if (type === "message_update" && nested && typeof nested === "object") {
      const event = nested as Record<string, unknown>;
      if (event.type === "text_delta" && typeof event.delta === "string") this.callbacks.onEvent("assistant_delta", { delta: event.delta, messageId: frame.messageId });
      return;
    }
    if (type === "message_update") this.callbacks.onEvent("assistant_delta", safePayload(frame));
    else if (type === "message_end") this.callbacks.onEvent("assistant_completed", safePayload(frame));
    else if (type === "tool_execution_start") this.callbacks.onEvent("tool_started", safePayload(frame));
    else if (type === "tool_execution_update" || type === "tool_stream_update") this.callbacks.onEvent("tool_progress", safePayload(frame));
    else if (type === "tool_execution_end") this.callbacks.onEvent((frame.isError ? "tool_error" : "tool_finished"), safePayload(frame));
    else if (type === "agent_end" && frame.yielded !== false) this.callbacks.onEvent("assistant_completed", safePayload(frame));
    else if (type === "prompt_result") this.callbacks.onEvent("session_status", safePayload(frame));
    else if (type === "session_settled") { this.settled = true; this.callbacks.onEvent("session_settled", safePayload(frame)); }
    else if (type === "session_error" || type === "extension_error" || type === "rpc_frame_error") this.callbacks.onEvent("agent_error", safePayload(frame));
  }
  request(command: Record<string, unknown>): Promise<RpcFrame> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("OMP is not running"));
    const id = `omp-${++this.sequence}-${randomUUID()}`; const frame = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`OMP command timed out: ${String(command.type)}`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer }); this.child?.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }
  async prompt(message: string): Promise<void> {
    if (this.isBusy) throw new Error("A prompt is already running for this project");
    this.settled = false; this.callbacks.onEvent("prompt_accepted", { message });
    const result = await this.request({ type: "prompt", message });
    if (!result.success) { this.settled = true; throw new Error(String(result.error ?? "OMP rejected prompt")); }
  }
  async abort(): Promise<void> { if (!this.child || this.settled) return; const result = await this.request({ type: "abort" }); if (!result.success) throw new Error(String(result.error ?? "OMP abort failed")); this.settled = true; this.callbacks.onEvent("prompt_aborted", {}); }
  async state(): Promise<Record<string, unknown>> { const result = await this.request({ type: "get_state" }); if (!result.success) throw new Error(String(result.error ?? "OMP state unavailable")); return safePayload(result.data); }
  async setModel(provider: string, modelId: string): Promise<void> { const result = await this.request({ type: "set_model", provider, modelId }); if (!result.success) throw new Error(String(result.error ?? "OMP model selection failed")); this.callbacks.onEvent("model_changed", { provider, modelId }); }
  async close(): Promise<void> { this.closing = true; for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("OMP session closed")); } this.pending.clear(); this.child?.stdin.end(); await new Promise((resolve) => setTimeout(resolve, 100)); this.child?.kill("SIGTERM"); this.child = undefined; }
}
