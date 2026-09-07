import type { ProviderEngine } from "./engine.js";

const REMOTE_ENGINES = new WeakSet<object>();

/** Internal discriminator; deliberately absent from every package entry point. */
export function markRemoteProviderEngine<T extends ProviderEngine>(engine: T): T {
	REMOTE_ENGINES.add(engine);
	return engine;
}

/** Internal discriminator; deliberately absent from every package entry point. */
export function isRemoteProviderEngine(engine: ProviderEngine): boolean {
	return REMOTE_ENGINES.has(engine);
}
