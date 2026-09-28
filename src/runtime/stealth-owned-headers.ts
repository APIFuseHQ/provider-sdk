import { SDKError } from "../errors.js";

/**
 * Header names the stealth transport owns.
 *
 * `ctx.stealth` composes these from the Chrome emulation and the request class,
 * so a caller value is rejected at request time with `SDKError` code
 * `STEALTH_HEADER_OVERRIDE_UNSUPPORTED` ({@link assertCallerHeadersSupported}).
 * The offline test harness (`runStandardTests`) calls the same function on
 * every `ctx.stealth` request it serves, so a provider test fails exactly where
 * production would, whichever file or variable the header came from. That is
 * the cross-file enforcement.
 *
 * The `browser-version-literal` lint reports a subset of these names — the
 * `sec-fetch-*` and `sec-ch-ua*` families — in files that use `ctx.stealth`
 * (`isReportedOwnedHeaderName` in lint.ts). Both read this module, so the lint
 * cannot claim a rejection the runtime does not perform; it reports
 * deliberately less than the runtime rejects (host, connection,
 * accept-encoding and a non-literal user-agent stay silent — see that
 * predicate for why), so a green `apifuse check` is not proof that no owned
 * header is set.
 *
 * Kept off the stealth runtime: the only import is `errors.js`, whose own
 * imports are type-only, so the lazily loaded CLI lint path does not pull the
 * stealth runtime in.
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

/**
 * Throws `SDKError` `STEALTH_HEADER_OVERRIDE_UNSUPPORTED` for the first caller
 * header `ctx.stealth` owns. An `undefined` value is skipped, as the transport
 * drops it before sending. The stealth runtime and the offline test harness
 * both call this, so the two cannot disagree about what is rejected.
 */
export function assertCallerHeadersSupported(
	headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): void {
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || !isStealthOwnedHeaderName(name)) continue;
		throw new SDKError(
			`Stealth transport owns the "${name.toLowerCase()}" header; remove it from headers.`,
			{ code: "STEALTH_HEADER_OVERRIDE_UNSUPPORTED" },
		);
	}
}
