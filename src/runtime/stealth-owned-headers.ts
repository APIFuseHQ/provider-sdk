/**
 * Header names the stealth transport owns.
 *
 * `ctx.stealth` composes these from the Chrome emulation and the request class,
 * so a caller value is rejected at request time with `SDKError` code
 * `STEALTH_HEADER_OVERRIDE_UNSUPPORTED` (`assertCallerHeadersSupported` in
 * stealth.ts). The `browser-version-literal` lint reports a subset of these
 * names — the `sec-fetch-*` and `sec-ch-ua*` families — in files that use
 * `ctx.stealth` (`isReportedOwnedHeaderName` in lint.ts). Both read this
 * module, so the lint cannot claim a rejection the runtime does not perform;
 * it reports deliberately less than the runtime rejects (host, connection,
 * accept-encoding and a non-literal user-agent stay silent — see that
 * predicate for why), so a green `apifuse check` is not proof that no owned
 * header is set.
 *
 * Leaf module by design: no imports, so the lazily loaded CLI lint path does
 * not pull the stealth runtime in.
 */
export const SDK_OWNED_EXACT_CHROME_HEADERS: ReadonlySet<string> = new Set([
	"host",
	"connection",
	"user-agent",
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform",
	"accept-encoding",
]);

export const SDK_OWNED_CHROME_HEADER_PREFIX = "sec-fetch-";

/**
 * True when `ctx.stealth` rejects a caller value for `name` (case-insensitive):
 * an exact member of {@link SDK_OWNED_EXACT_CHROME_HEADERS} or any
 * `sec-fetch-*` name.
 */
export function isStealthOwnedHeaderName(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		SDK_OWNED_EXACT_CHROME_HEADERS.has(lower) || lower.startsWith(SDK_OWNED_CHROME_HEADER_PREFIX)
	);
}
