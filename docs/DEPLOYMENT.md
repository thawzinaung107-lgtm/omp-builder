# Deployment

OMP Builder as deployed on the VPS (verified 2026-11-22, Phase 3E). This
document describes the real host, not a template: domain and production
reverse-proxy details are still open, so do not apply the production
section blindly.

## Current host (verified 2026-11-22)

- VPS `root@191.40.5.90`, Ubuntu 24.04, 4 CPUs, **3.8 GB RAM + 2 GB
  swapfile** (`/swapfile`, in `/etc/fstab`, active). The swap is a
  **requirement, not a nicety**: the web production build (Monaco) OOMs
  at Node's default ~2 GB heap — `npm run test:security` aborted with
  `FATAL ERROR: Ineffective mark-compacts near heap limit` until
  `NODE_OPTIONS=--max-old-space-size=2560` was baked into that script
  (Phase 3E). Run any full build with
  `NODE_OPTIONS=--max-old-space-size=2560 npm run build`.
- Node **22.23.5 via nvm** (`/root/.nvm/versions/node/v22.23.5/bin`). The
  system `node` is v18 and **cannot** run this repo (`better-sqlite3` is
  compiled for Node 22, `NODE_MODULE_VERSION 127`). Every command in this
  document assumes `export PATH=/root/.nvm/versions/node/v22.23.5/bin:$PATH`.
- Repo `/root/projects/omp-builder`, branch `feature/phase-3-browser-ide`.
  Never commit `data/` or secrets; see `.gitignore`.
- Podman **4.9.3** (crun, overlay, cgroup2fs). Node image cached:
  `docker.io/library/node:22-alpine`.

## Services (development, as running)

There is no systemd unit yet — services run under one `npm run dev`
(concurrently) process, started 2026-11-22 and supervised by hand:

| Service | Listen | Process |
| --- | --- | --- |
| API | `127.0.0.1:8787` | `tsx watch src/server.ts` (workspace `@omp-builder/api`) |
| Web (Vite dev) | `127.0.0.1:5173` (serves on all interfaces) | `vite` (workspace `@omp-builder/web`) |

Health: `curl http://127.0.0.1:8787/api/health` → `{"ok":true}`.
Web: `curl http://127.0.0.1:5173/` → 200.

### Start / restart

```sh
export PATH=/root/.nvm/versions/node/v22.23.5/bin:$PATH
cd /root/projects/omp-builder
# Find the concurrently parent by its exact node cmdline (the parent
# `sh -c` wrapper matches "concurrently" too — do NOT kill by pattern):
node -e "const fs=require('fs');for(const p of fs.readdirSync('/proc')){if(!/^\d+$/.test(p))continue;try{const c=fs.readFileSync('/proc/'+p+'/cmdline','utf8').replace(/\0/g,' ');if(c.includes('node')&&c.includes('.bin/concurrently'))console.log(p,c)}catch{}}"
kill <concurrently-pid>        # SIGTERM; wait for 8787 to stop answering
setsid nohup npm run dev > /tmp/npm-dev.log 2>&1 < /dev/null &
curl -s http://127.0.0.1:8787/api/health   # must return {"ok":true}
# Verify the restart in the log — tsx watch restarts are flaky, never assume:
grep -E "OMP Builder API listening|startup reconcile" /tmp/npm-dev.log
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5173/
```

Restarting `npm run dev` restarts **both** API and web. The API logs its
preview reconciliation on every start (`[preview] startup reconcile`).

### Gua preview app (separate, not a Builder service)

The user's overnight OMP test app "Gua — Plotline" runs its own Vite
server on `127.0.0.1:4173` from
`/root/projects/omp-builder/data/projects/4f75505f-a2d9-4cc9-b6f8-4e3978c6de9b`
(`npx vite --host 0.0.0.0 --port 4173 --strictPort`). **Stop it during
builds** (it competes for the same 3.8 GB RAM) and restart it after:

```sh
# stop: kill the vite node process + its npm wrapper by explicit PID
# (find them with: ps aux | grep "[v]ite --host 0.0.0.0 --port 4173")
kill <vite-pid> <npm-pid>
# restart:
cd /root/projects/omp-builder/data/projects/4f75505f-a2d9-4cc9-b6f8-4e3978c6de9b
setsid nohup /root/.nvm/versions/node/v22.23.5/bin/npx vite --host 0.0.0.0 --port 4173 --strictPort > /tmp/gua-4173.log 2>&1 < /dev/null &
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4173/
```

## Preview architecture (Phase 3C/3D)

1. **Staging sync.** The API (root) mirrors a project's workspace to
   `/var/lib/omp-builder/previews/<projectId>` (0700, owned by the
   `omp-builder` service user), excluding `node_modules`, `.git`, `.omp`,
   `dist`, `build`, `.next`, `.cache`, `.env*`, `*.pem`, `*.key` and all
   symlinks. Sync runs on preview start/restart and debounced (1.5 s)
   after file saves and OMP `files_modified` events. The live workspace
   is **never** bind-mounted into a container.
