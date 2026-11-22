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

/**
 * Proxy one HTTP request to the preview container's loopback port.
 * `targetPath` is the already-validated path + query (leading "/").
 * Streams the upstream response; nothing is buffered.
 */
export function proxyPreviewHttp(req: IncomingMessage, res: ServerResponse, targetPath: string, hostPort: number): Promise<void> {
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
        res.writeHead(up.statusCode ?? 502, outHeaders);
        up.pipe(res);
        up.on("end", done);
        up.on("error", done);
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
