import { type ObsidianProtocolData, requestUrl } from "obsidian";

import { DEFAULT_GDRIVE_AUTH_SERVER } from "../../constants";
import { notifyError, notifyInfo } from "../../ui/notices";
import { toArrayBuffer } from "../../utils/bytes";
import { EStorageBackend, type GoogleDriveStorageConfig } from "../config";
import {
	CONCURRENCY_FIELD,
	EFieldKind,
	type SettingsFieldSpec,
} from "../field-spec";
import type { StorageAdapter } from "../types";
import {
	assertOk,
	isRetryableStatus,
	STORAGE_TIMEOUT_MS,
	StorageHttpError,
	withRetry,
	withTimeout,
} from "./util";

export async function handleGoogleDriveProtocol(
	params: ObsidianProtocolData,
	config: GoogleDriveStorageConfig,
	saveCallback: () => Promise<void>,
): Promise<boolean> {
	if (params.error) {
		notifyError(`Google Drive auth failed`, params.error);
		return true;
	}

	const accessToken = params.access_token;
	const refreshToken = params.refresh_token;
	const expiresIn = params.expires_in;

	// No token at all: this callback was meant for some other backend.
	if (!accessToken && !refreshToken) return false;
	if (!accessToken) {
		notifyError("Google Drive auth failed - no access token received.");
		return true;
	}

	config.accessToken = accessToken;
	if (refreshToken) config.refreshToken = refreshToken;
	const seconds = Number(expiresIn);
	config.expiresAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : 0;

	await saveCallback();
	// Without a refresh token the backend still reads as unconfigured, so
	// reporting success would leave the user waiting for a sync that cannot run.
	if (!config.refreshToken) {
		notifyError(
			"Google Drive returned no refresh token. Remove Obsync from your Google account permissions and connect again.",
		);
		return true;
	}
	notifyInfo("Connected to Google Drive.");
	return true;
}

export function defaultGoogleDriveConfig(): GoogleDriveStorageConfig {
	return {
		kind: EStorageBackend.GoogleDrive,
		folderName: "ObsidianSync",
		clientId: "",
		authServerUrl: DEFAULT_GDRIVE_AUTH_SERVER,
		accessToken: "",
		refreshToken: "",
		expiresAt: 0,
		concurrency: 8,
	};
}

export function isGoogleDriveConfigured(
	config: GoogleDriveStorageConfig,
): boolean {
	return Boolean(config.folderName && config.refreshToken);
}

export function describeGoogleDriveTarget(
	config: GoogleDriveStorageConfig,
): string {
	return `Google Drive (${config.folderName})`;
}

export function googleDriveIdentity(config: GoogleDriveStorageConfig): string {
	return `gdrive|${config.folderName}`;
}

export const GOOGLE_DRIVE_FIELDS: ReadonlyArray<SettingsFieldSpec> = [
	{
		key: "folderName",
		name: "Folder Name",
		desc: "The name of the folder in your Google Drive root where data will be stored.",
		kind: EFieldKind.Text,
		placeholder: "ObsidianSync",
	},
	{
		key: "clientId",
		name: "Client ID",
		desc: "Leave empty to use the default Obsync client, or provide your own.",
		kind: EFieldKind.Text,
		placeholder: "...",
	},
	{
		key: "authServerUrl",
		name: "Auth Server URL",
		desc: "The Cloudflare Worker proxy that securely exchanges auth codes.",
		kind: EFieldKind.Text,
		placeholder: "https://obsync-auth...workers.dev",
	},
	CONCURRENCY_FIELD,
];

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
/** Google rejects a multipart upload above this; larger files go resumable. */
const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;
const DRIVE_PAGE_SIZE = "1000";
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const NOT_FOUND = 404;

interface GoogleDriveListResponse {
	files?: { id?: string; name?: string }[];
	nextPageToken?: string;
}

/**
 * Escapes a value for interpolation into a Google Drive `q` string literal.
 * Drive query syntax wraps literals in single quotes; an unescaped quote or
 * backslash in (e.g.) a folder name would break the query or alter its meaning.
 */
function escapeDriveQueryValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Google Drive is a best-effort backend for a content-addressed store: it has
 * no conditional write and no atomic create-by-name, so two devices writing the
 * same new key at the same moment can produce duplicate files. Everything else
 * here follows the shared contract — an error is never reported as absence.
 */
export function createGoogleDriveAdapter(
	config: GoogleDriveStorageConfig,
	onTokenRefreshed?: () => void,
): StorageAdapter {
	let cachedFolderId: string | null = null;
	let folderLookup: Promise<string> | null = null;
	let tokenRefresh: Promise<void> | null = null;
	// name -> file id. Only positive entries are cached: a negative one would
	// keep reporting a file another device uploaded during this session as
	// missing, and the pull would fail on a "missing object".
	const fileIdCache = new Map<string, string>();

	const refreshAccessToken = async (): Promise<void> => {
		const res = await driveRequest({
			url: `${config.authServerUrl}/refresh`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ refresh_token: config.refreshToken }),
			throw: false,
		});
		if (res.status !== 200) {
			throw new StorageHttpError(
				res.status,
				`Google Drive token refresh failed (HTTP ${res.status})`,
			);
		}
		const tokenData = res.json as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!tokenData.access_token) {
			throw new Error("Google Drive token refresh returned no access token");
		}
		config.accessToken = tokenData.access_token;
		// Google rotates refresh tokens on some accounts; dropping the new one
		// leaves the next refresh holding a revoked credential.
		if (tokenData.refresh_token) config.refreshToken = tokenData.refresh_token;
		const expiresIn = Number(tokenData.expires_in);
		config.expiresAt = Number.isFinite(expiresIn)
			? Date.now() + expiresIn * 1000
			: 0;
		onTokenRefreshed?.();
	};

	// Every worker shares one refresh: eight parallel uploads must not fire
	// eight refreshes and race each other's tokens.
	const refreshOnce = async (): Promise<void> => {
		tokenRefresh ??= refreshAccessToken().finally(() => {
			tokenRefresh = null;
		});
		await tokenRefresh;
	};

	const getHeaders = async (): Promise<Record<string, string>> => {
		if (needsRefresh(config)) await refreshOnce();
		return {
			Authorization: `Bearer ${config.accessToken}`,
			"Content-Type": "application/json",
		};
	};

	/**
	 * A token can die mid-run: Drive answers 401, which is not a retryable
	 * status, so without this one long sync would fail on an expired token it
	 * could simply have replaced.
	 */
	const authorized = async (
		build: (
			headers: Record<string, string>,
		) => Parameters<typeof requestUrl>[0],
	): Promise<DriveResponse> => {
		const first = await driveRequest(build(await getHeaders()));
		if (first.status !== 401) return first;
		await refreshOnce();
		return driveRequest(build(await getHeaders()));
	};

	const findFolder = async (): Promise<string | null> => {
		const q = `name = '${escapeDriveQueryValue(config.folderName)}' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
		const res = await authorized((headers) => ({
			url: `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`,
			method: "GET",
			headers,
			throw: false,
		}));
		// A failed search must not fall through to "create": that is how a 5xx
		// ends up making a second sync folder.
		assertOk(res, "find folder", config.folderName);
		const data = res.json as GoogleDriveListResponse;
		return data.files?.[0]?.id ?? null;
	};

	const getFolderId = async (): Promise<string> => {
		if (cachedFolderId) return cachedFolderId;
		folderLookup ??= (async () => {
			const existing = await findFolder();
			if (existing) {
				cachedFolderId = existing;
				return existing;
			}
			const createRes = await authorized((headers) => ({
				url: DRIVE_API,
				method: "POST",
				headers,
				body: JSON.stringify({
					name: config.folderName,
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root"],
				}),
				throw: false,
			}));
			assertOk(createRes, "create folder", config.folderName);
			const created = (createRes.json as { id?: string }).id;
			if (!created) {
				throw new Error("Google Drive create folder returned no id");
			}
			cachedFolderId = created;
			return created;
		})().finally(() => {
			folderLookup = null;
		});
		return folderLookup;
	};

	const findFileId = async (key: string): Promise<string | null> => {
		const cached = fileIdCache.get(key);
		if (cached) return cached;
		const folderId = await getFolderId();
		const q = `name = '${escapeDriveQueryValue(key)}' and '${escapeDriveQueryValue(folderId)}' in parents and trashed = false`;
		const res = await authorized((headers) => ({
			url: `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`,
			method: "GET",
			headers,
			throw: false,
		}));
		assertOk(res, "look up", key);
		const data = res.json as GoogleDriveListResponse;
		const id = data.files?.[0]?.id ?? null;
		if (id) fileIdCache.set(key, id);
		return id;
	};

	const upload = async (
		key: string,
		body: Uint8Array,
		contentType: string | undefined,
		existingId: string | null,
	): Promise<void> => {
		const context = { folderId: await getFolderId() };
		const send =
			body.length > MULTIPART_MAX_BYTES ? resumableUpload : multipartUpload;
		const id = await send(
			key,
			body,
			contentType,
			existingId,
			getHeaders,
			context,
		);
		if (id) fileIdCache.set(key, id);
	};

	return {
		identity: () => googleDriveIdentity(config),

		async exists(key: string): Promise<boolean> {
			return (await findFileId(key)) !== null;
		},

		async get(key: string): Promise<Uint8Array | null> {
			const id = await findFileId(key);
			if (!id) return null;
			const res = await authorized((headers) => ({
				url: `${DRIVE_API}/${id}?alt=media`,
				method: "GET",
				headers,
				throw: false,
			}));
			if (res.status === NOT_FOUND) {
				fileIdCache.delete(key);
				return null;
			}
			assertOk(res, "download", key);
			return new Uint8Array(res.arrayBuffer);
		},

		async put(key, body, contentType) {
			await upload(key, body, contentType, await findFileId(key));
		},

		async putIfAbsent(key, body, contentType) {
			// Drive has no conditional create. Probing first closes the ordinary
			// race; a genuine tie leaves two files with one name, which findFileId
			// then resolves arbitrarily — documented, not solved.
			if (await findFileId(key)) return false;
			await upload(key, body, contentType, null);
			return true;
		},

		async delete(key: string): Promise<void> {
			const id = await findFileId(key);
			if (!id) return;
			const res = await authorized((headers) => ({
				url: `${DRIVE_API}/${id}`,
				method: "DELETE",
				headers,
				throw: false,
			}));
			fileIdCache.delete(key);
			// Already gone is the outcome the caller asked for.
			if (res.status === NOT_FOUND) return;
			assertOk(res, "delete", key);
		},

		async list(prefix: string): Promise<string[]> {
			const files: string[] = [];
			let pageToken: string | undefined;
			const folderId = await getFolderId();

			// Drive queries cannot express "starts with", so the folder is listed
			// whole and filtered here.
			const q = `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`;

			do {
				const url = new URL(DRIVE_API);
				url.searchParams.set("q", q);
				url.searchParams.set("pageSize", DRIVE_PAGE_SIZE);
				url.searchParams.set("fields", "nextPageToken, files(id,name)");
				if (pageToken) url.searchParams.set("pageToken", pageToken);

				const res = await authorized((headers) => ({
					url: url.toString(),
					method: "GET",
					headers,
					throw: false,
				}));
				assertOk(res, "list", prefix);

				const data = res.json as GoogleDriveListResponse;
				for (const f of data.files ?? []) {
					if (!f.name) continue;
					// Prime the id cache so later exists()/put() avoid a lookup.
					if (f.id) fileIdCache.set(f.name, f.id);
					if (f.name.startsWith(prefix)) files.push(f.name);
				}
				pageToken = data.nextPageToken;
			} while (pageToken);

			return files;
		},
	};
}

function needsRefresh(config: GoogleDriveStorageConfig): boolean {
	if (!config.refreshToken) return false;
	if (!config.accessToken) return true;
	// A config restored without an expiry (or one that just elapsed) must refresh
	// rather than send a token that is probably already dead.
	return (
		!config.expiresAt || Date.now() > config.expiresAt - TOKEN_REFRESH_MARGIN_MS
	);
}

type DriveResponse = Awaited<ReturnType<typeof requestUrl>>;
type DriveHeaders = () => Promise<Record<string, string>>;

/** `requestUrl` under the shared timeout and retry policy. */
async function driveRequest(
	params: Parameters<typeof requestUrl>[0],
): Promise<DriveResponse> {
	return withRetry(async () => {
		const res = await withTimeout(requestUrl(params), STORAGE_TIMEOUT_MS);
		if (isRetryableStatus(res.status)) {
			throw new StorageHttpError(
				res.status,
				`Google Drive request failed (HTTP ${res.status})`,
			);
		}
		return res;
	});
}

const MULTIPART_BOUNDARY = "-------314159265358979323846";

async function multipartUpload(
	key: string,
	body: Uint8Array,
	contentType: string | undefined,
	existingId: string | null,
	getHeaders: DriveHeaders,
	context: { folderId: string },
): Promise<string | null> {
	const metadata = {
		name: key,
		...(existingId ? {} : { parents: [context.folderId] }),
	};
	const delimiter = `\r\n--${MULTIPART_BOUNDARY}\r\n`;
	const closeDelim = `\r\n--${MULTIPART_BOUNDARY}--`;
	const metadataPart = `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`;
	const mediaPart = `Content-Type: ${contentType ?? "application/octet-stream"}\r\n\r\n`;

	const encoder = new TextEncoder();
	const top = encoder.encode(delimiter + metadataPart + delimiter + mediaPart);
	const bottom = encoder.encode(closeDelim);
	const payload = new Uint8Array(top.length + body.length + bottom.length);
	payload.set(top, 0);
	payload.set(body, top.length);
	payload.set(bottom, top.length + body.length);

	const res = await driveRequest({
		url: existingId
			? `${DRIVE_UPLOAD_API}/${existingId}?uploadType=multipart`
			: `${DRIVE_UPLOAD_API}?uploadType=multipart`,
		method: existingId ? "PATCH" : "POST",
		headers: {
			...(await getHeaders()),
			"Content-Type": `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
		},
		body: toArrayBuffer(payload),
		throw: false,
	});
	assertOk(res, "upload", key);
	return existingId ?? (res.json as { id?: string } | null)?.id ?? null;
}

