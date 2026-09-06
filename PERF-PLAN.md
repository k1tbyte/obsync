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

## Phase 3 — Persistence and wire volume (P1) — DONE

Measured on the same 20,211-file vault, three consecutive settled refreshes:

| Metric | Before | After |
|---|---|---|
| Warm refresh | 694–1,207 ms | **509–597 ms** |
| `state.json` written per refresh | 3.86 MB | **0** |
| `adapter.write` / `rename` / `remove` per refresh | 1 / 4 / 2 | **0 / 0 / 0** |
| `adapter.exists` per refresh | 4–10 | **0** |
| `state.json` on disk | 4,046,944 B | **3,307,734 B** |
| Manifest on the wire, 20k files | 3.36 MB | **1.00 MB** (3.36x) |
| HEAD requests on a first push of 20k files | 20,000 | **~20** (one listing) |

### 1. The state file is written only when its bytes change

`saveState` pretty-printed the whole document on every persist, and
`StatePersister` debounced writes but never compared them. A settled refresh
rebuilds an identical hash cache and rewrote 3.86 MB for it.

`sync/state.ts` now exposes `serializeState` separately from `saveState`, and
`StatePersister` keeps the last payload it wrote and returns early when the next
one matches. The indent is gone: nothing reads this file by eye, and at 20k
files it cost 0.74 MB per write.

`lastWritten` is deliberately never seeded from `setInitial`. `loadState`
normalises what it read and can mint a device id that has to reach disk, so the
first persist of a session always writes.

### 2. The scan output is ordered by path

Prerequisite for the above, not a separate optimisation. Scan workers finish in
whatever order the adapter answers, so `snapshot.files` and `updatedCache` had a
different key order every scan and the payload comparison would never have
matched. `vault/scanner.ts` sorts both before returning; the sort costs ~20 ms
against a 3.3 MB write it removes, and makes `state.json` diffable.

### 3. Large JSON documents travel gzipped

`crypto/index.ts` compresses any JSON payload over 16 KB and marks it with a new
envelope version (`BLOB_VERSION_GZIP = 0x02`) that `decryptBytes` inflates
transparently. Covers the head manifest, history log and history pins through
one code path.

Measured in the Obsidian renderer on a real 20,224-entry manifest: 3.36 MB of
JSON → 1.00 MB, 51 ms to compress, **11 ms to inflate**, 21 ms to parse. The
earlier "3.17 MB → 0.23 MB, 14x" figure in this document was wrong: it came from
the synthetic corpus, whose 20,000 files share content and therefore share
hashes. A real vault has distinct hashes, and 64 hex characters per entry is
most of the document. 3.36x is the number to plan against.

Below 16 KB a document stays at `BLOB_VERSION`, so the keyfile and the
passphrase cache are untouched. A device whose engine has no `CompressionStream`
keeps writing version 1, which every build reads. Opaque file bytes are never
compressed — they stream through the same envelope and are as often
already-compressed media.

**Remote format change.** A build that predates this reads a compressed manifest
and fails with `Unsupported blob version: 2` rather than a parse error, but it
does fail. Every device on a vault has to be updated together. Nothing is
overwritten and no data is lost — the compare simply refuses to run.

### 4. A big push lists the bucket instead of probing each object

`uploadObject` did one `storage.exists` HEAD per object not already named by the
remote head. A first push of a 20k-file vault is 20,000 sequential-ish round
trips, which on a phone is the entire sync.

`sync/engine.ts` now counts how many objects still need settling and, above 64,
replaces the probes with a single `list(REMOTE_OBJECTS_PREFIX)` — one request
per 1,000 stored objects. A live listing outranks any manifest: it survives a
history GC that a stale baseline would not have noticed. Below the threshold, or
when a backend refuses to list, the per-object probe still runs.

### Deferred, with the measurement that justifies it

- **Splitting `baseline` from `hashCache`.** Measured on the live vault: the
  baselines are 65 KB of a 3.31 MB `state.json`; the hash cache is 98% of it. A
  split saves 2% here and ~50% only for a vault whose 20k files are all pushed.
  The real defect is that a one-entry delta rewrites the whole document, which a
  file split does not fix — that needs incremental persistence, and it is a
  bigger design change than this phase.
- **`If-None-Match` on the manifest.** Would remove the fetch entirely on an
  unchanged remote, but needs ETag plumbing through `ObjectStorage` and all four
  adapters. Compression already takes the manifest to 1.00 MB, so the remaining
  win is one round trip.
