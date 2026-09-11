import { describe, expect, it } from "bun:test";
import { closedEnum, RequestTelemetry, type TelemetryKey } from "../runtime/request-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";

const fixture = <T extends object>(key: TelemetryKey, payload: T) => ({
	key,
	toLogPayload: () => payload,
	toHeaderPayload: () => payload,
});

const existing = {
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
};
const stealth = {
	attempts: 2,
	poolRefreshes: 1,
	redirectHops: 2,
	proxyUsed: true,
	safeRefetch: 1,
	ms: 120,
	attemptSamples: Array.from({ length: 24 }, () => ({
		n: 1,
		ms: 120,
		status: 200,
		e: closedEnum("upstream_http_error"),
		kind: closedEnum("request"),
	})),
};
const ocr = {
	backend: closedEnum("custom"),
	engine: closedEnum("custom"),
	ms: 100,
	status: 200,
	bytesIn: 10_000,
	bytesOut: 12_000,
	candidates: 4,
	warnings: 1,
	samples: Array.from({ length: 24 }, () => ({
		ms: 120,
		status: 200,
		bytesIn: 10_000,
		bytesOut: 12_000,
		candidates: 4,
		warnings: 1,
		errorCode: closedEnum("OCR_UPSTREAM_FAILED"),
		finishReason: closedEnum("content_filter"),
	})),
};
const stt = {
	backend: closedEnum("custom"),
	engine: closedEnum("custom"),
	ms: 100,
	status: 200,
	audioBytes: 10_000,
	durationMs: 120,
	usage: 120,
	warnings: 1,
	samples: Array.from({ length: 24 }, () => ({
		ms: 120,
		status: 200,
		audioBytes: 10_000,
		durationMs: 120,
		usage: 120,
		warnings: 1,
	})),
};

function encodeFixture(include: { stealth: boolean; ocr: boolean; stt: boolean }) {
	const ledger = new RequestTelemetry(createTraceContext());
	ledger.register(fixture("proxy", existing.proxy));
	ledger.register(fixture("resolver", existing.resolver));
	ledger.register(fixture("native", existing.native));
	ledger.register(fixture("http", existing.http));
	if (include.stealth) ledger.register(fixture("stealth", stealth));
	if (include.ocr) ledger.register(fixture("ocr", ocr));
	if (include.stt) ledger.register(fixture("stt", stt));
	const encoded = ledger.toHeaderValue()!;
	return {
		encoded,
		header: JSON.parse(Buffer.from(encoded, "base64url").toString()) as Record<string, unknown>,
	};
}

function expectLengthWithinFivePercent(actual: number, measured: number) {
	expect(actual).toBeGreaterThanOrEqual(Math.floor(measured * 0.95));
	expect(actual).toBeLessThanOrEqual(Math.ceil(measured * 1.05));
}

