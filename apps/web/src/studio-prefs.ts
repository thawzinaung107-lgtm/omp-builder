/**
 * Milestone A (A7) — persistent per-project studio preferences.
 *
 * Stored in localStorage only (approved decision: no server-side prefs),
 * one key per project: `omp-builder-studio-prefs:<projectId>`. The
 * existing global keys (`omp-builder-default-provider`,
 * `omp-builder-remembered-email`) are untouched — this module never
 * reads or writes them.
 *
 * Persisted: active workspace tab, Split toggle, preview device width
 * (desktop / tablet 768px / mobile 390px), open editor files (paths
 * only — file contents are re-read from disk on restore, so unsaved
 * edits are NOT restored), the active file, expanded folders in the
 * file tree, the save-on-blur toggle, and the console-drawer open state.
 * Milestone D (B2) — the active chat session and per-chat composer
 * drafts, so switching tabs and reloading restore the conversation
 * the user was in (chat history itself is server-side, replayed from
 * the persisted event stream).
 * Panel sizes live in this same object (`chatLayout` / `codeLayout`,
 * maps of panel id → percentage): react-resizable-panels v4 has no
 * autoSaveId, so the Builder passes the stored layout as `defaultLayout`
 * and saves it back from `onLayoutChanged` (user drags only).
 *
 * Everything is validated on load: corrupt JSON, unknown tabs, or
 * wrong-typed fields fall back to defaults instead of crashing the
 * studio. Caps keep a hostile or stale entry from growing storage
 * without bound. All functions are safe to call when localStorage is
 * unavailable (private mode, SSR, tests) — they no-op to defaults.
 */

export type StudioDevice = "desktop" | "tablet" | "mobile";

export type StudioPrefs = {
  tab: string;
  split: boolean;
  device: StudioDevice;
  openFiles: string[];
  activePath: string | null;
  expandedDirs: string[];
  /** Milestone B (A3) — save-on-blur toggle; default off. */
  saveOnBlur: boolean;
  /** Milestone B (A6) — console drawer open/collapsed. */
  consoleOpen: boolean;
  /** Milestone B (A6) — resizable-panel layouts (panel id → percentage
   * of the group, 0–100), for the chat/workspace split (`chat` /
   * `workspace`) and the code tree/editor split (`code-tree` /
   * `code-editor`). Null until the user drags a separator once. */
  chatLayout: Record<string, number> | null;
  codeLayout: Record<string, number> | null;
  /** Milestone D (B2) — active chat session id (null until loaded). */
  activeChatId: string | null;
  /** Milestone D (B2) — unsent composer text per chat session id. */
  chatDrafts: Record<string, string>;
};

export const MAX_CHAT_DRAFTS = 20;
export const MAX_CHAT_DRAFT_CHARS = 4000;
export const STUDIO_PREFS_KEY_PREFIX = "omp-builder-studio-prefs:";
export const MAX_OPEN_FILES = 50;
export const MAX_EXPANDED_DIRS = 200;

export const STUDIO_TABS = ["preview", "code", "files", "logs", "git", "problems"] as const;

export function studioPrefsKey(projectId: string): string {
  return `${STUDIO_PREFS_KEY_PREFIX}${projectId}`;
}

export function defaultStudioPrefs(): StudioPrefs {
  return { tab: "preview", split: false, device: "desktop", openFiles: [], activePath: null, expandedDirs: [], saveOnBlur: false, consoleOpen: false, chatLayout: null, codeLayout: null, activeChatId: null, chatDrafts: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Milestone B (A6) — validate a stored panel layout: an object of
 * panel id → percentage (finite, 0–100); anything else is dropped, and
 * an empty result is null (use the built-in defaults instead). */
export function parsePanelLayout(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === "" || typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 100) continue;
    out[key] = entry;
    if (Object.keys(out).length >= 5) break;
  }
  return Object.keys(out).length ? out : null;
}

function stringList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") continue;
    if (!out.includes(item)) out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/** Validate + sanitize an unknown value into StudioPrefs (never throws). */
export function parseStudioPrefs(raw: unknown): StudioPrefs {
  const defaults = defaultStudioPrefs();
  if (!isRecord(raw)) return defaults;
  const tab = typeof raw.tab === "string" && (STUDIO_TABS as readonly string[]).includes(raw.tab) ? raw.tab : defaults.tab;
  const split = typeof raw.split === "boolean" ? raw.split : defaults.split;
  const device: StudioDevice = raw.device === "mobile" ? "mobile" : raw.device === "tablet" ? "tablet" : "desktop";
  const openFiles = stringList(raw.openFiles, MAX_OPEN_FILES);
  const activePath = typeof raw.activePath === "string" && raw.activePath !== "" ? raw.activePath : null;
  const expandedDirs = stringList(raw.expandedDirs, MAX_EXPANDED_DIRS);
  const saveOnBlur = typeof raw.saveOnBlur === "boolean" ? raw.saveOnBlur : defaults.saveOnBlur;
  const consoleOpen = typeof raw.consoleOpen === "boolean" ? raw.consoleOpen : defaults.consoleOpen;
  const chatLayout = parsePanelLayout(raw.chatLayout);
  const codeLayout = parsePanelLayout(raw.codeLayout);
  const activeChatId = typeof raw.activeChatId === "string" && raw.activeChatId !== "" ? raw.activeChatId : null;
  const chatDrafts: Record<string, string> = {};
  if (isRecord(raw.chatDrafts)) {
    for (const [key, entry] of Object.entries(raw.chatDrafts)) {
      if (key.trim() === "" || typeof entry !== "string") continue;
      const text = entry.slice(0, MAX_CHAT_DRAFT_CHARS);
      if (text) chatDrafts[key] = text;
      if (Object.keys(chatDrafts).length >= MAX_CHAT_DRAFTS) break;
    }
  }
  return { tab, split, device, openFiles, activePath, expandedDirs, saveOnBlur, consoleOpen, chatLayout, codeLayout, activeChatId, chatDrafts };
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadStudioPrefs(projectId: string): StudioPrefs {
  const store = storage();
  if (!store) return defaultStudioPrefs();
  try {
    const raw = store.getItem(studioPrefsKey(projectId));
    if (!raw) return defaultStudioPrefs();
    return parseStudioPrefs(JSON.parse(raw) as unknown);
  } catch {
    return defaultStudioPrefs();
  }
}

export function saveStudioPrefs(projectId: string, prefs: StudioPrefs): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(studioPrefsKey(projectId), JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: prefs are best-effort, never fatal.
  }
}
