import type { Extension } from "@codemirror/state";

import { computePlugin } from "./compute";
import { buildSignsGutter, signsField } from "./gutter";
import type { SignsProvider } from "./provider";
import { chunksField, compareTextField } from "./state";
import { subscriberPlugin } from "./subscriber";

export function buildSignsExtensions(provider: SignsProvider): Extension[] {
	return [
		compareTextField,
		chunksField,
		signsField,
		computePlugin,
		buildSignsGutter(provider),
		subscriberPlugin(provider),
	];
}