describe("OCR/STT telemetry header budget with realistic existing siblings", () => {
	it("drops stt, then ocr, before stealth while core siblings survive", () => {
		const all = encodeFixture({ stealth: true, ocr: true, stt: true });
		expect(Object.keys(all.header)).toEqual([
			"v",
			"taxonomy",
			"proxy",
			"resolver",
			"native",
			"http",
			"stealth",
			"truncated",
		]);
		expectLengthWithinFivePercent(all.encoded.length, 2_944);

		const afterStt = encodeFixture({ stealth: true, ocr: true, stt: false });
		expect(afterStt.header).not.toHaveProperty("ocr");
		expect(afterStt.header).toHaveProperty("stealth");
		expect(afterStt.header).toHaveProperty("truncated", true);
		expectLengthWithinFivePercent(afterStt.encoded.length, 2_944);

		const afterOcr = encodeFixture({ stealth: true, ocr: false, stt: false });
		expect(afterOcr.header).toHaveProperty("stealth");
		expect(afterOcr.header).not.toHaveProperty("truncated");
		expectLengthWithinFivePercent(afterOcr.encoded.length, 2_922);

		const afterStealth = encodeFixture({ stealth: false, ocr: false, stt: false });
		for (const key of ["v", "taxonomy", "proxy", "resolver", "native", "http"])
			expect(afterStealth.header).toHaveProperty(key);
	});

	it("automatically removes stt, then ocr, then stealth as core pressure rises", () => {
		const compactStealth = { ...stealth, attemptSamples: stealth.attemptSamples.slice(0, 12) };
		const compactOcr = { ...ocr, samples: ocr.samples.slice(0, 4) };
		const compactStt = { ...stt, samples: stt.samples.slice(0, 4) };
		const pressured = (pressureSamples: number) => {
			const ledger = new RequestTelemetry(createTraceContext());
			ledger.register(fixture("proxy", existing.proxy));
			ledger.register(fixture("resolver", existing.resolver));
			ledger.register(fixture("native", existing.native));
			ledger.register(
				fixture("http", {
					...existing.http,
					samples: Array.from({ length: pressureSamples }, () => ({
						ms: 120,
						status: 200,
						bytesIn: 10_000,
						bytesOut: 12_000,
						errorCode: closedEnum("upstream_http_error"),
					})),
				}),
			);
			ledger.register(fixture("stealth", compactStealth));
			ledger.register(fixture("ocr", compactOcr));
			ledger.register(fixture("stt", compactStt));
			return JSON.parse(Buffer.from(ledger.toHeaderValue()!, "base64url").toString()) as Record<
				string,
				unknown
			>;
		};

		const sttStage = pressured(8);
		expect(sttStage).not.toHaveProperty("stt");
		expect(sttStage).toHaveProperty("ocr");
		expect(sttStage).toHaveProperty("stealth");

		const ocrStage = pressured(12);
		expect(ocrStage).not.toHaveProperty("ocr");
		expect(ocrStage).toHaveProperty("stealth");

		const stealthStage = pressured(24);
		expect(stealthStage).not.toHaveProperty("ocr");
		expect(stealthStage).not.toHaveProperty("stealth");
		for (const key of ["v", "taxonomy", "proxy", "resolver", "native", "http"])
			expect(stealthStage).toHaveProperty(key);
	});

	it("drops all eight siblings in HEADER_PRIORITY order under increasing pressure", () => {
		const keys = ["proxy", "resolver", "native", "http", "stealth", "browser", "ocr", "stt"] as const;
		const baseSamples = [2, 2, 2, 2, 4, 6, 8, 10] as const;
		const encodeEight = (proxyPressure: number) => {
			const ledger = new RequestTelemetry(createTraceContext());
			keys.forEach((key, index) => {
				const samples = baseSamples[index] + (key === "proxy" ? proxyPressure : 0);
				const payload = {
					samples: Array.from({ length: samples }, () => closedEnum("x".repeat(63))),
				};
				ledger.register(fixture(key, payload));
			});
			const encoded = ledger.toHeaderValue();
			return {
				encoded,
				size: encoded?.length,
				keys: encoded
					? (Object.keys(JSON.parse(Buffer.from(encoded, "base64url").toString())).filter((key) =>
						keys.includes(key as (typeof keys)[number]),
					) as string[])
					: [],
			};
		};

		const stages = [
			[0, 3448, keys],
			[8, 3268, ["proxy", "resolver", "native", "http", "stealth", "browser", "ocr"]],
			[18, 3418, ["proxy", "resolver", "native", "http", "stealth", "browser"]],
			[26, 3562, ["proxy", "resolver", "native", "http", "stealth"]],
			[33, 3794, ["proxy", "resolver", "native", "http"]],
			[37, 3942, ["proxy", "resolver", "native"]],
			[39, 3911, ["proxy", "resolver"]],
			[42, 3966, ["proxy"]],
		] as const;
		for (const [pressure, size, expectedKeys] of stages) {
			const result = encodeEight(pressure);
			expect(result.size).toBe(size);
			expect(result.keys).toEqual([...expectedKeys]);
		}
		expect(encodeEight(44).encoded).toBeUndefined();
	});
});
