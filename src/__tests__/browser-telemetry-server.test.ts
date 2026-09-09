import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createServerAppAsync, type ProviderServerLogEvent } from "../server/serve.js";
import { statefulSignedHeaders } from "../stateful-signing.js";
import { createInProcessProviderEngine } from "../engine.js";
import {
	BrowserTelemetryCollector,
	type BrowserTelemetryLogPayload,
} from "../runtime/browser-telemetry.js";
import type { ResolverTelemetryLogPayload } from "../runtime/resolver-telemetry.js";
import { createBrowserClient } from "../runtime/browser.js";
import { createResolverClientFromEnv } from "../runtime/resolver.js";
import { swapBrowserResolverClientFactoryForTests } from "../runtime/resolver-vendors/browser.js";
import type { Span, TraceContext } from "../runtime/trace.js";
import type { BrowserClient, ProviderContext } from "../types.js";
import {
	createBrowserClientDouble,
	createBrowserPageDouble,
	createProviderDefinitionDouble,
} from "./test-utils.js";

const paths = [
	"/v1/probe",
	"/auth/start",
	"/auth/continue",
	"/auth/poll",
	"/auth/disconnect",
	"/auth/refresh",
	"/__apifuse/stateful/operations",
] as const;
const secret = "browser-telemetry-stateful-secret";

function fakePool(acquireCodes: Array<number | null> = []) {
	const calls: string[] = [];
	const server = Bun.serve<{ pool: boolean }>({
		port: 0,
		fetch(request, instance) {
			if (instance.upgrade(request, { data: { pool: new URL(request.url).pathname === "/pool" } }))
				return;
			return new Response("upgrade", { status: 400 });
		},
		websocket: {
			message(ws, raw) {
				const command = JSON.parse(String(raw));
				calls.push(command.method);
				if (command.method === "acquire") {
					const code = acquireCodes.shift();
					if (typeof code === "number") {
						ws.send(
							JSON.stringify({
								jsonrpc: "2.0",
								id: command.id,
								error: { code, message: "pool failure" },
							}),
						);
						return;
					}
				}
				let result: unknown = {};
				if (command.method === "acquire")
					result = { pageId: "page", wsEndpoint: `ws://127.0.0.1:${server.port}/page` };
				else if (command.method === "Runtime.evaluate") {
					const expression = String(command.params?.expression);
					result = {
						result: {
							value: expression.includes("navigator.userAgent")
								? "FixtureBrowser/1.0"
								: expression.includes("readyState")
									? "complete"
									: expression.includes("location.href")
										? "https://example.com/"
										: undefined,
						},
					};
				} else if (command.method === "Network.getCookies")
					result = {
						cookies: [
							{
								name: "aws-waf-token",
								value: "fixture-waf-token",
								domain: "example.com",
								path: "/",
								httpOnly: true,
								secure: true,
								expires: 2000000000,
							},
						],
					};
				ws.send(
					JSON.stringify({ ...(ws.data.pool ? { jsonrpc: "2.0" } : {}), id: command.id, result }),
				);
				if (command.method === "Page.navigate")
					ws.send(JSON.stringify({ method: "Page.loadEventFired", params: {} }));
			},
		},
	});
	return { calls, url: `ws://127.0.0.1:${server.port}/pool`, stop: () => server.stop(true) };
}

function terminal(events: ProviderServerLogEvent[]) {
	return events.findLast(
		(event) =>
			event.event === "provider_request_completed" || event.event === "provider_request_failed",
	) as ProviderServerLogEvent & {
		browser?: BrowserTelemetryLogPayload;
		resolver?: ResolverTelemetryLogPayload;
	};
}
function header(response: Response) {
	const encoded = response.headers.get("X-ApiFuse-Provider-Telemetry");
	return encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString()) : {};
}

