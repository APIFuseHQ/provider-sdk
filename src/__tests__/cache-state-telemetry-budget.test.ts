import { describe, expect, it, spyOn } from "bun:test";
import { BrowserTelemetryCollector } from "../runtime/browser-telemetry.js";
import type { CacheTelemetryLogPayload } from "../runtime/cache-telemetry.js";
import { HttpTelemetryCollector } from "../runtime/http-telemetry.js";
import { NativeTelemetryCollector } from "../runtime/native-telemetry.js";
import { OcrTelemetryCollector } from "../runtime/ocr-telemetry.js";
import { ProxyTelemetryCollector } from "../runtime/proxy-telemetry.js";
import {
	closedEnum,
	RequestTelemetry,
	type TelemetryContributor,
	type TelemetryKey,
} from "../runtime/request-telemetry.js";
import { ResolverTelemetryCollector } from "../runtime/resolver-telemetry.js";
import type { StateTelemetryLogPayload } from "../runtime/state-telemetry.js";
import { StealthTelemetryCollector } from "../runtime/stealth-telemetry.js";
import { SttTelemetryCollector } from "../runtime/stt-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";

const fixture = <T extends object>(
	key: TelemetryKey,
	payload: T,
	headerPayload: object = payload,
): TelemetryContributor<never, never> => {
	const contributor = { key, toLogPayload: () => payload, toHeaderPayload: () => headerPayload };
	// test-invalid: heterogeneous fixture contributor for budget pressure.
	return contributor as never;
};
const siblings = {
	proxy: { attempts: 2, resolutionMs: 120 },
	resolver: { attempts: 2, solveMs: 120, challengeKind: closedEnum("turnstile") },
	native: { attempts: 2, connectMs: 120, tunnelMs: 80, bytesIn: 100, bytesOut: 100 },
	http: {
		attempts: 2,
		retries: 1,
		timeouts: 0,
		proxyUsed: true,
		transport: closedEnum("native"),
		ms: 120,
	},
	stealth: {
		attempts: 24,
		poolRefreshes: 1,
		redirectHops: 2,
		proxyUsed: true,
		safeRefetch: 1,
		ms: 3240,
		attemptSamples: Array.from({ length: 24 }, (_, index) => ({
			n: index + 1,
			ms: 20 + index * 13,
			status: index % 3 === 0 ? 503 : 200,
			e: closedEnum(index % 3 === 0 ? "upstream_http_error" : "ok"),
			kind: closedEnum("request"),
		})),
	},
};
const ocr = {
	backend: closedEnum("custom"),
	engine: closedEnum("custom"),
	ms: 2400,
	status: 200,
	bytesIn: 240000,
	bytesOut: 288000,
	candidates: 48,
	warnings: 8,
	samples: Array.from({ length: 24 }, (_, index) => ({
		ms: 30 + index * 7,
		status: index % 4 === 0 ? 502 : 200,
		bytesIn: 9000 + index * 173,
		bytesOut: 11000 + index * 127,
		candidates: (index % 4) + 1,
		warnings: index % 3 === 0 ? 1 : 0,
		errorCode: closedEnum(index % 4 === 0 ? "OCR_UPSTREAM_FAILED" : "ok"),
		finishReason: closedEnum(index % 4 === 0 ? "content_filter" : "stop"),
	})),
};
const stt = {
	backend: closedEnum("custom"),
	engine: closedEnum("custom"),
	ms: 2400,
	status: 200,
	audioBytes: 240000,
	durationMs: 2880,
	usage: 2880,
	warnings: 6,
	samples: Array.from({ length: 24 }, (_, index) => ({
		ms: 35 + index * 11,
		status: index % 4 === 0 ? 502 : 200,
		audioBytes: 9000 + index * 239,
		durationMs: 120 + index * 17,
		usage: 110 + index * 19,
		warnings: index % 4 === 0 ? 1 : 0,
		errorCode: closedEnum(index % 4 === 0 ? "STT_UPSTREAM_FAILED" : "ok"),
	})),
};
const cache = {
	lookups: 24,
	hits: 16,
	stale: 4,
	misses: 8,
	writes: 8,
	loaderErrors: 1,
	writeErrors: 1,
	source: { memory: 8, redis: 8, loader: 8 },
	redisFallbacks: 2,
	redisMode: closedEnum("degraded"),
	redisRoundTrips: 2,
	ageMs: { p50: 187, max: 391 },
	samples: Array.from({ length: 24 }, (_, index) => ({
		key: `catalog:item-${index}:locale-${index % 3}`,
		hit: index % 3 !== 2,
		stale: index % 6 === 0,
		ageMs: index * 17,
		source: (["memory", "redis", "loader"] as const)[index % 3]!,
	})),
	dropped: 0,
} satisfies CacheTelemetryLogPayload;
const state = {
	ops: { list: 4, get: 4, set: 4, patch: 3, delete: 3, cas: 3, increment: 3 },
	casConflicts: 1,
	violations: { quota: 1, ttl: 1, size: 0, unsupported: 0, error: 0 },
	backend: closedEnum("redis"),
	redisFallbacks: 0,
	redisMode: closedEnum("degraded"),
	redisRoundTrips: 30,
	ms: 852,
	samples: Array.from({ length: 24 }, (_, index) => ({
		key: `session:${index}:checkpoint-${index % 5}`,
		op: (["list", "get", "set", "patch", "delete", "cas", "increment"] as const)[index % 7]!,
		ms: 1 + index * 3,
		backend: index % 3 === 0 ? "memory" : "redis",
	})),
	dropped: 0,
} satisfies StateTelemetryLogPayload;
const { samples: _cacheSamples, ageMs, ...cacheCounters } = cache;
const cacheHeader = { ...cacheCounters, ageP50: ageMs.p50, ageMax: ageMs.max };
const { samples: _stateSamples, ...stateHeader } = state;

