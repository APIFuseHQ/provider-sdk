import { isEngineOwnedEnvName } from "../engine.js";
import type { EnvContext } from "../types.js";

/**
 * A mixed-case spelling of an engine-owned name is an alias: on Windows it resolves to the
 * engine's variable while evading an exact-name allowlist. Only the exact (upper-case) name,
 * which engine-internal contexts allowlist explicitly, may read those values.
 */
function isEngineOwnedEnvAlias(key: string): boolean {
	return isEngineOwnedEnvName(key) && key !== key.toUpperCase();
}

export function createEnvContext(allowedKeys?: string[]): EnvContext {
	return {
		get(key: string): string | undefined {
			if (allowedKeys && !allowedKeys.includes(key)) {
				return undefined;
			}
			if (isEngineOwnedEnvAlias(key)) {
				return undefined;
			}

			return process.env[key];
		},
	};
}
