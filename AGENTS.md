# Obsync

An Obsidian community plugin that syncs a vault between devices over
user-configured remote storage (S3-compatible, WebDAV, Google Drive), with
shared folders brokered by a self-hosted worker. TypeScript, bundled to
`main.js` by esbuild.

pnpm workspace: `packages/plugin` (the plugin), `packages/auth-worker`
(Cloudflare worker brokering share invites), `packages/relay` (PartyKit
realtime presence).

## Commands

- `pnpm install` - dependencies
- `pnpm dev` - esbuild watch
- `pnpm build` - production bundle
- `pnpm lint` / `pnpm lint:fix` - Biome over the whole repo
- `pnpm typecheck` - `tsc -noEmit` in every package
- `pnpm test` - all vitest suites (`pnpm --filter obsync test:watch` while iterating)

## Read before touching sync code

Breaking an engine invariant silently corrupts user data or publishes remote
deletions. Read [sync invariants](.claude/sync-invariants.md) before changing
diff, hunk, baseline, history or GC code, and [shares](.claude/shares.md)
before touching shared folders - `share-key.ts` is the whole security boundary.

## Guidelines

- [Architecture](.claude/architecture.md) - layout, layering, imports, conventions
- [Sync invariants](.claude/sync-invariants.md) - data-integrity rules of the engine
- [Shares](.claude/shares.md) - shared folders, invites, broker, share key
- [Commands & settings](.claude/commands-and-settings.md) - commands, settings, transfer, UI copy
- [Testing](.claude/testing.md) - vitest, CDP driver, manual install
- [Releasing](.claude/releasing.md) - manifest, versioning, release assets
- [Security](.claude/security.md) - privacy, compliance, listener cleanup