type EncodingStage = { encoded: string; header: Record<string, unknown> };
const dropOrder = ["state", "cache", "stt", "ocr", "stealth"] as const;
const coreKeys = ["v", "taxonomy", "proxy", "resolver", "native", "http"] as const;

function encode(sampleCount = 24, pressure = 0) {
	const ledger = new RequestTelemetry(createTraceContext());
	for (const key of ["proxy", "resolver", "native"] as const) {
		ledger.register(fixture(key, siblings[key]));
	}
	ledger.register(
		fixture("http", {
			...siblings.http,
			...(pressure > 0
				? {
						samples: Array.from({ length: pressure }, (_, index) => ({
							n: index + 1,
							ms: 31 + index * 7,
							status: index % 3 === 0 ? 503 : 200,
							bytesIn: 10000 + index * 113,
							bytesOut: 12000 + index * 137,
						})),
					}
				: {}),
		}),
	);
	ledger.register(
		fixture("stealth", {
			...siblings.stealth,
			attemptSamples: siblings.stealth.attemptSamples.slice(0, sampleCount),
		}),
	);
	ledger.register(fixture("ocr", { ...ocr, samples: ocr.samples.slice(0, sampleCount) }));
	ledger.register(fixture("stt", { ...stt, samples: stt.samples.slice(0, sampleCount) }));
	ledger.register(fixture("cache", cache, cacheHeader));
	ledger.register(fixture("state", state, stateHeader));
	return observeEncoding(ledger);
}

function observeEncoding(ledger: RequestTelemetry) {
	// Observe the real encoder's base64url results, including over-budget candidates.
	// This synchronous spy is restored before returning; the encoder remains unchanged.
	const stages: EncodingStage[] = [];
	const originalToString = Buffer.prototype.toString;
	const encodedSpy = spyOn(Buffer.prototype, "toString").mockImplementation(function (
		this: Buffer,
		encoding?: BufferEncoding,
		start?: number,
		end?: number,
	) {
		const encoded = originalToString.call(this, encoding, start, end);
		if (encoding === "base64url") {
			const header: Record<string, unknown> = JSON.parse(originalToString.call(this, "utf8"));
			stages.push({ encoded, header });
		}
		return encoded;
	});
	let encoded: string | undefined;
	try {
		encoded = ledger.toHeaderValue();
	} finally {
		encodedSpy.mockRestore();
	}
	if (encoded === undefined) throw new Error("Fixture dropped every telemetry sibling");
	const header: Record<string, unknown> = JSON.parse(Buffer.from(encoded, "base64url").toString());
	return { encoded, header, stages, log: ledger.toLogPayload()! };
}

function expectSize(actual: number, measured: number) {
	expect(actual).toBeGreaterThanOrEqual(Math.floor(measured * 0.95));
	expect(actual).toBeLessThanOrEqual(Math.ceil(measured * 1.05));
}

