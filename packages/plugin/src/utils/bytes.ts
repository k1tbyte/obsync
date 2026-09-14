/**
 * A `Uint8Array` may be a view into a larger buffer, so handing `.buffer` to a
 * Web/Obsidian API that wants an `ArrayBuffer` would expose everything around
 * it. Copy unless the view already spans its whole buffer.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes.buffer as ArrayBuffer;
	}
	return bytes.slice().buffer as ArrayBuffer;
}
