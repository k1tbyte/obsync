import { type ObsyncSettings, shareStorage } from "@/settings/model";

import { registerShareStorage } from "./broker";
import { brokerShareStorage } from "./create";
import { isOwnedShare, type SharedFolderConfig } from "./types";

/**
 * Keeps the relay's copy of each owned share's storage current. A share is
 * registered again only when the relay, its secret or the storage changed, so
 * a settings save costs nothing while a rotated key still reaches participants.
 */
export class ShareBrokerRegistry {
	private readonly registered = new Map<
		string,
		{ key: string; done: Promise<void> }
	>();

	constructor(private readonly getSettings: () => ObsyncSettings) {}

	/** Registers in the background; a failure is retried on the next call. */
	sync(shares: readonly SharedFolderConfig[]): void {
		const { relayUrl, relaySecret } = this.getSettings();
		if (!relayUrl || !relaySecret) return;
		for (const share of shares) {
			if (!isOwnedShare(share) || share.paused) continue;
			this.ensure(share).catch(() => undefined);
		}
	}

	ensure(share: SharedFolderConfig): Promise<void> {
		const settings = this.getSettings();
		const storage = brokerShareStorage(share, shareStorage(settings));
		const key = JSON.stringify([
			settings.relayUrl,
			settings.relaySecret,
			storage,
		]);
		const current = this.registered.get(share.id);
		if (current?.key === key) return current.done;

		const done = registerShareStorage(settings, share.id, storage).catch(
			(err: unknown) => {
				if (this.registered.get(share.id)?.done === done) {
					this.registered.delete(share.id);
				}
				throw err;
			},
		);
		this.registered.set(share.id, { key, done });
		return done;
	}
}
