import { describe, expect, it } from "bun:test";
import { BrowserTelemetryCollector } from "../runtime/browser-telemetry.js";
import { RequestTelemetry, closedEnum } from "../runtime/request-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";
import { wrapWithInstrumentation } from "../runtime/instrumentation.js";
import {
	createBrowserClientDouble,
	createBrowserPageDouble,
	createProviderContextDouble,
} from "./test-utils.js";
import { createDiagnosticRedactor } from "../runtime/diagnostic-redactor.js";
import { withDiagnosticEnv, registerDiagnosticValue } from "../runtime/diagnostic-env.js";
import { cookieValuesFromHeaders } from "../runtime/stealth-cookies.js";
import { createBrowserClient } from "../runtime/browser.js";
import { bindBrowserTelemetry } from "../runtime/browser-telemetry-binding.js";
import { spansToOTLP } from "../runtime/otlp.js";

function index(trace: ReturnType<typeof createTraceContext>) {
	const spans = trace.getSpans();
	return {
		spans,
		byName: new Map(),
		count: (name: string) => spans.filter((s) => s.name === name).length,
		durationMs: () => 0,
	};
}

describe("browser telemetry", () => {
	it("reduces browser spans and lifecycle facts into log and header siblings", async () => {
		const trace = createTraceContext();
		await trace.span("request:operation:v1", async () => {
			await (trace as typeof trace & { span: typeof trace.span }).span(
				"browser.newPage",
				async () => undefined,
			);
		});
		const collector = new BrowserTelemetryCollector();
		collector.recordEngine("playwright-stealth");
		collector.recordPoolAcquire("not_configured");
		collector.recordProxyAuthChallenge();
		const log = collector.toLogPayload({
			spans: trace.getSpans(),
			byName: new Map(),
			count: (name) => trace.getSpans().filter((span) => span.name === name).length,
			durationMs: () => 0,
		});
		expect(log).toMatchObject({
			pages: 1,
			poolAcquireOutcome: "not_configured",
			proxyAuthChallenges: 1,
			engine: "playwright-stealth",
		});
		const header = collector.toHeaderPayload(log!);
		expect(header.poolAcquireOutcome as string).toBe("not_configured");
		const telemetry = new RequestTelemetry(trace);
		telemetry.register(collector);
		expect(
			JSON.parse(Buffer.from(telemetry.toHeaderValue()!, "base64url").toString("utf8")).browser,
		).toBeDefined();
	});
});

