export const PLUGIN_ID = "obsync";

export const STATE_FILE_NAME = "state.json";
export const DEVICE_KEY_FILE_NAME = "device.key";
export const PASSPHRASE_CACHE_FILE_NAME = "passphrase.enc";

export const IGNORE_FILE_NAME = ".syncignore";

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

export const DEVICE_KEY_BYTES = 32;

export const AUTO_PULL_MIN_MINUTES = 0;
export const AUTO_PULL_MAX_MINUTES = 1440;
export const AUTO_PULL_STARTUP_DELAY_MS = 3_000;
export const AUTO_PULL_BUSY_COOLDOWN_MS = 30_000;

export const HUNK_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const TEXT_SNIFF_BYTES = 8 * 1024;

export const CONFIG_CORE_FILES: ReadonlyArray<string> = [
	"app.json",
	"appearance.json",
	"core-plugins.json",
	"community-plugins.json",
	"graph.json",
	"bookmarks.json",
	"templates.json",
];

export const CONFIG_HOTKEYS_FILE = "hotkeys.json";

export const CONFIG_SNIPPETS_DIR = "snippets/";
export const CONFIG_THEMES_DIR = "themes/";
export const CONFIG_PLUGINS_DIR = "plugins/";

export const CONFIG_FILE_DENYLIST: ReadonlyArray<string> = [
	"workspace.json",
	"workspace-mobile.json",
	"workspaces.json",
	"types.json",
	"sync.json",
];

export const CONFIG_SUBDIR_DENYLIST: ReadonlyArray<string> = [".cache/"];

export const VAULT_SUBDIR_DENYLIST: ReadonlyArray<string> = [".trash/", ".git/"];

export const DEVICE_LOCAL_PLUGIN_IDS: ReadonlyArray<string> = [
	"obsidian-git",
	"file-recovery",
];

export const SOURCE_CONTROL_VIEW_TYPE = "obsync-source-control";
export const DIFF_VIEW_TYPE = "obsync-diff";

export const STATUS_EVENT = "obsync:status-changed";

export const RESET_CONFIRMATION_TEXT = "RESET";
export const IMPORT_CONFIRMATION_TEXT = "IMPORT";
export const QR_SIZE = 320;
export const QR_ERROR_CORRECTION = "L" as const;

export const VAULT_EVENT_DEBOUNCE_MS = 1_500;

export const SCHEDULER_BACKOFF_THRESHOLD = 3;
export const SCHEDULER_BACKOFF_BASE_MS = 2 * 60_000;
export const SCHEDULER_BACKOFF_MAX_MS = 60 * 60_000;

export const BATCH_RESOLVE_CONFIRM_THRESHOLD = 5;

export const RACY_INDEX_WINDOW_MS = 2_000;

export const PERSIST_STATE_DEBOUNCE_MS = 500;
