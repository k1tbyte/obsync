# Performance plan

Target: Obsidian mobile, vaults of 5,000–50,000 files. Everything below is
ordered by measured impact, not by guesswork.

## Measured baseline

Method: 20,000 synthetic `.md` files (56 MB) added to a real vault, indexed by
Obsidian (20,211 files total), driven over CDP with `tools/obsidian.mjs` and
`temp/prof/driver.mjs`. Desktop, Windows, Obsidian 1.13.7, real S3 (Oracle
object storage). Mobile has no measurements here — treat mobile multipliers as
estimates, not data.

### One `refresh()` on 20,211 files

| Metric | Value |
|---|---|
| Cold refresh (empty hash cache) | 29.7 s |
| Warm refresh (hash cache full) | 7.0–8.5 s |
| Blocked main thread across 3 refreshes | 211 long tasks, 19.2 s total |
| `adapter.stat` calls | 20,224, summing to 43.7 s of await |
| `adapter.list` calls | 753, 1.06 s, walked sequentially |
| `getFiles()` + `TFile.stat` over all 20,211 | **6 ms** |
| `state.json` written per refresh | 4.05 MB pretty-printed (3.31 MB compact) |

Per-call costs, settled machine: `adapter.stat` 0.6–1.3 ms, `adapter.list`
4.6–6.2 ms, `fs.statSync` 0.007 ms. The cost is the adapter wrapper and the
per-await overhead, not the filesystem.

### Network per refresh, with one note open in the editor

| | Tab open | No tabs |
|---|---|---|
| `fetch` calls to S3 | 37–40 | 1 |
| …of which the same `objects/<hash>` | 36, 10.2 s | 0 |
| `adapter.exists("syncignore.md")` | 39–47, 4.1–4.8 s | 8 |

Chain: `sync/runtime/controller-state.ts:98` `broadcastSoon` → rAF →
`editor/signs/provider.ts:186` `loadBaselineForPath` → `sync/content.ts:42`
`storage.get(objectKey(hash))`. A refresh spans ~35 frames, so the same
immutable object is downloaded once per frame. `showEditorChangeSigns = false`
does not stop it (verified by A/B).

### UI at 20,001 changed files

- Source-control view renders 20,001 rows and **80,052 DOM nodes**; no virtualization.
- `ui/source-control/changes-tab.ts:188` `signatureOf`: 5 ms per call, up to once per frame.
- `ui/file-explorer-api.ts:28` `readFileExplorer`: 5.2–8.3 ms per call, rebuilding a
  20,976-entry Map on every rAF while the file explorer scrolls.
- `getChangedPathStatuses`: 35–42 calls per refresh.

### Bundle

| Build | Bytes | Parse time |
|---|---|---|
| Current | 617,435 | 14.92 ms |
| With `@aws-sdk/client-s3` stubbed | 351,755 | 5.18 ms |

AWS stack is 283 KB, 47% of the bundle. Removing it saves ~9.7 ms of parse on
desktop, perhaps 30–50 ms on a phone. **Bundle size alone does not justify the
work.**

The actual reason to drop the SDK is CORS. Measured inside the Obsidian
renderer (origin `app://obsidian.md`):

```
fetch("https://example.com/")       -> TypeError: Failed to fetch
fetch("https://s3.amazonaws.com/")  -> TypeError: Failed to fetch
fetch(<Oracle endpoint>)            -> ok (Oracle sends permissive CORS headers)
```

The SDK goes through `fetch`, so CORS applies. S3 backends that do not send
CORS headers cannot work until the user configures a bucket CORS policy.
Obsidian's `requestUrl` bypasses CORS and is already used in
`storage/adapters/webdav.ts:244` and `storage/adapters/share-broker.ts:194`.

### Ruled out

