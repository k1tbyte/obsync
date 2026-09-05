import { Setting } from "obsidian";

import type ObsyncPlugin from "../../main";
import {
	deepCleanOrphanedObjects,
	resetLocalState,
	resetRemoteStorage,
	verifyRemoteIntegrity,
} from "../../ui/maintenance-actions";

interface MaintenanceAction {
	name: string;
	desc: string;
	buttonText: string;
	warning?: boolean;
	run: (plugin: ObsyncPlugin) => Promise<unknown>;
}

const MAINTENANCE_ACTIONS: ReadonlyArray<MaintenanceAction> = [
	{
		name: "Reset local state",
		desc: "Clear the local sync baseline, adopted remote vault, and file hash cache on this device. Obsync settings stay unchanged.",
		buttonText: "Reset local",
		warning: true,
		run: resetLocalState,
	},
	{
		name: "Verify remote integrity",
		desc: "Check every referenced object exists and decrypts to its hash.",
		buttonText: "Verify",
		run: verifyRemoteIntegrity,
	},
	{
		name: "Deep-clean orphaned objects",
		desc: "List storage and delete blobs/snapshots unreachable from the manifest or history.",
		buttonText: "Deep-clean",
		warning: true,
		run: deepCleanOrphanedObjects,
	},
	{
		name: "Reset remote storage",
		desc: "Delete the remote Obsync manifest and objects on the configured backend.",
		buttonText: "Reset remote",
		warning: true,
		run: resetRemoteStorage,
	},
];

export function renderMaintenanceSection(
	parent: HTMLElement,
	plugin: ObsyncPlugin,
): void {
	new Setting(parent).setName("Maintenance").setHeading();

	for (const action of MAINTENANCE_ACTIONS) {
		new Setting(parent)
			.setName(action.name)
			.setDesc(action.desc)
			.addButton((button) => {
				let running = false;
				button.setButtonText(action.buttonText).onClick(() => {
					if (running) return;
					running = true;
					button.setDisabled(true);
					void action.run(plugin).finally(() => {
						running = false;
						button.setDisabled(false);
					});
				});
				if (action.warning) button.setWarning();
			});
	}
}
