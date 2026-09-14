/**
 * Reads the two S3 responses that carry XML. A parser dependency would undo
 * what removing the SDK bought, and `DOMParser` does not exist in the test
 * runner; the documents are machine-generated and only four tags are read.
 * A value can never contain a raw `<`, so a non-greedy match between a tag and
 * its close is exact for any well-formed document.
 */

export interface ListPage {
	keys: string[];
	/** Present while the listing has more pages. */
	nextToken?: string;
}

/**
 * Throws rather than under-report. A listing that silently loses keys is read
 * as "the remote does not have these", which is the input to deciding what to
 * delete and what to upload.
 */
export function parseListObjects(xml: string): ListPage {
	if (!LIST_ROOT.test(xml)) {
		throw new Error(
			"S3 listing response was not a ListBucketResult; something between the plugin and the bucket answered instead.",
		);
	}
	const keys: string[] = [];
	for (const match of xml.matchAll(CONTENTS)) {
		// A key may legitimately begin or end with a space, so it is never trimmed.
		const key = tagValue(match[1] ?? "", "Key");
		if (key) keys.push(key);
	}
	const nextToken = tagValue(xml, "NextContinuationToken")?.trim();
	// S3 always names the token alongside a truncated listing. A backend that
	// does not has told us the page is partial without saying how to continue.
	if (!nextToken && tagValue(xml, "IsTruncated")?.trim() === "true") {
		throw new Error(
			"S3 reported a truncated listing without a continuation token, so the object list would be incomplete.",
		);
	}
	return nextToken ? { keys, nextToken } : { keys };
}

/** The `Code` of an S3 error document, e.g. `NoSuchBucket`. */
export function parseErrorCode(xml: string): string | null {
	return tagValue(xml, "Code")?.trim() ?? null;
}

/** Namespace prefixes and attributes are tolerated; S3 itself uses neither. */
const LIST_ROOT = /<(?:\w+:)?ListBucketResult[\s>]/;
const CONTENTS =
	/<(?:\w+:)?Contents(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?Contents>/g;

function tagValue(xml: string, tag: string): string | null {
	const match = new RegExp(
		String.raw`<(?:\w+:)?${tag}(?:\s[^>]*)?>([\s\S]*?)</(?:\w+:)?${tag}>`,
	).exec(xml);
	return match?.[1] === undefined ? null : decodeEntities(match[1]);
}

function decodeEntities(value: string): string {
	return (
		value
			.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
				String.fromCodePoint(Number.parseInt(hex, 16)),
			)
			.replace(/&#(\d+);/g, (_, dec: string) =>
				String.fromCodePoint(Number.parseInt(dec, 10)),
			)
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			// Last: an ampersand decoded first would corrupt the entities above.
			.replace(/&amp;/g, "&")
	);
}
