import { requestUrl } from "obsidian";

import { DEFAULT_CONCURRENCY } from "../../constants";
import { normalizeKeyPrefix } from "../../shared/path";
import { EStorageBackend, type WebDAVStorageConfig } from "../config";
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
	toArrayBuffer,
	withRetry,
	withTimeout,
} from "./util";

const PROPFIND_BODY =
	'<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const _HTTP_CONFLICT = 409;
const HTTP_MULTI_STATUS = 207;
const HTTP_PRECONDITION_FAILED = 412;

export const WEBDAV_FIELDS: ReadonlyArray<SettingsFieldSpec> = [
	{
		kind: EFieldKind.Text,
		key: "baseUrl",
		name: "Base URL",
		desc: "WebDAV server root, e.g. https://example.com/remote.php/dav/files/user/",
		placeholder: "https://example.com/remote.php/dav/files/user/",
	},
	{
		kind: EFieldKind.Text,
		key: "basePath",
		name: "Path",
		desc: "Subfolder inside the WebDAV root. Created on first push.",
		placeholder: "obsync/",
	},
	{ kind: EFieldKind.Text, key: "username", name: "Username" },
	{ kind: EFieldKind.Password, key: "password", name: "Password" },
	CONCURRENCY_FIELD,
];

export function defaultWebDAVConfig(): WebDAVStorageConfig {
	return {
		kind: EStorageBackend.WebDAV,
		baseUrl: "",
		basePath: "obsync/",
		username: "",
		password: "",
		concurrency: DEFAULT_CONCURRENCY,
	};
}

export function isWebDAVConfigured(config: WebDAVStorageConfig): boolean {
	return Boolean(config.baseUrl && config.username && config.password);
}

export function webdavIdentity(config: WebDAVStorageConfig): string {
	return `webdav|${config.baseUrl}|${config.basePath}|${config.username}`;
}

export function describeWebDAVTarget(config: WebDAVStorageConfig): string {
	const url = config.baseUrl || "(not configured)";
	const path = config.basePath || "(server root)";
	return `WebDAV: ${url} / path: ${path}`;
}

export function createWebDAVAdapter(
	config: WebDAVStorageConfig,
): StorageAdapter {
	assertConfig(config);
	const baseUrl = ensureTrailingSlash(config.baseUrl);
	const basePath = normalizeKeyPrefix(config.basePath);
	// The path is part of a URL, so it has to be encoded like every other
	// segment: a folder with a space would otherwise produce an invalid request.
	const rootUrl = baseUrl + encodeKey(basePath);
	const auth = `Basic ${basicCredentials(config.username, config.password)}`;
	const knownDirs = new Set<string>();
	knownDirs.add("");

	const buildHeaders = (
		extra: Record<string, string> = {},
	): Record<string, string> => ({
		Authorization: auth,
		...extra,
	});

	const urlForKey = (key: string): string => rootUrl + encodeKey(key);

	async function ensureParentDir(key: string): Promise<void> {
		const fullPath = basePath + key;
		const idx = fullPath.lastIndexOf("/");
		if (idx < 0) return;
		const dir = fullPath.slice(0, idx + 1);
		if (knownDirs.has(dir)) return;
		const parts = dir.split("/").filter(Boolean);
		let cursor = "";
		for (const part of parts) {
			cursor = `${cursor}${part}/`;
			if (knownDirs.has(cursor)) continue;
			const url = baseUrl + encodeKey(cursor);
			const res = await davRequest({
				url,
				method: "MKCOL",
				headers: buildHeaders(),
				throw: false,
			});
			// 405 means the collection is already there. 409 means the parent is
			// missing, and this loop creates parents first, so accepting it would
			// cache a directory that does not exist and fail every later PUT.
			if (isSuccess(res.status) || res.status === HTTP_METHOD_NOT_ALLOWED) {
				knownDirs.add(cursor);
				continue;
			}
			throw new StorageHttpError(
				res.status,
				`WebDAV MKCOL "${cursor}" failed (HTTP ${res.status})`,
			);
		}
	}

	return {
		identity() {
			return webdavIdentity(config);
		},
		async exists(key) {
			const res = await davRequest({
				url: urlForKey(key),
				method: "HEAD",
				headers: buildHeaders(),
				throw: false,
			});
			if (res.status === HTTP_NOT_FOUND) return false;
			assertOk(res, "check", key);
			return true;
		},
		async get(key) {
			const res = await davRequest({
				url: urlForKey(key),
				method: "GET",
				headers: buildHeaders(),
				throw: false,
			});
			if (res.status === HTTP_NOT_FOUND) return null;
			assertOk(res, "read", key);
			return new Uint8Array(res.arrayBuffer);
		},
		async put(key, body, contentType) {
			const res = await sendPut(key, body, contentType);
			assertOk(res, "write", key);
		},
		async putIfAbsent(key, body, contentType) {
			const res = await sendPut(key, body, contentType, {
				"If-None-Match": "*",
			});
			if (res.status === HTTP_PRECONDITION_FAILED) return false;
			assertOk(res, "write", key);
			return true;
		},
		async delete(key) {
			const res = await davRequest({
				url: urlForKey(key),
				method: "DELETE",
				headers: buildHeaders(),
				throw: false,
			});
			if (res.status === HTTP_NOT_FOUND) return;
			assertOk(res, "delete", key);
		},
		async list(keyPrefix) {
			// Depth 1 only reports direct children, so the walk has to recurse:
			// objects/ sits one level below the root and would be invisible.
			const seen = new Set<string>();
			const keys: string[] = [];
			const queue = [keyPrefix ? ensureTrailingSlash(keyPrefix) : ""];
			while (queue.length > 0) {
				const dir = queue.shift() as string;
				if (seen.has(dir)) continue;
				seen.add(dir);
				const res = await davRequest({
					url: rootUrl + encodeKey(dir),
					method: "PROPFIND",
					headers: buildHeaders({
						Depth: "1",
						"Content-Type": "application/xml; charset=utf-8",
					}),
					body: PROPFIND_BODY,
					throw: false,
				});
				if (res.status === HTTP_NOT_FOUND) continue;
				if (res.status !== HTTP_MULTI_STATUS) {
					throw new StorageHttpError(
						res.status,
						`WebDAV PROPFIND "${dir}" failed (HTTP ${res.status})`,
					);
				}
				const listed = parsePropfindResponse(res.text, rootUrl);
				keys.push(...listed.files);
				for (const child of listed.collections) {
					if (child !== dir) queue.push(child);
				}
			}
			return keys;
		},
	};

	async function sendPut(
		key: string,
		body: Uint8Array,
		contentType: string | undefined,
		extraHeaders: Record<string, string> = {},
	): ReturnType<typeof davRequest> {
		await ensureParentDir(key);
		return davRequest({
			url: urlForKey(key),
			method: "PUT",
			headers: buildHeaders({
				"Content-Type": contentType ?? "application/octet-stream",
				...extraHeaders,
			}),
			body: toArrayBuffer(body),
			throw: false,
		});
	}
}

