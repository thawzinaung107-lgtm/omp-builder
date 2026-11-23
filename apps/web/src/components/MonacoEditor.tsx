import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

/**
 * Phase 3B — thin wrapper around monaco.editor.create.
 *
 * Workers are bundled with Vite `?worker` imports (no CDN, no public/
 * copy of the vs/ folder). Direct `monaco-editor` ESM import — no
 * @monaco-editor/react, which would pull its own CDN loader.
 */

// Configure Monaco's worker factory once, before any editor is created.
const selfWithEnv = self as unknown as { MonacoEnvironment?: monaco.Environment };
if (!selfWithEnv.MonacoEnvironment) {
  selfWithEnv.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      if (label === "json") return new jsonWorker();
      if (label === "css" || label === "scss" || label === "less") return new cssWorker();
      if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
      if (label === "typescript" || label === "javascript") return new tsWorker();
      return new editorWorker();
    },
  };
}

export function MonacoEditor({
  value,
  language,
  onChange,
  readOnly = false,
  target,
}: {
  value: string;
  language: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  target?: { line: number; column?: number };
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const editor = monaco.editor.create(container, {
      value: valueRef.current,
      language,
      theme: "vs",
      readOnly,
      automaticLayout: true,
      fontFamily: "DM Sans, monospace",
      fontSize: 13,
      // Monaco takes lineHeight in px, not as a multiplier: 13px * 1.6.
      lineHeight: 21,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      tabSize: 2,
    });
    editorRef.current = editor;
    const disposable = editor.onDidChangeModelContent(() => {
      const next = editor.getValue();
      // setValue() below also fires this event; only report real user edits.
      if (next !== valueRef.current) onChangeRef.current(next);
    });
    return () => {
      disposable.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // Create once; value/language/readOnly are synced by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (file opened / reloaded from disk): push into
  // the editor. The change handler above suppresses the echo.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  // Language follows the active file's extension.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!target || !editor || !model) return;
    const position = model.validatePosition({ lineNumber: target.line, column: target.column ?? 1 });
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    editor.focus();
  }, [target]);

  return <div ref={containerRef} className="min-h-0 flex-1" aria-label="Code editor" />;
}
