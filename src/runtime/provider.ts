import type { ProviderDefinition } from "../types";

export function getProviderBaseUrl(
	provider: ProviderDefinition,
): string | undefined {
	const operations = Object.values(
		provider.operations as Record<string, unknown>,
	);

	for (const operation of operations) {
		const baseUrl = (operation as { upstream?: { baseUrl?: unknown } }).upstream
			?.baseUrl;

		if (typeof baseUrl === "string" && baseUrl.length > 0) {
			return baseUrl;
		}
	}

	return undefined;
}
