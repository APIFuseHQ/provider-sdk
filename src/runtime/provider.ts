import type { ProviderDefinition } from "../types.js";

export function getProviderBaseUrl(provider: ProviderDefinition): string | undefined {
	const operations = Object.values(provider.operations as Record<string, unknown>);

	for (const operation of operations) {
		const baseUrl = (operation as { upstream?: { baseUrl?: unknown } }).upstream?.baseUrl;

		if (typeof baseUrl === "string" && baseUrl.length > 0) {
			return baseUrl;
		}
	}

	return undefined;
}

/**
 * The base `ctx.stealth` resolves relative request URLs (and seeds its cookie
 * jar's default origin) against: the provider's first declared
 * `upstream.baseUrl`, else `https://<allowedHosts[0]>`. `undefined` means the
 * provider declares neither, and `serve` binds no stealth transport at all.
 */
export function getProviderStealthBaseUrl(provider: ProviderDefinition): string | undefined {
	const baseUrl = getProviderBaseUrl(provider);
	if (baseUrl) {
		return baseUrl;
	}
	const firstHost = provider.allowedHosts?.[0];
	return firstHost ? `https://${firstHost}` : undefined;
}