describe("browser telemetry regressions", () => {
	for (const runtime of ["node"])
		it(`browser diagnostics detach a 10 MiB UTF-16 buffer on ${runtime}`, async () => {
			const child = Bun.spawn(
				[
					runtime,
					...(runtime === "node" ? ["--expose-gc"] : []),
					new URL("./fixtures/browser-telemetry-retention.mjs", import.meta.url).pathname,
					new URL(
						runtime === "bun"
							? "../runtime/browser-telemetry.ts"
							: "../../dist/runtime/browser-telemetry.js",
						import.meta.url,
					).href,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(stderr).toBe("");
			expect(exit).toBe(0);
			const result = JSON.parse(stdout);
			expect(result.lengths).toEqual(Array(24).fill(300));
			expect(result.retainedHeapDelta).toBeLessThan(2 * 1024 * 1024);
		});
	it("repro-instrumentation wraps rawPage and isolated callback pages", async () => {
		const calls: string[] = [];
		const page = createBrowserPageDouble({
			goto: async () => {
				calls.push("goto");
			},
			click: async () => {
				calls.push("click");
			},
		});
		const context = createProviderContextDouble({
			browser: createBrowserClientDouble({
				newPage: async () => page,
				rawPage: async () => page,
				withIsolatedContext: async (h) => h(page),
			}),
			trace: createTraceContext(),
		});
		const instrumented = wrapWithInstrumentation(context);
		await (await instrumented.browser.newPage()).goto("new");
		await (await instrumented.browser.rawPage()).click("raw");
		await instrumented.browser.withIsolatedContext(async (p) => {
			await p.goto("isolated");
			await p.click("iso");
		});
		expect(calls).toHaveLength(4);
		expect(
			instrumented.trace.getSpans().filter((s) => s.name === "browser.page.goto"),
		).toHaveLength(2);
		expect(
			instrumented.trace.getSpans().filter((s) => s.name === "browser.page.click"),
		).toHaveLength(2);
	});

	it("repro-collector-omission reduces raw and isolated operations", async () => {
		const page = createBrowserPageDouble({ goto: async () => {} });
		const trace = createTraceContext();
		const context = createProviderContextDouble({
			browser: createBrowserClientDouble({
				rawPage: async () => page,
				withIsolatedContext: async (h) => h(page),
			}),
			trace,
		});
		const instrumented = wrapWithInstrumentation(context);
		await (await instrumented.browser.rawPage()).goto("x");
		await instrumented.browser.withIsolatedContext(async (p) => p.goto("y"));
		expect(new BrowserTelemetryCollector().toLogPayload(index(trace))).toMatchObject({
			pages: 2,
			navigations: 2,
		});
	});

	it("repro-cookie-registration redacts a bare Set-Cookie value", () => {
		const redactor = createDiagnosticRedactor();
		withDiagnosticEnv(
			{ finished: false, observe() {}, register: (values) => redactor.add(values) },
			() => {
				const header = "sid=abcdef123456; Path=/";
				registerDiagnosticValue(header);
				for (const value of cookieValuesFromHeaders(header)) registerDiagnosticValue(value);
			},
		);
		expect(redactor.redact("page state sid=abcdef123456")).toBe("page state sid=[REDACTED]");
	});

	it("repro-redactor-collector retains a failed error sample", async () => {
		const page = createBrowserPageDouble({
			goto: async () => {
				throw new Error("x");
			},
		});
		const trace = createTraceContext({
			redact: () => {
				throw new Error("redact");
			},
		});
		const instrumented = wrapWithInstrumentation(
			createProviderContextDouble({
				browser: createBrowserClientDouble({ newPage: async () => page }),
				trace,
			}),
		);
		await (await instrumented.browser.newPage()).goto("x").catch(() => {});
		const payload = new BrowserTelemetryCollector().toLogPayload(index(trace));
		expect(
			payload?.samples.some(
				(sample) => sample.status === "error" && sample.diagnostics === "[REDACTION_FAILED]",
			),
		).toBe(true);
	});

	it("repro-guard2 absorbs rejected observer promises", async () => {
		let unhandled = 0;
		const listener = () => {
			unhandled += 1;
		};
		process.on("unhandledRejection", listener);
		const sink = {
			recordEngine: () => Promise.reject(new Error("sink reject")),
			recordPoolAcquire() {},
			recordProxyAuthChallenge() {},
			recordError() {},
			markTelemetryFailed() {},
		};
		await createBrowserClient({ cdpUrl: "", telemetry: sink })
			.rawPage()
			.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 20));
		process.off("unhandledRejection", listener);
		expect(unhandled).toBe(0);
	});

	it("repro-guard preserves unsupported-engine errors without an unhandled observer rejection", async () => {
		let unhandled = 0;
		const listener = () => {
			unhandled += 1;
		};
		process.on("unhandledRejection", listener);
		try {
			const off = await createBrowserClient({ engine: "nodriver" })
				.newPage()
				.catch((error: unknown) => error);
			const on = await createBrowserClient({
				engine: "nodriver",
				telemetry: {
					recordEngine: () => Promise.reject(new Error("sink reject")),
					recordPoolAcquire: () => new Promise(() => {}),
					recordProxyAuthChallenge: () => Object.freeze({}),
					recordError: () => {
						throw new Error("sink throw");
					},
				},
			})
				.newPage()
				.catch((error: unknown) => error);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(on instanceof Error && on.constructor).toBe(off instanceof Error && off.constructor);
			expect(on instanceof Error && on.message).toBe(off instanceof Error && off.message);
			expect(unhandled).toBe(0);
		} finally {
			process.off("unhandledRejection", listener);
		}
	});

	it("repro-proxy-registration redacts decoded and encoded proxy credentials", () => {
		const redactor = createDiagnosticRedactor();
		withDiagnosticEnv(
			{ finished: false, observe() {}, register: (values) => redactor.add(values) },
			() => registerDiagnosticValue("p@ss-w0rd12"),
		);
		expect(redactor.redact("raw p@ss-w0rd12")).toBe("raw [REDACTED]");
		expect(redactor.redact("raw p%40ss-w0rd12")).toBe("raw [REDACTED]");
	});

	it("repro-url-selector redacts URL query and selector attributes", async () => {
		const redactor = createDiagnosticRedactor();
		redactor.add(["SENTINEL12CHARS"]);
		const page = createBrowserPageDouble({ goto: async () => {}, click: async () => {} });
		const observed: unknown[] = [];
		const trace = createTraceContext({
			redact: redactor.redact,
			onSpan: (span) => observed.push(span),
		});
		const browser = wrapWithInstrumentation(
			createProviderContextDouble({
				browser: createBrowserClientDouble({ newPage: async () => page }),
				trace,
			}),
		).browser;
		const p = await browser.newPage();
		await p.goto("https://example.test/?token=SENTINEL12CHARS");
		await p.click("button[SENTINEL12CHARS]");
		expect(
			trace
				.getSpans()
				.every((span) => !JSON.stringify(span.attributes).includes("SENTINEL12CHARS")),
		).toBe(true);
		expect(JSON.stringify(observed)).not.toContain("SENTINEL12CHARS");
		expect(JSON.stringify(spansToOTLP(trace.getSpans()))).not.toContain("SENTINEL12CHARS");
		expect(trace.getSpans().find((span) => span.name === "browser.page.goto")?.attributes.url).toBe(
			"https://example.test/?token=[REDACTED]",
		);
	});

	it("repro-enums exposes the nine closed sample names", async () => {
		const trace = createTraceContext();
		const names = [
			"browser.newPage",
			"browser.page.goto",
			"browser.page.fill",
			"browser.page.click",
			"browser.page.type",
			"browser.page.waitForSelector",
			"browser.evaluate",
			"browser.content",
			"browser.screenshot",
		] as const;
		await Promise.all(names.map((name) => trace.span(name, async () => undefined)));
		const payload = new BrowserTelemetryCollector().toLogPayload(index(trace));
		expect(payload?.samples.map((sample) => sample.name)).toEqual([...names]);
	});

	it("repro-host-browser binds a host replacement through the same sink", async () => {
		const collector = new BrowserTelemetryCollector();
		const host = createBrowserClientDouble({ engine: "nodriver" });
		const bound = bindBrowserTelemetry(host, collector);
		await bound.newPage();
		const payload = collector.toLogPayload({
			spans: [
				{
					id: "page",
					name: "browser.newPage",
					startedAt: 0,
					endedAt: 0,
					duration_ms: 0,
					status: "ok",
					attributes: {},
				},
			],
			byName: new Map(),
			count: (name) => (name === "browser.newPage" ? 1 : 0),
			durationMs: () => 0,
		});
		expect(payload).toMatchObject({
			engine: "nodriver",
			poolAcquireOutcome: "not_configured",
			pages: 1,
		});
	});

	it("host adapter preserves receiver, arguments, promise identity and replaces its sink", async () => {
		const first = new BrowserTelemetryCollector();
		const second = new BrowserTelemetryCollector();
		const page = createBrowserPageDouble();
		const promise = Promise.resolve(page);
		const receivers: unknown[] = [];
		const argumentsSeen: unknown[][] = [];
		const host = createBrowserClientDouble({
			newPage: function (...args: unknown[]) {
				receivers.push(this);
				argumentsSeen.push(args);
				return promise;
			},
		});
		const adapter = bindBrowserTelemetry(host, first);
		expect(adapter.newPage()).toBe(promise);
		expect(receivers[0]).toBe(host);
		expect(bindBrowserTelemetry(adapter, second)).toBe(adapter);
		expect(bindBrowserTelemetry(host, second)).toBe(adapter);
		const receiver = {};
		const argument = {};
		// test-invalid: exercise an explicit receiver and extra host argument beyond the SDK signature.
		expect(Reflect.apply(adapter.newPage, receiver, [argument])).toBe(promise);
		expect(receivers[1]).toBe(receiver);
		expect(argumentsSeen[1]?.[0]).toBe(argument);
		const empty = { spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 };
		expect(first.toLogPayload(empty)?.poolAcquireAttempts).toBe(1);
		expect(second.toLogPayload(empty)?.poolAcquireAttempts).toBe(1);
		await promise;
	});

	it("repro-redactor-fail keeps the returned provider error and failed span", async () => {
		const page = createBrowserPageDouble({
			goto: async () => {
				throw new Error("secret failure");
			},
		});
		const trace = createTraceContext({
			redact: () => {
				throw new Error("redact");
			},
		});
		const browser = wrapWithInstrumentation(
			createProviderContextDouble({
				browser: createBrowserClientDouble({ newPage: async () => page }),
				trace,
			}),
		).browser;
		const error = await (await browser.newPage()).goto("x").catch((value) => value);
		expect(error).toBeInstanceOf(Error);
		expect(
			new BrowserTelemetryCollector()
				.toLogPayload(index(trace))
				?.samples.some((sample) => sample.diagnostics === "[REDACTION_FAILED]"),
		).toBe(true);
	});

	it("repro-counts reduces all operation counters", async () => {
		const names = [
			"browser.newPage",
			"browser.page.goto",
			"browser.page.goto",
			"browser.page.click",
			"browser.evaluate",
			"browser.content",
			"browser.screenshot",
		];
		const trace = createTraceContext();
		await Promise.all(names.map((name) => trace.span(name, async () => undefined)));
		expect(new BrowserTelemetryCollector().toLogPayload(index(trace))).toMatchObject({
			pages: 1,
			navigations: 2,
			actions: 1,
			evaluate: 1,
			content: 1,
			screenshot: 1,
		});
	});

	it("pool acquisition records attempts, failures, final outcome, and unknown codes", () => {
		const collector = new BrowserTelemetryCollector();
		collector.recordPoolAcquire("queue_full");
		collector.recordPoolAcquire("queue_full");
		collector.recordPoolAcquire("ok");
		collector.recordPoolAcquireUnknownCode?.(1234);
		expect(
			collector.toLogPayload({ spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 }),
		).toMatchObject({
			poolAcquireAttempts: 3,
			poolAcquireFailures: 2,
			poolAcquireOutcome: "ok",
			poolAcquireUnknownCode: 1234,
		});
	});

	it("header carries closed samples and retains browser under a normal envelope", async () => {
		const trace = createTraceContext();
		await Promise.all(
			Array.from({ length: 24 }, () => trace.span("browser.page.goto", async () => undefined)),
		);
		const telemetry = new RequestTelemetry(trace);
		telemetry.register(new BrowserTelemetryCollector());
		const decoded = JSON.parse(
			Buffer.from(telemetry.toHeaderValue()!, "base64url").toString("utf8"),
		);
		expect(decoded.browser.samples.every((s: { name: string }) => typeof s.name === "string")).toBe(
			true,
		);
	});

	it("construction omits the browser sibling when unused", () => {
		expect(
			new BrowserTelemetryCollector().toLogPayload({
				spans: [],
				byName: new Map(),
				count: () => 0,
				durationMs: () => 0,
			}),
		).toBeUndefined();
	});

	it("4096-byte budget with 24 samples drops browser before stealth before http", async () => {
		for (const stealthSamples of [16, 32]) {
			const trace = createTraceContext();
			await Promise.all(
				Array.from({ length: 24 }, () =>
					trace.span("browser.page.waitForSelector", async () => undefined),
				),
			);
			const telemetry = new RequestTelemetry(trace);
			for (const [key, length] of [
				["http", 16],
				["stealth", stealthSamples],
			] as const) {
				const payload = { samples: Array.from({ length }, () => closedEnum("x".repeat(63))) };
				telemetry.register({ key, toLogPayload: () => payload, toHeaderPayload: () => payload });
			}
			const collector = new BrowserTelemetryCollector();
			expect(collector.toLogPayload(index(trace))?.samples).toHaveLength(24);
			telemetry.register(collector);
			const value = telemetry.toHeaderValue()!;
			const decoded = JSON.parse(Buffer.from(value, "base64url").toString());
			expect(value.length).toBeLessThanOrEqual(4096);
			expect(decoded.browser).toBeUndefined();
			expect(decoded.http).toBeDefined();
			expect(decoded.truncated).toBe(true);
			if (stealthSamples === 16) expect(decoded.stealth).toBeDefined();
			else expect(decoded.stealth).toBeUndefined();
		}
	});

	it("differential fake engine preserves return values and call ordering", async () => {
		const run = async (record: boolean) => {
			const calls: string[] = [];
			const page = createBrowserPageDouble({
				goto: async () => {
					calls.push("goto");
				},
				click: async () => {
					calls.push("click");
				},
				fill: async () => {
					calls.push("fill");
				},
				type: async () => {
					calls.push("type");
				},
				waitForSelector: async () => {
					calls.push("wait");
				},
				content: async () => {
					calls.push("content");
					return "html";
				},
			});
			const context = createProviderContextDouble({
				browser: createBrowserClientDouble({
					newPage: async () => {
						calls.push("newPage");
						return page;
					},
				}),
				trace: createTraceContext(),
			});
			const browser = record ? wrapWithInstrumentation(context).browser : context.browser;
			const p = await browser.newPage();
			await p.goto("x");
			await p.click("#x");
			await p.fill("#x", "v");
			await p.type("#x", "v");
			await p.waitForSelector("#x");
			return { result: await p.content(), value: await p.evaluate(() => 7), calls };
		};
		expect(await run(true)).toEqual(await run(false));
	});
});
