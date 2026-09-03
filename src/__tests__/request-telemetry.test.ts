import { describe, expect, it, mock } from "bun:test";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";
import { ProxyTelemetryCollector } from "../runtime/proxy-telemetry.js";
import {
	RequestTelemetry,
	type TelemetryContributor,
} from "../runtime/request-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";

const decode = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
const fake = (key: TelemetryContributor<any, any>["key"], payload: unknown): TelemetryContributor<any, any> => ({
	key,
	toLogPayload: () => payload,
	toHeaderPayload: () => payload,
});

describe("request telemetry ledger", () => {
	it("keeps proxy log and header siblings byte-compatible", () => {
		const collector = new ProxyTelemetryCollector();
		collector.recordProxyResolution({
			provider: "smartproxy",
			cacheStatus: "allocator",
			cacheHit: false,
			resolutionMs: 4,
			attempts: 1,
		});
		const ledger = new RequestTelemetry(createTraceContext(), [collector]);
		const log = ledger.toLogPayload();
		const encoded = ledger.toHeaderValue();
		expect(log?.proxy).toEqual(collector.toLogPayload());
		expect(decode(encoded ?? "").proxy).toEqual(collector.toLogPayload());
	});

	it("omits an empty ledger and pins the additive envelope metadata", () => {
		const ledger = new RequestTelemetry(createTraceContext(), []);
		expect(ledger.toLogPayload()).toBeUndefined();
		expect(ledger.toHeaderValue()).toBeUndefined();

		const collector = new ProxyTelemetryCollector();
		collector.recordProxyResolution({ provider: "smartproxy", cacheStatus: "allocator", cacheHit: false, resolutionMs: 1, attempts: 1 });
		const envelope = decode(new RequestTelemetry(createTraceContext(), [collector]).toHeaderValue() ?? "");
		expect(envelope.v).toBe(1);
		expect(envelope.taxonomy).toBe(PROVIDER_OBSERVABILITY_TAXONOMY_VERSION);
	});

	it("drops oversized trailing siblings and marks truncation", () => {
		const collector = new ProxyTelemetryCollector();
		collector.recordProxyResolution({ provider: "smartproxy", cacheStatus: "allocator", cacheHit: false, resolutionMs: 1, attempts: 1 });
		const ledger = new RequestTelemetry(createTraceContext(), [
			collector,
			fake("stealth", { samples: Array.from({ length: 5000 }, (_, index) => index) }),
		]);
		const envelope = decode(ledger.toHeaderValue() ?? "");
		expect(envelope.proxy).toBeDefined();
		expect(envelope.stealth).toBeUndefined();
		expect(envelope.truncated).toBe(true);
	});

	it("drops a proxy-only envelope when it cannot fit", () => {
		const ledger = new RequestTelemetry(createTraceContext(), [
			fake("proxy", { samples: Array.from({ length: 5000 }, (_, index) => index) }),
		]);
		expect(ledger.toHeaderValue()).toBeUndefined();
	});

	it("drops lower-priority oversized siblings first and never emits events", () => {
		const ledger = new RequestTelemetry(createTraceContext(), [
			fake("proxy", { ok: true }),
			fake("resolver", { samples: Array.from({ length: 2800 }, (_, index) => index) }),
			fake("stealth", { samples: Array.from({ length: 2800 }, (_, index) => index) }),
			fake("events", { shouldNotAppear: true }),
		]);
		const envelope = decode(ledger.toHeaderValue() ?? "");
		expect(envelope.proxy).toBeDefined();
		expect(envelope.stealth).toBeUndefined();
		expect(envelope.events).toBeUndefined();
		expect(envelope.truncated).toBe(true);
	});

	it("drops an invalid free-text sibling with one process warning", () => {
		const warn = mock(() => {});
		const original = console.warn;
		console.warn = warn;
		try {
			const collector = new ProxyTelemetryCollector();
			collector.recordProxyResolution({ provider: "smartproxy", cacheStatus: "allocator", cacheHit: false, resolutionMs: 1, attempts: 1 });
			const contributor = fake("stealth", { message: "free text" });
			const ledger = new RequestTelemetry(createTraceContext(), [collector, contributor]);
			const envelope = decode(ledger.toHeaderValue() ?? "");
			expect(envelope.proxy).toBeDefined();
			expect(envelope.stealth).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
			ledger.toHeaderValue();
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			console.warn = original;
		}
	});
});
