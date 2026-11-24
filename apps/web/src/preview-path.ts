/**
 * Milestone B (A5) — validate a preview path input. The path must stay
 * inside the gateway origin: absolute, no backslashes, no "//", no
 * query/hash, no "." / ".." segments, and only URL-safe characters.
 * Returns the normalised path, or null when it is not navigable.
 * Pure function (no React) so the Node test suite can import it.
 */
export function normalizePreviewPath(input: string): string | null {
  let next = input.trim();
  if (next === "") return "/";
  if (!next.startsWith("/")) next = `/${next}`;
  if (next.includes("\\") || next.includes("//") || next.includes("?") || next.includes("#")) return null;
  const segments = next.split("/").filter(Boolean);
  if (segments.includes("..") || segments.includes(".")) return null;
  if (!/^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]+$/.test(next)) return null;
  return next;
}