- File-explorer indicators do not affect refresh duration (A/B: 6.75 s vs 6.57 s).
- Crypto is not a factor: 1 ms of `digest` and 2 ms of `decrypt` per refresh.
- `getFiles()` has **no coverage gap** for synced paths. On the real vault the
  adapter walk found 639 files and `getFiles()` 211; all 428 extra paths are dot
  paths (`.obsidian/`, `.trash/`, `.git/`, `.DS_Store`, `.gitkeep`), every one of
  which `vault/scope.ts:147` already rejects via `hasDotSegment`. `getFiles()`
  does include arbitrary extensions (`.json`, `.pfx` observed), contradicting the
  common claim that the Vault API only surfaces known types.

---

## Phase 1 — Scan from the metadata cache (P0) — DONE

Measured on the same 20,211-file vault after the change:

| Metric | Before | After |
|---|---|---|
| Warm refresh | 7,000–8,500 ms | **852–1,043 ms** |
| Cold refresh | 29,726 ms | 878 ms |
| `adapter.stat` per refresh | 20,224 | **41** |
| `adapter.list` per refresh | 753 | **29** |
| Long tasks per refresh | ~70, 6.4 s | 4, 0.53 s |

The 41 remaining stat calls are the config directory. Scanning 20,000 vault
files now costs no IPC at all. Snapshot output is unchanged: 20,224 files
scanned, 41 of them config, 16 empty folders, 0 skipped, same diff.

What is left in the ~900 ms is the S3 manifest fetch and the `state.json` write,
which Phases 2 and 3 address.

### Review outcome

The swarm returned 8 confirmed findings. Fixed here:

- **Unreadable is not absent, regression.** Without the walk there is no
  unreadable-directory entry shielding the files under a locked directory, and
  the pre-existing `if (stat?.type !== "file") return` dropped them silently —
  absent from both `files` and `skipped` is exactly what the diff reads as a
  deletion. A path the index listed that will not stat now lands in
  `snapshot.skipped`. Covered by a test.
- **Non-deterministic folder order.** The empty-folder confirmation resolves out
  of order and the manifest carries those folders, so `emptyFolders` and
  `unreadable` are sorted before returning.
- `file-index.ts` uses `vault.getAllFolders(false)` rather than filtering
  `getAllLoadedFiles()`.

Accepted, with reasons:

- **Index staleness.** A file edited without changing size, whose cached mtime
  has not caught up, hits the hash cache and reports a stale hash. This is the
  price of spending no IPC on unchanged files; it self-heals on the next scan
  and is pinned by a test. Note that when Obsidian's cache is stale, Obsidian
  itself has not seen the write either.
- **`isIgnoredByPattern` misses a directory-only rule.** `ignores("drafts")` is
  false for the pattern `drafts/`, so such a folder never reaches
  `ignoredPaths`. Pre-existing: `listAllFiles` makes the identical call at
  `vault/scanner.ts:367`, and `canDescend` is the one that tries both spellings.
  Cosmetic — it only feeds the "N ignored" label, and `planVaultRestore` matches
  `ignoredPaths` against file paths where a folder entry never matched anyway.
- **A deleted empty directory is reported unreadable rather than absent.** Same
  ambiguity the walk had; impact is one spurious skipped row.
- **NFD paths from `adapter.list` on macOS are not normalized to NFC.**
  Pre-existing in `listAllFiles`, unchanged by this phase, and worth its own fix.

**Problem.** `vault/scanner.ts:65` calls `adapter.stat` once per file on every
scan, and `vault/scanner.ts:187` walks the tree with a sequential `adapter.list`
per directory. Obsidian already holds `path`, `size` and `mtime` for every
non-hidden file in memory, reachable in 6 ms.

**Design.** Split the scan by subtree, because the two halves have different
properties:

- **Vault subtree** (everything not under `configDir`): enumerate from
  `app.vault.getFiles()`. Provably complete for in-scope paths (see above).
- **Config subtree** (`.obsidian/**`): keep the existing `adapter.list` walk and
  per-file `adapter.stat`. The Vault API cannot see hidden folders, and
  `settingsSync` syncs hotkeys, plugin configs, snippets and themes from there.
  Its size is bounded by plugin count, not vault size (~80 files on the test vault).
- **Per file**: a hash-cache hit on `(mtime, size)` needs no IPC at all. Only a
  miss falls through to `adapter.stat` followed by read and hash.