2. **Rootless container.** Run as `omp-builder` via `runuser` (argv
   arrays, no shell), image `docker.io/library/node:22-alpine`,
   deterministic name `omp-preview-<first-8-of-project-id>`, port
   published to `127.0.0.1` only from 42000–42999 (recorded in the
   `preview_state` table, migration v3). Flags: `--cap-drop=ALL
   --security-opt no-new-privileges --read-only --tmpfs /tmp`, a named
   volume for `/app/node_modules` only, `--memory=512m --memory-swap=512m
   --cpus=1 --pids-limit=128`, env limited to `NODE_ENV`, `PORT`,
   `HOME=/tmp`. No secrets, no host socket, no host network namespace.
   Resource limits are enforced through the **systemd cgroup manager**
   (`podman --cgroup-manager=systemd`, user@996.service lingering); the
   cgroupfs fallback silently does **not** enforce them (verified
   2026-11-22 — a hog passed 800 MB under cgroupfs, and is OOM-killed at
   512 MiB under systemd).
3. **Modes.** Vite (package.json has `vite` + a `dev` script) runs
   `npm ci`/`npm install` then Vite under a generated wrapper config that
   pins the HMR path for the gateway; anything else is served by an
   API-generated `preview-server.mjs` static server with SPA fallback.
4. **Gateway + HMR (3D).** `GET /api/preview/:projectId/*` requires the
   admin session cookie and proxies to `127.0.0.1:<hostPort>` taken from
   the `preview_state` DB row for that project only (no SSRF: the client
   supplies no host/port/target; only GET/HEAD; `/api/*` rejected 403;
   `Cookie`/`Authorization` stripped). `GET
   /api/preview/:projectId/__hmr` upgrades the Vite HMR WebSocket through
   the same auth. The Preview tab's iframe sandbox is
   `allow-scripts allow-forms allow-popups` — **no `allow-same-origin`**,
   so generated JS runs in an opaque origin and cannot call Builder APIs
   (verified in a real headless-Chrome probe: `fetch('/api/projects')`
   from the iframe is blocked).
5. **State and recovery.** `preview_state` (project_id, container_name,
   host_port, container_port, framework, status, last_error, updated_at).
   On API start the manager reconciles DB rows against `podman ps -a`
   (stale rows marked stopped/crashed, abandoned `omp-preview-*`
   containers removed — containers only, never project files). Status
   queries re-inspect the live container, so a killed container surfaces
   as `crashed`. `preview_log` / `preview_status` events stream over the
   project WebSocket and into the Logs tab.
6. **File watching (3D).** `apps/api/src/watcher.ts` watches only the
   workspace of a project with a live WebSocket client (depth 12,
   `node_modules`/`.git`/`.omp`/`dist`/`build`/`.next`/`.cache` and
   `.env*`/`*.pem`/`*.key` never watched), debounced 750 ms into one
   `files_modified` event; duplicate detections of the same edit (file
   API, OMP, watcher) are deduplicated within 5 s.

## Service user + Podman setup (as configured)

- User `omp-builder`, uid **996**, `subuid`/`subgid` `200000:65536`,
  linger enabled, `user@996.service` active.
- OMP binary for the service user: world-executable copy at
  `/usr/local/bin/omp` (the real binary lives under `/root`, unreachable
  to `omp-builder`); omp-builder-owned config copy at
  `/var/lib/omp-builder/omp-config` (its `models.yml` is **not**
  auto-synced when providers change — resync manually after provider
  changes; see `docs/SECURITY-REPORT-PHASE3.md`).
- **OMP-as-service-user is opt-in, not default.** OMP children still
  spawn as root by default; per-project opt-in via the
  `OMP_RUN_AS_USER_PROJECT_IDS` env var (comma-separated project ids).
  Verified working 2026-11-22 on the Phase 2 fixture (session settled,
  files written owned by omp-builder). No project is currently opted in;
  the `/root`/repo-root traversal grants used for the verification were
  reverted. To opt a project in later: set the env var, apply the
  traversal grants, sync `models.yml` into the user config copy, restart
  the API.

## Environment variables

Only the repository-root `.env` is loaded (values already in the process
environment win). `.env` is mode **0600**; never print its values.

