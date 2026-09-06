import { Setting } from "obsidian";
import { clearCachedPassphrase } from "@/crypto/passphrase-cache";
import type { PluginHost } from "@/plugin/host";
import { PassphraseRotatedError } from "@/sync/keyfile";
import { askNewPassphrase, notifyError, notifyInfo, reportError } from "@/ui";

export function renderSecuritySection(
	parent: HTMLElement,
	plugin: PluginHost,
	onDisplay: () => void,
): void {
	new Setting(parent).setName("Encryption").setHeading();

	const status = plugin.passphrase.has()
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
				await plugin.saveSettings();
				if (v) {
					// Turning on with a loaded passphrase caches it immediately.
					await plugin.passphrase.persistIfEnabled();
					return;
				}
				await clearCachedPassphrase(
					plugin.app.vault.adapter,
					plugin.app.vault.configDir,
				);
			}),
		);

	new Setting(parent)
		.setName("Passphrase")
		.setDesc(status)
		.addButton((b) =>
			b
				.setButtonText(plugin.passphrase.has() ? "Replace" : "Set")
				.onClick(async () => {
					await plugin.passphrase.prompt(true);
					onDisplay();
				}),
		)
		.addButton((b) =>
			b
				.setButtonText("Forget")
				.setWarning()
				.setDisabled(!plugin.passphrase.has())
				.onClick(async () => {
					await plugin.passphrase.forget();
					notifyInfo("Passphrase forgotten.");
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
					const epoch = await plugin.passphrase.rotate(next);
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