- **The double manifest fetch in `publishManifestWithGuard`.** Both reads are
  correctness: the precheck is the compare-and-swap guard, the verify catches a
  writer that raced it. Compression takes the pair from 6.72 MB to 2.00 MB.
- **The cache-buster at `storage/adapters/s3.ts:127`.** Objects are
  content-addressed and could be served cacheable, but a settled refresh now
  makes zero object GETs and a pull fetches each object exactly once, so the
  cache would never be read. Not worth a layering change for no measured effect.

### Review outcome

Four swarm reviews, one concern each. 12 findings acted on, 6 refuted and agreed
with. Every fix was mutation-checked: the fix removed, the test confirmed to
fail, the fix restored.

**Security, in the compression layer.**

- *The version byte was not authenticated.* It rides outside the ciphertext, and
  AES-GCM was called without additional data, so anyone with write access could
  relabel a stored blob `0x01` → `0x02` and have its plaintext fed to the
  inflater — a stored `.gz` attachment then expands in memory before any hash
  check runs. The version is now bound as AES-GCM additional data, but only for
  `BLOB_VERSION_GZIP`: binding it for `BLOB_VERSION` would make every blob
  already on every remote undecryptable. Relabelling in either direction now
  fails the tag.
- *Compress-then-encrypt leaks through ciphertext length.* Someone who can put
  chosen strings into a document and also read the stored blob learns whether a
  guessed string already appears in it, from how well the pair compressed. The
  compressed payload is now framed as `[uint32 length][gzip][zero padding]` and
  padded to a 4 KB grid, which costs at most 4 KB on a document that is at least
  16 KB of JSON. Exposure needs read access to the vault's own bucket *and* the
  ability to write paths into that vault: a share participant has neither
  (their own key, their own `shares/<id>` prefix, broker-presigned URLs), so the
  realistic case is an insider who holds the bucket credentials and is also in a
  share mounted in the vault. Padding raises the cost of a probe rather than
  removing the channel; the manifest's size already reveals roughly how many
  paths it holds.
- *Compression sat inside the compare-and-swap window.* `publishManifestWithGuard`
  compressed between the precheck read and the PUT, adding ~50 ms to the window
  a competing writer can slip through. The manifest is now sealed before the
  precheck.

**Correctness, in the upload listing.** The first version added every listed
hash to the known set, which trusts a listing for the whole push. History GC
runs automatically after a push (`sync/history/publish.ts:51`), so another
device deleting exactly these orphans mid-push would leave a dangling reference
— and an eventually-consistent LIST can name a deleted object outright. The
listing is now only acted on in the direction that is safe: an object it does
not name is uploaded (a stale answer costs a redundant PUT), and an object it
does name is still confirmed with a probe before the upload is skipped. A first
push of an empty bucket, the case this was built for, still costs zero probes.
The threshold moved from 64 to 256: a listing costs one request per 1,000 stored
objects, so it only loses on a bucket holding more than a quarter of a million.
Cancellation is now checked either side of the listing.

**Correctness, in the state write skip.** A write that failed part-way left the
memo naming a payload that was no longer on disk — `writeAtomic` can fail with
the old file already renamed aside — so reverting to that state would have been
skipped. The memo is cleared before the write and only restored on success; the
same applies to `reset()`.

**Ordering, at one choke point instead of seven.** Sorting the scan output alone
was not enough: pulls, conflict resolutions and incremental pushes all append
paths to a record that a later scan produces sorted, so each would have caused
exactly the redundant write this phase removes. `sortedByPath` moved to
`shared/records.ts`, and `buildSessionState` sorts every persisted hash cache in
one place — all seven callers reach it. `buildPartialFileMap` sorts the manifest
it publishes, `collectFromWalk` now sorts its folders the way the index path
already did.

Sorting the manifest turned out to pay for itself twice: sorted paths share
longer prefixes, and the same 20k-file manifest gzips to 1.00 MB sorted against
1.09 MB shuffled — **8.5% off every manifest on the wire.**

**Accepted, not fixed.**

- `lastWritten` retains a 3.3 MB string alongside the state object it mirrors.
  Measured against a 650 MB renderer heap on the 20k vault, that is 0.5%. A
  digest instead would trade an exact comparison for one whose failure mode is a
  silently skipped write.
- `Object.keys().sort()` still hoists a path that reads as an array index
  (a file named `42`). Every engine does this the same way, and the requirement
  is that two equal records serialise identically, not that the order is
  lexicographic. Documented in the helper.
