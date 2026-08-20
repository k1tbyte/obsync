# Obsync

Obsync is a plugin for my personal Obsidian vault developed to manually sync an encrypted storage repository with an S3-compatible bucket. It compares local files with an encrypted remote manifest, then lets you push local changes, pull remote changes, and resolve conflicts from a source-control style view.

## Features

- Manual compare, push, and pull commands.
- Source control view with local changes, remote changes, conflicts, per-file diff, and hunk actions for text files.
- S3-compatible storage with encrypted manifests and encrypted file blobs.
- Shared folders: sync a single folder with other people through its own encrypted storage location, with invite links, automatic merging, and conflict copies.
- Optional sync of selected Obsidian configuration categories.
- Shared `syncignore.md` rules plus device-local ignore patterns.
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

Obsync uses two ignore sources, both with gitignore-style syntax:

- `syncignore.md` in the vault root is the shared repository-level ignore list.
- The **Device-local ignore patterns** setting is applied only on the current device.

Shared ignore rules are synced like a normal note. If a shared rule starts matching a file that was already tracked, the file is shown as a deletion and is removed from remote on the next explicit push. Other devices then delete their local copy on pull.

Device-local ignore rules are non-destructive. They stop this device from sending or receiving matching files, but they do not delete existing remote data.

Examples:

```gitignore
README.md
drafts/
*.tmp
.obsidian/plugins/example-plugin/cache/
```

Changing `syncignore.md` or the ignore settings marks the current compare result as stale and schedules a refresh when a compare has already been run.

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

## Shared folders

A shared folder lets another person (or another vault) sync one folder with you without giving them access to anything else:

- Each share syncs to its own storage location (`<prefix>/shares/<share-id>/`) and is encrypted with its own random key — not your vault passphrase. Invitees can decrypt only the share.
- Invitees never receive storage credentials. They get a token that the broker exchanges for short-lived presigned URLs scoped to that share's prefix, so their access is bounded by the storage service itself and can be revoked per person.
- Shares need S3-compatible storage (S3, R2, MinIO), which the broker signs against. Your vault itself can still live on WebDAV or Google Drive — point shares at an S3 bucket regardless.
- Create a share from the folder context menu (**Obsync: Share folder…**) or **Settings → Obsync → Shared folders**. Set the broker URL and admin secret there first.
- Invites are `obsidian://obsync-share?d=…` links encrypted with an invite passphrase that you communicate separately. Each link is issued for one named person and can be revoked from **People…** without disturbing anyone else.
- Joining downloads the share into a folder you choose; the folder name does not have to match the sharer's.
- Sync is automatic: local edits under the share, a periodic re-check, and (optionally) a PartyKit relay room per share for instant propagation between participants.
- Conflicts never lose data: concurrent text edits are three-way merged; anything unmergeable keeps your version and writes the other version next to it as `name (conflict from <device> <date>).md`; a deletion never beats an edit.
- Shared folders remain part of your normal vault sync too, so your own backup still covers them. The folder is therefore stored twice: once under your vault key, once under the share key. That separation is what keeps a participant's access from ever reaching the rest of the vault.
- Removing a share means different things on each side. The owner stops sharing: every invite is revoked and the share's encrypted copy is deleted from storage (the files stay in the vault, covered by the normal vault sync). A participant just leaves: their local files stay and nobody else is affected.

### Running the broker

The broker is `packages/auth-worker`, deployed to your own Cloudflare account — the credentials it holds are yours, and no one else's traffic passes through it.

1. `wrangler kv namespace create SHARE_TOKENS`, then paste the id into `wrangler.toml`.
2. Set the secrets: `SHARE_ADMIN_SECRET`, `SHARE_S3_ENDPOINT`, `SHARE_S3_BUCKET`, `SHARE_S3_ACCESS_KEY_ID`, `SHARE_S3_SECRET_ACCESS_KEY` (`wrangler secret put <name>`).
3. Scope that S3 key to `<SHARE_S3_PREFIX>shares/*` only. The broker then cannot reach the main vault even if it is compromised:

```json
{ "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::<bucket>/shares/*" }
```

4. `pnpm --filter obsync-auth-worker run deploy`, then put the worker URL and `SHARE_ADMIN_SECRET` into **Settings → Obsync → Shared folders**.

Object bytes go straight between participants and S3; the broker only signs, so it stays well inside the Workers free tier. If the broker is offline, participants pause until it returns — you keep syncing, since your own device holds the real credentials.

## Device transfer

Use **Settings → Obsync → Export** to create an encrypted setup link and QR code for another device. The transfer payload is intentionally compact: it includes the main sync settings such as endpoint, bucket, prefix, credentials, sync scope, device-local ignore patterns, file size limit, concurrency, and auto-pull settings. It does not include the cached passphrase, passphrase cache settings, or local-only display preferences.

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
