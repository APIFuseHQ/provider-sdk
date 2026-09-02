import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
	exportSpansOTLP,
	OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_EXPORTER_OTLP_HEADERS,
	OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
	OTEL_EXPORTER_OTLP_TRACES_HEADERS,
	OTEL_RESOURCE_ATTRIBUTES,
	OTEL_SERVICE_NAME,
	OTLP_EXPORT_LIMITS,
	resetOTLPExportForTests,
	resolveOTLPExportOptions,
	resolveOTLPResourceAttributes,
	spansToOTLP,
	swapOTLPTransportForTests,
} from "../runtime/otlp.js";
import type { TraceSpan } from "../types.js";

type TransportCall = { url: string; init?: RequestInit };

function createTransport(
	implementation: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(implementation, { preconnect: global.fetch.preconnect });
}

/** Installs a recording transport through the engine seam; globalThis.fetch is never touched. */
function installTransport(
	respond: (call: TransportCall) => Promise<Response> | Response,
): TransportCall[] {
	const calls: TransportCall[] = [];
	swapOTLPTransportForTests(
		createTransport(async (url, init) => {
			const call = { url: typeof url === "string" ? url : url.toString(), init };
			calls.push(call);
			return respond(call);
		}),
	);
	return calls;
}

function makeSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
	return {
		id: overrides.id ?? "span-1",
		name: overrides.name ?? "provider.search",
		startedAt: overrides.startedAt ?? 1_000,
		endedAt: overrides.endedAt ?? 1_025,
		duration_ms: overrides.duration_ms ?? 25,
		status: overrides.status ?? "ok",
		attributes: overrides.attributes ?? {
			method: "GET",
			status: 200,
			success: true,
		},
		...(overrides.parentId ? { parentId: overrides.parentId } : {}),
		...(overrides.error ? { error: overrides.error } : {}),
	};
}

const ENDPOINT = "http://collector.test/v1/traces";
const ATTEMPTS = OTLP_EXPORT_LIMITS.maxAttempts;

function warnedText(warn: { mock: { calls: unknown[][] } }): string {
	return warn.mock.calls.flat().map(String).join("\n");
}

