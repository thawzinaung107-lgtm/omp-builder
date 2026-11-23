<!-- coderabbit-ai-generated:v1 -->

# Per-project workspace preferences

Build Studio remembers the desktop workspace tab, mobile navigation tab, preview device mode, and whether Preview and Logs are split. Preferences are saved in this browser for the signed-in admin and project. After refreshing, reopen the project from the dashboard to restore its layout.

The versioned record contains only those four choices and its version. Missing records, unsupported versions, unreadable storage, or invalid values use the existing defaults for the affected preferences. Browser storage is best effort and does not sync across browsers or devices. Panel widths are currently fixed in CSS; there is no adjustable width to save. Editor files, unsaved edits, chat, and credentials are outside this record.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:3743bc307c428bd3a5ec364759209083fa6430300c229fb1471daaf1cdac518b -->

## Verification

At 179a450, the [post-merge audit](POST_MERGE_AUDIT.md) independently checked desktop and mobile refresh/reopen, a second disposable project, corrupt JSON fallback and the stored field list. Admin separation was tested at the key/serializer layer, not by provisioning multiple production admins.

<!-- /coderabbit-ai-generated:v1 -->

- `node --test tests/workspace-preferences.test.mjs`: four tests cover round trips, project/admin isolation, invalid data, allowed fields, and storage failures.
- Typecheck, production build, and provider security regression passed. The file API suite passed 12 checks and the Monaco suite passed six, including stale edit handling and the production dependency audit.
- Authenticated cloud Chromium at 1440 × 900 and 390 × 780 verified refresh and reopen, defaults in a second project, per-field recovery from invalid values, and a Monaco edit saved through the real local API.
- Live Podman preview and a provider-backed OMP prompt were not exercised in this environment. The preferences change does not alter runtime commands, the gateway, or OMP RPC.
