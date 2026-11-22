# Deployment

This document is a deployment template. Domain, credentials, and VPS package state were not provided. Do not apply it blindly.

## Target topology

`https://builder.example.com` → Caddy → `127.0.0.1:8787` API. The Vite bundle is served by the API or a separate static server in production; WebSocket upgrades use the same origin.

## Preflight

```sh
ss -ltnup
command -v caddy node npm docker
systemctl list-units --type=service --state=running
sudo ufw status verbose
```

The audited host currently has existing Performance Co-Pilot listeners and SSH. No changes were made. Choose an unused localhost port and never overwrite another service.

## Installation outline

1. Install Node.js 22 LTS from the approved Ubuntu repository or vendor distribution.
2. Create a dedicated unprivileged service account and `/opt/omp-builder` code directory.
3. Store `.env` with mode `0600`; use a random `SESSION_SECRET`.
4. Persist SQLite under `/var/lib/omp-builder` and projects under `/var/lib/omp-builder/projects`.
5. Run `npm ci` and `npm run build`.
6. Run the API with a systemd unit using `Restart=on-failure`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, and a restricted filesystem policy appropriate for the configured data paths.
7. Configure Caddy with automatic HTTPS and WebSocket reverse proxying to `127.0.0.1:8787`.
8. Add health checks and backup timers before accepting traffic.

## Rollback

Keep the previous immutable release directory, stop the service, switch the release symlink, run a compatible migration rollback only if explicitly supported, and restart. Never delete the data directory during rollback.

## Backup and restore

Back up SQLite using a consistent SQLite backup command, project Git/workspace data, and encrypted configuration separately. Test restores to a new directory. Do not back up plaintext provider keys or session cookies.
For this development migration, the source `/tmp/omp-final-data/app.db` was preserved. The verified persistent copy is `/root/projects/omp-builder/data/persistent/app.db`, and the pre-migration SQLite backup is `/root/projects/omp-builder/data/persistent/app.db.backup-20261121`. Both were made with `better-sqlite3` online backup while the source was open, which includes committed WAL state. Keep the database, project workspaces, session directories, OMP configuration, and backup under protected filesystem permissions; never commit them.
