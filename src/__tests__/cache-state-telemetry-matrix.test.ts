import { afterEach, expect, it } from "bun:test";
import { z } from "zod";
import { resetProviderCacheForTests } from "../runtime/cache.js";
import { CacheTelemetryCollector } from "../runtime/cache-telemetry.js";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/request-telemetry.js";
import {
	getResolverSolutionSource,
	swapResolverAdapterFactoryForTests,
} from "../runtime/resolver.js";
import { createMemoryProviderRuntimeState } from "../runtime/state.js";
import { StateTelemetryCollector } from "../runtime/state-telemetry.js";
import {
	createServerApp,
	createServerAppAsync,
	type ProviderServerLogEvent,
} from "../server/serve.js";
import { statefulSignedHeaders } from "../stateful-signing.js";
import type { FlowContext, ProviderContext, ProviderDefinition } from "../types.js";

const sentinel = "SENTINEL12CHARS";
afterEach(resetProviderCacheForTests);
for (const factory of ["sync", "async"] as const) {
	for (const outcome of ["success", "failure", "unused", "unused failure"] as const) {
		it.each([
			"operation",
			"start",
			"continue",
			"poll",
			"refresh",
			"disconnect",
			"signed stateful",
		] as const)(`cache/state construction matrix: ${factory} ${outcome} %s`, async (route) => {
			const used = !outcome.startsWith("unused");
			const authRoute = route !== "operation" && route !== "signed stateful";
			const cacheUsed = used && !authRoute;
			const failed = outcome.includes("failure");
			const effectiveFailed = failed;
			const probe = async (ctx: Pick<ProviderContext, "cache" | "state">) => {
				if (used) {
					await ctx.cache.getOrSet("matrix-key", async () => ({ value: sentinel }), {
						ttlMs: 1000,
					});
					// The instrumentation layer wraps the namespace result again for tracing.
					await ctx.state
						.namespace("x", { defaultTtl: "1h", maxTtl: "1d", maxEntries: 10, maxValueBytes: 1000 })
						.set(`user:${sentinel}:profile`, { value: sentinel });
				}
				if (failed) throw new Error("matrix failure");
				return { status: 200 };
			};
			const flowProbe = async (ctx: import("../types.js").FlowContext) => {
				if (used) {
					if (!ctx.state) throw new Error("auth state context missing");
					await ctx.state
						.namespace("x", { defaultTtl: "1h", maxTtl: "1d", maxEntries: 10, maxValueBytes: 1000 })
						.set(`user:${sentinel}:profile`, { value: sentinel });
				}
				if (failed) throw new Error("matrix failure");
				return { kind: "complete" as const, turnId: "done", data: { status: 200 } };
			};
			const provider: ProviderDefinition = {
				id: "cache-state-matrix",
				version: "1.0.0",
				runtime: "standard",
				meta: { displayName: "Storage matrix", descriptionKey: "description", category: "test" },
				cache: true,
				state: true,
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
			const app = await (factory === "sync" ? createServerApp : createServerAppAsync)(provider, {
				logger: (event) => events.push(event),
				state: createMemoryProviderRuntimeState(),
				statefulForwarding: { secret: "matrix-forwarding", validateOwnerFence: async () => true },
				internalOperationExecutor: async ({ ctx }) => probe(ctx),
			});
			const signed = route === "signed stateful";
			const path = signed
				? "/__apifuse/stateful/operations"
				: route === "operation"
					? "/v1/probe"
					: `/auth/${route}`;
			const timestamp = new Date().toISOString();
			const request = {
				requestId: `${factory}-${outcome}-${route}`,
				input: {},
				...(route !== "operation" && !signed ? { flowId: "flow" } : {}),
				connection: {
					id: "connection",
					mode: "credentials",
					externalRef: "external",
					metadata: {},
					secrets: { token: sentinel },
				},
			};
			const body = JSON.stringify(
				signed
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
					...(signed
						? {
								"x-apifuse-stateful-source-pod": "source",
								...statefulSignedHeaders({
									secret: "matrix-forwarding",
									timestamp,
									rawBody: body,
									method: "POST",
									path,
								}),
							}
						: {}),
				},
			});
			expect(response.status, JSON.stringify(events)).toBe(effectiveFailed ? 500 : 200);
			expect(events).toHaveLength(1);
			const terminal = events[0]!;
			expect(terminal.event).toBe(
				effectiveFailed ? "provider_request_failed" : "provider_request_completed",
			);
			// test-invalid: terminal log events are a discriminated union whose contributor fields are not exposed on the shared public type.
			const log = terminal as {
				cache?: ReturnType<CacheTelemetryCollector["toLogPayload"]>;
				state?: ReturnType<StateTelemetryCollector["toLogPayload"]>;
			};
			const encoded = response.headers.get(PROVIDER_TELEMETRY_HEADER);
			const header = encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString()) : {};
			if (cacheUsed) {
				expect(log.cache?.lookups, `${factory} ${route}: cache sink missing`).toBe(1);
				expect(log.cache?.writes).toBe(1);
				expect(header.cache).toEqual(new CacheTelemetryCollector().toHeaderPayload(log.cache!));
			} else {
				expect(log).not.toHaveProperty("cache");
				expect(header).not.toHaveProperty("cache");
			}
			if (used) {
				expect(log.state?.ops.set, `${factory} ${route}: state sink missing`).toBe(1);
				expect(log.state?.samples).toHaveLength(1);
				expect(log.state?.samples[0]?.key).toBe("user:[REDACTED]:profile");
				expect(header.state).toEqual(new StateTelemetryCollector().toHeaderPayload(log.state!));
				expect(JSON.stringify(header)).not.toContain('"key"');
				expect(JSON.stringify({ terminal, header })).not.toContain(sentinel);
				if (
					process.env.APIFUSE_P6C_PRINT_EXAMPLE === "1" &&
					factory === "sync" &&
					route === "operation" &&
					outcome === "success"
				)
					console.log(`P6C_HEADER=${JSON.stringify(header)}`);
			} else {
				for (const surface of [log, header]) {
					expect(surface).not.toHaveProperty("state");
				}
			}
		});
	}
}

