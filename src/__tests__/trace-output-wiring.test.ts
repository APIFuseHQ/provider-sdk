import { describe, expect, it, mock } from "bun:test";
import { z } from "zod";

import { createServerApp } from "../server/serve.js";
import {
	APIFUSE__TRACE__ENABLED,
	APIFUSE__TRACE__EXPORTER,
	APIFUSE__TRACE__OTLP__ENDPOINT,
	resolveTraceConfigFromEnv,
} from "../runtime/trace-config.js";
import {
	createTraceContext,
	getTraceRecorder,
	resolveTraceContextOptions,
} from "../runtime/trace.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const TRACE_CREDENTIAL = "tok_fake_Qj8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS";

const provider = createProviderDefinitionDouble({
	operations: {
		echo: {
			input: z.object({ value: z.string() }),
			output: z.object({ value: z.string() }),
			handler: async (ctx, input) => {
				const parsed = z.object({ value: z.string() }).parse(input);
				return ctx.trace.span("provider.echo", async () => ({ value: parsed.value }));
			},
		},
		fail: {
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
	for (const name of [
		APIFUSE__TRACE__ENABLED,
		APIFUSE__TRACE__EXPORTER,
		APIFUSE__TRACE__OTLP__ENDPOINT,
	]) {
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

async function invokeEcho(): Promise<Response> {
	return createServerApp(provider, {
		allowMemoryStateFallback: true,
		logger: () => {},
	}).request("/v1/echo", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "trace-output-test", input: { value: "hello" } }),
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

		const spans = output.map((line) => JSON.parse(line) as { name: string; duration_ms: number });
		const span = spans.find((candidate) => candidate.name === "handler:echo");
		expect(span).toBeDefined();
		expect(span?.duration_ms).toBeGreaterThanOrEqual(0);
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

	it("adds request, provider, and operation correlation resource attributes to OTLP", async () => {
		const originalFetch = globalThis.fetch;
		const payloads: Array<{
			resourceSpans: Array<{
				resource: {
					attributes: Array<{ key: string; value: { stringValue: string } }>;
				};
			}>;
		}> = [];
		globalThis.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				payloads.push(JSON.parse(String(init?.body)));
				return new Response(null, { status: 200 });
			},
			{ preconnect: originalFetch.preconnect },
		);

		try {
			await withTraceEnv(
				{
					[APIFUSE__TRACE__ENABLED]: "true",
					[APIFUSE__TRACE__EXPORTER]: "otlp",
					[APIFUSE__TRACE__OTLP__ENDPOINT]: "http://collector.test/v1/traces",
				},
				async () => {
					const response = await invokeEcho();
					expect(response.status).toBe(200);
					await new Promise<void>((resolve) => setImmediate(resolve));
				},
			);
		} finally {
			globalThis.fetch = originalFetch;
		}

		const attributes = Object.fromEntries(
			payloads[0]?.resourceSpans[0]?.resource.attributes.map((entry) => [
				entry.key,
				entry.value.stringValue,
			]) ?? [],
		);
		expect(attributes).toEqual({
			request_id: "trace-output-test",
			provider_id: "test-provider",
			operation_id: "echo",
		});
	});

	it("warns once and fails closed to none for an invalid exporter value", () => {
		const warn = mock(() => {});
		const originalWarn = console.warn;
		console.warn = warn;
		try {
			const env = {
				[APIFUSE__TRACE__ENABLED]: "true",
				[APIFUSE__TRACE__EXPORTER]: "not-a-real-exporter",
			};
			expect(resolveTraceConfigFromEnv(env)).toEqual({ enabled: true, exporter: "none" });
			expect(resolveTraceConfigFromEnv(env)).toEqual({ enabled: true, exporter: "none" });
		} finally {
			console.warn = originalWarn;
		}
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			'[apifuse] Invalid APIFUSE__TRACE__EXPORTER; falling back to exporter "none".',
		);
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

	it("warns once when OTLP is enabled without an endpoint", () => {
		const warn = mock(() => {});
		const originalWarn = console.warn;
		console.warn = warn;
		try {
			const env = {
				[APIFUSE__TRACE__ENABLED]: "true",
				[APIFUSE__TRACE__EXPORTER]: "otlp",
			};
			expect(resolveTraceConfigFromEnv(env)).toEqual({ enabled: true, exporter: "otlp" });
			expect(resolveTraceConfigFromEnv(env)).toEqual({ enabled: true, exporter: "otlp" });
		} finally {
			console.warn = originalWarn;
		}
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"[apifuse] APIFUSE__TRACE__EXPORTER selects OTLP but APIFUSE__TRACE__OTLP__ENDPOINT is unset; no spans will be exported.",
		);
	});
});
