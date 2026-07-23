import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { clearProxyResolutionCache } from "../config/loader.js";
import { AuthError, ProviderError, SessionExpiredError, TransportError } from "../errors.js";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/proxy-telemetry.js";
import { createMemoryProviderRuntimeState } from "../runtime/state.js";
import {
	createServerApp,
	type ProviderServerLogEvent,
	resolveProviderProxyAffinityKey,
} from "../server/serve.js";
import { event } from "../stream.js";
import type { ProviderDefinition } from "../types.js";
import { HttpRetryPreset } from "../types.js";

function createTestProvider(state: { streamCancelled?: boolean } = {}) {
	return {
		id: "test-provider",
		version: "1.0.0",
		runtime: "standard",
		meta: {
			displayName: "Test Provider",
			category: "test",
		},
		auth: {
			mode: "credentials",
			flow: {
				async start(ctx) {
					ctx.context.set("step", "started");
					return {
						kind: "form",
						turnId: "turn-start",
						data: { providerId: ctx.providerId },
					};
				},
				async continue(ctx, input) {
					ctx.context.set("otp", input?.code ?? "missing");
					return {
						kind: "complete",
						turnId: "turn-complete",
						data: { providerId: ctx.providerId },
					};
				},
				async poll(ctx) {
					return {
						kind: "poll",
						turnId: "turn-poll",
						data: { providerId: ctx.providerId },
					};
				},
				async abort(ctx) {
					ctx.context.set("step", "aborted");
					return {
						kind: "abort",
						turnId: "turn-abort",
						data: { providerId: ctx.providerId, aborted: true },
					};
				},
				async refresh(ctx, input) {
					if (input?.forceAuthRequired) {
						throw new AuthError("Silent refresh is not available.", {
							code: "AUTH_REQUIRED",
						});
					}
					ctx.context.set("step", "refreshed");
					const previousToken = input?.echoExistingCredential
						? ctx.credential?.get("token")
						: undefined;
					return {
						kind: "complete",
						turnId: "turn-refresh",
						data: {
							credential: {
								token: "refreshed-token",
							},
							previousToken,
						},
					};
				},
			},
		},
		credential: { keys: ["token"] },
		context: { keys: ["step", "otp"] },
		operations: {
			echo: {
				input: z.object({ value: z.string() }),
				output: z.object({
					echoed: z.string(),
					connectionId: z.string().optional(),
					secret: z.string().optional(),
				}),
				handler: async (ctx, input) => {
					const parsed = z.object({ value: z.string() }).parse(input);

					return {
						echoed: parsed.value,
						connectionId: ctx.request?.connectionId,
						secret: ctx.credential.get("token"),
					};
				},
			},
			issueServerChoice: {
				input: z.object({ value: z.string() }),
				output: z.object({ token: z.string() }),
				handler: async (ctx, input) => {
					const token = await ctx.choice.issue({
						prefix: "test_choice_v1",
						purpose: "server-state-http-test",
						payload: { value: input.value },
						ttlMs: 60_000,
						storage: {
							mode: "server",
							namespace: "choice.http.test.v1",
							ttl: "10m",
							maxEntries: 20,
							maxValueBytes: 10_000,
						},
					});
					return { token };
				},
			},
			parseServerChoice: {
				input: z.object({ token: z.string() }),
				output: z.object({ value: z.string() }),
				handler: async (ctx, input) => {
					const parsed = await ctx.choice.parse({
						token: input.token,
						prefix: "test_choice_v1",
						purpose: "server-state-http-test",
						ttlMs: 60_000,
						storage: {
							mode: "server",
							namespace: "choice.http.test.v1",
							ttl: "10m",
							maxEntries: 20,
							maxValueBytes: 10_000,
						},
					});
					return z.object({ value: z.string() }).parse(parsed);
				},
			},
			cached: {
				input: z.object({ value: z.string() }),
				output: z.object({ value: z.string() }),
				handler: async (ctx, input) => {
					const parsed = z.object({ value: z.string() }).parse(input);
					const cached = await ctx.cache.getOrSet(
						ctx.cache.key("cached", parsed),
						async () => ({ value: parsed.value }),
						{ ttlMs: 60_000 },
					);
					return cached.value;
				},
			},
			retryThenEcho: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async (ctx) => {
					const response = await ctx.http.get("https://example.com/flaky", {
						retry: {
							preset: HttpRetryPreset.TransportTransient,
							baseDelayMs: 0,
						},
					});
					return response.data;
				},
			},
			cachedRetryThenEcho: {
				input: z.object({ value: z.string() }),
				output: z.object({ value: z.string() }),
				handler: async (ctx, input) => {
					const parsed = z.object({ value: z.string() }).parse(input);
					const cached = await ctx.cache.getOrSet(
						ctx.cache.key("cached-retry", parsed),
						async () => ({ value: parsed.value }),
						{ ttlMs: 60_000 },
					);
					await ctx.http.get("https://example.com/flaky", {
						retry: {
							preset: HttpRetryPreset.TransportTransient,
							baseDelayMs: 0,
						},
					});
					return cached.value;
				},
			},
			events: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				transport: {
					kind: "sse",
					events: {
						delta: z.object({ value: z.string() }),
					},
				},
				async *handler(_ctx, input) {
					yield event("delta", { value: input.value }, { id: "evt_1" });
				},
			},
			invalidEvents: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				transport: {
					kind: "sse",
					events: {
						delta: z.object({ value: z.number() }),
					},
				},
				async *handler(_ctx, input) {
					yield event("delta", { value: input.value });
				},
			},
			undeclaredEvents: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				transport: {
					kind: "sse",
					events: {
						delta: z.object({ value: z.string() }),
					},
				},
				async *handler(_ctx, input) {
					yield event("other", { value: input.value });
				},
			},
			rawSseResponse: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				transport: {
					kind: "sse",
					events: {
						delta: z.object({ value: z.string() }),
					},
				},
				handler: async (_ctx, input) =>
					new Response(`event: delta\ndata: {"value":"${input.value}"}\n\n`, {
						headers: { "Content-Type": "text/event-stream" },
					}),
			},
			rawTelemetryResponse: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async (_ctx, input) =>
					new Response(JSON.stringify({ ok: input.value === "hello" }), {
						headers: {
							"Content-Type": "application/json",
							[PROVIDER_TELEMETRY_HEADER]:
								"eyJ2IjoxLCJwcm94eSI6eyJwcm92aWRlciI6InNtYXJ0cHJveHkiLCJjYWNoZVN0YXR1cyI6ImFsbG9jYXRvciIsImNhY2hlSGl0IjpmYWxzZSwicmVzb2x1dGlvbk1zIjo5OTk5OSwiYXR0ZW1wdHMiOjF9fQ",
							"X-Provider-Trace-Token": "visible",
						},
					}),
			},
			oversizedEvents: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				transport: {
					kind: "sse",
					maxEventBytes: 8,
					events: {
						delta: z.object({ value: z.string() }),
					},
				},
				async *handler(_ctx, input) {
					yield event("delta", { value: input.value });
				},
			},
			abortableEvents: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				transport: {
					kind: "sse",
					events: {
						delta: z.object({ value: z.string() }),
					},
				},
				async *handler(_ctx, input) {
					try {
						yield event("delta", { value: input.value });
						await new Promise(() => undefined);
					} finally {
						state.streamCancelled = true;
					}
				},
			},
			download: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				transport: { kind: "http-stream", contentType: "text/plain" },
				handler: async (_ctx, input) =>
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(input.value));
							controller.close();
						},
					}),
			},
			oversizedDownload: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				transport: {
					kind: "http-stream",
					contentType: "text/plain",
					maxChunkBytes: 4,
				},
				handler: async (_ctx, input) =>
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(input.value));
							controller.close();
						},
					}),
			},
			abortableDownload: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				transport: { kind: "http-stream", contentType: "text/plain" },
				handler: async () =>
					new ReadableStream<Uint8Array>({
						cancel() {
							state.streamCancelled = true;
						},
					}),
			},
			providerError: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new ProviderError("Bad input", { code: "BAD_INPUT" });
				},
			},
			providerActionRequired: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new ProviderError("Table choice required", {
						code: "TABLE_SELECTION_REQUIRED",
						fix: "Call availability and pass one reservation_choices[].reservation_choice.",
						details: {
							next_action: "ask_user_to_pick_table_then_call_reserve_with_reservation_choice",
							required_input: "reservation_choice",
						},
					});
				},
			},
			noData: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new ProviderError("No upstream data", { code: "NO_DATA" });
				},
			},
			lowercaseNotFound: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new ProviderError("Tracking number not found", {
						code: "not_found",
					});
				},
			},
			upstreamProviderError: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new ProviderError("Provider upstream failed", {
						code: "UPSTREAM_ERROR",
					});
				},
			},
			blockedProviderError: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new ProviderError("Provider upstream blocked", {
						code: "BLOCKED",
					});
				},
			},
			rateLimitedProviderError: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new ProviderError("Provider quota exceeded", {
						code: "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
					});
				},
			},
			transportTimeout: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new TransportError("Request timed out", {
						code: "transport_timeout",
						fix: "Increase timeout option",
						details: { next_action: "retry_with_longer_timeout" },
					});
				},
			},
			transportNetwork: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new TransportError("Network error", {
						code: "transport_network_error",
						status: 0,
					});
				},
			},
			proxyAuthIpDenied: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new TransportError(
						"Proxy source IP is not authorized. Add the runtime egress IP to the proxy provider allowlist.",
						{ code: "PROXY_AUTH_IP_DENIED" },
					);
				},
			},
			proxyEdgeAuthRejected: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new TransportError(
						"Proxy provider rejected a candidate endpoint during authentication. The SDK will retry or refresh the proxy pool when safe.",
						{ code: "PROXY_EDGE_AUTH_REJECTED" },
					);
				},
			},
			upstreamBadRequest: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new TransportError("HTTP 400 Bad Request", {
						code: "upstream_http_error",
						status: 400,
					});
				},
			},
			unexpectedError: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new Error("boom");
				},
			},
			sessionExpiredRetryable: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				retryOnAuthRefresh: true,
				handler: async () => {
					throw new SessionExpiredError("Provider session expired");
				},
			},
			sessionExpiredUnmarked: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new SessionExpiredError("Provider session expired");
				},
			},
		},
	} satisfies ProviderDefinition;
}