| Variable | Default | Notes |
| --- | --- | --- |
| `API_PORT` / `API_HOST` | `8787` / `127.0.0.1` | Never expose the API publicly; bind loopback only |
| `SESSION_COOKIE_NAME` | `omp_builder_session` | HttpOnly, SameSite=Lax |
| `SESSION_TTL_DAYS` | `14` | Session lifetime |
| `SESSION_COOKIE_SECURE` | `false` | Set `true` behind HTTPS |
| `DATABASE_PATH` | `data/persistent/app.db` | Explicit path must already exist (API refuses to create it) |
| `PROJECTS_ROOT` | `data/projects` | Workspaces are 0700 root-owned |
| `OMP_SESSION_ROOT` | `data/omp-sessions` | Per-project OMP session dirs |
| `OMP_CONFIG_DIR` | `data/omp-config` | OMP config incl. generated `models.yml` |
| `OMP_BIN` | `omp` | Resolved via PATH; `/root/.local/bin/omp` in dev |
| `OMP_MAX_PROCESSES` | `2` | Concurrent OMP children |
| `OMP_IDLE_MS` | `900000` (15 min) | Idle OMP sessions closed (checked every 60 s) |
| `OMP_RUN_AS_USER_PROJECT_IDS` | _(empty)_ | Opt-in list for OMP-as-`omp-builder` (see above) |
| `OMP_MASTER_KEY` | _(required)_ | Base64 32-byte key; AES-256-GCM for provider credentials |
| `SESSION_SECRET` | _(required)_ | Session signing secret |
| `WEB_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | CORS allowlist; dev also allows `http://new-lovable.localhost:<port>` |
| `DEV_DYNAMIC_FORWARD_ORIGIN` | `true` (dev) | Set `false` in production |
| `DEV_FORWARD_HOST` / `DEV_FORWARD_PORT` | `new-lovable.localhost` | Host is pinned; port optional |
| `APP_ENV` / `NODE_ENV` | `development` | `production` disables dynamic forward origins |

## Backup and restore

- **Database:** `data/persistent/app.db` (mode **0600** since Phase 3E;
  `-wal`/`-shm` and the backup files alongside it are 0600 too). Back
  up with a consistent SQLite backup while the API is running, e.g.
  via a `better-sqlite3` online backup (the method used for
  `data/persistent/app.db.backup-20261121` and
  `app.db.backup-provider-attach-1795305986`). Never copy the live file
  with plain `cp` while the API holds it open — use the backup API.
  Verify with `PRAGMA integrity_check` on the copy.
- **Also back up:** project workspaces (`data/projects/`), OMP session
  dirs (`data/omp-sessions/`), OMP config (`data/omp-config/`), the
  service-user config copy (`/var/lib/omp-builder/omp-config`), and
  `.env` (separately, encrypted — it holds the master key and session
  secret). Do **not** back up plaintext provider keys or session cookies.
- **Restore:** stop the API, restore the DB + directories with the same
  ownership/permissions (workspaces 0700 root, DB 0600 root), start the
  API, check `/api/health` and the `[preview] startup reconcile` log
  line. Test restores to a fresh directory before relying on them.
- Never delete the data directory during rollback. Migrations are
  additive (`user_version` 3 as of Phase 3); there is no downgrade path
  — keep the previous release directory and the pre-migration DB backup.

## Production checklist (still open)

- Systemd units for API + web with `Restart=on-failure`,
  `NoNewPrivileges=yes`, `PrivateTmp=yes`, restricted filesystem policy.
- Caddy (or equivalent) with automatic HTTPS, reverse-proxying to
  `127.0.0.1:8787` with WebSocket upgrades on the same origin.
- Dedicated preview origin (e.g. `preview-<id>.example.com` with its own
  cookie scope) — in development the gateway and Builder share one
  origin, so the iframe sandbox (not origin separation) is the isolation
  boundary. Do not serve Builder and previews from a shared production
  origin.
- Durable rate limiting, CSRF protection, security headers, audit
  logging, session revocation tooling, backup key rotation — see
  `docs/SECURITY-REPORT-PHASE3.md` for the full list.
- Egress allow-listing for preview containers (currently unrestricted
  outbound internet; see the security report).

## Tests

```sh
export PATH=/root/.nvm/versions/node/v22.23.5/bin:$PATH
npm run typecheck
NODE_OPTIONS=--max-old-space-size=2560 npm run build
npm run test:security   # bare command now passes (NODE_OPTIONS baked in)
npm run test:rpc
npm audit --omit=dev    # 0 vulnerabilities (2026-11-22)
node tests/phase3-files.mjs    # 12 checks
node tests/phase3-monaco.mjs   # 6 checks
node tests/phase3-preview.mjs  # 12 checks (real containers)
node tests/phase3-gateway.mjs  # 13 checks
node tests/phase3-e2e.mjs      # 4 checks (real OMP run + real API restart)
# Browser probe — run from a machine WITH headless Chrome, NOT on the VPS:
node tests/phase3-gateway-browser-probe.mjs  # 3 checks
```

`tests/phase3-gateway-browser-probe.mjs` tunnels to the VPS API over SSH
and drives the headless Chrome at
`~/workspace/remotion-videos/node_modules/.remotion/chrome-headless-shell/…`;
on the VPS it fails (no `/root/.ssh/id_ed25519`) by design.
