import { Setting } from "obsidian";

import type ObsyncPlugin from "../main";
import {
	ESyncLogLevel,
	ESyncLogOperation,
	type SyncLogEntry,
} from "../logs/store";

const LOG_LEVEL_LABELS: Record<ESyncLogLevel, string> = {
	[ESyncLogLevel.Info]: "Info",
	[ESyncLogLevel.Warn]: "Warning",
	[ESyncLogLevel.Error]: "Error",
};

const LOG_LEVEL_CLASSES: Record<ESyncLogLevel, string> = {
	[ESyncLogLevel.Info]: "is-info",
	[ESyncLogLevel.Warn]: "is-warn",
	[ESyncLogLevel.Error]: "is-error",
};

const OPERATION_LABELS: Record<ESyncLogOperation, string> = {
	[ESyncLogOperation.Compare]: "Compare",
	[ESyncLogOperation.Push]: "Push",
	[ESyncLogOperation.Pull]: "Pull",
	[ESyncLogOperation.Reset]: "Reset",
	[ESyncLogOperation.Session]: "Session",
};

export function renderLogsView(
	parent: HTMLElement,
	plugin: ObsyncPlugin,
	onRefresh: () => void,
): void {
	new Setting(parent).setName("Logs").setHeading();
	parent.createEl("p", {
		text:
			"Compare, push, pull, reset and sync errors are recorded locally on this device. " +
			"Use Compare with remote from the command palette to inspect the current diff.",
	});

	new Setting(parent)
		.setName("Diagnostics")
		.setDesc("Stored locally inside the Obsync plugin folder and excluded from sync.")
		.addButton((button) =>
			button.setButtonText("Refresh").onClick(() => {
				onRefresh();
			}),
		)
		.addButton((button) =>
			button
				.setButtonText("Clear logs")
				.setWarning()
				.onClick(async () => {
					await plugin.clearLogs();
					onRefresh();
				}),
		);

	const entries = plugin.getLogs();
	if (entries.length === 0) {
		parent.createEl("p", { text: "No logs yet." });
		return;
	}

	const list = parent.createDiv({ cls: "obsync-log-list" });
	for (const entry of entries) {
		renderLogEntry(list, entry);
	}
}

function renderLogEntry(parent: HTMLElement, entry: SyncLogEntry): void {
	const item = parent.createDiv({ cls: `obsync-log-entry ${LOG_LEVEL_CLASSES[entry.level]}` });
	const meta = item.createDiv({ cls: "obsync-log-meta" });
	meta.setText(
		`${formatTimestamp(entry.timestamp)} • ${OPERATION_LABELS[entry.operation]} • ${LOG_LEVEL_LABELS[entry.level]}`,
	);
	item.createEl("div", { cls: "obsync-log-message", text: entry.message });
	if (entry.details.length === 0) {
		return;
	}
	const details = item.createEl("details", { cls: "obsync-log-details" });
	details.createEl("summary", { text: `Details (${entry.details.length})` });
	const list = details.createEl("ul");
	for (const detail of entry.details) {
		list.createEl("li", { text: detail });
	}
}

function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toLocaleString();
}
