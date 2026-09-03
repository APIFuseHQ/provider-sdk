import { describe, expect, it, mock } from "bun:test";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";
import { ProxyTelemetryCollector } from "../runtime/proxy-telemetry.js";
import {
	closedEnum,
	isGatewayIngestible,
	RequestTelemetry,
	type ClosedEnum,
	type TelemetryContributor,
	type TelemetryKey,
} from "../runtime/request-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";

const BASE_SHA = "94f708a";
const BASE_PROXY_BYTES =
	'{"kind":"resolved","provider":"brightdata","userAgentSource":"request","protocol":"https","cacheStatus":"allocator","cacheHit":false,"resolutionMs":16,"allocatorMs":3,"allocatorStatus":201,"allocatorBodyClass":"json","allocatorAttempts":2,"lockWaitMs":1,"redisReadMs":2,"redisWriteMs":4,"poolAgeMs":5,"poolExpiresInMs":8,"attempts":3,"refreshes":1,"attemptSamples":[{"n":1,"a":2,"i":3,"h":"abcdef1234567890","o":"error","c":"E_FAIL","s":502,"d":9},{"n":2,"a":1,"o":"ok","c":"E_OTHER"},{"n":3,"a":1,"o":"ok","c":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}],"vendors":["smartproxy","brightdata"],"failovers":[{"v":"smartproxy","nx":"brightdata","p":"resolve","r":"timeout","a":2}]}';

