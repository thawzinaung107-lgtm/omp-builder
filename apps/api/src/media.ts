import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MEDIA_DIR,
  MEDIA_MAX_BYTES,
  mediaMimeTypeForExtension,
  sanitizeMediaFilename,
  type MediaImage,
} from "@omp-builder/shared";
import { FileError, resolveWorkspacePath } from "./files.js";

/**
 * Milestone E (B7) — binary-safe project media (images only).
 *
 * Images live under the workspace `images/` directory and are the only
 * binary content the API reads or serves: the text file API still
 * rejects binaries with 415, and this module never serves anything
 * outside `images/` or outside the allow-list. Every path goes through
 * files.ts `resolveWorkspacePath` (traversal / symlink / protected-path
 * checks), and symlinks are refused outright. Uploaded bytes are
 * verified against the file's magic bytes — an extension alone is
 * never trusted — and writes are atomic (temp file + rename), like
 * the text file API.
 *
 * Thumbnails are served by the authenticated API media endpoint
 * (`GET /api/projects/:id/media/:name`, admin session cookie, same
 * origin, `cache-control: no-store`), NOT by a public URL. The
 * preview gateway cannot serve them: it only proxies the running
 * preview container, so thumbnails would vanish whenever the preview
 * is stopped. The generated app itself references `/images/<name>`,
 * which the gateway serves from the container while the preview runs.
 */

export { MEDIA_MAX_BYTES };

