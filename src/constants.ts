export const PLUGIN_ID = "obsync";

export const STATE_FILE_NAME = "state.json";

export const REMOTE_MANIFEST_KEY = "manifest.json.enc";
export const REMOTE_OBJECTS_PREFIX = "objects/";
export const REMOTE_SALT_KEY = "salt.bin";
export const SALT_BYTES = 16;

export const MANIFEST_VERSION = 1;
export const BLOB_VERSION = 0x01;
export const IV_BYTES = 12;

export const KDF_ITERATIONS = 200_000;
export const KDF_SALT_LABEL = "obsync.v1.kdf";

export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_CONCURRENCY = 4;

export const CONFIG_FILE_ALLOWLIST: ReadonlyArray<string> = [
	"app.json",
	"appearance.json",
	"hotkeys.json",
	"core-plugins.json",
	"community-plugins.json",
	"graph.json",
	"bookmarks.json",
	"templates.json",
];

export const CONFIG_SUBDIR_ALLOWLIST: ReadonlyArray<string> = [
	"snippets/",
	"themes/",
	"plugins/",
];

export const CONFIG_FILE_DENYLIST: ReadonlyArray<string> = [
	"workspace.json",
	"workspace-mobile.json",
	"workspaces.json",
	"types.json",
	"sync.json",
];

export const CONFIG_SUBDIR_DENYLIST: ReadonlyArray<string> = [".cache/"];

export const VAULT_SUBDIR_DENYLIST: ReadonlyArray<string> = [".trash/", ".git/"];
