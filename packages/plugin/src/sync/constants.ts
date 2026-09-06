/** Remote object layout and engine-wide limits. */

export const REMOTE_MANIFEST_KEY = "manifest.json.enc";

export const REMOTE_OBJECTS_PREFIX = "objects/";

export const REMOTE_SNAPSHOTS_PREFIX = "snapshots/";

export const REMOTE_SNAPSHOT_INDEX_KEY = "snapshots/index.json.enc";

export const REMOTE_SALT_KEY = "salt.bin";

export const REMOTE_KEYFILE_KEY = "keys.json";

export const MANIFEST_VERSION = 1;

/** Max paths attached to a single log entry, so one big sync cannot flood the log. */
export const LOG_PATH_LIMIT = 50;

export const HUNK_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** Hard ceiling for an on-demand ("show anyway") diff of a size-capped file. */
export const FORCE_DIFF_MAX_BYTES = 16 * 1024 * 1024;
