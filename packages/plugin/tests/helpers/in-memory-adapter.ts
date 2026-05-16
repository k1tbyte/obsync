import type { DataAdapter, ListedFiles, Stat } from "obsidian";

interface FileEntry {
	data: Uint8Array;
	mtime: number;
}

function norm(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Minimal in-memory {@link DataAdapter} covering exactly what the sync engine
 * (scanner + vault/io + pull) touches: list/stat/exists/read(Binary)/
 * write(Binary)/mkdir/rmdir/remove/rename. Unused DataAdapter members are not
 * implemented (cast through `unknown`).
 */
export class InMemoryAdapter {
	private readonly files = new Map<string, FileEntry>();
	private readonly dirs = new Set<string>();
	// Monotonic, non-racy mtime so each write is distinct (real FS mtime
	// changes per write; Date.now() collides within a test tick).
	private mtimeSeq = 1;

	private nextMtime(): number {
		return ++this.mtimeSeq;
	}

	/** Test helper: seed/replace a text file. */
	putText(path: string, text: string): void {
		this.writeFile(
			norm(path),
			new TextEncoder().encode(text),
			this.nextMtime(),
		);
	}

	/** Test helper: read a file back as text (throws if missing). */
	readText(path: string): string {
		const entry = this.files.get(norm(path));
		if (!entry) throw new Error(`Missing file: ${path}`);
		return new TextDecoder().decode(entry.data);
	}

	hasFile(path: string): boolean {
		return this.files.has(norm(path));
	}

	private writeFile(n: string, data: Uint8Array, mtime: number): void {
		this.files.set(n, { data, mtime });
		const slash = n.lastIndexOf("/");
		if (slash > 0) this.addDir(n.slice(0, slash));
	}

	private addDir(n: string): void {
		let cur = n;
		while (cur) {
			this.dirs.add(cur);
			const slash = cur.lastIndexOf("/");
			cur = slash > 0 ? cur.slice(0, slash) : "";
		}
	}

	list(path: string): Promise<ListedFiles> {
		const n = norm(path);
		const prefix = n === "" ? "" : `${n}/`;
		const files: string[] = [];
		const folders = new Set<string>();
		for (const key of this.files.keys()) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			if (rest.includes("/")) folders.add(prefix + rest.split("/")[0]);
			else files.push(key);
		}
		for (const dir of this.dirs) {
			if (dir === n || !dir.startsWith(prefix)) continue;
			const rest = dir.slice(prefix.length);
			if (!rest.includes("/")) folders.add(dir);
		}
		return Promise.resolve({ files, folders: [...folders] });
	}

	stat(path: string): Promise<Stat | null> {
		const n = norm(path);
		const file = this.files.get(n);
		if (file) {
			return Promise.resolve({
				type: "file",
				ctime: file.mtime,
				mtime: file.mtime,
				size: file.data.length,
			});
		}
		if (this.dirs.has(n) || n === "") {
			return Promise.resolve({ type: "folder", ctime: 0, mtime: 0, size: 0 });
		}
		return Promise.resolve(null);
	}

	exists(path: string): Promise<boolean> {
		const n = norm(path);
		if (this.files.has(n) || this.dirs.has(n)) return Promise.resolve(true);
		const prefix = `${n}/`;
		for (const key of this.files.keys()) {
			if (key.startsWith(prefix)) return Promise.resolve(true);
		}
		return Promise.resolve(false);
	}

	readBinary(path: string): Promise<ArrayBuffer> {
		const entry = this.files.get(norm(path));
		if (!entry) return Promise.reject(new Error(`Missing file: ${path}`));
		return Promise.resolve(toArrayBuffer(entry.data));
	}

	writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.writeFile(norm(path), new Uint8Array(data), this.nextMtime());
		return Promise.resolve();
	}

	read(path: string): Promise<string> {
		const entry = this.files.get(norm(path));
		if (!entry) return Promise.reject(new Error(`Missing file: ${path}`));
		return Promise.resolve(new TextDecoder().decode(entry.data));
	}

	write(path: string, data: string): Promise<void> {
		this.writeFile(norm(path), new TextEncoder().encode(data), Date.now());
		return Promise.resolve();
	}

	mkdir(path: string): Promise<void> {
		this.addDir(norm(path));
		return Promise.resolve();
	}

	rmdir(path: string, recursive: boolean): Promise<void> {
		const n = norm(path);
		this.dirs.delete(n);
		if (recursive) {
			const prefix = `${n}/`;
			for (const key of [...this.files.keys()]) {
				if (key.startsWith(prefix)) this.files.delete(key);
			}
			for (const dir of [...this.dirs]) {
				if (dir.startsWith(prefix)) this.dirs.delete(dir);
			}
		}
		return Promise.resolve();
	}

	remove(path: string): Promise<void> {
		this.files.delete(norm(path));
		return Promise.resolve();
	}

	rename(oldPath: string, newPath: string): Promise<void> {
		const from = norm(oldPath);
		const entry = this.files.get(from);
		if (entry) {
			this.files.delete(from);
			this.writeFile(norm(newPath), entry.data, entry.mtime);
		}
		return Promise.resolve();
	}

	asDataAdapter(): DataAdapter {
		return this as unknown as DataAdapter;
	}
}
