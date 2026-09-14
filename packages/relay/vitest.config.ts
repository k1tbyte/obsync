import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"cloudflare:workers": fileURLToPath(
				new URL("./tests/helpers/cloudflare-workers.ts", import.meta.url),
			),
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// PartyServer imports the workerd-only "cloudflare:workers" module, so it
		// must go through the transform pipeline for the alias to rewrite it.
		server: { deps: { inline: ["partyserver"] } },
	},
});
