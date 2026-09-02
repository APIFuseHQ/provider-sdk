import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
	exportSpansOTLP,
	OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_EXPORTER_OTLP_HEADERS,
	OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
	OTEL_EXPORTER_OTLP_TRACES_HEADERS,
	OTEL_RESOURCE_ATTRIBUTES,
	OTEL_SERVICE_NAME,
	resolveOTLPExportOptions,
	resolveOTLPResourceAttributes,
	spansToOTLP,
} from "../runtime/otlp.js";
import type { TraceSpan } from "../types.js";

function createFetchMock(
	implementation: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(implementation, { preconnect: global.fetch.preconnect });
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

describe("otlp export", () => {
	let originalFetch: typeof fetch;
	let originalWarn: typeof console.warn;

	beforeEach(() => {
		originalFetch = global.fetch;
		originalWarn = console.warn;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		console.warn = originalWarn;
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

	it("exportSpansOTLP() posts OTLP JSON with merged headers", async () => {
		let requestUrl: string | undefined;
		let requestInit: RequestInit | undefined;

		global.fetch = createFetchMock(
			mock(async (url: string | URL | Request, init?: RequestInit) => {
				requestUrl = typeof url === "string" ? url : url.toString();
				requestInit = init;
				return new Response(null, { status: 200 });
			}),
		);

		await exportSpansOTLP([makeSpan()], {
			endpoint: "http://localhost:4318/v1/traces",
			headers: { Authorization: "Bearer test" },
			timeout: 100,
		});

		expect(requestUrl).toBe("http://localhost:4318/v1/traces");
		expect(requestInit?.method).toBe("POST");
		expect(requestInit?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer test",
		});
		expect(JSON.parse(String(requestInit?.body))).toEqual(spansToOTLP([makeSpan()]));
	});

	it("exportSpansOTLP() swallows fetch errors and warns", async () => {
		const warn = mock(() => {});
		console.warn = warn;
		global.fetch = createFetchMock(
			mock(async () => {
				throw new Error("network down");
			}),
		);

		await expect(
			exportSpansOTLP([makeSpan()], {
				endpoint: "http://localhost:4318/v1/traces",
			}),
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledWith("[apifuse] OTLP export failed (Error); spans were dropped.");
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

	it("exportSpansOTLP() reports a rejected export by status without echoing headers or the endpoint", async () => {
		const warn = mock(() => {});
		console.warn = warn;
		global.fetch = createFetchMock(mock(async () => new Response(null, { status: 401 })));
		const secret = "tok_fake_header_value_9f8e7d6c5b4a";

		await exportSpansOTLP([makeSpan({ id: "status-401" })], {
			endpoint: `http://collector.test/v1/traces?api-key=${secret}`,
			headers: { Authorization: `Bearer ${secret}` },
		});

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"[apifuse] OTLP export failed (HTTP 401); spans were dropped.",
		);
		expect(warn.mock.calls.flat().map(String).join("\n")).not.toContain(secret);
	});

	it("exportSpansOTLP() reports an aborted export as a timeout", async () => {
		const warn = mock(() => {});
		console.warn = warn;
		global.fetch = createFetchMock(
			mock(
				(_url: string | URL | Request, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () =>
							reject(new DOMException("The operation was aborted.", "AbortError")),
						);
					}),
			),
		);

		await exportSpansOTLP([makeSpan({ id: "timeout-1" })], {
			endpoint: "http://collector.test/v1/traces",
			timeout: 5,
		});

		expect(warn).toHaveBeenCalledWith(
			"[apifuse] OTLP export failed (timeout); spans were dropped.",
		);
	});

	it("exportSpansOTLP() sends headers resolved from the environment", async () => {
		let requestInit: RequestInit | undefined;
		global.fetch = createFetchMock(
			mock(async (_url: string | URL | Request, init?: RequestInit) => {
				requestInit = init;
				return new Response(null, { status: 200 });
			}),
		);
		const resolution = resolveOTLPExportOptions(
			{},
			{
				[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces",
				[OTEL_EXPORTER_OTLP_HEADERS]: "Authorization=Bearer%20env-token,X-Tenant=acme",
			},
		);
		if (resolution.status !== "resolved") throw new Error(`unexpected ${resolution.status}`);

		await exportSpansOTLP([makeSpan({ id: "env-headers-1" })], resolution.options);

		expect(requestInit?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer env-token",
			"X-Tenant": "acme",
		});
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

	it("appends /v1/traces to OTEL_EXPORTER_OTLP_ENDPOINT without doubling slashes", () => {
		const cases: Array<[string, string]> = [
			["http://collector.test:4318", "http://collector.test:4318/v1/traces"],
			["http://collector.test:4318/", "http://collector.test:4318/v1/traces"],
			["http://collector.test:4318//", "http://collector.test:4318/v1/traces"],
			[
				"http://collector.test:4318/mycollector",
				"http://collector.test:4318/mycollector/v1/traces",
			],
			[
				"http://collector.test:4318/mycollector/",
				"http://collector.test:4318/mycollector/v1/traces",
			],
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

	it("treats unset and whitespace-only endpoints as unconfigured", () => {
		expect(resolveOTLPExportOptions({}, {})).toEqual({ status: "unconfigured" });
		expect(
			resolveOTLPExportOptions(
				{ endpoint: " " },
				{ [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "", [OTEL_EXPORTER_OTLP_ENDPOINT]: "\t" },
			),
		).toEqual({ status: "unconfigured" });
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
		const endpoint = { [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces" };
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
			{ [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces", ...env },
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

	it("lets explicit headers override environment headers per key", () => {
		expect(
			resolvedHeaders(
				{ [OTEL_EXPORTER_OTLP_HEADERS]: "X-Tenant=env,X-Extra=1" },
				{ "X-Tenant": "cfg" },
			),
		).toEqual({ "X-Tenant": "cfg", "X-Extra": "1" });
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
			resolveOTLPResourceAttributes({ ...defaults, "service.name": "explicit" }, env),
		).toMatchObject({
			"service.name": "explicit",
		});
		expect(resolveOTLPResourceAttributes(defaults, env)).toMatchObject({
			"service.name": "from-service-name",
		});
		expect(
			resolveOTLPResourceAttributes(defaults, {
				[OTEL_RESOURCE_ATTRIBUTES]: "service.name=from-resource-attributes",
			}),
		).toMatchObject({ "service.name": "from-resource-attributes" });
		expect(resolveOTLPResourceAttributes(defaults, { [OTEL_SERVICE_NAME]: " " })).toEqual(defaults);
	});

	it("merges OTEL_RESOURCE_ATTRIBUTES under explicit attributes per key", () => {
		expect(
			resolveOTLPResourceAttributes(defaults, {
				[OTEL_RESOURCE_ATTRIBUTES]:
					"deployment.environment=prod, region=eu%2Dwest ,provider_id=env-loses",
			}),
		).toEqual({
			...defaults,
			"deployment.environment": "prod",
			region: "eu-west",
		});
		expect(resolveOTLPResourceAttributes(defaults, {})).toEqual(defaults);
	});
});