for (const [factory, create] of [
	["sync", createServerApp],
	["async", createServerAppAsync],
] as const) {
	for (const usage of ["cacheable browser", "non-cacheable capsolver", "unused browser"] as const) {
		it.each([
			"start",
			"continue",
			"poll",
			"refresh",
			"disconnect",
		] as const)(`auth resolver cache matrix: ${factory} ${usage} %s`, async (route) => {
			const cacheable = usage === "cacheable browser";
			const vendor = usage === "non-cacheable capsolver" ? "capsolver" : "browser";
			let calls = 0;
			const sources: Array<ReturnType<typeof getResolverSolutionSource>> = [];
			const restore = swapResolverAdapterFactoryForTests(vendor, () => ({
				id: vendor,
				supports: () => true,
				async solve() {
					calls++;
					return vendor === "browser"
						? {
								form: "cookies",
								cookies: { "aws-waf-token": "synthetic-cookie" },
								userAgent: "matrix-agent",
								expires: Date.now() / 1000 + 60,
							}
						: { form: "token", token: "synthetic-token" };
				},
			}));
			const envKey = "APIFUSE__RESOLVER__CAPSOLVER__API_KEY";
			const previous = process.env[envKey];
			process.env[envKey] = "synthetic-engine-key";
			try {
				const flow = async (ctx: FlowContext) => {
					if (usage !== "unused browser") {
						for (let invocation = 0; invocation < 2; invocation++) {
							const solution = await ctx.resolver.solve(
								vendor === "browser"
									? { kind: "aws_waf", pageUrl: "https://example.com/protected" }
									: { kind: "turnstile", pageUrl: "https://example.com", siteKey: "site" },
							);
							sources.push(getResolverSolutionSource(solution));
						}
					}
					return { kind: "complete" as const, turnId: "done", data: { ok: true } };
				};
				const provider: ProviderDefinition = {
					id: "auth-resolver-cache-matrix",
					version: "1.0.0",
					runtime: "standard",
					meta: { displayName: "Auth cache", descriptionKey: "description", category: "test" },
					allowedHosts: ["example.com"],
					resolver: { kinds: [vendor === "browser" ? "aws_waf" : "turnstile"], vendors: [vendor] },
					operations: {},
					auth: {
						mode: "credentials",
						flow: { start: flow, continue: flow, poll: flow, refresh: flow, abort: flow },
					},
				};
				const events: ProviderServerLogEvent[] = [];
				const app = await create(provider, { logger: (event) => events.push(event) });
				const response = await app.request(`/auth/${route}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ requestId: "auth-cache", flowId: "flow", input: {} }),
				});
				expect(response.status, JSON.stringify(events)).toBe(200);
				expect(events).toHaveLength(1);
				// test-invalid: contributor fields are not exposed on the shared log event type.
				const log = events[0] as { cache?: ReturnType<CacheTelemetryCollector["toLogPayload"]> };
				const encoded = response.headers.get(PROVIDER_TELEMETRY_HEADER);
				const header = encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString()) : {};
				if (cacheable) {
					expect(sources).toEqual(["vendor", "cache"]);
					expect(calls).toBe(1);
					expect(log.cache?.lookups, `${factory} ${route}: resolver cache sink missing`).toBe(4);
					expect(log.cache?.writes).toBe(2);
					expect(header.cache).toEqual(new CacheTelemetryCollector().toHeaderPayload(log.cache!));
				} else {
					expect(calls).toBe(usage === "unused browser" ? 0 : 2);
					expect(log).not.toHaveProperty("cache");
					expect(header).not.toHaveProperty("cache");
				}
			} finally {
				restore();
				if (previous === undefined) delete process.env[envKey];
				else process.env[envKey] = previous;
			}
		});
	}
}