describe("provider proxy affinity", () => {
	it("prefers credential connection IDs and falls back to identity-only IDs", () => {
		const provider = {
			...createTestProvider(),
			proxy: {
				mode: "required",
				provider: "smartproxy",
				geo: { country: "KR" },
				session: { affinity: "connection" },
			},
		} satisfies ProviderDefinition;
		const identityOnlyRequest = {
			requestId: "req_identity_only",
			input: {},
			connectionId: "af_con_0123456789ABCDEFGHJKMN",
		} satisfies Parameters<typeof resolveProviderProxyAffinityKey>[1];
		const credentialRequest = {
			requestId: "req_credential",
			input: {},
			connectionId: "af_con_conflicting_top_level",
			connection: {
				id: "af_con_credential",
				mode: "credentials",
				secrets: { token: "secret-token" },
				metadata: {},
				externalRef: "ext_credential",
			},
		} satisfies Parameters<typeof resolveProviderProxyAffinityKey>[1];

		expect(resolveProviderProxyAffinityKey(provider, identityOnlyRequest, "search")).toBe(
			"af_con_0123456789ABCDEFGHJKMN",
		);
		expect(resolveProviderProxyAffinityKey(provider, credentialRequest, "search")).toBe(
			"af_con_credential",
		);
	});

	it("scopes operation affinity by provider and operation instead of provider-wide fallback", () => {
		const provider = {
			...createTestProvider(),
			proxy: {
				mode: "required",
				provider: "smartproxy",
				geo: { country: "KR" },
				session: { affinity: "operation" },
			},
		} satisfies ProviderDefinition;
		const request = {
			input: {},
		} as Parameters<typeof resolveProviderProxyAffinityKey>[1];

		expect(resolveProviderProxyAffinityKey(provider, request, "search")).toBe(
			"test-provider/search",
		);
		expect(resolveProviderProxyAffinityKey(provider, request, "detail")).toBe(
			"test-provider/detail",
		);
	});
});

