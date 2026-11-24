import { redactSecrets, type Problem } from "@omp-builder/shared";

/**
 * Milestone A (A4) — parse Vite dev-server output + container logs into
 * structured problems ({file, line, column, code, message, severity}).
 *
 * The parser is deliberately line-oriented and conservative: it only
 * claims a problem for shapes it recognises (esbuild/Vite `file:line:col`
 * locations, tsc `file(line,col): error TS…`, Vite "Failed to resolve
 * import", and `Error:` headlines followed by a stack frame). Anything
 * else stays a raw log line in the Logs tab — a missed problem is better
 * than a hallucinated file/line. Container paths are `/app/…` (the
 * staging mount); the prefix is stripped so locations are
 * workspace-relative, matching the file API and the editor.
 *
 * Nothing here touches secrets: messages are redacted at parse time
 * (defence in depth — the Fix prompt redacts again), and the parser
 * never emits raw log lines, only the scoped fields above.
 */

export const MAX_PROBLEMS = 100;
const MAX_MESSAGE_CHARS = 1000;
const MAX_LINES_SCANNED = 500;

const ANSI = /\u001b\[[0-9;]*m/g;
const SOURCE_EXT = String.raw`(?:tsx?|jsx?|mts|cts|mjs|cjs|js|css|scss|json|html)`;
const TSC_RE = new RegExp(`^(.+?\\.${SOURCE_EXT})\\((\\d+),(\\d+)\\):\\s+(error|warning)\\s+(TS\\d+):\\s*(.*)$`);
const LOCATED_RE = new RegExp(`^(.+?\\.${SOURCE_EXT})\\s*:\\s*(\\d+):(\\d+)\\s*[:\\-]?\\s*(.*)$`);
const RESOLVE_RE = /Failed to resolve import\s+"([^"]+)"\s+from\s+"([^"]+)"/;
const ERROR_HEADLINE_RE = /^(Error|SyntaxError|TypeError|ReferenceError|RangeError|EvalError|URIError|AggregateError)(?::\s*(.*))?$/;
const STACK_FRAME_RE = /\(([^()\s]+):(\d+):(\d+)\)/;
const VITE_INTERNAL_ERROR_RE = /\[vite\]\s*Internal server error:\s*(.*)$/;
const WARNING_RE = /^(?:\[vite\]\s*)?Warning:\s*(.*)$/i;

function clean(line: string): string {
  return line.replace(ANSI, "").trim();
}

/** `/app/src/App.tsx` → `src/App.tsx`; `./src/App.tsx` → `src/App.tsx`. */
export function toWorkspacePath(raw: string): string {
  let file = raw.trim().replace(/^\.\//, "");
  if (file.startsWith("/app/")) file = file.slice("/app/".length);
  return file;
}

function isPlausibleFile(file: string): boolean {
  if (!file || file.includes("\0") || file.includes("..")) return false;
  if (file.startsWith("node:") || file.startsWith("internal/")) return false;
  if (/^(https?|file|vite|data):/.test(file)) return false;
  return true;
}

function makeProblem(partial: Omit<Problem, "message"> & { message: string }): Problem | null {
  const file = partial.file === null ? null : toWorkspacePath(partial.file);
  if (file !== null && !isPlausibleFile(file)) return null;
  const message = redactSecrets(partial.message.trim()).slice(0, MAX_MESSAGE_CHARS);
  if (!message) return null;
  return { file, line: partial.line, column: partial.column, code: partial.code.slice(0, 120), message, severity: partial.severity };
}

function dedupeKey(problem: Problem): string {
  return [problem.file ?? "", problem.line ?? "", problem.column ?? "", problem.code, problem.message].join("|");
}

/**
 * Parse log lines (chronological order) into structured problems.
 * `previewLastError` — the preview_state lastError for a crashed/errored
 * preview — is included as a file-less problem when supplied.
 */
export function parseProblemsFromLines(lines: string[], previewLastError?: string | null): Problem[] {
  const found: Problem[] = [];
  const seen = new Set<string>();
  const push = (problem: Problem | null): void => {
    if (!problem || found.length >= MAX_PROBLEMS) return;
    const key = dedupeKey(problem);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(problem);
  };

  const cleaned = lines.slice(-MAX_LINES_SCANNED).map(clean);
  for (let i = 0; i < cleaned.length; i += 1) {
    const line = cleaned[i];
    if (!line) continue;

    // Vite internal server error: the useful text follows the prefix.
    const viteError = VITE_INTERNAL_ERROR_RE.exec(line);
    if (viteError) {
      const rest = viteError[1];
      const resolve = RESOLVE_RE.exec(rest);
      if (resolve) {
        push(makeProblem({ file: resolve[2], line: null, column: null, code: "vite/resolve", message: rest, severity: "error" }));
      } else {
        push(makeProblem({ file: null, line: null, column: null, code: "vite/error", message: rest, severity: "error" }));
      }
      continue;
    }

    // "Failed to resolve import" on its own line.
    const resolve = RESOLVE_RE.exec(line);
    if (resolve) {
      push(makeProblem({ file: resolve[2], line: null, column: null, code: "vite/resolve", message: line, severity: "error" }));
      continue;
    }

    // tsc: src/App.tsx(12,5): error TS2307: Cannot find module 'x'
    const tsc = TSC_RE.exec(line);
    if (tsc) {
      push(
        makeProblem({
          file: tsc[1],
          line: Number(tsc[2]),
          column: Number(tsc[3]),
          code: tsc[5],
          message: tsc[6] || line,
          severity: tsc[4] === "warning" ? "warning" : "error",
        }),
      );
      continue;
    }

    // esbuild / Vite / generic: src/App.tsx:12:5: ERROR: message
    // (or with an empty message, when the headline is the previous line,
    // e.g. "✘ [ERROR] Could not resolve ..." followed by the location).
    // A stack-frame line ("at f (/app/src/x.ts:1:2)") also matches the
    // shape — it is context for an error headline, not a problem of its
    // own, so a file part containing whitespace or parens is skipped.
    const located = LOCATED_RE.exec(line);
    if (located) {
      if (/[\s()]/.test(located[1])) continue;
      let message = located[4].replace(/^\[ERROR\]\s*/i, "").replace(/^ERROR:\s*/i, "");
      let code = "build/error";
      if (!message) {
        const prev = cleaned[i - 1] ?? "";
        const headline = prev.replace(/^[✘×]\s*/u, "").replace(/^\[ERROR\]\s*/i, "").replace(/^ERROR:\s*/i, "").trim();
        message = headline || line;
      }
      if (/warning/i.test(message)) code = "build/warning";
      push(
        makeProblem({
          file: located[1],
          line: Number(located[2]),
          column: Number(located[3]),
          code,
          message,
          severity: /warning/i.test(message) ? "warning" : "error",
        }),
      );
      continue;
    }

    // Error headline: look ahead a few lines for a stack frame that
    // carries the file/line/column. Without one, keep the file-less
    // problem — a crash with no location is still worth showing.
    const headline = ERROR_HEADLINE_RE.exec(line);
    if (headline) {
      const message = headline[2] ? `${headline[1]}: ${headline[2]}` : headline[1];
      let locatedProblem: Problem | null = null;
      for (let j = i + 1; j < Math.min(i + 6, cleaned.length); j += 1) {
        const frame = STACK_FRAME_RE.exec(cleaned[j]);
        if (!frame) continue;
        const candidate = toWorkspacePath(frame[1]);
        if (!isPlausibleFile(candidate) || candidate.startsWith("node:")) continue;
        locatedProblem = makeProblem({
          file: candidate,
          line: Number(frame[2]),
          column: Number(frame[3]),
          code: headline[1],
          message,
          severity: "error",
        });
        break;
      }
      push(locatedProblem ?? makeProblem({ file: null, line: null, column: null, code: headline[1], message, severity: "error" }));
      continue;
    }

    // Plain warning lines.
    const warning = WARNING_RE.exec(line);
    if (warning && warning[1]) {
      push(makeProblem({ file: null, line: null, column: null, code: "warning", message: warning[1], severity: "warning" }));
      continue;
    }
  }

  if (previewLastError) {
    push(
      makeProblem({
        file: null,
        line: null,
        column: null,
        code: "preview/error",
        message: previewLastError,
        severity: "error",
      }),
    );
  }
  return found;
}

/** Convenience wrapper used by the endpoint: lines + preview state. */
export function collectProblems(
  lines: string[],
  preview: { status: string; lastError: string | null } | null,
): Problem[] {
  const lastError = preview && (preview.status === "crashed" || preview.status === "error") ? preview.lastError : null;
  return parseProblemsFromLines(lines, lastError);
}
