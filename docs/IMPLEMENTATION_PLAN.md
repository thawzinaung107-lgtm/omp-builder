<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:a81f29c1d6bd44329fea8b423dc45cb8ffaac8227bd4f19bcc991e6961e5f21b -->

# Implementation Plan

## Phase 1 — Foundation (implemented)

- Audit Open-Laudable, OMP RPC documentation, VPS listeners, and runtimes.
- Create an independent npm workspaces monorepo.
- Add SQLite backed single-admin setup, login, logout, and HTTP-only sessions.
- Add the authenticated project dashboard and builder layout.

## Phase 2 — OMP integration (implemented; live provider required)

The API owns OMP RPC v2, project sessions, authenticated prompt and abort commands, and WebSocket replay. SQLite stores projects, events, and provider metadata; provider credentials stay encrypted on the server. OMP remains the exclusive coding engine, using the existing dynamic OpenAI-compatible provider configuration. Approval and UI requests fail closed. The [Phase 3.5 migration record](MIGRATION-PHASE3.5-2.md) records an earlier real provider run; each new deployment still needs a compatible provider configured.

## Phase 3 — Workspace and preview

### Audit baseline

Reviewed OMP Builder at `a9f1030300855db84687addea4fd5246d31a091d` and Dyad at `56cc3964a8983296a1f49d511cb8afde1719c6f3`. The [Phase 3 security report](SECURITY-REPORT-PHASE3.md) and [Phase 3.5 migration record](MIGRATION-PHASE3.5-2.md) contain historical browser, API, real OMP, and Podman results. The browser isolation probe is a separate iframe harness; the Monaco suite exercises saves through the API. Neither establishes authenticated workspace interaction coverage. This audit is based on source and recorded evidence; no browser or runtime results were produced in this planning pass.

