import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Milestone E (B3) — preview element picker: static script loading and
 * the server-side per-project picker flag.
 *
 * Security review conditions implemented here (see
 * PICKER-SECURITY-REVIEW.md §2.1, §5):
 *
 * - The picker script is a static file
 *   (`src/picker/picker-client.js`), loaded once at API startup,
 *   SHA-256 hash-pinned and verified before ANY injection. If the file
 *   is missing or the hash does not match the pinned value, injection
 *   is disabled (fail closed) and the mismatch is logged loudly. The
 *   injected bytes are that file, unmodified — no templating, no
 *   per-request interpolation, no credentials, no identifiers.
 * - Picker mode is a server-side per-project flag (an in-memory Set
 *   keyed by project id), set ONLY by an authenticated
 *   `POST /api/projects/:id/preview/picker {enabled}`. It is NEVER a
 *   query parameter (the iframe could set one itself) and NEVER
 *   consults client input at gateway time. The flag is cleared on
 *   preview stop / crash / error (see the preview_status handler in
 *   server.ts) and vanishes on API restart (in-memory by design).
 *
 * If you edit `picker-client.js` you MUST update PICKER_SCRIPT_SHA256
 * below to the new `sha256sum` of the file, or injection stays
 * disabled. That is intentional: the pin makes silent tampering with
 * the injected script impossible.
 */

// Pinned SHA-256 of apps/api/src/picker/picker-client.js. Recompute
// with `sha256sum apps/api/src/picker/picker-client.js` after any edit.
export const PICKER_SCRIPT_SHA256 =
  "8eb17e7a50073f25393fa67a1ab8579312352711301bc6ca3bab59237caa3a48";

const PICKER_SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "picker",
  "picker-client.js",
);

let cachedScript: string | null | undefined;

/**
 * Load + verify the picker script once; the result is cached for the
 * life of the process. Returns the script text, or null when injection
 * must stay disabled (missing file / hash mismatch — fail closed).
 */
export function loadPickerScript(): string | null {
  if (cachedScript !== undefined) return cachedScript;
  let text: string;
  try {
    text = readFileSync(PICKER_SCRIPT_PATH, "utf8");
  } catch (error) {
    console.error(
      `[picker] picker script missing at ${PICKER_SCRIPT_PATH} — injection DISABLED:`,
      error instanceof Error ? error.message : error,
    );
    cachedScript = null;
    return cachedScript;
  }
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  if (hash !== PICKER_SCRIPT_SHA256) {
    console.error(
      `[picker] picker script SHA-256 mismatch (got ${hash}, expected ${PICKER_SCRIPT_SHA256}) — injection DISABLED. ` +
        `Update PICKER_SCRIPT_SHA256 in picker.ts if the script changed intentionally.`,
    );
    cachedScript = null;
    return cachedScript;
  }
  console.log(`[picker] picker script verified (sha256 ${hash.slice(0, 12)}…)`);
  cachedScript = text;
  return cachedScript;
}

// --- Server-side per-project picker flag (in-memory) -------------------
const enabledProjects = new Set<string>();

export function setPickerEnabled(projectId: string, enabled: boolean): void {
  if (enabled) enabledProjects.add(projectId);
  else enabledProjects.delete(projectId);
}

export function isPickerEnabled(projectId: string): boolean {
  return enabledProjects.has(projectId);
}

export function clearPickerEnabled(projectId: string): void {
  enabledProjects.delete(projectId);
}
