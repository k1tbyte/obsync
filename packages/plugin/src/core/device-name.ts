import type { App } from "obsidian";

import { defaultDeviceName } from "@/sync/device";
import { loadState } from "@/sync/state";

import type { StatePersister } from "./state-persister";

/** The device name lives in local state only - it is never synced. */
export class DeviceName {
	constructor(
		private readonly app: App,
		private readonly state: StatePersister,
		private readonly onRenamed: () => void,
	) {}

	current(): string {
		return this.state.state?.deviceName ?? defaultDeviceName();
	}

	async rename(name: string): Promise<void> {
		const trimmed = name.trim() || defaultDeviceName();
		const base =
			this.state.state ??
			(await loadState(this.app.vault.adapter, this.app.vault.configDir));
		this.state.setInitial(base);
		await this.state.persist({ ...base, deviceName: trimmed });
		this.onRenamed();
	}
}
