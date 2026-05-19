import { requestUrl } from "obsidian";

import { EStorageBackend, type WebDAVStorageConfig } from "../config";
import {
	CONCURRENCY_FIELD,
	EFieldKind,
	type SettingsFieldSpec,
} from "../field-spec";
import type { StorageAdapter } from "../types";

const PROPFIND_BODY =
	'<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_CONFLICT = 409;
const HTTP_MULTI_STATUS = 207;
const WEBDAV_RETRY_DELAYS_MS: ReadonlyArray<number> = [500, 2_000, 5_000];

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
		concurrency: 4,
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
	const basePath = normalizeBasePath(config.basePath);
	const rootUrl = baseUrl + basePath;
	const auth = `Basic ${btoa(`${config.username}:${config.password}`)}`;
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
			if (
				isSuccess(res.status) ||
				res.status === HTTP_METHOD_NOT_ALLOWED ||
				res.status === HTTP_CONFLICT
			) {
				knownDirs.add(cursor);
				continue;
			}
			throw new Error(`WebDAV MKCOL ${cursor} failed: ${res.status}`);
		}
	}

	return {
		capabilities: { canList: true, hasConditionalWrites: false },
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
			if (isSuccess(res.status)) return true;
			if (res.status === HTTP_NOT_FOUND) return false;
			throw new Error(`WebDAV HEAD ${key} failed: ${res.status}`);
		},
		async get(key) {
			const res = await davRequest({
				url: urlForKey(key),
				method: "GET",
				headers: buildHeaders(),
				throw: false,
			});
			if (res.status === HTTP_NOT_FOUND) return null;
			if (!isSuccess(res.status)) {
				throw new Error(`WebDAV GET ${key} failed: ${res.status}`);
			}
			return new Uint8Array(res.arrayBuffer);
		},
		async put(key, body, contentType) {
			await ensureParentDir(key);
			const buffer = body.buffer.slice(
				body.byteOffset,
				body.byteOffset + body.byteLength,
			) as ArrayBuffer;
			const res = await davRequest({
				url: urlForKey(key),
				method: "PUT",
				headers: buildHeaders({
					"Content-Type": contentType ?? "application/octet-stream",
				}),
				body: buffer,
				throw: false,
			});
			if (!isSuccess(res.status)) {
				throw new Error(`WebDAV PUT ${key} failed: ${res.status}`);
			}
		},
		async delete(key) {
			const res = await davRequest({
				url: urlForKey(key),
				method: "DELETE",
				headers: buildHeaders(),
				throw: false,
			});
			if (isSuccess(res.status) || res.status === HTTP_NOT_FOUND) return;
			throw new Error(`WebDAV DELETE ${key} failed: ${res.status}`);
		},
		async list(keyPrefix) {
			const dir = keyPrefix.endsWith("/") ? keyPrefix : `${keyPrefix}/`;
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
			if (res.status === HTTP_NOT_FOUND) return [];
			if (res.status !== HTTP_MULTI_STATUS) {
				throw new Error(`WebDAV PROPFIND ${keyPrefix} failed: ${res.status}`);
			}
			return parsePropfindResponse(res.text, rootUrl);
		},
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * `requestUrl` with bounded retry/backoff. All WebDAV verbs used here are
 * idempotent, so retrying a thrown network error or a 5xx is safe. Non-5xx
 * statuses are returned as-is for the caller to interpret.
 */
async function davRequest(
	params: Parameters<typeof requestUrl>[0],
): Promise<Awaited<ReturnType<typeof requestUrl>>> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= WEBDAV_RETRY_DELAYS_MS.length; attempt++) {
		try {
			const res = await requestUrl(params);
			if (res.status >= 500 && attempt < WEBDAV_RETRY_DELAYS_MS.length) {
				await delay(WEBDAV_RETRY_DELAYS_MS[attempt] as number);
				continue;
			}
			return res;
		} catch (err) {
			lastErr = err;
			if (attempt === WEBDAV_RETRY_DELAYS_MS.length) break;
			await delay(WEBDAV_RETRY_DELAYS_MS[attempt] as number);
		}
	}
	throw lastErr;
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

function normalizeBasePath(value: string): string {
	if (!value) return "";
	const trimmed = value.replace(/^\/+|\/+$/g, "");
	return trimmed ? `${trimmed}/` : "";
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

function parsePropfindResponse(xmlText: string, rootUrl: string): string[] {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xmlText, "application/xml");
	const responses = doc.getElementsByTagNameNS("DAV:", "response");
	const out: string[] = [];
	for (let i = 0; i < responses.length; i++) {
		const node = responses.item(i);
		if (!node) continue;
		const hrefEl = node.getElementsByTagNameNS("DAV:", "href").item(0);
		if (!hrefEl) continue;
		const href = (hrefEl.textContent ?? "").trim();
		if (!href) continue;
		const resourceType = node
			.getElementsByTagNameNS("DAV:", "resourcetype")
			.item(0);
		const isCollection = Boolean(
			resourceType?.getElementsByTagNameNS("DAV:", "collection").length,
		);
		if (isCollection) continue;
		const relative = relativizeHref(href, rootUrl);
		if (relative !== null) out.push(relative);
	}
	return out;
}

function relativizeHref(href: string, rootUrl: string): string | null {
	let absolute: string;
	try {
		absolute = new URL(href, rootUrl).toString();
	} catch {
		return null;
	}
	if (!absolute.startsWith(rootUrl)) return null;
	const tail = absolute.slice(rootUrl.length);
	return decodeURIComponent(tail);
}
