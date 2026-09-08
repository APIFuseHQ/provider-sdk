import { describe, expect, it } from "bun:test";
import {
	HttpTelemetryCollector,
	type HttpTelemetryHeaderPayload,
} from "../runtime/http-telemetry.js";
import { type GatewayIngestible, RequestTelemetry } from "../runtime/request-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";

const sentinel = "SENTINEL12xy";

describe("HTTP telemetry collector", () => {
	it("omits an unused contributor from both surfaces", () => {
		const collector = new HttpTelemetryCollector();
		const ledger = new RequestTelemetry(createTraceContext());
		ledger.register(collector);
		expect(collector.toTenantRetryPayload()).toBeUndefined();
		expect(ledger.toLogPayload()).toBeUndefined();
		expect(ledger.toHeaderValue()).toBeUndefined();
	});

	it("aggregates attempts incrementally after the sample cap and projects tenant retry", () => {
		const collector = new HttpTelemetryCollector();
		const call = collector.startRequest({ retryPreset: "safe_read" });
		for (let n = 1; n <= 30; n++)
			call.recordAttempt({
				ms: 1.9,
				proxyUsed: true,
				status: n === 30 ? 200 : 503,
				...(n === 30 ? {} : ({ e: "upstream_http_error", statusRetry: true } as const)),
			});
		call.finish(50.9);
		call.finish(100);
		const log = collector.toLogPayload()!;
		expect(log as unknown).toEqual({
			attempts: 30,
			retries: 29,
			timeouts: 0,
			proxyUsed: true,
			lastStatus: 200,
			retryPreset: "safe_read",
			transport: "native",
			lastErrorCode: "upstream_http_error",
			attemptSamples: Array.from({ length: 24 }, (_, i) => ({
				n: i + 1,
				ms: 1,
				status: 503,
				e: "upstream_http_error",
			})),
			dropped: 6,
			ms: 50,
			retry: {
				attempts: 30,
				retries: 29,
				preset: "safe_read",
				transport: "native",
				lastStatus: 503,
			},
		});
		expect(collector.toTenantRetryPayload()).toEqual(log.retry);
		expect(call.toTenantRetryPayload()).toEqual(log.retry);
		const header: GatewayIngestible<HttpTelemetryHeaderPayload> = collector.toHeaderPayload(log);
		expect(header as unknown).toEqual(log);
	});

	it("isolates concurrent retry state and snapshots", () => {
		const collector = new HttpTelemetryCollector();
		const a = collector.startRequest({ retryPreset: "transport_transient" });
		const b = collector.startRequest({ retryPreset: "safe_read" });
		a.recordAttempt({ ms: 2, proxyUsed: true, e: "transport_timeout", status: 0 });
		b.recordAttempt({
			ms: 3,
			proxyUsed: false,
			e: "upstream_http_error",
			status: 503,
			statusRetry: true,
		});
		a.recordAttempt({ ms: 4, proxyUsed: true, status: 200 });
		b.recordAttempt({ ms: 5, proxyUsed: false, status: 201 });
		a.finish(20);
		b.finish(30);
		expect(a.toTenantRetryPayload() as unknown).toEqual({
			attempts: 2,
			retries: 1,
			preset: "transport_transient",
			transport: "native",
			lastErrorCode: "transport_timeout",
		});
		expect(b.toTenantRetryPayload() as unknown).toEqual({
			attempts: 2,
			retries: 1,
			preset: "safe_read",
			transport: "native",
			lastStatus: 503,
		});
		const log = collector.toLogPayload()!;
		expect(log).toMatchObject({ attempts: 4, retries: 2, timeouts: 1, proxyUsed: true, ms: 50 });
		expect(log.attemptSamples.map(({ n }) => n)).toEqual([1, 1, 2, 2]);
		log.attemptSamples[0]!.ms = 999;
		log.retry!.attempts = 999;
		expect(collector.toLogPayload()?.attemptSamples[0]?.ms).toBe(2);
		expect(collector.toTenantRetryPayload()?.attempts).toBe(2);
	});

	it.each([
		false,
		true,
	])("redacts every diagnostic before bounding; redactor throws=%s", (throws) => {
		const seen: string[] = [];
		const raw = `${"x".repeat(400)}${sentinel}`;
		const collector = new HttpTelemetryCollector({
			redact: (text) => {
				seen.push(text);
				if (throws) throw new Error("redactor failed");
				return text.replace(sentinel, "[REDACTED]");
			},
		});
		const call = collector.startRequest({});
		call.recordAttempt({
			ms: 1,
			proxyUsed: false,
			e: "other",
			diagnostics: {
				name: raw,
				message: raw,
				cause: { name: raw, message: raw },
			},
		});
		call.finish(1);
		expect(seen).toEqual([raw, raw, raw, raw]);
		const log = collector.toLogPayload()!;
		const expected = throws ? "[REDACTION_FAILED]" : "x".repeat(300);
		expect(log.attemptSamples[0]?.diagnostics).toEqual({
			name: expected,
			message: expected,
			cause: { name: expected, message: expected },
		});
		expect(JSON.stringify(log)).not.toContain(sentinel);
		expect(collector.toHeaderPayload(log).attemptSamples as unknown).toEqual([
			{ n: 1, ms: 1, e: "other" },
		]);
		log.attemptSamples[0]!.diagnostics!.cause!.message = "mutated";
		expect(collector.toLogPayload()?.attemptSamples[0]?.diagnostics?.cause?.message).toBe(expected);
	});

	it.each([
		"\ud800X\udc00",
		`${"x".repeat(299)}😀`,
		`${"x".repeat(298)}😀`,
	])("preserves UTF-16 units when detaching %j", (text) => {
		const collector = new HttpTelemetryCollector();
		collector.startRequest({}).recordAttempt({
			ms: 1,
			proxyUsed: false,
			e: "other",
			diagnostics: { name: text, message: text },
		});
		expect(collector.toLogPayload()?.attemptSamples[0]?.diagnostics?.message).toBe(
			text.slice(0, 300),
		);
	});
});

