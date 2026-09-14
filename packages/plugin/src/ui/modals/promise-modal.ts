import type { Modal } from "obsidian";

/**
 * Opens a modal that answers with a value.
 * The promise always settles so callers do not wait forever - which used to stall sync.
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
