export enum EStorageBackend {
	S3 = "s3",
	WebDAV = "webdav",
	GoogleDrive = "google-drive",
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
}

export interface WebDAVStorageConfig {
	kind: EStorageBackend.WebDAV;
	baseUrl: string;
	basePath: string;
	username: string;
	password: string;
}

export interface GoogleDriveStorageConfig {
	kind: EStorageBackend.GoogleDrive;
	folderName: string;
	clientId: string;
	authServerUrl: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

export type StorageAdapterConfig =
	| S3StorageConfig
	| WebDAVStorageConfig
	| GoogleDriveStorageConfig;
