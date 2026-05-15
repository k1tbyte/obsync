import { requestUrl, type ObsidianProtocolData } from "obsidian";
import { notifyError, notifyInfo } from "../../ui/notices";

import { EStorageBackend, type GoogleDriveStorageConfig } from "../config";
import { EFieldKind, type SettingsFieldSpec } from "../field-spec";
import type { StorageAdapter } from "../types";

export async function handleGoogleDriveProtocol(
    params: ObsidianProtocolData,
    config: GoogleDriveStorageConfig,
    saveCallback: () => Promise<void>
): Promise<void> {
    if (params.error) {
        notifyError(`Google Drive auth failed`, params.error);
        return;
    }

    const accessToken = params.access_token;
    const refreshToken = params.refresh_token;
    const expiresIn = params.expires_in;

    if (!accessToken) {
        notifyError("Google Drive auth failed - no access token received.");
        return;
    }

    config.accessToken = accessToken;
    if (refreshToken) config.refreshToken = refreshToken;
    if (expiresIn) config.expiresAt = Date.now() + parseInt(expiresIn, 10) * 1000;

    await saveCallback();
    notifyInfo("Successfully authenticated with Google Drive!");
}

export function defaultGoogleDriveConfig(): GoogleDriveStorageConfig {
    return {
        kind: EStorageBackend.GoogleDrive,
        folderName: "ObsidianSync",
        clientId: "",
        authServerUrl: "https://obsync-auth.kitbyte.workers.dev",
        accessToken: "",
        refreshToken: "",
        expiresAt: 0,
    };
}

export function isGoogleDriveConfigured(config: GoogleDriveStorageConfig): boolean {
    return Boolean(config.folderName && config.refreshToken);
}

export function describeGoogleDriveTarget(config: GoogleDriveStorageConfig): string {
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
];

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

interface GoogleDriveListResponse {
    files?: { id?: string; name?: string }[];
    nextPageToken?: string;
}

