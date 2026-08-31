import type { DataAdapter, ListedFiles, Stat } from "obsidian";

import { normalizeShareRoot } from "./types";

/**
 * A view of the vault's DataAdapter rooted at a folder. The sync engine works
 * with share-root-relative paths ("" is the share root), which is what makes
 * a share mountable at a different folder on each participant's device: the
 * share manifest stores relative paths, and this adapter maps them back to
 * real vault paths.
 *
 * Implements exactly the DataAdapter surface the engine touches (scanner,
 * vault/io, content loaders). Obtain a typed DataAdapter via
 * {@link asDataAdapter}.
 */
export class ScopedVaultAdapter {
	private readonly root: string;

	constructor(
		private readonly inner: DataAdapter,
		root: string,
	) {
		this.root = normalizeShareRoot(root);
		if (!this.root) {
			throw new Error("Shared folder root must not be the vault root");
		}
	}

	asDataAdapter(): DataAdapter {
		return this as unknown as DataAdapter;
	}

	getName(): string {
		return this.inner.getName();
	}

	exists(path: string): Promise<boolean> {
		return this.inner.exists(this.abs(path));
	}

	stat(path: string): Promise<Stat | null> {
		return this.inner.stat(this.abs(path));
	}

	async list(path: string): Promise<ListedFiles> {
		const listing = await this.inner.list(this.abs(path));
		return {
			files: listing.files.map((entry) => this.rel(entry)),
			folders: listing.folders.map((entry) => this.rel(entry)),
		};
	}

	read(path: string): Promise<string> {
		return this.inner.read(this.abs(path));
	}

	readBinary(path: string): Promise<ArrayBuffer> {
		return this.inner.readBinary(this.abs(path));
	}

	write(path: string, data: string): Promise<void> {
		return this.inner.write(this.abs(path), data);
	}

	writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		return this.inner.writeBinary(this.abs(path), data);
	}

	mkdir(path: string): Promise<void> {
		return this.inner.mkdir(this.abs(path));
	}

	rmdir(path: string, recursive: boolean): Promise<void> {
		return this.inner.rmdir(this.abs(path), recursive);
	}

	remove(path: string): Promise<void> {
		return this.inner.remove(this.abs(path));
	}

	rename(from: string, to: string): Promise<void> {
		return this.inner.rename(this.abs(from), this.abs(to));
	}

	trashLocal(path: string): Promise<void> {
		return this.inner.trashLocal(this.abs(path));
	}

	async trashSystem(path: string): Promise<boolean> {
		return this.inner.trashSystem(this.abs(path));
	}

	private abs(path: string): string {
		const rel = path.replace(/^\/+/, "");
		return rel ? `${this.root}/${rel}` : this.root;
	}

	private rel(vaultPath: string): string {
		const prefix = `${this.root}/`;
		if (vaultPath === this.root) return "";
		return vaultPath.startsWith(prefix)
			? vaultPath.slice(prefix.length)
			: vaultPath;
	}
}
