import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { type Socket, createServer } from "node:net";
import { z } from "zod";

import { clearProxyResolutionCache } from "../config/loader.js";
import { PROVIDER_ERROR_CATEGORIES } from "../observability.js";
import {
	AuthError,
	ProviderError,
	type ProviderErrorObservability,
	type ProviderErrorOptions,
	SessionExpiredError,
	TransportError,
	ValidationError,
} from "../errors.js";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/proxy-telemetry.js";
import { createMemoryProviderRuntimeState } from "../runtime/state.js";
import {
	createServerApp,
	ERROR_OBSERVABILITY_HEADER,
	type ErrorObservabilityDetails,
	type ProviderServerLogEvent,
	resolveAuthFlowProxyAffinityKey,
	resolveProviderProxyAffinityKey,
} from "../server/serve.js";
import { safeProviderErrorObservability } from "../server/error-observability.js";
import { event } from "../stream.js";
import type { OperationErrorCode, ProviderContext, ProviderDefinition } from "../types.js";
import { HttpRetryPreset } from "../types.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

function errorObservability(response: Response): ErrorObservabilityDetails {
	const value = response.headers.get(ERROR_OBSERVABILITY_HEADER);
	expect(value).toBeTruthy();
	expect(value).not.toMatch(/[\r\n]/);
	if (value === null) throw new Error("Expected error observability header");
	return z
		.object({
			category: z.enum(PROVIDER_ERROR_CATEGORIES),
			taxonomyVersion: z.string(),
			retryable: z.boolean(),
			upstreamStatus: z.number().optional(),
			providerObservability: z
				.object({
					reason: z.string().optional(),
					fingerprint: z.string().optional(),
					messageLength: z.number().optional(),
				})
				.optional(),
		})
		.parse(JSON.parse(value));
}

function parseValueInput(input: unknown): { value: string } {
	return z.object({ value: z.string() }).parse(input);
}

function parseTokenInput(input: unknown): { token: string } {
	return z.object({ token: z.string() }).parse(input);
}

function createLocalFetchDouble(
	implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(implementation, {
		preconnect: (
			_url: string | URL,
			_options?: { dns?: boolean; tcp?: boolean; http?: boolean },
		) => {},
	});
}

