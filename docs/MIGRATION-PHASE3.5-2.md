# Phase 3.5 §2 — Non-root OMP execution: migration plan + record

Date: 2026-11-22. Branch: `feature/phase-3.5-hardening` (from 6fb358d).
Status: MIGRATED — see "Record" at the end for what actually happened.

## Why this is feasible (preflight findings)

- The code already resolves every runtime path from the repo root or the
  environment — nothing hard-codes `/root/projects/omp-builder` except test
  defaults and one comment. `config.ts` derives `projectRoot` from the
  source file location, so moving the repo to `/opt/omp-builder` moves the
  default paths with it; absolute `.env` values override them.
- The service user `omp-builder` (uid 996, linger, `user@996.service`
  active) already exists, already owns `/var/lib/omp-builder` (previews,
  omp-config copy), and already runs the preview containers.
- The OMP binary already has an identical world-executable copy at
  `/usr/local/bin/omp` (md5 `db642cf702d20e68fc15580a380c72ca`, same as
  `/root/.local/bin/omp`, v19.1.0).
- The only hard blocker found in preflight: **`runuser` refuses non-root
  callers** (`runuser: may not be used by non-root users`, verified). Both
  `runuser -u omp-builder` call sites (OMP spawn in `omp-rpc.ts`, podman in
  `preview.ts`) would fail the moment the API itself runs as
  `omp-builder`. Both get a same-user fast path (spawn directly, no
  runuser) when `process.getuid() === 996`. The root-spawn paths are kept
  unchanged for rollback / non-service-user runs.

## Target layout

| What | Before | After |
| --- | --- | --- |
| App repo | `/root/projects/omp-builder` | `/opt/omp-builder` (git repo, owned by `omp-builder`) |
| SQLite + data | `/root/projects/omp-builder/data/` | `/var/lib/omp-builder/data/` (`persistent/app.db`, `projects/`, `omp-sessions/`, `omp-config/`) |
| `.env` | repo root, 0600 root | `/opt/omp-builder/.env`, 0600 `omp-builder`, absolute data paths |
| Node 22.23.5 | `/root/.nvm/...` (unreachable to `omp-builder`) | `/usr/local/node-22.23.5` (world-readable copy of the verified install) |
| OMP binary | `/root/.local/bin/omp` | `/usr/local/bin/omp` (already present, identical) |
| OMP user config | `/var/lib/omp-builder/omp-config` (stale-prone copy) | the real config dir `/var/lib/omp-builder/data/omp-config` via `OMP_USER_CONFIG_DIR` — kills the 3C `models.yml` sync gap; the old copy stays on disk, unused |
| Previews | `/var/lib/omp-builder/previews` | unchanged |
| Services | `nohup npm run dev` as root | systemd unit `omp-builder.service` (`User=omp-builder`, `npm run dev` = concurrently tsx-watch API + Vite web, `Restart=on-failure`) |
| OMP children | root spawn (opt-in per project) | service-user spawn for ALL projects by default (`OMP_RUN_AS_USER` escape hatch, see below) |
| Rollback copy | — | `/root/projects/omp-builder` frozen pre-migration (services stopped, data frozen at copy time) |

## What moves, what stays

- Moves (by copy, originals intact until verified): whole repo incl.
  `node_modules` and `.git`; `data/`; `.env` (rewritten paths only).
- Rewritten in the COPY only: DB `projects.workspace_path` /
  `session_dir` (absolute old prefix → new prefix); the same literal
  prefix inside text files under `data/omp-sessions/` and
  `data/omp-config/custom-session-files/` (OMP session transcripts and
  session-file pointers). Historical `omp_events` payloads keep old paths
  (append-only history, never read as paths).
- NOT binary-patched: OMP's own `agent.db` / `models.db` under
  `data/omp-config` — check with `strings` whether they embed the old
  prefix and record the result; OMP `--continue` resume reads the session
  jsonl files, which are rewritten.
