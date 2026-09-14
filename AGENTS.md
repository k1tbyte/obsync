# Obsidian community plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## Environment & tooling

- Node.js: use current LTS (Node 18+ recommended).
- **Package manager: pnpm** (workspace monorepo; `pnpm-workspace.yaml` lists the packages).
- **Bundler: esbuild** (required for this sample - `esbuild.config.mjs` and build scripts depend on it). Alternative bundlers like Rollup or webpack are acceptable for other projects if they bundle all external dependencies into `main.js`.
- Types: `obsidian` type definitions.
- Lint and format: **Biome** (`biome.json`). Tests: **vitest**.

### Install

```bash
pnpm install
```

### Dev (watch)

```bash
pnpm dev
```

### Production build

```bash
pnpm build
```

## Linting

- `pnpm lint` checks the whole repo, `pnpm lint:fix` applies what Biome can fix.
- `pnpm typecheck` runs `tsc -noEmit` in every package; `pnpm test` runs every suite.

## File & folder conventions

- **Organize code into multiple files**: Split functionality across separate modules rather than putting everything in `main.ts`.
- Source lives in `src/`. Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering commands).
- **Actual layout** (`packages/plugin/src/`):
  ```
  main.ts        # lifecycle only: onload/onunload, saveSettings, scheduleScopeRefresh
  plugin/        # composition root - host.ts, bootstrap, and one register*() per concern
  core/          # long-lived services: LogService, PassphraseManager, StatePersister, DeviceName
  sync/          # the engine: manifest, diff, operations, history, projection. No UI.
  storage/       # remote backends behind StorageAdapter, plus the registry
  share/         # shared folders: service orchestrator + status/realtime/session collaborators
  vault/         # Obsidian filesystem access, scanning, ignore rules
  settings/      # settings model, transfer, and the settings tab sections
  ui/            # views, modals, indicators, notices
  editor/        # CodeMirror gutter signs
  shared/, utils/  # app-aware helpers vs. generic algorithms
  ```
- **`PluginHost` over the plugin class** (`plugin/host.ts`): feature modules take `PluginHost`,
  never `import ObsyncPlugin from "@/main"` - that import direction is what turned `main.ts`
  into a proxy dump. A module that also registers something with Obsidian takes
  `Plugin & PluginHost`; `ObsyncPlugin` satisfies both.
- **Layering**: `sync/`, `storage/`, `share/` and `vault/` must not import from `ui/`,
  `settings/` (beyond `settings/model`) or `editor/`. An adapter that needs to tell the user
  something returns a result for the caller to surface - see `StorageAuthOutcome`.
- **Imports**: `@/` for anything outside the file's own directory, relative `./` inside it.
  Tests reach source through `@/` and their own helpers through `@tests/`.
  Cross-area *behaviour* goes through the area barrel (`@/ui`, `@/storage`); leaf type modules
  (`@/storage/types`, `@/share/types`) are imported directly so a type never drags in an adapter graph.
- **Constants live with their consumer.** A value used by one module is a module-level `const`
  there; only genuinely cross-area values belong in `src/constants.ts`.
- **Tests mirror `src/`**: `tests/<area>/<module>.test.ts`, helpers in `tests/helpers/`.
- **Do not commit build artifacts**: Never commit `node_modules/`, `main.js`, or other generated files to version control.
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.
- Generated output should be placed at the plugin root or `dist/` depending on your build setup. Release artifacts must end up at the top level of the plugin folder in the vault (`main.js`, `manifest.json`, `styles.css`).

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):  
  - `id` (plugin ID; for local dev it should match the folder name)  
  - `name`  
  - `version` (Semantic Versioning `x.y.z`)  
  - `minAppVersion`  
  - `description`  
  - `isDesktopOnly` (boolean)  
  - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Testing

- **Unit tests**: `vitest` is configured for core logic testing (`diff.ts`, `hunks.ts`, `concurrency.ts`, `ignore.ts`, etc.).
  - Run tests with `pnpm test`, or `pnpm --filter obsync test:watch` while iterating.
  - ALL domain logic (diffs, merging, concurrency, hunks matching, baseline cache) must have complete unit-test coverage.
