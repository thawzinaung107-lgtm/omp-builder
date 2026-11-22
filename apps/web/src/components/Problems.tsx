import { useEffect, useState } from "react";
import type { PreviewProblem, PreviewProblems } from "@omp-builder/shared";
import { api } from "../api";

export function Problems({ projectId, onOpen, onFix }: {
  projectId: string;
  onOpen: (location: NonNullable<PreviewProblem["location"]>) => void;
  onFix: (problem: PreviewProblem) => void;
}) {
  const [snapshot, setSnapshot] = useState<PreviewProblems>();
  const [error, setError] = useState(false);
  const [logs, setLogs] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api.previewProblems(projectId, controller.signal);
        if (!controller.signal.aborted) {
          setSnapshot(result);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 1500);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId]);

  return (
    <section className="min-h-0 min-w-0 flex-1 overflow-auto p-4 text-sm" aria-label="Preview problems">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-omp-ink">Problems</h2>
        {snapshot?.runId && <button type="button" aria-expanded={logs} onClick={() => setLogs(!logs)} className="rounded border border-omp-border px-2 py-1">
          {logs ? "Hide Logs" : "View Logs"}
        </button>}
      </div>
      {error ? <p role="status">Could not load current problems. Retrying…</p> : !snapshot ? <p role="status">Loading problems…</p> : <>
        <p role="status" className="mb-3 text-omp-muted">
          {snapshot.phase === "starting" ? "Checking preview startup…" :
            snapshot.phase === "stopped" ? "Preview stopped. Any listed problems are from its last run." :
            snapshot.phase === "running" && !snapshot.problems.some((problem) => !problem.stale) ? "Preview is running. No current problems reported." :
            snapshot.phase === "idle" ? "Start the preview to check for problems." :
            snapshot.problems.length ? "Review the problems reported by the preview." : "No problems reported."}
        </p>
        {logs && <pre className="mb-3 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-omp-border bg-white p-3">{snapshot.logs || "No captured output for this run."}</pre>}
        <ul key={snapshot.runId} className="space-y-3">
          {snapshot.problems.map((problem) => <li key={problem.id} className="min-w-0 rounded border border-omp-border bg-white p-3">
            <p className="font-semibold">{problem.summary}</p>
            <p className="mt-1 text-xs text-omp-muted">
              {problem.severity === "error" ? "Error" : "Warning"} · {problem.stale ? "May be stale" : "Current run"}
            </p>
            {problem.location && <p className="mt-1 break-all font-mono text-xs">
              {problem.location.path}:{problem.location.line}{problem.location.column === undefined ? "" : `:${problem.location.column}`}
            </p>}
            <details className="mt-2">
              <summary className="cursor-pointer">Details</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{problem.detail}</pre>
            </details>
            <div className="mt-3 flex flex-wrap gap-3 font-medium text-omp-brand">
              {problem.location && <button type="button" onClick={() => onOpen(problem.location!)}>Open in Code</button>}
              <button type="button" onClick={() => onFix(problem)}>Fix with OMP</button>
            </div>
          </li>)}
        </ul>
      </>}
    </section>
  );
}
