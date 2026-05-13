import { DEFAULT_CONCURRENCY, DEFAULT_MAX_FILE_BYTES } from "../constants";

export interface ObsyncSettings {
	endpoint: string;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
	syncObsidianSettings: boolean;
	maxFileBytes: number;
	concurrency: number;
}

export const DEFAULT_SETTINGS: ObsyncSettings = {
	endpoint: "",
	region: "auto",
	bucket: "",
	prefix: "",
	accessKeyId: "",
	secretAccessKey: "",
	forcePathStyle: true,
	syncObsidianSettings: true,
	maxFileBytes: DEFAULT_MAX_FILE_BYTES,
	concurrency: DEFAULT_CONCURRENCY,
};

export function isStorageConfigured(settings: ObsyncSettings): boolean {
	return Boolean(settings.bucket && settings.accessKeyId && settings.secretAccessKey);
}