- **Empty folders**: non-dot ones from `TFolder.children.length === 0` filtered by
  `scope.canDescend`; config-dir ones keep coming from the walk.

Introduce a `VaultIndex` port so `vault/scanner.ts` stays testable and the
adapter walk remains as a fallback when no index is supplied. Existing tests
drive `scanVault` with `InMemoryAdapter` and must keep passing unchanged.

**Files.** `vault/scanner.ts`, new `vault/file-index.ts`,
`core/session-factory.ts`, `sync/runtime/history-service.ts`, plus tests under
`tests/vault/`.

**Risks that must not regress.**
1. Settings and plugin config sync. `.obsidian/**` must be scanned exactly as
   today, honouring every `settingsSync` toggle and both denylists.
2. "Unreadable is not absent" (see AGENTS.md). A file or directory that cannot
   be read must land in `snapshot.skipped`, never be reported as deleted.
3. Metadata-cache staleness. `TFile.stat` can lag a very recent write. The
   existing `RACY_INDEX_WINDOW_MS` guard must still force a real `adapter.stat`
   plus re-hash inside that window.
4. Case-insensitive collision handling on Windows and macOS.
5. Empty-folder reporting must not gain or lose entries, or the manifest starts
   creating or deleting folders.

**Verification.** `pnpm test`, `pnpm typecheck`, `pnpm lint`. Then, on a real
vault via CDP, assert that the scan produces a byte-identical
`snapshot.files` map to the pre-change scanner, including `.obsidian/**` entries
and `emptyFolders`. Target: warm refresh on 20k files under 500 ms.

**Review brief for the swarm** (`pi-subagent review`):

> Review the Phase 1 diff in packages/plugin/src/vault/. Context: the scanner now
> enumerates the vault subtree from Obsidian's in-memory metadata cache instead of
> `adapter.list` + `adapter.stat`, while `.obsidian/**` keeps the old adapter walk.
> Hunt for: (1) any in-scope path the new enumeration can miss that the walk
> found, especially under `.obsidian/`; (2) any case where a settingsSync toggle
> or a denylist entry is now evaluated differently; (3) any path where an
> unreadable file or directory is reported as absent rather than skipped;
> (4) staleness: a file written moments before the scan whose cached mtime/size
> still match the hash cache, producing a stale hash; (5) empty-folder entries
> gained or lost versus the walk; (6) case-collision handling on Windows/macOS;
> (7) the fallback path when no VaultIndex is supplied.

---

## Phase 2 — Stop re-downloading the baseline (P0) — DONE

Measured on the same 20,211-file vault, with a note open in the editor (the
condition that produced the repeated downloads):

| Metric | Before | After |
|---|---|---|
| Warm refresh | 6,841 ms | **526–719 ms** |
| `fetch` per refresh | 37–40 | **1** (the manifest) |
| …downloads of the same object | 36 | **0** |
| `adapter.exists` per refresh | 39–47 | **0–7** |

Three fixes, one per layer:

1. `sync/content.ts` caches decoded remote text by hash, bounded to 4 MB of
   characters. Objects are content-addressed and the digest is verified on read,
   so within one remote the hash is a key that cannot go stale. Entries are
   namespaced per storage instance: a shared folder's manifest is written by
   someone else, and letting it name a hash and receive this vault's plaintext
   would be a way to read a file back out through the share
   (`share/sync-cycle.ts:7` reaches this code through `tryAutoMergeConflict`).
   The pull path keeps using the uncached `loadRemoteBytes`, so downloading
   20,000 files does not retain them.
2. `editor/signs/integration.ts` invalidated the baseline cache on every status
   broadcast, which is once a frame while an operation runs. It now invalidates
   only when the compare result changes, which is the only thing that can have
   moved the baseline.
3. `core/session-factory.ts` rebuilt the ignore matchers on every
   `openSession()`, costing an `exists` plus a `read` of `syncignore.md` each
   time. They are memoized against that note's mtime and size taken from the
   metadata cache, so the memo invalidates itself without an IPC call of its own.

