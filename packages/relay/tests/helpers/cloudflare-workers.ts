/** Node stand-in for the workerd-only "cloudflare:workers" module, aliased in
 * vitest.config.ts so the relay can be imported outside workerd. */
export class DurableObject {
	constructor(
		readonly ctx: unknown,
		readonly env: unknown,
	) {}
}
