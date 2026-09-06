export {
	DEFAULT_GDRIVE_AUTH_SERVER,
	defaultGoogleDriveConfig,
} from "./adapters/google-drive";
export { defaultS3Config } from "./adapters/s3";
export { defaultWebDAVConfig } from "./adapters/webdav";
export {
	EStorageBackend,
	type GoogleDriveStorageConfig,
	type S3StorageConfig,
	type StorageAdapterConfig,
	type WebDAVStorageConfig,
} from "./config";
export {
	type BaseFieldSpec,
	CONCURRENCY_FIELD,
	EFieldKind,
	type NumberFieldSpec,
	type PasswordFieldSpec,
	type SettingsFieldSpec,
	type TextFieldSpec,
	type ToggleFieldSpec,
} from "./field-spec";
export {
	canHostShares,
	createStorageAdapter,
	describeStorageTarget,
	getDescriptor,
	handleStorageProtocol,
	isAdapterConfigured,
	listBackends,
	listShareBackends,
	type StorageDescriptor,
	storageIdentity,
} from "./registry";
export type {
	ObjectStorage,
	StorageAdapter,
	StorageAuthOutcome,
} from "./types";