describe("browser construction matrix", () => {
	it("bound SDK resolver override receives a fresh browser sink", async () => {
		const pool = fakePool();
		const previous = process.env.APIFUSE__CDP_POOL__URL;
		process.env.APIFUSE__CDP_POOL__URL = pool.url;
		try {
			const provider = createProviderDefinitionDouble({
				id: "bound-browser-telemetry",
				allowedHosts: ["example.com"],
				resolver: { kinds: ["aws_waf"], vendors: ["browser"] },
				operations: {
					probe: {
						riskClass: "read",
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						handler: async (ctx) => {
							await ctx.resolver.solve({ kind: "aws_waf", pageUrl: "https://example.com/" });
							return { ok: true };
						},
					},
				},
			});
			const resolver = createResolverClientFromEnv(provider.resolver, process.env, {
				allowedHosts: provider.allowedHosts,
			});
			const events: ProviderServerLogEvent[] = [];
			const app = await createServerAppAsync(provider, {
				resolver,
				logger: (event) => events.push(event),
			});
			for (const requestId of ["first", "second"]) {
				const response = await app.request("/v1/probe", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ requestId, input: {} }),
				});
				expect(response.status).toBe(200);
				expect(terminal(events).browser).toMatchObject({
					pages: 1,
					navigations: 1,
					engine: "playwright-stealth",
					poolAcquireOutcome: "ok",
					poolAcquireAttempts: 1,
				});
				expect(terminal(events).resolver?.attempts).toBe(1);
			}
		} finally {
			if (previous === undefined) delete process.env.APIFUSE__CDP_POOL__URL;
			else process.env.APIFUSE__CDP_POOL__URL = previous;
			pool.stop();
		}
	});
	it("CDP pool -32001, -32001, ok preserves allocation history", async () => {
		const pool = fakePool([-32001, -32001, null]);
		const collector = new BrowserTelemetryCollector();
		const client = createBrowserClient({ cdpUrl: pool.url, telemetry: collector });
		try {
			await client.newPage().catch(() => {});
			await client.newPage().catch(() => {});
			await client.newPage();
			const log = collector.toLogPayload({
				spans: [],
				byName: new Map(),
				count: () => 0,
				durationMs: () => 0,
			});
			expect(log).toMatchObject({
				poolAcquireAttempts: 3,
				poolAcquireFailures: 2,
				poolAcquireOutcome: "ok",
			});
			expect(pool.calls.filter((call) => call === "acquire")).toHaveLength(3);
		} finally {
			await client.close();
			pool.stop();
		}
	});
	it("CDP pool maps all six codes and preserves unknown numeric codes log-only", async () => {
		const outcomes = [
			"queue_full",
			"timed_out",
			"shutting_down",
			"unknown_lease",
			"unknown_method",
			"missing_allowed_hosts",
			"other",
		] as const;
		const pool = fakePool([-32001, -32002, -32003, -32004, -32005, -32006, -32123]);
		const collector = new BrowserTelemetryCollector();
		const client = createBrowserClient({ cdpUrl: pool.url, telemetry: collector });
		try {
			for (const outcome of outcomes) {
				await client.newPage().catch(() => {});
				expect(
					collector.toLogPayload({
						spans: [],
						byName: new Map(),
						count: () => 0,
						durationMs: () => 0,
					})?.poolAcquireOutcome,
				).toBe(outcome);
			}
			const log = collector.toLogPayload({
				spans: [],
				byName: new Map(),
				count: () => 0,
				durationMs: () => 0,
			})!;
			expect(log).toMatchObject({
				poolAcquireUnknownCode: -32123,
				poolAcquireAttempts: 7,
				poolAcquireFailures: 7,
			});
			expect(collector.toHeaderPayload(log)).not.toHaveProperty("poolAcquireUnknownCode");
		} finally {
			await client.close();
			pool.stop();
		}
	});
	for (const path of paths)
		for (const used of [true, false])
			for (const failed of [true, false])
				it(`${path} ${used ? "used" : "unused"} ${failed ? "failed" : "completed"}`, async () => {
					const pool = fakePool();
					const previous = process.env.APIFUSE__CDP_POOL__URL;
					process.env.APIFUSE__CDP_POOL__URL = pool.url;
					try {
						const use = async (ctx: unknown) => {
							if (used) {
								const page = await (ctx as { browser: BrowserClient }).browser.newPage();
								await page.goto("https://example.com/");
							}
							if (failed) throw new Error("matrix failure");
							return { ok: true };
						};
						const auth = async (ctx: unknown) => {
							await use(ctx);
							return { kind: "complete", turnId: "complete" } as const;
						};
						const provider = createProviderDefinitionDouble({
							id: "browser-telemetry-matrix",
							runtime: "browser",
							browser: { engine: "playwright-stealth" },
							allowedHosts: ["example.com"],
							auth: {
								mode: "credentials",
								flow: { start: auth, continue: auth, poll: auth, abort: auth, refresh: auth },
							},
							operations: {
								probe: {
									riskClass: "read",
									input: z.object({}),
									output: z.object({ ok: z.boolean() }),
									handler: use,
								},
							},
						});
						const events: ProviderServerLogEvent[] = [];
						const app = await createServerAppAsync(provider, {
							logger: (event) => events.push(event),
							statefulForwarding: { secret, validateOwnerFence: async () => true },
							internalOperationExecutor: async ({ ctx }) => use(ctx),
						});
						const requestId = `matrix-${path}-${used}-${failed}`;
						const timestamp = new Date().toISOString();
						const operation = { requestId, input: {} };
						const body = JSON.stringify(
							path === "/v1/probe"
								? operation
								: path.startsWith("/auth/")
									? {
											requestId,
											flowId: "flow",
											providerId: provider.id,
											tenantId: "tenant",
											connectionId: "connection",
											context: {},
											input: {},
										}
									: {
											requestId,
											providerId: provider.id,
											operationId: "probe",
											sessionKey: "browser:account:connection",
											connectionId: "connection",
											serviceAccountId: "account",
											ownerPodId: "owner",
											generation: 7,
											sourcePodId: "source",
											forwardedAt: timestamp,
											operationRequest: operation,
										},
						);
						const signed = path.startsWith("/__apifuse/")
							? {
									"x-apifuse-stateful-source-pod": "source",
									...statefulSignedHeaders({
										secret,
										timestamp,
										rawBody: body,
										method: "POST",
										path,
									}),
								}
							: {};
						const response = await app.request(path, {
							method: "POST",
							headers: { "content-type": "application/json", ...signed },
							body,
						});
						const event = terminal(events);
						expect(event.event).toBe(`provider_request_${failed ? "failed" : "completed"}`);
						const decoded = header(response);
						if (used) {
							expect(
								event.browser,
								"browser matrix sink must reach construction site",
							).toMatchObject({
								engine: "playwright-stealth",
								poolAcquireOutcome: "ok",
								poolAcquireAttempts: 1,
								pages: 1,
								navigations: 1,
							});
							expect(decoded).toMatchObject({ v: 1, taxonomy: "2026-08-07" });
							expect(decoded.browser).toEqual(
								new BrowserTelemetryCollector().toHeaderPayload(event.browser!),
							);
						} else {
							expect(event).not.toHaveProperty("browser");
							expect(decoded).not.toHaveProperty("browser");
						}
					} finally {
						if (previous === undefined) delete process.env.APIFUSE__CDP_POOL__URL;
						else process.env.APIFUSE__CDP_POOL__URL = previous;
						pool.stop();
					}
				});

	it("repro-host-browser execution binds replacement and preserves lifecycle facts", async () => {
		const events: ProviderServerLogEvent[] = [];
		const local = createInProcessProviderEngine();
		const host = createBrowserClientDouble({
			engine: "nodriver",
			newPage: async () => createBrowserPageDouble(),
		});
		const provider = createProviderDefinitionDouble({
			runtime: "browser",
			browser: { engine: "playwright-stealth" },
			operations: {
				probe: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async (ctx: ProviderContext) => {
						await ctx.browser.newPage();
						return { ok: true };
					},
				},
			},
		});
		const app = await createServerAppAsync(provider, {
			logger: (event) => events.push(event),
			engine: {
				attach: (input) =>
					local.attach({ ...input, bindings: { ...input.bindings, browser: host } }),
			},
		});
		const response = await app.request("/v1/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "host", input: {} }),
		});
		expect(response.status).toBe(200);
		expect(terminal(events).browser, "host adapter sink must be bound").toMatchObject({
			engine: "nodriver",
			poolAcquireOutcome: "not_configured",
			pages: 1,
		});
		expect(header(response).browser.engine).toBe("nodriver");
	});

	it("bound resolver cleanup failure preserves attempt parentage and base resolver bytes", async () => {
		const pool = fakePool();
		const previous = process.env.APIFUSE__CDP_POOL__URL;
		process.env.APIFUSE__CDP_POOL__URL = pool.url;
		const originalNow = Date.now;
		Date.now = () => 1789000000000;
		const cleanupError = new Error("CDP lease release failed after success");
		const restoreFactory = swapBrowserResolverClientFactoryForTests((options) => {
			const client = createBrowserClient(options);
			const close = client.close.bind(client);
			client.close = async () => {
				await close();
				throw cleanupError;
			};
			return client;
		});
		try {
			let trace: TraceContext | undefined;
			const events: ProviderServerLogEvent[] = [];
			const provider = createProviderDefinitionDouble({
				id: "bound-browser-cleanup-byte-pin",
				allowedHosts: ["example.com"],
				resolver: { kinds: ["aws_waf"], vendors: ["browser"] },
				operations: {
					probe: {
						riskClass: "read",
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						handler: async (ctx) => {
							trace = ctx.trace as TraceContext;
							const solution = await ctx.resolver.solve({
								kind: "aws_waf",
								pageUrl: "https://example.com/",
							});
							return { ok: solution.form === "cookies" };
						},
					},
				},
			});
			const app = await createServerAppAsync(provider, { logger: (event) => events.push(event) });
			const response = await app.request("/v1/probe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "bound-browser-cleanup", input: {} }),
			});
			expect(response.status).toBe(200);
			const event = terminal(events);
			// Captured by this cleanup-failure scenario in a scratch worktree at beafbf7.
			expect(JSON.stringify(event.resolver)).toBe(
				'{"outcome":"solved","challengeKind":"aws_waf","solveMs":0,"cacheStatus":"miss","cacheWrite":{"written":true},"identitySource":"none","attempts":1,"failovers":0,"vendorChain":["browser"],"vendorUsed":"browser","pollCount":0,"attemptSamples":[{"v":"browser","p":"cleanup","o":"error","ms":0,"e":"unexpected","diagnostics":{"attemptIndex":1,"phase":"cleanup"}},{"v":"browser","p":"poll_result","o":"ok","ms":0,"diagnostics":{"attemptIndex":1}}],"lastVendorErrorDescription":"CDP lease release failed after success"}',
			);
			expect(event.browser).toMatchObject({
				pages: 1,
				navigations: 1,
				poolAcquireOutcome: "ok",
			});
			expect(trace).toBeDefined();
			const spans = trace!.getSpans();
			const byId = new Map(spans.map((span) => [span.id, span]));
			const attempt = spans.find((span) => span.name === "resolver.vendor.attempt");
			expect(attempt).toBeDefined();
			expect(attempt!.status).toBe("ok");
			const browserSpans = spans.filter((span) => span.name.startsWith("browser."));
			expect(browserSpans.map((span) => span.name).sort()).toEqual([
				"browser.page.cookies",
				"browser.page.goto",
				"browser.page.userAgent",
				"browser.withIsolatedContext",
			]);
			for (const span of browserSpans) {
				const visited = new Set([span.id]);
				let parentId = span.parentId;
				while (parentId !== attempt!.id) {
					expect(parentId, `${span.name} must descend from the attempt`).toBeDefined();
					expect(visited.has(parentId!)).toBe(false);
					visited.add(parentId!);
					const parent = byId.get(parentId!);
					expect(parent).toBeDefined();
					parentId = parent!.parentId;
				}
			}
			const context = browserSpans.find((span) => span.name === "browser.withIsolatedContext")!;
			expect(context.parentId).toBe(attempt!.id);
			for (const pageSpan of browserSpans.filter((span) => span.name.startsWith("browser.page.")))
				expect(pageSpan.parentId).toBe(context.id);
			const cleanupSpans = spans.filter((span) => span.name === "resolver.vendor.cleanup");
			expect(cleanupSpans).toHaveLength(1);
			const cleanup = cleanupSpans[0]!;
			expect(cleanup.parentId).toBe(attempt!.id);
			expect(cleanup.parentId).toBe(context.parentId);
			expect(cleanup.status).toBe("error");
			expect(cleanup.error).toBe(cleanupError.message);
			expect(cleanup.attributes).toEqual({
				vendor: "browser",
				challenge_kind: "aws_waf",
				operation: "client.close",
				error_message: cleanupError.message,
				duration_ms: 0,
			});
			expect(cleanup.attributes).not.toHaveProperty("error_stack");
			const tree = (span: Span, depth = 0): string =>
				[
					`${"  ".repeat(depth)}${span.name} (${span.status})`,
					...spans
						.filter((child) => child.parentId === span.id)
						.map((child) => tree(child, depth + 1)),
				].join("\n");
			console.log(`Bound resolver span tree:\n${tree(attempt!)}`);
		} finally {
			restoreFactory();
			Date.now = originalNow;
			if (previous === undefined) delete process.env.APIFUSE__CDP_POOL__URL;
			else process.env.APIFUSE__CDP_POOL__URL = previous;
			pool.stop();
		}
	});

	it("resolver factory threads the browser sink and preserves one resolver attempt", async () => {
		const pool = fakePool();
		const previous = process.env.APIFUSE__CDP_POOL__URL;
		process.env.APIFUSE__CDP_POOL__URL = pool.url;
		const originalNow = Date.now;
		Date.now = () => 1789000000000;
		try {
			const events: ProviderServerLogEvent[] = [];
			const provider = createProviderDefinitionDouble({
				id: "browser-resolver-byte-pin",
				allowedHosts: ["example.com"],
				resolver: { kinds: ["aws_waf"], vendors: ["browser"] },
				operations: {
					probe: {
						riskClass: "read",
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						handler: async (ctx) => {
							await ctx.resolver.solve({ kind: "aws_waf", pageUrl: "https://example.com/" });
							return { ok: true };
						},
					},
				},
			});
			const app = await createServerAppAsync(provider, { logger: (event) => events.push(event) });
			const response = await app.request("/v1/probe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "resolver-browser", input: {} }),
			});
			expect(response.status).toBe(200);
			const event = terminal(events);
			expect(JSON.stringify(event.resolver)).toBe(
				'{"outcome":"solved","challengeKind":"aws_waf","solveMs":0,"cacheStatus":"miss","cacheWrite":{"written":true},"identitySource":"none","attempts":1,"failovers":0,"vendorChain":["browser"],"vendorUsed":"browser","pollCount":0,"attemptSamples":[{"v":"browser","p":"cleanup","o":"ok","ms":0,"diagnostics":{"attemptIndex":1,"phase":"cleanup"}},{"v":"browser","p":"poll_result","o":"ok","ms":0,"diagnostics":{"attemptIndex":1}}]}',
			);
			expect(event.browser, "resolver factory sink must be bound").toMatchObject({
				engine: "playwright-stealth",
				poolAcquireOutcome: "ok",
				pages: 1,
				navigations: 1,
			});
			expect(event.resolver).toMatchObject({
				attempts: 1,
				failovers: 0,
				vendorUsed: "browser",
				outcome: "solved",
			});
			expect(header(response).browser).toBeDefined();
		} finally {
			Date.now = originalNow;
			if (previous === undefined) delete process.env.APIFUSE__CDP_POOL__URL;
			else process.env.APIFUSE__CDP_POOL__URL = previous;
			pool.stop();
		}
	});
});
