# Deployment

OMP Builder as deployed on the VPS (verified 2026-11-22, Phase 3E;
migrated to non-root execution in Phase 3.5 §2 — see
`docs/MIGRATION-PHASE3.5-2.md`). This
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
- Node **22.23.5** at `/usr/local/node-22.23.5/bin` (world-readable copy
  of the verified nvm install; the system `node` is v18 and **cannot**
  run this repo — `better-sqlite3` is compiled for Node 22,
  `NODE_MODULE_VERSION 127`). Every command in this document assumes
  `export PATH=/usr/local/node-22.23.5/bin:$PATH`. The old nvm path
  (`/root/.nvm/versions/node/v22.23.5/bin`) still exists but is
  unreachable to the service user.
- Repo `/opt/omp-builder`, branch `feature/phase-3.5-hardening`.
  Data (SQLite, workspaces, OMP sessions/config) under
  `/var/lib/omp-builder/data/`. Never commit `data/` or secrets; see
  `.gitignore`. The pre-migration tree `/root/projects/omp-builder` is
  kept frozen as the rollback copy — do not run services from both
  locations at once.
- Podman **4.9.3** (crun, overlay, cgroup2fs). Node image cached:
  `docker.io/library/node:22-alpine`.

## Services (as running)

One systemd unit, `omp-builder.service` (`User=omp-builder`,
`WorkingDirectory=/opt/omp-builder`, `Restart=on-failure`), runs
`npm run dev` (concurrently: tsx-watch API + Vite web). It is enabled,
so it starts on boot.

| Service | Listen | Process |
| --- | --- | --- |
| API | `127.0.0.1:8787` | `tsx watch src/server.ts` (workspace `@omp-builder/api`), as `omp-builder` |
| Web (Vite dev) | `127.0.0.1:5173` (serves on all interfaces) | `vite` (workspace `@omp-builder/web`), as `omp-builder` |

Health: `curl http://127.0.0.1:8787/api/health` → `{"ok":true}`.
Web: `curl http://127.0.0.1:5173/` → 200.

### Start / restart

```sh
systemctl restart omp-builder.service
systemctl status omp-builder.service --no-pager
curl -s http://127.0.0.1:8787/api/health   # must return {"ok":true}
# Verify the restart in the journal — tsx watch restarts are flaky, never assume:
journalctl -u omp-builder.service --since "5 minutes ago" -n 100 --no-pager | grep -E "OMP Builder API listening|startup reconcile"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5173/
```

Do NOT kill the concurrently process directly: the unit's
`Restart=on-failure` would race a manual relaunch on the same port.
`systemctl restart` is the only restart path. Restarting the unit
restarts **both** API and web. The API logs its preview reconciliation
on every start (`[preview] startup reconcile`). Logs: `journalctl -u
omp-builder.service`.

### Gua preview app (separate, not a Builder service)

The user's overnight OMP test app "Gua — Plotline" runs its own Vite
server on `127.0.0.1:4173` from
`/var/lib/omp-builder/data/projects/4f75505f-a2d9-4cc9-b6f8-4e3978c6de9b`
(`npx vite --host 0.0.0.0 --port 4173 --strictPort`). **Stop it during
builds** (it competes for the same 3.8 GB RAM) and restart it after:

```sh
# stop: kill the vite node process + its npm wrapper by explicit PID
# (find them with: ps aux | grep "[v]ite --host 0.0.0.0 --port 4173")
kill <vite-pid> <npm-pid>
# restart:
cd /var/lib/omp-builder/data/projects/4f75505f-a2d9-4cc9-b6f8-4e3978c6de9b
setsid nohup /usr/local/node-22.23.5/bin/npx vite --host 0.0.0.0 --port 4173 --strictPort > /tmp/gua-4173.log 2>&1 < /dev/null &
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4173/
```

Note: the 4173 server that was running across the Phase 3.5 §2
migration still serves from the OLD path
(`/root/projects/omp-builder/data/projects/4f75505f-…`) until it is
restarted with the snippet above; its files are identical to the
migrated copy.

## Preview architecture (Phase 3C/3D)

1. **Staging sync.** The API mirrors a project's workspace to
   `/var/lib/omp-builder/previews/<projectId>` (0700, owned by the
   `omp-builder` service user), excluding `node_modules`, `.git`, `.omp`,
   `dist`, `build`, `.next`, `.cache`, `.env*`, `*.pem`, `*.key` and all
   symlinks. Sync runs on preview start/restart and debounced (1.5 s)
   after file saves and OMP `files_modified` events. The live workspace
   is **never** bind-mounted into a container.
2. **Rootless container.** Run as `omp-builder` (via `runuser` when the
   API runs as root, directly when it already runs as `omp-builder` —
   `runuser` refuses non-root callers; see `runPodman` in
   `apps/api/src/preview.ts`), image `docker.io/library/node:22-alpine`,
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
  linger enabled, `user@996.service` active. The API, web server, OMP
  RPC children, and preview containers all run as this user (Phase 3.5
  §2). Nothing Builder-related runs as root anymore, except the
  pre-migration rollback copy (stopped) and the Gua 4173 server.
- OMP binary for the service user: world-executable copy at
  `/usr/local/bin/omp` (the real binary lives under `/root`, unreachable
  to `omp-builder`); the OMP child config dir is the real config dir
  (`/var/lib/omp-builder/data/omp-config`, via `OMP_USER_CONFIG_DIR`),
  so its `models.yml` is always in sync — the 3C manual-resync gap is
  closed. The old copy at `/var/lib/omp-builder/omp-config` stays on
  disk, unused.