/** Multipart is capped at 5 MB, so anything larger is sent as a resumable
 * session in chunks. */
async function resumableUpload(
	key: string,
	body: Uint8Array,
	contentType: string | undefined,
	existingId: string | null,
	getHeaders: DriveHeaders,
	context: { folderId: string },
): Promise<string | null> {
	const start = await driveRequest({
		url: existingId
			? `${DRIVE_UPLOAD_API}/${existingId}?uploadType=resumable`
			: `${DRIVE_UPLOAD_API}?uploadType=resumable`,
		method: existingId ? "PATCH" : "POST",
		headers: {
			...(await getHeaders()),
			"X-Upload-Content-Type": contentType ?? "application/octet-stream",
		},
		body: JSON.stringify({
			name: key,
			...(existingId ? {} : { parents: [context.folderId] }),
		}),
		throw: false,
	});
	assertOk(start, "start upload of", key);
	const session = start.headers.location ?? start.headers.Location;
	if (!session) {
		throw new Error(`Google Drive did not open an upload session for "${key}"`);
	}

	let offset = 0;
	while (offset < body.length) {
		const end = Math.min(offset + RESUMABLE_CHUNK_BYTES, body.length);
		const chunk = body.subarray(offset, end);
		const res = await driveRequest({
			url: session,
			method: "PUT",
			headers: {
				"Content-Range": `bytes ${offset}-${end - 1}/${body.length}`,
			},
			body: toArrayBuffer(chunk),
			throw: false,
		});
		// 308 means "chunk stored, send the next one".
		if (res.status === 308) {
			offset = end;
			continue;
		}
		assertOk(res, "upload", key);
		return existingId ?? (res.json as { id?: string } | null)?.id ?? null;
	}
	return existingId;
}
