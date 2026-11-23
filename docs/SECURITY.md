# Security

## Dependency remediation

- `zod` is a direct dependency of `@omp-builder/api` and `@omp-builder/shared`; both are pinned to the patched `^4.6.7` line. Request bodies remain capped at 1,000,000 bytes before JSON/schema validation, and individual provider/project fields retain explicit size limits.
- Monaco is reintroduced in Phase 3B as `monaco-editor@0.57.0` (latest stable, 2026-11-22), imported directly as ESM in `apps/web/src/components/MonacoEditor.tsx` — no `@monaco-editor/react`, no CDN loader, no `public/` copy of the `vs/` folder; language workers are bundled with Vite `?worker` imports (the short `monaco-editor/editor/editor.worker` form, matching the package's `exports` map — the documented `esm/vs/...` paths do not resolve under it). The root `package.json` pins `dompurify` to `^3.4.13` via npm `overrides`, covering CVE-2026-0540 (XSS bypass, patched 3.3.2) and GHSA-55q2-fjhq-7xh7 (DOM-clobbering XSS, patched 3.4.13). Note the override governs the npm package only: Monaco's editor core ships a vendored DOMPurify copy (`esm/vs/base/browser/dompurify/dompurify.js`), which is **3.4.15** in 0.57.0 — also patched for both advisories, and verified by `tests/phase3-monaco.mjs` alongside the npm copy (resolved 3.4.18). `tests/phase3-monaco.mjs` verifies all gates on every run: installed monaco-editor is 0.57.0, the on-disk dompurify is >= 3.4.13 with no older copy in `npm ls dompurify`, the vendored copy is >= 3.4.13 and is the version in the built bundle, and `npm audit --omit=dev` reports 0 vulnerabilities. If any gate fails, Monaco must not ship — CodeMirror 6 is the designated secure alternative.

## Phase 3C — Rootless Podman previews (implemented 2026-11-22)

- Staging copy: the API (root) mirrors the project workspace to `/var/lib/omp-builder/previews/<projectId>` (0700, owned by omp-builder), excluding `node_modules`, `.git`, `.omp`, `dist`, `build`, `.next`, `.cache`, `.env*`, `*.pem`, `*.key`, and all symlinks. The live workspace is never bind-mounted; only the staging copy is mounted, read-only, at `/app`. Re-sync runs on preview start/restart and debounced (1.5 s) after file saves and OMP `files_modified` events.
- Containers run as the `omp-builder` service user via `runuser -u omp-builder` (argv arrays, no shell), image `docker.io/library/node:22-alpine`, deterministic name `omp-preview-<first-8-of-project-id>`, port published to `127.0.0.1` only from 42000–42999 (recorded in the `preview_state` table, migration v3). Flags: `--cap-drop=ALL --security-opt no-new-privileges --read-only --tmpfs /tmp`, a named volume for `/app/node_modules` only, `--memory=512m --memory-swap=512m --cpus=1 --pids-limit=128`, env limited to `NODE_ENV`, `PORT`, `HOME=/tmp`. No secrets, no host socket, no host network namespace, no privileged flag, no mounts of `/`, `/root`, host secrets, SSH keys, API credentials, or other projects. Resource limits are enforced through the **systemd cgroup manager** (`podman --cgroup-manager=systemd` with `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/996/bus`, user@996.service lingering): the cgroupfs fallback silently does NOT enforce them — verified 2026-11-22, `memory.max` read `max` and a hog passed 800 MB. With the systemd manager, `memory.max` is 536870912, `memory.swap.max` 0, `cpu.max` `100000 100000`. If the user manager is ever down, podman fails loudly instead of running unlimited.
- Modes: Vite (package.json has `vite` + a `dev` script) runs `npm ci`/`npm install` then Vite under a generated wrapper config that merges the project's own Vite config and pins the HMR path for the Phase 3D gateway (`/api/preview/<projectId>/__hmr`); anything else is served by an API-generated `preview-server.mjs` static server with SPA fallback.
- State and recovery: `preview_state` (project_id, container_name, host_port, container_port, framework, status, last_error, updated_at). On API start the manager reconciles DB rows against `podman ps -a` (stale rows marked stopped/crashed, abandoned `omp-preview-*` containers removed — containers only, never project files). Status queries re-inspect the live container, so a killed container surfaces as `crashed`.
- Logs: `GET /api/projects/:id/preview/logs` reads `podman logs`; a `podman logs -f` follower streams lines as `preview_log` WebSocket events (also persisted, capped at the newest 200 per project, lines truncated to 500 chars). `preview_status` events mark lifecycle changes. Containers run with `--log-driver k8s-file`: the default journald driver is unreadable to this runuser-spawned podman (`podman logs` came back empty), while k8s-file logs read back correctly.
- Verified by `tests/phase3-preview.mjs` (live API + real containers): start/stop/restart lifecycle, status, the Phase 2 static fixture and the real Gua Vite app serving over HTTP, a memory-hog container killed at the 512 MiB limit (exit 137; kernel dmesg proves the `CONSTRAINT_MEMCG` OOM kill at ~522 MB anon-rss — podman 4.9 with the systemd cgroup manager reports `OOMKilled=false` for a real cgroup kill, a reporting quirk, so the test asserts the exit code and the kernel evidence rather than the flag), CPU/memory/PID limits visible in `podman inspect` and in the live cgroup files (`memory.max` 536870912, `cpu.max` `100000 100000`), and isolation probes (the container's own `/etc/shadow` holds only locked image accounts with no password hashes and no host users; no `/root/.ssh`; no host `127.0.0.1:8787`; no other project's staging dir).
- Known gaps (not claimed as done): **egress is not allow-listed** — containers can reach the public internet (required for `npm ci`) and the host LAN address `191.40.5.90:8787` is reachable from inside a container (verified); only loopback `127.0.0.1:8787` is unreachable because it is the container's own loopback. Egress allow-listing is a follow-up. The generated Vite wrapper merges a project's own Vite config via `loadConfigFromFile`; a malicious/broken user config could change dev-server behaviour inside the container only. Direct `127.0.0.1` preview access has no auth — the Phase 3D gateway (auth + proxy) is what makes previews user-facing; until then preview ports are localhost-only by construction.
- OMP as service user (brief §6): `OmpRpcSession` supports `runAsUser` (runuser spawn, `HOME=/var/lib/omp-builder`, `XDG_RUNTIME_DIR=/run/user/996`), gated per project by `OMP_RUN_AS_USER_PROJECT_IDS`. Default is root spawn, unchanged. **Verified working 2026-11-22:** the Phase 2 Hello prompt completed as omp-builder (session_settled, `index.html` written, owned by omp-builder). Environment is passed via spawn `env` (execve), never as `env KEY=VALUE` argv — the argv form leaks decrypted provider keys into world-readable `ps` output (caught and fixed during verification). Requirements for opt-in: a world-executable OMP copy at `/usr/local/bin/omp` (the real binary lives under `/root`, unreachable to omp-builder), an omp-builder-owned config copy at `/var/lib/omp-builder/omp-config`, traverse-only ACLs (`0710`, group omp-builder) on `/root`, the repo root, and the session root (the last is code-managed at API startup when the gate is non-empty), and per-project workspace/session ownership (code-managed in `OmpRpcSession.start()` for fresh projects; a pre-existing project with root-owned workspace files needs a one-time recursive chown first). Known gaps: the config copy's `models.yml` is NOT auto-synced when providers change (the API writes it only to the real config dir — resync manually after provider changes); OMP-as-996 can read other projects' staging copies (source only, no secrets — staging excludes `.env`/keys) and any world-readable file under `/root` (note `data/persistent/app.db` is mode 0644 — readable once traversal is granted; it holds only SHA-256 session hashes and AES-GCM-encrypted keys, not the master key). **Live state after 3C: no project opted in; the API runs root spawn, and the `/root`/repo-root traversal grants were reverted.** To opt a project in later: set the env var to its id, apply the traversal grants, sync `models.yml` into the user config copy, restart the API.

## Phase 3D — Authenticated preview gateway + hardened iframe (implemented 2026-11-22)

- Gateway: `GET /api/preview/:projectId/*` requires the admin session cookie and an existing project, then proxies to `127.0.0.1:<hostPort>` taken from the `preview_state` DB row for that project only. The client supplies no host, port, or target — there is no code path to another host, port, or project (no SSRF). Only GET/HEAD are proxied. `/api/*` under the gateway is rejected (403), so generated preview code can never reach Builder APIs through the gateway. `Cookie` and `Authorization` headers are stripped before proxying; hop-by-hop headers are stripped in both directions and `Set-Cookie` is stripped from upstream responses, so a container can never see the admin session or set a cookie on the Builder origin. A stopped/absent preview returns 503 "Preview is not running" (never a proxy to nowhere). The proxy streams (no body buffering) with a 30 s upstream timeout.
- HMR: `GET /api/preview/:projectId/__hmr` upgrades and is piped as raw TCP to the container's Vite HMR endpoint — the 3C wrapper config pins `server.hmr.path` to exactly that path, so the two sides agree. The upgrade requires the same cookie + project check, and a non-running preview gets 502. The Vite dev proxy (`apps/web/vite.config.ts`) forwards WS upgrades under `/api` (`ws: true`) so HMR works through the Builder origin.
- Iframe: the Preview tab's iframe sandbox is `allow-scripts allow-forms allow-popups` — `allow-same-origin` is dropped, so generated JavaScript runs in an opaque origin and cannot read admin cookies or call `/api`. The browser enforces this even if the gateway check were bypassed: a `fetch('/api/projects')` from the opaque origin sends `Origin: null`, which the API's CORS check rejects with 403 before auth is even considered — with or without a cookie. Verified by `tests/phase3-gateway.mjs` (gateway `/api` block, `Origin: null` → 403, no `allow-same-origin` in the built bundle) and by a real headless-Chrome probe (see the test file's notes).
- Managed UI: the Preview tab has Start/Stop/Restart, a status pill (running/stopped/starting/crashed/error + framework + port), Desktop/Mobile widths, and Refresh. The manual URL bar and the `omp-builder-preview-url:<id>` localStorage entry are removed; the gateway URL is shown read-only. The Logs tab gains a runtime-logs section (`preview_log` / `preview_status`, auto-scrolling, latest 100 shown) above the unchanged session-event log.
- Watcher: `apps/api/src/watcher.ts` watches only the workspace of a project with a live WebSocket client (one `fs.watch` per directory, recursive walk, depth 12, `node_modules`/`.git`/`.omp`/`dist`/`build`/`.next`/`.cache` and `.env*`/`*.pem`/`*.key` never watched or reported), debounced 750 ms into one `files_modified` event. File-API writes, OMP `files_modified` events, and watcher detections of the same edit are deduplicated (identical file set within 5 s emits once) in `emitFilesModified`.
- Dev limitation: the gateway and the Builder share one origin in development, so the sandbox (not origin separation) is the isolation boundary. True origin separation needs a dedicated preview domain in production (e.g. `preview-<id>.example.com` with its own cookie scope); until then, do not serve the Builder and previews from a shared production origin.
- Known gaps (not claimed as done): the gateway trusts the container's HTTP responses (a malicious preview could serve phishing content inside the iframe — the sandbox blocks credential theft but not lookalike UI); egress allow-listing is still a follow-up (see 3C).

## Phase 3.5 §2 — Non-root execution is now the default (implemented 2026-11-22)

- The API, web server, OMP RPC children, and preview containers all run
  as the `omp-builder` service user (uid 996). Nothing Builder-related
  runs as root anymore. App: `/opt/omp-builder`; data:
  `/var/lib/omp-builder/data/` (DB, workspaces, OMP sessions/config);
  Node 22.23.5: `/usr/local/node-22.23.5`; services via the
  `omp-builder.service` systemd unit (`npm run dev`, `Restart=on-failure`).
  Full record: `docs/MIGRATION-PHASE3.5-2.md`.
- OMP-as-service-user is the default, not opt-in: an empty
  `OMP_RUN_AS_USER_PROJECT_IDS` now means ALL projects run OMP as
  `omp-builder` (previously it meant none). `OMP_RUN_AS_USER=false`
  restores root spawn (escape hatch only). The 3C `models.yml` sync gap
  is closed: OMP children now use the real config dir via
  `OMP_USER_CONFIG_DIR=/var/lib/omp-builder/data/omp-config`, so the
  API-written `models.yml` is what the child reads; the stale copy at
  `/var/lib/omp-builder/omp-config` is unused. The 3C `/root`/repo-root
  traversal grants are gone — the API owns the tree, so same-uid
  children need no grants.
- `runuser` refuses non-root callers (verified: `runuser: may not be
  used by non-root users`), so both `runuser -u omp-builder` call sites
  have a same-user fast path that spawns directly when the API already
  runs as uid 996 (`OmpRpcSession.start()` for OMP,
  `runPodman()` for podman, with the podman env passed via spawn `env`
  instead of the `/usr/bin/env …` argv form). The root-run paths are
  kept unchanged for the rollback layout. No new privilege is granted:
  the fast paths spawn the same binaries with the same argv/env as
  before, only without the (now impossible) user switch.
- Verified by the re-run `tests/phase3-e2e.mjs` (real Kuoai prompt →
  preview → gateway → `systemctl restart` recovery → security
  re-probes) plus `npm run test:rpc`, `npm run test:security`,
  `npm run typecheck`, `npm run build`, `npm audit --omit=dev`.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:e2185eb0a57f652dd9c8e8b40dd717d14f0e8f51bda972a66756ef0859bbdea2 -->

## Current Phase 2 controls

- Single-admin setup is one-time and password hashes use Node's `scrypt` with a random salt.
- Login is rate-limited in memory per IP; production should place the API behind Caddy and add durable abuse monitoring.
- Session tokens are random opaque values; only a SHA-256 token hash is stored. Cookies are HTTP-only and SameSite=Lax.
- Private API routes require a non-expired session. WebSocket upgrades require the same session and an existing project; the single administrator has access to all projects. There is no per-project owner ACL.
- Project names and IDs are validated; server-generated paths are not accepted from the browser.
- The browser has no general shell or raw filesystem endpoint. OMP child permissions and credentials are a separate boundary; see the [post-merge audit](POST_MERGE_AUDIT.md).
- Provider credentials use AES-256-GCM with a server-only master key at rest and are not returned to the browser or written to generated `models.yml` as plaintext.
- Provider URLs reject unsafe protocols, non-local HTTP, private-network DNS targets, credentials, query strings, and redirects.
- OMP runs headless and approval/UI requests fail closed until an explicit approval bridge exists.

<!-- /coderabbit-ai-generated:v1 -->

## Required before production
- Replace the in-memory rate limiter with a durable bounded store and proxy-aware trusted-IP configuration.
- Add CSRF protection for state-changing cookie-authenticated requests (origin check plus CSRF token where cross-origin deployment is possible).
- Add security headers, strict origin allowlists, WebSocket message schemas, payload/connection limits, audit logging, session revocation, and backup key rotation.
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:d454d4b129278814a7bd61c35e3cf5035f1d4f986b1cedd9f33e839d54f4d992 -->

- Verify rootless execution, read-only staging, limited writable storage, effective CPU/memory/PID limits, disk quotas and outbound policy on the target host. Launch flags are present; disk quotas and restricted egress are not established by those flags. Keep the dedicated preview origin gate open.

<!-- /coderabbit-ai-generated:v1 -->
- Validate every Git path and remote; require confirmation for reset, revert, force push, branch deletion, and other destructive operations.

## Threat model

The primary attacker is generated code or a malicious prompt attempting to read VPS credentials, pivot through the preview proxy, escape its runtime, or use Git/provider secrets. The trust boundary is the API process: it alone can access SQLite, encrypted credentials, OMP children, and workspace roots. Preview containers and OMP tools must not inherit those capabilities.
