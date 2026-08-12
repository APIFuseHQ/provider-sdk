import { ProviderError } from "../../errors.js";

export function normalizedResolverHostname(hostname: string): string {
	return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function assertResolverHostAllowed(
	targetUrl: string,
	allowedHosts: readonly string[],
): void {
	let targetHost: string;
	try {
		targetHost = normalizedResolverHostname(new URL(targetUrl).hostname);
	} catch {
		throw new ProviderError("Resolver target URL is invalid", {
			code: "RESOLVER_HOST_NOT_ALLOWED",
			fix: "Use a valid URL whose exact hostname appears in the provider's allowedHosts declaration.",
		});
	}

	const isAllowed = allowedHosts.some((host) => {
		const declaredHost = normalizedResolverHostname(host);
		return declaredHost.length > 0 && !declaredHost.includes("*") && declaredHost === targetHost;
	});
	if (isAllowed) return;

	throw new ProviderError(`Resolver target host "${targetHost}" is not declared`, {
		code: "RESOLVER_HOST_NOT_ALLOWED",
		fix: "Add the exact target hostname to the provider's allowedHosts declaration.",
	});
}