describe("otlp export", () => {
	let originalWarn: typeof console.warn;

	beforeEach(() => {
		originalWarn = console.warn;
		resetOTLPExportForTests();
	});

	afterEach(() => {
		console.warn = originalWarn;
		resetOTLPExportForTests();
	});

	it("spansToOTLP() returns OTLP resource and scope span payload", () => {
		const payload = spansToOTLP(
			[makeSpan({ id: "abc123", parentId: "def456", name: "stealth.fetch" })],
			{ "service.name": "provider-sdk-test" },
		);

		expect(payload).toEqual({
			resourceSpans: [
				{
					resource: {
						attributes: [
							{
								key: "service.name",
								value: { stringValue: "provider-sdk-test" },
							},
						],
					},
					scopeSpans: [
						{
							scope: {
								name: "apifuse-provider-sdk",
								version: "0.1.0",
							},
							spans: [
								{
									attributes: [
										{
											key: "method",
											value: { stringValue: "GET" },
										},
										{
											key: "status",
											value: { doubleValue: 200 },
										},
										{
											key: "success",
											value: { boolValue: true },
										},
									],
									endTimeUnixNano: "1025000000",
									kind: 2,
									name: "stealth.fetch",
									parentSpanId: "0000000000def456",
									spanId: "0000000000abc123",
									startTimeUnixNano: "1000000000",
									status: { code: 1 },
									traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
								},
							],
						},
					],
				},
			],
		});
	});

	it("spansToOTLP() stamps a supplied trace id on every span in the batch", () => {
		const traceId = "0af7651916cd43dd8448eb211c80319c";
		const payload = spansToOTLP(
			[
				makeSpan({ id: "trace-id-root" }),
				makeSpan({ id: "trace-id-child", parentId: "trace-id-root" }),
			],
			undefined,
			traceId,
		);

		expect(payload.resourceSpans[0]?.scopeSpans[0]?.spans.map((span) => span.traceId)).toEqual([
			traceId,
			traceId,
		]);
	});

	it("exportSpansOTLP() posts OTLP JSON with merged headers through the engine transport", async () => {
		const calls = installTransport(() => new Response(null, { status: 200 }));

		await exportSpansOTLP([makeSpan()], {
			endpoint: ENDPOINT,
			headers: { Authorization: "Bearer test" },
			timeout: 100,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(ENDPOINT);
		expect(calls[0]?.init?.method).toBe("POST");
		expect(calls[0]?.init?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer test",
		});
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(spansToOTLP([makeSpan()]));
	});

	it("exportSpansOTLP() sends a single content-type and authorization header whatever the casing", async () => {
		const calls = installTransport(() => new Response(null, { status: 200 }));

		await exportSpansOTLP([makeSpan({ id: "header-case" })], {
			endpoint: ENDPOINT,
			headers: { "content-type": "text/plain", authorization: "a" },
		});

		expect(calls[0]?.init?.headers).toEqual({
			authorization: "a",
			"Content-Type": "application/json",
		});
		const sent = new Headers(calls[0]?.init?.headers);
		expect(sent.get("content-type")).toBe("application/json");
		expect(sent.get("authorization")).toBe("a");
	});

	it("exportSpansOTLP() retries a network failure a bounded number of times, then warns without error text", async () => {
		const warn = mock((_message?: unknown) => {});
		console.warn = warn;
		const calls = installTransport(() => {
			throw new Error("network down");
		});

		await expect(
			exportSpansOTLP([makeSpan({ id: "net-down" })], { endpoint: ENDPOINT }),
		).resolves.toBeUndefined();

		expect(calls).toHaveLength(ATTEMPTS);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			`[apifuse] OTLP export failed (network error after ${ATTEMPTS} attempts); 1 batch dropped.`,
		);
		expect(warnedText(warn)).not.toContain("network down");
	});

	it("exportSpansOTLP() drops a rejected export immediately by status without echoing headers", async () => {
		const warn = mock((_message?: unknown) => {});
		console.warn = warn;
		const secret = "tok_fake_header_value_9f8e7d6c5b4a";
		const calls = installTransport(() => new Response(null, { status: 401 }));

		await exportSpansOTLP([makeSpan({ id: "status-401" })], {
			endpoint: `${ENDPOINT}?api-key=${secret}`,
			headers: { Authorization: `Bearer ${secret}` },
		});

		expect(calls).toHaveLength(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith("[apifuse] OTLP export failed (HTTP 401); 1 batch dropped.");
		expect(warnedText(warn)).not.toContain(secret);
	});

	it("exportSpansOTLP() retries a retryable collector status (503) a bounded number of times, then drops the batch", async () => {
		const warn = mock((_message?: unknown) => {});
		console.warn = warn;
		const calls = installTransport(() => new Response(null, { status: 503 }));

		await exportSpansOTLP([makeSpan({ id: "status-503" })], { endpoint: ENDPOINT });

		expect(calls).toHaveLength(ATTEMPTS);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			`[apifuse] OTLP export failed (HTTP 503 after ${ATTEMPTS} attempts); 1 batch dropped.`,
		);
	});

	it("exportSpansOTLP() reports an aborted attempt as a timeout", async () => {
		const warn = mock((_message?: unknown) => {});
		console.warn = warn;
		installTransport(
			(call) =>
				new Promise<Response>((_resolve, reject) => {
					call.init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("The operation was aborted.", "AbortError")),
					);
				}),
		);

		await exportSpansOTLP([makeSpan({ id: "timeout-1" })], { endpoint: ENDPOINT, timeout: 5 });

		expect(warn).toHaveBeenCalledWith(
			`[apifuse] OTLP export failed (timeout after ${ATTEMPTS} attempts); 1 batch dropped.`,
		);
	});

	it("exportSpansOTLP() never interpolates attacker-controlled error names, codes, or messages", async () => {
		const warn = mock((_message?: unknown) => {});
		console.warn = warn;
		const secret = "tok_fake_error_secret_1a2b3c4d5e6f";
		installTransport(() => {
			throw Object.assign(new Error(`leak ${secret}`), {
				name: `Authorization: Bearer ${secret}`,
				code: `X-${secret}`,
			});
		});

		await exportSpansOTLP([makeSpan({ id: "hostile-error" })], { endpoint: ENDPOINT });

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warnedText(warn)).toBe(
			`[apifuse] OTLP export failed (network error after ${ATTEMPTS} attempts); 1 batch dropped.`,
		);
	});

	it("exportSpansOTLP() echoes only allowlisted system error codes", async () => {
		const warn = mock((_message?: unknown) => {});
		console.warn = warn;
		installTransport(() => {
			throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4318"), {
				code: "ECONNREFUSED",
			});
		});

		await exportSpansOTLP([makeSpan({ id: "econnrefused" })], { endpoint: ENDPOINT });

		expect(warn).toHaveBeenCalledWith(
			`[apifuse] OTLP export failed (network error: ECONNREFUSED after ${ATTEMPTS} attempts); 1 batch dropped.`,
		);
		expect(warnedText(warn)).not.toContain("127.0.0.1");
	});

	it("exportSpansOTLP() cancels the unused response body", async () => {
		let cancelled = false;
		installTransport(
			() =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 200 },
				),
		);

		await exportSpansOTLP([makeSpan({ id: "body-cancel" })], { endpoint: ENDPOINT });

		expect(cancelled).toBe(true);
	});

	it("exportSpansOTLP() ignores a provider's replacement of globalThis.fetch", async () => {
		const warn = mock((_message?: unknown) => {});
		console.warn = warn;
		swapOTLPTransportForTests();
		const secret = "tok_fake_bound_transport_9z8y7x6w";
		const hijacked = mock(async () => new Response(null, { status: 200 }));
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(hijacked, { preconnect: originalFetch.preconnect });
		try {
			await exportSpansOTLP([makeSpan({ id: "hijacked-fetch" })], {
				endpoint: "http://127.0.0.1:1/v1/traces",
				headers: { Authorization: `Bearer ${secret}` },
				timeout: 1_000,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(hijacked).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warnedText(warn)).toContain("[apifuse] OTLP export failed (network error");
		expect(warnedText(warn)).not.toContain(secret);
	});

	it("exportSpansOTLP() drops a certificate failure without retrying", async () => {
		const warn = mock((_message?: unknown) => {});
		console.warn = warn;
		const calls = installTransport(() => {
			throw Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
		});

		await exportSpansOTLP([makeSpan({ id: "cert-expired" })], { endpoint: ENDPOINT });

		expect(calls).toHaveLength(1);
		expect(warn).toHaveBeenCalledWith(
			"[apifuse] OTLP export failed (certificate error: CERT_HAS_EXPIRED); 1 batch dropped.",
		);
	});

	it("exportSpansOTLP() drops a batch that cannot be serialized instead of throwing", async () => {
		const warn = mock((_message?: unknown) => {});
		console.warn = warn;
		const calls = installTransport(() => new Response(null, { status: 200 }));
		// A JavaScript caller can hand the exporter a span whose id is not a string.
		const hostile = JSON.parse(
			JSON.stringify({ ...makeSpan({ id: "unserializable" }), id: 123 }),
		) as TraceSpan;

		await expect(exportSpansOTLP([hostile], { endpoint: ENDPOINT })).resolves.toBeUndefined();

		expect(calls).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith(
			"[apifuse] OTLP export failed (span serialization failed); 1 batch dropped.",
		);
	});

	it("exportSpansOTLP() sends headers resolved from the environment", async () => {
		const calls = installTransport(() => new Response(null, { status: 200 }));
		const resolution = resolveOTLPExportOptions(
			{},
			{
				[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: ENDPOINT,
				[OTEL_EXPORTER_OTLP_HEADERS]: "Authorization=Bearer%20env-token,X-Tenant=acme",
			},
		);
		if (resolution.status !== "resolved") throw new Error(`unexpected ${resolution.status}`);

		await exportSpansOTLP([makeSpan({ id: "env-headers-1" })], resolution.options);

		expect(calls[0]?.init?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer env-token",
			"X-Tenant": "acme",
		});
	});

	it("caps concurrent exports and drops batches beyond the queue bound", async () => {
		const warn = mock((_message?: unknown) => {});
		console.warn = warn;
		const release: Array<() => void> = [];
		const calls = installTransport(
			() =>
				new Promise<Response>((resolve) => {
					release.push(() => resolve(new Response(null, { status: 200 })));
				}),
		);
		const { maxInFlight, maxQueued } = OTLP_EXPORT_LIMITS;
		const overflow = 3;
		const total = maxInFlight + maxQueued + overflow;
		const settled: boolean[] = [];
		const pending = Array.from({ length: total }, (_unused, index) =>
			exportSpansOTLP([makeSpan({ id: `queued-${index}` })], { endpoint: ENDPOINT }).then(() => {
				settled[index] = true;
			}),
		);
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));

			expect(calls).toHaveLength(maxInFlight);
			expect(settled.filter(Boolean)).toHaveLength(overflow);
			for (let index = total - overflow; index < total; index += 1) {
				expect(settled[index]).toBe(true);
			}
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(
				"[apifuse] OTLP export failed (export queue is full); 1 batch dropped.",
			);

			let completed = 0;
			while (release.length > 0) {
				release.shift()?.();
				completed += 1;
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(calls.length - completed).toBeLessThanOrEqual(maxInFlight);
			}
			await Promise.all(pending);
			expect(calls).toHaveLength(maxInFlight + maxQueued);
		} finally {
			// Never leave an in-flight delivery unsettled: the queue state is shared across test files.
			while (release.length > 0) release.shift()?.();
			await Promise.all(pending);
		}
	});
});