/**
 * `requestUrl` under the shared timeout and retry policy. Every WebDAV verb
 * used here is idempotent, so retrying a transport failure or a "try later"
 * status is safe; any other status is returned for the caller to interpret.
 */
async function davRequest(
	params: Parameters<typeof requestUrl>[0],
): Promise<Awaited<ReturnType<typeof requestUrl>>> {
	return withRetry(async () => {
		const res = await withTimeout(requestUrl(params), STORAGE_TIMEOUT_MS);
		if (isRetryableStatus(res.status)) {
			throw new StorageHttpError(
				res.status,
				`WebDAV request failed (HTTP ${res.status})`,
			);
		}
		return res;
	});
}

/** Basic auth is Latin-1 by definition, so a non-ASCII password has to be
 * UTF-8 encoded before base64 or `btoa` throws. */
function basicCredentials(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function assertConfig(config: WebDAVStorageConfig): void {
	if (!config.baseUrl) throw new Error("WebDAV base URL is not configured");
	if (!config.username || !config.password) {
		throw new Error("WebDAV credentials are not configured");
	}
}

function ensureTrailingSlash(value: string): string {
	if (!value) return value;
	return value.endsWith("/") ? value : `${value}/`;
}

function encodeKey(key: string): string {
	return key
		.split("/")
		.map((segment) => (segment === "" ? "" : encodeURIComponent(segment)))
		.join("/");
}

function isSuccess(status: number): boolean {
	return status >= HTTP_OK_MIN && status <= HTTP_OK_MAX;
}

interface PropfindListing {
	files: string[];
	collections: string[];
}

function parsePropfindResponse(
	xmlText: string,
	rootUrl: string,
): PropfindListing {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xmlText, "application/xml");
	const responses = doc.getElementsByTagNameNS("DAV:", "response");
	const listing: PropfindListing = { files: [], collections: [] };
	for (let i = 0; i < responses.length; i++) {
		const node = responses.item(i);
		if (!node) continue;
		const hrefEl = node.getElementsByTagNameNS("DAV:", "href").item(0);
		if (!hrefEl) continue;
		const href = (hrefEl.textContent ?? "").trim();
		if (!href) continue;
		const relative = relativizeHref(href, rootUrl);
		if (relative === null) continue;
		const resourceType = node
			.getElementsByTagNameNS("DAV:", "resourcetype")
			.item(0);
		const isCollection = Boolean(
			resourceType?.getElementsByTagNameNS("DAV:", "collection").length,
		);
		if (isCollection) {
			if (relative) listing.collections.push(ensureTrailingSlash(relative));
		} else {
			listing.files.push(relative);
		}
	}
	return listing;
}

/**
 * Href to a key relative to the configured root. Compared as parsed URLs, not
 * as strings: `https://host:443/` and `https://host/` are the same origin, and
 * a textual prefix test drops every entry when the two spellings differ.
 */
function relativizeHref(href: string, rootUrl: string): string | null {
	let absolute: URL;
	let root: URL;
	try {
		absolute = new URL(href, rootUrl);
		root = new URL(rootUrl);
	} catch {
		return null;
	}
	if (absolute.origin !== root.origin) return null;
	if (!absolute.pathname.startsWith(root.pathname)) return null;
	return decodeURIComponent(absolute.pathname.slice(root.pathname.length));
}
