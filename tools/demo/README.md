# Demo recordings

Each script drives real Obsidian windows over CDP and writes `artifacts/demos/<name>.webp`.

```bash
pnpm exec jiti tools/demo/readonly.ts
DEMO_HOLD=1 pnpm exec jiti tools/demo/readonly.ts   # stage the scene and keep Obsidian open
```

- Needs Obsidian, `ffmpeg` and, for `drawing.ts`, network access once (fetches the Excalidraw plugin).
- Solo demos: `changes marks merge history timeline deleted`. Pair demos (two panes, relay and S3 on localhost): `share readonly live presence follow drawing`.
- `transfer.ts` films two windows one after another (no relay): the setup QR, `scan.ts` overlay, then the import prompt.
- `stage.ts` and `pair.ts` build the vaults, `recorder.ts` films and encodes, `cursor.ts` draws the pointer.
- Copy the results to `docs/demos/` for the README.
