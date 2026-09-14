# Commands, settings and UI copy

## Commands

- Add user-facing commands via `this.addCommand(...)` with stable IDs; never rename once released.
- Sync flow is manual: `compare`, `push`, `pull`. Push/pull run a compare preflight and must surface conflicts instead of choosing a side silently.
- The `reset-remote-storage` command is destructive and must remain confirmation-gated. It deletes `manifest.json.enc`, `objects/`, `history.json.enc`, and `pins/` in the configured remote prefix (history must not outlive the objects it references), preserves local vault files, clears local `baseline`/`vaultId`, and keeps `salt.bin` and `keys.json` so the current passphrase-derived key remains valid.

## Settings

- Provide a settings tab with sensible defaults and validation; persist via `this.loadData()` / `this.saveData()`.
- Device transfer exports only the main sync settings as a compact `obsidian://obsync?d=...` URL/QR. The payload uses short field names, omits default-valued fields, and may compress before encryption when that makes the token smaller. Never include the cached passphrase, passphrase cache settings, or local-only display preferences. Import requires the same passphrase and explicit confirmation.
- Local diagnostics are stored only on the current device in `<configDir>/plugins/obsync/logs.json` and surfaced in the second tab of the plugin settings. They must stay excluded from sync.
- Configuration categories (core settings, hotkeys, plugin list, plugins, snippets, themes) are per device and default to off. A disabled category is invisible to that device: nothing is scanned, diffed, pulled or published for it, and the remote keeps whatever other devices synced. Turning a category off never deletes anything anywhere. Obsync's own plugin folder is never synced.
- **Clear on remote** beside a category is the only way to remove a category from the remote. It bumps that category's reset generation so every device forgets its baseline for it instead of reading the removal as deletions; local files stay everywhere, and enabled devices re-upload on their next push. Confirmation-gated.

## UI copy

- Sentence case for headings, buttons, and titles.
- Clear, action-oriented imperatives in step-by-step copy; keep in-app strings short, consistent, free of jargon.
- **Bold** for literal UI labels; prefer "select" for interactions.
- Arrow notation for navigation: **Settings → Community plugins**.
