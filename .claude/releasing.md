# Releasing

## Manifest (`manifest.json`)

- Must include (non-exhaustive): `id` (matches the plugin folder name for local dev), `name`, `version` (SemVer `x.y.z`), `minAppVersion`, `description`, `isDesktopOnly` (boolean). Optional: `author`, `authorUrl`, `fundingUrl` (string or map).
- Never change `id` after release; treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Process

- Bump `version` in `manifest.json` and update `versions.json` to map plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version` - no leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) as individual release assets. Release artifacts live at the top level of the plugin folder in the vault (`<Vault>/.obsidian/plugins/<plugin-id>/`).
- After the initial release, add/update the plugin in the community catalog as required.

## References

- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide
