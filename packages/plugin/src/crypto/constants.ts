/** Crypto parameters and device-local key file names. */

export const DEVICE_KEY_FILE_NAME = "device.key";

export const PASSPHRASE_CACHE_FILE_NAME = "passphrase.enc";

export const DEVICE_KEY_BYTES = 32;

export const BLOB_VERSION = 0x01;

export const IV_BYTES = 12;

export const KDF_ITERATIONS = 200_000;

export const KDF_SALT_LABEL = "obsync.v1.kdf";
