import type { PluginHost } from "@/plugin/host";
import { activeStorage } from "@/settings/model";
import { errorMessage } from "@/shared/errors";
import {
	createStorageAdapter,
	describeStorageTarget,
	isAdapterConfigured,
} from "@/storage";
import { REMOTE_MANIFEST_KEY } from "@/sync/constants";

export interface ConnectionTestResult {
	ok: boolean;
	message: string;
}

/**
 * Reaches the remote without a passphrase, so credentials can be checked before
 * anything is encrypted. Reads only the manifest key: an absent one is a healthy
 * empty remote, and anything else is a real connection problem.
 */
export async function testConnection(
	plugin: PluginHost,
): Promise<ConnectionTestResult> {
	const config = activeStorage(plugin.settings);
	if (!isAdapterConfigured(config)) {
		return { ok: false, message: "This backend is not fully configured yet." };
	}
	const target = describeStorageTarget(config);
	try {
		const adapter = createStorageAdapter(config);
		const found = await adapter.exists(REMOTE_MANIFEST_KEY);
		return {
			ok: true,
			message: found
				? `Connected to ${target}. A vault is already published there.`
				: `Connected to ${target}. No vault published yet - your first push will create one.`,
		};
	} catch (err) {
		return {
			ok: false,
			message: `Could not reach ${target}: ${errorMessage(err)}`,
		};
	}
}