import { z } from "zod";
import { createInProcessProviderEngine } from "../engine.js";
import {
	createServerApp,
	createServerAppAsync,
	type ProviderServerLogEvent,
} from "../server/serve.js";
import { statefulSignedHeaders } from "../stateful-signing.js";
import type { ProviderContext, ProviderDefinition } from "../types.js";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/request-telemetry.js";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";

for (const factory of ["sync", "async"] as const) {
	for (const outcome of ["success", "failure", "unused"] as const) {
		it.each([
			"operation",
			"operation override",
			"engine override",
			"stream",
			"sse",
			"start",
			"continue",
			"poll",
			"refresh",
			"disconnect",
			"signed stateful",
		] as const)(`HTTP server sink matrix: ${factory} ${outcome} %s`, async (route) => {
			const originalFetch = globalThis.fetch;
			const streaming = route === "stream" || route === "sse";
			const expectedAttempts = streaming ? 1 : 3;
			let fetches = 0;
			globalThis.fetch = Object.assign(
				async () => {
					fetches++;
					if (outcome === "failure" || (!streaming && fetches === 1))
						throw new Error(`upstream vendor: ${sentinel}`);
					return new Response("response", { status: !streaming && fetches === 2 ? 503 : 200 });
				},
				{ preconnect: () => {} },
			);
			const probe = async (ctx: Pick<ProviderContext, "http">) => {
				if (outcome === "unused") return { status: 200 };
				if (route === "stream") {
					const response = await ctx.http.stream("https://example.com/probe");
					await new Response(response.body).text();
					return { status: response.status };
				}
				if (route === "sse") {
					for await (const _message of await ctx.http.sse("https://example.com/probe")) {
						/* consume */
					}
					return { status: 200 };
				}
				return {
					status: (
						await ctx.http.get("https://example.com/probe", {
							retry: { attempts: 3, statusCodes: [503], baseDelayMs: 0, jitter: "none" },
						})
					).status,
				};
			};
			const flowProbe = async (ctx: Pick<ProviderContext, "http">) => ({
				kind: "complete" as const,
				turnId: "done",
				data: await probe(ctx),
			});
			const provider: ProviderDefinition = {
				id: "http-telemetry-probe",
				version: "1.0.0",
				runtime: "standard",
				http: {},
				meta: { displayName: "HTTP telemetry", descriptionKey: "description", category: "test" },
				credential: { keys: ["token"] },
				auth: {
					mode: "credentials",
					flow: {
						start: flowProbe,
						continue: flowProbe,
						poll: flowProbe,
						refresh: flowProbe,
						abort: flowProbe,
					},
				},
				operations: {
					probe: {
						riskClass: "read",
						input: z.object({}),
						output: z.object({ status: z.number() }),
						handler: probe,
					},
				},
			};
			const events: ProviderServerLogEvent[] = [];
			const inProcess = createInProcessProviderEngine();
			let attachments = 0;
			try {
				const app = await (factory === "sync" ? createServerApp : createServerAppAsync)(provider, {
					logger: (event) => events.push(event),
					...(route === "operation override"
						? { operationExecutor: async ({ ctx }) => probe(ctx) }
						: {}),
					...(route === "engine override"
						? {
								engine: {
									attach: (input) => {
										attachments++;
										return inProcess.attach(input);
									},
								},
							}
						: {}),
					statefulForwarding: {
						secret: "http-telemetry-forwarding",
						validateOwnerFence: async () => true,
					},
					internalOperationExecutor: async ({ ctx }) => probe(ctx),
				});
				const stateful = route === "signed stateful";
				const operation = route.includes("operation") || route === "engine override" || streaming;
				const path = stateful
					? "/__apifuse/stateful/operations"
					: operation
						? "/v1/probe"
						: `/auth/${route}`;
				const timestamp = new Date().toISOString();
				const request = {
					requestId: `${factory}-${outcome}-${route}`,
					...(!stateful && !operation ? { flowId: "flow" } : {}),
					input: {},
					connection: {
						id: "connection",
						mode: "credentials",
						externalRef: "external",
						metadata: {},
						secrets: { token: sentinel },
					},
				};
				const body = JSON.stringify(
					stateful
						? {
								requestId: request.requestId,
								providerId: provider.id,
								operationId: "probe",
								sessionKey: "provider:account:connection",
								connectionId: "connection",
								serviceAccountId: "account",
								ownerPodId: "owner",
								generation: 7,
								sourcePodId: "source",
								forwardedAt: timestamp,
								operationRequest: request,
							}
						: request,
				);
				const response = await app.request(path, {
					method: "POST",
					body,
					headers: {
						"content-type": "application/json",
						...(stateful
							? {
									"x-apifuse-stateful-source-pod": "source",
									...statefulSignedHeaders({
										secret: "http-telemetry-forwarding",
										timestamp,
										rawBody: body,
										method: "POST",
										path,
									}),
								}
							: {}),
					},
				});
				expect(response.status, JSON.stringify(events)).toBe(outcome === "failure" ? 502 : 200);
				expect(events).toHaveLength(1);
				const event = events[0]!;
				if (
					event.event !== "provider_request_completed" &&
					event.event !== "provider_request_failed"
				)
					throw new Error("Expected a terminal request event");
				expect(event.event).toBe(
					outcome === "failure" ? "provider_request_failed" : "provider_request_completed",
				);
				if (route === "engine override") expect(attachments).toBe(1);
				const encoded = response.headers.get(PROVIDER_TELEMETRY_HEADER);
				if (outcome === "unused") {
					expect(event).not.toHaveProperty("http");
					expect(encoded).toBeNull();
					expect(fetches).toBe(0);
				} else {
					expect(fetches).toBe(expectedAttempts);
					expect(event.http?.attempts).toBe(expectedAttempts);
					expect(event.http?.retries).toBe(expectedAttempts - 1);
					expect(event.http?.attemptSamples.map(({ n }) => n)).toEqual(streaming ? [1] : [1, 2, 3]);
					expect(encoded).not.toBeNull();
					const decoded = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
					expect(decoded).toEqual({
						v: 1,
						taxonomy: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
						http: new HttpTelemetryCollector().toHeaderPayload(event.http!),
					});
					expect(JSON.stringify({ event, decoded })).not.toContain(sentinel);
					if (!streaming || outcome === "failure")
						expect(event.http?.attemptSamples[0]?.diagnostics?.cause?.message).toContain(
							"[REDACTED]",
						);
					const payload = await response.json();
					if (outcome === "success" && operation && !streaming) {
						expect(payload.meta.retry).toEqual(event.http?.retry);
						expect(payload.meta.retry).toEqual({
							attempts: 3,
							retries: 2,
							transport: "native",
							lastErrorCode: "transport_network_error",
							preset: "transport_transient",
							lastStatus: 503,
						});
					}
					if (
						process.env.APIFUSE_P5A_PRINT_EXAMPLE === "1" &&
						factory === "sync" &&
						outcome === "success" &&
						route === "operation"
					) {
						console.log("P5A_LOG=" + JSON.stringify(event.http));
						console.log("P5A_HEADER=" + JSON.stringify(decoded));
					}
				}
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	}
}

it.each([
	"bun",
	"node",
] as const)("HTTP diagnostics release caller buffers after GC on %s", async (runtime) => {
	const probe = Bun.spawn({
		cmd: [
			runtime,
			...(runtime === "node" ? ["--expose-gc"] : []),
			new URL("./fixtures/http-telemetry-retention.mjs", import.meta.url).pathname,
			new URL(
				runtime === "bun" ? "../runtime/http-telemetry.ts" : "../../dist/runtime/http-telemetry.js",
				import.meta.url,
			).href,
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
	expect(result.lengths).toEqual(Array(96).fill(300));
	expect(result.retainedHeapDelta).toBeLessThan(2 * 1024 * 1024);
});

it.each([
	[Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	[Number.MAX_SAFE_INTEGER - 1, 2],
	[Number.MAX_VALUE, Number.MAX_VALUE],
])("saturates logical duration sums and retains the HTTP ledger sibling: %j + %j", (a, b) => {
	const collector = new HttpTelemetryCollector();
	const ledger = new RequestTelemetry(createTraceContext());
	ledger.register(collector);
	for (const ms of [a, b, 1]) {
		const request = collector.startRequest({});
		request.recordAttempt({ ms, status: 200, proxyUsed: false });
		request.finish(ms);
	}
	const log = collector.toLogPayload()!;
	expect(log.ms).toBe(Number.MAX_SAFE_INTEGER);
	expect(log.attempts).toBe(3);
	expect(ledger.toLogPayload()?.http).toEqual(log);
	const header = JSON.parse(Buffer.from(ledger.toHeaderValue()!, "base64url").toString());
	expect(header.http).toEqual(collector.toHeaderPayload(log));
	expect(header.http.ms).toBe(Number.MAX_SAFE_INTEGER);
});

it.each([
	[NaN, Number.MAX_SAFE_INTEGER],
	[Infinity, Number.MAX_SAFE_INTEGER],
	[-Infinity, Number.MAX_SAFE_INTEGER],
	[Number.MAX_VALUE, Number.MAX_SAFE_INTEGER],
	[-10, 0],
	[0, 0],
	[6.9, 6],
])("bounds duration sources %j to %j on both surfaces", (input, expected) => {
	const collector = new HttpTelemetryCollector();
	const ledger = new RequestTelemetry(createTraceContext());
	ledger.register(collector);
	const request = collector.startRequest({});
	request.recordAttempt({ ms: input, status: 200, proxyUsed: false });
	request.finish(input);
	const log = collector.toLogPayload()!;
	expect(log.ms).toBe(expected);
	expect(log.attemptSamples[0]?.ms).toBe(expected);
	expect(ledger.toLogPayload()?.http).toEqual(log);
	const header = JSON.parse(Buffer.from(ledger.toHeaderValue()!, "base64url").toString());
	expect(header.http).toEqual(collector.toHeaderPayload(log));
});

it("keeps ordinary aggregate sums and per-call sample numbering unchanged", () => {
	const collector = new HttpTelemetryCollector();
	for (let call = 0; call < 2; call++) {
		const request = collector.startRequest({});
		request.recordAttempt({ ms: 1.9, proxyUsed: false, status: 0, e: "transport_timeout" });
		request.recordAttempt({ ms: 2.9, proxyUsed: false, status: 200 });
		request.finish(10.9);
	}
	expect(collector.toLogPayload()).toMatchObject({
		attempts: 4,
		retries: 2,
		timeouts: 2,
		dropped: 0,
		ms: 20,
	});
	expect(collector.toLogPayload()?.attemptSamples.map(({ n, ms }) => ({ n, ms }))).toEqual([
		{ n: 1, ms: 1 },
		{ n: 2, ms: 2 },
		{ n: 1, ms: 1 },
		{ n: 2, ms: 2 },
	]);
});
