import { defaultDeviceName } from "@/sync/device";

import type { StatePersister } from "./state-persister";

/** The device name lives in local state only - it is never synced. */
export class DeviceName {
	constructor(
		private readonly state: StatePersister,
		private readonly onRenamed: () => void,
	) {}

	current(): string {
		return this.state.state.deviceName ?? defaultDeviceName();
	}

	async rename(name: string): Promise<void> {
		const trimmed = name.trim() || defaultDeviceName();
		await this.state.persist({ ...this.state.state, deviceName: trimmed });
		this.onRenamed();
	}
}
