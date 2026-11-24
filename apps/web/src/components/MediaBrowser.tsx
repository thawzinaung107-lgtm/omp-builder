import { useCallback, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, RefreshCw, Upload } from "lucide-react";
import { MEDIA_ALLOWED_MIME_TYPES, MEDIA_MAX_BYTES, sanitizeMediaFilename } from "@omp-builder/shared";
import { api, type MediaImage } from "../api";
import { Button } from "../ui";

/* Milestone E (B7) — media browser: the workspace's images/ folder.
 * Lives as a section at the top of the Files tab (least invasive fit:
 * no new tab, no new route). Thumbnails use the authenticated API
 * media endpoint (same-origin, session cookie) — never a public URL.
 * Upload stores a new image; Replace swaps one in place (same name,
 * same extension, no orphan). Validation mirrors the server (type
 * allow-list, 5 MB cap, filename sanitization); the server re-checks
 * everything, including magic bytes, and is authoritative. */

const ACCEPT = MEDIA_ALLOWED_MIME_TYPES.join(",");

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Client-side pre-check (server re-validates): returns an error string or "". */
function validateFile(file: File): string {
  if (!(MEDIA_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return `Only jpg, png, gif and webp images can be uploaded (got ${file.type || "unknown type"}).`;
  }
  if (file.size > MEDIA_MAX_BYTES) {
    return `Image is ${formatSize(file.size)} — the limit is ${MEDIA_MAX_BYTES / (1024 * 1024)} MB.`;
  }
  if (file.size === 0) return "Image is empty.";
  try {
    sanitizeMediaFilename(file.name);
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid image filename.";
  }
  return "";
}

export function MediaBrowser({
  projectId,
  refreshToken,
  onChanged,
}: {
  projectId: string;
  refreshToken: number;
  onChanged?: () => void;
}) {
  const [images, setImages] = useState<MediaImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const replaceTargetRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.listMedia(projectId);
      setImages(result.images);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load images");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const handleUpload = async (file: File | undefined) => {
    if (!file || busy) return;
    const problem = validateFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await api.uploadMedia(projectId, file);
      setImages((current) => [...current, saved.image].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })));
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const handleReplace = async (file: File | undefined) => {
    const target = replaceTargetRef.current;
    if (!file || !target || busy) return;
    const problem = validateFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await api.replaceMedia(projectId, target, file);
      setImages((current) => current.map((image) => (image.name === target ? saved.image : image)));
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Replace failed");
    } finally {
      setBusy(false);
      replaceTargetRef.current = null;
    }
  };

  return (
    <div className="shrink-0 border-b border-omp-border bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-omp-ink">
          <ImageIcon size={15} className="text-omp-muted" /> Media
          <span className="rounded-full bg-omp-canvas px-2 py-0.5 text-[11px] font-medium text-omp-muted">
            {images.length} image{images.length === 1 ? "" : "s"}
          </span>
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="!px-3 !py-1.5 !text-xs" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} /> Refresh
          </Button>
          <Button className="!px-3 !py-1.5 !text-xs" onClick={() => uploadInputRef.current?.click()} disabled={busy}>
            <Upload size={13} /> Upload image
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-omp-muted">
        Stored under <span className="font-mono">images/</span> (jpg, png, gif, webp — max 5 MB). Reference one in a prompt as{" "}
        <span className="font-mono">@images/&lt;name&gt;</span>.
      </p>
      {error && (
        <p role="alert" className="mt-2 rounded-omp bg-[#fdecec] px-3 py-2 text-xs text-[#a83232]">
          {error}
        </p>
      )}
      {loading ? (
        <p className="mt-2 text-xs text-omp-muted">Loading images…</p>
      ) : images.length === 0 ? (
        <p className="mt-2 text-xs text-omp-muted">No images yet — upload one to use it in the app or attach it to a prompt.</p>
      ) : (
        <div className="mt-2 grid max-h-64 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((image) => (
            <figure key={image.path} className="overflow-hidden rounded-omp border border-omp-border bg-omp-canvas">
              <img
                src={api.mediaUrl(projectId, image.name)}
                alt={image.name}
                loading="lazy"
                className="h-24 w-full bg-white object-contain"
              />
              <figcaption className="px-2 py-1.5">
                <span className="block truncate font-mono text-[11px] text-omp-ink" title={image.name}>
                  {image.name}
                </span>
                <span className="flex items-center justify-between gap-1">
                  <span className="text-[11px] text-omp-muted">{formatSize(image.size)}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      replaceTargetRef.current = image.name;
                      replaceInputRef.current?.click();
                    }}
                    className="text-[11px] font-medium text-omp-brand hover:underline disabled:opacity-50"
                  >
                    Replace
                  </button>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <input
        ref={uploadInputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        aria-label="Upload image"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void handleUpload(file);
        }}
      />
      <input
        ref={replaceInputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        aria-label="Replace image"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void handleReplace(file);
        }}
      />
    </div>
  );
}
