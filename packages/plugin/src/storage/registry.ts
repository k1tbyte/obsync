import type { ObsidianProtocolData } from "obsidian";

import {
	createGoogleDriveAdapter,
	defaultGoogleDriveConfig,
	describeGoogleDriveTarget,
	GOOGLE_DRIVE_FIELDS,
	googleDriveIdentity,
	handleGoogleDriveProtocol,
	isGoogleDriveConfigured,
} from "./adapters/google-drive";
import {
	createS3Adapter,
	defaultS3Config,
	describeS3Target,
	isS3Configured,
	S3_FIELDS,
	s3Identity,
} from "./adapters/s3";
import {
	createShareBrokerAdapter,
	defaultShareBrokerConfig,
	describeShareBrokerTarget,
	isShareBrokerConfigured,
	SHARE_BROKER_FIELDS,
	shareBrokerIdentity,
} from "./adapters/share-broker";
import {
	createWebDAVAdapter,
	defaultWebDAVConfig,
	describeWebDAVTarget,
	isWebDAVConfigured,
	WEBDAV_FIELDS,
	webdavIdentity,
} from "./adapters/webdav";
import { EStorageBackend, type StorageAdapterConfig } from "./config";
import type { SettingsFieldSpec } from "./field-spec";
import type { StorageAdapter } from "./types";

export interface StorageDescriptor<
	T extends StorageAdapterConfig = StorageAdapterConfig,
> {
	label: string;
	defaults: () => T;
	create: (config: T, onConfigChanged?: () => void) => StorageAdapter;
	isConfigured: (config: T) => boolean;
	describeTarget: (config: T) => string;
	identity: (config: T) => string;
	fields: ReadonlyArray<SettingsFieldSpec>;
	/** Returns false when the callback was not this backend's to handle. */
	handleProtocol?: (
		params: ObsidianProtocolData,
		config: T,
		saveCallback: () => Promise<void>,
	) => Promise<boolean>;
}

const STORAGE_REGISTRY: {
	[K in EStorageBackend]: StorageDescriptor<
		Extract<StorageAdapterConfig, { kind: K }>
	>;
} = {
	[EStorageBackend.S3]: {
		label: "S3-compatible",
		defaults: defaultS3Config,
		create: createS3Adapter,
		isConfigured: isS3Configured,
		describeTarget: describeS3Target,
		identity: s3Identity,
		fields: S3_FIELDS,
	},
	[EStorageBackend.WebDAV]: {
		label: "WebDAV",
		defaults: defaultWebDAVConfig,
		create: createWebDAVAdapter,
		isConfigured: isWebDAVConfigured,
		describeTarget: describeWebDAVTarget,
		identity: webdavIdentity,
		fields: WEBDAV_FIELDS,
	},
	[EStorageBackend.GoogleDrive]: {
		label: "Google Drive",
		defaults: defaultGoogleDriveConfig,
		create: createGoogleDriveAdapter,
		isConfigured: isGoogleDriveConfigured,
		describeTarget: describeGoogleDriveTarget,
		identity: googleDriveIdentity,
		fields: GOOGLE_DRIVE_FIELDS,
		handleProtocol: handleGoogleDriveProtocol,
	},
	[EStorageBackend.ShareBroker]: {
		label: "Shared folder (broker)",
		defaults: defaultShareBrokerConfig,
		create: createShareBrokerAdapter,
		isConfigured: isShareBrokerConfigured,
		describeTarget: describeShareBrokerTarget,
		identity: shareBrokerIdentity,
		fields: SHARE_BROKER_FIELDS,
	},
};

/** Backends a user can pick as their own vault storage. The broker is only
 * ever reached through a share invite, never chosen directly. */
const SELECTABLE_BACKENDS = new Set<EStorageBackend>([
	EStorageBackend.S3,
	EStorageBackend.WebDAV,
	EStorageBackend.GoogleDrive,
]);

export function getDescriptor<K extends EStorageBackend>(
	kind: K,
): StorageDescriptor<Extract<StorageAdapterConfig, { kind: K }>> {
	return STORAGE_REGISTRY[kind];
}

export function listBackends(): ReadonlyArray<{
	kind: EStorageBackend;
	label: string;
}> {
	return Object.entries(STORAGE_REGISTRY)
		.filter(([kind]) => SELECTABLE_BACKENDS.has(kind as EStorageBackend))
		.map(([kind, descriptor]) => ({
			kind: kind as EStorageBackend,
			label: descriptor.label,
		}));
}

export function createStorageAdapter(
	config: StorageAdapterConfig,
	/** Called when the adapter updates the config itself, e.g. after refreshing
	 * an OAuth token, so the caller can persist it. */
	onConfigChanged?: () => void,
): StorageAdapter {
	const descriptor = STORAGE_REGISTRY[
		config.kind
	] as StorageDescriptor<StorageAdapterConfig>;
	return descriptor.create(config, onConfigChanged);
}

export function isAdapterConfigured(config: StorageAdapterConfig): boolean {
	const descriptor = STORAGE_REGISTRY[
		config.kind
	] as StorageDescriptor<StorageAdapterConfig>;
	return descriptor.isConfigured(config);
}

export function describeStorageTarget(config: StorageAdapterConfig): string {
	const descriptor = STORAGE_REGISTRY[
		config.kind
	] as StorageDescriptor<StorageAdapterConfig>;
	return descriptor.describeTarget(config);
}

export function storageIdentity(config: StorageAdapterConfig): string {
	const descriptor = STORAGE_REGISTRY[
		config.kind
	] as StorageDescriptor<StorageAdapterConfig>;
	return descriptor.identity(config);
}
/**
 * Routes an `obsidian://` callback to the backend that owns it, not to the
 * active one: configuring Google Drive while S3 is selected must still deliver
 * the OAuth result.
 */
export async function handleStorageProtocol(
	params: ObsidianProtocolData,
	getConfig: (kind: EStorageBackend) => StorageAdapterConfig | undefined,
	saveCallback: () => Promise<void>,
): Promise<void> {
	for (const [kind, entry] of Object.entries(STORAGE_REGISTRY)) {
		const descriptor = entry as StorageDescriptor<StorageAdapterConfig>;
		if (!descriptor.handleProtocol) continue;
		const config = getConfig(kind as EStorageBackend);
		if (!config) continue;
		// A descriptor that does not recognise the callback returns false, so the
		// next backend still gets a chance at it.
		if (
			(await descriptor.handleProtocol(params, config, saveCallback)) !== false
		) {
			return;
		}
	}
}
