# OMP Builder

Self-hosted, web-native AI application builder powered exclusively by [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). This is an independent project; it does not convert or embed Open-Laudable's Electron application.

## Current status

Phase 2 OMP integration is implemented behind the authenticated local API. Dependency remediation is complete:

- React/Vite/Tailwind frontend with real reconnecting OMP chat, streamed assistant/tool/status events, replay, cancellation, and provider model selection.
- TypeScript backend with OMP JSONL RPC v2 negotiation, backend-owned sessions, session recovery, SQLite event persistence, authenticated WebSocket controls, process limits, and graceful shutdown.
- Encrypted AES-256-GCM provider credentials, masked provider APIs, provider connectivity testing, HTTPS/localhost SSRF restrictions, and generated environment-reference `models.yml`.
- Direct Zod dependencies are upgraded from `3.25.76` to patched `4.6.7`; unused Monaco/DOMPurify packages are removed; `npm audit --omit=dev` reports zero vulnerabilities.

Live provider acceptance remains dependent on configuring a compatible provider credential. Preview, Monaco, isolated execution, GitHub, and deployment automation remain future milestones.

## Requirements

- Node.js 22 LTS (the development VPS currently has neither Node nor Bun installed; see `docs/ARCHITECTURE.md`).
- npm 10+
- SQLite build prerequisites for `better-sqlite3`.

## Development

The API binds to loopback only. The browser uses relative `/api` and `/ws` paths, so Vite proxies authenticated requests and WebSocket upgrades to the API without exposing the backend port.

```sh
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. The frontend uses relative `/api` and `/ws` paths, so Vite proxies both through the same browser origin. For SSH/mobile previews, keep `DEV_DYNAMIC_FORWARD_ORIGIN=true` and use the exact host `new-lovable.localhost`; any numeric forwarded port is accepted in development without editing `.env`. Vite still allows only that hostname. Production disables the dynamic rule and requires exact `WEB_ORIGINS` entries.

The API loads `.env` from the repository root based on its module location, not `process.cwd()`. Relative paths in `.env` resolve from that root. An explicit `DATABASE_PATH` must already be a regular file; startup refuses to create an empty replacement when it is missing.

Origin checking is an application-layer allowlist, not a replacement for authentication or transport security. It does not prove that a browser reached the service through the intended SSH tunnel, so keep the API on `127.0.0.1`, use authenticated sessions, and never trust `X-Forwarded-Host`.

## Startup commands

From any current directory, start the workspace with `npm run dev` from this repository. For separate processes: `npm run dev --workspace @omp-builder/api` and `npm run dev --workspace @omp-builder/web`. The API remains bound to `127.0.0.1:8787`; Vite serves `127.0.0.1:5173` and proxies `/api` and `/ws`. SSH preview clients may forward the frontend port to any numeric `new-lovable.localhost` port in development.
## Verification

Verified with Node 22: `npm run typecheck`, `npm run build`, `npm run test:security`, and `npm audit --omit=dev`.

## Production

See `docs/DEPLOYMENT.md`. The intended topology is Caddy → localhost-bound API, with the API owning OMP child processes and isolated project runtimes. Do not expose the RPC process, Docker socket, or project directories to clients.

## Licenses and attribution

- This repository is original application code and is not a fork of Open-Laudable.
- UI research and compatible interaction patterns were informed by Open-Laudable, Apache License 2.0: https://github.com/ishandutta2007/Open-Laudable
- OMP is an external MIT-licensed dependency/reference: https://github.com/can1357/oh-my-pi
- See `docs/COMPONENT_REUSE.md` for the reuse boundary.
