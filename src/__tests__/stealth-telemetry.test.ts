import { describe, expect, it } from "bun:test";

import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";
import {
	closedEnum,
	type GatewayIngestible,
	RequestTelemetry,
} from "../runtime/request-telemetry.js";
import {
	StealthTelemetryCollector,
	type StealthTelemetryHeaderPayload,
} from "../runtime/stealth-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";

function recordAttempt(
	collector: StealthTelemetryCollector,
	overrides: Partial<Parameters<StealthTelemetryCollector["recordAttempt"]>[0]> = {},
): void {
	collector.recordAttempt({
		ms: 9.9,
		status: 200,
		profileId: { browser: "chrome", os: "macos" },
		proxyUsed: true,
		requestClass: "xhr",
		kind: "request",
		...overrides,
	});
}

function decode(value: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

describe("stealth telemetry collector", () => {
	it("omits an empty collector", () => {
		expect(new StealthTelemetryCollector().toLogPayload()).toBeUndefined();
	});

	it("aggregates attempts, redirect and challenge events incrementally", () => {
		const collector = new StealthTelemetryCollector();
		recordAttempt(collector, { status: 302, ms: 10.8, requestClass: "script_navigation" });
		collector.recordRedirectHop();
		collector.recordPoolRefresh();
		recordAttempt(collector, {
			status: 503,
			ms: 20.2,
			errorCode: "upstream_http_error",
			kind: "resolver",
		});
		collector.recordSbsd("detected");
		collector.recordSafeRefetch();
		collector.recordSbsd("refetch_clear");

		expect(collector.toLogPayload()).toEqual({
			attempts: 2,
			poolRefreshes: 1,
			redirectHops: 1,
			profileId: { browser: "chrome", os: "macos" },
			proxyUsed: true,
			requestClass: "xhr",
			sbsdDetected: true,
			sbsdOutcome: "refetch_clear",
			safeRefetch: 1,
			lastStatus: 503,
			ms: 30,
			attemptSamples: [
				{ n: 1, ms: 10, status: 302, kind: "request" },
				{
					n: 2,
					ms: 20,
					status: 503,
					e: "upstream_http_error",
					kind: "resolver",
				},
			],
		});
	});

	it("caps attempt samples at 24 while retaining all aggregates", () => {
		const collector = new StealthTelemetryCollector();
		for (let index = 0; index < 10_000; index += 1) {
			recordAttempt(collector, {
				ms: 1,
				status: 200 + (index % 2),
				proxyUsed: index % 2 === 0,
			});
		}
		const log = collector.toLogPayload();
		expect(log?.attempts).toBe(10_000);
		expect(log?.ms).toBe(10_000);
		expect(log?.lastStatus).toBe(201);
		expect(log?.proxyUsed).toBe(true);
		expect(log?.attemptSamples).toHaveLength(24);
		expect(log?.attemptSamplesDropped).toBe(9_976);
	});

	it("saturates non-finite, negative, and overflowing durations and counters", () => {
		const collector = new StealthTelemetryCollector();
		collector.recordAttempt({
			ms: Number.MAX_VALUE,
			profileId: { browser: "chrome", os: "macos" },
			proxyUsed: false,
			requestClass: "navigation",
		});
		collector.recordAttempt({
			ms: Number.MAX_VALUE,
			profileId: { browser: "chrome", os: "macos" },
			proxyUsed: false,
			requestClass: "navigation",
		});
		collector.recordAttempt({
			ms: Number.POSITIVE_INFINITY,
			profileId: { browser: "chrome", os: "macos" },
			proxyUsed: false,
			requestClass: "navigation",
		});
		collector.recordAttempt({
			ms: -1,
			profileId: { browser: "chrome", os: "macos" },
			proxyUsed: false,
			requestClass: "navigation",
		});
		collector.recordPoolRefresh();
		collector.recordRedirectHop();
		collector.recordSafeRefetch();
		const log = collector.toLogPayload()!;
		expect(log.attempts).toBe(4);
		expect(log.ms).toBe(Number.MAX_SAFE_INTEGER);
		expect(log.attemptSamples?.map((sample) => sample.ms)).toEqual([
			Number.MAX_SAFE_INTEGER,
			Number.MAX_SAFE_INTEGER,
			Number.MAX_SAFE_INTEGER,
			0,
		]);
		expect(log.poolRefreshes).toBe(1);
		expect(log.redirectHops).toBe(1);
		expect(log.safeRefetch).toBe(1);
	});

	it("redacts every diagnostic field before bounding it", () => {
		const seen: string[] = [];
		const collector = new StealthTelemetryCollector({
			redact(text) {
				seen.push(text);
				return text.replaceAll("orchardtoken", "[REDACTED]");
			},
		});
		const message = `orchardtoken-${"x".repeat(400)}`;
		recordAttempt(collector, {
			diagnostics: { name: "orchardtoken", message, code: "orchardtoken-code" },
		});
		const diagnostics = collector.toLogPayload()?.attemptSamples?.[0]?.diagnostics;
		expect(seen).toEqual(["orchardtoken", message, "orchardtoken-code"]);
		expect(diagnostics).toEqual({
			name: "[REDACTED]",
			message: expect.stringMatching(/^\[REDACTED\]-x+$/),
			code: "[REDACTED]-code",
		});
		expect(diagnostics?.message).toHaveLength(300);
		expect(JSON.stringify(collector.toHeaderPayload(collector.toLogPayload()!))).not.toContain(
			"orchardtoken",
		);
	});

	it("fails closed when diagnostic redaction throws", () => {
		const collector = new StealthTelemetryCollector({
			redact() {
				throw new Error("redactor unavailable");
			},
		});
		recordAttempt(collector, {
			diagnostics: { name: "SecretError", message: "orchardtoken", code: "SECRET_CODE" },
		});
		expect(collector.toLogPayload()?.attemptSamples?.[0]?.diagnostics).toEqual({
			name: "[REDACTION_FAILED]",
			message: "[REDACTION_FAILED]",
			code: "[REDACTION_FAILED]",
		});
		expect(JSON.stringify(collector.toLogPayload())).not.toContain("orchardtoken");
	});

	it("takes independent snapshots of caller input and returned payloads", () => {
		const collector = new StealthTelemetryCollector();
		const profile = { browser: "firefox", os: "linux" } as const;
		const diagnostics = { name: "NetworkError", message: "connection reset" };
		recordAttempt(collector, { profileId: profile, diagnostics });
		diagnostics.message = "mutated after record";

		const first = collector.toLogPayload()!;
		first.profileId!.browser = "chrome";
		Object.assign(first.attemptSamples![0]!.diagnostics!, { message: "mutated snapshot" });
		const second = collector.toLogPayload()!;
		expect(second.profileId).toEqual({ browser: "firefox", os: "linux" });
		expect(second.attemptSamples?.[0]?.diagnostics?.message).toBe("connection reset");
	});

	it("projects the same closed facts to the header and excludes diagnostics", () => {
		const collector = new StealthTelemetryCollector();
		recordAttempt(collector, {
			status: 504,
			ms: 18.7,
			errorCode: "transport_timeout",
			profileId: { browser: "safari", os: "ios" },
			proxyUsed: false,
			requestClass: "navigation",
			kind: "proxy_diagnostic",
			diagnostics: { message: "vendor diagnostic prose" },
		});
		collector.recordSbsd({ detected: true, outcome: "replay_required" });
		const log = collector.toLogPayload()!;
		const header: GatewayIngestible<StealthTelemetryHeaderPayload> = collector.toHeaderPayload(log);

		expect(header as unknown).toEqual({
			attempts: 1,
			poolRefreshes: 0,
			redirectHops: 0,
			profileId: { browser: "safari", os: "ios" },
			proxyUsed: false,
			requestClass: "navigation",
			sbsdDetected: true,
			sbsdOutcome: "replay_required",
			safeRefetch: 0,
			lastStatus: 504,
			ms: 18,
			attemptSamples: [
				{
					n: 1,
					ms: 18,
					status: 504,
					e: "transport_timeout",
					kind: "proxy_diagnostic",
				},
			],
		});
		expect(header).not.toHaveProperty("diagnostics");
		expect(header.attemptSamples?.[0]).not.toHaveProperty("diagnostics");
	});

	it("drops stealth before resolver and proxy when the header exceeds its budget", () => {
		const telemetry = new RequestTelemetry(createTraceContext());
		const contributor = (key: "proxy" | "resolver") => ({
			key,
			toLogPayload: () => ({
				samples: Array.from({ length: 12 }, () =>
					closedEnum(key === "proxy" ? "p".repeat(63) : "r".repeat(63)),
				),
			}),
			toHeaderPayload: () => ({
				samples: Array.from({ length: 12 }, () =>
					closedEnum(key === "proxy" ? "p".repeat(63) : "r".repeat(63)),
				),
			}),
		});
		telemetry.register(contributor("proxy"));
		telemetry.register(contributor("resolver"));
		const stealth = new StealthTelemetryCollector();
		for (let index = 0; index < 24; index += 1) {
			recordAttempt(stealth, {
				errorCode: "PROXY_EDGE_AUTH_REJECTED",
				kind: "proxy_diagnostic",
			});
		}
		telemetry.register(stealth);
		const envelope = decode(telemetry.toHeaderValue()!);
		expect(envelope.v).toBe(1);
		expect(envelope.taxonomy).toBe(PROVIDER_OBSERVABILITY_TAXONOMY_VERSION);
		expect(envelope.proxy).toBeDefined();
		expect(envelope.resolver).toBeDefined();
		expect(envelope.stealth).toBeUndefined();
		expect(envelope.truncated).toBe(true);
	});
});
