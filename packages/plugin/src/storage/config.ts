export enum EStorageBackend {
	S3 = "s3",
	WebDAV = "webdav",
	GoogleDrive = "google-drive",
	ShareBroker = "share-broker",
}

export interface S3StorageConfig {
	kind: EStorageBackend.S3;
	endpoint: string;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
	concurrency: number;
}

export interface WebDAVStorageConfig {
	kind: EStorageBackend.WebDAV;
	baseUrl: string;
	basePath: string;
	username: string;
	password: string;
	concurrency: number;
}

export interface GoogleDriveStorageConfig {
	kind: EStorageBackend.GoogleDrive;
	folderName: string;
	clientId: string;
	authServerUrl: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	concurrency: number;
}

/**
 * A shared folder seen from a participant's device. Carries no storage
 * credentials: every object access is signed on demand by the owner's broker,
 * scoped to this share's prefix.
 */
export interface ShareBrokerStorageConfig {
	kind: EStorageBackend.ShareBroker;
	brokerUrl: string;
	shareToken: string;
	concurrency: number;
}

export type StorageAdapterConfig =
	| S3StorageConfig
	| WebDAVStorageConfig
	| GoogleDriveStorageConfig
	| ShareBrokerStorageConfig;