- A carried-forward cache entry under an unreadable directory bypasses the
  case-collision pass. A path under an unreadable directory is never enumerated
  into `files`, so the two sets do not intersect; and this predates the phase.

---

## Phase 4 — Replace the AWS SDK (P1) — DONE

Motivated by CORS, not by bundle size. The plugin runs at origin
`app://obsidian.md`; the SDK talks over `fetch`, which is subject to CORS
there, so AWS S3 and most compatible backends refuse it until the user
hand-writes a bucket CORS policy. Obsidian's `requestUrl` is not a browser
fetch and is never asked. The other two backends already use it
(`webdav.ts:244`, `share-broker.ts:194`).

| Metric | Before | After |
|---|---|---|
| `main.js` | 623,461 B | **331,578 B** (−47%) |
| Runtime dependencies | 8 | **6** |
| Node globals shimmed into the renderer | `Buffer`, `process` | **none** |

Option B from the original plan: SigV4 signed by hand over `requestUrl`.
Three files replace the SDK.

- `storage/adapters/s3-signer.ts` builds the URL and the `Authorization`
  header. Signing keys are derived per (secret, day, region) and cached, since
  a push signs one request per object. A body is signed as `UNSIGNED-PAYLOAD`:
  hashing an upload would mean a second full pass over every blob on the thread
  that draws the UI, and TLS already protects the body in transit. A request
  with no body carries the SHA-256 of the empty string.
- `storage/adapters/s3-xml.ts` reads `ListBucketResult` and the `Code` of an
  error document. Four tags; an XML parser dependency would undo what removing
  the SDK bought, and `DOMParser` does not exist in the test runner.
- `storage/adapters/s3.ts` keeps its shape, and now goes through the same
  `withRetry` + `withTimeout` + `assertOk` policy the WebDAV adapter uses.
  Signing happens **inside** the retry: a signature carries the minute it was
  made, and a request replayed after a backoff is refused for skew.

Also removed: `src/polyfills.ts` (it existed only to shim `Buffer` for the SDK;
no plugin source uses it), the `buffer` dev dependency and the esbuild rule that
kept `buffer` bundled, and `diff2html`, which was in `package.json` and imported
nowhere.

### One thing the rewrite improves

The SDK could not tell a missing object from a missing bucket on a GET, because
it mapped both to a 404 error class. The raw response carries the error
document, so a 404 whose `Code` is `NoSuchBucket` is now re-raised instead of
reported as absence — reporting it as absence would re-upload the whole vault
into nowhere. A HEAD still cannot tell, because a HEAD has no body, and neither
could the SDK.

### Verification

Unit: the signature for AWS's own published "GET Object" SigV4 example is
reproduced exactly, which pins the implementation to an answer written down
outside this repository rather than to a second copy of the same algorithm.
Plus signed-header lists, path-style and virtual-host URLs, endpoints that sit
under a path, query canonicalisation, key escaping, and a new signing day.

Live, against the real Oracle S3-compatible endpoint the vault syncs to
(path-style, `us-east-1`): `refresh()` fetched and decrypted the real 40,263
byte manifest in 538 ms with no error; `exists` answered true and false; `get`
returned bytes and `null`; `list("objects/")` returned 290 correctly-prefixed
keys. A scratch key under `__obsync_probe__/` then exercised the write path -
`put`, byte-identical read-back, `putIfAbsent` correctly refusing the second
write with 412, `delete`, and confirmation that the key was gone from both
`exists` and `list`.

Not verified live: a listing past 1,000 keys (the bucket holds 290, so the
continuation token is covered by unit test only), and a region redirect. The SDK
followed a 307 to the correct region; this adapter surfaces it as a failed
request, since `assertOk` treats 3xx as failure rather than saving a redirect
page as object bytes.

### Deliberately unchanged

- `Cache-Control: no-cache, no-store, must-revalidate` is still stored with every
  object, as the SDK adapter did. Phase 3 measured that making immutable objects
  cacheable buys nothing (a settled refresh makes zero object GETs, and a pull
  fetches each object exactly once), so this port does not change it.
- The per-request cache-buster is gone, because it was a `ResponseCacheControl`
  query parameter the SDK needed; the same intent is now one signed
  `Cache-Control: no-cache` request header on GET, which does not change the URL
  per request.

### Review outcome

Two swarm reviews, one on the signing, one on behaviour parity with the SDK.
9 findings acted on, 6 refuted and agreed with. Each fix mutation-checked.

**Signing.**

