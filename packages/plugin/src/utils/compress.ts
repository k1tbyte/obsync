const FORMAT: CompressionFormat = "deflate-raw";

/**
 * Widest support of the three formats: shipped with CompressionStream itself,
 * where "deflate-raw" arrived three Chromium releases later. Worth the 18-byte
 * header for a payload a stranger's device has to be able to read back.
 */
export const GZIP: CompressionFormat = "gzip";

/** Returns null when the platform lacks CompressionStream. */
export async function deflateBytes(
	bytes: Uint8Array,
	format: CompressionFormat = FORMAT,
): Promise<Uint8Array | null> {
	if (typeof CompressionStream !== "function") return null;
	const stream = new Blob([bytes as unknown as BlobPart])
		.stream()
		.pipeThrough(new CompressionStream(format));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflateBytes(
	bytes: Uint8Array,
	format: CompressionFormat = FORMAT,
): Promise<Uint8Array> {
	if (typeof DecompressionStream !== "function") {
		throw new Error("This device cannot decompress Obsync links");
	}
	const stream = new Blob([bytes as unknown as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream(format));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
