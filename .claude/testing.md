# Testing

- vitest covers core logic (diff, hunks, concurrency, ignore, etc.). Run with `pnpm test`, or `pnpm --filter obsync test:watch` while iterating.
- ALL domain logic (diffs, merging, concurrency, hunks matching, baseline cache) must have complete unit-test coverage.
- Tests mirror `src/`: `tests/<area>/<module>.test.ts`, helpers in `tests/helpers/`.

## Driving a real Obsidian

`tools/obsidian.mjs` attaches to a running instance over CDP, so plugin UI can
be exercised without a human clicking. Obsidian must be started with the port
open (`node tools/obsidian.mjs launch`) - a normally launched instance exposes
nothing. Then `shot`, `click`, `text`, `cmd <command-id>` and `eval` drive it;
`eval` runs in the renderer, where `app` and `app.plugins.plugins.obsync` are
reachable. After copying a new build in, reload with
`app.plugins.disablePlugin('obsync')` then `enablePlugin` - `styles.css` is
re-injected only on reload.

## Manual install for testing

Copy `main.js`, `manifest.json`, `styles.css` (if any) to
`<Vault>/.obsidian/plugins/<plugin-id>/`, reload Obsidian and enable the
plugin in **Settings → Community plugins**.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behaviour unless `isDesktopOnly` is `true`.
