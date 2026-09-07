import { describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";
import {
	createResolverClient,
	createResolverClientFromEnv,
	createResolverClientFromEnvForTests,
	swapResolverAdapterFactoryForTests,
	bindResolverSignal,
} from "../runtime/resolver.js";
import { bindResolverTelemetry } from "../runtime/resolver-shared.js";
import { wrapWithInstrumentation } from "../runtime/instrumentation.js";
import { createTraceContext } from "../runtime/trace.js";
import { ResolverTelemetryCollector } from "../runtime/resolver-telemetry.js";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/request-telemetry.js";
import type { ResolverVendorAdapter } from "../runtime/resolver-vendors/types.js";
import {
	createServerApp,
	createServerAppAsync,
	type ProviderServerLogEvent,
} from "../server/serve.js";
import { statefulSignedHeaders } from "../stateful-signing.js";
import type { ResolverContext } from "../types.js";
import { createProviderDefinitionDouble, createProviderContextDouble } from "./test-utils.js";

const challenge = { kind: "turnstile", pageUrl: "https://example.com", siteKey: "site" } as const;
const config = { vendors: ["capsolver"], kinds: ["turnstile"] } as const;
const paths = [
	"/v1/solve",
	"/auth/start",
	"/auth/continue",
	"/auth/poll",
	"/auth/disconnect",
	"/auth/refresh",
	"/__apifuse/stateful/operations",
] as const;
const solve = async (ctx: { resolver: ResolverContext }) => {
	await ctx.resolver.solve(challenge);
	return { ok: true };
};
const authSolve = async (ctx: { resolver: ResolverContext }) => {
	await solve(ctx);
	return { kind: "complete", turnId: "complete" } as const;
};

// Permanent version of review round 2's paths.ts: every construction route executes a real invocation.
describe("resolver server construction-path telemetry matrix", () => {
	for (const [factory, create] of [
		["sync", createServerApp],
		["async", createServerAppAsync],
	] as const) {
		for (const source of [
			"env",
			"chain override",
			"opaque override",
			"chain override undeclared",
			"opaque override undeclared",
		] as const) {
			it.each(
				paths.filter((path) => !source.endsWith("undeclared") || path.startsWith("/auth/")),
			)(`${factory} ${source} %s receives a fresh request sink`, async (path) => {
				let calls = 0;
				const adapter: ResolverVendorAdapter = {
					id: "capsolver",
					supports: () => true,
					async solve() {
						calls++;
						return { form: "token", token: "token" };
					},
				};
				const restore = swapResolverAdapterFactoryForTests("capsolver", () => adapter);
				const key = "APIFUSE__RESOLVER__CAPSOLVER__API_KEY";
				const previous = process.env[key];
				process.env[key] = "synthetic-engine-key";
				const stale = new ResolverTelemetryCollector();
				const staleOutcome = spyOn(stale, "recordOutcome");
				const outcome = spyOn(ResolverTelemetryCollector.prototype, "recordOutcome");
				try {
					const provider = createProviderDefinitionDouble({
						id: "resolver-paths",
						allowedHosts: ["example.com"],
						resolver: source.endsWith("undeclared") ? undefined : config,
						auth: {
							mode: "credentials",
							flow: {
								start: authSolve,
								continue: authSolve,
								poll: authSolve,
								abort: authSolve,
								refresh: authSolve,
							},
						},
						operations: {
							solve: {
								riskClass: "read",
								input: z.object({}),
								output: z.object({ ok: z.boolean() }),
								handler: solve,
							},
						},
					});
					const resolver = source.startsWith("chain override")
						? createResolverClient({ adapters: [adapter], kinds: config.kinds, telemetry: stale })
						: source.startsWith("opaque override")
							? {
									async solve() {
										calls++;
										return { form: "token", token: "opaque" } as const;
									},
								}
							: undefined;
					const events: ProviderServerLogEvent[] = [];
					const app = await create(provider, {
						resolver,
						logger: (event) => events.push(event),
						statefulForwarding: { secret: "probe-secret", validateOwnerFence: async () => true },
						internalOperationExecutor: async ({ ctx }) => solve(ctx),
					});
					for (let turn = 0; turn < 2; turn++) {
						const timestamp = new Date().toISOString();
						const operationRequest = {
							requestId: `${factory}-${source}-${path}-${turn}`,
							...(path.startsWith("/auth/") ? { flowId: "flow" } : {}),
							input: {},
						};
						const stateful = path === "/__apifuse/stateful/operations";
						const body = JSON.stringify(
							stateful
								? {
										requestId: operationRequest.requestId,
										providerId: provider.id,
										operationId: "solve",
										sessionKey: "resolver-paths:account:connection",
										connectionId: "connection-1",
										serviceAccountId: "account-1",
										ownerPodId: "pod-owner",
										generation: 7,
										sourcePodId: "pod-source",
										forwardedAt: timestamp,
										operationRequest,
									}
								: operationRequest,
						);
						const response = await app.request(path, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								...(stateful
									? {
											"x-apifuse-stateful-source-pod": "pod-source",
											...statefulSignedHeaders({
												secret: "probe-secret",
												timestamp,
												rawBody: body,
												method: "POST",
												path,
											}),
										}
									: {}),
							},
							body,
						});
						expect(response.status).toBe(200);
						expect(calls).toBe(turn + 1);
						expect(outcome).toHaveBeenCalledTimes(turn + 1);
						const vendor = source.startsWith("opaque override") ? "custom" : "capsolver";
						const log = [...events]
							.reverse()
							.find((event) => event.event === "provider_request_completed")?.resolver;
						expect(log?.outcome).toBe("solved");
						expect(log?.attempts).toBe(1);
						expect(log?.vendorChain).toEqual([vendor]);
						expect(log?.attemptSamples).toHaveLength(1);
						const header = response.headers.get(PROVIDER_TELEMETRY_HEADER);
						expect(header).toBeTruthy();
						const decoded = JSON.parse(Buffer.from(header ?? "", "base64url").toString());
						expect(decoded.resolver.outcome).toBe("solved");
						expect(decoded.resolver.attempts).toBe(1);
						expect(decoded.resolver.vendorChain).toEqual([vendor]);
						expect(decoded.resolver.attemptSamples).toHaveLength(1);
					}
					expect(staleOutcome).toHaveBeenCalledTimes(0);
				} finally {
					outcome.mockRestore();
					staleOutcome.mockRestore();
					restore();
					if (previous === undefined) delete process.env[key];
					else process.env[key] = previous;
				}
			});
		}
	}

	it.each([
		"manual",
		"env explicit",
		"env defaults",
		"test factory",
		"empty chain",
	] as const)("%s constructor receives its supplied sink", async (source) => {
		let calls = 0;
		const adapter: ResolverVendorAdapter = {
			id: "capsolver",
			supports: () => true,
			async solve() {
				calls++;
				return { form: "token", token: "token" };
			},
		};
		const restore = swapResolverAdapterFactoryForTests("capsolver", () => adapter);
		const sink = new ResolverTelemetryCollector();
		const outcome = spyOn(sink, "recordOutcome");
		const env = { APIFUSE__RESOLVER__CAPSOLVER__API_KEY: "synthetic-key" };
		try {
			const resolver =
				source === "manual"
					? createResolverClient({ kinds: config.kinds, adapters: [adapter], telemetry: sink })
					: source === "test factory"
						? createResolverClientFromEnvForTests(
								config,
								env,
								{ telemetry: sink },
								{ capsolver: () => adapter },
							)
						: createResolverClientFromEnv(
								source === "empty chain"
									? { vendors: [], kinds: config.kinds }
									: source === "env defaults"
										? { kinds: config.kinds }
										: config,
								env,
								{ telemetry: sink },
							);
			if (source === "empty chain")
				await expect(resolver.solve(challenge)).rejects.toMatchObject({
					code: "RESOLVER_UNAVAILABLE",
				});
			else await resolver.solve(challenge);
			expect(calls).toBe(source === "empty chain" ? 0 : 1);
			expect(outcome).toHaveBeenCalledTimes(1);
		} finally {
			outcome.mockRestore();
			restore();
		}
	});

	it("rebinds SDK signal wrappers without sending events to a finished sink", async () => {
		const oldSink = new ResolverTelemetryCollector();
		const oldOutcome = spyOn(oldSink, "recordOutcome");
		const freshSink = new ResolverTelemetryCollector();
		const freshOutcome = spyOn(freshSink, "recordOutcome");
		const adapter: ResolverVendorAdapter = {
			id: "capsolver",
			supports: () => true,
			async solve() {
				return { form: "token", token: "token" };
			},
		};
		const root = createResolverClient({ kinds: config.kinds, adapters: [adapter] });
		const finished = bindResolverSignal(
			bindResolverTelemetry(root, oldSink),
			new AbortController().signal,
		);
		await bindResolverTelemetry(finished, freshSink).solve(challenge);
		expect(oldOutcome).toHaveBeenCalledTimes(0);
		expect(freshOutcome).toHaveBeenCalledTimes(1);
		oldOutcome.mockRestore();
		freshOutcome.mockRestore();
	});

	it("rebinds an instrumented continuation without retaining its old collector or trace", async () => {
		const oldSink = new ResolverTelemetryCollector();
		const freshSink = new ResolverTelemetryCollector();
		const trace = createTraceContext();
		const root = createResolverClient({
			kinds: config.kinds,
			adapters: [
				{
					id: "capsolver",
					supports: () => true,
					async solve() {
						return { form: "token", token: "token" };
					},
				},
			],
		});
		const previous = wrapWithInstrumentation(
			createProviderContextDouble({ trace, resolver: bindResolverTelemetry(root, oldSink) }),
		);
		await bindResolverTelemetry(previous.resolver, freshSink).solve(challenge);
		expect(oldSink.toLogPayload()).toBeUndefined();
		expect(trace.getSpans()).toEqual([]);
		expect(freshSink.toLogPayload()?.attempts).toBe(1);
		expect(freshSink.toLogPayload()?.vendorChain).toEqual(["capsolver"]);
	});
});
