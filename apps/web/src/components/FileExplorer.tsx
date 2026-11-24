import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, File as FileIcon, FilePlus2, Folder, FolderPlus, Pencil, RefreshCw, Search, Trash2, X } from "lucide-react";
import { api, type FileTreeEntry } from "../api";
import { Button, EmptyState, inputClass } from "../ui";

/* Phase 3A — workspace file explorer. Tree only; editing arrives in 3B. */

function filterTree(entries: FileTreeEntry[], query: string): FileTreeEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const out: FileTreeEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "dir") {
      const children = filterTree(entry.children ?? [], q);
      if (children.length) out.push({ ...entry, children });
      else if (entry.name.toLowerCase().includes(q)) out.push({ ...entry, children: entry.children ?? [] });
    } else if (entry.name.toLowerCase().includes(q) || entry.path.toLowerCase().includes(q)) {
      out.push(entry);
    }
  }
  return out;
}

function countFiles(entries: FileTreeEntry[]): number {
  return entries.reduce((n, e) => n + (e.type === "file" ? 1 : countFiles(e.children ?? [])), 0);
}

export function FileExplorer({
  projectId,
  changedFiles,
  dirtyFiles = [],
  refreshToken,
  onSelectFile,
  initialExpanded,
  onExpandedChange,
}: {
  projectId: string;
  changedFiles: string[];
  /** Milestone B (A3) — paths with unsaved editor buffers; shown as an
   * amber dot next to the file name. Coexists with the agent-"Modified"
   * badge (a file can carry both). */
  dirtyFiles?: string[];
  refreshToken: number;
  onSelectFile?: (path: string) => void;
  /** Milestone A (A7) — folders to expand on first load, restored from
   * per-project prefs. When absent, the first level expands as before. */
  initialExpanded?: string[] | null;
  /** Milestone A (A7) — reports the expanded set whenever it changes so
   * the Builder can persist it. */
  onExpandedChange?: (paths: string[]) => void;
}) {
  const [tree, setTree] = useState<FileTreeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [createType, setCreateType] = useState<"file" | "dir" | null>(null);
  const [createName, setCreateName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<{ path: string; name: string; isDir: boolean } | null>(null);
  const [deleteRecursive, setDeleteRecursive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const renameGuard = useRef<string | null>(null);
  // Milestone A (A7): the restored expansion is a first-load seed only
  // (captured in a ref so later prop updates can't re-seed the tree).
  const initialExpandedRef = useRef(initialExpanded);
  // Milestone A (A7): report expansion changes to the Builder for
  // persistence. The last-reported join is tracked so the callback
  // fires only on a real change (never a render loop: the Builder
  // stores the value and passes a new array back as a prop).
  const lastReportedExpanded = useRef<string>("");
  useEffect(() => {
    if (!onExpandedChange) return;
    const key = [...expanded].sort().join("\n");
    if (key === lastReportedExpanded.current) return;
    lastReportedExpanded.current = key;
    onExpandedChange([...expanded]);
  }, [expanded, onExpandedChange]);

  const changedSet = useMemo(() => new Set(changedFiles), [changedFiles]);
  const dirtySet = useMemo(() => new Set(dirtyFiles), [dirtyFiles]);
  const changedAncestors = useMemo(() => {
    const ancestors = new Set<string>();
    for (const file of changedFiles) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i += 1) ancestors.add(parts.slice(0, i).join("/"));
    }
    return ancestors;
  }, [changedFiles]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.listFiles(projectId);
      setTree(result.tree);
      setExpanded((current) => {
        if (current.size) return current;
        // Milestone A (A7): restore the persisted expansion when the
        // Builder has one; otherwise expand the first level as before.
        if (initialExpandedRef.current && initialExpandedRef.current.length) return new Set(initialExpandedRef.current);
        // Expand the first level on first load so the tree is not empty-looking.
        return new Set(result.tree.filter((e) => e.type === "dir").map((e) => e.path));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load files");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const visibleTree = useMemo(() => filterTree(tree, query), [tree, query]);
  const searching = query.trim() !== "";

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const selectedDir = useMemo(() => {
    if (!selected) return "";
    const find = (entries: FileTreeEntry[]): FileTreeEntry | null => {
      for (const entry of entries) {
        if (entry.path === selected) return entry;
        if (entry.type === "dir") {
          const hit = find(entry.children ?? []);
          if (hit) return hit;
        }
      }
      return null;
    };
    const entry = find(tree);
    if (!entry) return "";
    if (entry.type === "dir") return entry.path;
    const slash = entry.path.lastIndexOf("/");
    return slash < 0 ? "" : entry.path.slice(0, slash);
  }, [selected, tree]);

  const runOp = async (op: () => Promise<unknown>, doneMessage?: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await op();
      if (doneMessage) setNotice(doneMessage);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = () => {
    const name = createName.trim();
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      setError("Enter a file or folder name without slashes.");
      return;
    }
    const type = createType ?? "file";
    const path = selectedDir ? `${selectedDir}/${name}` : name;
    setCreateType(null);
    setCreateName("");
    void runOp(() => api.createEntry(projectId, path, type), `Created ${path}`);
  };

  const submitRename = (from: string) => {
    const name = renameValue.trim();
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      setError("Enter a name without slashes.");
      return;
    }
    // Enter and blur can both fire for one edit; only submit once.
    if (renameGuard.current === from) return;
    renameGuard.current = from;
    const slash = from.lastIndexOf("/");
    const to = slash < 0 ? name : `${from.slice(0, slash + 1)}${name}`;
    if (to === from) {
      setRenaming(null);
      return;
    }
    setRenaming(null);
    void runOp(() => api.renameEntry(projectId, from, to), `Renamed to ${to}`);
  };

  const submitDelete = (target: { path: string; name: string; isDir: boolean }) => {
    setConfirmingDelete(null);
    setDeleteRecursive(false);
    if (selected === target.path) setSelected(null);
    void runOp(() => api.deleteEntry(projectId, target.path, target.isDir ? deleteRecursive : undefined), `Deleted ${target.path}`);
  };

  const renderRow = (entry: FileTreeEntry, depth: number): ReactNode => {
    const isDir = entry.type === "dir";
    const isOpen = expanded.has(entry.path) || searching;
    const isSelected = selected === entry.path;
    const changed = changedSet.has(entry.path) || (isDir && changedAncestors.has(entry.path));
    const children = entry.children ?? [];
    return (
      <div key={entry.path}>
        <div
          className={`group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${isSelected ? "bg-omp-brandSubtle text-omp-brand" : "text-omp-ink hover:bg-omp-canvas"}`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          {isDir ? (
            <button type="button" onClick={() => toggle(entry.path)} aria-label={isOpen ? "Collapse folder" : "Expand folder"} className="shrink-0 rounded p-0.5 text-omp-muted hover:text-omp-ink">
              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <span className="w-[18px] shrink-0" />
          )}
          {renaming === entry.path ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename(entry.path);
                if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={() => submitRename(entry.path)}
              className="min-w-0 flex-1 rounded border border-omp-brand bg-white px-1.5 py-0.5 text-sm text-omp-ink outline-none"
              aria-label="New name"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                if (isDir) {
                  toggle(entry.path);
                  setSelected(entry.path);
                } else {
                  setSelected(entry.path);
                  onSelectFile?.(entry.path);
                }
              }}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              {isDir ? <Folder size={15} className="shrink-0 text-omp-brand" /> : <FileIcon size={15} className="shrink-0 text-omp-muted" />}
              <span className="min-w-0 truncate">{entry.name}</span>
              {!isDir && dirtySet.has(entry.path) && (
                <span title="Unsaved changes" className="h-2 w-2 shrink-0 rounded-full bg-[#e8a13a]" aria-label={`Unsaved changes in ${entry.name}`} />
              )}
              {changed && (
                <span title="Changed in this session" className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-[#9a6b12]">
                  <span className="h-2 w-2 rounded-full bg-[#e8a13a]" /> Modified
                </span>
              )}
            </button>
          )}
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              title={`Rename ${entry.name}`}
              aria-label={`Rename ${entry.name}`}
              onClick={() => {
                renameGuard.current = null;
                setRenaming(entry.path);
                setRenameValue(entry.name);
              }}
              className="rounded p-1 text-omp-muted hover:bg-white hover:text-omp-ink"
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              title={`Delete ${entry.name}`}
              aria-label={`Delete ${entry.name}`}
              onClick={() => {
                setConfirmingDelete({ path: entry.path, name: entry.name, isDir });
                setDeleteRecursive(false);
              }}
              className="rounded p-1 text-omp-muted hover:bg-white hover:text-[#c73e3e]"
            >
              <Trash2 size={13} />
            </button>
          </span>
        </div>
        {isDir && isOpen && children.map((child) => renderRow(child, depth + 1))}
        {isDir && isOpen && children.length === 0 && <p className="py-1 pl-10 text-xs text-omp-muted">Empty folder</p>}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-omp-border px-4 py-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-omp border border-omp-border bg-omp-canvas px-3 py-2">
          <Search size={14} className="shrink-0 text-omp-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            className="min-w-0 flex-1 bg-transparent text-sm text-omp-ink outline-none placeholder:text-omp-muted/70"
            aria-label="Search files"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="text-omp-muted hover:text-omp-ink">
              <X size={14} />
            </button>
          )}
        </label>
        <Button variant="outline" className="!px-3 !py-2 !text-xs" disabled={busy} onClick={() => { setCreateType("file"); setCreateName(""); }}>
          <FilePlus2 size={14} /> File
        </Button>
        <Button variant="outline" className="!px-3 !py-2 !text-xs" disabled={busy} onClick={() => { setCreateType("dir"); setCreateName(""); }}>
          <FolderPlus size={14} /> Folder
        </Button>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy || loading}
          className="rounded-md p-2 text-omp-muted hover:bg-omp-canvas disabled:opacity-40"
          aria-label="Refresh file tree"
          title="Refresh file tree"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
        </button>
      </div>

      {createType && (
        <div className="flex shrink-0 items-center gap-2 border-b border-omp-border bg-omp-brandSubtle/50 px-4 py-2.5">
          <span className="text-xs font-medium text-omp-muted">
            New {createType} in {selectedDir || "project root"}:
          </span>
          <input
            autoFocus
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
              if (e.key === "Escape") setCreateType(null);
            }}
            placeholder={createType === "file" ? "name.ts" : "folder-name"}
            className={`${inputClass} !w-56 !py-1.5 !text-sm`}
            aria-label="New entry name"
          />
          <Button className="!px-3 !py-1.5 !text-xs" disabled={busy || !createName.trim()} onClick={submitCreate}>
            Create
          </Button>
          <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => setCreateType(null)}>
            Cancel
          </Button>
        </div>
      )}

      {confirmingDelete && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#f6c6c6] bg-[#fdecec] px-4 py-2.5 text-sm text-[#a83232]">
          <span>
            Delete <strong>{confirmingDelete.name}</strong>?
          </span>
          {confirmingDelete.isDir && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs">
              <input type="checkbox" checked={deleteRecursive} onChange={(e) => setDeleteRecursive(e.target.checked)} />
              Delete contents too
            </label>
          )}
          <span className="ml-auto flex items-center gap-2">
            <Button variant="danger" className="!px-3 !py-1.5 !text-xs" disabled={busy} onClick={() => submitDelete(confirmingDelete)}>
              Confirm delete
            </Button>
            <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => setConfirmingDelete(null)}>
              Cancel
            </Button>
          </span>
        </div>
      )}

      {(error || notice) && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-omp-border bg-white px-4 py-2 text-xs">
          {error ? (
            <span className="text-[#a83232]">{error}</span>
          ) : (
            <span className="text-omp-success">{notice}</span>
          )}
          <button type="button" onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss" className="text-omp-muted hover:text-omp-ink">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
        {loading && tree.length === 0 ? (
          <p className="py-10 text-center text-sm text-omp-muted">Loading files…</p>
        ) : tree.length === 0 ? (
          <EmptyState
            icon={<Folder size={20} />}
            title="No files yet"
            body="This workspace is empty. Ask OMP to build something, or create your first file."
            action={
              <Button variant="outline" onClick={() => { setCreateType("file"); setCreateName(""); }}>
                <FilePlus2 size={14} /> Create a file
              </Button>
            }
          />
        ) : visibleTree.length === 0 ? (
          <p className="py-10 text-center text-sm text-omp-muted">No files match “{query}”.</p>
        ) : (
          visibleTree.map((entry) => renderRow(entry, 0))
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-omp-border bg-white px-4 py-2 text-xs text-omp-muted">
        <span>
          {countFiles(tree)} file{countFiles(tree) === 1 ? "" : "s"}
          {selected ? ` • Selected: ${selected}` : ""}
        </span>
        {changedFiles.length > 0 && <span className="text-[#9a6b12]">{changedFiles.length} modified this session</span>}
      </div>
    </div>
  );
}