- **OMP-as-service-user is the default since Phase 3.5 §2** (was opt-in
  in 3C). An empty `OMP_RUN_AS_USER_PROJECT_IDS` now means ALL projects;
  an explicit list still acts as an allowlist. Escape hatch:
  `OMP_RUN_AS_USER=false` restores root spawn for every project.
  Because the API itself runs as `omp-builder`, OMP children are
  spawned directly, not via `runuser` (which refuses non-root callers);
  the runuser path is kept for the root-run rollback layout. No
  `/root`/repo-root traversal grants are needed anymore.
- Node for the service user: `/usr/local/node-22.23.5/bin` (see above).

## Environment variables

Only the repository-root `.env` is loaded (values already in the process
environment win). `.env` is mode **0600**; never print its values.

| Variable | Default | Notes |
| --- | --- | --- |
| `API_PORT` / `API_HOST` | `8787` / `127.0.0.1` | Never expose the API publicly; bind loopback only |
| `SESSION_COOKIE_NAME` | `omp_builder_session` | HttpOnly, SameSite=Lax |
| `SESSION_TTL_DAYS` | `14` | Session lifetime |
| `SESSION_COOKIE_SECURE` | `false` | Set `true` behind HTTPS |
| `DATABASE_PATH` | `/var/lib/omp-builder/data/persistent/app.db` | Explicit path must already exist (API refuses to create it) |
| `PROJECTS_ROOT` | `/var/lib/omp-builder/data/projects` | Workspaces are 0700 `omp-builder`-owned |
| `OMP_SESSION_ROOT` | `/var/lib/omp-builder/data/omp-sessions` | Per-project OMP session dirs, 0700 `omp-builder`-owned |
| `OMP_CONFIG_DIR` | `/var/lib/omp-builder/data/omp-config` | OMP config incl. generated `models.yml` |
| `OMP_BIN` | `/usr/local/bin/omp` | Resolved via PATH; must be reachable by `omp-builder` |
| `OMP_BIN_USER` | `/usr/local/bin/omp` | Binary used for service-user OMP children |
| `OMP_USER_CONFIG_DIR` | `/var/lib/omp-builder/data/omp-config` | Config dir for service-user OMP children (= real config dir, so `models.yml` stays in sync) |
| `OMP_MAX_PROCESSES` | `2` | Concurrent OMP children |
| `OMP_IDLE_MS` | `900000` (15 min) | Idle OMP sessions closed (checked every 60 s) |
| `OMP_RUN_AS_USER` | `true` | `false` restores root spawn for all projects (escape hatch) |
| `OMP_RUN_AS_USER_PROJECT_IDS` | _(empty = all)_ | Explicit allowlist; empty now means ALL projects (was: none, pre-3.5 §2) |
| `OMP_MASTER_KEY` | _(required)_ | Base64 32-byte key; AES-256-GCM for provider credentials |
| `SESSION_SECRET` | _(required)_ | Session signing secret |
| `WEB_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | CORS allowlist; dev also allows `http://new-lovable.localhost:<port>` |
| `DEV_DYNAMIC_FORWARD_ORIGIN` | `true` (dev) | Set `false` in production |
| `DEV_FORWARD_HOST` / `DEV_FORWARD_PORT` | `new-lovable.localhost` | Host is pinned; port optional |
| `APP_ENV` / `NODE_ENV` | `development` | `production` disables dynamic forward origins |

## Backup and restore

- **Database:** `/var/lib/omp-builder/data/persistent/app.db` (mode
  **0600**, owned by `omp-builder` since Phase 3.5 §2; `-wal`/`-shm`
  and the backup files alongside it are 0600 too). Back
  up with a consistent SQLite backup while the API is running, e.g.
  via a `better-sqlite3` online backup (the method used for
  `data/persistent/app.db.backup-20261121` and
  `app.db.backup-provider-attach-1795305986`). Never copy the live file
  with plain `cp` while the API holds it open — use the backup API.
  Verify with `PRAGMA integrity_check` on the copy.
- **Also back up:** project workspaces (`/var/lib/omp-builder/data/projects/`),
  OMP session dirs (`/var/lib/omp-builder/data/omp-sessions/`), OMP
  config (`/var/lib/omp-builder/data/omp-config/`), and `.env`
  (separately, encrypted — it holds the master key and session secret).
  Do **not** back up plaintext provider keys or session cookies. The
  pre-3.5 backup is `/root/omp-builder-backup-phase3.5-20261122.tgz`
  (+ git bundle of the same name), mode 0600.
- **Restore:** stop the service (`systemctl stop omp-builder`), restore
  the DB + directories with the same ownership/permissions (workspaces
  0700 `omp-builder`, DB 0600 `omp-builder`), start the service, check
  `/api/health` and the `[preview] startup reconcile` journal line.
  Test restores to a fresh directory before relying on them.
- **Rollback to the pre-migration layout:** `systemctl stop
  omp-builder` (and `disable` if it was enabled), then from
  `/root/projects/omp-builder` run the old `setsid nohup npm run dev`
  as root with the nvm Node on PATH (see
  `docs/MIGRATION-PHASE3.5-2.md`). The old DB is frozen at copy time —
  anything created after the migration exists only in the new DB.
- Never delete the data directory during rollback. Migrations are
  additive (`user_version` 3 as of Phase 3); there is no downgrade path
  — keep the previous release directory and the pre-migration DB backup.

## Production checklist (still open)

- Split the single `omp-builder.service` unit into separate API + web
  units (with `Restart=on-failure`, `NoNewPrivileges=yes`,
  `PrivateTmp=yes`, restricted filesystem policy). The single unit is
  the dev workflow under systemd; it is not yet a production split.
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
export PATH=/usr/local/node-22.23.5/bin:$PATH
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