- **Reuse the existing workspace.** [Builder](../apps/web/src/components/Builder.tsx) already has chat, separate desktop/mobile navigation, Preview and Code, a Files tab, and desktop logs. [FileExplorer](../apps/web/src/components/FileExplorer.tsx), [MonacoEditor](../apps/web/src/components/MonacoEditor.tsx), and the [file API](../apps/api/src/files.ts) already cover tree search, file operations, editor tabs, saves, and conflict handling. Keep workspace validation, protected paths, size limits, and the `expectedMtime` contract.
- **Reuse the existing preview lifecycle.** The [API](../apps/api/src/server.ts), [Podman manager](../apps/api/src/preview.ts), and [gateway](../apps/api/src/gateway.ts) already provide staged copies, start/stop/restart/status/logs, reconciliation, and HMR through an authenticated gateway. The latest migration record places the live install at `/opt/omp-builder`; `/root/projects/omp-builder` is the frozen rollback copy.
- **Correct two assumptions in the old plan.** Project creation makes workspace and session directories but does not initialize Git. The iframe has an opaque origin, but its gateway URL is served from the Builder origin and the toolbar can open that URL outside the iframe. The [deployment checklist](DEPLOYMENT.md#production-checklist-still-open) also records missing egress restrictions. These are open release gates.

### Dyad reference and reuse policy

[Dyad’s product guidance](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/PRODUCT.md) favors clear next actions for loading, empty, and failure states and keeping technical detail available on demand. Its [app lifecycle guidance](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/docs/adr/main-owned-state-machines.md#app-run-pilot-deletion-budget) separates authoritative runtime state from UI actions and display state. Apply those ideas to the existing React, TypeScript, SQLite, OMP RPC, and rootless Podman design.

All matrix entries marked **Pattern** mean original OMP Builder code informed by a public workflow. No Dyad code was copied. Do not adopt Electron IPC, desktop process management, Dyad AI orchestration, or `src/pro/` code. If source reuse is proposed later, verify the individual file and its dependencies against Dyad’s [LICENSE](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/LICENSE) and [NOTICE](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/NOTICE). For eligible Apache-2.0 code, retain applicable copyright, license, and NOTICE attribution, mark modified files, and record the source path and revision in [Third-Party Notices](../THIRD_PARTY_NOTICES.md).

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:4951a1d9b4651d6a36b182413fee143f9110a7216b43d02514e95727c0bb0de5 -->

### Priority A — Phase 3 implementation matrix

Updated at merge 179a450. See the [post-merge audit](POST_MERGE_AUDIT.md) for test scope and release blockers. Proposed adaptations below describe target scope.

| Priority and feature | Dyad reference | Existing OMP Builder capability | Proposed adaptation | License |
| --- | --- | --- | --- | --- |
| A1 · Preview / Code / Problems | [PreviewToolbar](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/preview_panel/PreviewToolbar.tsx) and [PreviewPanel](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/preview_panel/PreviewPanel.tsx) | Partial: desktop and mobile have Problems. Files and Code remain separate. | Use Preview, Code, and Problems as primary workspace tabs at all sizes; keep Chat accessible on mobile. Move Files into Code and keep raw logs discoverable from Preview and Problems. Preserve editor state on tab switches. | Pattern |
| A2 · AI file cards and diffs | [DyadWrite](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/chat/DyadWrite.tsx) for cards; [FileDiffEditor](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/preview_panel/FileDiffEditor.tsx) and [version diff test](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/version_diff_view.spec.ts) for comparison | Missing turn-attributed file cards and before/after diffs; watcher events identify paths only. | Add collapsible cards grouped by OMP turn, with path, change kind, summary, a read-only diff, and Open in Code for files that still exist. Use bounded before/after text and verified attribution; keep ambiguous changes out of AI cards. | Pattern |
| A3 · File explorer and browser editor | [CodeView](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/preview_panel/CodeView.tsx), [FileTree](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/preview_panel/FileTree.tsx), and [FileEditor tests](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/preview_panel/FileEditor.test.tsx) | File APIs, explorer, Monaco and save conflicts verified. Combined explorer/editor layout remains partial. | Compose the existing tree and editor inside Code: resizable sidebar on wide screens, a file picker on narrow screens. Keep unsaved tabs intact when opening a diagnostic or switching panels. | Pattern |
| A4 · Diagnostics and Fix with OMP | [Problems](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/preview_panel/Problems.tsx) and [Problems tests](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/problems.spec.ts) | PR #5 merged: Problems, checked source links, bounded run snapshots and editable fixes exist. Redaction and log grouping fail specific checks; real container/provider recovery remains blocked. | Show current install/start/build diagnostics with a source location when available, an action to open the file, and a link to logs. Fix with OMP puts selected diagnostic context into a reviewable draft; normal Send uses the existing authenticated OMP prompt path. | Pattern |
| A5 · Refresh and runtime status | [App-run lifecycle test](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/app_run_remote.spec.ts), [Refresh tests](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/refresh.spec.ts), and [Restart test](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/restart.spec.ts) | Partial: iframe refresh and start/stop/restart exist; full live status and reconnect acceptance is open. | Keep one Reload preview action and separate runtime commands. Render the API’s latest state, show pending and failure states, and ignore stale events from prior runs. Preserve the route only when the gateway can verify it within the current preview; otherwise reload the entry route. | Pattern |
| A6 · Responsive workspace | [CodeView split](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/preview_panel/CodeView.tsx) and [chat panel toggle test](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/chat_panel_toggle.spec.ts) | Partial: responsive desktop/mobile views and fixed split exist; adjustable keyboard-accessible panels remain open. | Clamp split widths, fit the available viewport, make panel bodies scroll independently, and keep editor, chat composer, and preview controls reachable on short and narrow screens. Support keyboard tabs and resize handles. | Pattern |
| A7 · Per-project preferences | [Dyad chat tab storage](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/atoms/chatAtoms.ts) is a persistence reference; [view atoms](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/atoms/viewAtoms.ts) are a separate view state reference | PR #4 merged: versioned per-admin/project tabs, device and split boolean verified. Widths are fixed; resizing belongs to A6. | Store versioned UI preferences by signed-in admin ID and project ID in browser storage: workspace tab, mobile Chat/workspace choice, split state/sizes, and preview device. Validate on read and fall back to defaults for corrupt values. Define scope as this browser; keep code, drafts, session state, and credentials out of preference storage. | Pattern |

<!-- /coderabbit-ai-generated:v1 -->

### Phase 3 checkpoints

Make each checkpoint a small Git commit with its verification recorded. Reuse existing routes and contracts unless a checkpoint requires an additive change.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:8339d3d3e16c8095bbd5c42c51be6fa00faae1b5256b9cdd737288946b954532 -->

1. **A1/A3/A6/A7 — Workspace shell.** Retain the merged Problems tab and A7 preference schema when composing the explorer/editor and adding accessible resizing.
2. **A4/A5 — Diagnostics and controls.** Repair structured-field redaction and stream grouping, then validate recovery on a disposable rootless host. Keep the explicit Send boundary and run-scoped snapshots.

<!-- /coderabbit-ai-generated:v1 -->
3. **A2 — Turn review.** Correlate changes with a server owned run ID and authenticated event replay. Verify which OMP RPC signals identify actual writes before using them; a watcher event during a turn is insufficient proof. Use the file API’s path and content protections for both sides of the comparison; exclude protected, escaped, binary, and oversized contents. Cover create/edit/delete and renames when reliably identified. Bound snapshots or hunks and their retention; show an honest summary when a diff is unavailable. Keep this read-only review independent of Priority B’s Git history and Undo.
4. **A release gate — Preview isolation.** Start this work before integrating new preview entry points. Remove or disable same-origin Open in new tab until the dedicated origin is available; prevent generated documents from being served as Builder-origin pages. Use a dedicated preview origin with project-scoped, expiring access, with authorization for both HTTP and HMR and no Builder cookie or OMP endpoint on that origin. Keep the iframe sandbox, loopback upstream selection, staged read-only files, credential/header isolation, non-root execution, and enforced Podman resource limits. Deny private, host, and metadata network access; use a restricted dependency fetch path and keep runtime egress closed unless explicitly supported by policy. A capability for one preview must grant no control over the Builder or other projects. Gate release on actual browser and Podman verification of these properties.

### Verification gates

| Checkpoint | Evidence required before marking complete |
| --- | --- |
| Workspace shell | Authenticated click-through in the task’s cloud Chromium Preview at phone, tablet, and desktop sizes, including a short viewport and keyboard-only navigation. Create/open/edit/save a file, exercise a stale-write conflict, then switch views, reload, and reopen two different projects to verify independence and recoverable defaults. Run [file API](../tests/phase3-files.mjs) and [Monaco](../tests/phase3-monaco.mjs) regressions. |
| Diagnostics and controls | In rootless Podman, trigger a startup failure and a Vite compile failure with disposable fixtures. In cloud Chromium, verify the Problems count, location navigation, log fallback, fix draft selection, and no send before explicit confirmation. Submit a fix with a configured real OMP process and verify the app serves again. Check that reload keeps the same container, restart changes the invocation, stop settles, and reconnect reflects the newest run. |
| Turn review | With a real OMP run, verify added, modified, and deleted file cards and readable hunks, and replay after reload. Include a concurrent manual edit or watcher event, failed/aborted turns, and hidden/oversized files to ensure there is no false AI attribution or content disclosure. |
| Preview isolation | Use the actual Builder iframe in cloud Chromium and disposable containers. Verify isolated-origin rendering, working HMR, denied Builder HTTP/WebSocket and other project access, and no Builder credentials in preview traffic. Verify private-service egress is blocked and Podman limits and permitted dependency installs still work. Run [preview](../tests/phase3-preview.mjs), [gateway](../tests/phase3-gateway.mjs), and [real OMP + recovery](../tests/phase3-e2e.mjs) regressions; adapt the [legacy browser probe](../tests/phase3-gateway-browser-probe.mjs) to the new origin and a disposable target. |

Use the [documented deployment checks](DEPLOYMENT.md#tests), including typecheck, build, security, RPC, and dependency audit, as applicable to each change. Existing integration scripts can target a live VPS by default; inspect and explicitly configure disposable targets before running them. Record the revision, viewport/fixture, and actual outcome. A static review, an API-only result, or a mock provider does not satisfy the browser, Podman, or real OMP gates.

## Priority B — Next milestone (design backlog)

Start after the Priority A gates pass. Use Phase 3’s turn IDs, file review, and secured preview as foundations.

| Feature | Dyad reference | Existing OMP Builder capability | Proposed adaptation | License |
| --- | --- | --- | --- | --- |
| B1 · Git history, Undo, Retry | [VersionPane](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/chat/VersionPane.tsx) and [version switch test](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/switch_versions.spec.ts) | Project directories and event replay; no Builder managed Git history. | Initialize or adopt valid per-project Git, record verified OMP turn boundaries, and require explicit approval and a recoverable checkpoint before restoring or retrying. Protect dirty work and serialize mutations. | Pattern |
| B2 · Multiple chats for one codebase | [ChatTabs](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/chat/ChatTabs.tsx) and [chat tabs tests](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/chat_tabs.spec.ts) | Session manager and event replay are keyed by project. | Migrate the existing conversation to a default chat; separate chat/session/event identities while sharing one workspace and one project write coordinator. | Pattern |
| B3 · Visual element selection | [component picker tests](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/select_component.spec.ts) | Sandboxed iframe and preview size toggle; no picker. | Add opt-in, preview scoped selection and an overlay. Use a narrow message contract tied to the expected frame and run; treat all preview messages as untrusted. Do not grant DOM access across origins. | Pattern |
| B4 · Targeted edit context | [component selection and prompt tests](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/select_component.spec.ts) | Ordinary OMP prompt input only. | Show removable selection chips and validate project-relative source pointers before attaching bounded context to the existing OMP prompt. Never treat preview supplied content as trusted instructions. | Pattern |
| B5 · GitHub, ZIP, and existing workspace import | [GitHub import tests](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/github_import.spec.ts) and [import in place test](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/import_in_place.spec.ts) | New project directories and a GitHub placeholder; no import workflow. | Use a staged, validated import into managed storage. Limit archives, reject escaping entries, and select existing workspaces through an authorized server-side catalog. Never accept arbitrary host paths. | Pattern |
| B6 · Project coding rules | [import with AI rules test](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/import.spec.ts) | Provider selection and ordinary prompts; no explicit project rules UI. | Add a reviewable project rule file, bounded and scoped to the workspace; integrate through OMP’s supported instructions mechanism without overriding Builder permissions or approvals. | Pattern |
| B7 · Image upload, browsing, replacement | [media library tests](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/e2e-tests/media_library.spec.ts) and [ImageSwapPopover](https://github.com/dyad-sh/dyad/blob/56cc3964a8983296a1f49d511cb8afde1719c6f3/src/components/preview_panel/ImageSwapPopover.tsx) | Protected text APIs reject binary files; no media flow. | Add an authenticated project asset API with type and size checks, safe names, bounded previews, and explicit replacement. Reuse preview staging after validation. | Pattern |

## Phase 4 — GitHub and deployment

Build on the validated Priority B import and history contracts for remote GitHub operations. Keep explicit confirmation for destructive actions. Complete production service separation, HTTPS, backups/restore, health checks, and rollback using the [deployment checklist](DEPLOYMENT.md).


<!-- /coderabbit-ai-generated:v1 -->