import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
// Monaco workers are configured once by MonacoEditor.tsx (imported by the
// Builder alongside this component); this module only creates the diff
// editor and its two throwaway models.

/**
 * Milestone B (A2) — read-only Monaco DiffEditor (original vs modified)
 * for the chat "Modified files" card. The original side is the
 * pre-prompt snapshot content; the modified side is the current on-disk
 * content. Added files show empty vs current; deleted files show the
 * snapshot vs empty. Both models are created per mount and disposed on
 * unmount — diffs are views, never edited, so no model cache is needed.
 */
export function MonacoDiffEditor({
  original,
  modified,
  language,
  originalLabel = "Before",
  modifiedLabel = "After",
}: {
  original: string;
  modified: string;
  language: string;
  originalLabel?: string;
  modifiedLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);
  const propsRef = useRef({ original, modified, language });
  propsRef.current = { original, modified, language };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const { original: orig, modified: mod, language: lang } = propsRef.current;
    const originalModel = monaco.editor.createModel(orig, lang);
    const modifiedModel = monaco.editor.createModel(mod, lang);
    modelsRef.current = { original: originalModel, modified: modifiedModel };
    const diff = monaco.editor.createDiffEditor(container, {
      theme: "vs",
      readOnly: true,
      automaticLayout: true,
      fontFamily: "DM Sans, monospace",
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      renderSideBySide: true,
      originalEditable: false,
    });
    diff.setModel({ original: originalModel, modified: modifiedModel });
    diffRef.current = diff;
    return () => {
      diff.dispose();
      diffRef.current = null;
      originalModel.dispose();
      modifiedModel.dispose();
      modelsRef.current = null;
    };
    // Create once per mount; content/language changes remount via key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-4 border-b border-omp-border bg-white px-4 py-1.5 text-xs text-omp-muted">
        <span>
          <span className="font-semibold text-omp-ink">Before</span> — {originalLabel}
        </span>
        <span>
          <span className="font-semibold text-omp-ink">After</span> — {modifiedLabel}
        </span>
        <span className="ml-auto">Read-only diff</span>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" aria-label="File diff viewer" />
    </div>
  );
}
