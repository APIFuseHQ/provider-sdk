import { assertProviderLocaleKey } from "./keys.js";

/** Canonical locale-catalog namespace for a URL-safe provider operation id. */
export function operationIdToLocaleNamespace(operationId: string): string {
	const namespace = operationId.replace(/[-_]([a-z0-9])/g, (_separator, character: string) =>
		character.toUpperCase(),
	);
	assertProviderLocaleKey(`operations.${namespace}.description`);
	return namespace;
}
