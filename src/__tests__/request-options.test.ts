import { describe, expect, it } from "bun:test";
import { TransportError } from "../errors.js";
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
		expect(second.details.received).toBe(REDACTED_QUERY_VALUE);
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

	it("preserves error classification fields that equal a sensitive value", () => {
		const error = Object.assign(new Error("request timeout for timeout"), {
			code: "timeout",
			status: 500,
			upstreamStatus: 500,
		});
		const redacted = redactSensitiveError(error, ["timeout", "500"]);
		expect(redacted.message).toBe("request [REDACTED] for [REDACTED]");
		expect(redacted).toMatchObject({ code: "timeout", status: 500, upstreamStatus: 500 });
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