function createTestProvider(state: { streamCancelled?: boolean } = {}): ProviderDefinition {
	return {
		id: "test-provider",
		version: "1.0.0",
		runtime: "standard",
		meta: {
			displayName: "Test Provider",
			descriptionKey: "test-provider.description",
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
						payload: { value: parseValueInput(input).value },
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
						token: parseTokenInput(input).token,
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
					yield event("delta", { value: parseValueInput(input).value }, { id: "evt_1" });
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
					yield event("delta", { value: parseValueInput(input).value });
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
					yield event("other", { value: parseValueInput(input).value });
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
					new Response(`event: delta\ndata: {"value":"${parseValueInput(input).value}"}\n\n`, {
						headers: { "Content-Type": "text/event-stream" },
					}),
			},
			rawTelemetryResponse: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async (_ctx, input) =>
					new Response(JSON.stringify({ ok: parseValueInput(input).value === "hello" }), {
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
					yield event("delta", { value: parseValueInput(input).value });
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
						yield event("delta", { value: parseValueInput(input).value });
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
							controller.enqueue(new TextEncoder().encode(parseValueInput(input).value));
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
							controller.enqueue(new TextEncoder().encode(parseValueInput(input).value));
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
					throw new ProviderError("New provider failure", { code: "SOME_NEW_CODE" });
				},
			},
			validationError: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new ValidationError("Invalid provider input", { code: "SOME_NEW_CODE" });
				},
			},
			invalidOutput: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				// test-invalid: runtime output validation must reject a string in a boolean field.
				handler: async () => ({ ok: "not-a-boolean" }) as never,
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
			transportWithDetails: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new TransportError("Upstream failed", {
						code: "upstream_http_error",
						status: 502,
						details: { providerReason: "inventory_unavailable" },
					});
				},
			},
			transportExplicitNonRetryable: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new TransportError("Upstream failed", {
						code: "upstream_http_error",
						status: 502,
						retryable: false,
						details: { retryable: true, providerPolicy: "independent" },
					});
				},
			},
			transportStringDetails: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new TransportError("Network error", {
						code: "transport_network_error",
						details: "provider diagnostic",
					});
				},
			},
			transportArrayDetails: {
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new TransportError("Network error", {
						code: "transport_network_error",
						details: ["first", { providerCode: 17 }],
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
	};
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

	it("keys auth-flow proxy affinity by connection.id when only the connection object carries it", () => {
		const provider = createTestProvider() satisfies ProviderDefinition;
		// Parity with resolveProviderProxyAffinityKey: the auth chain must not
		// fall through to externalRef/tenant/provider when a nested
		// connection.id identifies the connection.
		expect(
			resolveAuthFlowProxyAffinityKey(provider, {
				connection: {
					id: "af_con_credential",
					mode: "credentials",
					secrets: {},
					metadata: {},
					externalRef: "ext_credential",
				},
				externalRef: "ext_fallback",
			}),
		).toBe("af_con_credential");
		expect(
			resolveAuthFlowProxyAffinityKey(provider, {
				connectionId: "af_con_top_level",
				externalRef: "ext_fallback",
			}),
		).toBe("af_con_top_level");
		expect(resolveAuthFlowProxyAffinityKey(provider, { externalRef: "ext_fallback" })).toBe(
			"ext_fallback",
		);
		// An empty connection.id is malformed, not an identity: it must not
		// shadow a valid top-level id, and all-empty ids must fall through to
		// the fallback chain rather than keying everything under "".
		expect(
			resolveAuthFlowProxyAffinityKey(provider, {
				connection: {
					id: "",
					mode: "credentials",
					secrets: {},
					metadata: {},
					externalRef: "ext_credential",
				},
				connectionId: "af_con_top_level",
			}),
		).toBe("af_con_top_level");
		expect(
			resolveAuthFlowProxyAffinityKey(provider, {
				connectionId: "",
				externalRef: "ext_fallback",
			}),
		).toBe("ext_fallback");
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

	it("derives resolver identity scope from the proxy policy and stable session affinity", async () => {
		const { resolveProviderResolverIdentityScope } = await import("../server/serve.js");
		const provider = {
			...createTestProvider(),
			proxy: {
				mode: "required",
				provider: "smartproxy",
				geo: { country: "KR" },
				session: { affinity: "connection" },
			},
		} satisfies ProviderDefinition;

		const first = resolveProviderResolverIdentityScope(provider, "connection-one", "context-one");
		const second = resolveProviderResolverIdentityScope(provider, "connection-two", "context-two");

		expect(first).not.toBe(second);
		expect(JSON.parse(first)).toEqual({
			proxy: provider.proxy,
			affinityKey: "connection-one",
			contextId: "context-one",
		});
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
		expect("proxy" in (events[0] ?? {})).toBe(false);
		expect(response.headers.get(PROVIDER_TELEMETRY_HEADER)).toBeNull();
	});

	it("logs optional proxy credential failover and emits the same payload in the header", async () => {
		const originalFetch = global.fetch;
		const originalSmartproxyKey = process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		clearProxyResolutionCache();
		delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		global.fetch = createLocalFetchDouble(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const baseProvider = createTestProvider();
		const provider = {
			...baseProvider,
			allowedHosts: ["example.com"],
			proxy: { mode: "optional", providers: ["smartproxy"] },
			operations: {
				...baseProvider.operations,
				proxyOptionalFallback: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async (ctx) => {
						const response = await ctx.http.get("https://example.com/direct");
						return response.data;
					},
				},
			},
		} satisfies ProviderDefinition;
		const events: ProviderServerLogEvent[] = [];
		const proxyApp = createServerApp(provider, { logger: (event) => events.push(event) });

		try {
			const response = await proxyApp.request("/v1/proxyOptionalFallback", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "req_proxy_optional_fallback", input: {} }),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ data: { ok: true } });
			const completedEvent = events.find((event) => event.event === "provider_request_completed");
			const proxy = completedEvent && "proxy" in completedEvent ? completedEvent.proxy : undefined;
			expect(proxy).toEqual({
				kind: "unresolved",
				vendors: ["smartproxy"],
				failovers: [{ v: "smartproxy", p: "resolution", r: "no_credentials" }],
			});
			const telemetryHeader = response.headers.get(PROVIDER_TELEMETRY_HEADER);
			expect(telemetryHeader).toBeTruthy();
			const decoded = JSON.parse(Buffer.from(telemetryHeader ?? "", "base64url").toString("utf8"));
			expect(decoded).toEqual({ v: 1, proxy });
		} finally {
			global.fetch = originalFetch;
			if (originalSmartproxyKey === undefined) {
				delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
			} else {
				process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = originalSmartproxyKey;
			}
			clearProxyResolutionCache();
		}
	});

	it("logs the proxy failover trail when required egress has no credentials", async () => {
		const originalSmartproxyKey = process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		clearProxyResolutionCache();
		delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		const baseProvider = createTestProvider();
		const provider = {
			...baseProvider,
			allowedHosts: ["example.com"],
			proxy: { mode: "required", providers: ["smartproxy"] },
			operations: {
				...baseProvider.operations,
				proxyRequiredFailure: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async (ctx) => {
						const response = await ctx.http.get("https://example.com/unreachable");
						return response.data;
					},
				},
			},
		} satisfies ProviderDefinition;
		const events: ProviderServerLogEvent[] = [];
		const proxyApp = createServerApp(provider, { logger: (event) => events.push(event) });

		try {
			const response = await proxyApp.request("/v1/proxyRequiredFailure", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "req_proxy_required_failure", input: {} }),
			});

			expect(response.status).toBe(502);
			const failedEvent = events.find((event) => event.event === "provider_request_failed");
			expect(failedEvent && "proxy" in failedEvent ? failedEvent.proxy : undefined).toEqual({
				kind: "unresolved",
				vendors: ["smartproxy"],
				failovers: [{ v: "smartproxy", p: "resolution", r: "no_credentials" }],
			});
		} finally {
			if (originalSmartproxyKey === undefined) {
				delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
			} else {
				process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = originalSmartproxyKey;
			}
			clearProxyResolutionCache();
		}
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

	it("binds native declarations into the server context while undeclared providers stay open", async () => {
		let accepted = 0;
		const sockets = new Set<Socket>();
		const destination = createServer((socket) => {
			accepted += 1;
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		await new Promise<void>((resolve, reject) => {
			destination.once("error", reject);
			destination.listen(0, "127.0.0.1", () => resolve());
		});
		const address = destination.address();
		if (!address || typeof address === "string") throw new Error("native fixture did not bind");
		const target = { host: "127.0.0.1", port: address.port };
		const operation = {
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			handler: async (ctx: ProviderContext) => {
				const connection = await ctx.native.network.connectTcp(target);
				await connection.close();
				return { ok: true };
			},
		};

		try {
			const openProvider = {
				...createTestProvider(),
				native: {},
				operations: { nativeConnect: operation },
			} satisfies ProviderDefinition;
			const openResponse = await createServerApp(openProvider).request("/v1/nativeConnect", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "req_native_open", input: {} }),
			});
			expect(openResponse.status).toBe(200);
			expect(accepted).toBe(1);

			const unsupportedGrantProvider = {
				...createTestProvider(),
				native: {},
				operations: {
					unsupportedGrant: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						handler: async (ctx: ProviderContext) => {
							ctx.native.network.grantTcpEgress({
								sourceHost: "bootstrap.example",
								sourcePort: 443,
								host: "session.example",
								port: 5228,
								tls: "disabled",
							});
							return { ok: true };
						},
					},
				},
			} satisfies ProviderDefinition;
			const unsupportedGrantResponse = await createServerApp(unsupportedGrantProvider).request(
				"/v1/unsupportedGrant",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ requestId: "req_native_grant_unsupported", input: {} }),
				},
			);
			expect(unsupportedGrantResponse.status).toBe(502);
			expect(await unsupportedGrantResponse.json()).toMatchObject({
				error: { code: "native_dynamic_egress_unsupported" },
			});
			expect(errorObservability(unsupportedGrantResponse)).toMatchObject({
				category: "provider_error",
				retryable: false,
			});

			const enforcedProvider = {
				...createTestProvider(),
				native: {
					network: {
						tcp: [{ host: "elsewhere.example", ports: [443], tls: "disabled" }],
					},
				},
				operations: { nativeConnect: operation },
			} satisfies ProviderDefinition;
			const deniedResponse = await createServerApp(enforcedProvider).request("/v1/nativeConnect", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "req_native_denied", input: {} }),
			});
			expect(deniedResponse.status).toBe(502);
			expect(await deniedResponse.json()).toMatchObject({
				error: { code: "native_egress_not_declared", requestId: "req_native_denied" },
			});
			expect(errorObservability(deniedResponse)).toMatchObject({
				category: "provider_error",
				retryable: false,
			});
			expect(accepted).toBe(1);
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => destination.close(() => resolve()));
		}
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

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: {
					code: "BROWSER_CDP_POOL_REQUIRED",
					message: "Managed CDP Pool is required for browser providers in production",
					requestId: "req_browser_no_pool",
					retryable: false,
					source: "apifuse",
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

			expect(response.status).toBe(500);
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
		globalThis.fetch = createLocalFetchDouble(async () => {
			attempts += 1;
			if (attempts === 1) {
				throw new Error("Network error");
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
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
		globalThis.fetch = createLocalFetchDouble(async () => {
			attempts += 1;
			if (attempts === 1) {
				throw new Error("Network error");
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
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

		expect(response.status).toBe(500);
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
		const provider = createTestProvider();
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

		expect(response.status).toBe(500);
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

	it("maps an unregistered ProviderError code to 500", async () => {
		const response = await app.request("/v1/providerError", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_4",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: {
				code: "SOME_NEW_CODE",
				message: "New provider failure",
				requestId: "req_4",
				retryable: false,
				source: "apifuse",
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

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: {
				code: "TABLE_SELECTION_REQUIRED",
				message: "Table choice required",
				requestId: "req_action_required",
				retryable: false,
				source: "apifuse",
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
				retryable: false,
				source: "apifuse",
			},
		});
	});

	it("keeps every explicitly registered ProviderError code status mapping unchanged", async () => {
		const cases = [
			{ code: "AUTH_REQUIRED", status: 401 },
			{ code: "reauth_required", status: 401 },
			{ code: "MISSING_SECRET", status: 400 },
			{ code: "NOT_FOUND", status: 404 },
			{ code: "not_found", status: 404 },
			{ code: "NO_DATA", status: 404 },
			{ code: "RATE_LIMITED", status: 429 },
			{ code: "UPSTREAM_RATE_LIMIT", status: 429 },
			{ code: "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR", status: 429 },
			{ code: "UPSTREAM_ERROR", status: 502 },
			{ code: "BLOCKED", status: 502 },
			{ code: "OCR_UNAVAILABLE", status: 503 },
			{ code: "UNSUPPORTED_OCR_BACKEND", status: 503 },
			{ code: "STT_UNAVAILABLE", status: 503 },
			{ code: "UNSUPPORTED_STT_BACKEND", status: 503 },
			{ code: "STATEFUL_FORWARDING_REPLAY_CACHE_FULL", status: 503 },
		] as const;

		for (const testCase of cases) {
			const base = createTestProvider();
			const provider = {
				...base,
				operations: {
					statusProbe: {
						input: z.object({ value: z.string() }),
						output: z.object({ ok: z.boolean() }),
						handler: async () => {
							throw new ProviderError("status probe", { code: testCase.code });
						},
					},
				},
			} satisfies ProviderDefinition;
			const statusApp = createServerApp(provider, { logger: () => undefined });
			const response = await statusApp.request("/v1/statusProbe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: `req_${testCase.code}`,
					input: { value: "hello" },
				}),
			});

			expect(response.status).toBe(testCase.status);
			expect((await response.json()).error.code).toBe(testCase.code);
		}
	});

	it("serves UPSTREAM_REJECTED as a non-retryable 409 upstream rule refusal", async () => {
		const base = createTestProvider();
		const provider = createProviderDefinitionDouble({
			...base,
			operations: {
				reserve: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					handler: async () => {
						throw new ProviderError("The requested slot overlaps an existing reservation.", {
							code: "UPSTREAM_REJECTED",
							fix: "Pick a slot that does not overlap the account's existing reservations.",
						});
					},
				},
			},
		});
		const app = createServerApp(provider, { logger: () => undefined });
		const response = await app.request("/v1/reserve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_rejected", input: { value: "x" } }),
		});

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.error.code).toBe("UPSTREAM_REJECTED");
		expect(body.error.retryable).toBe(false);
		expect(body.error.source).toBe("upstream_rule");
		const observability = JSON.parse(response.headers.get("X-ApiFuse-Error-Observability") ?? "{}");
		expect(observability.category).toBe("upstream_rejected");
		expect(observability.taxonomyVersion).toBe("2026-08-07");
	});

	it("classifies operation-declared rejection statuses as upstream_rejected", async () => {
		const base = createTestProvider();
		const provider = {
			...base,
			operations: {
				order: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					docs: {
						descriptionKey: "order",
						errorCodes: [
							{
								code: "SOLD_OUT",
								status: 422 as const,
								description: "Item is sold out",
								retryable: false,
							},
						],
					},
					handler: async () => {
						throw new ProviderError("Item is sold out.", { code: "SOLD_OUT" });
					},
				},
			},
		} satisfies ProviderDefinition;
		const app = createServerApp(provider, { logger: () => undefined });
		const response = await app.request("/v1/order", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_sold_out", input: { value: "x" } }),
		});

		expect(response.status).toBe(422);
		const body = await response.json();
		expect(body.error.code).toBe("SOLD_OUT");
		expect(body.error.retryable).toBe(false);
		expect(body.error.source).toBe("upstream_rule");
		const observability = JSON.parse(response.headers.get("X-ApiFuse-Error-Observability") ?? "{}");
		expect(observability.category).toBe("upstream_rejected");
	});

	it("applies registered statuses before the ValidationError fallback", async () => {
		const cases = [
			{ kind: "validation", code: "NOT_FOUND", status: 404 },
			{ kind: "validation", code: "RATE_LIMITED", status: 429 },
			{ kind: "validation", code: "UNREGISTERED_VALIDATION", status: 400 },
			{ kind: "provider", code: "UNREGISTERED_PROVIDER", status: 500 },
		] as const;

		for (const testCase of cases) {
			const base = createTestProvider();
			const provider = {
				...base,
				operations: {
					statusProbe: {
						input: z.object({ value: z.string() }),
						output: z.object({ ok: z.boolean() }),
						handler: async () => {
							const ErrorConstructor =
								testCase.kind === "validation" ? ValidationError : ProviderError;
							throw new ErrorConstructor("status probe", { code: testCase.code });
						},
					},
				},
			} satisfies ProviderDefinition;
			const statusApp = createServerApp(provider, { logger: () => undefined });
			const response = await statusApp.request("/v1/statusProbe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: `req_${testCase.code}`,
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
				retryable: true,
				source: "upstream_failure",
				fix: "Increase timeout option",
				details: { next_action: "retry_with_longer_timeout" },
			},
		});
		expect(errorObservability(response)).toEqual({
			category: "timeout",
			taxonomyVersion: "2026-08-07",
			retryable: true,
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
				retryable: true,
				source: "upstream_failure",
			},
		});
		expect(errorObservability(response)).toEqual({
			category: "network",
			taxonomyVersion: "2026-08-07",
			retryable: true,
		});
	});

	it("keeps TransportError details provider-owned and moves all observability fields to the header", async () => {
		const response = await app.request("/v1/transportWithDetails", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_transport_details", input: { value: "hello" } }),
		});

		expect(response.status).toBe(502);
		const body = await response.json();
		expect(body.error.retryable).toBe(true);
		expect(body.error.details).toEqual({ providerReason: "inventory_unavailable" });
		expect(body.error.details).not.toHaveProperty("category");
		expect(body.error.details).not.toHaveProperty("taxonomyVersion");
		expect(body.error.details).not.toHaveProperty("upstreamStatus");
		expect(errorObservability(response)).toEqual({
			category: "upstream_http",
			taxonomyVersion: "2026-08-07",
			retryable: true,
			upstreamStatus: 502,
		});
	});

	it("lets provider-declared retryable:false override SDK derivation in body and header", async () => {
		const response = await app.request("/v1/transportExplicitNonRetryable", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_explicit_retry", input: { value: "hello" } }),
		});

		expect(response.status).toBe(502);
		const body = await response.json();
		expect(body.error.retryable).toBe(false);
		expect(body.error.details).toEqual({ retryable: true, providerPolicy: "independent" });
		expect(errorObservability(response)).toEqual({
			category: "upstream_http",
			taxonomyVersion: "2026-08-07",
			retryable: false,
			upstreamStatus: 502,
		});
	});

	it("passes non-record provider details through verbatim without a split wrapper", async () => {
		for (const [operation, expected] of [
			["transportStringDetails", "provider diagnostic"],
			["transportArrayDetails", ["first", { providerCode: 17 }]],
		] as const) {
			const response = await app.request(`/v1/${operation}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: `req_${operation}`, input: { value: "hello" } }),
			});

			expect(response.status).toBe(502);
			expect((await response.json()).error.details).toEqual(expected);
		}
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
		expect(await response.json()).toEqual({
			error: {
				code: "reauth_required",
				message: "Provider session expired",
				requestId: "req_session_retry",
				retryable: true,
				source: "client",
			},
		});
		expect(errorObservability(response)).toEqual({
			category: "credential_expired",
			taxonomyVersion: "2026-08-07",
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
		expect(await response.json()).toEqual({
			error: {
				code: "reauth_required",
				message: "Provider session expired",
				requestId: "req_session_unmarked",
				retryable: false,
				source: "client",
			},
		});
		expect(errorObservability(response)).toEqual({
			category: "credential_expired",
			taxonomyVersion: "2026-08-07",
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
				retryable: false,
				source: "upstream_failure",
			},
		});
		expect(errorObservability(response)).toEqual({
			category: "upstream_http",
			taxonomyVersion: "2026-08-07",
			retryable: false,
			upstreamStatus: 400,
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
				retryable: false,
				source: "upstream_failure",
			},
		});
		expect(errorObservability(response)).toEqual({
			category: "anti_bot_blocked",
			taxonomyVersion: "2026-08-07",
			retryable: false,
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
				retryable: true,
				source: "apifuse",
			},
		});
		expect(errorObservability(response)).toEqual({
			category: "proxy_pool",
			taxonomyVersion: "2026-08-07",
			retryable: true,
		});
	});

	it("returns Smartproxy allocator failures with private telemetry and proxy-pool classification", async () => {
		const originalFetch = global.fetch;
		const originalSmartproxyKey = process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		clearProxyResolutionCache();
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = createLocalFetchDouble(
			async () => new Response("allocator denied", { status: 503 }),
		);
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
		const events: ProviderServerLogEvent[] = [];
		const proxyApp = createServerApp(provider, { logger: (event) => events.push(event) });

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
					kind: "unresolved",
					vendors: ["smartproxy"],
					cacheStatus: "allocator",
					cacheHit: false,
					attempts: 3,
					allocatorAttempts: 3,
					allocatorStatus: 503,
					allocatorBodyClass: "http_error",
					failovers: [
						{
							v: "smartproxy",
							p: "resolution",
							r: "allocation_failed",
						},
					],
				},
			});
			expect(decoded.proxy).not.toHaveProperty("provider");
			expect(decoded.proxy).not.toHaveProperty("protocol");
			expect(decoded.proxy).not.toHaveProperty("userAgentSource");
			const failedEvent = events.find((event) => event.event === "provider_request_failed");
			expect(failedEvent).toBeDefined();
			expect(failedEvent && "proxy" in failedEvent ? failedEvent.proxy : undefined).toEqual(
				decoded.proxy,
			);
			const body = await response.json();
			expect(body.error.code).toBe("PROXY_ALLOCATION_FAILED");
			expect(body.error.retryable).toBe(true);
			expect(body.error.details).toBeUndefined();
			expect(errorObservability(response)).toMatchObject({
				category: "proxy_pool",
				retryable: true,
			});
			const serialized = JSON.stringify({ body, decoded, error: errorObservability(response) });
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
				retryable: false,
				source: "apifuse",
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
		expect(errorObservability(response)).toEqual({
			category: "internal_error",
			taxonomyVersion: "2026-08-07",
			retryable: false,
		});
	});

	it("emits provider failure events through the injected logger", async () => {
		const events: ProviderServerLogEvent[] = [];
		const appWithLogger = createServerApp(createTestProvider(), {
			logger: (event) => events.push(event),
		});

		const response = await appWithLogger.request("/v1/transportWithDetails", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_logged_upstream",
				input: { value: "hello" },
			}),
		});

		expect(response.status).toBe(502);
		const header = errorObservability(response);
		expect(events).toEqual([
			expect.objectContaining({
				level: "error",
				event: "provider_request_failed",
				providerId: "test-provider",
				kind: "operation",
				route: "transportWithDetails",
				requestId: "req_logged_upstream",
				status: 502,
				durationMs: expect.any(Number),
				cpuUserMicros: expect.any(Number),
				cpuSystemMicros: expect.any(Number),
				cpuTotalMicros: expect.any(Number),
				code: "upstream_http_error",
				errorClass: "TransportError",
				upstreamStatus: header.upstreamStatus,
				errorCategory: header.category,
				taxonomyVersion: header.taxonomyVersion,
				retryable: header.retryable,
			}),
		]);
	});

	function createCauseErrorApp(
		createError: () => ProviderError,
		events: ProviderServerLogEvent[],
		mutateLog?: (event: ProviderServerLogEvent) => void,
	) {
		const base = createTestProvider();
		const provider = {
			...base,
			operations: {
				causeError: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					handler: async () => {
						throw createError();
					},
				},
			},
		} satisfies ProviderDefinition;
		return createServerApp(provider, {
			logger: (event) => {
				mutateLog?.(event);
				events.push(event);
			},
		});
	}

	function requestCauseError(app: ReturnType<typeof createServerApp>) {
		return app.request("/v1/causeError", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_cause", input: { value: "hello" } }),
		});
	}

	function causeFingerprint(message: string): string {
		return createHash("sha256").update(message).digest("hex").slice(0, 12);
	}

	type LoggedCauseFrame = {
		errorClass: string;
		code?: string;
		message: string;
		messageLength: number;
		messageFingerprint: string;
	};

	function loggedCauseChain(
		event: ProviderServerLogEvent | undefined,
	): LoggedCauseFrame[] | undefined {
		return Object.getOwnPropertyDescriptor(event ?? {}, "causeChain")?.value;
	}

	it("logs readable redacted messages for every frame in a nested cause chain", async () => {
		const bearerToken = "fake.header.signature";
		const email = "person@example.com";
		const password = "hunter2";
		const apiKey = "sdk-test-key";
		const rawCauseMessages = [
			`vendor rejected Bearer ${bearerToken} during login`,
			`upstream rejected ${email} during lookup`,
			`choice parser rejected password=${password} and apiKey: ${apiKey}`,
		];
		const redactedCauseMessages = [
			"vendor rejected Bearer [REDACTED] during login",
			"upstream rejected [REDACTED] during lookup",
			"choice parser rejected password=[REDACTED] and apiKey: [REDACTED]",
		];
		const innermost = new ProviderError(rawCauseMessages[2], { code: "INNER_CODE" });
		const middle = new Error(rawCauseMessages[1], { cause: innermost });
		middle.name = "ProviderChoiceTokenError";
		Object.defineProperty(middle, "code", { value: "UNBRANDED_CODE" });
		const outermost = new ProviderError(rawCauseMessages[0], {
			code: "OUTER_CAUSE_CODE",
			cause: middle,
		});
		const events: ProviderServerLogEvent[] = [];
		const response = await requestCauseError(
			createCauseErrorApp(
				() =>
					new ProviderError("Pagination is temporarily unavailable.", {
						code: "CHOICE_STATE_UNAVAILABLE",
						cause: outermost,
					}),
				events,
			),
		);

		expect(response.status).toBe(500);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ event: "provider_request_failed" });
		expect(loggedCauseChain(events[0])).toEqual([
			{
				errorClass: "ProviderError",
				code: "OUTER_CAUSE_CODE",
				message: redactedCauseMessages[0],
				messageLength: rawCauseMessages[0].length,
				messageFingerprint: causeFingerprint(rawCauseMessages[0]),
			},
			{
				errorClass: "ProviderChoiceTokenError",
				message: redactedCauseMessages[1],
				messageLength: rawCauseMessages[1].length,
				messageFingerprint: causeFingerprint(rawCauseMessages[1]),
			},
			{
				errorClass: "ProviderError",
				code: "INNER_CODE",
				message: redactedCauseMessages[2],
				messageLength: rawCauseMessages[2].length,
				messageFingerprint: causeFingerprint(rawCauseMessages[2]),
			},
		]);
		const serializedEvent = JSON.stringify(events[0]);
		for (const secret of [bearerToken, email, password, apiKey]) {
			expect(serializedEvent).not.toContain(secret);
		}
		const responseBody = await response.json();
		expect(responseBody).toEqual({
			error: {
				code: "CHOICE_STATE_UNAVAILABLE",
				message: "Pagination is temporarily unavailable.",
				requestId: "req_cause",
				retryable: false,
				source: "apifuse",
			},
		});
		const serializedResponse = JSON.stringify(responseBody);
		for (const diagnostic of redactedCauseMessages) {
			expect(serializedResponse).not.toContain(diagnostic);
		}
		expect(serializedResponse).not.toContain("[REDACTED]");
	});

	it("redacts adversarial cause messages without dropping useful context", async () => {
		const opaqueToken = "tok_fake_Qj8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS";
		const traceId = "0123456789abcdef0123456789abcdef";
		const cases = [
			{
				name: "opaque token",
				raw: `decoder rejected ${opaqueToken} before retry`,
				logged: "decoder rejected [REDACTED] before retry",
				removed: [opaqueToken],
				survives: ["decoder rejected", "before retry"],
			},
			{
				name: "URL query string",
				raw: "GET https://api.example.test/login?session=secret&redirect=/home returned 401",
				logged: "GET https://api.example.test/login?[REDACTED] returned 401",
				removed: ["session=secret", "redirect=/home"],
				survives: ["GET https://api.example.test/login", "returned 401"],
			},
			{
				name: "control characters and newline",
				raw: "worker line one\nline two\u0000\u001b[31m failed",
				logged: "worker line one line two\\u0000\\u001b[31m failed",
				removed: ["\n", "\u0000", "\u001b"],
				survives: ["worker line one", "line two", "failed"],
			},
			{
				name: "trace id",
				raw: `lookup trace_id=${traceId} password=secret-value failed`,
				logged: `lookup trace_id=${traceId} password=[REDACTED] failed`,
				removed: ["secret-value"],
				survives: ["lookup", `trace_id=${traceId}`, "failed"],
			},
		];

		for (const testCase of cases) {
			const events: ProviderServerLogEvent[] = [];
			await requestCauseError(
				createCauseErrorApp(
					() =>
						new ProviderError("Public message", {
							code: "ADVERSARIAL_CAUSE",
							cause: new Error(testCase.raw),
						}),
					events,
				),
			);

			const frames = loggedCauseChain(events[0]);
			expect(frames, testCase.name).toHaveLength(1);
			expect(frames?.[0], testCase.name).toEqual({
				errorClass: "Error",
				message: testCase.logged,
				messageLength: testCase.raw.length,
				messageFingerprint: causeFingerprint(testCase.raw),
			});
			for (const sensitivePart of testCase.removed) {
				expect(frames?.[0]?.message, testCase.name).not.toContain(sensitivePart);
			}
			for (const diagnosticPart of testCase.survives) {
				expect(frames?.[0]?.message, testCase.name).toContain(diagnosticPart);
			}
		}
	});

	it("visibly truncates sanitized cause messages after 300 characters", async () => {
		const rawMessage = `upstream diagnostic: ${"ordinary detail ".repeat(30)}final detail`;
		const events: ProviderServerLogEvent[] = [];
		await requestCauseError(
			createCauseErrorApp(
				() =>
					new ProviderError("Public message", {
						code: "LONG_CAUSE",
						cause: new Error(rawMessage),
					}),
				events,
			),
		);

		const frame = loggedCauseChain(events[0])?.[0];
		expect(frame).toEqual({
			errorClass: "Error",
			message: `${rawMessage.slice(0, 300)}… [truncated]`,
			messageLength: rawMessage.length,
			messageFingerprint: causeFingerprint(rawMessage),
		});
		expect(frame?.message).toStartWith("upstream diagnostic: ordinary detail");
		expect(frame?.message).not.toContain("final detail");
		expect(frame?.message).toEndWith("… [truncated]");
	});

	it("emits validated outer provider observability in the log and header", async () => {
		const diagnostic =
			"NOL login completion errorType=LOGIN_COMPLETE_FAILED messageLength=73 messageFingerprint=038ed7ef11d8";
		const providerObservability = {
			reason: "LOGIN_COMPLETE_FAILED",
			fingerprint: "038ed7ef11d8",
			messageLength: 73,
		} satisfies ProviderErrorObservability;
		const events: ProviderServerLogEvent[] = [];
		const response = await requestCauseError(
			createCauseErrorApp(
				() =>
					new TransportError("NOL login completion failed upstream.", {
						code: "UPSTREAM_ERROR",
						category: "upstream_auth",
						retryable: true,
						cause: new Error(diagnostic),
						observability: providerObservability,
					}),
				events,
			),
		);

		expect(response.status).toBe(502);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: "provider_request_failed",
			providerObservability,
		});
		const headerObservability = errorObservability(response).providerObservability;
		expect(headerObservability).toEqual(providerObservability);
		expect(Object.getOwnPropertyDescriptor(events[0], "providerObservability")?.value).toEqual(
			headerObservability,
		);
		expect(Object.getOwnPropertyDescriptor(events[0], "causeChain")?.value).toEqual([
			expect.objectContaining({
				errorClass: "Error",
				messageLength: diagnostic.length,
				messageFingerprint: causeFingerprint(diagnostic),
			}),
		]);
		expect(JSON.stringify(events[0])).toContain("LOGIN_COMPLETE_FAILED");
		expect(JSON.stringify(events[0])).toContain("038ed7ef11d8");
		expect(await response.json()).toEqual({
			error: {
				code: "UPSTREAM_ERROR",
				message: "Upstream request failed",
				requestId: "req_cause",
				retryable: true,
				source: "upstream_failure",
			},
		});
	});

	it("isolates the observability header from logger mutations", async () => {
		const providerObservability = {
			reason: "LOGGER_SNAPSHOT",
			fingerprint: "038ed7ef11d8",
			messageLength: 73,
		} satisfies ProviderErrorObservability;
		const events: ProviderServerLogEvent[] = [];
		const response = await requestCauseError(
			createCauseErrorApp(
				() =>
					new TransportError("NOL login completion failed upstream.", {
						code: "UPSTREAM_ERROR",
						observability: providerObservability,
					}),
				events,
				(event) => {
					if (event.event !== "provider_request_failed" || !event.providerObservability) return;
					event.providerObservability.reason = "LOGGER_MUTATED";
					event.providerObservability.fingerprint = "000000000000";
					Object.defineProperty(event.providerObservability, "circular", {
						value: event.providerObservability,
					});
				},
			),
		);

		expect(response.status).toBe(502);
		expect(events[0]).toMatchObject({
			providerObservability: {
				reason: "LOGGER_MUTATED",
				fingerprint: "000000000000",
			},
		});
		expect(errorObservability(response).providerObservability).toEqual(providerObservability);
	});

	it("rejects inherited observability from the log, header, cause frame, and body", async () => {
		const inheritedObservability = {
			reason: "INHERITED_LEAK",
			fingerprint: "038ed7ef11d8",
		};
		const innerOptions = Object.assign(Object.create({ observability: inheritedObservability }), {
			code: "INNER_INHERITED_OBSERVABILITY",
		}) as ProviderErrorOptions;
		const inner = new ProviderError("Private diagnostic placeholder", innerOptions);
		const outerOptions = Object.assign(Object.create({ observability: inheritedObservability }), {
			code: "UPSTREAM_ERROR",
			cause: inner,
		}) as ProviderErrorOptions;
		const outer = new TransportError("NOL login completion failed upstream.", outerOptions);
		const events: ProviderServerLogEvent[] = [];
		const response = await requestCauseError(createCauseErrorApp(() => outer, events));

		const header = errorObservability(response);
		const body = await response.json();
		const frame = Object.getOwnPropertyDescriptor(events[0], "causeChain")?.value?.[0];
		expect(Object.getOwnPropertyDescriptor(outerOptions, "observability")).toBeUndefined();
		expect(events[0]).not.toHaveProperty("providerObservability");
		expect(header).not.toHaveProperty("providerObservability");
		expect(frame).not.toHaveProperty("providerObservability");
		for (const channel of [
			JSON.stringify(events[0]),
			JSON.stringify(header),
			JSON.stringify(frame),
			JSON.stringify(body),
		]) {
			expect(channel).not.toContain(inheritedObservability.reason);
			expect(channel).not.toContain(inheritedObservability.fingerprint);
		}
	});

	it("rejects observability accessors without invoking their getters", async () => {
		const accessorObservability = {
			reason: "ACCESSOR_LEAK",
			fingerprint: "038ed7ef11d8",
		};
		let getterCalls = 0;
		const innerOptions: ProviderErrorOptions = { code: "INNER_ACCESSOR_OBSERVABILITY" };
		Object.defineProperty(innerOptions, "observability", {
			get() {
				getterCalls += 1;
				return accessorObservability;
			},
		});
		const inner = new ProviderError("Private diagnostic placeholder", innerOptions);
		const outerOptions: ProviderErrorOptions = { code: "UPSTREAM_ERROR", cause: inner };
		Object.defineProperty(outerOptions, "observability", {
			get() {
				getterCalls += 1;
				return accessorObservability;
			},
		});
		const outer = new TransportError("NOL login completion failed upstream.", outerOptions);
		const events: ProviderServerLogEvent[] = [];
		const response = await requestCauseError(createCauseErrorApp(() => outer, events));

		const header = errorObservability(response);
		const body = await response.json();
		const frame = Object.getOwnPropertyDescriptor(events[0], "causeChain")?.value?.[0];
		expect(getterCalls).toBe(0);
		expect(events[0]).not.toHaveProperty("providerObservability");
		expect(header).not.toHaveProperty("providerObservability");
		expect(frame).not.toHaveProperty("providerObservability");
		for (const channel of [
			JSON.stringify(events[0]),
			JSON.stringify(header),
			JSON.stringify(frame),
			JSON.stringify(body),
		]) {
			expect(channel).not.toContain(accessorObservability.reason);
			expect(channel).not.toContain(accessorObservability.fingerprint);
		}
	});

	it("rejects observability from options accessors at the HTTP boundary", async () => {
		const accessorObservability = {
			reason: "OPTIONS_ACCESSOR_LEAK",
			fingerprint: "038ed7ef11d8",
		};
		const inner = new ProviderError("Private diagnostic placeholder", {
			code: "INNER_OPTIONS_ACCESSOR",
		});
		Object.defineProperty(inner, "options", {
			get() {
				return {
					code: "INNER_OPTIONS_ACCESSOR",
					observability: accessorObservability,
				};
			},
		});
		const outer = new TransportError("NOL login completion failed upstream.", {
			code: "UPSTREAM_ERROR",
			cause: inner,
		});
		Object.defineProperty(outer, "options", {
			get() {
				return { code: "UPSTREAM_ERROR", cause: inner, observability: accessorObservability };
			},
		});
		const events: ProviderServerLogEvent[] = [];
		const response = await requestCauseError(createCauseErrorApp(() => outer, events));

		const header = errorObservability(response);
		const body = await response.json();
		const frame = Object.getOwnPropertyDescriptor(events[0], "causeChain")?.value?.[0];
		expect(frame).not.toHaveProperty("providerObservability");
		for (const channel of [
			JSON.stringify(events[0]),
			JSON.stringify(header),
			JSON.stringify(frame),
			JSON.stringify(body),
		]) {
			expect(channel).not.toContain(accessorObservability.reason);
			expect(channel).not.toContain(accessorObservability.fingerprint);
		}
	});

	it("rejects an options accessor without invoking it in safe observability extraction", () => {
		const accessorObservability = {
			reason: "OPTIONS_ACCESSOR_LEAK",
			fingerprint: "038ed7ef11d8",
		};
		const error = new ProviderError("Private diagnostic placeholder", {
			code: "OPTIONS_ACCESSOR",
		});
		let getterCalls = 0;
		Object.defineProperty(error, "options", {
			get() {
				getterCalls += 1;
				return { code: "OPTIONS_ACCESSOR", observability: accessorObservability };
			},
		});

		expect(safeProviderErrorObservability(error)).toBeUndefined();
		expect(getterCalls).toBe(0);
	});

	it("adds validated observability from a branded inner cause to its frame", async () => {
		const providerObservability = {
			reason: "LOGIN_COMPLETE_FAILED",
			fingerprint: "038ed7ef11d8",
			messageLength: 73,
		} satisfies ProviderErrorObservability;
		const events: ProviderServerLogEvent[] = [];
		const response = await requestCauseError(
			createCauseErrorApp(
				() =>
					new TransportError("NOL login completion failed upstream.", {
						code: "UPSTREAM_ERROR",
						cause: new ProviderError("Private provider diagnostic", {
							code: "INNER_DIAGNOSTIC",
							observability: providerObservability,
						}),
					}),
				events,
			),
		);

		expect(response.status).toBe(502);
		expect(events[0]).not.toHaveProperty("providerObservability");
		expect(errorObservability(response)).not.toHaveProperty("providerObservability");
		expect(Object.getOwnPropertyDescriptor(events[0], "causeChain")?.value).toEqual([
			{
				errorClass: "ProviderError",
				code: "INNER_DIAGNOSTIC",
				message: "Private provider diagnostic",
				messageLength: "Private provider diagnostic".length,
				messageFingerprint: causeFingerprint("Private provider diagnostic"),
				providerObservability,
			},
		]);
	});

	it("emits only allowlisted observability fields from mixed metadata", async () => {
		const providerObservability = {
			reason: "LOGIN_COMPLETE_FAILED",
			fingerprint: "038ed7ef11d8",
			email: "mixed-operator@example.com",
			password: "mixed-password-secret",
			cookie: "mixed_session=cookie-secret; Path=/",
			token: "mixed.jwt.token-secret",
		};
		const unsafeObservability: ProviderErrorObservability = providerObservability;
		const allowlistedObservability = {
			reason: providerObservability.reason,
			fingerprint: providerObservability.fingerprint,
		};
		const inner = new ProviderError("Private diagnostic placeholder", {
			code: "INNER_MIXED_METADATA",
			observability: unsafeObservability,
		});
		const events: ProviderServerLogEvent[] = [];
		const response = await requestCauseError(
			createCauseErrorApp(
				() =>
					new TransportError("NOL login completion failed upstream.", {
						code: "UPSTREAM_ERROR",
						cause: inner,
						observability: unsafeObservability,
					}),
				events,
			),
		);

		const body = await response.json();
		const rawHeader = response.headers.get(ERROR_OBSERVABILITY_HEADER);
		expect(rawHeader).toBeTruthy();
		if (rawHeader === null) throw new Error("Expected error observability header");
		const decodedHeader: unknown = JSON.parse(rawHeader);
		const frame = Object.getOwnPropertyDescriptor(events[0], "causeChain")?.value?.[0];
		expect(events[0]).toHaveProperty("providerObservability", allowlistedObservability);
		expect(decodedHeader).toHaveProperty("providerObservability", allowlistedObservability);
		expect(frame).toHaveProperty("providerObservability", allowlistedObservability);

		const channels = [
			JSON.stringify(events[0]),
			rawHeader,
			JSON.stringify(frame),
			JSON.stringify(body),
		];
		for (const forbidden of [
			providerObservability.email,
			providerObservability.password,
			providerObservability.cookie,
			providerObservability.token,
		]) {
			for (const channel of channels) {
				expect(channel).not.toContain(forbidden);
			}
		}
	});

	it("drops invalid and non-allowlisted observability from every output channel", async () => {
		const invalidReasons = [
			"LOGIN COMPLETE FAILED",
			"LOGIN/COMPLETE/FAILED",
			"NOL login completion failed with an upstream body",
			"R".repeat(65),
		];
		const sensitiveValues = [
			"operator@example.com",
			"p@ssword with spaces",
			"session_id=cookie-secret; Path=/",
			"eyJhbGciOiJIUzI1NiJ9.test-token.signature",
		];
		const oversizedKey = `private_${"k".repeat(80)}`;
		const oversizedValue = `private_${"v".repeat(100)}`;

		for (const reason of invalidReasons) {
			const unsafeObservabilityInput = {
				reason,
				fingerprint: "not-a-12hex-fingerprint",
				messageLength: 10_000_001,
				email: sensitiveValues[0],
				password: sensitiveValues[1],
				cookie: sensitiveValues[2],
				token: sensitiveValues[3],
				[oversizedKey]: oversizedValue,
			};
			const unsafeObservability: ProviderErrorObservability = unsafeObservabilityInput;
			const inner = new ProviderError("Private diagnostic placeholder", {
				code: "INNER_INVALID_METADATA",
				observability: unsafeObservability,
			});
			const events: ProviderServerLogEvent[] = [];
			const response = await requestCauseError(
				createCauseErrorApp(
					() =>
						new TransportError("NOL login completion failed upstream.", {
							code: "UPSTREAM_ERROR",
							cause: inner,
							observability: unsafeObservability,
						}),
					events,
				),
			);

			const body = await response.json();
			const rawHeader = response.headers.get(ERROR_OBSERVABILITY_HEADER);
			expect(rawHeader).toBeTruthy();
			if (rawHeader === null) throw new Error("Expected error observability header");
			const decodedHeader: unknown = JSON.parse(rawHeader);
			const frame = Object.getOwnPropertyDescriptor(events[0], "causeChain")?.value?.[0];
			expect(events[0]).not.toHaveProperty("providerObservability");
			expect(decodedHeader).not.toHaveProperty("providerObservability");
			expect(frame).not.toHaveProperty("providerObservability");
			const serialized = JSON.stringify({ event: events[0], decodedHeader, frame, body });
			for (const forbidden of [
				reason,
				"not-a-12hex-fingerprint",
				oversizedKey,
				oversizedValue,
				...sensitiveValues,
			]) {
				expect(serialized).not.toContain(forbidden);
			}
		}
	});

	it("truncates cause chains deeper than five frames", async () => {
		let cause: Error = new Error("666666");
		for (let index = 5; index >= 1; index -= 1) {
			cause = new Error(String(index).repeat(index), { cause });
		}
		const events: ProviderServerLogEvent[] = [];
		await requestCauseError(
			createCauseErrorApp(
				() => new ProviderError("Public message", { code: "DEEP_CAUSE", cause }),
				events,
			),
		);

		expect(Object.getOwnPropertyDescriptor(events[0], "causeChain")?.value).toEqual([
			expect.objectContaining({ errorClass: "Error", messageLength: 1 }),
			expect.objectContaining({ errorClass: "Error", messageLength: 2 }),
			expect.objectContaining({ errorClass: "Error", messageLength: 3 }),
			expect.objectContaining({ errorClass: "Error", messageLength: 4 }),
			expect.objectContaining({ errorClass: "Error", messageLength: 5 }),
		]);
	});

	it("terminates cyclic cause chains without repeating a frame", async () => {
		const first = new Error("cycle first");
		const second = new Error("cycle second", { cause: first });
		first.cause = second;
		const events: ProviderServerLogEvent[] = [];
		await requestCauseError(
			createCauseErrorApp(
				() => new ProviderError("Public message", { code: "CYCLIC_CAUSE", cause: first }),
				events,
			),
		);

		expect(Object.getOwnPropertyDescriptor(events[0], "causeChain")?.value).toEqual([
			expect.objectContaining({ errorClass: "Error", messageLength: "cycle first".length }),
			expect.objectContaining({ errorClass: "Error", messageLength: "cycle second".length }),
		]);
	});

	it("omits causeChain when the provider error has no cause", async () => {
		const events: ProviderServerLogEvent[] = [];
		await requestCauseError(
			createCauseErrorApp(() => new ProviderError("Public message", { code: "NO_CAUSE" }), events),
		);

		expect(events).toHaveLength(1);
		expect(events[0]).not.toHaveProperty("causeChain");
		expect(events[0]).not.toHaveProperty("providerObservability");
	});

	it("emits a greppable signal for an unregistered code and preserves ValidationError as 400", async () => {
		const events: ProviderServerLogEvent[] = [];
		const appWithLogger = createServerApp(createTestProvider(), {
			logger: (event) => events.push(event),
		});

		const unregistered = await appWithLogger.request("/v1/providerError", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_unregistered", input: { value: "hello" } }),
		});
		expect(unregistered.status).toBe(500);
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "provider_request_failed",
				code: "SOME_NEW_CODE",
				signal: "unregistered_provider_error_code",
			}),
		);

		const validation = await appWithLogger.request("/v1/validationError", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_validation", input: { value: "hello" } }),
		});
		expect(validation.status).toBe(400);
		expect(await validation.json()).toMatchObject({
			error: { code: "SOME_NEW_CODE", retryable: false },
		});
		expect(errorObservability(validation)).toMatchObject({
			category: "input_validation",
			retryable: false,
		});

		const sdkOwned = await appWithLogger.request("/v1/rawSseResponse", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_sdk_owned", input: { value: "hello" } }),
		});
		expect(sdkOwned.status).toBe(500);
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "provider_request_failed",
				code: "SSE_RESULT_UNSUPPORTED",
			}),
		);
		expect(events).not.toContainEqual(
			expect.objectContaining({
				code: "SSE_RESULT_UNSUPPORTED",
				signal: "unregistered_provider_error_code",
			}),
		);
	});

	it("returns zod invalid_request details with top-level retryability and observability header", async () => {
		const response = await app.request("/v1/echo", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: { value: "hello" } }),
		});

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error.code).toBe("invalid_request");
		expect(body.error.retryable).toBe(false);
		expect(body.error.details).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "requestId" })]),
		);
		expect(errorObservability(response)).toEqual({
			category: "input_validation",
			taxonomyVersion: "2026-08-07",
			retryable: false,
		});
	});

	it("classifies invalid handler output as a non-client output validation failure", async () => {
		const response = await app.request("/v1/invalidOutput", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_invalid_output", input: { value: "hello" } }),
		});

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: {
				code: "OUTPUT_VALIDATION_FAILED",
				requestId: "req_invalid_output",
				retryable: false,
			},
		});
		expect(errorObservability(response)).toEqual({
			category: "output_validation",
			taxonomyVersion: "2026-08-07",
			retryable: false,
		});
	});

	it("returns 404 for unknown routes", async () => {
		const response = await app.request("/missing");

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				code: "not_found",
				message: "Not found",
				retryable: false,
				source: "apifuse",
			},
		});
		expect(errorObservability(response)).toMatchObject({
			category: "provider_error",
			retryable: false,
		});
	});
});

describe("operation-declared error resolution", () => {
	function createDeclaredErrorApp(input: {
		entry?: OperationErrorCode;
		createError: () => ProviderError;
		logger?: (event: ProviderServerLogEvent) => void;
	}) {
		const base = createTestProvider();
		const provider = {
			...base,
			operations: {
				declaredError: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					...(input.entry ? { docs: { errorCodes: [input.entry] } } : {}),
					handler: async () => {
						throw input.createError();
					},
				},
			},
		} satisfies ProviderDefinition;
		return createServerApp(provider, { logger: input.logger ?? (() => undefined) });
	}

	function requestDeclaredError(app: ReturnType<typeof createServerApp>) {
		return app.request("/v1/declaredError", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_declared_error", input: { value: "hello" } }),
		});
	}

	it("uses a declared 502 and retryability consistently without an unregistered signal", async () => {
		const events: ProviderServerLogEvent[] = [];
		const response = await requestDeclaredError(
			createDeclaredErrorApp({
				entry: {
					code: "UPSTREAM_SCHEMA_ERROR",
					status: 502,
					description: "Upstream schema changed",
					retryable: true,
				},
				createError: () =>
					new ProviderError("Upstream schema changed", { code: "UPSTREAM_SCHEMA_ERROR" }),
				logger: (event) => events.push(event),
			}),
		);

		expect(response.status).toBe(502);
		const body = await response.json();
		const header = errorObservability(response);
		expect(body.error.retryable).toBe(true);
		expect(header).toEqual({
			category: "provider_error",
			taxonomyVersion: "2026-08-07",
			retryable: true,
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: "provider_request_failed",
			status: 502,
			code: "UPSTREAM_SCHEMA_ERROR",
			errorCategory: header.category,
			taxonomyVersion: header.taxonomyVersion,
			retryable: header.retryable,
		});
		expect(events[0]).not.toHaveProperty("signal");
	});

	it("applies declared status and retryable precedence in one resolution order", async () => {
		const cases = [
			{
				name: "statusless declaration",
				entry: {
					code: "STATUSLESS_CUSTOM",
					description: "Custom failure",
					retryable: true,
				},
				createError: () => new ProviderError("Custom failure", { code: "STATUSLESS_CUSTOM" }),
				status: 500,
				retryable: true,
			},
			{
				name: "instance-explicit retryable",
				entry: {
					code: "INSTANCE_POLICY",
					status: 502,
					description: "Instance owns retry policy",
					retryable: true,
				},
				createError: () =>
					new ProviderError("Do not retry", { code: "INSTANCE_POLICY", retryable: false }),
				status: 502,
				retryable: false,
			},
			{
				name: "declared ValidationError",
				entry: {
					code: "UPSTREAM_VALIDATION_FAILURE",
					status: 502,
					description: "Upstream response was invalid",
					retryable: true,
				},
				createError: () =>
					new ValidationError("Upstream response was invalid", {
						code: "UPSTREAM_VALIDATION_FAILURE",
					}),
				status: 502,
				retryable: true,
			},
		] as const;

		for (const testCase of cases) {
			const events: ProviderServerLogEvent[] = [];
			const response = await requestDeclaredError(
				createDeclaredErrorApp({
					entry: testCase.entry,
					createError: testCase.createError,
					logger: (event) => events.push(event),
				}),
			);

			expect(response.status, testCase.name).toBe(testCase.status);
			expect((await response.json()).error.retryable, testCase.name).toBe(testCase.retryable);
			expect(errorObservability(response).retryable, testCase.name).toBe(testCase.retryable);
			expect(events[0], testCase.name).toMatchObject({ retryable: testCase.retryable });
			expect(events[0], testCase.name).not.toHaveProperty("signal");
		}
	});

	it("does not let a declaration override an SDK-owned code", async () => {
		const events: ProviderServerLogEvent[] = [];
		const response = await requestDeclaredError(
			createDeclaredErrorApp({
				entry: {
					code: "SSE_RESULT_UNSUPPORTED",
					status: 502,
					description: "Conflicts with the SDK mapping",
					retryable: true,
				},
				createError: () =>
					new ProviderError("SDK-owned failure", { code: "SSE_RESULT_UNSUPPORTED" }),
				logger: (event) => events.push(event),
			}),
		);

		expect(response.status).toBe(500);
		expect((await response.json()).error.retryable).toBe(false);
		expect(errorObservability(response).retryable).toBe(false);
		expect(events[0]).not.toHaveProperty("signal");
	});

	it("preserves canonical resolution for declared SDK-generated errors", async () => {
		const cases = [
			{
				name: "session expiry",
				entry: {
					code: "reauth_required",
					status: 502,
					description: "Conflicts with credential refresh detection",
				},
				createError: () => new SessionExpiredError(),
				status: 401,
				category: "credential_expired",
				code: "reauth_required",
			},
			{
				name: "output validation failure",
				entry: {
					code: "OUTPUT_VALIDATION_FAILED",
					status: 400,
					description: "Conflicts with SDK output validation",
				},
				createError: () =>
					new ValidationError("Operation handler output failed schema validation.", {
						code: "OUTPUT_VALIDATION_FAILED",
						category: "output_validation",
						retryable: false,
					}),
				status: 500,
				category: "output_validation",
				code: "OUTPUT_VALIDATION_FAILED",
			},
		] as const;

		for (const testCase of cases) {
			const events: ProviderServerLogEvent[] = [];
			const response = await requestDeclaredError(
				createDeclaredErrorApp({
					entry: testCase.entry,
					createError: testCase.createError,
					logger: (event) => events.push(event),
				}),
			);

			expect(response.status, testCase.name).toBe(testCase.status);
			expect(await response.json(), testCase.name).toMatchObject({
				error: { code: testCase.code, retryable: false },
			});
			expect(errorObservability(response), testCase.name).toMatchObject({
				category: testCase.category,
				retryable: false,
			});
			expect(events[0], testCase.name).toMatchObject({
				status: testCase.status,
				errorCategory: testCase.category,
				retryable: false,
			});
			expect(events[0], testCase.name).not.toHaveProperty("signal");
		}
	});

	it("classifies ValidationError from the effective declared status unless instance-explicit", async () => {
		const cases: Array<{
			name: string;
			entry?: OperationErrorCode;
			createError: () => ValidationError;
			status: number;
			category: string;
		}> = [
			{
				name: "declared provider failure",
				entry: {
					code: "UPSTREAM_VALIDATION_FAILURE",
					status: 502,
					description: "Upstream response was invalid",
				},
				createError: () =>
					new ValidationError("Upstream response was invalid", {
						code: "UPSTREAM_VALIDATION_FAILURE",
					}),
				status: 502,
				category: "provider_error",
			},
			{
				name: "instance-explicit output failure",
				entry: {
					code: "EXPLICIT_OUTPUT_VALIDATION_FAILURE",
					status: 502,
					description: "Output was invalid",
				},
				createError: () =>
					new ValidationError("Output was invalid", {
						code: "EXPLICIT_OUTPUT_VALIDATION_FAILURE",
						category: "output_validation",
					}),
				status: 502,
				category: "output_validation",
			},
			{
				name: "undeclared input failure",
				createError: () =>
					new ValidationError("Input was invalid", { code: "UNDECLARED_VALIDATION_FAILURE" }),
				status: 400,
				category: "input_validation",
			},
		];

		for (const testCase of cases) {
			const events: ProviderServerLogEvent[] = [];
			const response = await requestDeclaredError(
				createDeclaredErrorApp({
					entry: testCase.entry,
					createError: testCase.createError,
					logger: (event) => events.push(event),
				}),
			);

			expect(response.status, testCase.name).toBe(testCase.status);
			expect(errorObservability(response), testCase.name).toMatchObject({
				category: testCase.category,
			});
			expect(events[0], testCase.name).toMatchObject({
				status: testCase.status,
				errorCategory: testCase.category,
			});
		}
	});

	it("ignores a structurally supplied non-emittable declared status", async () => {
		const base = createTestProvider();
		const provider = createProviderDefinitionDouble({
			...base,
			operations: {
				structuralError: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					docs: {
						errorCodes: [
							{
								code: "STRUCTURAL_INVALID_STATUS",
								// @ts-expect-error test-invalid: structural validation must reject non-emittable status
								status: 600,
								description: "Invalid structural status",
							},
						],
					},
					handler: async () => {
						throw new ProviderError("Structural failure", {
							code: "STRUCTURAL_INVALID_STATUS",
						});
					},
				},
			},
		});
		const app = createServerApp(provider, { logger: () => undefined });

		const response = await app.request("/v1/structuralError", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_structural", input: { value: "hello" } }),
		});

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: {
				code: "STRUCTURAL_INVALID_STATUS",
				message: "Structural failure",
				requestId: "req_structural",
				retryable: false,
				source: "apifuse",
			},
		});
		expect(errorObservability(response)).toEqual({
			category: "provider_error",
			taxonomyVersion: "2026-08-07",
			retryable: false,
		});
	});
});

describe("provider HTTP server cross-module error identity", () => {
	async function createDuplicateInstanceApp() {
		// Genuine second module identity for the SDK errors, modelling the packaged
		// src/* server importing errors whose provider throws dist/* errors.
		// @ts-expect-error test-invalid: Bun query import intentionally creates a duplicate module identity
		// biome-ignore lint/correctness/useImportExtensions: the query mints a second module identity under bun test
		const Dup = await import("../errors.ts?duplicate-sdk-instance");
		const base = createTestProvider();
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
				dupDeclaredProviderError: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					docs: {
						errorCodes: [
							{
								code: "DUPLICATE_DECLARED_ERROR",
								status: 502,
								description: "Duplicate-module declared failure",
								retryable: true,
							},
						],
					},
					handler: async () => {
						throw new Dup.ProviderError("Duplicate declared failure", {
							code: "DUPLICATE_DECLARED_ERROR",
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
				dupValidation: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					handler: async () => {
						throw new Dup.ValidationError("Invalid provider input", {
							code: "SOME_NEW_CODE",
						});
					},
				},
				preBrandValidation: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					handler: async () => {
						const error = new Dup.ProviderError("Invalid provider input", {
							code: "SOME_NEW_CODE",
						});
						error.name = "ValidationError";
						throw error;
					},
				},
				unbrandedLookalike: {
					input: z.object({ value: z.string() }),
					output: z.object({ ok: z.boolean() }),
					handler: async () => {
						const err = Object.assign(new Error("Missing provider service key"), {
							code: "CONFIGURATION_ERROR",
							options: { code: "CONFIGURATION_ERROR" },
						});
						err.name = "ProviderError";
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

	it("classifies a duplicate-instance unregistered ProviderError as provider-owned 500", async () => {
		const app = await createDuplicateInstanceApp();
		const response = await requestOperation(app, "dupProviderError");

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: {
				code: "CONFIGURATION_ERROR",
				message: "Missing provider service key",
				requestId: "req_dupProviderError",
				retryable: false,
				source: "apifuse",
				fix: "Set the provider service key.",
			},
		});
	});

	it("honors declarations for duplicate-instance ProviderError values", async () => {
		const app = await createDuplicateInstanceApp();
		const response = await requestOperation(app, "dupDeclaredProviderError");

		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({
			error: { code: "DUPLICATE_DECLARED_ERROR", retryable: true },
		});
		expect(errorObservability(response).retryable).toBe(true);
	});

	it("classifies a duplicate-instance SessionExpiredError as reauth_required", async () => {
		const app = await createDuplicateInstanceApp();
		const response = await requestOperation(app, "dupSessionExpired");

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: {
				code: "reauth_required",
				message: "Provider session expired",
				requestId: "req_dupSessionExpired",
				retryable: false,
				source: "client",
			},
		});
		expect(errorObservability(response)).toMatchObject({
			category: "credential_expired",
			retryable: false,
		});
	});

	it("classifies a duplicate-instance TransportError as a 504 upstream failure", async () => {
		const app = await createDuplicateInstanceApp();
		const response = await requestOperation(app, "dupTransport");

		expect(response.status).toBe(504);
		expect((await response.json()).error.code).toBe("transport_timeout");
	});

	it("keeps a duplicate-instance ValidationError with an unregistered code at 400", async () => {
		const app = await createDuplicateInstanceApp();
		const response = await requestOperation(app, "dupValidation");

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "SOME_NEW_CODE", retryable: false },
		});
		expect(errorObservability(response)).toMatchObject({ category: "input_validation" });
	});

	it("keeps a pre-validation-brand cross-module ValidationError at 400", async () => {
		const app = await createDuplicateInstanceApp();
		const response = await requestOperation(app, "preBrandValidation");

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "SOME_NEW_CODE", retryable: false },
		});
		expect(errorObservability(response)).toMatchObject({ category: "input_validation" });
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
				retryable: false,
				source: "apifuse",
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
		const base = createTestProvider();
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
			expect(body.error.retryable).toBe(false);
			expect(body.error.details).toBeUndefined();
			expect(errorObservability(response)).toEqual({
				category: "credential_unavailable",
				taxonomyVersion: "2026-08-07",
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
			expect(body.error.retryable).toBe(false);
			expect(body.error.details).toBeUndefined();
			expect(errorObservability(response)).toMatchObject({
				category: "credential_unavailable",
				retryable: false,
			});
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
