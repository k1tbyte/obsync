export const PLUGIN_ID = "obsync";

export const STATE_FILE_NAME = "state.json";
export const DEVICE_KEY_FILE_NAME = "device.key";
export const PASSPHRASE_CACHE_FILE_NAME = "passphrase.enc";

export const IGNORE_FILE_NAME = "syncignore.md";

export const REMOTE_MANIFEST_KEY = "manifest.json.enc";
export const REMOTE_OBJECTS_PREFIX = "objects/";
export const REMOTE_SNAPSHOTS_PREFIX = "snapshots/";
export const REMOTE_SNAPSHOT_INDEX_KEY = "snapshots/index.json.enc";
export const SNAPSHOT_INDEX_VERSION = 1;
export const REMOTE_SALT_KEY = "salt.bin";
export const REMOTE_KEYFILE_KEY = "keys.json";
export const KEYFILE_VERSION = 1;
export const DATA_KEY_BYTES = 32;
export const SALT_BYTES = 16;

export const MANIFEST_VERSION = 1;
export const BLOB_VERSION = 0x01;
export const IV_BYTES = 12;

export const KDF_ITERATIONS = 200_000;
export const KDF_SALT_LABEL = "obsync.v1.kdf";

export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_CONCURRENCY = 4;

export const DEFAULT_FILE_HISTORY_MAX_SNAPSHOTS = 50;
export const FILE_HISTORY_MIN_SNAPSHOTS = 1;
export const FILE_HISTORY_MAX_SNAPSHOTS = 1000;
/** GC fires only when retained snapshots exceed max by this fraction... */
export const FILE_HISTORY_GC_EXCESS_RATIO = 0.3;
/** ...or by this absolute count, whichever is larger. Bounds GC frequency. */
export const FILE_HISTORY_GC_MIN_EXCESS = 10;

export const DEVICE_KEY_BYTES = 32;

export const AUTO_PULL_MIN_MINUTES = 0;
export const AUTO_PULL_MAX_MINUTES = 1440;
export const AUTO_PULL_STARTUP_DELAY_MS = 3_000;
export const AUTO_PULL_BUSY_COOLDOWN_MS = 30_000;

export const HUNK_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const TEXT_SNIFF_BYTES = 8 * 1024;
/** Hard ceiling for an on-demand ("show anyway") diff of a size-capped file. */
export const FORCE_DIFF_MAX_BYTES = 16 * 1024 * 1024;
/** Total text bytes the in-memory diff model cache may retain. */
export const DIFF_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Extensions that are always binary. Used to classify a diff side without
 * reading its content — opening a diff for e.g. a large video must not load
 * the file (locally or from remote) at all.
 */
export const KNOWN_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
	// Images
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"webp",
	"avif",
	"heic",
	"heif",
	"ico",
	"icns",
	"tif",
	"tiff",
	"psd",
	"raw",
	// Audio
	"mp3",
	"wav",
	"m4a",
	"ogg",
	"oga",
	"flac",
	"aac",
	"wma",
	"aiff",
	"opus",
	// Video
	"mp4",
	"m4v",
	"mov",
	"avi",
	"mkv",
	"webm",
	"wmv",
	"flv",
	"mpg",
	"mpeg",
	"3gp",
	// Documents
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"odt",
	"ods",
	"odp",
	"pages",
	"numbers",
	// Archives
	"zip",
	"rar",
	"7z",
	"gz",
	"bz2",
	"xz",
	"zst",
	"tar",
	"tgz",
	"jar",
	// Fonts
	"ttf",
	"otf",
	"woff",
	"woff2",
	"eot",
	// Executables / bundles
	"exe",
	"dll",
	"so",
	"dylib",
	"bin",
	"apk",
	"ipa",
	"dmg",
	"iso",
	// Data
	"db",
	"sqlite",
	"sqlite3",
	"pickle",
	"parquet",
]);

/** community-plugins.json is deliberately absent: it has its own toggle, and
 * listing it here would let "core settings" sync it behind that toggle. */
export const CONFIG_CORE_FILES: ReadonlyArray<string> = [
	"app.json",
	"appearance.json",
	"core-plugins.json",
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

export const VAULT_SUBDIR_DENYLIST: ReadonlyArray<string> = [
	".trash/",
	".git/",
];

export const DEVICE_LOCAL_PLUGIN_IDS: ReadonlyArray<string> = [
	"obsidian-git",
	"file-recovery",
];

export const SOURCE_CONTROL_VIEW_TYPE = "obsync-source-control";
export const DIFF_VIEW_TYPE = "obsync-diff";

export const STATUS_EVENT = "obsync:status-changed";

/** Fallback Google Drive auth broker when the user has not self-hosted one. */
export const DEFAULT_GDRIVE_AUTH_SERVER =
	"https://obsync-auth.kitbyte.workers.dev";

export const RESET_CONFIRMATION_TEXT = "RESET";
export const IMPORT_CONFIRMATION_TEXT = "IMPORT";
export const QR_SIZE = 320;
export const QR_ERROR_CORRECTION = "L" as const;

export const VAULT_EVENT_DEBOUNCE_MS = 1_500;
export const REALTIME_SYNC_DEBOUNCE_MS = 2_000;

/** How often shared folders re-check their remote when nothing else triggers. */
export const SHARE_SYNC_INTERVAL_MS = 5 * 60_000;
/** Debounce for share syncs triggered by local edits or realtime signals. */
export const SHARE_EVENT_DEBOUNCE_MS = 2_500;
export const SHARE_STARTUP_DELAY_MS = 5_000;
/** Retries when another participant pushes between our compare and publish. */
export const SHARE_PUSH_RETRIES = 3;
export const SHARE_KEY_BYTES = 32;

export const SCHEDULER_BACKOFF_THRESHOLD = 3;
export const SCHEDULER_BACKOFF_BASE_MS = 2 * 60_000;
export const SCHEDULER_BACKOFF_MAX_MS = 60 * 60_000;

/** Max paths attached to a single log entry, so one big sync cannot flood the log. */
export const LOG_PATH_LIMIT = 50;
/** Shares log more often (every cycle), so they attach fewer paths. */
/** Guard against an endless "(conflict from X) N" chain on one file. */
export const CONFLICT_COPY_LIMIT = 100;

export const SHARE_LOG_PATH_LIMIT = 25;

export const BATCH_RESOLVE_CONFIRM_THRESHOLD = 5;

export const RACY_INDEX_WINDOW_MS = 2_000;

export const PERSIST_STATE_DEBOUNCE_MS = 500;
