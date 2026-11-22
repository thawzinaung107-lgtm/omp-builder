/**
 * Phase 3B — file-extension to Monaco language id mapping.
 *
 * Kept in a plain module (no React) so the test suite can compile and
 * import it directly with tsc. Unknown or extension-less paths fall back
 * to "plaintext".
 */

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  sql: "sql",
};

export function languageForPath(filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  // No dot, or a dotfile with no extension (".gitignore").
  if (dot <= 0) return "plaintext";
  const ext = name.slice(dot + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}