describe("cache/state header budget", () => {
	it("drops all ten realistic siblings in priority order while retaining version, taxonomy and proxy", () => {
		const ledger = new RequestTelemetry(createTraceContext());
		const resolver = new ResolverTelemetryCollector();
		resolver.recordIdentity({ source: "declared" });
		resolver.recordCacheRead({ status: "miss", challengeKind: "turnstile" });
		// The real collector caps this pressure at 24 samples and 64 chain entries.
		// Alternating supported vendors models a resolver retry/failover chain.
		for (let index = 0; index < 64; index += 1) {
			const vendor = index % 2 === 0 ? "capsolver" : "capmonster";
			resolver.recordVendorAttempt({
				vendor,
				phase: "poll_result",
				outcome: "error",
				ms: 12000 + index * 137,
				pollCount: 3,
				vendorErrorCode: "ERROR_CAPTCHA_UNSOLVABLE",
			});
			if (index < 63) {
				resolver.recordFailover({
					from: vendor,
					to: index % 2 === 0 ? "capmonster" : "capsolver",
					reason: "allocation_exhausted",
				});
			}
		}
		resolver.recordOutcome({ outcome: "exhausted", solveMs: 1044192, challengeKind: "turnstile" });
		const proxy = new ProxyTelemetryCollector();
		proxy.recordProxyResolution({
			provider: "smartproxy",
			cacheStatus: "memory_hit",
			cacheHit: true,
			resolutionMs: 120,
			attempts: 2,
		});
		const native = new NativeTelemetryCollector();
		native.recordConnect({ kind: "tls", outcome: "ok", ms: 120, tunnelMs: 80, proxyUsed: true });
		native.recordBytes({ direction: "in", bytes: 100 });
		native.recordBytes({ direction: "out", bytes: 100 });
		const http = new HttpTelemetryCollector();
		const request = http.startRequest({});
		request.recordAttempt({
			ms: 40,
			proxyUsed: true,
			status: 503,
			statusRetry: true,
			e: "upstream_http_error",
		});
		request.recordAttempt({ ms: 60, proxyUsed: true, status: 200 });
		request.finish(120);
		const stealth = new StealthTelemetryCollector();
		const ocrCollector = new OcrTelemetryCollector();
		const sttCollector = new SttTelemetryCollector();
		for (let index = 0; index < 24; index += 1) {
			stealth.recordAttempt({
				ms: 20 + index * 13,
				status: index % 3 === 0 ? 503 : 200,
				...(index % 3 === 0 ? { errorCode: "upstream_http_error" as const } : {}),
				profileId: { browser: "chrome", os: "linux" },
				proxyUsed: true,
				requestClass: "navigation",
			});
			ocrCollector.record({
				...ocr.samples[index]!,
				backend: "custom",
				engine: "custom",
				errorCode: index % 4 === 0 ? "OCR_UPSTREAM_FAILED" : undefined,
			});
			sttCollector.record({
				...stt.samples[index]!,
				backend: "custom",
				engine: "custom",
				errorCode: index % 4 === 0 ? "STT_UPSTREAM_FAILED" : undefined,
			});
		}
		const browser = new BrowserTelemetryCollector();
		const browserLog = {
			allocateMs: 148,
			pages: 3,
			navigations: 3,
			actions: 9,
			evaluate: 3,
			content: 3,
			screenshot: 3,
			poolAcquireAttempts: 3,
			poolAcquireFailures: 0,
			proxyAuthChallenges: 3,
			engine: "playwright-stealth" as const,
			samples: Array.from({ length: 24 }, (_, index) => ({
				name: (
					[
						"browser.newPage",
						"browser.page.goto",
						"browser.page.fill",
						"browser.page.click",
						"browser.page.waitForSelector",
						"browser.evaluate",
						"browser.content",
						"browser.screenshot",
					] as const
				)[index % 8]!,
				ms: 30 + index * 11,
				status: "ok" as const,
			})),
			dropped: 0,
		};
		ledger.register(proxy);
		ledger.register(resolver);
		ledger.register(native);
		ledger.register(http);
		ledger.register(stealth);
		ledger.register(fixture("browser", browserLog, browser.toHeaderPayload(browserLog)));
		ledger.register(ocrCollector);
		ledger.register(sttCollector);
		ledger.register(fixture("cache", cache, cacheHeader));
		ledger.register(fixture("state", state, stateHeader));
		const all = observeEncoding(ledger);
		const removed = all.stages
			.slice(1)
			.map((stage, index) =>
				Object.keys(all.stages[index]!.header).filter((key) => !(key in stage.header)),
			);
		console.log(
			"BUDGET_TEN_ENCODER_STAGES=" +
				JSON.stringify(
					all.stages.map((stage, index) => ({
						removed: index ? removed[index - 1]![0] : null,
						bytes: stage.encoded.length,
					})),
				),
		);
		expect(Object.keys(all.stages[0]!.header)).toEqual([
			"v",
			"taxonomy",
			"proxy",
			"resolver",
			"native",
			"http",
			"stealth",
			"browser",
			"ocr",
			"stt",
			"cache",
			"state",
		]);
		expect(removed, "ten-sibling priority-swap negative").toEqual(
			["state", "cache", "stt", "ocr", "browser", "stealth", "http", "native", "resolver"].map(
				(key) => [key],
			),
		);
		for (const [index, stage] of all.stages.entries()) {
			expectSize(
				stage.encoded.length,
				[16639, 16298, 15976, 12807, 8831, 6834, 5300, 4851, 4439, 234][index]!,
			);
			for (const key of ["v", "taxonomy", "proxy"] as const) {
				expect(stage.header[key]).toEqual(all.stages[0]!.header[key]);
			}
		}
		for (const stage of all.stages.slice(0, -1)) expect(stage.encoded.length).toBeGreaterThan(4096);
		expect(all.encoded.length).toBeLessThanOrEqual(4096);
		expect(Object.keys(all.header)).toEqual(["v", "taxonomy", "proxy", "truncated"]);
		expect(all.header.truncated).toBe(true);
		expect(all.header.proxy).toEqual(all.stages[0]!.header.proxy);
		expect(all.log).toHaveProperty("resolver.attemptSamples.length", 24);
		expect(all.log).toHaveProperty("resolver.vendorChain.length", 64);
		expect(all.log).toHaveProperty("resolver.attemptSamplesDropped", 40);
		for (const key of ["cache", "state"] as const)
			expect(all.log).toHaveProperty(`${key}.samples.length`, 24);
	});

	it("measures actual encoder candidates and drops state, cache, stt, ocr in order", () => {
		const all = encode();
		const removed = all.stages
			.slice(1)
			.map((stage, index) =>
				Object.keys(all.stages[index]!.header).filter((key) => !(key in stage.header)),
			);
		expect(removed, "encoder sibling removal order (cache/state priority-swap negative)").toEqual(
			dropOrder.slice(0, 4).map((key) => [key]),
		);
		console.log(
			"BUDGET_ENCODER_STAGES=" +
				JSON.stringify(
					all.stages.map((stage, index) => ({
						removed: index ? removed[index - 1]![0] : null,
						bytes: stage.encoded.length,
					})),
				),
		);
		for (const [index, stage] of all.stages.slice(1).entries()) {
			expectSize(stage.encoded.length, [10848, 10527, 6950, 2595][index]!);
		}
		expect(all.encoded.length).toBeLessThanOrEqual(4096);
		expect(all.header).toHaveProperty("truncated", true);
		for (const key of coreKeys) expect(all.header).toHaveProperty(key);
		expect(all.header).toHaveProperty("stealth");
		expect(all.log.cache).toHaveProperty("samples", cache.samples);
		expect(all.log.state).toHaveProperty("samples", state.samples);
	});

	it("rising HTTP pressure removes state, cache, stt, ocr, then stealth and preserves core siblings", () => {
		const removed: string[] = [];
		const pressureStages: { pressure: number; removed: string; bytes: number }[] = [];
		let previous = encode(3).header;
		for (const key of dropOrder) expect(previous).toHaveProperty(key);
		for (let pressure = 1; pressure <= 64 && removed.length < dropOrder.length; pressure += 1) {
			const current = encode(3, pressure);
			for (const key of coreKeys) expect(current.header).toHaveProperty(key);
			expect(current.encoded.length).toBeLessThanOrEqual(4096);
			const disappeared = dropOrder.filter((key) => key in previous && !(key in current.header));
			if (disappeared.length) {
				expect(disappeared, `HTTP pressure ${pressure}: one sibling must disappear`).toHaveLength(
					1,
				);
				removed.push(...disappeared);
				expect(current.header).toHaveProperty("truncated", true);
				pressureStages.push({ pressure, removed: disappeared[0]!, bytes: current.encoded.length });
			}
			previous = current.header;
		}
		expect(
			removed,
			"rising-pressure sibling removal order (cache/state priority-swap negative)",
		).toEqual([...dropOrder]);
		for (const [index, stage] of pressureStages.entries()) {
			expectSize(stage.bytes, [3776, 3796, 3523, 3404, 3766][index]!);
		}
		console.log("BUDGET_PRESSURE=" + JSON.stringify(pressureStages));
	});
});
