import { beforeEach, describe, expect, it, mock } from "bun:test";
import { z } from "zod";

import {
	OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_EXPORTER_OTLP_HEADERS,
	OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
	OTEL_EXPORTER_OTLP_TRACES_HEADERS,
	OTEL_RESOURCE_ATTRIBUTES,
	OTEL_SERVICE_NAME,
	OTLP_EXPORT_LIMITS,
	resetOTLPExportForTests,
	swapOTLPTransportForTests,
} from "../runtime/otlp.js";
import {
	createTraceContext,
	getTraceRecorder,
	resolveTraceContextOptions,
	type TraceRecorder,
} from "../runtime/trace.js";
import {
	APIFUSE__TRACE__ENABLED,
	APIFUSE__TRACE__EXPORTER,
	resolveTraceConfigFromEnv,
} from "../runtime/trace-config.js";
import { createServerApp } from "../server/serve.js";
import { resolveServerTraceContextOptions } from "../server/trace-output.js";
import type { FlowContext, ResolverContext, TraceConfig } from "../types.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const TRACE_CREDENTIAL = "tok_fake_Qj8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS";
const TRACE_ENV_NAMES = [
	APIFUSE__TRACE__ENABLED,
	APIFUSE__TRACE__EXPORTER,
	OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
	OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_EXPORTER_OTLP_TRACES_HEADERS,
	OTEL_EXPORTER_OTLP_HEADERS,
	OTEL_SERVICE_NAME,
	OTEL_RESOURCE_ATTRIBUTES,
];

type OTLPAttribute = {
	key: string;
	value: { stringValue?: string; doubleValue?: number; boolValue?: boolean };
};
type OTLPBody = {
	resourceSpans: Array<{
		resource: { attributes: OTLPAttribute[] };
		scopeSpans: Array<{
			spans: Array<{ name: string; traceId: string; attributes: OTLPAttribute[] }>;
		}>;
	}>;
};
type CapturedExport = { url: string; init?: RequestInit };

function attributeMap(attributes: OTLPAttribute[]): Record<string, string | number | boolean> {
	return Object.fromEntries(
		attributes.map(({ key, value }) => [
			key,
			value.stringValue ?? value.doubleValue ?? value.boolValue ?? "",
		]),
	);
}

/** Installs a recording transport through the engine seam; exports are fire-and-forget, so callers await settleExports(). */
function captureExports(status = 200): { exports: CapturedExport[]; restore: () => void } {
	const exports: CapturedExport[] = [];
	swapOTLPTransportForTests(
		Object.assign(
			async (url: string | URL | Request, init?: RequestInit) => {
				exports.push({ url: typeof url === "string" ? url : url.toString(), init });
				return new Response(null, { status });
			},
			{ preconnect: global.fetch.preconnect },
		),
	);
	return { exports, restore: () => swapOTLPTransportForTests() };
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

async function settleExports(exports: CapturedExport[], expected = 1): Promise<void> {
	for (let attempt = 0; attempt < 50 && exports.length < expected; attempt += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	// Let exportSpansOTLP observe the mocked response and run its finally/warn path.
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
	resetOTLPExportForTests();
});

const provider = createProviderDefinitionDouble({
	operations: {
		echo: {
			riskClass: "read",
			input: z.object({ value: z.string() }),
			output: z.object({ value: z.string() }),
			handler: async (ctx, input) => {
				const parsed = z.object({ value: z.string() }).parse(input);
				return ctx.trace.span("provider.echo", async () => ({ value: parsed.value }));
			},
		},
		fail: {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			handler: async (ctx) => {
				const recorder = getTraceRecorder(ctx.trace);
				if (!recorder) throw new Error("trace recorder missing");
				return recorder.runSpan(
					"provider.failure",
					async () => {
						throw new Error(`upstream rejected authorization=Bearer ${TRACE_CREDENTIAL}`);
					},
					{
						attributes: {
							authorization: `Bearer ${TRACE_CREDENTIAL}`,
							upstream_url: `https://vendor.test/items?access_token=${TRACE_CREDENTIAL}`,
							diagnostic: `useful context ${"x".repeat(400)}`,
						},
					},
				);
			},
		},
		get_flea_market_item: {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			handler: async (ctx) => {
				const recorder = getTraceRecorder(ctx.trace);
				if (!recorder) throw new Error("trace recorder missing");
				for (const name of [
					"http.get",
					"resolver.solve",
					"resolver.vendor.attempt",
					"stealth.redirects.run",
					"browser.close",
				]) {
					await recorder.runSpan(name, async () => undefined);
				}
				await recorder.runSpan("name:\u0000\u001bline\n", async () => undefined);
				return { ok: true };
			},
		},
	},
});

function withTraceEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
	const previous = new Map<string, string | undefined>();
	for (const name of TRACE_ENV_NAMES) {
		previous.set(name, process.env[name]);
		const value = values[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	return run().finally(() => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
}

async function invokeEcho(
	input: {
		requestId?: string;
		headers?: Record<string, string>;
		bodyHeaders?: Record<string, string>;
	} = {},
): Promise<Response> {
	return createServerApp(provider, {
		allowMemoryStateFallback: true,
		logger: () => {},
	}).request("/v1/echo", {
		method: "POST",
		headers: { "content-type": "application/json", ...input.headers },
		body: JSON.stringify({
			requestId: input.requestId ?? "trace-output-test",
			input: { value: "hello" },
			...(input.bodyHeaders ? { headers: input.bodyHeaders } : {}),
		}),
	});
}

async function invokeFailure(): Promise<Response> {
	return createServerApp(provider, {
		allowMemoryStateFallback: true,
		logger: () => {},
	}).request("/v1/fail", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "trace-secret-test", input: {} }),
	});
}