- **Hunk source of truth**: a hunk operation must take both texts from `loadHunkSides`, the same function the projection uses, and must verify the sha256 of each side before it applies an index. A view that diffs one pair of texts while the operation recomputes from another will apply the wrong hunk.
- **Baseline advance**: the baseline may only move for paths an operation actually wrote. Adopting a whole published or remote manifest silently claims every file this device has not downloaded, and the next push publishes them as deletions.
- **History is a change log, not an archive.** `history.json.enc` holds one record per push, each the diff from that snapshot's *parent* - which is `compareResult.remote`, not `state.baseline`; the two differ whenever another device pushed since the last compare. Records carry both sides (`modified.from`/`.to`, and the departed entry on `deleted`) so a restore never needs a replay and a lost update leaves a detectable gap instead of a corrupted chain. Walk the chain only while `entry.parentId === next.id` (`contiguousLength`); past a gap the log is not evidence of anything.
- **Deleted-file listing walks deletions, never absences.** `listDeletedFiles` collects `changes[snapshot].deleted` newest first and keeps the first hit per path, so a file deleted, recreated and deleted again reports its latest death; anything back in HEAD is skipped. Pinned snapshots outside the walked chain are diffed against HEAD separately, and those rows say "last seen", not "deleted" - a pin proves the file existed, not when it went. A log that lags HEAD sets `lagging` rather than reporting an empty vault as an empty trash.
- **Hunk indices belong to one patch.** The history diff numbers its hunks from `computeHunks(version, current)`, so `restoreHistoryHunks` must compute in that same order and invert the selection (`applyHunks` takes the right side for selected hunks, so keeping one hunk on the version's side means selecting all the others). It also verifies the working copy's sha256 against the one the view drew, or a file edited since then gets a stale index applied.
- **A restore that puts the vault back is local only.** `planVaultRestore` is pure and both the confirmation and the operation run it, the operation re-planning after the user confirms. It only removes paths the scan actually read - an unreadable directory means unknown, not absent - and never touches an ignored path in either direction. Nothing reaches the remote until the user pushes.
- **GC reachability under the change log**: never delete an object reachable from HEAD, from a retained change record, or from a pinned snapshot's manifest. If any of those cannot be read, set `skippedObjectSweep` and delete no objects at all - a bounded blob leak is acceptable, a dangling reference is not. Pins keep their own full manifest under `pins/` precisely so they outlive the chain; write that manifest *before* setting the flag, or GC will believe objects are protected that nothing references.
- **Unreadable is not absent**: a file or directory the scan could not read is reported in `snapshot.skipped` and excluded from the diff. Treating it as missing turns a locked file into a remote deletion.
  - Tests live in the `tests/` directory at the root.
- **Driving a real Obsidian**: `tools/obsidian.mjs` attaches to a running instance over CDP, so plugin UI can be exercised without a human clicking. Obsidian must be started with the port open (`node tools/obsidian.mjs launch`) - a normally launched instance exposes nothing. Then `shot`, `click`, `text`, `cmd <command-id>` and `eval` drive it; `eval` runs in the renderer, where `app` and `app.plugins.plugins.obsync` are reachable. After copying a new build in, reload with `app.plugins.disablePlugin('obsync')` then `enablePlugin` - `styles.css` is re-injected only on reload.
- **Manual install for testing**: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
  ```
  <Vault>/.obsidian/plugins/<plugin-id>/
  ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.
- Current Obsync sync flow is manual via the `compare`, `push`, and `pull` commands; push/pull run a compare preflight and must surface conflicts instead of choosing a side silently.
- The `reset-remote-storage` command is destructive and must remain confirmation-gated. It deletes `manifest.json.enc`, `objects/`, `history.json.enc`, and `pins/` in the configured remote prefix (history must not outlive the objects it references), preserves local vault files, clears local `baseline`/`vaultId`, and keeps `salt.bin` and `keys.json` so the current passphrase-derived key remains valid.
- Device transfer exports only the main sync settings as a compact `obsidian://obsync?d=...` URL/QR. The payload should use short field names, omit default-valued fields, and may compress before encryption when that makes the token smaller. Never include the cached passphrase, passphrase cache settings, or local-only display preferences. Import must require the same passphrase and explicit confirmation.
- Local diagnostics are stored only on the current device in `<configDir>/plugins/obsync/logs.json` and surfaced in the second tab of the plugin settings. They must stay excluded from sync.
- Shared folders (`src/share/`) sync one vault folder to a share-specific storage prefix with a random per-share AES key (never the vault passphrase). Share manifests store share-root-relative paths (via `ScopedVaultAdapter`) so participants can mount a share at different local folders. Conflict handling must never lose data: clean three-way merge, otherwise local wins and the remote version is written as a conflict copy; delete-vs-edit resolves to the edit.
- Invite links (`obsidian://obsync-share?d=…`) are encrypted with an out-of-band passphrase and carry the share key plus a broker token — **never storage credentials**. Participants reach storage only through the owner's self-hosted broker (`packages/auth-worker`), which presigns one S3 URL per object under `shares/<id>/`. `share-key.ts` is the whole security boundary: it must fail closed, and every change to it needs traversal tests. Shares therefore require S3-compatible storage; WebDAV and Google Drive cannot presign. The share backend is its own setting (`shareStorageKind`, picked under Shared folders) and is independent of `activeStorageKind` - a vault syncing to Google Drive still shares over S3 without switching. `listShareBackends()`/`canHostShares()` in `storage/registry.ts` are the source of truth for which backends qualify. A share's stored `storage` config pins its location (endpoint, bucket, prefix) forever; only the credentials are refreshed from settings on each cycle, via `withCurrentCredentials()` - re-deriving the location would silently orphan the objects already there.
- Diff views must never load file content that cannot be shown as text: classify sides from `adapter.stat()`, manifest entry sizes, and `KNOWN_BINARY_EXTENSIONS` before reading or downloading anything (see `src/sync/projection.ts`). Keep this invariant when touching diff/merge code paths.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`. Do not use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the release as individual assets.
- After the initial release, follow the process to add/update your plugin in the community catalog as required.

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party services, require explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided `register*` helpers so the plugin unloads safely.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.
- Vault scanning uses `ScopePolicy.canDescend()` to prune denied, ignored, and disabled config directories before listing descendants. Keep this pruning path in sync with `ScopePolicy.includes()` when changing sync scope rules.
- Symlink skipping lives in `vault/symlinks.ts` and plugs into `ScopePolicy` via the optional `symlinks` option, so the scanner, the diff filter and shared folders all honour it from one place. It is the only part of the plugin that touches Node (`require("node:fs")`, lazily, so mobile just gets a no-op detector).

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**
- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**
- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.

## Common tasks

### Organize code across multiple files

**main.ts** (minimal, lifecycle only):
```ts
import { Plugin } from "obsidian";
import { MySettings, DEFAULT_SETTINGS } from "./settings";
import { registerCommands } from "./commands";

export default class MyPlugin extends Plugin {
  settings: MySettings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    registerCommands(this);
  }
}
```

**settings.ts**:
```ts
export interface MySettings {
  enabled: boolean;
  apiKey: string;
}

