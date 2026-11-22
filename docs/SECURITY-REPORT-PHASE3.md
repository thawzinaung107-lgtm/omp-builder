# Security Report — Phase 3 (2026-11-22)

What was verified, with evidence pointers; what is NOT yet enforced; and
the remaining limitations. Companion to `docs/SECURITY.md` (controls and
dependency remediation) and `docs/DEPLOYMENT.md` (host and operations).
All verification ran against the live VPS (`root@191.40.5.90`) on
2026-11-22 unless noted. Nothing here is claimed from code reading alone
— each item names the test or probe that exercised it.

## Test evidence (all green, final runs 2026-11-22)

| Suite | Result | What it proves |
| --- | --- | --- |
| `tests/phase3-files.mjs` | 12/12 | File listing/read/write, traversal + symlink rejection, cross-project auth, protected paths, 409 conflicts, `files_modified` emission |
| `tests/phase3-monaco.mjs` | 6/6 | monaco-editor 0.57.0, dompurify ≥ 3.4.13 (npm 3.4.18, vendored 3.4.15), `npm audit --omit=dev` 0 vulnerabilities, editor save path |
| `tests/phase3-preview.mjs` | 12/12 (re-run) | Rootless container lifecycle, staging sync, resource limits, isolation probes, restart reconciliation, real Gua Vite app |
| `tests/phase3-gateway.mjs` | 13/13 (re-run) | Gateway auth/SSRF blocks, header stripping, HMR tunnel, iframe `Origin: null` → 403, fs watcher |
| `tests/phase3-gateway-browser-probe.mjs` | 3/3 (run from a machine with headless Chrome, via SSH tunnel) | Real JS in the real sandboxed iframe: `fetch('/api/projects')` and `fetch('/api/auth/status')` blocked, plain and credentialed |
| `tests/phase3-e2e.mjs` (new in 3E) | 4/4 | Real OMP run → gateway → file-API edit live in preview; real API restart recovery; security re-probes; app.db 0600 holds across restart |
| `npm run test:security` | pass (bare command, after the 3E fix) | Provider security + lifecycle regression against a fresh API on a scratch DB |
| `npm run test:rpc` | pass | OMP RPC init + startup-failure smoke |
| `npm run typecheck` / `npm run build` | pass | `build` needs `NODE_OPTIONS=--max-old-space-size=2560` (see below) |
| `npm audit --omit=dev` | 0 vulnerabilities | — |

## What was verified

- **Preview isolation (containers).** A container cannot read the
  image's `/etc/shadow` for host password hashes (all entries locked
  `!`/`*`, no `$1$`/`$5$`/`$6$`/`$y$` hashes, no `omp-builder` user), cannot
  list `/root/.ssh`, cannot reach the host API on `127.0.0.1:8787`, and
  cannot see another project's staging directory. Re-probed in 3E
  (`tests/phase3-e2e.mjs` check 3) against the live Phase 2 preview
  container, plus the 3C suite's `podman run` probes. Container env has
  no secret-named variables (`KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL`)
  and no `Kuoai` reference; the init cmdline carries no key material.
  (Evidence: phase3-preview check 10, phase3-e2e check 3.)
- **Resource limits enforced.** Memory-hog container OOM-killed at the
  512 MiB limit (exit 137; kernel `CONSTRAINT_MEMCG` OOM in dmesg —
  podman 4.9 with the systemd cgroup manager reports `OOMKilled=false`
  for a real cgroup kill, so the tests assert the exit code and the
  kernel evidence, not the flag). `memory.max` 536870912,
  `memory.swap.max` 0, `cpu.max` `100000 100000`, 1 CPU, 128 PIDs,
  read-only rootfs, no-new-privileges, all caps dropped — visible in
  `podman inspect` and the live cgroup files. Limits are enforced ONLY
  through the **systemd** cgroup manager; the cgroupfs fallback silently
  does not enforce them (verified: a hog passed 800 MB under cgroupfs).
  (Evidence: phase3-preview checks 8–9.)
- **Gateway + iframe.** The gateway proxies only to `127.0.0.1:<port>`
  from the `preview_state` DB row for the requested project (no SSRF —
  the client supplies no host/port/target), only GET/HEAD, `/api/*`
  rejected 403, `Cookie`/`Authorization` stripped before proxying,
  `Set-Cookie` stripped from upstream responses, hop-by-hop headers
  stripped both ways, dead upstream → 502, stopped preview → 503,
  unknown project → 404, no cookie → 401. The iframe sandbox is
  `allow-scripts allow-forms allow-popups` with NO `allow-same-origin`,
  so generated JS runs in an opaque origin; the API's CORS check rejects
  `Origin: null` with 403 before auth. Verified at the HTTP layer and in
  a real headless-Chrome probe. (Evidence: phase3-gateway checks 1–11,
  browser probe 3/3.)
