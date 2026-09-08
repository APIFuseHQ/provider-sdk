import { expect, test } from "bun:test";
import { z } from "zod";
import { createInProcessProviderEngine } from "../engine.js";
import { createHttpClient } from "../runtime/http.js";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/request-telemetry.js";
import { createServerApp, type ProviderServerLogEvent } from "../server/serve.js";
import type { HttpClient, ProviderDefinition } from "../types.js";
import { bindHttpTelemetry } from "../runtime/http-telemetry-binding.js";
import { HttpTelemetryCollector } from "../runtime/http-telemetry.js";
import { TransportError } from "../errors.js";

for (const method of ["request", "get", "post", "put", "delete", "stream", "sse"] as const) {
	for (const outcome of ["resolve", "reject", "throw"] as const) {
		test(`opaque host differential: ${method} ${outcome}`, async () => {
			const args = ["https://example.com/path", { method: "POST", headers: { test: "value" } }];
			const result = { status: 201, body: new ReadableStream(), marker: Symbol() };
			const error = new TransportError("host failed", { code: "transport_timeout", status: 0 });
			async function run(observed: boolean) {
				const calls: unknown[] = [];
				let promise: Promise<unknown> | undefined;
				const host = Object.freeze({
					...createHttpClient(),
					[method](this: unknown, ...received: unknown[]) {
						expect(this).toBe(host);
						expect(received[0]).toBe(args[0]);
						expect(received[1]).toBe(args[1]);
						calls.push([method, received]);
						if (outcome === "throw") throw error;
						promise = outcome === "resolve" ? Promise.resolve(result) : Promise.reject(error);
						return promise;
					},
				});
				const collector = new HttpTelemetryCollector();
				const client = observed ? bindHttpTelemetry(host, collector) : host;
				try {
					// test-invalid: invoke every method with the same opaque argument tuple to pin exact forwarding.
					const returned = Reflect.apply(client[method], client, args);
					expect(returned).toBe(promise);
					calls.push("returned");
					const value = await returned;
					expect(value).toBe(result);
					calls.push("resolved");
				} catch (caught) {
					expect(caught).toBe(error);
					calls.push(outcome);
				}
				if (observed) {
					expect(collector.toLogPayload()).toMatchObject({
						attempts: 1,
						retries: 0,
						timeouts: outcome === "resolve" ? 0 : 1,
						lastStatus: outcome === "resolve" ? 201 : 0,
					});
					expect(collector.toTenantRetryPayload()).toBeUndefined();
				}
				return calls;
			}
			expect(await run(true)).toEqual(await run(false));
		});
	}
}

test("a shared host SDK client keeps concurrent request sinks and its own observer independent", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			await Promise.resolve();
			return new Response("ok", { status: String(input).endsWith("a") ? 200 : 201 });
		},
		{ preconnect() {} },
	) as typeof fetch;
	try {
		const hostCollector = new HttpTelemetryCollector();
		const client = createHttpClient(undefined, { httpTelemetry: hostCollector });
		const a = new HttpTelemetryCollector();
		const b = new HttpTelemetryCollector();
		await Promise.all([
			bindHttpTelemetry(client, a).get("https://example.com/a"),
			bindHttpTelemetry(client, b).get("https://example.com/b"),
		]);
		expect(a.toLogPayload()).toMatchObject({ attempts: 1, retries: 0, lastStatus: 200 });
		expect(b.toLogPayload()).toMatchObject({ attempts: 1, retries: 0, lastStatus: 201 });
		expect(hostCollector.toLogPayload()).toMatchObject({ attempts: 2, retries: 0 });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a host observer failure marks the request collector without retrying transport", async () => {
	const originalFetch = globalThis.fetch;
	let fetches = 0;
	globalThis.fetch = Object.assign(
		async () => {
			if (++fetches === 1) throw new TypeError("fetch failed");
			return new Response("ok");
		},
		{ preconnect() {} },
	) as typeof fetch;
	try {
		const host = createHttpClient(undefined, {
			httpTelemetry: {
				startRequest: () => ({
					recordAttempt() {},
					finish() {},
					toTenantRetryPayload() {
						throw new TypeError("fetch failed");
					},
				}),
			},
		});
		const collector = new HttpTelemetryCollector();
		const response = await bindHttpTelemetry(host, collector).get("https://example.com", {
			retry: { attempts: 2, baseDelayMs: 0, jitter: "none" },
		});
		expect(response.status).toBe(200);
		expect(fetches).toBe(2);
		expect(collector.toLogPayload()).toMatchObject({ attempts: 2, telemetryFailed: true });
		expect(collector.toTenantRetryPayload()).toBeUndefined();
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a throwing Promise species is an observation failure and preserves the host promise", () => {
	const promise = Promise.resolve({ status: 200 });
	Object.defineProperty(promise, "constructor", {
		get() {
			throw new Error("species failed");
		},
	});
	// test-invalid: incomplete host response isolates observation of a hostile Promise constructor.
	const host = { get: (_url: string) => promise } as HttpClient;
	const collector = new HttpTelemetryCollector();
	const returned: unknown = bindHttpTelemetry(host, collector).get("https://example.com");
	expect(returned).toBe(promise);
	expect(collector.toLogPayload()).toMatchObject({ telemetryFailed: true });
});

