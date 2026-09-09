import { describe, expect, it } from "bun:test";
import {
	BrowserTelemetryCollector,
	type BrowserTelemetrySink,
} from "../runtime/browser-telemetry.js";
import { bindBrowserTelemetry } from "../runtime/browser-telemetry-binding.js";
import { observeTelemetryCallback } from "../runtime/http-telemetry-guard.js";
import { wrapWithInstrumentation } from "../runtime/instrumentation.js";
import { createTraceContext } from "../runtime/trace.js";
import {
	createBrowserClientDouble,
	createBrowserPageDouble,
	createProviderContextDouble,
} from "./test-utils.js";

const scenarios = [
	"newPage",
	"goto ok",
	"goto 404",
	"goto timeout",
	"click ok",
	"click missing selector",
	"fill",
	"type",
	"waitForSelector ok",
	"waitForSelector timeout",
	"evaluate",
	"content",
	"screenshot",
	"cookies",
	"withIsolatedContext",
	"rawPage",
	"pool acquire -32001",
	"proxy auth challenge",
	"abort mid-navigation",
] as const;

describe("browser recorder differential", () => {
	for (const scenario of scenarios)
		it(`recorder on/off preserves ${scenario}`, async () => {
			const run = async (record: boolean) => {
				const calls: unknown[] = [];
				const collector = new BrowserTelemetryCollector();
				const failure = Object.assign(new Error(scenario), {
					code: scenario === "pool acquire -32001" ? -32001 : undefined,
				});
				const op = async (name: string, args: unknown[], result?: unknown) => {
					calls.push([name, args]);
					if (
						scenario.includes("timeout") ||
						scenario.includes("missing selector") ||
						scenario === "abort mid-navigation"
					)
						throw failure;
					return result;
				};
				const page = createBrowserPageDouble({
					goto: async (...args) => {
						await op("goto", args);
					},
					click: async (...args) => {
						await op("click", args);
					},
					fill: async (...args) => {
						await op("fill", args);
					},
					type: async (...args) => {
						await op("type", args);
					},
					waitForSelector: async (...args) => {
						await op("waitForSelector", args);
					},
					content: async () => String(await op("content", [], "<html>fixture</html>")),
					screenshot: async (...args) => {
						await op("screenshot", args);
						return Buffer.from("image");
					},
					cookies: async () => {
						await op("cookies", []);
						return [];
					},
				});
				const host = createBrowserClientDouble({
					newPage: async () => {
						calls.push(["newPage"]);
						if (scenario === "pool acquire -32001") throw failure;
						return page;
					},
					rawPage: async () => {
						calls.push(["rawPage"]);
						return page;
					},
					withIsolatedContext: async (handler) => {
						calls.push(["withIsolatedContext"]);
						return handler(page);
					},
				});
				const browser = wrapWithInstrumentation(
					createProviderContextDouble({
						browser: record ? bindBrowserTelemetry(host, collector) : host,
						trace: createTraceContext(),
					}),
				).browser;
				let ticks = 0;
				let running = true;
				const tick = () => {
					if (running) {
						ticks += 1;
						queueMicrotask(tick);
					}
				};
				queueMicrotask(tick);
				let result: unknown;
				let error: unknown;
				try {
					if (scenario === "rawPage") result = await browser.rawPage().then((p) => p.content());
					else if (scenario === "withIsolatedContext")
						result = await browser.withIsolatedContext((p) => p.content());
					else {
						const p = await browser.newPage();
						if (scenario.startsWith("goto") || scenario === "abort mid-navigation")
							result = await p.goto("https://example.test/", { timeout: 1 });
						else if (scenario.startsWith("click")) result = await p.click("#button");
						else if (scenario.startsWith("waitForSelector"))
							result = await p.waitForSelector("#button", { timeout: 1 });
						else if (scenario === "fill") result = await p.fill("#input", "value");
						else if (scenario === "type") result = await p.type("#input", "value");
						else if (scenario === "content") result = await p.content();
						else if (scenario === "evaluate") result = await p.evaluate(() => 7);
						else if (scenario === "screenshot") result = await p.screenshot({ fullPage: true });
						else if (scenario === "cookies") result = await p.cookies();
						else if (scenario === "proxy auth challenge") {
							calls.push(["Fetch.authRequired"]);
							if (record) collector.recordProxyAuthChallenge();
							result = "ProvideCredentials";
						}
					}
				} catch (caught) {
					error = caught;
				} finally {
					running = false;
				}
				return { calls, result, error, ticks };
			};
			const off = await run(false);
			const on = await run(true);
			expect(on.calls).toEqual(off.calls);
			expect(on.result).toEqual(off.result);
			expect(on.error instanceof Error ? on.error.constructor : undefined).toBe(
				off.error instanceof Error ? off.error.constructor : undefined,
			);
			expect(on.error instanceof Error ? on.error.message : undefined).toBe(
				off.error instanceof Error ? off.error.message : undefined,
			);
			expect(on.ticks).toBe(off.ticks);
		});

	const edges = {
		throw: () => {
			throw new Error("observer");
		},
		reject: () => Promise.reject(new Error("observer")),
		never: () => new Promise(() => {}),
		garbage: () => 42,
		species: () => {
			class BadPromise extends Promise<void> {
				static get [Symbol.species](): PromiseConstructor {
					throw new Error("species");
				}
			}
			return new BadPromise((_resolve, reject) => reject(new Error("observer")));
		},
		frozen: () => Object.freeze(Promise.reject(new Error("observer"))),
	};
	for (const [edge, bad] of Object.entries(edges))
		it(`guard edge ${edge} is observational across every browser hook`, async () => {
			let unhandled = 0;
			const listener = () => {
				unhandled += 1;
			};
			process.on("unhandledRejection", listener);
			const collector = new BrowserTelemetryCollector();
			const sink: BrowserTelemetrySink = {
				recordEngine: bad,
				recordPoolAcquire: bad,
				recordError: bad,
				recordProxyAuthChallenge: bad,
				markTelemetryFailed: () => collector.markTelemetryFailed(),
			};
			const calls: string[] = [];
			for (const hook of [
				() => sink.recordEngine("host"),
				() => sink.recordPoolAcquire("ok"),
				() => sink.recordError("other"),
				() => sink.recordProxyAuthChallenge(),
			]) {
				calls.push("before");
				observeTelemetryCallback(sink, hook);
				calls.push("after");
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
			process.off("unhandledRejection", listener);
			expect(calls).toEqual(Array.from({ length: 4 }, () => ["before", "after"]).flat());
			expect(unhandled).toBe(0);
			const log = collector.toLogPayload({
				spans: [],
				byName: new Map(),
				count: () => 0,
				durationMs: () => 0,
			});
			expect(log?.telemetryFailed).toBe(true);
			expect(collector.toHeaderPayload(log!)).not.toHaveProperty("telemetryFailed");
		});
});
