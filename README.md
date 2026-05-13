# Obsync

Obsync is an Obsidian community plugin for manual encrypted vault sync to an S3-compatible bucket. It compares local files with an encrypted remote manifest, then lets you push local changes, pull remote changes, and resolve conflicts from a source-control style view.

## Features

- Manual compare, push, and pull commands.
- Source control view with local changes, remote changes, conflicts, per-file diff, and hunk actions for text files.
- S3-compatible storage with encrypted manifests and encrypted file blobs.
- Optional sync of selected Obsidian configuration categories.
- `.syncignore` and settings-based ignore patterns.
- Encrypted setup transfer by Obsidian URL, copyable link, or QR code.
- Local-only diagnostics stored under the plugin folder in the current vault config directory.

## Storage layout

Obsync writes only inside the configured bucket and prefix:

```text
<prefix>/manifest.json.enc
<prefix>/salt.bin
<prefix>/objects/<sha256>.enc
```

The manifest and object contents are encrypted with a key derived from your passphrase. The passphrase is not uploaded.

## Setup

1. Install the plugin files into `<Vault>/.obsidian/plugins/obsync/`.
2. Enable the plugin in Obsidian.
3. Open **Settings → Obsync**.
4. Enter the S3 endpoint, region, bucket, optional prefix, and credentials.
5. Run **Obsync: Compare with remote** and enter a passphrase when prompted.
6. Use **Push all local changes** for the first upload, or pull from an existing remote manifest.

Use a separate bucket prefix per vault. Reusing a prefix for another vault is rejected after the remote vault id is established.

## Ignore patterns

Obsync merges patterns from the vault root `.syncignore` file and the **Ignore patterns** setting. Patterns use gitignore-style syntax.

Examples:

```gitignore
README.md
drafts/
*.tmp
.obsidian/plugins/example-plugin/cache/
```

Changing `.syncignore` or the ignore settings marks the current compare result as stale and schedules a refresh when a compare has already been run.

## Commands

- **Obsync: Compare with remote** - refresh sync status and open the source control view.
- **Obsync: Push all local changes** - push all local changes after compare preflight.
- **Obsync: Pull all remote changes** - pull all remote changes after compare preflight.
- **Obsync: Open source control** - open the sync panel.
- **Obsync: Refresh sync status** - run compare only.
- **Obsync: Reset remote storage** - delete the remote Obsync manifest and file objects for the configured bucket prefix, then compare local files as new additions.
- **Obsync: Open diff for active file** - open the diff for the active file when it has changes.
- **Obsync: Forget cached passphrase** - clear the locally cached passphrase.

## Remote reset

Use **Obsync: Reset remote storage** or **Settings → Obsync → Reset remote** only when you want to rebuild the remote sync state from this vault. The reset flow requires typing `RESET` before it runs. It deletes `manifest.json.enc` and everything under `objects/` for the configured bucket prefix. It keeps `salt.bin`, so the same passphrase-derived key remains valid.

After reset, local vault files are preserved, the local baseline is cleared, and the next source control view shows local files as additions ready to push.

## Device transfer

Use **Settings → Obsync → Export** to create an encrypted setup link and QR code for another device. The transfer payload is intentionally compact: it includes the main sync settings such as endpoint, bucket, prefix, credentials, sync scope, ignore patterns, file size limit, concurrency, and auto-pull settings. It does not include the cached passphrase, passphrase cache settings, or local-only display preferences.

The transfer link is encrypted with a key derived from the current Obsync passphrase and a random transfer salt. Before encryption, the payload is minified to short keys and compressed when that actually makes the token smaller. The final URL uses the `obsidian://obsync?d=...` format. The receiving device must use the same passphrase and explicitly confirm import before the transferred settings are applied.

## Development

```bash
npm install
npm run dev
npm run build
npm run lint
```

Source code lives in `src/`. The bundled release artifact is `main.js` at the plugin root.

## Release checklist

1. Update `manifest.json` `minAppVersion` if the release needs a newer Obsidian API.
2. Run `npm version patch`, `npm version minor`, or `npm version major`.
3. Confirm `package.json`, `manifest.json`, and `versions.json` contain the new version.
4. Run `npm run build`.
5. Create a GitHub release whose tag exactly matches `manifest.json` `version` without a leading `v`.
6. Attach `manifest.json`, `main.js`, and `styles.css` as individual release assets.

## Privacy and security

Obsync has no telemetry. Sync logs are local to the current device and are excluded from sync. Vault files and filenames are sent only to the S3-compatible storage that you configure. Plugin settings are transferred between devices only when you explicitly export an encrypted setup link or QR code.