async function invokeSpanNames(): Promise<Response> {
	return createServerApp(provider, {
		allowMemoryStateFallback: true,
		logger: () => {},
	}).request("/v1/get_flea_market_item", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "trace-name-test", input: {} }),
	});
}

function createLocalFetchDouble(
	implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(implementation, {
		preconnect: () => {},
	});
}

async function exerciseAuthNamespaces(ctx: FlowContext, route: string) {
	await ctx.http.get("https://auth-trace.test/ping");
	if (!ctx.state) throw new Error("auth trace test requires runtime state");
	await ctx.state
		.namespace("auth_trace", {
			defaultTtl: "1m",
			maxTtl: "1h",
			maxEntries: 10,
			maxValueBytes: 1_024,
		})
		.get(route);
	return { kind: "message", turnId: `turn-${route}`, data: { route } };
}

const authTraceProvider = createProviderDefinitionDouble({
	auth: {
		mode: "credentials",
		flow: {
			start: async (ctx) => exerciseAuthNamespaces(ctx, "start"),
			continue: async (ctx) => exerciseAuthNamespaces(ctx, "continue"),
			poll: async (ctx) => exerciseAuthNamespaces(ctx, "poll"),
			refresh: async (ctx) => exerciseAuthNamespaces(ctx, "refresh"),
			abort: async (ctx) => exerciseAuthNamespaces(ctx, "disconnect"),
		},
	},
	operations: provider.operations,
});

