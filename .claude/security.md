# Security, privacy and compliance

Follow Obsidian's Developer Policies and Plugin Guidelines:

- Default to local/offline operation; make network requests only when essential to the feature, with an obvious user-facing reason and documentation.
- No hidden telemetry. Optional analytics require explicit opt-in, documented clearly in README.md and settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside normal releases.
- Minimize scope: read/write only what's necessary inside the vault; do not access files outside it.
- Do not collect vault contents, filenames, or personal information unless strictly necessary and explicitly consented; store or transmit vault contents only when essential and consented.
- Clearly disclose any external services used, data sent, and risks. Features requiring cloud services need explicit opt-in.
- No deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners with the provided `register*` helpers so the plugin unloads safely; teardown is idempotent so reload/unload leaks nothing.
