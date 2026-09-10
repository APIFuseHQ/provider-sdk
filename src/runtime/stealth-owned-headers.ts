/**
 * Header names the stealth transport owns.
 *
 * `ctx.stealth` composes these from the Chrome emulation and the request class,
 * so a caller value is rejected at request time with `SDKError` code
 * `STEALTH_HEADER_OVERRIDE_UNSUPPORTED` (`assertCallerHeadersSupported` in
 * stealth.ts). The `browser-version-literal` lint reports the same names in
 * files that use `ctx.stealth` (lint.ts). Both read this module so the lint
 * cannot claim a rejection the runtime does not perform, or miss one it does.
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
