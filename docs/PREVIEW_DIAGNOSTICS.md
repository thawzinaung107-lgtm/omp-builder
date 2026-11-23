<!-- coderabbit-ai-generated:v1 -->

# Preview diagnostics and Fix with OMP

Open **Problems** in desktop or mobile Build Studio. Start or restart the preview to check for startup and dependency errors. Problems also recognizes supported Vite compiler output while the preview is running. Expand **Details** or **View Logs** to inspect the captured output. **Open in Code** is available when the API can verify a file and source position through the project's file access rules.

**Fix with OMP** opens an editable draft and labels the diagnostic as untrusted build output. If a chat draft already exists, it stays available after canceling or sending the fix draft. Review and explicitly press **Send** to use the existing authenticated OMP RPC workflow.

Each preview run has a separate diagnostic snapshot. Restarting replaces it; stopped previews and diagnostics after a staged source update are labeled as potentially stale until the next observation. A running preview with no current reported errors is not a full build certification. Snapshots are bounded and held in API memory, so diagnostic history does not survive an API restart. Unsupported log formats can appear as plain details on startup failure without an editor link. Log redaction removes known credential and path patterns; projects should never print secrets.

## Local verification

Run `npm run build --workspace @omp-builder/api` after building the shared workspace, then `node --test tests/preview-diagnostics.test.mjs tests/workspace-preferences.test.mjs`. The existing `node tests/security-regression.mjs` suite exercises the authenticated Problems endpoint against a disposable API. With a disposable local Builder authenticated in cloud Chromium, `bash tests/a4-browser-smoke.sh` verifies desktop/mobile navigation, a compile/recovery response fixture, Monaco unsaved edits, and fix draft behavior.

A dedicated preview origin and network egress isolation are separate production gates. This work does not change them.