describe("provider HTTP server", () => {
	const app = createServerApp(createTestProvider());

	it("serves health checks", async () => {
		const response = await app.request("/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			provider: "test-provider",
			version: "1.0.0",
		});
	});

	it("dispatches operation handlers", async () => {
		const events: ProviderServerLogEvent[] = [];
		const appWithLogger = createServerApp(createTestProvider(), {
			logger: (event) => events.push(event),
		});
		const response = await appWithLogger.request("/v1/echo", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_1",
				input: { value: "hello" },
				connection: {
					id: "af_con_1",
					mode: "credentials",
					secrets: { token: "secret-token" },
					metadata: {},
					externalRef: "ext_1",
				},
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				echoed: "hello",
				connectionId: "af_con_1",
				secret: "secret-token",
			},
		});
		expect(events).toEqual([
			expect.objectContaining({
				level: "info",
				event: "provider_request_completed",
				providerId: "test-provider",
				kind: "operation",
				route: "echo",
				requestId: "req_1",
				status: 200,
				durationMs: expect.any(Number),
				cpuUserMicros: expect.any(Number),
				cpuSystemMicros: expect.any(Number),
				cpuTotalMicros: expect.any(Number),
			}),
		]);
	});

	it("preserves optional connection identity without credential material", async () => {
		const response = await app.request("/v1/echo", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_optional_connection",
				input: { value: "hello" },
				connectionId: "af_con_0123456789ABCDEFGHJKMN",
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				echoed: "hello",
				connectionId: "af_con_0123456789ABCDEFGHJKMN",
			},
		});
	});

	it("fails closed for deployed browser providers when the CDP pool URL is missing", async () => {
		const previousRuntime = process.env.APIFUSE__PROVIDER__RUNTIME;
		const previousPoolUrl = process.env.APIFUSE__CDP_POOL__URL;
		process.env.APIFUSE__PROVIDER__RUNTIME = "browser";
		delete process.env.APIFUSE__CDP_POOL__URL;

		try {
			const browserProvider = {
				...createTestProvider(),
				runtime: "browser",
				browser: { engine: "playwright-stealth" },
				operations: {
					open: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						handler: async (ctx) => {
							await ctx.browser.newPage();
							return { ok: true };
						},
					},
				},
			} satisfies ProviderDefinition;
			const browserApp = createServerApp(browserProvider);
			const response = await browserApp.request("/v1/open", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req_browser_no_pool",
					input: {},
				}),
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: {
					code: "BROWSER_CDP_POOL_REQUIRED",
					message: "Managed CDP Pool is required for browser providers in production",
					requestId: "req_browser_no_pool",
					fix: "Set APIFUSE__CDP_POOL__URL for deployed browser providers. Local standalone development may omit it.",
				},
			});
		} finally {
			if (previousRuntime === undefined) {
				delete process.env.APIFUSE__PROVIDER__RUNTIME;
			} else {
				process.env.APIFUSE__PROVIDER__RUNTIME = previousRuntime;
			}
			if (previousPoolUrl === undefined) {
				delete process.env.APIFUSE__CDP_POOL__URL;
			} else {
				process.env.APIFUSE__CDP_POOL__URL = previousPoolUrl;
			}
		}
	});

	it("rejects server-backed choice state without a durable runtime state backend", async () => {
		const previousMasterSecret = process.env.APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET;
		process.env.APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET = Buffer.from(
			"x".repeat(32),
		).toString("base64");
		try {
			const serverChoiceApp = createServerApp(createTestProvider());
			const response = await serverChoiceApp.request("/v1/issueServerChoice", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req_issue_choice_no_state",
					input: { value: "persisted" },
					connection: {
						id: "af_con_choice_http",
						mode: "credentials",
						secrets: { token: "secret-token" },
						metadata: {},
						externalRef: "ext_choice_http",
					},
				}),
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { code: "PROVIDER_STATE_UNSUPPORTED" },
			});
		} finally {
			if (previousMasterSecret === undefined) {
				delete process.env.APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET;
			} else {
				process.env.APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET = previousMasterSecret;
			}
		}
	});

	it("keeps injected server-backed choice state across operation HTTP requests", async () => {
		const previousMasterSecret = process.env.APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET;
		process.env.APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET = Buffer.from(
			"x".repeat(32),
		).toString("base64");
		try {
			const serverChoiceApp = createServerApp(createTestProvider(), {
				state: createMemoryProviderRuntimeState(),
			});
			const connection = {
				id: "af_con_choice_http",
				mode: "credentials" as const,
				secrets: { token: "secret-token" },
				metadata: {},
				externalRef: "ext_choice_http",
			};
			const issueResponse = await serverChoiceApp.request("/v1/issueServerChoice", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req_issue_choice",
					input: { value: "persisted" },
					connection,
				}),
			});
			expect(issueResponse.status).toBe(200);
			const issueBody = await issueResponse.json();
			const token = z.object({ data: z.object({ token: z.string() }) }).parse(issueBody).data.token;

			const parseResponse = await serverChoiceApp.request("/v1/parseServerChoice", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req_parse_choice",
					input: { token },
					connection,
				}),
			});

			expect(parseResponse.status).toBe(200);
			expect(await parseResponse.json()).toEqual({
				data: { value: "persisted" },
			});
		} finally {
			if (previousMasterSecret === undefined) {
				delete process.env.APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET;
			} else {
				process.env.APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET = previousMasterSecret;
			}
		}
	});

	it("adds cache metadata to successful cached operation responses", async () => {
		const body = JSON.stringify({
			requestId: "req_cache",
			input: { value: "hello" },
		});

		await app.request("/v1/cached", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		const response = await app.request("/v1/cached", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: { value: "hello" },
			meta: {
				cached: true,
				stale: false,
				cache: {
					hit: true,
					stale: false,
					keys: [expect.stringContaining("apifuse:provider-cache:v1")],
					source: "memory",
				},
			},
		});
	});

	it("adds redacted retry metadata to successful retry-assisted responses", async () => {
		const originalFetch = globalThis.fetch;
		let attempts = 0;
		globalThis.fetch = (async () => {
			attempts += 1;
			if (attempts === 1) {
				throw new Error("Network error");
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const response = await app.request("/v1/retryThenEcho", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req_retry",
					input: { value: "hello" },
				}),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				data: { ok: true },
				meta: {
					retry: {
						attempts: 2,
						retries: 1,
						preset: HttpRetryPreset.TransportTransient,
						transport: "native",
						lastErrorCode: "transport_network_error",
					},
				},
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("merges cache and retry metadata on successful responses", async () => {
		const originalFetch = globalThis.fetch;
		let attempts = 0;
		globalThis.fetch = (async () => {
			attempts += 1;
			if (attempts === 1) {
				throw new Error("Network error");
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const response = await app.request("/v1/cachedRetryThenEcho", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req_cache_retry",
					input: { value: "hello" },
				}),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				data: { value: "hello" },
				meta: {
					cached: false,
					stale: false,
					cache: {
						hit: false,
						stale: false,
						keys: [expect.stringContaining("apifuse:provider-cache:v1")],
						source: "loader",
					},
					retry: {
						attempts: 2,
						retries: 1,
						preset: HttpRetryPreset.TransportTransient,
						transport: "native",
						lastErrorCode: "transport_network_error",
					},
				},
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("streams typed SSE events without JSON response wrapping", async () => {
		const response = await app.request("/v1/events", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_sse",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(await response.text()).toBe('id: evt_1\nevent: delta\ndata: {"value":"hello"}\n\n');
	});

	it("emits terminal SSE error events for invalid stream payloads", async () => {
		const response = await app.request("/v1/invalidEvents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_bad_sse",
				input: { value: "not-a-number" },
			}),
		});

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("event: apifuse.error");
		expect(body).toContain('"code":"stream_error"');
		expect(body).toContain('"requestId":"req_bad_sse"');
	});

	it("emits terminal SSE error events for undeclared stream events", async () => {
		const response = await app.request("/v1/undeclaredEvents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_undeclared_sse",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("event: apifuse.error");
		expect(body).toContain('SSE event \\"other\\" is not declared');
	});

	it("rejects raw SSE Response results so event validation cannot be bypassed", async () => {
		const response = await app.request("/v1/rawSseResponse", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_raw_sse",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: {
				code: "SSE_RESULT_UNSUPPORTED",
				requestId: "req_raw_sse",
			},
		});
	});

	it("strips provider-authored telemetry headers from raw operation responses", async () => {
		const response = await app.request("/v1/rawTelemetryResponse", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_raw_telemetry",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get(PROVIDER_TELEMETRY_HEADER)).toBeNull();
		expect(await response.json()).toEqual({ data: { ok: true } });
	});

	it("enforces declared SSE event byte limits", async () => {
		const response = await app.request("/v1/oversizedEvents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_large_sse",
				input: { value: "too-large" },
			}),
		});

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("event: apifuse.error");
		expect(body).toContain('"code":"stream_error"');
		expect(body).toContain("Stream event exceeded declared byte limit");
	});

	it("streams raw HTTP response bodies with declared content type", async () => {
		const response = await app.request("/v1/download", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_stream",
				input: { value: "stream-body" },
			}),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/plain");
		expect(await response.text()).toBe("stream-body");
	});

	it("enforces declared raw stream chunk byte limits", async () => {
		const response = await app.request("/v1/oversizedDownload", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_large_stream",
				input: { value: "too-large" },
			}),
		});

		expect(response.status).toBe(200);
		await expect(response.text()).rejects.toThrow("Stream chunk exceeded declared byte limit");
	});

	it("propagates stream cancellation to returned ReadableStream sources", async () => {
		const state: { streamCancelled?: boolean } = {};
		const appWithAbortableStream = createServerApp(createTestProvider(state));
		const response = await appWithAbortableStream.request("/v1/abortableDownload", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_abort_stream",
				input: { value: "unused" },
			}),
		});

		await response.body?.cancel("test abort");

		expect(state.streamCancelled).toBe(true);
	});

	it("propagates SSE stream cancellation to async iterators", async () => {
		const state: { streamCancelled?: boolean } = {};
		const appWithAbortableStream = createServerApp(createTestProvider(state));
		const response = await appWithAbortableStream.request("/v1/abortableEvents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_abort_sse",
				input: { value: "first" },
			}),
		});

		const reader = response.body?.getReader();
		await reader?.read();
		await reader?.cancel("test abort");

		expect(state.streamCancelled).toBe(true);
	});

	it("dispatches auth start", async () => {
		const response = await app.request("/auth/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_2",
				flowId: "flow_1",
				providerId: "test-provider",
				context: {},
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				kind: "form",
				turnId: "turn-start",
				data: {
					providerId: "test-provider",
				},
			},
			contextPatch: {
				step: "started",
			},
		});
	});

	it("dispatches auth disconnect through the standard endpoint", async () => {
		const response = await app.request("/auth/disconnect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_disconnect",
				flowId: "flow_disconnect",
				providerId: "test-provider",
				context: { step: "started" },
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				kind: "abort",
				turnId: "turn-abort",
				data: {
					providerId: "test-provider",
					aborted: true,
				},
			},
			contextPatch: {
				step: "aborted",
			},
		});
	});

	it("dispatches auth refresh and returns contextPatch for persistence", async () => {
		const response = await app.request("/auth/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_refresh",
				flowId: "flow_refresh",
				providerId: "test-provider",
				connectionId: "af_con_test",
				context: { step: "started" },
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				kind: "complete",
				turnId: "turn-refresh",
				data: {
					credential: {
						token: "refreshed-token",
					},
				},
			},
			contextPatch: {
				step: "refreshed",
			},
		});
	});

	it("exposes current connection credential to auth refresh handlers", async () => {
		const response = await app.request("/auth/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_refresh_existing_credential",
				flowId: "flow_refresh",
				providerId: "test-provider",
				connectionId: "af_con_test",
				input: { echoExistingCredential: true },
				connection: {
					id: "af_con_test",
					mode: "credentials",
					secrets: { token: "existing-token" },
					metadata: {},
					externalRef: "external-test",
				},
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: {
				data: {
					credential: { token: "refreshed-token" },
					previousToken: "existing-token",
				},
			},
		});
	});

	it("propagates AUTH_REQUIRED from auth refresh without SDK short-circuit", async () => {
		const response = await app.request("/auth/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_refresh_auth_required",
				flowId: "flow_refresh",
				providerId: "test-provider",
				input: { forceAuthRequired: true },
				context: {},
			}),
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			error: {
				code: "AUTH_REQUIRED",
				message: "Silent refresh is not available.",
				requestId: "req_refresh_auth_required",
			},
		});
	});

	it("maps missing auth refresh handler to refresh_not_supported", async () => {
		const provider = createTestProvider() as ProviderDefinition;
		if (provider.auth?.flow) {
			delete provider.auth.flow.refresh;
		}
		const appWithoutRefresh = createServerApp(provider);
		const response = await appWithoutRefresh.request("/auth/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_refresh_unsupported",
				flowId: "flow_refresh",
				providerId: "test-provider",
				context: {},
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: {
				code: "refresh_not_supported",
				requestId: "req_refresh_unsupported",
			},
		});
	});

	it("returns 404 for unknown operation", async () => {
		const response = await app.request("/v1/missing", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_3",
				input: {},
			}),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			error: {
				code: "NOT_FOUND",
				message: "Unknown operation: test-provider/missing",
				requestId: "req_3",
			},
		});
	});

	it("maps ProviderError to 4xx", async () => {
		const response = await app.request("/v1/providerError", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_4",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				code: "BAD_INPUT",
				message: "Bad input",
				requestId: "req_4",
			},
		});
	});

	it("preserves ProviderError fix and structured details in the public envelope", async () => {
		const response = await app.request("/v1/providerActionRequired", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_action_required",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				code: "TABLE_SELECTION_REQUIRED",
				message: "Table choice required",
				requestId: "req_action_required",
				fix: "Call availability and pass one reservation_choices[].reservation_choice.",
				details: {
					next_action: "ask_user_to_pick_table_then_call_reserve_with_reservation_choice",
					required_input: "reservation_choice",
				},
			},
		});
	});

	it("maps ProviderError NO_DATA to 404", async () => {
		const response = await app.request("/v1/noData", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_no_data",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				code: "NO_DATA",
				message: "No upstream data",
				requestId: "req_no_data",
			},
		});
	});

	it("maps provider docs-style error codes to their public statuses", async () => {
		const cases = [
			{ operation: "lowercaseNotFound", status: 404, code: "not_found" },
			{
				operation: "upstreamProviderError",
				status: 502,
				code: "UPSTREAM_ERROR",
			},
			{
				operation: "blockedProviderError",
				status: 502,
				code: "BLOCKED",
			},
			{
				operation: "rateLimitedProviderError",
				status: 429,
				code: "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
			},
		];

		for (const testCase of cases) {
			const response = await app.request(`/v1/${testCase.operation}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: `req_${testCase.operation}`,
					input: { value: "hello" },
				}),
			});

			expect(response.status).toBe(testCase.status);
			expect((await response.json()).error.code).toBe(testCase.code);
		}
	});

	it("maps provider transport timeout to 504 instead of caller 400", async () => {
		const response = await app.request("/v1/transportTimeout", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_timeout",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(504);
		expect(await response.json()).toEqual({
			error: {
				code: "transport_timeout",
				message: "Request timed out",
				requestId: "req_timeout",
				fix: "Increase timeout option",
				details: {
					next_action: "retry_with_longer_timeout",
					category: "timeout",
					taxonomyVersion: "2026-05-26",
					retryable: true,
				},
			},
		});
	});

	it("maps provider transport network failures to network classification", async () => {
		const response = await app.request("/v1/transportNetwork", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_network",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: {
				code: "transport_network_error",
				message: "Network error",
				requestId: "req_network",
				details: {
					category: "network",
					taxonomyVersion: "2026-05-26",
					retryable: true,
				},
			},
		});
	});

	it("surfaces credential_expired + retryable:true in the HTTP error for retryOnAuthRefresh operations", async () => {
		const response = await app.request("/v1/sessionExpiredRetryable", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_session_retry",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(401);
		const body = (await response.json()) as {
			error: { details?: Record<string, unknown> };
		};
		// Codex P1: the refresh/re-drive signal must reach Gateway/Credential
		// Service end-to-end, not just live in memory.
		expect(body.error.details).toMatchObject({
			category: "credential_expired",
			retryable: true,
		});
	});

	it("surfaces credential_expired + retryable:false for unmarked operations", async () => {
		const response = await app.request("/v1/sessionExpiredUnmarked", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_session_unmarked",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(401);
		const body = (await response.json()) as {
			error: { details?: Record<string, unknown> };
		};
		expect(body.error.details).toMatchObject({
			category: "credential_expired",
			retryable: false,
		});
	});

	it("maps upstream 400 transport failures to provider 502 without upstream body details", async () => {
		const response = await app.request("/v1/upstreamBadRequest", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_upstream_400",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: {
				code: "upstream_http_error",
				message: "Upstream request failed with status 400",
				requestId: "req_upstream_400",
				details: {
					category: "upstream_http",
					taxonomyVersion: "2026-05-26",
					retryable: false,
					upstreamStatus: 400,
				},
			},
		});
	});

	it("surfaces proxy source-IP denial without pretending it is an upstream HTTP status", async () => {
		const response = await app.request("/v1/proxyAuthIpDenied", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_proxy_auth_ip",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: {
				code: "PROXY_AUTH_IP_DENIED",
				message:
					"Proxy source IP is not authorized. Add the runtime egress IP to the proxy provider allowlist.",
				requestId: "req_proxy_auth_ip",
				details: {
					category: "anti_bot_blocked",
					taxonomyVersion: "2026-05-26",
					retryable: false,
				},
			},
		});
	});

	it("classifies proxy edge auth rejection as proxy-pool, not anti-bot or source-IP allowlist", async () => {
		const response = await app.request("/v1/proxyEdgeAuthRejected", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_proxy_edge_auth",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: {
				code: "PROXY_EDGE_AUTH_REJECTED",
				message:
					"Proxy provider rejected a candidate endpoint during authentication. The SDK will retry or refresh the proxy pool when safe.",
				requestId: "req_proxy_edge_auth",
				details: {
					category: "proxy_pool",
					taxonomyVersion: "2026-05-26",
					retryable: true,
				},
			},
		});
	});

	it("returns Smartproxy allocator failures with private telemetry and proxy-pool classification", async () => {
		const originalFetch = global.fetch;
		const originalSmartproxyKey = process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		clearProxyResolutionCache();
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () => new Response("allocator denied", { status: 503 })) as typeof fetch;
		const baseProvider = createTestProvider();
		const provider = {
			...baseProvider,
			allowedHosts: ["example.com"],
			proxy: {
				mode: "required",
				provider: "smartproxy",
				geo: { country: "KR" },
				session: { affinity: "connection", poolSize: 1 },
			},
			operations: {
				...baseProvider.operations,
				proxyAllocationFailure: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async (ctx) => {
						await ctx.stealth.fetch("/");
						return { ok: true };
					},
				},
			},
		} satisfies ProviderDefinition;
		const proxyApp = createServerApp(provider, { logger: () => undefined });

		try {
			const response = await proxyApp.request("/v1/proxyAllocationFailure", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req_proxy_alloc",
					input: {},
					connection: {
						id: "af_con_failure",
						mode: "credentials",
						secrets: {},
						metadata: {},
						externalRef: "ext_failure",
					},
				}),
			});

			expect(response.status).toBe(502);
			const telemetryHeader = response.headers.get(PROVIDER_TELEMETRY_HEADER);
			expect(telemetryHeader).toBeTruthy();
			const decoded = JSON.parse(Buffer.from(telemetryHeader ?? "", "base64url").toString("utf8"));
			expect(decoded).toMatchObject({
				v: 1,
				proxy: {
					provider: "smartproxy",
					cacheStatus: "allocator",
					cacheHit: false,
					attempts: 3,
					allocatorAttempts: 3,
					allocatorStatus: 503,
					allocatorBodyClass: "http_error",
				},
			});
			const body = await response.json();
			expect(body.error.code).toBe("PROXY_ALLOCATION_FAILED");
			expect(body.error.details.category).toBe("proxy_pool");
			const serialized = JSON.stringify({ body, decoded });
			expect(serialized).not.toContain("redacted-test-key");
			expect(serialized).not.toContain("5.78.24.25");
			expect(serialized).not.toContain("af_con_failure");
		} finally {
			global.fetch = originalFetch;
			if (originalSmartproxyKey) {
				process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = originalSmartproxyKey;
			} else {
				delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
			}
			clearProxyResolutionCache();
		}
	});

	it("maps unexpected errors to 500", async () => {
		const response = await app.request("/v1/unexpectedError", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_5",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: {
				code: "internal_error",
				message: "Internal error",
				requestId: "req_5",
				details: {
					retryable: false,
					category: "internal_error",
					errorClass: "Error",
				},
			},
		});
	});

	it("marks masked internal errors as non-retryable with the real error class", async () => {
		const response = await app.request("/v1/unexpectedError", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_masked", input: { value: "hello" } }),
		});

		expect(response.status).toBe(500);
		const body = (await response.json()) as {
			error: { code: string; message: string; details?: Record<string, unknown> };
		};
		expect(body.error.code).toBe("internal_error");
		// Must never leak the raw message/stack beyond the generic string.
		expect(body.error.message).toBe("Internal error");
		expect(JSON.stringify(body)).not.toContain("boom");
		// The hub honors details.retryable; a masked crash must be non-retryable so
		// it cannot drive the START->CONTINUE->restart loop.
		expect(body.error.details?.retryable).toBe(false);
		expect(body.error.details?.category).toBe("internal_error");
		expect(body.error.details?.errorClass).toBe("Error");
	});

	it("emits provider failure events through the injected logger", async () => {
		const events: ProviderServerLogEvent[] = [];
		const appWithLogger = createServerApp(createTestProvider(), {
			logger: (event) => events.push(event),
		});

		const response = await appWithLogger.request("/v1/transportTimeout", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_logged_timeout",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(504);
		expect(events).toEqual([
			expect.objectContaining({
				level: "error",
				event: "provider_request_failed",
				providerId: "test-provider",
				kind: "operation",
				route: "transportTimeout",
				requestId: "req_logged_timeout",
				status: 504,
				durationMs: expect.any(Number),
				cpuUserMicros: expect.any(Number),
				cpuSystemMicros: expect.any(Number),
				cpuTotalMicros: expect.any(Number),
				code: "transport_timeout",
				errorClass: "TransportError",
			}),
		]);
	});

	it("returns 404 for unknown routes", async () => {
		const response = await app.request("/missing");

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				code: "not_found",
				message: "Not found",
			},
		});
	});
});

describe("provider HTTP server cross-module error identity", () => {
	async function createDuplicateInstanceApp() {
		// Genuine second module identity for the SDK errors, modelling the packaged
		// src/* server importing errors whose provider throws dist/* errors.
		// biome-ignore lint/correctness/useImportExtensions: specifier already carries .ts; the ?query (invisible to the rule) mints a second module identity under bun test
		const Dup = (await import("../errors.ts?duplicate-sdk-instance")) as typeof import("../errors");
		const base = createTestProvider() as ProviderDefinition;
		const provider = {
			...base,
			operations: {
				...base.operations,
				dupProviderError: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					handler: async () => {
						throw new Dup.ProviderError("Missing provider service key", {
							code: "CONFIGURATION_ERROR",
							fix: "Set the provider service key.",
						});
					},
				},
				dupSessionExpired: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					handler: async () => {
						throw new Dup.SessionExpiredError();
					},
				},
				dupTransport: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					handler: async () => {
						throw new Dup.TransportError("Request timed out", {
							code: "transport_timeout",
						});
					},
				},
				unbrandedLookalike: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					handler: async () => {
						const err = new Error("Missing provider service key") as Error & {
							code?: string;
							options?: unknown;
						};
						err.name = "ProviderError";
						err.code = "CONFIGURATION_ERROR";
						err.options = { code: "CONFIGURATION_ERROR" };
						throw err;
					},
				},
			},
		} as ProviderDefinition;
		return createServerApp(provider);
	}

	async function requestOperation(app: ReturnType<typeof createServerApp>, operation: string) {
		return app.request(`/v1/${operation}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: `req_${operation}`, input: { value: "hello" } }),
		});
	}

	it("classifies a duplicate-instance ProviderError instead of 500 internal_error", async () => {
		const app = await createDuplicateInstanceApp();
		const response = await requestOperation(app, "dupProviderError");

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				code: "CONFIGURATION_ERROR",
				message: "Missing provider service key",
				requestId: "req_dupProviderError",
				fix: "Set the provider service key.",
			},
		});
	});

	it("classifies a duplicate-instance SessionExpiredError as reauth_required", async () => {
		const app = await createDuplicateInstanceApp();
		const response = await requestOperation(app, "dupSessionExpired");

		expect(response.status).toBe(401);
		const body = await response.json();
		expect(body.error.code).toBe("reauth_required");
		expect(body.error.details.category).toBe("credential_expired");
	});

	it("classifies a duplicate-instance TransportError as a 504 upstream failure", async () => {
		const app = await createDuplicateInstanceApp();
		const response = await requestOperation(app, "dupTransport");

		expect(response.status).toBe(504);
		expect((await response.json()).error.code).toBe("transport_timeout");
	});

	it("keeps an unbranded lookalike as 500 internal_error", async () => {
		const app = await createDuplicateInstanceApp();
		const response = await requestOperation(app, "unbrandedLookalike");

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: {
				code: "internal_error",
				message: "Internal error",
				requestId: "req_unbrandedLookalike",
				details: {
					retryable: false,
					category: "internal_error",
					errorClass: "ProviderError",
				},
			},
		});
	});
});

