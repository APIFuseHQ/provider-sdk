import { ProviderError } from "../../errors.js";
import type { ProviderResolverVendor } from "../../types.js";

/**
 * Exact SDK-owned service hosts each vendor's adapter may reach through its bound
 * transport, in addition to the provider's declared `allowedHosts`. This table is
 * the trust boundary for `ResolverVendorAdapter.transportAllowedHosts`: a
 * declaration outside its vendor's entry is rejected, whoever supplied the adapter.
 * Only Hyper's observed-IP reflector rides the identity-bound transport (ADR-0008
 * v1.1 amend, PR #251); every other vendor talks to its own service directly.
 * Frozen at runtime, not just in the type: the Hyper adapter hands its entry out by
 * reference as `transportAllowedHosts`, so a mutable table would let any holder of a
 * registry adapter widen the boundary for every later adapter in the process.
 */
export const RESOLVER_VENDOR_TRANSPORT_HOSTS = Object.freeze({
	"2captcha": Object.freeze([] as const),
	browser: Object.freeze([] as const),
	capmonster: Object.freeze([] as const),
	capsolver: Object.freeze([] as const),
	custom: Object.freeze([] as const),
	hypersolutions: Object.freeze(["ip.hypersolutions.co"] as const),
}) satisfies Readonly<Record<ProviderResolverVendor, readonly string[]>>;

export function normalizedResolverHostname(hostname: string): string {
	return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function assertResolverHostAllowed(
	targetUrl: string,
	allowedHosts: readonly string[],
): void {
	let targetUrlObject: URL;
	try {
		targetUrlObject = new URL(targetUrl);
	} catch {
		throw new ProviderError("Resolver target URL is invalid", {
			code: "RESOLVER_HOST_NOT_ALLOWED",
			fix: "Use a valid URL whose exact hostname appears in the provider's allowedHosts declaration.",
		});
	}
	if (targetUrlObject.protocol !== "http:" && targetUrlObject.protocol !== "https:") {
		throw new ProviderError(`Resolver target URL scheme "${targetUrlObject.protocol}" is not allowed`, {
			code: "RESOLVER_HOST_NOT_ALLOWED",
			fix: "Use an http or https URL whose exact hostname appears in the provider's allowedHosts declaration.",
		});
	}
	const targetHost = normalizedResolverHostname(targetUrlObject.hostname);

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

export function assertResolverVendorTransportHosts(
	vendor: ProviderResolverVendor,
	declaredHosts: readonly string[],
): void {
	// A vendor id outside the table (only reachable from untyped callers) owns no hosts and
	// is rejected below like any other overreach; `hasOwn` keeps prototype keys out too.
	const ownedHosts: readonly string[] = Object.hasOwn(RESOLVER_VENDOR_TRANSPORT_HOSTS, vendor)
		? RESOLVER_VENDOR_TRANSPORT_HOSTS[vendor]
		: [];
	for (const declaredHost of declaredHosts) {
		const normalizedHost = normalizedResolverHostname(declaredHost);
		if (ownedHosts.some((host) => normalizedResolverHostname(host) === normalizedHost)) continue;
		throw new ProviderError(
			`Resolver vendor "${vendor}" may not declare transport host "${normalizedHost}"`,
			{
				code: "RESOLVER_VENDOR_HOST_NOT_ALLOWED",
				fix: "Remove the host from transportAllowedHosts: an adapter reaches only the provider's allowedHosts plus the SDK-owned service hosts of its vendor.",
			},
		);
	}
}
