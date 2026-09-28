import { getPublicSuffix } from "tough-cookie";

/**
 * Request-body header names a redirect drops when it changes the method
 * (Fetch "request-body-header name").
 */
const REDIRECT_BODY_HEADERS: ReadonlySet<string> = new Set([
	"content-encoding",
	"content-language",
	"content-location",
	"content-type",
]);

/**
 * Credentials a redirect never carries to another origin. Fetch removes
 * `Authorization` on a cross-origin redirect; `Proxy-Authorization` is a
 * credential of the same kind.
 */
const CROSS_ORIGIN_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
	"authorization",
	"proxy-authorization",
]);

/** One redirect hop: the URL the headers were sent to, and the next request. */
export interface RedirectHop {
	readonly from: string;
	readonly to: string;
	readonly methodChanged: boolean;
}

/**
 * Schemeful site (HTML "same site"): scheme plus registrable domain from the
 * public suffix list, or the bare host when there is none (an IP address or
 * a single-label host).
 */
function schemefulSite(url: URL): string {
	const host = url.hostname;
	const registrable = getPublicSuffix(host, { allowSpecialUseDomain: true, ignoreError: true });
	return `${url.protocol}//${registrable ?? host}`;
}

/**
 * The caller headers the next redirect hop carries, derived from the headers
 * the previous hop sent. Both stealth redirect walkers compute every hop's
 * headers here, so the rules hold on every path:
 *
 * - a method change drops the request-body headers;
 * - a cross-origin hop drops `Authorization` and `Proxy-Authorization`;
 * - a cross-site hop drops an explicit `Cookie`, after which the session
 *   cookie jar supplies cookies by its own domain rules, as a browser does.
 *
 * A header dropped on one hop stays dropped for the rest of the chain.
 */
export function redirectHopHeaders<T>(
	hop: RedirectHop,
	headers: Readonly<Record<string, T>>,
): Record<string, T> {
	const from = new URL(hop.from);
	const to = new URL(hop.to);
	const crossOrigin = from.origin !== to.origin;
	const crossSite = schemefulSite(from) !== schemefulSite(to);
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => {
			const lower = name.toLowerCase();
			if (hop.methodChanged && REDIRECT_BODY_HEADERS.has(lower)) return false;
			if (crossOrigin && CROSS_ORIGIN_CREDENTIAL_HEADERS.has(lower)) return false;
			if (crossSite && lower === "cookie") return false;
			return true;
		}),
	);
}
