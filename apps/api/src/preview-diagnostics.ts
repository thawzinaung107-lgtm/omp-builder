import { createHash, randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { PreviewProblem, PreviewProblems } from "@omp-builder/shared";
import { isProtectedPath, validateRelPath } from "./files.js";

const MAX_OUTPUT = 12_000;
const MAX_PROBLEMS = 8;

// Only release complete records to the log stream and diagnostic batches.
export class PreviewLogLines {
  private partial = "";
  private overflow = false;
  private inPrivateKey = false;

  push(chunk: string): string[] {
    const segments = chunk.split("\n");
    const lines: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (this.partial.length + segment.length > MAX_OUTPUT) {
        this.overflow = true;
        this.partial = "";
      }
      if (!this.overflow) this.partial += segment;
      if (i < segments.length - 1) {
        const line = this.finish();
        if (line !== undefined) lines.push(line);
      }
    }
    return lines;
  }

  finish(): string | undefined {
    const line = this.partial;
    const omitted = this.overflow;
    this.partial = "";
    this.overflow = false;
    if (omitted) return undefined;
    const plain = stripVTControlCharacters(line);
    if (/-----BEGIN [^-]*PRIVATE KEY-----/i.test(plain)) this.inPrivateKey = true;
    if (this.inPrivateKey) {
      if (/-----END [^-]*PRIVATE KEY-----/i.test(plain)) this.inPrivateKey = false;
      return undefined;
    }
    return line;
  }
}

export function previewOutputTail(raw: string, max = MAX_OUTPUT): string {
  // Do not retain mid-record suffixes, which could remove a redaction label.
  if (raw.length <= max) return raw;
  const tail = raw.slice(-max);
  const newline = tail.indexOf("\n");
  return newline === -1 ? "" : tail.slice(newline + 1);
}

export function sanitizePreviewOutput(raw: string): string {
  let text = stripVTControlCharacters(previewOutputTail(raw))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 6 && /secret|token|key|pass|credential|database_url/i.test(name)) {
      text = text.replaceAll(value, "[redacted]");
    }
  }
  return text
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/gi, "[redacted]")
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, "[redacted]")
    .replace(/\b[\w.-]*(?:secret|token|password|passwd|authorization|api[_-]?key|credential)[\w.-]*["']?\s*[:=]\s*(?:"[^"\n]*"|\x27[^\x27\n]*\x27|[^\s,;]+)/gi, "[redacted]")
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, "[address]")
    .replace(/(?:[a-z]:[\\/]|\\\\|(?<![\w.])\/)[^\s"'<>|)\]]+/gi, "[path]")
    .replace(/\[[\da-f]*:[\da-f:]+\](?::\d+)?|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|\b(?:localhost|[\w.-]+\.(?:internal|local|localhost|lan|svc|cluster\.local))(?::\d+)?\b/gi, "[address]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[\w-]+|\b[A-Za-z\d_=-]{32,}\b/g, "[redacted]")
    .slice(-MAX_OUTPUT).trim();
}

function sourceLocation(text: string): PreviewProblem["location"] {
  for (const match of text.matchAll(/(?:^|\n)[ \t]*(?:File:\s*)?(?:\x1b\[[\d;]*m)*((?:\/app\/|\.\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[\w]+):(\d+)(?::(\d+))?(?=[\s):]|$)/g)) {
    try {
      const path = validateRelPath(match[1].replace(/^(?:\/app\/|\.\/)/, ""));
      const line = Number(match[2]);
      const column = match[3] === undefined ? undefined : Number(match[3]);
      if (!isProtectedPath(path) && path.length <= 240 && line >= 1 && line <= 1_000_000 &&
        (column === undefined || (column >= 1 && column <= 1_000_000))) return { path, line, column };
    } catch { /* Untrusted location; no editor link. */ }
  }
}

export function parsePreviewProblem(raw: string, fallback?: "startup" | "runtime"): PreviewProblem | undefined {
  const text = stripVTControlCharacters(previewOutputTail(raw));
  const dependency = /(?:^|\n)(?:npm\s+(?:ERR!|error)\s+(?:code|ci|unable|could|cannot|enoent|the)|\[omp-preview\] dependency installation failed)/i;
  const compile = /(?:\[vite\].*(?:Internal server error|Pre-transform error|Transform failed)|\[plugin:vite:[^\]]+\]|error during build:|Build failed with \d+ error)/i;
  // A startup failure can contain install output followed by Vite output.
  const marker = /\[omp-preview\] dependency installation failed/i.test(text);
  const kind = marker ? "dependency" : compile.test(text) ? "compile" : dependency.test(text) ? "dependency" : fallback;
  if (!kind) return;
  const summary = {
    dependency: "Dependency installation failed",
    compile: "Vite could not compile the project",
    startup: "The project did not start",
    runtime: "The preview runtime could not start",
  }[kind];
  const location = kind === "compile" ? sourceLocation(text) : undefined;
  const output = sanitizePreviewOutput(text);
  const detail = (output.length > 1600 ? `[Output truncated]\n${output.slice(-1580)}` : output) || summary;
  const headline = sanitizePreviewOutput(text.split("\n").find((line) => compile.test(line) || dependency.test(line)) ?? detail.split("\n")[0])
    .replace(/^\d{1,2}:\d{2}:\d{2}(?:\s+[AP]M)?\s*/i, "");
  const id = createHash("sha256").update(JSON.stringify([kind, headline, location])).digest("hex").slice(0, 20);
  return { id, severity: "error", kind, summary, detail, location, stale: false };
}

type Run = PreviewProblems & { runId: string };

export class PreviewDiagnosticStore {
  private readonly runs = new Map<string, Run>();

  begin(projectId: string): string {
    const runId = randomUUID();
    this.runs.delete(projectId);
    this.runs.set(projectId, { runId, phase: "starting", problems: [], logs: "" });
    this.prune();
    return runId;
  }

  private prune(): void {
    const inactive = [...this.runs].filter(([, run]) => run.phase !== "running" && run.phase !== "starting");
    for (const [id] of inactive.slice(0, Math.max(0, inactive.length - 100))) this.runs.delete(id);
  }

  get(projectId: string): PreviewProblems {
    return this.runs.get(projectId) ?? { runId: null, phase: "idle", problems: [], logs: "" };
  }

  phase(projectId: string, runId: string, phase: Run["phase"]): void {
    const run = this.runs.get(projectId);
    if (run?.runId !== runId) return;
    this.runs.set(projectId, { ...run, phase, problems: phase === "stopped" ? run.problems.map((problem) => ({ ...problem, stale: true })) : run.problems });
    this.prune();
  }

  changed(projectId: string): void {
    const run = this.runs.get(projectId);
    if (run?.phase !== "running") return;
    this.runs.set(projectId, { ...run, problems: run.problems.map((problem) => ({ ...problem, stale: true })) });
  }

  capture(projectId: string, runId: string, raw: string, fallback?: "startup" | "runtime"): void {
    const run = this.runs.get(projectId);
    if (run?.runId !== runId || run.phase === "stopped") return;
    const problem = parsePreviewProblem(raw, fallback);
    const logs = previewOutputTail([run.logs, sanitizePreviewOutput(raw)].filter(Boolean).join("\n"));
    const problems = problem ? [...run.problems.filter((entry) => entry.id !== problem.id), problem].slice(-MAX_PROBLEMS) : run.problems;
    this.runs.set(projectId, { ...run, logs, problems });
  }

  forget(projectId: string): void { this.runs.delete(projectId); }
}