test.each([
	"sdk",
	"opaque",
] as const)("custom engine can replace the supplied http binding: %s", async (kind) => {
	const originalFetch = globalThis.fetch;
	let fetches = 0;
	globalThis.fetch = Object.assign(
		async () => {
			fetches += 1;
			return new Response("ok", { status: fetches < 3 ? 503 : 200 });
		},
		{
			preconnect: () => {},
		},
	);
	const events: ProviderServerLogEvent[] = [];
	const local = createInProcessProviderEngine();
	let candidateSeen = false;
	const provider: ProviderDefinition = {
		id: "engine-http-replacement",
		version: "1.0.0",
		runtime: "standard",
		http: {},
		meta: { displayName: "probe", descriptionKey: "description", category: "test" },
		operations: {
			probe: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ status: z.number() }),
				handler: async (ctx) => ({
					status: (
						await ctx.http.get("https://example.com", {
							retry: { attempts: 3, statusCodes: [503], baseDelayMs: 0, jitter: "none" },
						})
					).status,
				}),
			},
		},
	};
	try {
		const app = createServerApp(provider, {
			logger: (event) => events.push(event),
			engine: {
				attach: (input) => {
					candidateSeen = input.bindings.http !== undefined;
					return local.attach({
						...input,
						bindings: {
							...input.bindings,
							http:
								kind === "sdk"
									? createHttpClient()
									: // test-invalid: opaque host exposes only the method and response status used by this provider.
										({
											async get(url: string) {
												let response = await fetch(url);
												while (response.status === 503) response = await fetch(url);
												return { status: response.status };
											},
										} as HttpClient),
						},
					});
				},
			},
		});
		const response = await app.request("/v1/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "engine-replacement", input: {} }),
		});
		expect(response.status).toBe(200);
		expect(fetches).toBe(3);
		expect(candidateSeen).toBe(true);
		expect(events).toHaveLength(1);
		if (kind === "sdk") {
			expect(events[0]).toHaveProperty(
				"http",
				expect.objectContaining({ attempts: 3, retries: 2, lastStatus: 200 }),
			);
		} else {
			expect(events[0]).toHaveProperty(
				"http",
				expect.objectContaining({ attempts: 1, retries: 0, lastStatus: 200 }),
			);
		}
		expect(response.headers.get(PROVIDER_TELEMETRY_HEADER)).not.toBeNull();
		const payload = (await response.json()) as { meta?: { retry?: unknown } };
		if (kind === "sdk") {
			expect(payload.meta?.retry).toEqual({
				attempts: 3,
				retries: 2,
				preset: "transport_transient",
				transport: "native",
				lastStatus: 503,
			});
		} else {
			expect(payload.meta?.retry).toBeUndefined();
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});
