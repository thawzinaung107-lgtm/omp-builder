import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

/**
 * Phase 3D — Authenticated preview gateway (proxy layer only).
 *
 * The caller (server.ts) is responsible for authentication (admin session
 * cookie), the project-exists check, the /api/* block, and the "preview is
 * running" check. This module only moves bytes between the admin's browser
 * and the container's loopback port — and it can only ever reach that port:
 *
 * - The target host is always 127.0.0.1 and the port comes from the
 *   preview_state DB row, never from any client-supplied value. There is no
 *   code path that lets a request reach another host, another port, or
 *   another project's container (no SSRF).
 * - Cookie and Authorization headers are stripped before proxying, so a
 *   container can never see the admin session token.
 * - Hop-by-hop headers are stripped in both directions, and Set-Cookie is
 *   stripped from upstream responses so a container can never set a cookie
 *   on the Builder origin.
 * - Only GET/HEAD are proxied; the caller rejects other methods.
 *
 * Milestone E (B3) — picker injection: `proxyPreviewHttp` accepts an
 * optional verified picker script. When one is passed, the gateway
 * inlines it into the HTML document (a single splice immediately after
 * the first `<head>` tag) — but ONLY when every review condition holds
 * (§2.1): GET document navigation, upstream 200, `text/html`, no
 * `content-encoding`, body ≤ 5 MiB, and a `<head>` to splice after.
 * Any failure serves the response unmodified (fail open for the preview,
 * fail closed for the picker). The streaming path is untouched when no
 * script is passed. Every gateway response also carries
 * `X-Content-Type-Options: nosniff` (review §4.3).
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function jsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: message }));
}

// Milestone E (B3) — picker injection body cap (review §2.1 / R-06).
export const PICKER_MAX_BODY_BYTES = 5 * 1024 * 1024;

export type PreviewProxyOptions = {
  /**
   * The verified picker script text (hash-pinned at startup, see
   * picker.ts), or null/omitted to stream the response unmodified.
   * The caller passes a script ONLY when picker mode is on for this
   * project (a server-side per-project flag — never a query parameter).
   */
  pickerScript?: string | null;
};

/**
 * Is this request a document navigation (the only kind injection ever
 * applies to)? `Sec-Fetch-Dest` decides when present: a top-level
 * navigation sends `document`, a nested browsing context (the preview
 * iframe — the only consumer that matters here) sends `iframe`; both
 * are document loads. Anything else (`empty`, `script`, `style`,
 * `image`, ...) is a subresource fetch and never injects. When absent
 * (older clients), only the app entry document and .html pages count —
 * never a path whose last segment looks like a non-HTML asset.
 */
function isPickerDocumentRequest(req: IncomingMessage, targetPath: string): boolean {
  const dest = req.headers["sec-fetch-dest"];
  if (typeof dest === "string" && dest !== "") return dest === "document" || dest === "iframe";
  const pathOnly = targetPath.split("?")[0];
  if (pathOnly === "/" || pathOnly.endsWith("/")) return true;
  const last = pathOnly.split("/").pop() ?? "";
  if (last.endsWith(".html") || last.endsWith(".htm")) return true;
  return !last.includes(".");
}

/**
 * Proxy one HTTP request to the preview container's loopback port.
 * `targetPath` is the already-validated path + query (leading "/").
 * Streams the upstream response; nothing is buffered — except on the
 * picker-injection path (options.pickerScript set and every review
 * condition met), which buffers the body up to 5 MiB to splice the
 * script in after `<head>`.
 */
