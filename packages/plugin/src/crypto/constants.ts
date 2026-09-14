/** Crypto parameters and device-local key file names. */

export const DEVICE_KEY_FILE_NAME = "device.key";

export const PASSPHRASE_CACHE_FILE_NAME = "passphrase.enc";

export const DEVICE_KEY_BYTES = 32;

export const BLOB_VERSION = 0x01;

/**
 * Same envelope, plaintext gzipped. Written only for large JSON documents; a
 * build that predates it rejects the blob by version instead of failing inside
 * JSON.parse, so the remote says what it needs rather than looking corrupt.
 */
export const BLOB_VERSION_GZIP = 0x02;

/**
 * Below this the gzip framing costs more than it saves and the document stays
 * readable by any build. A 20k-file manifest is 3.4 MB of JSON that gzips to
 * 1.0 MB, and it is fetched on every compare and three times per push.
 */
export const JSON_GZIP_MIN_BYTES = 16 * 1024;

/**
 * Compressed length is padded to a multiple of this before encryption.
 * Compress-then-encrypt leaks through ciphertext length: someone who can both
 * put chosen strings into a document and read the stored blob learns whether a
 * guessed string already appears in it, from how well the pair compressed.
 * A 4 KB grid costs at most 4 KB on a document that is at least 16 KB of JSON,
 * and makes a probe move the length only if it shifts a whole block.
 */
export const GZIP_PAD_BYTES = 4 * 1024;

/** uint32 little-endian gzip length, ahead of the padding. */
export const GZIP_LENGTH_BYTES = 4;

export const IV_BYTES = 12;

export const KDF_ITERATIONS = 200_000;

export const KDF_SALT_LABEL = "obsync.v1.kdf";