- **HMR.** The Vite HMR WebSocket upgrades through the gateway with the
  same cookie + project check; a file edit produces a real HMR update
  over the tunnel; HMR to a stopped preview is rejected.
  (Evidence: phase3-gateway checks 9–10.)
- **File APIs.** Traversal (`../`, absolute, encoded `%2e%2e%2f`,
  backslash), symlink escape (to `/etc` and to another project), and
  cross-project access are rejected; protected paths (`.env`, `.env.*`,
  `*.pem`, `*credentials*`, `node_modules`, `.git`) return 403; stale
  `expectedMtime` returns 409; 1 MiB write cap; binary extensions 415.
  (Evidence: phase3-files checks 5–9, 12.)
- **Full prompt-to-preview (real AI).** A real OMP agent
  (Kuoai/gpt-6-sol) generated a small React+Vite counter app from a
  one-line prompt; the preview container served it through the gateway;
  a file-API edit went live in the preview. Throwaway project deleted
  afterwards (DB rows, workspace, session dir, staging, container,
  volume). (Evidence: phase3-e2e check 1, run 2026-11-22 ~13:00 UTC;
  marker `Counter-E2E-bcecc0` served through the gateway.)
- **Backend restart recovery (real).** The API process was killed
  (SIGTERM to the concurrently parent) and relaunched; the Phase 2
  container was removed externally beforehand so its row was genuinely
  stale — reconcile marked it `stopped`, removed no files (workspace
  SHA-256 hashes identical before/after), left no orphan `omp-preview-*`
  container, and a fresh WebSocket connection replayed 383 persisted
  events including pre-restart ids. Also verified: containers SURVIVE
  an API restart (close() only detaches log followers) and reconcile
  correctly leaves a live container's row `running` — in that case it
  logs nothing, because it only logs when something was removed or
  marked stale. (Evidence: phase3-e2e check 2; phase3-preview check 11
  covers the abandoned-container case.)
- **Data survival.** Project workspaces, `preview_state`, and
  `omp_events` survive the restart (hashes + replay above). Database
  `user_version` 3.
- **App.db permissions (hardened in 3E).** `data/persistent/app.db`,
  `app.db-wal`, `app.db-shm`, and the two backup files alongside them
  are now mode **0600** (were 0644); `.env` was already 0600. The API
  (root) still works after the change, and the 0600 modes still hold
  after a full API restart (SQLite did not recreate the WAL/SHM
  world-readable). (Evidence: phase3-e2e check 4; `ls -l
  data/persistent/` 2026-11-22.)
- **Builder renders; login enforced.** The Builder was rendered in a
  real headless Chrome via an SSH tunnel (local 5173 → VPS 5173): the
  React app mounts and shows the "Welcome back / Sign in" screen
  (email + password + Sign in). No click-through was possible — the
  admin password is unknown and was not sought or reset — so the
  logged-in UI (Files/Preview/Logs tabs) is left for user QC.
  (Evidence: `/tmp/builder-login.png` on the operator machine,
  2026-11-22.)
- **Dependency posture.** `npm audit --omit=dev` reports 0
  vulnerabilities. Monaco 0.57.0 with dompurify pinned `^3.4.13` via
  npm `overrides` (CVE-2026-0540, GHSA-55q2-fjhq-7xh7); the vendored
  copy inside Monaco is 3.4.15, also patched. (Evidence:
  phase3-monaco checks 2–4.)

## What is NOT yet enforced

- **Egress allow-listing.** Preview containers can reach the public
  internet (required for `npm ci`) and, in at least one probe, the host
  LAN address. There is no egress firewall/dns allow-list for
  containers. A malicious preview could exfiltrate data or probe the
  LAN. This is the largest open item; it needs a follow-up (e.g.
  per-container nftables/iptables rules or a filtering proxy) that
  keeps `registry.npmjs.org` reachable for installs.
- **Host-LAN reachability — unresolved variance, do not rely on it.**
  The API binds `127.0.0.1:8787` only, so `191.40.5.90:8787` SHOULD be
  unreachable from a container. Probes: 3C run — REACHABLE; 3D run —
  unreachable; 3E preview re-run — (not separately recorded); 3E e2e
  run — unreachable. The single reachable result is unexplained (no
  firewall rule was found or configured; no rule is claimed here). Do
  not treat host-LAN as blocked, and do not treat it as open — treat
  egress as untrusted until allow-listing lands.