describe("server trace output wiring", () => {
	it("keeps the default in-memory trace behavior silent", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		try {
			await withTraceEnv({}, async () => {
				const response = await invokeEcho();
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ data: { value: "hello" } });
			});
		} finally {
			console.log = originalLog;
		}
		expect(output).toEqual([]);
	});

	it("keeps server trace output silent when disabled with the console exporter", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		try {
			await withTraceEnv(
				{ [APIFUSE__TRACE__ENABLED]: "false", [APIFUSE__TRACE__EXPORTER]: "console" },
				async () => {
					const response = await invokeEcho();
					expect(response.status).toBe(200);
				},
			);
		} finally {
			console.log = originalLog;
		}
		expect(output).toEqual([]);
	});

	it("emits JSON spans for the json exporter", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		try {
			await withTraceEnv(
				{ [APIFUSE__TRACE__ENABLED]: "true", [APIFUSE__TRACE__EXPORTER]: "json" },
				async () => {
					const response = await invokeEcho();
					expect(response.status).toBe(200);
				},
			);
		} finally {
			console.log = originalLog;
		}

		const spans = output.map(
			(line) => JSON.parse(line) as { id: string; name: string; parentId?: string },
		);
		const roots = spans.filter((span) => span.name === "request:operation:echo");
		expect(roots).toHaveLength(1);
		expect(spans.find((span) => span.name === "handler:echo")?.parentId).toBe(roots[0]?.id);
	});

	it("parents auth resolver and vendor spans under the request root", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		const resolver = {
			async solve(_challenge: unknown, _signal?: AbortSignal, traceRecorder?: TraceRecorder) {
				if (!traceRecorder) throw new Error("resolver trace recorder missing");
				return traceRecorder.runSpan("resolver.vendor.attempt", async () => ({
					form: "token" as const,
					token: "solved",
				}));
			},
		} as ResolverContext;
		const resolverProvider = createProviderDefinitionDouble({
			auth: {
				mode: "credentials",
				flow: {
					start: async () => ({ kind: "form", turnId: "start" }),
					continue: async (ctx) => {
						await ctx.resolver.solve({
							kind: "turnstile",
							siteKey: "site-key",
							pageUrl: "https://example.com/challenge",
						});
						return { kind: "complete", turnId: "complete" };
					},
				},
			},
			operations: provider.operations,
		});

		try {
			await withTraceEnv(
				{ [APIFUSE__TRACE__ENABLED]: "true", [APIFUSE__TRACE__EXPORTER]: "json" },
				async () => {
					const response = await createServerApp(resolverProvider, {
						allowMemoryStateFallback: true,
						logger: () => {},
						resolver,
					}).request("/auth/continue", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							requestId: "auth-resolver-trace",
							flowId: "flow-resolver-trace",
							input: {},
						}),
					});
					expect(response.status).toBe(200);
				},
			);
		} finally {
			console.log = originalLog;
		}

		const spans = output.map(
			(line) => JSON.parse(line) as { id: string; name: string; parentId?: string },
		);
		const root = spans.find((span) => span.name === "request:auth:continue");
		const solve = spans.find((span) => span.name === "resolver.solve");
		const vendor = spans.find((span) => span.name === "resolver.vendor.attempt");
		expect(root).toBeDefined();
		expect(solve?.parentId).toBe(root?.id);
		expect(vendor?.parentId).toBe(solve?.id);
	});

	it("emits HTTP and state spans under one request root on every auth route", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		const originalFetch = global.fetch;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		global.fetch = createLocalFetchDouble(async () => Response.json({ ok: true }));
		const routes = ["start", "continue", "poll", "refresh", "disconnect"] as const;

		try {
			await withTraceEnv(
				{ [APIFUSE__TRACE__ENABLED]: "true", [APIFUSE__TRACE__EXPORTER]: "json" },
				async () => {
					const app = createServerApp(authTraceProvider, {
						allowMemoryStateFallback: true,
						logger: () => {},
					});
					for (const route of routes) {
						const response = await app.request(`/auth/${route}`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								requestId: `auth-route-${route}`,
								flowId: `flow-${route}`,
								input: {},
							}),
						});
						expect(response.status).toBe(200);
					}
				},
			);
		} finally {
			global.fetch = originalFetch;
			console.log = originalLog;
		}

		const spans = output.map(
			(line) =>
				JSON.parse(line) as {
					id: string;
					name: string;
					parentId?: string;
					attributes: Record<string, string | number | boolean>;
				},
		);
		for (const route of routes) {
			const requestSpans = spans.filter(
				(span) => span.attributes.request_id === `auth-route-${route}`,
			);
			const roots = requestSpans.filter((span) => span.name === `request:auth:${route}`);
			expect(roots).toHaveLength(1);
			const root = roots[0];
			for (const name of ["http.get", "state.get"]) {
				const span = requestSpans.find((candidate) => candidate.name === name);
				expect(span).toBeDefined();
				expect(span?.parentId).toBe(root?.id);
			}
		}
	});

	it("emits JSON spans with names and durations for the console exporter", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		try {
			await withTraceEnv(
				{ [APIFUSE__TRACE__ENABLED]: "true", [APIFUSE__TRACE__EXPORTER]: "console" },
				async () => {
					const response = await invokeEcho();
					expect(response.status).toBe(200);
				},
			);
		} finally {
			console.log = originalLog;
		}

		const spans = output.map(
			(line) =>
				JSON.parse(line) as {
					name: string;
					duration_ms: number;
					attributes: Record<string, string | number | boolean>;
				},
		);
		const span = spans.find((candidate) => candidate.name === "handler:echo");
		expect(span).toBeDefined();
		expect(span?.duration_ms).toBeGreaterThanOrEqual(0);
		expect(span?.attributes).toMatchObject({
			request_id: "trace-output-test",
			provider_id: "test-provider",
			operation_id: "echo",
		});
	});

	it("retains SDK-authored span names and neutralizes name controls", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		try {
			await withTraceEnv(
				{ [APIFUSE__TRACE__ENABLED]: "true", [APIFUSE__TRACE__EXPORTER]: "console" },
				async () => {
					const response = await invokeSpanNames();
					expect(response.status).toBe(200);
				},
			);
		} finally {
			console.log = originalLog;
		}

		const names = output.map((line) => (JSON.parse(line) as { name: string }).name);
		expect(names).toContain("handler:get_flea_market_item");
		for (const name of [
			"http.get",
			"resolver.solve",
			"resolver.vendor.attempt",
			"stealth.redirects.run",
			"browser.close",
		]) {
			expect(names).toContain(name);
		}
		expect(names).toContain("name:\\u0000\\u001bline ");
	});

	it("redacts and bounds untrusted error and attribute strings before console output", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		try {
			await withTraceEnv(
				{ [APIFUSE__TRACE__ENABLED]: "true", [APIFUSE__TRACE__EXPORTER]: "console" },
				async () => {
					const response = await invokeFailure();
					expect(response.status).toBe(500);
				},
			);
		} finally {
			console.log = originalLog;
		}

		const serialized = output.join("\n");
		expect(serialized.includes(TRACE_CREDENTIAL)).toBe(false);
		const span = output
			.map(
				(line) =>
					JSON.parse(line) as {
						name: string;
						error?: string;
						attributes: Record<string, string | number | boolean>;
					},
			)
			.find((candidate) => candidate.name === "provider.failure");
		expect(span?.error).toContain("upstream rejected");
		expect(span?.error).toContain("[REDACTED]");
		expect(span?.attributes.authorization).toBe("[REDACTED]");
		expect(span?.attributes.upstream_url).toContain("[REDACTED]");
		expect(span?.attributes.diagnostic).toEndWith("… [truncated]");
	});

	it("does not add server console output to shared programmatic trace options", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		try {
			const trace = createTraceContext(
				resolveTraceContextOptions({ enabled: true, exporter: "console" }),
			);
			await trace.span("perf.programmatic", async () => undefined);
		} finally {
			console.log = originalLog;
		}
		expect(output).toEqual([]);
	});

	it("keeps long SDK-authored span names verbatim within the output bound", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		const authoredName = `handler:${"long_operation_id_".repeat(10)}`;
		try {
			const trace = createTraceContext(
				resolveServerTraceContextOptions({ enabled: true, exporter: "console" }, {}),
			);
			await trace.span(authoredName, async () => undefined);
		} finally {
			console.log = originalLog;
		}
		expect((JSON.parse(output[0] ?? "{}") as { name?: string }).name).toBe(authoredName);
	});

	it("warns once and fails closed to none for an invalid exporter value", () => {
		const warn = mock(() => {});
		const originalWarn = console.warn;
		console.warn = warn;
		try {
			const env = {
				[APIFUSE__TRACE__ENABLED]: "true",
				[APIFUSE__TRACE__EXPORTER]: "zipkin",
			};
			expect(resolveTraceConfigFromEnv(env)).toEqual({ enabled: true, exporter: "none" });
			expect(resolveTraceConfigFromEnv(env)).toEqual({ enabled: true, exporter: "none" });
		} finally {
			console.warn = originalWarn;
		}
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			'[apifuse] Invalid APIFUSE__TRACE__EXPORTER value "zipkin"; supported exporters are "console", "json", "otlp", and "none"; falling back to exporter "none".',
		);
	});

	it("accepts otlp as a server exporter and leaves console, json, and none unchanged", () => {
		const warn = mock(() => {});
		const originalWarn = console.warn;
		console.warn = warn;
		try {
			expect(
				resolveTraceConfigFromEnv({
					[APIFUSE__TRACE__ENABLED]: "true",
					[APIFUSE__TRACE__EXPORTER]: " OTLP ",
				}),
			).toEqual({ enabled: true, exporter: "otlp" });
			for (const exporter of ["console", "json", "none"] as const) {
				expect(resolveTraceConfigFromEnv({ [APIFUSE__TRACE__EXPORTER]: exporter })).toEqual({
					exporter,
				});
			}
		} finally {
			console.warn = originalWarn;
		}
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns once and falls back to disabled for an invalid enabled value", () => {
		const warn = mock(() => {});
		const originalWarn = console.warn;
		console.warn = warn;
		try {
			const env = { [APIFUSE__TRACE__ENABLED]: "definitely" };
			expect(resolveTraceConfigFromEnv(env)).toEqual({ enabled: false });
			expect(resolveTraceConfigFromEnv(env)).toEqual({ enabled: false });
		} finally {
			console.warn = originalWarn;
		}
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"[apifuse] Invalid APIFUSE__TRACE__ENABLED; falling back to disabled tracing.",
		);
	});
});

