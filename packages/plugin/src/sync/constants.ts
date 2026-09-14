/** Remote object layout and engine-wide limits. */

export const REMOTE_MANIFEST_KEY = "manifest.json.enc";

export const REMOTE_OBJECTS_PREFIX = "objects/";

/** Single change log: snapshot metadata plus one parent-relative delta per snapshot. */
export const REMOTE_HISTORY_LOG_KEY = "history.json.enc";

/** Full manifests for pinned snapshots, so a pin survives its chain being evicted. */
export const REMOTE_PINS_PREFIX = "pins/";

export const REMOTE_SALT_KEY = "salt.bin";

export const REMOTE_KEYFILE_KEY = "keys.json";

export const MANIFEST_VERSION = 2;

/** Max paths attached to a single log entry, so one big sync cannot flood the log. */
export const LOG_PATH_LIMIT = 50;

export const HUNK_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** Hard ceiling for an on-demand ("show anyway") diff of a size-capped file. */
export const FORCE_DIFF_MAX_BYTES = 16 * 1024 * 1024;
