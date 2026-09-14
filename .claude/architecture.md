# Architecture

## Layout (`packages/plugin/src/`)

- `main.ts` - lifecycle only: onload/onunload, saveSettings, scheduleScopeRefresh
- `plugin/` - composition root: host.ts, bootstrap, one register*() per concern
- `core/` - long-lived services: LogService, PassphraseManager, StatePersister, DeviceName
- `sync/` - the engine: manifest, diff, operations, history, projection. No UI.
- `storage/` - remote backends behind StorageAdapter, plus the registry
- `share/` - shared folders: service orchestrator + status/realtime/session collaborators
- `vault/` - Obsidian filesystem access, scanning, ignore rules
- `settings/` - settings model, transfer, and the settings tab sections
- `ui/` - views, modals, indicators, notices
- `editor/` - CodeMirror gutter signs
- `shared/`, `utils/` - app-aware helpers vs. generic algorithms

## PluginHost over the plugin class

Feature modules take `PluginHost` (`plugin/host.ts`), never
`import ObsyncPlugin from "@/main"` - that import direction is what turned
`main.ts` into a proxy dump. A module that also registers something with
Obsidian takes `Plugin & PluginHost`; `ObsyncPlugin` satisfies both.

## Layering

`sync/`, `storage/`, `share/` and `vault/` must not import from `ui/`,
`settings/` (beyond `settings/model`) or `editor/`. An adapter that needs to
tell the user something returns a result for the caller to surface - see
`StorageAuthOutcome`.

## Imports

- `@/` for anything outside the file's own directory, relative `./` inside it.
- Tests reach source through `@/` and their own helpers through `@tests/`.
- Cross-area behaviour goes through the area barrel (`@/ui`, `@/storage`); leaf
  type modules (`@/storage/types`, `@/share/types`) are imported directly so a
  type never drags in an adapter graph.

## Conventions

- TypeScript strict; Node.js current LTS; obsidian type definitions.
- esbuild (`esbuild.config.mjs`) bundles everything into `main.js` - no
  unbundled runtime deps, no Node/Electron APIs (mobile compatibility;
  `isDesktopOnly` is set accordingly). Mind mobile memory limits.
- Keep the bundled plugin small; prefer browser-compatible packages.
- Split files that exceed ~200-300 lines; one well-defined responsibility per
  module; prefer `async/await` over promise chains; handle errors gracefully.
- Constants live with their consumer: a value used by one module is a
  module-level `const` there; only genuinely cross-area values belong in
  `src/constants.ts`.
- Never commit generated files (`node_modules/`, `main.js`).

## Scope rules

- Vault scanning prunes denied, ignored and disabled config directories via
  `ScopePolicy.canDescend()` before listing descendants. Keep that pruning
  path in sync with `ScopePolicy.includes()` when changing sync scope rules.
- Symlink skipping lives in `vault/symlinks.ts` and plugs into `ScopePolicy`
  through the optional `symlinks` option, so the scanner, the diff filter and
  shared folders all honour it from one place. It is the only part of the
  plugin that touches Node (`require("node:fs")`, lazily - mobile gets a
  no-op detector).

## Performance

- Keep startup light: defer heavy work, lazy-initialise, nothing long-running
  in `onload`.
- Batch disk access, avoid excessive vault scans, debounce/throttle expensive
  reactions to file system events.