### Review outcome

The swarm returned 8 confirmed findings. Fixed:

- **Cache accounting leaked on a race.** Two callers can miss the same hash, both
  download it and both call `rememberText`; the second charged its length again
  without crediting the entry it replaced, shrinking the 4 MB budget for good one
  race at a time.
- **`null` entries were unbounded.** A binary object caches as `null` and weighs
  nothing, so the byte budget could never evict one. Added an entry count cap.
- **Signs could hold a stale baseline.** A scan-progress `requestAnimationFrame`
  can deliver the new compare result *between* `setResult` and the `persistState`
  that advances the baseline for converged paths, after which the result-identity
  gate suppressed the corrective broadcast. The gate now also fires when an
  operation settles (`busy` true → false), which is at most one extra
  invalidation per operation and costs no network now that the text is cached.
- **The ignore memo could serve empty rules.** Memoising the *absent* case meant a
  `syncignore.md` the user had just created was ignored until Obsidian's index
  caught up - and the files those new rules exclude would sync in the meantime.
  An absent note is no longer memoised.
- **Orphaned cache entries after an adapter rebuild.** A token refresh replaces
  the storage adapter, and entries keyed to the old instance become unreachable
  weight; the rebuild now clears the cache.
- A weak test: the "genuinely deleted" case asserted against a file that was
  still on disk. It now deletes the file first.

Two findings were reported and are the intended behaviour: an unindexed baseline
path whose `stat` *throws* lands in `skipped` (unreadable is not absent - only a
`null` return means gone), and a bulk deletion costs one `stat` per deleted path,
which is the price of never publishing a deletion the index merely imagined.

Both cache fixes are pinned by tests verified to fail when the fix is removed.

### A hazard Phase 1 introduced, fixed here

Watching Obsidian mis-handle a bulk copy made it visible: its watcher dropped
events and `getFiles()` returned 9,458 of 20,211 files for several minutes. A
scan reading only the index would have reported every unindexed baseline file as
a **local deletion**, and a push would have carried those deletions out on the
remote. The old adapter walk could not do this because it read the disk.

`scanVault` now takes `expected` — the baseline's paths — and confirms any of
them the index did not list against the disk before the scan is allowed to call
it gone. In a settled vault the list is empty and the guard costs nothing; when
the index is behind it costs one `stat` per missing path, which is what the old
scanner spent on every file anyway. Three tests pin it: the index-behind case,
a genuine deletion still being reported, and a path the scope no longer includes
not being resurrected.

## Phase 2 (original notes) — Stop re-downloading the baseline (P0)

**Problem.** 36 downloads of one immutable object per refresh, plus 39–47
`adapter.exists("syncignore.md")` calls.

**Design.**
1. Cache remote object bytes by hash. Objects are content-addressed and
   immutable, so the hash is a perfect cache key. Bound the cache by total bytes,
   not entry count.
2. `editor/signs/provider.ts` must not reload the baseline on every status
   broadcast. Reload only when the baseline hash for that path actually changes.
3. `core/session-factory.ts:87` reloads `syncignore.md` on every `openSession()`.
   Cache the matcher and invalidate on a vault event for that path
   (`plugin/events.ts:89` already detects it).

**Files.** `editor/signs/provider.ts`, `sync/content.ts`,
`core/session-factory.ts`, `vault/ignore.ts`.

**Verification.** Re-run `temp/prof/44-who.js`-style instrumentation: one refresh
with a note open must produce 1 `fetch` and single-digit `exists` calls.

---

## Phase 3 — Persistence and wire volume (P1)

1. `sync/state.ts:39` writes `JSON.stringify(state, null, 2)` — 4.05 MB per
   refresh at 20k files. Drop the indent (−0.74 MB) and skip writes when the
   serialized state is unchanged; `core/state-persister.ts:119` currently
   debounces but always writes.
2. Split `baseline` and `hashCache` into separate files so a hash-cache update
   does not rewrite the baseline.