const EXT_TO_MAGIC: Record<string, (data: Buffer) => boolean> = {
  ".png": (data) =>
    data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a,
  ".jpg": (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  ".jpeg": (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  ".gif": (data) =>
    data.length >= 6 &&
    (data.toString("ascii", 0, 6) === "GIF87a" || data.toString("ascii", 0, 6) === "GIF89a"),
  ".webp": (data) =>
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP",
};

/** Detect an image type from magic bytes; null when the bytes match no allow-listed type. */
export function detectImageType(data: Buffer): string | null {
  for (const [extension, matches] of Object.entries(EXT_TO_MAGIC)) {
    try {
      if (matches(data)) return extension;
    } catch {
      // A malformed check — treat as no match.
    }
  }
  return null;
}

function mediaError(status: number, message: string): FileError {
  return new FileError(status, message);
}

/** Sanitize + validate an image filename, mapping errors to FileError 400. */
export function assertMediaName(raw: unknown): string {
  try {
    return sanitizeMediaFilename(raw);
  } catch (error) {
    throw mediaError(400, error instanceof Error ? error.message : "Invalid image filename");
  }
}

/** Validate uploaded bytes: size cap, then magic bytes must match the filename extension. */
export function assertImageBytes(filename: string, data: Buffer): void {
  if (data.length === 0) throw mediaError(400, "Uploaded image is empty");
  if (data.length > MEDIA_MAX_BYTES) {
    throw mediaError(413, `Image exceeds the ${MEDIA_MAX_BYTES / (1024 * 1024)} MB size limit`);
  }
  const extension = path.extname(filename).toLowerCase();
  const detected = detectImageType(data);
  if (detected === null) {
    throw mediaError(415, "Uploaded file is not a supported image (jpeg, png, gif or webp)");
  }
  // .jpg and .jpeg share the JPEG magic; both are accepted for either.
  const jpeg = extension === ".jpg" || extension === ".jpeg";
  const detectedJpeg = detected === ".jpg" || detected === ".jpeg";
  if (!(extension === detected || (jpeg && detectedJpeg))) {
    throw mediaError(415, `Uploaded file content (${detected.slice(1)}) does not match its '.${extension.slice(1)}' extension`);
  }
}

function toImageEntry(name: string, size: number, mtimeMs: number): MediaImage {
  const mimeType = mediaMimeTypeForExtension(path.extname(name).toLowerCase()) ?? "application/octet-stream";
  return {
    path: `${MEDIA_DIR}/${name}`,
    name,
    size,
    mimeType,
    mtime: new Date(mtimeMs).toISOString(),
    mtimeMs,
  };
}

/** List the workspace's images (missing `images/` dir → empty list). */
export async function listMedia(projectsRoot: string, projectId: string): Promise<MediaImage[]> {
  const imagesDir = await resolveWorkspacePath(projectsRoot, projectId, MEDIA_DIR).catch((error) => {
    if (error instanceof FileError && error.status === 404) return null;
    throw error;
  });
  if (imagesDir === null) return [];
  let dirents;
  try {
    dirents = await readdir(imagesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const images: MediaImage[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || dirent.isSymbolicLink()) continue;
    let name: string;
    try {
      name = assertMediaName(dirent.name);
    } catch {
      continue; // A non-image file placed in images/ by other means is skipped, never served.
    }
    const info = await stat(path.join(imagesDir, dirent.name)).catch(() => null);
    if (!info || !info.isFile()) continue;
    images.push(toImageEntry(name, info.size, info.mtimeMs));
  }
  images.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return images;
}

export type MediaFile = MediaImage & { data: Buffer };

/** Binary-safe read of one workspace image. Refuses symlinks and non-images. */
export async function readMediaFile(projectsRoot: string, projectId: string, rawName: unknown): Promise<MediaFile> {
  const name = assertMediaName(rawName);
  const absolute = await resolveWorkspacePath(projectsRoot, projectId, `${MEDIA_DIR}/${name}`);
  const linkInfo = await lstat(absolute).catch(() => null);
  if (linkInfo === null) throw mediaError(404, "Image not found");
  if (linkInfo.isSymbolicLink()) throw mediaError(403, "Image is a symbolic link and cannot be served");
  if (!linkInfo.isFile()) throw mediaError(404, "Image not found");
  if (linkInfo.size > MEDIA_MAX_BYTES) throw mediaError(413, "Image exceeds the 5 MB size limit");
  const data = await readFile(absolute);
  // Re-verify content on read: a file placed in images/ by another
  // route (file API, OMP, git restore) is served only if it really is
  // the image type its extension claims.
  try {
    assertImageBytes(name, data);
  } catch (error) {
    if (error instanceof FileError && error.status === 415) throw mediaError(415, "File in images/ is not a valid image of its claimed type");
    throw error;
  }
  return { ...toImageEntry(name, data.length, linkInfo.mtimeMs), data };
}

/**
 * Store uploaded image bytes under `images/`.
 * - replace=false (upload): the name must be free, else 409.
 * - replace=true (replace in place): the target must exist, else 404,
 *   and the new bytes must carry the target's extension, else 400 —
 *   the stored name never changes, so no orphan is left behind.
 */
export async function writeMediaFile(
  projectsRoot: string,
  projectId: string,
  rawFilename: unknown,
  data: Buffer,
  options: { replace: boolean; targetName?: unknown },
): Promise<MediaImage> {
  const uploadName = assertMediaName(rawFilename);
  assertImageBytes(uploadName, data);
  let name = uploadName;
  if (options.replace) {
    const target = assertMediaName(options.targetName);
    const uploadExt = path.extname(uploadName).toLowerCase();
    const targetExt = path.extname(target).toLowerCase();
    const sameKind =
      uploadExt === targetExt ||
      ((uploadExt === ".jpg" || uploadExt === ".jpeg") && (targetExt === ".jpg" || targetExt === ".jpeg"));
    if (!sameKind) {
      throw mediaError(400, `Replacement image must be a '${targetExt}' like the image it replaces, not '${uploadExt}'`);
    }
    name = target;
  }
  const absolute = await resolveWorkspacePath(projectsRoot, projectId, `${MEDIA_DIR}/${name}`);
  const existing = await lstat(absolute).catch(() => null);
  if (options.replace) {
    if (existing === null) throw mediaError(404, "Image to replace was not found");
    if (existing.isSymbolicLink() || !existing.isFile()) throw mediaError(403, "Image to replace cannot be replaced");
  } else if (existing !== null) {
    throw mediaError(409, `An image named '${name}' already exists — use Replace to swap it, or upload under a different name`);
  }
  const dir = path.dirname(absolute);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  // Re-verify the parent chain after mkdir (mkdir follows symlinks).
  await resolveWorkspacePath(projectsRoot, projectId, MEDIA_DIR);
  const temp = path.join(dir, `.${name}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temp, data, { mode: 0o644 });
    await chmod(temp, 0o644);
    await rename(temp, absolute);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  const info = await stat(absolute);
  return toImageEntry(name, info.size, info.mtimeMs);
}

/** One file part of a multipart/form-data body. */
export type MultipartUpload = { filename: string; contentType: string | undefined; data: Buffer };

/**
 * Minimal multipart/form-data parser (single `file` field). Operates on
 * raw Buffers throughout — the body is never decoded as text, so binary
 * uploads survive intact. Throws FileError 400 on malformed bodies and
 * missing file parts.
 */
export function parseMultipartUpload(body: Buffer, contentType: string | undefined): MultipartUpload {
  if (!contentType || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw mediaError(400, "Upload must be multipart/form-data");
  }
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "").trim();
  if (boundary === "" || boundary.length > 70 || /[\r\n]/.test(boundary)) {
    throw mediaError(400, "Upload is missing a valid multipart boundary");
  }
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const start = body.indexOf(delimiter, cursor);
    if (start === -1) break;
    const after = start + delimiter.length;
    if (body.subarray(after, after + 2).toString("ascii") === "--") break; // closing delimiter
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), after);
    if (headerEnd === -1) throw mediaError(400, "Malformed multipart upload (headers)");
    const headers = body.subarray(after, headerEnd).toString("ascii");
    const dataStart = headerEnd + 4;
    const next = body.indexOf(delimiter, dataStart);
    if (next === -1) throw mediaError(400, "Malformed multipart upload (unterminated part)");
    // Each part's data ends with CRLF immediately before the delimiter.
    const dataEnd = next >= 2 && body[next - 2] === 0x0d && body[next - 1] === 0x0a ? next - 2 : next;
    parts.push(body.subarray(dataStart, dataEnd));
    // Remember which part this was by stashing its headers alongside.
    (parts as unknown as { headers?: string[] }).headers ??= [];
    ((parts as unknown as { headers: string[] }).headers as string[]).push(headers);
    cursor = next;
  }
  const headersList = ((parts as unknown as { headers?: string[] }).headers ?? []) as string[];
  for (let i = 0; i < parts.length; i += 1) {
    const headers = headersList[i] ?? "";
    const disposition = /content-disposition:\s*form-data[^;\r\n]*(?:;\s*[^;\r\n]*)*/i.exec(headers)?.[0] ?? "";
    if (!/name="file"/.test(disposition) && !/name=file\b/.test(disposition)) continue;
    const filenameMatch = /filename="([^"]*)"/.exec(disposition) ?? /filename=([^;\s]+)/.exec(disposition);
    const rawFilename = (filenameMatch?.[1] ?? "").trim();
    if (rawFilename === "") throw mediaError(400, "Upload is missing a filename");
    // Browsers send only the basename; strip any directory the client
    // may have smuggled in (sanitizeMediaFilename also neutralizes it).
    const filename = rawFilename.split(/[\\/]/).pop() ?? rawFilename;
    const typeMatch = /content-type:\s*([^\s;]+)/i.exec(headers);
    return { filename, contentType: typeMatch?.[1], data: parts[i] };
  }
  throw mediaError(400, "Upload must include a 'file' part");
}
