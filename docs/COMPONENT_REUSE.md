# Component Reuse Decisions

## Reference audit

Open-Laudable is Apache-2.0 outside its separately licensed `src/pro/` tree. Its browser-compatible React code includes useful interaction patterns, but the application is Electron-first: package scripts use `electron-forge`, the layout calls `window.electron.webFrame`, and data access is routed through `ipc` contracts. Those desktop boundaries are excluded.

Observed reusable patterns:

- `src/components/AppList.tsx`: grouped app navigation, New App action, and search affordance.
- `src/components/ChatPanel.tsx`: independently scrolling conversation surface, streaming-aware scroll behavior, composer, and version-pane toggle.
- `src/components/preview_panel/PreviewPanel.tsx`: vertical split between preview and logs using resizable panels.
- `src/components/preview_panel/FileTree.tsx`: debounced search and flat-path-to-tree transformation.
- `src/components/preview_panel/FileEditor.tsx`: Monaco editor, breadcrumb, unsaved state, and explicit save affordance.

## Adaptation boundary

The new application reimplements these patterns with small web-native components. No Open-Laudable source files are copied into this repository, and no component imports from the reference repository exist. This avoids inheriting Electron IPC, local process execution, desktop path assumptions, or original AI orchestration.

Phase 1 uses an original visual system: slate surfaces, indigo accent, compact borders, screen-fit panels, and independent scroll regions. Phase 3 can introduce Monaco and a dedicated file-tree package after the backend file contract is stable.

## Attribution

Design research is attributed in `README.md` and this document. If future code copies a compatible Apache-2.0 component rather than reimplementing its behavior, preserve the applicable copyright and license notice in that package.