3. Compress the manifest before encrypting. Measured: 3.17 MB → 0.23 MB in 18 ms
   with gzip, a 14x reduction on every auto-pull. `utils/compress.ts` already exists.
4. `sync/manifest.ts:85` and `:95` fetch the full manifest before and after every
   push — 6.4 MB of extra traffic per push at 20k files. Use a conditional
   request or an ETag for the verify step.
5. `sync/engine.ts:326` issues `storage.exists(objectKey(hash))` per uploaded
   object; a first push of 20k files means 20,000 HEAD requests.
6. Serve the manifest with `If-None-Match` so an unchanged remote returns 304
   instead of a full download plus decrypt. Drop the cache-buster at
   `storage/adapters/s3.ts:127`, which currently defeats caching on every GET.

---

## Phase 4 — Replace the AWS SDK (P1)

Motivated by CORS, not by bundle size. Two options:

- **A**: keep the SDK, supply a custom `requestHandler` backed by `requestUrl`.
  Fixes CORS, keeps 283 KB.
- **B**: hand-rolled SigV4 over `requestUrl`. Fixes CORS, removes 265 KB, lets
  `src/polyfills.ts` go (it exists only to shim `Buffer` for the SDK; no plugin
  source uses `Buffer`), and drops the per-request middleware stack.

Recommend B. `packages/auth-worker/src/sigv4.ts` already implements SigV4 with
WebCrypto HMAC and handles both path-style and virtual-host addressing; it needs
`Authorization`-header signing, payload hashing, and a small XML reader for
`ListBucketResult` and error codes.

Required surface, from `storage/adapters/s3.ts`: HeadObject, GetObject,
PutObject (with `IfNoneMatch: "*"`), DeleteObject, ListObjectsV2 with
continuation tokens.

Also: `diff2html` is in `package.json` but imported nowhere — remove it.
`qrcode` (23 KB) is imported statically at
`ui/modals/settings-transfer-modal.ts:2` and could be dynamic or swapped for
`qrcode-generator`.

---

## Phase 5 — UI at scale (P2)

1. Virtualize the source-control change list. 80,052 DOM nodes for 20,001 rows.
2. `ui/file-explorer-api.ts:28` rebuilds a 20,976-entry Map on every rAF during
   explorer scroll. Cache it, invalidate from the existing MutationObserver.
3. `ui/source-control/changes-tab.ts:188` `signatureOf` concatenates every change
   into one string per frame. Compare cheaply, or version the diff result.

---

## Phase 6 — Redundant IPC and sequential loops (P2)

Confirmed by review, each cheap to fix:

| Site | Problem |
|---|---|
| `sync/operations/revert.ts:22` | `.find()` over the change array inside a loop: O(N²). Measured 103 ms vs 3.2 ms at 5k. |
| `sync/operations/revert.ts:21` | Sequential revert loop; use `runWithConcurrency`. |
| `sync/engine.ts:182` | Sequential remote-deletion loop. |
| `sync/operations/push.ts:155` | `batchKeepLocalOp` sequential. |
| `sync/operations/pull.ts:145` | `batchAcceptRemoteOp` sequential. |
| `vault/io.ts:34` | `ensureDir` calls `exists` per path segment on every write. Cache created directories per operation. |
| `vault/io.ts:26`, `vault/io.ts:50`, `sync/content.ts:24`, `vault/atomic-write.ts:10` | `exists()` before an operation that already tolerates absence. |
| `sync/engine.ts:191` | `adapter.stat` after every pulled file, only to read mtime. |
| `sync/runtime/file-diff-service.ts:36-38` | Three `.find()` scans over the full change array per call. |
| `sync/operations/push.ts:47` | Per-file synchronous progress broadcast; batch operations already use the coalesced `reportProgressSoon`. |

---

## Reproducing the measurements

```bash
node tools/obsidian.mjs launch          # Obsidian with CDP on 9222
node temp/prof/driver.mjs <script.js>   # run one async IIFE in the renderer
```

The profiling scripts used for this baseline live in `temp/prof/`. Re-run them
after each phase and record the new numbers in this file.