- **Dedicated preview origin (production).** In development the gateway
  and the Builder share one origin, so the iframe sandbox — not origin
  separation — is the isolation boundary. A dedicated preview origin
  (e.g. `preview-<id>.example.com` with its own cookie scope) is
  required before serving Builder and previews from a shared production
  origin.
- **OMP-as-service-user is opt-in, not default.** OMP children still
  spawn as **root** by default. The opt-in gate
  (`OMP_RUN_AS_USER_PROJECT_IDS`, runuser spawn, `HOME=/var/lib/omp-builder`)
  was verified working on the Phase 2 fixture in 3C (session settled,
  files written owned by omp-builder), but **no project is currently
  opted in** and the `/root`/repo-root traversal grants used for the
  verification were reverted. Consequence: the "no unrestricted root
  execution required" acceptance item is PARTIAL — see Acceptance §14
  in the 3E report. The config copy's `models.yml` is NOT auto-synced
  when providers change (resync manually after provider changes).
- **In-memory rate limiting, no CSRF tokens, no security headers,
  no audit logging, no backup key rotation.** Carried over from
  `docs/SECURITY.md` "Required before production". Single-admin auth
  only; no multi-user isolation (the user has said other people will
  use the platform later — per-user providers/keys and multi-user auth
  become required beyond Phase 3).
- **Gateway trusts container responses.** A malicious preview could
  serve phishing content inside the iframe; the sandbox blocks
  credential theft but not lookalike UI.
- **Vite wrapper merges the project's own Vite config**
  (`loadConfigFromFile`); a malicious/broken user config could change
  dev-server behaviour inside the container only.
- **Stale sessions.** Five unrevoked sessions exist in the DB (oldest
  created 2026-11-21). They were not revoked during 3E (they may
  include the user's own browser session); stale sessions should be
  reviewed and revoked by the user/admin. Test sessions minted by the
  Phase 3 suites are revoked by each suite's cleanup.
- **No systemd units yet.** The API + web run under a hand-supervised
  `npm run dev` (concurrently) process, not a service with
  `Restart=on-failure`. A host reboot leaves the Builder down until
  someone restarts it.

## Remaining limitations (3E findings)

- **Test-harness bugs found and fixed in 3E (test code only, not the
  product):**
  1. `execFile("bash", ["-c", "... && setsid nohup npm run dev ... &"])`
     hangs forever: `&` binds to the whole `&&` chain, so the background
     subshell runs `npm run dev` in its FOREGROUND and holds the
     execFile stdio pipes open (diagnosed live: the relaunch bash sat
     alive 9+ minutes while the e2e script waited). Fixed by launching
     the restarted API with `spawn(..., { detached: true, stdio: "ignore" })`
     + `unref()` in `tests/phase3-e2e.mjs` (`relaunchApi()`).
  2. Test helpers that shell out to `runuser`/`podman` must pass
     `cwd: "/"` (as the API already does in `apps/api/src/preview.ts`):
     podman fails to resolve its working directory when spawned from a
     cwd the service user cannot traverse (`/root` is 0700) —
     `cannot chdir to /root/projects/omp-builder: Permission denied`.
     Fixed in `tests/phase3-e2e.mjs`, `tests/phase3-gateway.mjs`
     (cleanup volume rm), and `tests/phase3-gateway-browser-probe.mjs`
     (`cd /tmp &&` prefix on the remote cleanup). `tests/phase3-preview.mjs`
     already had `cwd: "/"`.
- **Build memory.** The full web build OOMs at Node's default ~2 GB
  heap on this 3.8 GB host (`FATAL ERROR: Ineffective mark-compacts
  near heap limit`, exit 134). `NODE_OPTIONS=--max-old-space-size=2560`
  is now baked into `npm run test:security`; run any full build with
  that variable. The 2 GB swapfile is a requirement, not a nicety.
  `tsx watch` restarts are flaky — always verify a restart via the log
  (`OMP Builder API listening` + `[preview] startup reconcile` when
  applicable) and `/api/health`, never assume.
- **Reconcile logging.** `reconcile()` only logs `[preview] startup
  reconcile` when it removed an abandoned container or marked a row
  stale. A clean restart logs nothing about reconciliation; absence of
  the line is not evidence it didn't run — check the DB rows.
- **Headless-shell rendering is slow/flaky for the Builder.**
  `--virtual-time-budget` stalls on the vite HMR WebSocket; `--dump-dom
  --timeout` returned an empty DOM. CDP (navigate + 10 s wait +
  `Runtime.evaluate`) works reliably. Logged-in UI was not
  click-tested (no admin password) — user QC.