export function proxyPreviewHttp(req: IncomingMessage, res: ServerResponse, targetPath: string, hostPort: number, options?: PreviewProxyOptions): Promise<void> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (lower === "cookie" || lower === "authorization" || lower === "host" || HOP_BY_HOP.has(lower)) continue;
      if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    headers.host = `127.0.0.1:${hostPort}`;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const upstream = httpRequest(
      { host: "127.0.0.1", port: hostPort, method: req.method, path: targetPath, headers, timeout: 30_000 },
      (up) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(up.headers)) {
          const lower = name.toLowerCase();
          // A container must never set a cookie on the Builder origin.
          if (HOP_BY_HOP.has(lower) || lower === "set-cookie") continue;
          if (value !== undefined) outHeaders[name] = value;
        }
        // Milestone E (B3) — cheap MIME-sniffing defence on every
        // gateway response (review §4.3). Set here, after the loop, so
        // an upstream header can never override it.
        outHeaders["x-content-type-options"] = "nosniff";
        const pickerScript = options?.pickerScript ?? null;
        const contentType = String(up.headers["content-type"] ?? "");
        const isHtml = contentType.toLowerCase().replace(/\s/g, "").startsWith("text/html");
        const injectable =
          pickerScript !== null &&
          req.method === "GET" &&
          up.statusCode === 200 &&
          isHtml &&
          up.headers["content-encoding"] === undefined &&
          isPickerDocumentRequest(req, targetPath);
        if (!injectable) {
          // Today's path, untouched: stream verbatim, nothing buffered.
          res.writeHead(up.statusCode ?? 502, outHeaders);
          up.pipe(res);
          up.on("end", done);
          up.on("error", done);
          return;
        }
        // Injection path: buffer (capped at 5 MiB). Over the cap, or with
        // no <head> to splice after, the response is served unmodified.
        const chunks: Buffer[] = [];
        let total = 0;
        let streaming = false;
        const startStreaming = (crossing: Buffer) => {
          // The body is too big to rewrite: forward everything verbatim
          // (buffered prefix + crossing chunk + the rest of the stream).
          streaming = true;
          res.writeHead(up.statusCode ?? 502, outHeaders);
          for (const chunk of chunks) res.write(chunk);
          res.write(crossing);
          up.pipe(res);
          up.on("end", done);
          up.on("error", done);
        };
        up.on("data", (chunk: Buffer) => {
          if (streaming) return;
          total += chunk.length;
          if (total > PICKER_MAX_BODY_BYTES) {
            startStreaming(chunk);
            return;
          }
          chunks.push(chunk);
        });
        up.on("error", () => {
          if (!res.headersSent && !streaming) jsonError(res, 502, "Preview is unreachable");
          done();
        });
        up.on("end", () => {
          if (streaming) return; // the pipe's end handler resolves
          const raw = Buffer.concat(chunks);
          const body = raw.toString("utf8");
          const headMatch = /<head[\s>]/i.exec(body);
          const headEnd = headMatch === null ? -1 : body.indexOf(">", headMatch.index);
          if (headEnd < 0) {
            // No <head>: serve unmodified (never prepend to a fragment).
            outHeaders["content-length"] = String(raw.length);
            res.writeHead(up.statusCode ?? 502, outHeaders);
            res.end(raw);
            done();
            return;
          }
          const rewritten =
            body.slice(0, headEnd + 1) + `<script>${pickerScript}</script>` + body.slice(headEnd + 1);
          const rewrittenBytes = Buffer.from(rewritten, "utf8");
          outHeaders["content-length"] = String(rewrittenBytes.length);
          res.writeHead(up.statusCode ?? 502, outHeaders);
          res.end(rewrittenBytes);
          done();
        });
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("preview upstream timed out")));
    upstream.on("error", () => {
      jsonError(res, 502, "Preview is unreachable");
      done();
    });
    // GET/HEAD carry no body; piping is a no-op for them and keeps this
    // correct if a future caller allows a body-bearing method.
    req.pipe(upstream);
    req.on("error", done);
  });
}

/**
 * Proxy a WebSocket upgrade (Vite HMR) to the preview container as a raw
 * TCP pipe. The request line path is forwarded unchanged: the 3C wrapper
 * config pins Vite's hmr.path to /api/preview/<projectId>/__hmr, which is
 * exactly the path the browser requested. `head` (bytes already read past
 * the headers) is forwarded first so the handshake is not corrupted.
 */
export function proxyPreviewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, hostPort: number): void {
  const upstream = connect(hostPort, "127.0.0.1");
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    try {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    } catch {
      // Socket already gone; nothing to report.
    }
    socket.destroy();
    upstream.destroy();
  };
  upstream.once("error", fail);
  upstream.once("connect", () => {
    const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (lower === "cookie" || lower === "authorization" || lower === "host") continue;
      if (value !== undefined) lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    lines.push(`host: 127.0.0.1:${hostPort}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.once("error", () => upstream.destroy());
    upstream.once("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  });
}