- Stays: admin account, providers (Kuoai/gpt-6-sol, key still AES-256-GCM
  under the same `OMP_MASTER_KEY`), all 3 projects, OMP sessions,
  `preview_state` rows (container names/ports are path-independent),
  `/var/lib/omp-builder/omp-config` (unused copy), the Gua Vite server on
  4173 (keeps serving from the OLD workspace path until restarted — its
  files move with the data copy, the live server is untouched).
- Ports unchanged: API `127.0.0.1:8787`, web `0.0.0.0:5173`, Gua
  `127.0.0.1:4173`. No new public ports, no new public exposure.

## Code changes (committed on the branch after verification)

1. `apps/api/src/config.ts` — non-root OMP is now the default: an empty
   `OMP_RUN_AS_USER_PROJECT_IDS` means ALL projects run as the service
   user (previously it meant none). New escape hatch `OMP_RUN_AS_USER=false`
   restores root spawn for every project. Explicit allowlist still works.
2. `apps/api/src/server.ts` — the 0710 session-root traversal grant
   applies only when the API itself runs as root (uid 0); as
   `omp-builder` it is unnecessary (same-uid children) and `chown` to
   root would fail. `runAsUserFor` uses the new default.
3. `apps/api/src/omp-rpc.ts` — same-user fast path: when the API already
   runs as uid 996, spawn `/usr/local/bin/omp` directly (no runuser),
   skip the chown (dirs already owned), same HOME/XDG/config env.
