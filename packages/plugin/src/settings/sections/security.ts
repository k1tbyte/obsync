import { Setting } from "obsidian";
import { clearCachedPassphrase } from "../../crypto/passphrase-cache";
import type ObsyncPlugin from "../../main";
import { PassphraseRotatedError } from "../../sync/keyfile";
import { askNewPassphrase } from "../../ui/modals";
import { notifyError, notifyInfo } from "../../ui/notices";

export function renderSecuritySection(
	parent: HTMLElement,
	plugin: ObsyncPlugin,
	onDisplay: () => void,
): void {
	new Setting(parent).setName("Encryption").setHeading();

	const status = plugin.hasPassphrase()
		? "Passphrase is loaded for this session."
		: "Passphrase is not set. You will be prompted before the next sync.";

	new Setting(parent)
		.setName("Cache passphrase between launches")
		.setDesc(
			"Stores the passphrase encrypted with a per-device key inside the plugin folder. " +
				"Disable for stricter security on shared devices.",
		)
		.addToggle((t) =>
			t.setValue(plugin.settings.cachePassphrase).onChange(async (v) => {
				Object.assign(plugin.settings, { cachePassphrase: v });
				void plugin.saveSettings();
				if (!v) {
					await clearCachedPassphrase(
						plugin.app.vault.adapter,
						plugin.app.vault.configDir,
					);
				}
			}),
		);

	new Setting(parent)
		.setName("Passphrase")
		.setDesc(status)
		.addButton((b) =>
			b
				.setButtonText(plugin.hasPassphrase() ? "Replace" : "Set")
				.onClick(async () => {
					await plugin.promptPassphrase(true);
					onDisplay();
				}),
		)
		.addButton((b) =>
			b
				.setButtonText("Forget")
				.setWarning()
				.setDisabled(!plugin.hasPassphrase())
				.onClick(async () => {
					await plugin.forgetPassphrase();
					notifyInfo("passphrase forgotten.");
					onDisplay();
				}),
		);

	new Setting(parent)
		.setName("Rotate passphrase")
		.setDesc(
			"Switch to a new passphrase. Re-wraps the data key only — notes are not re-encrypted, so it is instant. All other devices must enter the new passphrase afterwards.",
		)
		.addButton((b) =>
			b.setButtonText("Change…").onClick(async () => {
				const next = await askNewPassphrase(plugin.app);
				if (!next) return;
				try {
					const epoch = await plugin.changePassphrase(next);
					if (epoch === null) return;
					notifyInfo(`Passphrase changed (key epoch ${epoch}).`);
					onDisplay();
				} catch (err) {
					if (err instanceof PassphraseRotatedError) {
						notifyError("Current passphrase is incorrect.");
						return;
					}
					reportError(err);
				}
			}),
		);
}

function reportError(err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	notifyError(message);
	console.error("[obsync]", err);
}
