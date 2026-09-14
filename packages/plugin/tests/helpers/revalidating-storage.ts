import type { ConditionalRead } from "@/storage/types";
import { FakeStorage } from "./fake-storage";

/** A backend that hands out a validator, as S3 and WebDAV do. */
export class RevalidatingStorage extends FakeStorage {
	bodiesSent = 0;
	private version = 0;
	private readonly etags = new Map<string, string>();

	override put(objectKey: string, body: Uint8Array): Promise<void> {
		this.etags.set(objectKey, `"v${++this.version}"`);
		return super.put(objectKey, body);
	}

	override delete(objectKey: string): Promise<void> {
		this.etags.delete(objectKey);
		return super.delete(objectKey);
	}

	getIfChanged(
		objectKey: string,
		etag: string | null,
	): Promise<ConditionalRead> {
		const body = this.map.get(objectKey);
		if (!body) return Promise.resolve({ status: "absent" });
		const current = this.etags.get(objectKey) ?? null;
		if (etag !== null && etag === current) {
			return Promise.resolve({ status: "unchanged" });
		}
		this.bodiesSent++;
		return Promise.resolve({ status: "found", body, etag: current });
	}
}
