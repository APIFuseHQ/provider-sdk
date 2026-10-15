/**
 * Which hosts a URL in public provider output may name. Consumers load images
 * and open links from these URLs in a user's browser, so a literal IPv4 or
 * IPv6 address, `localhost`, a name ending in `.local`, `.internal` or
 * `.localhost`, and a single-label name (`http://router/`) never qualify.
 *
 * This module has no runtime dependencies, so browser bundles import it
 * (`@apifuse/provider-sdk/url-host`): the SDK's output URL helpers and the
 * Prompt Playground's URL references apply this one rule.
 */

const BLOCKED_HOST =
	/^(\d{1,3}(\.\d{1,3}){3}|\[[^\]]*\]|localhost|.+\.(local|internal|localhost)|[^.]+)$/i;
// ASCII letters, digits, `-`, `_` and dots; an internationalized name counts in
// its punycode form, which is how `URL.hostname` gives it. The URL parser also
// reads `a.com,https` out of the run-on `https://a.com,https://b.com`: no host.
const HOST_CHARACTERS = /^[a-z0-9_.-]+$/;

/**
 * Whether `hostname`, as `URL.hostname` gives it, may appear in public output.
 * ASCII case and trailing dots are ignored: a fully qualified `localhost.`
 * resolves to the same host as `localhost`.
 */
export function isPublicUrlHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.+$/, "");
	return host.length > 0 && !BLOCKED_HOST.test(host) && HOST_CHARACTERS.test(host);
}