describe("server OTLP trace output wiring", () => {
	const requestAttributes = {
		request_id: "req-1",
		provider_id: "test-provider",
		operation_id: "echo",
	};
	const otlpConfig = {
		enabled: true,
		exporter: "otlp",
		otlp: {
			endpoint: "http://collector.test/v1/traces",
			headers: { "X-Tenant": "acme" },
			timeout: 250,
		},
	} as const;

	it("forwards export options and resource attributes for the otlp exporter", () => {
		const options = resolveServerTraceContextOptions(otlpConfig, requestAttributes, {});

		expect(options.exportOptions).toEqual({
			endpoint: "http://collector.test/v1/traces",
			headers: { "X-Tenant": "acme" },
			timeout: 250,
		});
		expect(options.resourceAttributes).toEqual(requestAttributes);
		expect(options.onSpan).toBeUndefined();
		expect(typeof options.sanitizeSpanForExport).toBe("function");
	});

	it("keeps console, json, none, and disabled options free of export plumbing", () => {
		const env = {
			[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces",
			[OTEL_SERVICE_NAME]: "ignored",
		};
		for (const config of [
			{ enabled: true, exporter: "console" },
			{ enabled: true, exporter: "json" },
			{ enabled: true, exporter: "none" },
			{ enabled: false, exporter: "otlp" },
		] as const) {
			const options = resolveServerTraceContextOptions(config, requestAttributes, env);
			expect(Object.keys(options).sort()).toEqual(["maxSpans", "onSpan"]);
			expect(options.onSpan === undefined).toBe(
				config.exporter === "none" || config.enabled === false,
			);
		}
	});

	it("resolves the endpoint, headers, and resource attributes from the OTel environment", () => {
		const options = resolveServerTraceContextOptions(
			{ enabled: true, exporter: "otlp" },
			requestAttributes,
			{
				[OTEL_EXPORTER_OTLP_ENDPOINT]: "http://collector.test:4318/",
				[OTEL_EXPORTER_OTLP_HEADERS]: "Authorization=Bearer%20env-token",
				[OTEL_SERVICE_NAME]: "apifuse-provider-under-test-production",
				[OTEL_RESOURCE_ATTRIBUTES]:
					"deployment.environment=prod,service.name=overridden,k8s.pod.name=provider-under-test-7d9f8b6c5d-x2k9q,telemetry.distro.version=1.0.0,region=eu%1Bwest,api_key=operator-secret",
			},
		);

		expect(options.exportOptions).toEqual({
			endpoint: "http://collector.test:4318/v1/traces",
			headers: { Authorization: "Bearer env-token" },
		});
		expect(options.resourceAttributes).toEqual({
			...requestAttributes,
			"service.name": "apifuse-provider-under-test-production",
			"deployment.environment": "prod",
			"k8s.pod.name": "provider-under-test-7d9f8b6c5d-x2k9q",
			"telemetry.distro.version": "1.0.0",
			region: "eu\\u001bwest",
			api_key: "[REDACTED]",
		});
	});

	it("accepts a typed otlp config without an endpoint and resolves it from the environment", () => {
		const config: TraceConfig = {
			enabled: true,
			exporter: "otlp",
			otlp: { headers: { "X-Tenant": "acme" }, timeout: 250 },
		};
		const options = resolveServerTraceContextOptions(config, requestAttributes, {
			[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces",
		});
		expect(options.exportOptions).toEqual({
			endpoint: "http://collector.test/v1/traces",
			headers: { "X-Tenant": "acme" },
			timeout: 250,
		});
	});

	it("ignores an unparseable OTEL_RESOURCE_ATTRIBUTES value and warns once without echoing it", () => {
		const warn = mock((_message?: unknown) => {});
		const originalWarn = console.warn;
		console.warn = warn;
		try {
			const env = {
				[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces",
				[OTEL_RESOURCE_ATTRIBUTES]: `deployment.environment=prod,${TRACE_CREDENTIAL}`,
			};
			const options = resolveServerTraceContextOptions(otlpConfig, requestAttributes, env);
			resolveServerTraceContextOptions(otlpConfig, requestAttributes, env);
			expect(options.resourceAttributes).toEqual(requestAttributes);
		} finally {
			console.warn = originalWarn;
		}
		expect(warn).toHaveBeenCalledTimes(1);
		const message = String(warn.mock.calls[0]?.[0]);
		expect(message).toContain(OTEL_RESOURCE_ATTRIBUTES);
		expect(message).not.toContain(TRACE_CREDENTIAL);
		expect(message).not.toContain("prod");
	});

	it("warns once per environment and disables export when no endpoint is resolvable", async () => {
		const warn = mock(() => {});
		const originalWarn = console.warn;
		console.warn = warn;
		const capture = captureExports();
		try {
			const env = {};
			const first = resolveServerTraceContextOptions(
				{ enabled: true, exporter: "otlp" },
				requestAttributes,
				env,
			);
			const second = resolveServerTraceContextOptions(
				{ enabled: true, exporter: "otlp" },
				requestAttributes,
				env,
			);
			expect(Object.keys(first).sort()).toEqual(["maxSpans", "onSpan"]);
			expect(Object.keys(second).sort()).toEqual(["maxSpans", "onSpan"]);

			const trace = createTraceContext(first);
			await expect(trace.span("provider.noop", async () => "ok")).resolves.toBe("ok");
			await settleExports(capture.exports, 1);
			expect(capture.exports).toEqual([]);
		} finally {
			capture.restore();
			console.warn = originalWarn;
		}
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"[apifuse] OTLP trace export is enabled but no endpoint is configured; set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT. Trace export is disabled.",
		);
	});

	it("names the offending variable but never its value for an invalid endpoint", () => {
		const warn = mock((_message?: unknown) => {});
		const originalWarn = console.warn;
		console.warn = warn;
		try {
			const env = {
				[OTEL_EXPORTER_OTLP_ENDPOINT]: `collector.internal:4318?token=${TRACE_CREDENTIAL}`,
			};
			const options = resolveServerTraceContextOptions(
				{ enabled: true, exporter: "otlp" },
				requestAttributes,
				env,
			);
			resolveServerTraceContextOptions({ enabled: true, exporter: "otlp" }, requestAttributes, env);
			expect("exportOptions" in options).toBe(false);
		} finally {
			console.warn = originalWarn;
		}
		expect(warn).toHaveBeenCalledTimes(1);
		const message = String(warn.mock.calls[0]?.[0]);
		expect(message).toContain(OTEL_EXPORTER_OTLP_ENDPOINT);
		expect(message).not.toContain(TRACE_CREDENTIAL);
		expect(message).not.toContain("collector.internal");
	});

	it("sanitizes exported spans and resource attributes without touching recorded spans", async () => {
		const options = resolveServerTraceContextOptions(
			otlpConfig,
			{ request_id: "req\u0000\u001b", provider_id: "p", api_key: TRACE_CREDENTIAL },
			{},
		);
		expect(options.resourceAttributes).toEqual({
			request_id: "req\\u0000\\u001b",
			provider_id: "p",
			api_key: "[REDACTED]",
		});

		const capture = captureExports();
		try {
			const trace = createTraceContext(options);
			const recorder = getTraceRecorder(trace);
			if (!recorder) throw new Error("trace recorder missing");
			await recorder.runSpan("provider.secret", async () => undefined, {
				attributes: { authorization: `Bearer ${TRACE_CREDENTIAL}`, method: "GET", status: 200 },
			});
			await settleExports(capture.exports, 1);

			expect(trace.getSpans()[0]?.attributes.authorization).toBe(`Bearer ${TRACE_CREDENTIAL}`);
			const serialized = String(capture.exports[0]?.init?.body);
			expect(serialized).not.toContain(TRACE_CREDENTIAL);
			const body = JSON.parse(serialized) as OTLPBody;
			const span = body.resourceSpans[0]?.scopeSpans[0]?.spans[0];
			expect(span?.name).toBe("provider.secret");
			expect(attributeMap(span?.attributes ?? [])).toMatchObject({
				authorization: "[REDACTED]",
				method: "GET",
				status: 200,
			});
			expect(attributeMap(body.resourceSpans[0]?.resource.attributes ?? [])).toEqual({
				request_id: "req\\u0000\\u001b",
				provider_id: "p",
				api_key: "[REDACTED]",
			});
		} finally {
			capture.restore();
		}
	});

	it("drops the batch and keeps the request when the export sanitizer fails", async () => {
		const warn = mock((_message?: unknown) => {});
		const originalWarn = console.warn;
		console.warn = warn;
		const capture = captureExports();
		try {
			const throwing = createTraceContext({
				...resolveServerTraceContextOptions(otlpConfig, requestAttributes, {}),
				sanitizeSpanForExport: () => {
					throw new Error("sanitizer exploded");
				},
			});
			await expect(throwing.span("provider.throwing", async () => "ok")).resolves.toBe("ok");
			const returningNothing = createTraceContext({
				...resolveServerTraceContextOptions(otlpConfig, requestAttributes, {}),
				sanitizeSpanForExport: () => undefined,
			});
			await expect(returningNothing.span("provider.nothing", async () => "ok")).resolves.toBe("ok");
			await settleExports(capture.exports, 1);
			expect(capture.exports).toEqual([]);
		} finally {
			capture.restore();
			console.warn = originalWarn;
		}
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledWith("[apifuse] OTLP export skipped; span sanitization failed.");
		expect(warn.mock.calls.flat().map(String).join("\n")).not.toContain("sanitizer exploded");
	});

	it("gives the export hook a detached copy so in-place edits never reach recorded spans", async () => {
		const capture = captureExports();
		try {
			const trace = createTraceContext({
				...resolveServerTraceContextOptions(otlpConfig, requestAttributes, {}),
				sanitizeSpanForExport: (span) => {
					span.attributes.authorization = "[REDACTED]";
					return span;
				},
			});
			const recorder = getTraceRecorder(trace);
			if (!recorder) throw new Error("trace recorder missing");
			await recorder.runSpan("provider.in_place", async () => undefined, {
				attributes: { authorization: `Bearer ${TRACE_CREDENTIAL}` },
			});
			await settleExports(capture.exports, 1);
			expect(trace.getSpans()[0]?.attributes.authorization).toBe(`Bearer ${TRACE_CREDENTIAL}`);
			expect(String(capture.exports[0]?.init?.body)).not.toContain(TRACE_CREDENTIAL);
		} finally {
			capture.restore();
		}
	});

	it("does not expose export options or resource attributes on the trace context", () => {
		const trace = createTraceContext(
			resolveServerTraceContextOptions(otlpConfig, requestAttributes, {
				[OTEL_EXPORTER_OTLP_HEADERS]: `Authorization=Bearer%20${TRACE_CREDENTIAL}`,
			}),
		);
		expect(JSON.stringify(trace)).not.toContain(TRACE_CREDENTIAL);
		expect(Object.keys(trace)).toEqual(["span", "getSpans"]);
	});

	it("coalesces roots that complete in the same tick into one export batch", async () => {
		const capture = captureExports();
		try {
			const trace = createTraceContext(
				resolveServerTraceContextOptions(otlpConfig, requestAttributes, {}),
			);
			await Promise.all([
				trace.span("root.a", async () => undefined),
				trace.span("root.b", async () => undefined),
			]);
			await settleExports(capture.exports, 1);
			await settleExports(capture.exports, 2);

			expect(capture.exports).toHaveLength(1);
			const body = JSON.parse(String(capture.exports[0]?.init?.body)) as OTLPBody;
			const names = body.resourceSpans[0]?.scopeSpans[0]?.spans.map((span) => span.name) ?? [];
			expect(names.sort()).toEqual(["root.a", "root.b"]);
		} finally {
			capture.restore();
		}
	});

	it("never has more concurrent collector requests than the in-flight cap", async () => {
		const release: Array<() => void> = [];
		const exports: CapturedExport[] = [];
		swapOTLPTransportForTests(
			Object.assign(
				(url: string | URL | Request, init?: RequestInit) => {
					exports.push({ url: typeof url === "string" ? url : url.toString(), init });
					return new Promise<Response>((resolve) => {
						release.push(() => resolve(new Response(null, { status: 200 })));
					});
				},
				{ preconnect: global.fetch.preconnect },
			),
		);
		const concurrentRequests = OTLP_EXPORT_LIMITS.maxInFlight + 2;
		try {
			await withTraceEnv(
				{
					[APIFUSE__TRACE__ENABLED]: "true",
					[APIFUSE__TRACE__EXPORTER]: "otlp",
					[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces",
				},
				async () => {
					const responses = await Promise.all(
						Array.from({ length: concurrentRequests }, () => invokeEcho()),
					);
					for (const response of responses) expect(response.status).toBe(200);
					await settleExports(exports, OTLP_EXPORT_LIMITS.maxInFlight);
					await settleExports(exports, concurrentRequests);
					expect(exports).toHaveLength(OTLP_EXPORT_LIMITS.maxInFlight);
				},
			);
		} finally {
			while (release.length > 0) {
				release.shift()?.();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			await waitUntil(() => exports.length === concurrentRequests && release.length === 0);
			while (release.length > 0) release.shift()?.();
			swapOTLPTransportForTests();
		}
		expect(exports).toHaveLength(concurrentRequests);
	});

	it("assigns one trace id per trace context and never re-sends an exported span", async () => {
		const capture = captureExports();
		try {
			const first = createTraceContext(
				resolveServerTraceContextOptions(otlpConfig, requestAttributes, {}),
			);
			const second = createTraceContext(
				resolveServerTraceContextOptions(otlpConfig, requestAttributes, {}),
			);
			await first.span("first.root.a", async () => undefined);
			await settleExports(capture.exports, 1);
			await first.span("first.root.b", async () => undefined);
			await second.span("second.root", async () => undefined);
			await settleExports(capture.exports, 3);

			const batches = capture.exports.map((entry) => {
				const body = JSON.parse(String(entry.init?.body)) as OTLPBody;
				const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
				const traceIds = new Set(spans.map((span) => span.traceId));
				expect(traceIds.size).toBe(1);
				return { traceId: [...traceIds][0] ?? "", names: spans.map((span) => span.name) };
			});
			const exportedNames = batches.flatMap((batch) => batch.names);
			expect(exportedNames.sort()).toEqual(["first.root.a", "first.root.b", "second.root"]);
			const firstIds = new Set(
				batches.filter((batch) => batch.names[0]?.startsWith("first.")).map((b) => b.traceId),
			);
			expect(firstIds.size).toBe(1);
			const secondId = batches.find((batch) => batch.names.includes("second.root"))?.traceId;
			expect(secondId).toMatch(/^[0-9a-f]{32}$/);
			expect(firstIds.has(secondId ?? "")).toBe(false);
		} finally {
			capture.restore();
		}
	});

	it("seeds the exported trace id from an inbound traceparent", async () => {
		const capture = captureExports();
		const inboundTraceId = "0123456789abcdef0123456789abcdef";
		try {
			await withTraceEnv(
				{
					[APIFUSE__TRACE__ENABLED]: "true",
					[APIFUSE__TRACE__EXPORTER]: "otlp",
					[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces",
				},
				async () => {
					const response = await invokeEcho({
						requestId: "traceparent-request",
						headers: {
							traceparent: `00-${inboundTraceId}-0123456789abcdef-01`,
						},
					});
					expect(response.status).toBe(200);
					await settleExports(capture.exports, 1);
				},
			);

			expect(capture.exports).toHaveLength(1);
			const body = JSON.parse(String(capture.exports[0]?.init?.body)) as OTLPBody;
			const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
			expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([inboundTraceId]));
		} finally {
			capture.restore();
		}
	});

	it("derives a stable exported trace id from the request id", async () => {
		const capture = captureExports();
		try {
			await withTraceEnv(
				{
					[APIFUSE__TRACE__ENABLED]: "true",
					[APIFUSE__TRACE__EXPORTER]: "otlp",
					[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces",
				},
				async () => {
					for (let invocation = 0; invocation < 2; invocation += 1) {
						const response = await invokeEcho({ requestId: "stable-request-id" });
						expect(response.status).toBe(200);
					}
					await settleExports(capture.exports, 2);
				},
			);

			expect(capture.exports).toHaveLength(2);
			const traceIds = capture.exports.map((entry) => {
				const body = JSON.parse(String(entry.init?.body)) as OTLPBody;
				const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
				const ids = new Set(spans.map((span) => span.traceId));
				expect(ids.size).toBe(1);
				return [...ids][0];
			});
			expect(traceIds[0]).toMatch(/^[0-9a-f]{32}$/);
			expect(traceIds[1]).toBe(traceIds[0]);
		} finally {
			capture.restore();
		}
	});

	it("keeps provider operations unaffected when otlp is enabled without an endpoint", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		const originalWarn = console.warn;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		console.warn = () => {};
		const capture = captureExports();
		try {
			await withTraceEnv(
				{ [APIFUSE__TRACE__ENABLED]: "true", [APIFUSE__TRACE__EXPORTER]: "otlp" },
				async () => {
					const response = await invokeEcho();
					expect(response.status).toBe(200);
					expect(await response.json()).toEqual({ data: { value: "hello" } });
					await settleExports(capture.exports, 1);
				},
			);
		} finally {
			capture.restore();
			console.log = originalLog;
			console.warn = originalWarn;
		}
		expect(capture.exports).toEqual([]);
		expect(output).toEqual([]);
	});

	it("answers the request before the export completes", async () => {
		let releaseExport!: () => void;
		const exportReleased = new Promise<void>((resolve) => {
			releaseExport = resolve;
		});
		const exports: CapturedExport[] = [];
		swapOTLPTransportForTests(
			Object.assign(
				async (url: string | URL | Request, init?: RequestInit) => {
					exports.push({ url: typeof url === "string" ? url : url.toString(), init });
					await exportReleased;
					return new Response(null, { status: 200 });
				},
				{ preconnect: global.fetch.preconnect },
			),
		);
		try {
			await withTraceEnv(
				{
					[APIFUSE__TRACE__ENABLED]: "true",
					[APIFUSE__TRACE__EXPORTER]: "otlp",
					[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces",
				},
				async () => {
					const response = await invokeEcho();
					expect(response.status).toBe(200);
					expect(await response.json()).toEqual({ data: { value: "hello" } });
					// The collector has not answered yet; the request already has.
					await settleExports(exports, 1);
					expect(exports).toHaveLength(1);
					releaseExport();
					await settleExports(exports, 1);
				},
			);
		} finally {
			swapOTLPTransportForTests();
		}
	});

	it("exports sanitized spans to the endpoint resolved from the environment", async () => {
		const output: string[] = [];
		const warnings: string[] = [];
		const originalLog = console.log;
		const originalWarn = console.warn;
		console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		const capture = captureExports();
		try {
			await withTraceEnv(
				{
					[APIFUSE__TRACE__ENABLED]: "true",
					[APIFUSE__TRACE__EXPORTER]: "otlp",
					[OTEL_EXPORTER_OTLP_ENDPOINT]: "http://collector.test:4318/",
					[OTEL_EXPORTER_OTLP_HEADERS]: `Authorization=Bearer%20${TRACE_CREDENTIAL}`,
					[OTEL_SERVICE_NAME]: "apifuse-provider-under-test-production",
				},
				async () => {
					const response = await invokeFailure();
					expect(response.status).toBe(500);
					await settleExports(capture.exports, 1);
				},
			);
		} finally {
			capture.restore();
			console.log = originalLog;
			console.warn = originalWarn;
		}

		expect(output).toEqual([]);
		expect(warnings).toEqual([]);
		expect(capture.exports).toHaveLength(1);
		const [exported] = capture.exports;
		expect(exported?.url).toBe("http://collector.test:4318/v1/traces");
		expect(exported?.init?.method).toBe("POST");
		expect(exported?.init?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: `Bearer ${TRACE_CREDENTIAL}`,
		});

		const serialized = String(exported?.init?.body);
		expect(serialized).not.toContain(TRACE_CREDENTIAL);
		const body = JSON.parse(serialized) as OTLPBody;
		expect(attributeMap(body.resourceSpans[0]?.resource.attributes ?? [])).toEqual({
			request_id: "trace-secret-test",
			provider_id: "test-provider",
			operation_id: "fail",
			route: "fail",
			"service.name": "apifuse-provider-under-test-production",
		});
		const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
		expect(spans.map((span) => span.name)).toEqual(
			expect.arrayContaining(["handler:fail", "provider.failure"]),
		);
		expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
		expect(spans[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
		const failure = attributeMap(
			spans.find((span) => span.name === "provider.failure")?.attributes ?? [],
		);
		expect(failure.authorization).toBe("[REDACTED]");
		expect(String(failure.upstream_url)).toContain("[REDACTED]");
		expect(String(failure.diagnostic)).toEndWith("… [truncated]");
	});

	it("never fails the request or logs header values when the collector rejects the export", async () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		const capture = captureExports(401);
		try {
			await withTraceEnv(
				{
					[APIFUSE__TRACE__ENABLED]: "true",
					[APIFUSE__TRACE__EXPORTER]: "otlp",
					[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces",
					[OTEL_EXPORTER_OTLP_TRACES_HEADERS]: `Authorization=Bearer%20${TRACE_CREDENTIAL}`,
				},
				async () => {
					const response = await invokeEcho();
					expect(response.status).toBe(200);
					expect(await response.json()).toEqual({ data: { value: "hello" } });
					await settleExports(capture.exports, 1);
				},
			);
		} finally {
			capture.restore();
			console.warn = originalWarn;
		}
		expect(capture.exports).toHaveLength(1);
		expect(capture.exports[0]?.init?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: `Bearer ${TRACE_CREDENTIAL}`,
		});
		expect(warnings).toEqual(["[apifuse] OTLP export failed (HTTP 401); 1 batch dropped."]);
		expect(warnings.join("\n")).not.toContain(TRACE_CREDENTIAL);
	});

	it("keeps the request successful while a failing collector is retried and then dropped", async () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		const capture = captureExports(503);
		try {
			await withTraceEnv(
				{
					[APIFUSE__TRACE__ENABLED]: "true",
					[APIFUSE__TRACE__EXPORTER]: "otlp",
					[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: "http://collector.test/v1/traces",
				},
				async () => {
					const response = await invokeEcho();
					expect(response.status).toBe(200);
					expect(await response.json()).toEqual({ data: { value: "hello" } });
					await waitUntil(() => warnings.length > 0);
				},
			);
		} finally {
			capture.restore();
			console.warn = originalWarn;
		}
		expect(capture.exports).toHaveLength(OTLP_EXPORT_LIMITS.maxAttempts);
		expect(warnings).toEqual([
			`[apifuse] OTLP export failed (HTTP 503 after ${OTLP_EXPORT_LIMITS.maxAttempts} attempts); 1 batch dropped.`,
		]);
	});
});
