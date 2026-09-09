import { afterEach, expect, it } from "bun:test";
import { z } from "zod";
import { TransportError } from "../errors.js";
import { createHttpClient } from "../runtime/http.js";
import { HttpTelemetryCollector } from "../runtime/http-telemetry.js";
import { startHttpTelemetry } from "../runtime/http-telemetry-guard.js";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/request-telemetry.js";
import { createServerApp, type ProviderServerLogEvent } from "../server/serve.js";
import type { ProviderDefinition } from "../types.js";

const savedFetch = globalThis.fetch;
const savedStart = HttpTelemetryCollector.prototype.startRequest;
afterEach(() => {
	globalThis.fetch = savedFetch;
	HttpTelemetryCollector.prototype.startRequest = savedStart;
});

// Reuses the reviewer's network -> 200 and retryable-observer duplicate-request probes.
it.each([
	false,
	true,
])("network -> 200 survives summary failure, retryable=%s", async (retryable) => {
	let fetches = 0;
	globalThis.fetch = Object.assign(
		async () => {
			if (++fetches === 1) throw new Error("socket");
			return new Response("ok", { status: 200 });
		},
		{ preconnect() {} },
	);
	let summaryCalls = 0;
	let markers = 0;
	HttpTelemetryCollector.prototype.startRequest = function (options) {
		const request = savedStart.call(this, options);
		return {
			...request,
			toTenantRetryPayload() {
				summaryCalls++;
				if (retryable)
					throw new TransportError("observer failed", {
						code: "transport_network_error",
						status: 0,
					});
				throw new Error("observer summary failed");
			},
		};
	};
	const provider: ProviderDefinition = {
		id: "observer-probe",
		version: "1.0.0",
		runtime: "standard",
		http: {},
		meta: { displayName: "Observer probe", descriptionKey: "description", category: "test" },
		operations: {
			probe: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ status: z.number() }),
				handler: async (ctx) => ({
					status: (
						await ctx.http.get("https://example.com/probe", {
							retry: { attempts: retryable ? 3 : 2, baseDelayMs: 0, jitter: "none" },
						})
					).status,
				}),
			},
		},
	};
	const events: ProviderServerLogEvent[] = [];
	const app = createServerApp(provider, { logger: (event) => events.push(event) });
	const response = await app.request("/v1/probe", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "observer", input: {} }),
	});
	expect(response.status).toBe(200);
	expect(fetches).toBe(2);
	expect(summaryCalls).toBe(1);
	const body = await response.json();
	expect(body.data).toEqual({ status: 200 });
	expect(body.meta?.retry).toBeUndefined();
	const terminal = events.find((event) => event.event === "provider_request_completed");
	if (terminal?.event !== "provider_request_completed") throw new Error("missing terminal event");
	expect(terminal.http).toMatchObject({ attempts: 2, retries: 1, telemetryFailed: true });
	const encoded = response.headers.get(PROVIDER_TELEMETRY_HEADER);
	expect(encoded).toBeTruthy();
	const header = JSON.parse(Buffer.from(encoded!, "base64url").toString());
	expect(header.http.attempts).toBe(2);
	expect(header.http).not.toHaveProperty("telemetryFailed");

	const request = startHttpTelemetry(
		{
			startRequest() {
				throw new Error("start failed");
			},
			markTelemetryFailed() {
				markers++;
				throw new Error("marker failed");
			},
		},
		undefined,
	);
	request.recordAttempt({ ms: 1, proxyUsed: false });
	request.finish(1);
	expect(request.toTenantRetryPayload()).toBeUndefined();
	expect(markers).toBe(1);
});

it("guards observer getters and omits malformed summaries without changing fetch count", async () => {
	for (const value of [
		null,
		7,
		{},
		{ attempts: 2, retries: 1, transport: "vendor" },
		new Proxy(
			{},
			{
				get() {
					throw new Error("getter failed");
				},
			},
		),
	]) {
		let fetches = 0;
		globalThis.fetch = Object.assign(
			async () => {
				if (++fetches === 1) throw new Error("socket");
				return new Response("ok");
			},
			{ preconnect() {} },
		);
		const collector = new HttpTelemetryCollector();
		const client = createHttpClient(undefined, {
			httpTelemetry: {
				markTelemetryFailed: () => collector.markTelemetryFailed(),
				startRequest(options) {
					return {
						...collector.startRequest(options),
						// test-invalid: values from untyped public sinks must not enter the retry loop.
						toTenantRetryPayload: () =>
							value as ReturnType<HttpTelemetryCollector["toTenantRetryPayload"]>,
					};
				},
			},
		});
		expect(
			(await client.get("https://example.com/probe", { retry: { attempts: 3, baseDelayMs: 0 } }))
				.status,
		).toBe(200);
		expect(fetches).toBe(2);
		expect(collector.toTenantRetryPayload()).toBeUndefined();
		expect(collector.toLogPayload()?.telemetryFailed).toBe(true);
	}
});

it("absorbs asynchronous garbage from every synchronous hook, including the marker", async () => {
	for (const hook of [
		"startRequest",
		"recordAttempt",
		"finish",
		"toTenantRetryPayload",
		"hidden-then",
	] as const) {
		const collector = new HttpTelemetryCollector();
		const request = startHttpTelemetry(
			{
				markTelemetryFailed() {
					collector.markTelemetryFailed();
					return Promise.reject(new Error("async marker"));
				},
				startRequest(options) {
					if (hook === "startRequest") {
						const invalid: unknown = Promise.reject(new Error("async start"));
						// test-invalid: absorb rejected Promises from untyped synchronous observers.
						return invalid as ReturnType<HttpTelemetryCollector["startRequest"]>;
					}
					const target = collector.startRequest(options);
					return {
						...target,
						[hook === "hidden-then" ? "recordAttempt" : hook]: () => {
							if (hook === "hidden-then") {
								const promise = Promise.reject(new Error("hidden then rejection"));
								// biome-ignore lint/suspicious/noThenProperty: reproduces a Promise with a hidden then method.
								Object.defineProperty(promise, "then", { value: undefined });
								return promise;
							}
							return Promise.reject(new Error("async observer"));
						},
					};
				},
			},
			undefined,
		);
		request.recordAttempt({ ms: 1, proxyUsed: false });
		request.finish(1);
		expect(request.toTenantRetryPayload()).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(collector.toLogPayload()?.telemetryFailed).toBe(true);
	}
});