describe("otlp endpoint resolution", () => {
	function resolvedEndpoint(env: Record<string, string | undefined>, explicit?: string): string {
		const resolution = resolveOTLPExportOptions({ endpoint: explicit }, env);
		if (resolution.status !== "resolved") throw new Error(`unexpected ${resolution.status}`);
		return resolution.options.endpoint;
	}

	it("uses OTEL_EXPORTER_OTLP_TRACES_ENDPOINT verbatim", () => {
		const verbatim = "http://collector.test:4318/custom/traces/";
		expect(resolvedEndpoint({ [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: verbatim })).toBe(verbatim);
		expect(
			resolvedEndpoint({ [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test:4318" }),
		).toBe("http://collector.test:4318");
	});

	it("appends v1/traces to OTEL_EXPORTER_OTLP_ENDPOINT while preserving the configured path", () => {
		const cases: Array<[string, string]> = [
			["http://collector.test:4318", "http://collector.test:4318/v1/traces"],
			["http://collector.test:4318/", "http://collector.test:4318/v1/traces"],
			["http://collector.test:4318//", "http://collector.test:4318//v1/traces"],
			["http://collector.test:4318/tenant", "http://collector.test:4318/tenant/v1/traces"],
			["http://collector.test:4318/tenant/", "http://collector.test:4318/tenant/v1/traces"],
			["http://collector.test:4318/tenant//", "http://collector.test:4318/tenant//v1/traces"],
			["https://collector.test/x?tenant=1", "https://collector.test/x/v1/traces?tenant=1"],
		];
		for (const [base, expected] of cases) {
			expect(resolvedEndpoint({ [OTEL_EXPORTER_OTLP_ENDPOINT]: base })).toBe(expected);
		}
	});

	it("prefers the traces endpoint over the base endpoint and explicit config over both", () => {
		const env = {
			[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://traces.test/v1/traces",
			[OTEL_EXPORTER_OTLP_ENDPOINT]: "http://base.test",
		};
		expect(resolvedEndpoint(env)).toBe("http://traces.test/v1/traces");
		expect(resolvedEndpoint(env, "http://explicit.test/v1/traces")).toBe(
			"http://explicit.test/v1/traces",
		);
		expect(resolvedEndpoint({ [OTEL_EXPORTER_OTLP_ENDPOINT]: "http://base.test" })).toBe(
			"http://base.test/v1/traces",
		);
	});

	it("treats only unset and empty endpoints as unconfigured; whitespace fails closed", () => {
		expect(resolveOTLPExportOptions({}, {})).toEqual({ status: "unconfigured" });
		expect(
			resolveOTLPExportOptions(
				{ endpoint: "" },
				{ [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "", [OTEL_EXPORTER_OTLP_ENDPOINT]: "" },
			),
		).toEqual({ status: "unconfigured" });
		expect(
			resolveOTLPExportOptions(
				{},
				{
					[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: " ",
					[OTEL_EXPORTER_OTLP_ENDPOINT]: "http://base.test",
				},
			),
		).toEqual({
			status: "invalid",
			source: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
			reason: "is not an absolute http(s) URL",
		});
	});

	it("fails closed on an endpoint that is not an absolute http(s) URL, naming only its source", () => {
		const notAUrl = "is not an absolute http(s) URL";
		expect(
			resolveOTLPExportOptions({}, { [OTEL_EXPORTER_OTLP_ENDPOINT]: "localhost:4318" }),
		).toEqual({
			status: "invalid",
			source: OTEL_EXPORTER_OTLP_ENDPOINT,
			reason: notAUrl,
		});
		expect(
			resolveOTLPExportOptions(
				{},
				{
					[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "not a url",
					[OTEL_EXPORTER_OTLP_ENDPOINT]: "http://base.test",
				},
			),
		).toEqual({ status: "invalid", source: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, reason: notAUrl });
		expect(
			resolveOTLPExportOptions(
				{ endpoint: "ftp://collector.test/v1/traces" },
				{ [OTEL_EXPORTER_OTLP_ENDPOINT]: "http://base.test" },
			),
		).toEqual({ status: "invalid", source: "the configured OTLP endpoint", reason: notAUrl });
	});

	it("fails closed on an endpoint that embeds credentials, without echoing them", () => {
		const resolution = resolveOTLPExportOptions(
			{},
			{ [OTEL_EXPORTER_OTLP_ENDPOINT]: "http://collector-user:collector-pass@collector.test:4318" },
		);
		expect(resolution).toMatchObject({ status: "invalid", source: OTEL_EXPORTER_OTLP_ENDPOINT });
		const serialized = JSON.stringify(resolution);
		expect(serialized).toContain(OTEL_EXPORTER_OTLP_HEADERS);
		expect(serialized).not.toContain("collector-pass");
		expect(serialized).not.toContain("collector.test");
	});

	it("fails closed once on header names or values that cannot be sent", () => {
		const endpoint = { [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: ENDPOINT };
		const reason = "contains an HTTP header name or value that cannot be sent";
		expect(
			resolveOTLPExportOptions({}, { ...endpoint, [OTEL_EXPORTER_OTLP_HEADERS]: "X-Foo%20Bar=1" }),
		).toEqual({ status: "invalid", source: OTEL_EXPORTER_OTLP_HEADERS, reason });
		expect(
			resolveOTLPExportOptions(
				{},
				{
					...endpoint,
					[OTEL_EXPORTER_OTLP_TRACES_HEADERS]: "X-Line=a%0Ab",
					[OTEL_EXPORTER_OTLP_HEADERS]: "X-Fine=1",
				},
			),
		).toEqual({ status: "invalid", source: OTEL_EXPORTER_OTLP_TRACES_HEADERS, reason });
		expect(resolveOTLPExportOptions({ headers: { "X Bad": "1" } }, endpoint)).toEqual({
			status: "invalid",
			source: "the configured OTLP headers",
			reason,
		});
	});
});

describe("otlp header resolution", () => {
	function resolvedHeaders(
		env: Record<string, string | undefined>,
		explicit?: Record<string, string>,
	): Record<string, string> | undefined {
		const resolution = resolveOTLPExportOptions(
			{ headers: explicit },
			{ [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: ENDPOINT, ...env },
		);
		if (resolution.status !== "resolved") throw new Error(`unexpected ${resolution.status}`);
		return resolution.options.headers;
	}

	it("parses key=value pairs, trimming whitespace and percent-decoding", () => {
		expect(
			resolvedHeaders({
				[OTEL_EXPORTER_OTLP_HEADERS]:
					" Authorization = Bearer%20abc , X-Tenant=t%3D1,,novalue,=empty,X-Trailing= ",
			}),
		).toEqual({ Authorization: "Bearer abc", "X-Tenant": "t=1", "X-Trailing": "" });
	});

	it("uses OTEL_EXPORTER_OTLP_TRACES_HEADERS as a whole in place of OTEL_EXPORTER_OTLP_HEADERS", () => {
		expect(
			resolvedHeaders({
				[OTEL_EXPORTER_OTLP_TRACES_HEADERS]: "X-Signal=traces",
				[OTEL_EXPORTER_OTLP_HEADERS]: "X-Generic=all",
			}),
		).toEqual({ "X-Signal": "traces" });
		expect(resolvedHeaders({ [OTEL_EXPORTER_OTLP_HEADERS]: "X-Generic=all" })).toEqual({
			"X-Generic": "all",
		});
	});

	it("lets explicit headers replace environment headers per key, case-insensitively", () => {
		expect(
			resolvedHeaders(
				{ [OTEL_EXPORTER_OTLP_HEADERS]: "X-Tenant=env,X-Extra=1" },
				{ "X-Tenant": "cfg" },
			),
		).toEqual({ "X-Tenant": "cfg", "X-Extra": "1" });
		expect(
			resolvedHeaders({ [OTEL_EXPORTER_OTLP_HEADERS]: "authorization=a" }, { Authorization: "b" }),
		).toEqual({ Authorization: "b" });
		expect(
			resolvedHeaders({ [OTEL_EXPORTER_OTLP_HEADERS]: "X-Tenant=first,x-tenant=second" }),
		).toEqual({ "x-tenant": "second" });
	});

	it("keeps a value with an invalid percent-escape verbatim and omits headers when none resolve", () => {
		expect(resolvedHeaders({ [OTEL_EXPORTER_OTLP_HEADERS]: "X-Raw=100%" })).toEqual({
			"X-Raw": "100%",
		});
		expect(resolvedHeaders({})).toBeUndefined();
		expect(resolvedHeaders({ [OTEL_EXPORTER_OTLP_HEADERS]: "novalue" })).toBeUndefined();
	});
});

describe("otlp resource attribute resolution", () => {
	const defaults = { request_id: "req-1", provider_id: "test-provider", operation_id: "echo" };

	it("resolves service.name as explicit, then OTEL_SERVICE_NAME, then OTEL_RESOURCE_ATTRIBUTES", () => {
		const env = {
			[OTEL_SERVICE_NAME]: "from-service-name",
			[OTEL_RESOURCE_ATTRIBUTES]: "service.name=from-resource-attributes",
		};
		expect(
			resolveOTLPResourceAttributes({ ...defaults, "service.name": "explicit" }, env).attributes,
		).toMatchObject({ "service.name": "explicit" });
		expect(resolveOTLPResourceAttributes(defaults, env).attributes).toMatchObject({
			"service.name": "from-service-name",
		});
		expect(
			resolveOTLPResourceAttributes(defaults, {
				[OTEL_RESOURCE_ATTRIBUTES]: "service.name=from-resource-attributes",
			}).attributes,
		).toMatchObject({ "service.name": "from-resource-attributes" });
		expect(resolveOTLPResourceAttributes(defaults, { [OTEL_SERVICE_NAME]: "" })).toEqual({
			attributes: defaults,
			discarded: [],
		});
	});

	it("merges OTEL_RESOURCE_ATTRIBUTES under explicit attributes per key", () => {
		expect(
			resolveOTLPResourceAttributes(defaults, {
				[OTEL_RESOURCE_ATTRIBUTES]:
					"deployment.environment=prod, region=eu%2Dwest ,provider_id=env-loses, ,k8s.pod=a,",
			}),
		).toEqual({
			attributes: {
				...defaults,
				"deployment.environment": "prod",
				region: "eu-west",
				"k8s.pod": "a",
			},
			discarded: [],
		});
		expect(resolveOTLPResourceAttributes(defaults, {})).toEqual({
			attributes: defaults,
			discarded: [],
		});
	});

	it("keeps a __proto__ resource key as an ordinary own attribute", () => {
		const resolution = resolveOTLPResourceAttributes(defaults, {
			[OTEL_RESOURCE_ATTRIBUTES]: "__proto__=1,constructor=2",
		});
		expect(Object.hasOwn(resolution.attributes, "__proto__")).toBe(true);
		expect(Object.entries(resolution.attributes)).toEqual(
			expect.arrayContaining([
				["__proto__", "1"],
				["constructor", "2"],
			]),
		);
		expect(resolution.discarded).toEqual([]);
	});

	it("discards the whole OTEL_RESOURCE_ATTRIBUTES value when any member is malformed", () => {
		for (const value of [
			"deployment.environment=prod,broken",
			"region=eu%ZZ",
			"=novalue",
			"a%ZZ=1",
		]) {
			expect(
				resolveOTLPResourceAttributes(defaults, { [OTEL_RESOURCE_ATTRIBUTES]: value }),
			).toEqual({
				attributes: defaults,
				discarded: [OTEL_RESOURCE_ATTRIBUTES],
			});
		}
	});
});