- *A capitalised bucket broke virtual-host addressing.* The signed host was
  built from `config.bucket` verbatim, but DNS is case-insensitive and the
  transport sends a lowercased `Host`, which then does not match the signature.
  The hostname is lowercased; a path-style URI keeps the bucket exactly as typed,
  because there it is part of the path and the path is case-sensitive.
- *`region: "auto"` is the shipped default and is not an AWS region.* With no
  endpoint configured it named `s3.auto.amazonaws.com`, which resolves nowhere.
  The SDK did the same thing, so this is not a regression, but it is a dead
  configuration: it now signs for `us-east-1`, which fails with a 400 that names
  the bucket's real region. An endpoint that was configured keeps `auto`, which
  is what R2 wants.
- *`UNSIGNED-PAYLOAD` has no transport integrity behind it over plain HTTP.*
  A MinIO on the LAN reached over `http://` now hashes the body after all. The
  signer takes the body rather than a boolean so it can.
- Header values are canonicalised the way SigV4 specifies - trimmed **and**
  internal whitespace runs collapsed. Every value the adapter sends today is a
  literal, so this changes nothing now; it stops the next caller from being the
  one that finds out.

**Listing, which was the weaker half.** Under-reporting a listing is read as
"the remote does not have these", and that is the input to deciding what to
delete and what to upload. Three ways it could under-report silently:

- A body that is not a `ListBucketResult` at all - a proxy's HTML, a captive
  portal - parsed to zero keys. It now throws.
- `IsTruncated: true` with no continuation token returned a partial page as if
  it were the whole listing. It now throws.
- A backend repeating a continuation token would have looped forever. It now
  throws rather than answering with what it collected so far.

Also: keys are no longer under-read for a backend that qualifies its tags with a
namespace prefix or hangs attributes on them (S3 uses neither, but an empty
listing is the expensive way to find that out); numeric character references are
decoded; a continuation token is trimmed, and a key is not - a key may
legitimately begin or end with a space.

**Absence.** A 404 whose body is neither an S3 error document nor empty is
something between the plugin and the bucket answering. Treating it as absence
would let a proxy outage read as an empty remote, and an empty remote read as
the head republishes over the real one. Only a HEAD is allowed to be silent,
because a HEAD carries no body - as it was under the SDK. `delete` now runs the
same check instead of accepting any 404.

Re-verified live against the same Oracle endpoint after the hardening: refresh
522 ms, `get` of an absent key still `null`, `list("objects/")` still 290 keys.

**Refuted, and agreed with.** Query-parameter names needing different sort order
(all three are literals with nothing to encode), a `host` header supplied by a
caller (none is), a signer whose config mutates underneath it
(`core/session-factory.ts` rebuilds the adapter on any config change), and a key
with a leading slash (`normalizeKeyPrefix` strips them and the rest are
constants).

### Left for later

`packages/auth-worker/src/sigv4.ts` signs the same protocol a different way
(presigned query string, so a share participant can talk to S3 without
credentials). The two share the signing-key chain, the canonical request shape
and the encoders. Merging them means a fourth workspace package and a change to
how the Worker is bundled and deployed, which is a bigger blast radius than this
phase; the duplication is about 60 lines and is recorded here so it is not
forgotten.

`qrcode` (23 KB) is still imported statically at
`ui/modals/settings-transfer-modal.ts:2` and could be dynamic.

---

## Phase 5 — UI at scale (P2) — DONE

Measured on the same 20,211-file vault with 20,001 local changes, source
control pane open:

| Metric | Before | After |
|---|---|---|
| Changes pane render, flat layout | 3,190 ms | **24–28 ms** |
| Longest task during that render | 3,190 ms | **none** |
| DOM nodes in the pane | 80,028 | **140** |
| Tree layout, every folder collapsed | 81,312 nodes | **26** |
| `needsRebuild` per controller broadcast | 5.34 ms, a 2.49 MB string | **0 µs** |
| Progress broadcast (busy, no tree change) | rebuild | 0.1 ms, no rebuild |
| Explorer row map, per rAF while scrolling | 5.79 ms | **one lookup per path** |
| Scrolling the whole 510,000 px list | — | 11–17 ms per window |

### 1. One list of visible rows, windowed

Both layouts now flatten to the same thing: a `VisualRow[]` in display order,
which `ui/source-control/virtual-list.ts` windows against the pane's scroller.
Rows sit at a fixed pitch on absolute positions, so the list has its full height
from the first frame and the scrollbar never moves under the user.