function decode(value: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function castContributor(
	key: TelemetryKey,
	payload: object,
): TelemetryContributor<object, { ok: boolean }> {
	return {
		key,
		toLogPayload: () => payload,
		// test-invalid: exercise the runtime guard against a contributor that cast past it.
		toHeaderPayload: () => payload as never,
	};
}

function ledgerWith(
	...contributors: TelemetryContributor<object, { ok: boolean }>[]
): RequestTelemetry {
	const ledger = new RequestTelemetry(createTraceContext());
	for (const contributor of contributors) ledger.register(contributor);
	return ledger;
}

function recordedProxy(): ProxyTelemetryCollector {
	const collector = new ProxyTelemetryCollector();
	// test-invalid: reproduce the exact base-SHA oracle event, including legacy literals.
	collector.recordProxyResolution({
		provider: "smartproxy",
		cacheStatus: "allocator",
		cacheHit: false,
		resolutionMs: 1,
		attempts: 1,
	});
	return collector;
}

function oracleProxy(): ProxyTelemetryCollector {
	const collector = new ProxyTelemetryCollector();
	// test-invalid: reproduce the exact base-SHA oracle event, including legacy literals.
	collector.recordProxyResolution({
		provider: "smartproxy",
		cacheStatus: "allocator",
		cacheHit: false,
		resolutionMs: 12.9,
		allocatorMs: 3.8,
		allocatorStatus: 201,
		allocatorBodyClass: "json",
		allocatorAttempts: 2.9,
		lockWaitMs: 1.2,
		redisReadMs: 2.3,
		redisWriteMs: 4.4,
		poolAgeMs: 5.9,
		poolExpiresInMs: 8.1,
		attempts: 2.8,
		refreshes: 1.9,
		userAgentSource: "request",
		protocol: "http",
	} as never); // test-invalid: base-SHA oracle includes legacy literals.
	collector.recordProxyResolution({
		provider: "brightdata",
		cacheStatus: "redis_hit",
		cacheHit: true,
		resolutionMs: 4,
		attempts: 1,
		outcome: "ok",
		protocol: "https",
	} as never); // test-invalid: base-SHA oracle includes a legacy vendor.
	// test-invalid: reproduce the exact base-SHA oracle event, including its legacy vendor.
	collector.recordProxyAttempt({
		provider: "smartproxy",
		attempt: 2.9,
		poolIndex: 3.8,
		proxyHash: "abcdef1234567890ZZ",
		outcome: "error",
		errorCode: "E_FAIL",
		status: 502.8,
		durationMs: 9.7,
	});
	collector.recordProxyAttempt({
		provider: "brightdata",
		attempt: 1,
		outcome: "ok",
		errorCode: "E_OTHER",
	} as never); // test-invalid: base-SHA oracle includes a legacy vendor.
	collector.recordProxyAttempt({
		provider: "smartproxy",
		attempt: 1,
		outcome: "ok",
		errorCode: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	});
	// test-invalid: reproduce the exact base-SHA oracle failover literals.
	collector.recordProxyVendorFailover({
		vendor: "smartproxy",
		nextVendor: "brightdata",
		phase: "resolve",
		reason: "timeout",
		attempt: 2.2,
	} as never); // test-invalid: base-SHA oracle includes legacy failover literals.
	return collector;
}

function proxyArrayPayload(count: number, commonLength: number, finalLength: number): object {
	return {
		samples: Array.from({ length: count }, (_, index) =>
			closedEnum("x".repeat(index === count - 1 ? finalLength : commonLength)),
		),
	};
}

function largeValidPayload(prefix: string, count = 32): object {
	return {
		samples: Array.from({ length: count }, (_, index) =>
			closedEnum(`${prefix}${index.toString().padStart(2, "0")}${"x".repeat(58)}`),
		),
	};
}

describe("request telemetry ledger", () => {
	it(`matches the ${BASE_SHA} proxy log and header byte oracle`, () => {
		const collector = oracleProxy();
		const ledger = new RequestTelemetry(createTraceContext());
		ledger.register(collector);
		const log = ledger.toLogPayload();
		const encoded = ledger.toHeaderValue();
		expect(JSON.stringify(log?.proxy)).toBe(BASE_PROXY_BYTES);
		expect(JSON.stringify(decode(encoded ?? "").proxy)).toBe(BASE_PROXY_BYTES);
		expect(Object.keys(decode(encoded ?? ""))).toEqual(["v", "taxonomy", "proxy"]);
	});

	it("omits an empty ledger and pins the additive envelope metadata", () => {
		const empty = new RequestTelemetry(createTraceContext());
		expect(empty.toLogPayload()).toBeUndefined();
		expect(empty.toHeaderValue()).toBeUndefined();

		const ledger = new RequestTelemetry(createTraceContext());
		ledger.register(recordedProxy());
		const envelope = decode(ledger.toHeaderValue() ?? "");
		expect(envelope.v).toBe(1);
		expect(envelope.taxonomy).toBe(PROVIDER_OBSERVABILITY_TAXONOMY_VERSION);
	});

	it("keeps the exact 4096-byte boundary and drops the first representable overflow", () => {
		const exact = ledgerWith(castContributor("proxy", proxyArrayPayload(46, 63, 46)));
		expect(exact.toHeaderValue()).toHaveLength(4096);

		// Unpadded base64url lengths can never be 1 mod 4, so 4097 is not
		// representable; 4098 is the smallest encoded envelope above the budget.
		const overflow = ledgerWith(castContributor("proxy", proxyArrayPayload(46, 63, 47)));
		expect(overflow.toHeaderValue()).toBeUndefined();
	});

	it("drops a trailing sibling, marks truncation, and rejects flag overflow", () => {
		const collector = recordedProxy();
		const ledger = new RequestTelemetry(createTraceContext());
		ledger.register(collector);
		ledger.register(castContributor("stealth", largeValidPayload("s", 64)));
		const envelope = decode(ledger.toHeaderValue() ?? "");
		expect(envelope.proxy).toBeDefined();
		expect(envelope.stealth).toBeUndefined();
		expect(envelope.truncated).toBe(true);

		const flagOverflow = ledgerWith(
			castContributor("proxy", proxyArrayPayload(46, 63, 46)),
			castContributor("stealth", { ok: true }),
		);
		expect(flagOverflow.toHeaderValue()).toBeUndefined();
	});

	it("drops lower-priority siblings first and never emits events", () => {
		const ledger = new RequestTelemetry(createTraceContext());
		ledger.register(recordedProxy());
		ledger.register(castContributor("resolver", largeValidPayload("r")));
		ledger.register(castContributor("stealth", largeValidPayload("s")));
		ledger.register(castContributor("events", { ok: true }));
		const envelope = decode(ledger.toHeaderValue() ?? "");
		expect(envelope.proxy).toBeDefined();
		expect(envelope.resolver).toBeDefined();
		expect(envelope.stealth).toBeUndefined();
		expect(envelope.events).toBeUndefined();
		expect(envelope.truncated).toBe(true);
	});

	it.each([
		["BigInt", "stealth", { big: 1n }],
		[
			"cyclic object",
			"browser",
			(() => {
				const cyclic: Record<string, unknown> = {};
				cyclic.self = cyclic;
				return cyclic;
			})(),
		],
	] as const)("contains an independent %s contributor failure", (_name, key, invalid) => {
		const warn = mock(() => {});
		const original = console.warn;
		console.warn = warn;
		try {
			const ledger = new RequestTelemetry(createTraceContext());
			ledger.register(recordedProxy());
			ledger.register(castContributor(key, invalid));
			expect(ledger.toLogPayload()).toEqual({ proxy: recordedProxy().toLogPayload() });
			const envelope = decode(ledger.toHeaderValue() ?? "");
			expect(envelope.proxy).toBeDefined();
			expect(envelope[key]).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			console.warn = original;
		}
	});

	it("keeps proxy logs verbatim while omitting invalid open sample strings from the header", () => {
		const collector = recordedProxy();
		collector.recordProxyAttempt({
			provider: "smartproxy",
			attempt: 1,
			proxyHash: "bad hash",
			outcome: "error",
			errorCode: "vendor said hello",
		});
		const log = collector.toLogPayload();
		expect(log?.attemptSamples?.[0]).toMatchObject({
			h: "bad hash",
			c: "vendor said hello",
		});

		const warn = mock(() => {});
		const original = console.warn;
		console.warn = warn;
		try {
			const ledger = new RequestTelemetry(createTraceContext());
			ledger.register(collector);
			const envelope = decode(ledger.toHeaderValue() ?? "");
			const proxy = envelope.proxy as { attemptSamples?: Record<string, unknown>[] };
			expect(proxy).toBeDefined();
			expect(proxy.attemptSamples?.[0]).toEqual({ n: 1, a: 1, o: "error" });
			expect(warn).not.toHaveBeenCalled();
		} finally {
			console.warn = original;
		}
	});

	it("bounds retained proxy resolution history while aggregating 10,000 resolutions", () => {
		const collector = new ProxyTelemetryCollector();
		for (let index = 0; index < 10_000; index += 1) {
			collector.recordProxyResolution({
				provider: index % 2 === 0 ? "smartproxy" : "nodemaven",
				cacheStatus: "memory_hit",
				cacheHit: true,
				resolutionMs: 1,
				attempts: 1,
			});
		}
		expect(collector.resolutionEventCount).toBe(10_000);
		expect(collector.retainedResolutionEventCount).toBe(64);
		expect(collector.toLogPayload()).toEqual({
			kind: "resolved",
			provider: "nodemaven",
			cacheStatus: "memory_hit",
			cacheHit: true,
			resolutionMs: 10_000,
			attempts: 10_000,
			vendors: ["smartproxy", "nodemaven"],
		});
	});

	it("isolates a contributor whose log projection throws", () => {
		const throwing: TelemetryContributor<object, { ok: boolean }> = {
			key: "native",
			toLogPayload: () => {
				throw new Error("telemetry bug");
			},
			toHeaderPayload: () => ({ ok: true }),
		};
		const warn = mock(() => {});
		const original = console.warn;
		console.warn = warn;
		try {
			const ledger = new RequestTelemetry(createTraceContext());
			const collector = recordedProxy();
			ledger.register(collector);
			ledger.register(throwing);
			expect(ledger.toLogPayload()).toEqual({ proxy: collector.toLogPayload() });
			const envelope = decode(ledger.toHeaderValue() ?? "");
			expect(envelope.proxy).toBeDefined();
			expect(envelope.native).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			console.warn = original;
		}
	});

	it.each([
		["free prose", "http", { value: "vendor said hello" }],
		["65-character token", "browser", { value: "x".repeat(65) }],
		["200-element array", "ocr", { values: Array.from({ length: 200 }, () => 1) }],
		["depth-five object", "stt", { a: { b: { c: { d: { e: true } } } } }],
	] as const)("drops %s while preserving proxy", (_name, key, payload) => {
		const ledger = new RequestTelemetry(createTraceContext());
		ledger.register(recordedProxy());
		ledger.register(castContributor(key, payload));
		const envelope = decode(ledger.toHeaderValue() ?? "");
		expect(envelope.proxy).toBeDefined();
		expect(envelope[key]).toBeUndefined();
	});

	it("brands closed enums without observable module state", () => {
		expect(isGatewayIngestible({ value: "vendor said hello" })).toBe(false);
		expect(String(closedEnum("vendor said hello"))).toBe("vendor said hello");
		expect(isGatewayIngestible({ value: "vendor said hello" })).toBe(false);
		const branded: ClosedEnum<"x"> = closedEnum("x");
		expect(String(branded)).toBe("x");
	});
});