export const DEFAULT_SETTINGS: MySettings = {
  enabled: true,
  apiKey: "",
};
```

**commands/index.ts**:
```ts
import { Plugin } from "obsidian";
import { doSomething } from "./my-command";

export function registerCommands(plugin: Plugin) {
  plugin.addCommand({
    id: "do-something",
    name: "Do something",
    callback: () => doSomething(plugin),
  });
}
```

### Add a command

```ts
this.addCommand({
  id: "your-command-id",
  name: "Do the thing",
  callback: () => this.doTheThing(),
});
```

### Persist settings

```ts
interface MySettings { enabled: boolean }
const DEFAULT_SETTINGS: MySettings = { enabled: true };

async onload() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  await this.saveData(this.settings);
}
```

### Register listeners safely

```ts
this.registerEvent(this.app.workspace.on("file-open", f => { /* ... */ }));
this.registerDomEvent(window, "resize", () => { /* ... */ });
this.registerInterval(window.setInterval(() => { /* ... */ }, 1000));
```

## Troubleshooting

- Plugin doesn't load after build: ensure `main.js` and `manifest.json` are at the top level of the plugin folder under `<Vault>/.obsidian/plugins/<plugin-id>/`. 
- Build issues: if `main.js` is missing, run `pnpm build` or `pnpm dev` to compile your TypeScript source code.
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique.
- Settings not persisting: ensure `loadData`/`saveData` are awaited and you re-render the UI after changes.
- Mobile-only issues: confirm you're not using desktop-only APIs; check `isDesktopOnly` and adjust.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide
