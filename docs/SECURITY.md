# Security

## Dependency remediation

- `zod` is a direct dependency of `@omp-builder/api` and `@omp-builder/shared`; both are pinned to the patched `^4.6.7` line. Request bodies remain capped at 1,000,000 bytes before JSON/schema validation, and individual provider/project fields retain explicit size limits.
- Monaco is reintroduced in Phase 3B as `monaco-editor@0.57.0` (latest stable, 2026-11-22), imported directly as ESM in `apps/web/src/components/MonacoEditor.tsx` — no `@monaco-editor/react`, no CDN loader, no `public/` copy of the `vs/` folder; language workers are bundled with Vite `?worker` imports (the short `monaco-editor/editor/editor.worker` form, matching the package's `exports` map — the documented `esm/vs/...` paths do not resolve under it). The root `package.json` pins `dompurify` to `^3.4.13` via npm `overrides`, covering CVE-2026-0540 (XSS bypass, patched 3.3.2) and GHSA-55q2-fjhq-7xh7 (DOM-clobbering XSS, patched 3.4.13). Note the override governs the npm package only: Monaco's editor core ships a vendored DOMPurify copy (`esm/vs/base/browser/dompurify/dompurify.js`), which is **3.4.15** in 0.57.0 — also patched for both advisories, and verified by `tests/phase3-monaco.mjs` alongside the npm copy (resolved 3.4.18). `tests/phase3-monaco.mjs` verifies all gates on every run: installed monaco-editor is 0.57.0, the on-disk dompurify is >= 3.4.13 with no older copy in `npm ls dompurify`, the vendored copy is >= 3.4.13 and is the version in the built bundle, and `npm audit --omit=dev` reports 0 vulnerabilities. If any gate fails, Monaco must not ship — CodeMirror 6 is the designated secure alternative.

## Current Phase 2 controls

- Single-admin setup is one-time and password hashes use Node's `scrypt` with a random salt.
- Login is rate-limited in memory per IP; production should place the API behind Caddy and add durable abuse monitoring.
- Session tokens are random opaque values; only a SHA-256 token hash is stored. Cookies are HTTP-only and SameSite=Lax.
- Private API routes require a non-expired session. WebSocket upgrades require the same cookie and project ownership.
- Project names and IDs are validated; server-generated paths are not accepted from the browser.
- No terminal, arbitrary process execution, raw filesystem, provider secret, or OMP process endpoint is exposed.
- Provider credentials use AES-256-GCM with a server-only master key and are never returned to the browser or written to generated `models.yml` as plaintext.
- Provider URLs reject unsafe protocols, non-local HTTP, private-network DNS targets, credentials, query strings, and redirects.
- OMP runs headless and approval/UI requests fail closed until an explicit approval bridge exists.

## Required before production
- Replace the in-memory rate limiter with a durable bounded store and proxy-aware trusted-IP configuration.
- Add CSRF protection for state-changing cookie-authenticated requests (origin check plus CSRF token where cross-origin deployment is possible).
- Add security headers, strict origin allowlists, WebSocket message schemas, payload/connection limits, audit logging, session revocation, and backup key rotation.
- Run generated previews in rootless, per-project containers with no Docker socket, no host network, read-only base image, writable project volume only, CPU/memory/PID/disk limits, and egress restrictions.
- Validate every Git path and remote; require confirmation for reset, revert, force push, branch deletion, and other destructive operations.

## Threat model

The primary attacker is generated code or a malicious prompt attempting to read VPS credentials, pivot through the preview proxy, escape its runtime, or use Git/provider secrets. The trust boundary is the API process: it alone can access SQLite, encrypted credentials, OMP children, and workspace roots. Preview containers and OMP tools must not inherit those capabilities.
