import type { Modal } from "obsidian";

/**
 * Opens a modal that answers with a value.
 *
 * The promise always settles: Escape and a click outside close the modal
 * without touching its buttons, and a caller awaiting the answer would
 * otherwise wait forever — which is how a dismissed passphrase prompt used to
 * stall the whole sync.
 */
export function openPromiseModal<T>(
	create: (answer: (value: T) => void) => Modal,
	dismissed: T,
): Promise<T> {
	return new Promise<T>((resolve) => {
		let settled = false;
		const settle = (value: T): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const modal = create(settle);
		const close = modal.onClose.bind(modal);
		modal.onClose = (): void => {
			close();
			settle(dismissed);
		};
		modal.open();
	});
}
