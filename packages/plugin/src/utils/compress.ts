const FORMAT: CompressionFormat = "deflate-raw";

/** Returns null when the platform lacks CompressionStream. */
export async function deflateBytes(
	bytes: Uint8Array,
): Promise<Uint8Array | null> {
	if (typeof CompressionStream !== "function") return null;
	const stream = new Blob([bytes as unknown as BlobPart])
		.stream()
		.pipeThrough(new CompressionStream(FORMAT));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflateBytes(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream !== "function") {
		throw new Error("This device cannot decompress Obsync links");
	}
	const stream = new Blob([bytes as unknown as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream(FORMAT));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
