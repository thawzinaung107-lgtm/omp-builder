# Implementation Plan

## Phase 1 — Foundation (implemented)

- Audit Open-Laudable, OMP RPC documentation, VPS listeners, and runtimes.
- Create an independent npm workspaces monorepo.
- Add SQLite-backed single-admin setup/login/logout with opaque HTTP-only sessions.
- Add authenticated project dashboard and builder layout shell.
- Add documentation and deployment placeholders.

## Phase 2 — OMP integration (in progress)

- Add backend-owned `OmpRpcSession` using OMP's documented `--mode rpc` JSONL transport and protocol v2 negotiation.
- Persist project workspace/session mapping, OMP events, and provider metadata through idempotent SQLite schema setup.
- Stream structured assistant/tool/status events over authenticated, replayable WebSockets with prompt cancellation and reconnect support.
- Add encrypted provider CRUD/test endpoints, masked responses, localhost/HTTPS SSRF restrictions, and generated environment-reference model configuration.
- Keep OMP headless and fail closed for approval/UI requests; raw stdio remains backend-only.

Phase 2 real-provider acceptance is blocked until an administrator configures a compatible provider credential. Preview, Monaco, isolated execution, GitHub, and deployment automation remain Phase 3–4 work.

## Phase 3 — Workspace and preview

- Create isolated workspace directories and initialize Git at project creation.
- Add server-validated file listing/read/write APIs; integrate Monaco.
- Start per-project preview containers with CPU/memory/PID/disk limits, no host socket, no host secrets, and restricted proxying.
- Refresh previews on safe file changes. Preserve the same workspace for follow-up prompts.

## Phase 4 — GitHub and deployment

- Add server-side GitHub clone/status/commit/pull/push/branch/history operations with explicit destructive-action confirmation.
- Add snapshots, audit records, backups, restore, health checks, Caddy config, systemd unit, and rollback script.
- Run browser, API, WebSocket, OMP, persistence, and sandbox end-to-end tests against real services.

## Acceptance gates

A phase is only marked complete after its observable behavior is exercised. Phase 1's gate is browser login plus persistent project metadata and authenticated private routes. The full MVP gate requires a real OMP process, streamed events, persistent files, preview, follow-up modification, restart recovery, and sandbox-secret isolation; those are not claimed in this milestone.
