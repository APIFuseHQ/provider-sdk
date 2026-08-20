import { describe, expect, it } from "bun:test";
import {
	ProviderError,
	ProviderSecretError,
	SessionExpiredError,
	StealthCookieStoreVersionError,
	TransportError,
} from "../errors.js";
import {
	REDACTED_QUERY_VALUE,
	redactSensitiveError,
	redactSensitiveText,
	serializeRequestUrl,
} from "../runtime/request-options.js";

describe("sensitive request diagnostics", () => {
	it("collects every value for a declared-sensitive key from the URL and params", () => {
		const serialized = serializeRequestUrl(
			"https://example.com/items?serviceKey=url-secret&visible=1",
			{ serviceKey: ["params-secret", 123456] },
			{ serviceKey: "new-secret" },
		);

		expect(new Set(serialized.sensitiveValues)).toEqual(
			new Set(["url-secret", "params-secret", "123456", "new-secret"]),
		);
		expect(serialized.redactedUrl).toBe(
			"https://example.com/items?serviceKey=[REDACTED]&visible=1&serviceKey=[REDACTED]&serviceKey=[REDACTED]&serviceKey=[REDACTED]",
		);

		const reorderedEcho =
			"received serviceKey=params-secret&serviceKey=url-secret&serviceKey=123456";
		const redacted = redactSensitiveText(reorderedEcho, serialized.sensitiveValues);
		expect(redacted).not.toContain("params-secret");
		expect(redacted).not.toContain("url-secret");
		expect(redacted).not.toContain("123456");
		expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(3);
	});

	it("keeps params-only serialization identical when sensitiveParams is omitted or empty", () => {
		const url = "https://EXAMPLE.com:443/items?q=a%20b&tilde=~";
		const params = { page: 1 };
		const base = serializeRequestUrl(url, params);
		const empty = serializeRequestUrl(url, params, {});
		expect(empty).toEqual(base);
		expect(base.requestUrl).toBe("https://example.com/items?q=a+b&tilde=%7E&page=1");
	});

	it("structurally redacts sensitive params after URL normalization", () => {
		const serialized = serializeRequestUrl("https://example.com/items?q=a%20b&tilde=~", undefined, {
			pin: "1",
		});
		expect(serialized.requestUrl).toBe("https://example.com/items?q=a+b&tilde=%7E&pin=1");
		expect(serialized.redactedUrl).toBe("https://example.com/items?q=a+b&tilde=%7E&pin=[REDACTED]");
	});

	it("redacts overlapping credentials longest-first and compares percent escapes case-insensitively", () => {
		const longSecret = "sk-live-abc";
		const encodedSecret = "space +/%=";
		const mixedCasePercentEncoded = encodeURIComponent(encodedSecret).replace("%2F", "%2f");
		const lowercaseFormEncoded = new URLSearchParams({ value: encodedSecret })
			.toString()
			.slice("value=".length)
			.replace(/%[\dA-F]{2}/g, (percentEscape) => percentEscape.toLowerCase());

		const redacted = redactSensitiveText(
			`${longSecret} ${mixedCasePercentEncoded} ${lowercaseFormEncoded}`,
			["sk-l", longSecret, encodedSecret],
		);
		expect(redacted).toBe(
			`${REDACTED_QUERY_VALUE} ${REDACTED_QUERY_VALUE} ${REDACTED_QUERY_VALUE}`,
		);
		expect(redacted).not.toContain("ive-abc");
	});

	it("redacts delimited low-entropy values without corrupting larger tokens", () => {
		const unrelated = "rapid api response a%20value at 2026-01-01";
		expect(redactSensitiveText(unrelated, ["api", "a "])).toBe(
			"rapid [REDACTED] response a%20value at 2026-01-01",
		);
		expect(redactSensitiveText("rapid response", ["api"])).toBe("rapid response");
		expect(redactSensitiveText("prefixapisuffix", ["api"])).toBe("prefixapisuffix");

		const requestUrl = "https://example.com/items?pin=1";
		const redactedUrl = "https://example.com/items?pin=[REDACTED]";
		expect(redactSensitiveText(`failed ${requestUrl}`, ["1"], requestUrl, redactedUrl)).toBe(
			`failed ${redactedUrl}`,
		);
	});

	it("redacts long credentials as unconditional raw and encoded substrings", () => {
		const secret = "long-test-secret";
		const encoded = encodeURIComponent(secret);
		expect(redactSensitiveText(`prefix${secret}suffix prefix${encoded}suffix`, [secret])).toBe(
			"prefix[REDACTED]suffix prefix[REDACTED]suffix",
		);
	});

	it("scrubs structured error fields, exact numeric echoes, and cause cycles", () => {
		const secret = "structured-secret";
		const requestUrl = `https://example.com/items?serviceKey=${secret}`;
		const redactedUrl = "https://example.com/items?serviceKey=[REDACTED]";
		const first = Object.assign(new Error(`first failed at ${requestUrl}`), {
			url: requestUrl,
			request: { url: requestUrl },
		});
		const second = Object.assign(new Error(`second leaked ${secret}`), {
			details: { received: 123456 },
		});
		const aggregate = new AggregateError([first, second], `both failed for ${secret}`);
		first.cause = aggregate;
		const outer = new TransportError("Network error", {
			code: "transport_network_error",
			status: 0,
			cause: aggregate,
			details: { url: requestUrl, received: 123456 },
		});

		const redacted = redactSensitiveError(outer, [secret, "123456"], requestUrl, redactedUrl);
		expect(redacted).toBe(outer);
		expect(redacted.details).toEqual({ url: redactedUrl, received: REDACTED_QUERY_VALUE });
		expect(aggregate.message).not.toContain(secret);
		expect(first.message).toContain(REDACTED_QUERY_VALUE);
		expect(first.url).toBe(redactedUrl);
		expect(first.request.url).toBe(redactedUrl);
		expect(first.cause).toBe(aggregate);
		expect(second.message).not.toContain(secret);
		expect(String(second.details.received)).toBe(REDACTED_QUERY_VALUE);
	});

	it("clones before traversing readonly cycles and scrubs custom non-enumerable fields", () => {
		const secret = "readonly-cycle-secret";
		const diagnostic: { self?: unknown; endpoint?: string } = {};
		diagnostic.self = diagnostic;
		Object.defineProperty(diagnostic, "endpoint", {
			value: `https://example.com/?key=${secret}`,
			enumerable: false,
			writable: false,
		});

		const redacted = redactSensitiveError(diagnostic, [secret]);
		expect(redacted).not.toBe(diagnostic);
		expect(redacted.self).toBe(redacted);
		expect(redacted.endpoint).toBe("https://example.com/?key=[REDACTED]");
	});

	it("scrubs secrets inside string classification fields while preserving normal error identity", () => {
		const secret = "classification-secret";
		const requestUrl = `https://example.com/next?serviceKey=${secret}`;
		const redactedUrl = "https://example.com/next?serviceKey=[REDACTED]";
		const error = Object.assign(new Error(`request failed for ${secret}`), {
			name: `Upstream ${secret} Error`,
			code: "UPSTREAM_ERROR",
			status: 500,
			upstreamStatus: 500,
		});
		const providerError = new ProviderError("redirect failed", {
			code: requestUrl,
			// @ts-expect-error test-invalid: preserves a legacy category value for redaction coverage
			category: "upstream",
			retryable: false,
		});
		const shortSecretError = Object.assign(new Error("short"), {
			code: "prefixapisuffix",
		});

		const redacted = redactSensitiveError(
			error,
			[secret, "500", "UPSTREAM_ERROR"],
			requestUrl,
			redactedUrl,
		);
		const redactedProviderError = redactSensitiveError(
			providerError,
			[secret, "false", "upstream"],
			requestUrl,
			redactedUrl,
		);
		redactSensitiveError(shortSecretError, ["api"]);
		expect(redacted.message).toBe("request failed for [REDACTED]");
		expect(redacted).toMatchObject({
			name: "Upstream [REDACTED] Error",
			code: REDACTED_QUERY_VALUE,
			status: 500,
			upstreamStatus: 500,
		});
		expect(redactedProviderError).toBe(providerError);
		expect(providerError.code).toBe(redactedUrl);
		expect(providerError.options).toMatchObject({
			category: REDACTED_QUERY_VALUE,
			retryable: false,
		});
		expect(shortSecretError.code).toBe("prefix[REDACTED]suffix");

		const sessionExpired = new SessionExpiredError();
		redactSensitiveError(sessionExpired, [secret]);
		expect(sessionExpired).toMatchObject({ name: "SessionExpiredError", code: "reauth_required" });
		expect(sessionExpired.options).toMatchObject({
			category: "credential_expired",
			retryable: false,
		});
	});

	it("redacts untrusted nested name and code metadata", () => {
		const secret = "nested-secret";
		const error = Object.assign(new Error("outer"), {
			code: "transport_network_error",
			cause: { name: `failure-${secret}`, code: secret },
		});
		const redacted = redactSensitiveError(error, [secret]);
		expect(redacted.code).toBe("transport_network_error");
		expect(redacted.cause).toEqual({
			name: "failure-[REDACTED]",
			code: REDACTED_QUERY_VALUE,
		});
	});

	it("scrubs credentials inside semantic-shaped ProviderError codes", () => {
		const secret = "sk_live_abc123";
		const secretError = new ProviderError("upstream failed", {
			code: `failure_${secret}`,
			details: { code: secret },
		});
		const cleanError = new ProviderError("upstream failed", { code: "UPSTREAM_ERROR" });

		redactSensitiveError(secretError, [secret]);
		redactSensitiveError(cleanError, [secret]);

		expect(secretError.code).toBe(`failure_${REDACTED_QUERY_VALUE}`);
		expect(secretError.details).toEqual({ code: REDACTED_QUERY_VALUE });
		expect(cleanError.code).toBe("UPSTREAM_ERROR");
	});

	it("scrubs declared credentials before preserving clean SDK semantic error codes", () => {
		const cookieError = new StealthCookieStoreVersionError("unsupported");
		const secretError = new ProviderSecretError("missing provider secret");
		const cleanCookieError = new StealthCookieStoreVersionError("other-version");
		const cleanSecretError = new ProviderSecretError("missing provider secret");

		redactSensitiveError(cookieError, ["unsupported"]);
		redactSensitiveError(secretError, ["provider"]);
		redactSensitiveError(cleanCookieError, ["declared-secret"]);
		redactSensitiveError(cleanSecretError, ["declared-secret"]);

		expect(cookieError.code).toBe(`${REDACTED_QUERY_VALUE}_stealth_cookie_store_version`);
		expect(secretError.code).toBe(`${REDACTED_QUERY_VALUE}_secret_error`);
		expect(cleanCookieError.code).toBe("unsupported_stealth_cookie_store_version");
		expect(cleanSecretError.code).toBe("provider_secret_error");
	});

	it("scrubs built-in diagnostic containers, symbol values, and serializers", () => {
		const secret = "built-in-secret";
		const requestUrl = `https://example.com/items?token=${secret}`;
		const diagnosticSymbol = Symbol("diagnostic");
		const request = new Request(requestUrl, {
			headers: { "x-diagnostic": `credential ${secret}` },
		});
		const response = Response.redirect(requestUrl);
		const map = new Map<unknown, unknown>([["request", request]]);
		const serializer = {
			toJSON: () => ({ url: requestUrl }),
		};
		const diagnostic = {
			request,
			response,
			headers: request.headers,
			map,
			serializer,
			[diagnosticSymbol]: requestUrl,
		};

		const redacted = redactSensitiveError(diagnostic, [secret]);

		expect(redacted.request.url).toBe("https://example.com/items?token=[REDACTED]");
		expect(redacted.request.headers.get("x-diagnostic")).toBe("credential [REDACTED]");
		expect(redacted.response.headers.get("location")).toBe(
			"https://example.com/items?token=[REDACTED]",
		);
		expect(redacted.headers.get("x-diagnostic")).toBe("credential [REDACTED]");
		expect((redacted.map.get("request") as Request).url).not.toContain(secret);
		expect(redacted[diagnosticSymbol]).not.toContain(secret);
		expect(JSON.stringify(redacted.serializer)).not.toContain(secret);
	});

	it("replaces readonly errors and frozen self-cycles without exposing the original graph", () => {
		const secret = "readonly-secret";
		const domError = new DOMException(`aborted for ${secret}`, "AbortError");
		const redactedDomError = redactSensitiveError(domError, [secret]);
		expect(redactedDomError).not.toBe(domError);
		expect(redactedDomError).toBeInstanceOf(DOMException);
		expect(() => redactedDomError.code).not.toThrow();
		expect(redactedDomError.name).toBe("AbortError");
		expect(redactedDomError.message).toBe(`aborted for ${REDACTED_QUERY_VALUE}`);

		type FrozenCycle = { self: FrozenCycle; url: string };
		const cycle = {} as FrozenCycle;
		cycle.self = cycle;
		cycle.url = `https://example.com/?serviceKey=${secret}`;
		Object.freeze(cycle);
		const redactedCycle = redactSensitiveError(cycle, [secret]);
		expect(redactedCycle).not.toBe(cycle);
		expect(redactedCycle.self).toBe(redactedCycle);
		expect(redactedCycle.url).toBe("https://example.com/?serviceKey=[REDACTED]");

		const frozenArray = Object.freeze(["safe", `value=${secret}`]);
		const redactedArray = redactSensitiveError(frozenArray, [secret]);
		expect(Array.isArray(redactedArray)).toBe(true);
		expect(redactedArray).toEqual(["safe", "value=[REDACTED]"]);
	});

	it("scrubs sensitive property names, URL internal data, and lone surrogates", () => {
		const secret = "key-secret";
		const diagnostic = {
			[secret]: true,
			"[REDACTED]": false,
			prefixapisuffix: "short-key",
			endpoint: new URL(`https://example.com/?serviceKey=${secret}`),
		};
		const redacted = redactSensitiveError(diagnostic, [secret, "api", "\ud800"]);
		expect(new Set(Object.keys(redacted))).toEqual(
			new Set(["[REDACTED]", "prefix[REDACTED]suffix", "endpoint", "[REDACTED]#2"]),
		);
		expect(String(redacted.endpoint)).toBe("https://example.com/?serviceKey=[REDACTED]");
		expect(() => redactSensitiveText("bad \ud800 diagnostic", ["\ud800"])).not.toThrow();
		expect(redactSensitiveText("bad \ud800 diagnostic", ["\ud800"])).toBe(
			"bad [REDACTED] diagnostic",
		);
	});

	it("redacts non-Error thrown values", () => {
		const secret = "non-error-secret";
		expect(redactSensitiveError(`failed with ${secret}`, [secret])).toBe(
			`failed with ${REDACTED_QUERY_VALUE}`,
		);
		expect(redactSensitiveError({ url: `https://example.com/?key=${secret}` }, [secret])).toEqual({
			url: "https://example.com/?key=[REDACTED]",
		});
	});
});