The pane scrolls, not the lists, so each section computes its window from the
distance between its own top and the scroller's. The window is rebuilt on a
coalesced rAF from `scroll` and from a `ResizeObserver`; only rows that entered
or left are created or removed, about 30 to 48 at a time.

Pitch is measured from one real row with the windowed styles already applied,
not assumed - a hidden view reads every height as zero, so the first row that
reports one settles the pitch and everything placed against the fallback moves.

### 2. A collapsed folder costs one row

The tree built every descendant and left CSS to hide it, so collapsing a folder
saved nothing: 81,312 nodes for a tree with all 642 folders shut. Flattening
skips what a collapsed folder hides, which is why the same tree is now 26 nodes.

Nesting is an indent on the row rather than a nested container, so the vertical
guide line between levels is gone.

### 3. Identity instead of a description

`needsRebuild` described every change as one string to decide whether the tree
moved - 2.49 MB and 5.34 ms per broadcast at 20k, on the path that runs once a
frame during a sync. The compare result is replaced and never patched, so its
identity answers the same question in nothing.

### 4. The explorer row map is not built at all

`readFileExplorer` materialised a 20,976-entry `Map` inside the frame the
explorer is scrolling in - 5.79 ms of a 16 ms budget - to answer for the handful
of paths that actually carry a badge. It now returns a lookup instead, and the
whole path list only where the symlink scan wants it.

### Limits

- The conflicts section is never windowed: its rows grow an inline diff preview,
  so their height is not the pitch a windowed list would place them on. A vault
  with more than a few hundred conflicts still builds them all.
- Below 100 rows a list is built whole, which keeps small change sets and
  anything that varies a row's height working exactly as before.
- A row is one line high and a path too long for the pane is elided, with the
  full path on the element's `title`. The mobile rule that let a row wrap is off
  inside a windowed list, where a taller row would overlap its neighbour.

### Review outcome

Two swarm reviews, one on the windowed list, one on the two cheap comparisons.
12 findings acted on, 3 refuted. Each fix mutation-checked or verified live.

**The comparison that decides whether to rebuild.** Comparing the compare
result by identity was wrong: `compare()` returns a fresh object even when
nothing moved, so every refresh of a settled vault rebuilt the whole pane. The
fields the rows are drawn from are now walked instead - same fields the deleted
string covered, short-circuiting on the first difference. An unchanged 20k diff
costs **0.17 ms** against the 5.34 ms the string took, and the same object still
costs 0.5 µs. Also: the section counts a status-only refresh redraws were
re-derived from the unfiltered diff, so an active filter would have had its
counts overwritten with the whole list.

**Things that move a list without the scroller scrolling.** A windowed list
reads its own position to decide which rows to hold, and four things moved it
silently: collapsing a section, expanding a folder in another section, the
status line growing a Retry button, and the pane's scroll being restored after
`root.empty()` clamped it to zero. All four now re-window, synchronously -
waiting a frame would show the rows for where the pane used to be.

**Rebuilding a section threw the scroll position away.** Dropping a list drops
its height, so the browser clamped the pane's scroll to what was left before the
new list restored it: every folder toggle in tree mode jumped the user back
toward the top. The position is saved across the rebuild. Verified: 1642 px
before a toggle, 1642 px after.

**Keyboard focus was lost on scroll.** A row is `tabindex="0"`; scrolling it out
of the window removed it and dropped focus to the body. The focused row is now
kept mounted until focus moves off it. Tab order still cannot cross the window
boundary - a windowed list only offers the rows it holds, and fixing that means
an `aria-activedescendant` listbox rather than per-row buttons.

**Row height is no longer incidental.** The pitch held because the CSS happened
to equalise a folder row and a file row. Both are now pinned to the measured
height, and the measurement takes the taller of the first two rows, because a
tree interleaves the two kinds. Verified: one distinct height across a windowed
list.

**Also.** A tab switch replaced the pane without disposing the lists, which kept
listening on it and building rows into a detached container. A collapsed section
is `display: none`, where every rect reads zero and the window was computed from
nonsense; that update is now skipped.

**Refuted.** `measurePitch` on an empty list (the call site requires 100 rows),
`destroy()` leaving rows attached (both callers empty the container), and
`row-gap` reading `normal` under `display: block` - `gap: 2px` is specified on
the list, so it computes to `2px` whatever the display is, which the measured
25.5 px pitch against 23.5 px rows confirms.

**Left alone.** A file row in tree layout shows its whole path rather than its
base name. That predates this phase, the folder above it already gives the
context, and the full path is on the row's `title` either way - but the base
name is now available on the flattened row if it should change.

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
