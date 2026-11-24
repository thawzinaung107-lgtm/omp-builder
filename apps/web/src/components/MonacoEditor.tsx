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
 *
 * Milestone B (A3) — retained/shared Monaco model cache. One text model
 * per open file path, kept in a module-level cache: switching files
 * calls `editor.setModel(model)` instead of remounting the editor (the
 * old `key={activeFile.path}` remount threw away each file's undo
 * history on every switch). Each model's undo stack, cursor and
 * selections survive file switches, tab switches, and editor remounts.
 * Models are disposed only when the file is closed
 * (`disposeEditorModel`) or the page unloads. External content changes
 * (reload from disk, agent edits) push into the model with setValue —
 * that one case does reset that file's undo stack, which is the correct
 * trade-off: the on-disk content is the new truth.
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

type CachedModel = { model: monaco.editor.ITextModel; refCount: number };
const modelCache = new Map<string, CachedModel>();

function modelUri(path: string): monaco.Uri {
  // One stable URI per workspace path, so getModel() finds the cached model.
  return monaco.Uri.parse(`inmemory://omp-builder/${encodeURIComponent(path)}`);
}

/** Get (or create) the retained model for a path; refcounted. */
export function acquireEditorModel(path: string, language: string, initialContent: string): monaco.editor.ITextModel {
  const cached = modelCache.get(path);
  if (cached) {
    cached.refCount += 1;
    monaco.editor.setModelLanguage(cached.model, language);
    return cached.model;
  }
  const existing = monaco.editor.getModel(modelUri(path));
  const model = existing ?? monaco.editor.createModel(initialContent, language, modelUri(path));
  if (existing) monaco.editor.setModelLanguage(model, language);
  modelCache.set(path, { model, refCount: 1 });
  return model;
}

function releaseEditorModel(path: string): void {
  const cached = modelCache.get(path);
  if (!cached) return;
  cached.refCount -= 1;
  if (cached.refCount <= 0) {
    modelCache.delete(path);
    cached.model.dispose();
  }
}

/** Dispose the cached model for a closed file (frees memory + undo stack). */
export function disposeEditorModel(path: string): void {
  const cached = modelCache.get(path);
  if (!cached) return;
  modelCache.delete(path);
  cached.model.dispose();
}

export function MonacoEditor({
  path,
  value,
  language,
  onChange,
  readOnly = false,
  revealLine = null,
  onBlur,
}: {
  /** Workspace path — the model-cache key. Switching paths swaps models. */
  path: string;
  value: string;
  language: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  /**
   * Milestone A (A4) — when set, the editor scrolls this 1-based line
   * into view and places the cursor there (Problems-row deep-link).
   * Milestone B (A3) generalises it: `openFile(path, line)` is the
   * shared `selectedFile {path, line}` deep-link for Problems rows and
   * diff rows alike. The effect runs when the path or the line changes.
   */
  revealLine?: number | null;
  /** Milestone B (A3) — save-on-blur hook; fired when editor text loses focus. */
  onBlur?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const modelPathRef = useRef<string | null>(null);
  const changeDisposableRef = useRef<monaco.IDisposable | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  valueRef.current = value;
  onChangeRef.current = onChange;
  onBlurRef.current = onBlur;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const editor = monaco.editor.create(container, {
      model: null,
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
    const blurDisposable = editor.onDidBlurEditorText(() => {
      onBlurRef.current?.();
    });
    return () => {
      blurDisposable.dispose();
      changeDisposableRef.current?.dispose();
      changeDisposableRef.current = null;
      if (modelPathRef.current) {
        releaseEditorModel(modelPathRef.current);
        modelPathRef.current = null;
      }
      modelRef.current = null;
      editor.dispose();
      editorRef.current = null;
    };
    // Create once; path/value/language/readOnly are synced by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach the retained model for the active path (create on first open).
  // Switching paths swaps models — undo history, cursor and selections
  // for each file survive in its cached model.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (modelPathRef.current === path && modelRef.current) return;
    changeDisposableRef.current?.dispose();
    if (modelPathRef.current) releaseEditorModel(modelPathRef.current);
    const model = acquireEditorModel(path, language, valueRef.current);
    modelRef.current = model;
    modelPathRef.current = path;
    // Sync content on switch: a file reloaded from disk (or edited by
    // the agent) while inactive has newer content than its cached model.
    // setValue is a no-op for the common case (content already matches).
    if (model.getValue() !== valueRef.current) model.setValue(valueRef.current);
    editor.setModel(model);
    changeDisposableRef.current = editor.onDidChangeModelContent(() => {
      const next = model.getValue();
      // setValue() below also fires this event; only report real user edits.
      if (next !== valueRef.current) onChangeRef.current(next);
    });
    // Reveal after a model switch when a deep-link line is set.
    if (revealLine && revealLine >= 1) {
      const line = Math.min(revealLine, model.getLineCount());
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // External value changes (file opened / reloaded from disk / agent
  // edit): push into the retained model. The change handler above
  // suppresses the echo.
  useEffect(() => {
    const model = modelRef.current;
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);

  // Language follows the active file's extension.
  useEffect(() => {
    const model = modelRef.current;
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  // Milestone A (A4) — Problems deep-link: reveal + cursor, no selection.
  // Runs when the line changes for the same file (e.g. clicking another
  // problem row for the file that is already open).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !revealLine || revealLine < 1) return;
    const model = editor.getModel();
    if (!model) return;
    const line = Math.min(revealLine, model.getLineCount());
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }, [revealLine]);

  return <div ref={containerRef} className="min-h-0 flex-1" aria-label="Code editor" />;
}
