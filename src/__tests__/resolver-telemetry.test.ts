import { describe, expect, it } from "bun:test";

import {
	ResolverTelemetryCollector,
	type ResolverTelemetryHeaderPayload,
} from "../runtime/resolver-telemetry.js";
import { closedEnum, type GatewayIngestible } from "../runtime/request-telemetry.js";
import { createBypassProviderCache, createProviderCache } from "../runtime/cache.js";
import { createResolverClient } from "../runtime/resolver.js";
import { ResolverVendorUnavailableError } from "../runtime/resolver-vendors/types.js";
import type { ProviderCache } from "../types.js";

function completedCollector(
	outcome: "solved" | "cached" | "exhausted" | "aborted",
): ResolverTelemetryCollector {
	const collector = new ResolverTelemetryCollector();
	collector.recordIdentity({ source: "none" });
	collector.recordCacheRead({
		status: outcome === "cached" ? "hit" : "miss",
		challengeKind: "aws_waf",
	});
	collector.recordOutcome({ outcome, solveMs: 12.9, challengeKind: "aws_waf" });
	return collector;
}

describe("resolver telemetry collector", () => {
	it.each([
		false,
		true,
	])("detaches retained text after GC, including diagnostics=%s", async (includeDiagnostics) => {
		const probe = Bun.spawn({
			cmd: [
				process.execPath,
				new URL("./fixtures/resolver-telemetry-retention.mjs", import.meta.url).pathname,
				new URL("../runtime/resolver-telemetry.ts", import.meta.url).href,
				...(includeDiagnostics ? ["--diagnostics"] : []),
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(probe.stdout).text(),
			new Response(probe.stderr).text(),
			probe.exited,
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.descriptionLength).toBe(300);
		expect(result.codeLengths).toEqual(Array(24).fill(300));
		// Each reverted copy retains at least 10 MiB; allow 2 MiB of runtime noise.
		expect(result.retainedHeapDelta).toBeLessThan(2 * 1024 * 1024);
	}, 20_000);

	it.each([
		"absent",
		"bypass",
		"enabled",
	] as const)("classifies the actual %s cache across two solves", async (mode) => {
		const cache =
			mode === "absent"
				? undefined
				: mode === "bypass"
					? createBypassProviderCache({ providerId: "resolver-telemetry-bypass" })
					: createProviderCache({ providerId: crypto.randomUUID(), redisUrl: "" });
		let calls = 0;
		for (let index = 0; index < 2; index++) {
			const collector = new ResolverTelemetryCollector();
			const resolver = createResolverClient({
				kinds: ["aws_waf"],
				cache,
				telemetry: collector,
				adapters: [
					{
						id: "custom",
						supports: () => true,
						async solve() {
							calls++;
							return {
								form: "cookies",
								cookies: { "aws-waf-token": "cookie" },
								userAgent: "probe",
								expires: Math.floor(Date.now() / 1000) + 60,
							};
						},
					},
				],
			});
			await resolver.solve({
				kind: "aws_waf",
				pageUrl: "https://example.com/challenge",
				siteKey: "k",
				iv: "i",
				context: "c",
			});
			const log = collector.toLogPayload()!;
			const hit = mode === "enabled" && index === 1;
			expect(log.cacheStatus).toBe(mode === "enabled" ? (hit ? "hit" : "miss") : "disabled");
			expect(log.cacheWrite).toEqual(mode === "enabled" && !hit ? { written: true } : undefined);
			expect(log.outcome).toBe(hit ? "cached" : "solved");
			expect(log.attempts).toBe(hit ? 0 : 1);
			expect(collector.toHeaderPayload(log).cacheStatus as unknown).toBe(
				mode === "enabled" ? (hit ? "hit" : "miss") : "disabled",
			);
		}
		expect(calls).toBe(mode === "enabled" ? 1 : 2);
	});

	it("records one successful vendor invocation when the cache write throws", async () => {
		const collector = new ResolverTelemetryCollector();
		const failure = new Error("cache write failed");
		const cache: ProviderCache = {
			...createProviderCache({ providerId: crypto.randomUUID(), redisUrl: "" }),
			async set() {
				throw failure;
			},
		};
		let calls = 0;
		const resolver = createResolverClient({
			kinds: ["aws_waf"],
			cache,
			telemetry: collector,
			adapters: [
				{
					id: "custom",
					supports: () => true,
					async solve() {
						calls++;
						return {
							form: "cookies",
							cookies: { "aws-waf-token": "cookie" },
							userAgent: "probe",
							expires: Math.floor(Date.now() / 1000) + 60,
						};
					},
				},
			],
		});
		await expect(
			resolver.solve({
				kind: "aws_waf",
				pageUrl: "https://example.com/challenge",
				siteKey: "k",
				iv: "i",
				context: "c",
			}),
		).rejects.toBe(failure);
		const log = collector.toLogPayload()!;
		expect(calls).toBe(1);
		expect(log.attempts).toBe(1);
		expect(log.failovers).toBe(0);
		expect(log.outcome).toBe("error");
		expect(log.cacheWrite).toEqual({ written: false, reason: "error" });
		expect(log.attemptSamples).toEqual([
			{
				v: "custom",
				p: "poll_result",
				o: "ok",
				ms: expect.any(Number),
				diagnostics: { attemptIndex: 1 },
			},
		]);
	});

	it("reports an enabled but non-cacheable runtime solve", async () => {
		const collector = new ResolverTelemetryCollector();
		await createResolverClient({
			kinds: ["turnstile"],
			telemetry: collector,
			cache: createProviderCache({ providerId: crypto.randomUUID(), redisUrl: "" }),
			adapters: [
				{
					id: "custom",
					supports: () => true,
					async solve() {
						return { form: "token", token: "ok" };
					},
				},
			],
		}).solve({ kind: "turnstile", pageUrl: "https://example.com", siteKey: "k" });
		expect(collector.toLogPayload()?.cacheStatus).toBe("not_cacheable");
		expect(collector.toLogPayload()?.cacheWrite).toEqual({
			written: false,
			reason: "not_cacheable",
		});
	});

	it("keeps unavailable-attempt diagnostics in the log with the true custom phase", async () => {
		const collector = new ResolverTelemetryCollector({
			redact: (text) => text.replaceAll("SECRET", "[REDACTED]"),
		});
		const resolver = createResolverClient({
			kinds: ["turnstile"],
			telemetry: collector,
			adapters: [
				{
					id: "custom",
					supports: () => true,
					async solve() {
						throw new ResolverVendorUnavailableError("custom", "missing_challenge_input", {
							cause: new Error("connect timeout SECRET"),
							upstreamHost: "api.vendor.invalid",
							missingFields: ["siteKey", "SECRET"],
							round: 2,
							phase: "fetch_script.SECRET",
						});
					},
				},
			],
		});
		try {
			await resolver.solve({ kind: "turnstile", pageUrl: "https://example.com", siteKey: "k" });
			throw new Error("Expected exhaustion");
		} catch (error) {
			expect(error).toHaveProperty("details", {
				challengeKind: "turnstile",
				attempts: 1,
				outcome: "exhausted",
				retryable: false,
			});
		}
		const log = collector.toLogPayload()!;
		expect(log.attemptSamples).toEqual([
			{
				v: "custom",
				p: "create_task",
				o: "error",
				ms: expect.any(Number),
				e: "missing_challenge_input",
				diagnostics: {
					cause: { name: "Error", message: "connect timeout [REDACTED]" },
					upstreamHost: "api.vendor.invalid",
					missingFields: ["siteKey", "[REDACTED]"],
					round: 2,
					attemptIndex: 1,
					phase: "fetch_script.[REDACTED]",
				},
			},
		]);
		expect(collector.toHeaderPayload(log).attemptSamples as unknown).toEqual([
			{ v: "custom", p: "create_task", o: "error", ms: log.attemptSamples![0]!.ms },
		]);
	});

	it.each([
		"measure_ip",
		"fetch_script",
		"generate_payload",
		"post_payload",
	] as const)("projects the closed %s adapter phase", async (phase) => {
		const collector = new ResolverTelemetryCollector();
		const resolver = createResolverClient({
			kinds: ["turnstile"],
			telemetry: collector,
			adapters: [
				{
					id: "custom",
					supports: () => true,
					async solve() {
						throw new ResolverVendorUnavailableError("custom", "transport_failure", {
							phase,
						});
					},
				},
			],
		});
		await expect(
			resolver.solve({ kind: "turnstile", pageUrl: "https://example.com", siteKey: "k" }),
		).rejects.toHaveProperty("code", "RESOLVER_CHAIN_EXHAUSTED");
		const log = collector.toLogPayload()!;
		expect(log.attemptSamples?.[0]?.p).toBe(phase);
		expect(collector.toHeaderPayload(log).attemptSamples?.[0]?.p).toBe(closedEnum(phase));
	});

	it("preserves custom phases from trace diagnostics, including cleanup", async () => {
		const collector = new ResolverTelemetryCollector();
		const resolver = createResolverClient({
			kinds: ["turnstile"],
			telemetry: collector,
			adapters: [
				{
					id: "custom",
					supports: () => true,
					async solve(_challenge, _identity, _signal, trace) {
						await trace!.runSpan("resolver.vendor.create_task", () => undefined, {
							onSuccess: () => ({ transport_phase: "fetch_script" }),
						});
						await trace!.runSpan("resolver.vendor.cleanup", () => undefined, {
							onSuccess: () => ({ transport_phase: "release_session" }),
						});
						return { form: "token", token: "ok" };
					},
				},
			],
		});
		await resolver.solve({ kind: "turnstile", pageUrl: "https://example.com", siteKey: "k" });
		const log = collector.toLogPayload()!;
		expect(log.attempts).toBe(1);
		expect(log.attemptSamples).toEqual([
			{
				v: "custom",
				p: "cleanup",
				o: "ok",
				ms: expect.any(Number),
				diagnostics: { phase: "release_session", attemptIndex: 1 },
			},
			{
				v: "custom",
				p: "fetch_script",
				o: "ok",
				ms: expect.any(Number),
				diagnostics: { phase: "fetch_script", attemptIndex: 1 },
			},
		]);
		expect(collector.toHeaderPayload(log).attemptSamples as unknown).toEqual([
			{ v: "custom", p: "cleanup", o: "ok", ms: log.attemptSamples![0]!.ms },
			{ v: "custom", p: "fetch_script", o: "ok", ms: log.attemptSamples![1]!.ms },
		]);
	});

	it.each([
		false,
		true,
	])("redacts all free text before bounding, with redactor failure=%s", (throws) => {
		const secret = "BOUNDARY_SECRET_1234567890";
		const input = `${"x".repeat(290)}${secret}tail`;
		const seen: string[] = [];
		const collector = new ResolverTelemetryCollector({
			redact: (text) => {
				seen.push(text);
				if (throws) throw new Error("API_KEY_FAKE_SECRET");
				return text.replace(secret, "[REDACTED]");
			},
		});
		collector.recordVendorAttempt({
			vendor: "capsolver",
			phase: "create_task",
			outcome: "error",
			ms: 1,
			vendorErrorCode: input,
			vendorErrorDescription: input,
			diagnostics: {
				cause: { name: input, message: input },
				upstreamHost: input,
				missingFields: Array(30).fill(input),
				phase: input,
				round: 2,
				attemptIndex: 1,
			},
		});
		const output = throws ? "[REDACTION_FAILED]" : `${"x".repeat(290)}[REDACTED]`;
		const log = collector.toLogPayload()!;
		expect(log.lastVendorErrorDescription).toBe(output);
		expect(log.attemptSamples![0]!.c).toBe(output);
		expect(log.attemptSamples![0]!.diagnostics).toEqual({
			cause: { name: output, message: output },
			upstreamHost: output,
			missingFields: Array(24).fill(output),
			phase: output,
			round: 2,
			attemptIndex: 1,
		});
		expect(seen).toEqual(Array(30).fill(input));
		expect(JSON.stringify(log)).not.toContain("API_KEY_FAKE_SECRET");
		expect(collector.toHeaderPayload(log).attemptSamples as unknown).toEqual([
			{ v: "capsolver", p: "create_task", o: "error", ms: 1 },
		]);
	});

	it.each([
		"\ud800X\udc00",
		`${"x".repeat(299)}😀`,
		`${"x".repeat(298)}😀`,
	])("preserves exact UTF-16 code units, including lone and boundary surrogates: %j", (input) => {
		const collector = new ResolverTelemetryCollector();
		collector.recordVendorAttempt({
			vendor: "capsolver",
			phase: "create_task",
			outcome: "error",
			ms: 1,
			vendorErrorCode: input,
			vendorErrorDescription: input,
		});
		const expected = input.slice(0, 300);
		expect(collector.toLogPayload()?.lastVendorErrorDescription).toBe(expected);
		expect(collector.toLogPayload()?.attemptSamples?.[0]?.c).toBe(expected);
	});

	it.each([
		"solved",
		"cached",
		"exhausted",
		"aborted",
	] as const)("aggregates a %s outcome", (outcome) => {
		const collector = completedCollector(outcome);
		expect(collector.toLogPayload()).toMatchObject({
			outcome,
			challengeKind: "aws_waf",
			cacheStatus: outcome === "cached" ? "hit" : "miss",
			identitySource: "none",
			solveMs: 12,
			attempts: 0,
			failovers: 0,
			vendorChain: [],
			pollCount: 0,
		});
	});

	it("keeps the vendor attempt and failover trail while selecting the serving vendor", () => {
		const collector = new ResolverTelemetryCollector();
		collector.recordVendorAttempt({
			vendor: "capsolver",
			phase: "create_task",
			outcome: "error",
			ms: 7.8,
			errorClass: "allocation_exhausted",
			vendorErrorCode: "ERROR_ZERO_BALANCE",
			vendorErrorDescription: "Account has zero funds",
		});
		collector.recordFailover({
			from: "capsolver",
			to: "2captcha",
			reason: "allocation_exhausted",
		});
		collector.recordVendorAttempt({
			vendor: "2captcha",
			phase: "poll_result",
			outcome: "ok",
			ms: 25.2,
			pollCount: 3,
		});
		collector.recordOutcome({ outcome: "solved", solveMs: 34, challengeKind: "recaptcha_v2" });

		expect(collector.toLogPayload()).toEqual({
			outcome: "solved",
			challengeKind: "recaptcha_v2",
			solveMs: 34,
			attempts: 2,
			failovers: 1,
			vendorChain: ["capsolver", "2captcha"],
			vendorUsed: "2captcha",
			pollCount: 3,
			attemptSamples: [
				{
					v: "capsolver",
					p: "create_task",
					o: "error",
					ms: 7,
					c: "ERROR_ZERO_BALANCE",
					e: "allocation_exhausted",
				},
				{ v: "2captcha", p: "poll_result", o: "ok", ms: 25 },
			],
			lastVendorErrorDescription: "Account has zero funds",
		});
	});

	it("records every cache read/write classification including the no-expires gate", () => {
		const cases = [
			["hit", true, undefined],
			["miss", false, "no_expires"],
			["disabled", false, "not_cacheable"],
			["not_cacheable", false, "error"],
		] as const;
		for (const [status, written, reason] of cases) {
			const collector = new ResolverTelemetryCollector();
			collector.recordCacheRead({ status, challengeKind: "cloudflare_interstitial" });
			collector.recordCacheWrite({ written, ...(reason ? { reason } : {}) });
			expect(collector.toLogPayload()).toMatchObject({
				cacheStatus: status,
				cacheWrite: { written, ...(reason ? { reason } : {}) },
			});
		}
	});

	it("reports the runtime gate that drops a cookie solution without expires", async () => {
		const collector = new ResolverTelemetryCollector();
		const resolver = createResolverClient({
			kinds: ["cloudflare_interstitial"],
			cache: createProviderCache({
				providerId: `resolver-no-expires-${crypto.randomUUID()}`,
				redisUrl: "",
			}),
			telemetry: collector,
			adapters: [
				{
					id: "custom",
					supports: () => true,
					async solve() {
						return {
							form: "cookies" as const,
							cookies: { cf_clearance: "session-cookie" },
							userAgent: "resolver telemetry test",
						};
					},
				},
			],
		});
		await resolver.solve({
			kind: "cloudflare_interstitial",
			pageUrl: "https://example.com/challenge",
		});
		expect(collector.toLogPayload()).toMatchObject({
			outcome: "solved",
			cacheStatus: "miss",
			cacheWrite: { written: false, reason: "no_expires" },
		});
	});

	it("caps samples at 24 and keeps 10,000-attempt aggregates incremental", () => {
		const collector = new ResolverTelemetryCollector();
		for (let index = 0; index < 10_000; index += 1) {
			collector.recordVendorAttempt({
				vendor: index % 2 === 0 ? "capsolver" : "2captcha",
				phase: "create_task",
				outcome: "error",
				ms: 1,
				errorClass: "transport_failure",
			});
		}
		const log = collector.toLogPayload();
		expect(log?.attempts).toBe(10_000);
		expect(log?.attemptSamples).toHaveLength(24);
		expect(log?.attemptSamplesDropped).toBe(9_976);
		expect(log?.vendorChain).toHaveLength(64);
	});

	it("omits an empty collector", () => {
		expect(new ResolverTelemetryCollector().toLogPayload()).toBeUndefined();
	});

	it("redacts and bounds operator-only vendor descriptions", () => {
		const collector = new ResolverTelemetryCollector({
			redact: (text) => text.replace("secret", "[REDACTED]"),
		});
		collector.recordVendorAttempt({
			vendor: "capsolver",
			phase: "poll_result",
			outcome: "error",
			ms: 1,
			vendorErrorDescription: `secret-${"x".repeat(400)}`,
		});
		const description = collector.toLogPayload()?.lastVendorErrorDescription;
		expect(description).toStartWith("[REDACTED]-");
		expect(description).toHaveLength(300);
	});

	it("projects only bounded closed-enum values to the gateway header", () => {
		const collector = new ResolverTelemetryCollector();
		collector.recordIdentity({ source: "defaulted", failure: "missing_proxy_identity" });
		collector.recordVendorAttempt({
			vendor: "capsolver",
			phase: "poll_result",
			outcome: "error",
			ms: 8,
			errorClass: "transport_failure",
			vendorErrorCode: "vendor said no",
			vendorErrorDescription: "operator free text",
		});
		collector.recordVendorAttempt({
			vendor: "2captcha",
			phase: "poll_result",
			outcome: "ok",
			ms: 10,
			vendorErrorCode: "OK_TOKEN",
		});
		collector.recordOutcome({ outcome: "solved", solveMs: 20, challengeKind: "turnstile" });
		const log = collector.toLogPayload();
		if (!log) throw new Error("Expected resolver log payload");
		const header: GatewayIngestible<ResolverTelemetryHeaderPayload> =
			collector.toHeaderPayload(log);

		expect(header as unknown).toEqual({
			outcome: "solved",
			solveMs: 20,
			attempts: 2,
			failovers: 0,
			vendorUsed: "2captcha",
			vendorChain: ["capsolver", "2captcha"],
			pollCount: 0,
			identitySource: "defaulted",
			attemptSamples: [
				{ v: "capsolver", p: "poll_result", o: "error", ms: 8 },
				{ v: "2captcha", p: "poll_result", o: "ok", ms: 10, c: "OK_TOKEN" },
			],
		});
		expect(header).not.toHaveProperty("lastVendorErrorDescription");
		expect(header.attemptSamples?.[0]).not.toHaveProperty("c");
	});
});