4. `apps/api/src/preview.ts` — same-user fast path in `runPodman`:
   spawn `/usr/bin/podman` directly with the podman env
   (`XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `HOME`, `PATH`) via
   spawn `env` instead of the `runuser … /usr/bin/env …` argv form.
   Root path unchanged. Header comment updated (workspaces are no
   longer root-owned).
5. Tests — hardcoded `/root` defaults moved to the new layout (env
   overrides retained): `phase3-files/gateway/preview/monaco/e2e`
   DB/projects/repo paths, e2e relaunch node path
   (`/usr/local/node-22.23.5/bin/npm`), `security-regression.mjs`
   `OMP_BIN`, `omp-rpc-smoke.mjs` binary assertion
   (`/usr/local/bin/omp`). E2E check 2 (restart) now uses
   `systemctl restart omp-builder` instead of kill + manual relaunch —
   under systemd `Restart=on-failure`, a manual relaunch would race the
   unit's own restart on the same port.
6. Docs — this file; `docs/DEPLOYMENT.md` (new layout, systemd unit,
   rollback) and `docs/SECURITY.md` (non-root is now the default;
   `models.yml` sync gap closed) updated.

## Procedure (order matters)

1. Fresh pre-3.5 backup: tar of `data/` + `.env` (mode 600) +
   `git bundle` of the branch; verify listings + sizes. The Phase 3
   backup is NOT a substitute.
2. Stop the old services: SIGTERM to the `concurrently` parent by
   verified PID; confirm 8787/5173 down, 4173 still up. (Stopping the
   API first makes the DB copy consistent; no `cp` of a live DB.)
3. Copy: `cp -a` repo → `/opt/omp-builder`, `data/` →
   `/var/lib/omp-builder/data`, node 22.23.5 → `/usr/local/node-22.23.5`.
4. New `.env` (copy + sed on path keys only; secrets untouched),
   DB path rewrite + `integrity_check`, session-file prefix rewrite,
   `chown -R omp-builder`, perms (app.db 0600, data dirs 0700).
5. Deploy code changes as a tarball (exact relative paths, md5 check).
6. Systemd unit `omp-builder.service`, `daemon-reload`, `enable`,
   `start`; verify health, logs, and that API/web/OMP children run as
   `omp-builder` (`ps -o user=`).
7. Verify: `npm run test:rpc` + `npm run test:security` (as
   `omp-builder`), `npm run typecheck`, `npm run build`,
   `npm audit --omit=dev`; minted-session login check (mint → use →
   revoke, never the user's password); file-API round-trip; preview
   start → gateway serve → stop for the Phase 2 fixture; full
   `tests/phase3-e2e.mjs` (real Kuoai prompt → preview → gateway →
   `systemctl` restart recovery → security re-probes).
8. Commit on `feature/phase-3.5-hardening`. Do NOT push (separate track).

## Rollback

1. `systemctl stop omp-builder` (and `disable` if it was enabled).
2. From `/root/projects/omp-builder`: `setsid nohup npm run dev`
   (root, nvm node on PATH) exactly as before; verify `/api/health`
   and 5173.
3. The old DB is frozen at copy time — any projects/prompts created
   after the migration exist only in the new DB. Rollback loses them;
   re-migration would need a fresh copy. Never delete either copy
   during rollback.
4. The Gua 4173 server never stopped, so it needs no rollback step.

## Known limitations (carried, not introduced)

- Egress allow-listing for preview containers is still open (Phase 3
  report); the migration does not change it.
- `user@996.service` must stay lingering; if it ever goes down, podman
  fails loudly (fail closed) instead of running unlimited.
- The systemd unit runs `npm run dev` (concurrently + tsx watch + Vite
  dev), i.e. the dev workflow, not a production build. Splitting API
  and web into separate units / a production build is a follow-up.
- The old `/root/projects/omp-builder` tree remains as the rollback
  copy; its `.env` still points at the old (frozen) data — do not start
  services from both locations at once (port conflict + split brain).

## Record (completed 2026-11-22 ~15:15 Yangon)

- Backup: `/root/omp-builder-backup-phase3.5-20261122.tgz` (19,581,791
  bytes, 5120 entries, mode 0600; contains `data/` + `.env`) +
  `/root/omp-builder-backup-phase3.5-20261122.bundle` (257,963 bytes,
  `git bundle verify` OK, HEAD 6fb358d). DB integrity ok pre-copy.
- Copy verified: repo 863 files, data 5012 files, node_modules 14664
  entries — identical counts old vs new. Node copy
  `/usr/local/node-22.23.5` runs v22.23.5.
- Data rewrite (copy only): DB `projects` 3 rows updated to
  `/var/lib/omp-builder/data/…`, integrity ok, `user_version` 3, 0
  old-prefix rows; session/config text files: 16 files, 59 occurrences
  rewritten, 0 remaining; OMP `agent.db`/`models.db` contain 0
  old-prefix refs (no binary patch needed). Old tree untouched (old
  jsonl still has old paths; old DB still has old paths).
- Ownership: `/opt/omp-builder` + `/var/lib/omp-builder/data` chown
  `-R omp-builder:omp-builder`; `.env` + `app.db` 0600;
  `data/projects` + `data/persistent` 0700.
- Services: `omp-builder.service` enabled + active; API 8787 healthy,
  web 5173:200, Gua 4173:200 (still root, old path). Journal confirms
  `.env` `/opt/omp-builder/.env`, `databasePath`
  `/var/lib/omp-builder/data/persistent/app.db`, `ompExecutable`
  `/usr/local/bin/omp`, master key valid.
- Verification (all as `omp-builder` unless noted): typecheck pass;
  `npm audit --omit=dev` 0 vulnerabilities; `test:rpc` pass (after a
  smoke-test fix — see deviations); `test:security` pass (exit 0, web
  built in 55.58s); minted-session login + file round-trip (uid 996 on
  disk) + preview start/gateway/stop (Hello marker served) all pass,
  session revoked → 401; `phase3-e2e` 4/4 (real Kuoai prompt as
  `omp-builder` → React+Vite counter app, gateway served, file edit
  live, marker `Counter-E2E-70bc21`; `systemctl restart` recovery with
  429 events replayed; security re-probes pass; `app.db` 0600 holds);
  `phase3-files` 12/12, `phase3-monaco` 6/6, `phase3-gateway` 13/13,
  `phase3-preview` 12/12. Two empty suite throwaways deleted
  afterwards; DB back to the 3 original projects; no containers running.
- Deviations from plan: (1) `test:rpc` initially failed — bare OMP as
  `omp-builder` exits 1 ("No default model selected") because the smoke
  test relied on root's ambient `/root/.omp` config; fixed by pointing
  the smoke spawn at the real config dir via `OMP_CONFIG_DIR` (mirrors
  the API). The API path was never affected (it always passes config
  dir + `--model`). (2) The e2e restart check now uses `systemctl
  restart`, as the plan anticipated.