export function createGoogleDriveAdapter(config: GoogleDriveStorageConfig): StorageAdapter {
    let cachedFolderId: string | null = null;

    const getHeaders = async () => {
        // If token is expired or close to expiring (within 1 min), refresh it
        if (config.refreshToken && config.expiresAt && Date.now() > config.expiresAt - 60000) {
            const res = await requestUrl({
                url: `${config.authServerUrl}/refresh`,
                method: "POST",
                contentType: "application/json",
                body: JSON.stringify({ refresh_token: config.refreshToken }),
                throw: false,
            });
            const tokenData = res.json as { access_token?: string; expires_in?: number };
            if (res.status === 200 && tokenData.access_token) {
                config.accessToken = tokenData.access_token;
                if (tokenData.expires_in) {
                    config.expiresAt = Date.now() + tokenData.expires_in * 1000;
                }
            }
        }

        return {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
        };
    };

    const getFolderId = async (): Promise<string> => {
        if (cachedFolderId) return cachedFolderId;

        const q = `name = '${config.folderName}' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        const res = await requestUrl({
            url: `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`,
            method: "GET",
            headers: await getHeaders(),
            throw: false,
        });

        const data = res.json as GoogleDriveListResponse;
        if (res.status === 200 && data.files && data.files.length > 0) {
            cachedFolderId = data.files[0]?.id ?? null;
            if (cachedFolderId) return cachedFolderId;
        }

        // Create folder if it doesn't exist
        const createRes = await requestUrl({
            url: DRIVE_API,
            method: "POST",
            headers: await getHeaders(),
            body: JSON.stringify({
                name: config.folderName,
                mimeType: "application/vnd.google-apps.folder",
                parents: ["root"],
            }),
            throw: false,
        });

        if (createRes.status !== 200) {
            throw new Error(`Google Drive failed to create folder: ${createRes.status} - ${createRes.text}`);
        }

        const createData = createRes.json as { id?: string };
        if (!createData.id) {
            throw new Error(`Google Drive failed to create folder: missing id in response`);
        }
        cachedFolderId = createData.id;
        return cachedFolderId;
    };

    const findFileId = async (key: string): Promise<string | null> => {
        const folderId = await getFolderId();
        const q = `name = '${key}' and '${folderId}' in parents and trashed = false`;
        const res = await requestUrl({
            url: `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`,
            method: "GET",
            headers: await getHeaders(),
            throw: false,
        });
        if (res.status !== 200) return null;
        const data = res.json as GoogleDriveListResponse;
        if (!data.files || data.files.length === 0) return null;
        return data.files[0]?.id ?? null;
    };

    return {
        capabilities: {
            canList: true,
            hasConditionalWrites: false,
        },
        identity: () => googleDriveIdentity(config),

        async exists(key: string): Promise<boolean> {
            const id = await findFileId(key);
            return id !== null;
        },

        async get(key: string): Promise<Uint8Array | null> {
            const id = await findFileId(key);
            if (!id) return null;

            const res = await requestUrl({
                url: `${DRIVE_API}/${id}?alt=media`,
                method: "GET",
                headers: await getHeaders(),
                throw: false,
            });
            if (res.status === 404) return null;
            if (res.status !== 200) {
                throw new Error(`Google Drive GET failed: ${res.status}`);
            }
            return new Uint8Array(res.arrayBuffer);
        },

        async put(key: string, body: Uint8Array, contentType?: string): Promise<void> {
            const existingId = await findFileId(key);
            const folderId = await getFolderId();

            const metadata = {
                name: key,
                ...(existingId ? {} : { parents: [folderId] })
            };

            const boundary = "-------314159265358979323846";
            const delimiter = `\r\n--${boundary}\r\n`;
            const closeDelim = `\r\n--${boundary}--`;

            const metadataPart = `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`;
            const mediaPart = `Content-Type: ${contentType ?? "application/octet-stream"}\r\n\r\n`;

            // Build multipart body
            const encoder = new TextEncoder();
            const top = encoder.encode(delimiter + metadataPart + delimiter + mediaPart);
            const bottom = encoder.encode(closeDelim);
            const payload = new Uint8Array(top.length + body.length + bottom.length);
            payload.set(top, 0);
            payload.set(body, top.length);
            payload.set(bottom, top.length + body.length);

            const method = existingId ? "PATCH" : "POST";
            const url = existingId
                ? `${DRIVE_UPLOAD_API}/${existingId}?uploadType=multipart`
                : `${DRIVE_UPLOAD_API}?uploadType=multipart`;

            const res = await requestUrl({
                url,
                method,
                headers: {
                    ...(await getHeaders()),
                    "Content-Type": `multipart/related; boundary=${boundary}`,
                },
                body: payload.buffer,
                throw: false,
            });

            if (res.status !== 200) {
                throw new Error(`Google Drive PUT failed: ${res.status} ${res.text}`);
            }
        },

        async delete(key: string): Promise<void> {
            const id = await findFileId(key);
            if (!id) return;
            const res = await requestUrl({
                url: `${DRIVE_API}/${id}`,
                method: "DELETE",
                headers: await getHeaders(),
                throw: false,
            });
            if (res.status !== 204 && res.status !== 200) {
                throw new Error(`Google Drive DELETE failed: ${res.status}`);
            }
        },

        async list(prefix: string): Promise<string[]> {
            const files: string[] = [];
            let pageToken: string | undefined;
            const folderId = await getFolderId();

            // We fetch all files in the folder and filter by prefix locally
            // since Google Drive API does not support "startsWith" in queries.
            const q = `'${folderId}' in parents and trashed = false`;

            do {
                const url = new URL(DRIVE_API);
                url.searchParams.set("q", q);
                url.searchParams.set("fields", "nextPageToken, files(name)");
                if (pageToken) url.searchParams.set("pageToken", pageToken);

                const res = await requestUrl({
                    url: url.toString(),
                    method: "GET",
                    headers: await getHeaders(),
                    throw: false,
                });

                if (res.status !== 200) {
                    throw new Error(`Google Drive LIST failed: ${res.status}`);
                }

                const data = res.json as GoogleDriveListResponse;
                for (const f of data.files || []) {
                    if (f.name && f.name.startsWith(prefix)) {
                        files.push(f.name);
                    }
                }
                pageToken = data.nextPageToken;
            } while (pageToken);

            return files;
        },
    };
}