describe("SDK-owned secret enforcement over HTTP", () => {
	const API_KEY_ENV = "APIFUSE__PROVIDER__TEST_PROVIDER__HTTP_TEST_API_KEY";

	function createSecretProvider(): ProviderDefinition {
		const base = createTestProvider() as ProviderDefinition;
		return {
			...base,
			secrets: [{ name: API_KEY_ENV, required: true, description: "Test upstream key" }],
		};
	}

	function withUnsetSecret<T>(run: () => Promise<T>): Promise<T> {
		const previous = process.env[API_KEY_ENV];
		delete process.env[API_KEY_ENV];
		return run().finally(() => {
			if (previous === undefined) {
				delete process.env[API_KEY_ENV];
			} else {
				process.env[API_KEY_ENV] = previous;
			}
		});
	}

	it("rejects operations with the canonical structured MISSING_SECRET envelope", async () => {
		await withUnsetSecret(async () => {
			const events: ProviderServerLogEvent[] = [];
			const app = createServerApp(createSecretProvider(), {
				logger: (event) => events.push(event),
			});

			const response = await app.request("/v1/echo", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "req_missing_secret", input: { value: "hello" } }),
			});

			expect(response.status).toBe(400);
			const body = await response.json();
			expect(body.error.code).toBe("MISSING_SECRET");
			expect(body.error.message).toBe(`Missing required provider secret: ${API_KEY_ENV}`);
			expect(body.error.fix).toContain(API_KEY_ENV);
			expect(body.error.details).toEqual({
				category: "credential_unavailable",
				taxonomyVersion: expect.any(String),
				retryable: false,
			});

			// Structured failure log carries the canonical category for
			// observability/alerting (the incident-visibility fix).
			expect(events).toContainEqual(
				expect.objectContaining({
					level: "warn",
					event: "provider_request_failed",
					code: "MISSING_SECRET",
					errorCategory: "credential_unavailable",
					retryable: false,
					status: 400,
				}),
			);
		});
	});

	it("runs the handler once the declared secret is provisioned", async () => {
		const previous = process.env[API_KEY_ENV];
		process.env[API_KEY_ENV] = "provisioned-value";
		try {
			const app = createServerApp(createSecretProvider());
			const response = await app.request("/v1/echo", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "req_present_secret", input: { value: "hello" } }),
			});

			expect(response.status).toBe(200);
			expect((await response.json()).data.echoed).toBe("hello");
		} finally {
			if (previous === undefined) {
				delete process.env[API_KEY_ENV];
			} else {
				process.env[API_KEY_ENV] = previous;
			}
		}
	});

	it("rejects auth flow start with the same MISSING_SECRET envelope", async () => {
		await withUnsetSecret(async () => {
			const app = createServerApp(createSecretProvider());
			const response = await app.request("/auth/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req_auth_missing_secret",
					flowId: "flow_missing_secret",
					providerId: "test-provider",
					context: {},
				}),
			});

			expect(response.status).toBe(400);
			const body = await response.json();
			expect(body.error.code).toBe("MISSING_SECRET");
			expect(body.error.details.category).toBe("credential_unavailable");
		});
	});

	it("still allows aborting a flow while secrets are unprovisioned", async () => {
		await withUnsetSecret(async () => {
			const app = createServerApp(createSecretProvider());
			const response = await app.request("/auth/disconnect", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req_abort_missing_secret",
					flowId: "flow_abort_missing_secret",
					providerId: "test-provider",
					context: { step: "started" },
				}),
			});

			expect(response.status).toBe(200);
		});
	});

	it("emits a provider_secrets_missing warn at boot instead of crashing", async () => {
		await withUnsetSecret(async () => {
			const events: ProviderServerLogEvent[] = [];
			createServerApp(createSecretProvider(), { logger: (event) => events.push(event) });

			expect(events).toEqual([
				{
					level: "warn",
					event: "provider_secrets_missing",
					providerId: "test-provider",
					missingSecrets: [API_KEY_ENV],
				},
			]);
		});
	});

	it("does not emit the boot warning when the secret is provisioned", async () => {
		const previous = process.env[API_KEY_ENV];
		process.env[API_KEY_ENV] = "provisioned-value";
		try {
			const events: ProviderServerLogEvent[] = [];
			createServerApp(createSecretProvider(), { logger: (event) => events.push(event) });

			expect(events).toEqual([]);
		} finally {
			if (previous === undefined) {
				delete process.env[API_KEY_ENV];
			} else {
				process.env[API_KEY_ENV] = previous;
			}
		}
	});
});
