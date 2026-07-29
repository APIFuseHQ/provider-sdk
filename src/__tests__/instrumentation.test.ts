import { describe, expect, it, mock } from "bun:test";
import { createProviderCache } from "../runtime/cache.js";
import { createTestProviderChoiceContext } from "../runtime/choice.js";
import { createCredentialContext } from "../runtime/credential.js";
import { createEnvContext } from "../runtime/env.js";
import { isProviderError } from "../errors.js";
import { wrapWithInstrumentation } from "../runtime/instrumentation.js";
import { createMemoryProviderRuntimeState } from "../runtime/state.js";
import { createTraceContext } from "../runtime/trace.js";
import type {
	AuthContext,
	BrowserClient,
	HttpClient,
	ProviderContext,
	StealthClient,
} from "../types.js";

function createMockHttpResponse(requestId: string, duration: number) {
	const data = { ok: true };
	const body = JSON.stringify(data);
	const bodyBytes = new TextEncoder().encode(body);
	return {
		status: 200,
		ok: true,
		headers: { "content-type": "application/json" },
		data,
		meta: { requestId, duration },
		json: async <T>() => data as T,
		text: async () => body,
		arrayBuffer: async () =>
			bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength),
		bytes: async () => bodyBytes.slice(0),
	};
}

function createMockContext(): ProviderContext {
	const mockPage = {
		pageId: "page-1",
		goto: mock(async (url: string) => ({ url })),
		fill: mock(async () => undefined),
		click: mock(async () => undefined),
		type: mock(async () => undefined),
		waitForSelector: mock(async () => undefined),
	};

	const stealth: StealthClient = {
		fetch: mock(async () => ({
			status: 201,
			ok: true,
			headers: {},
			rawHeaders: [] as [string, string][],
			body: "created",
			cookies: {
				get: () => undefined,
				getAll: () => ({}),
				toString: () => "",
			},
			json: async <T>() => ({}) as T,
		})),
		createSession: mock(() => ({
			fetch: async () => ({
				status: 200,
				ok: true,
				headers: {},
				rawHeaders: [] as [string, string][],
				body: "ok",
				cookies: {
					get: () => undefined,
					getAll: () => ({}),
					toString: () => "",
				},
				json: async <T>() => ({}) as T,
			}),
			close: () => {},
		})),
	};

	return {
		env: createEnvContext(),
		credential: createCredentialContext(),
		http: {
			request: mock(async () => createMockHttpResponse("req-0", 10)),
			get: mock(async () => createMockHttpResponse("req-1", 15)),
			post: mock(async () => createMockHttpResponse("req-2", 20)),
			put: mock(async () => createMockHttpResponse("req-3", 25)),
			delete: mock(async () => createMockHttpResponse("req-4", 30)),
			stream: mock(async () => {
				throw new Error("stream unsupported in instrumentation test client");
			}),
			sse: mock(async () => {
				throw new Error("sse unsupported in instrumentation test client");
			}),
		} as HttpClient,
		cache: createProviderCache({ providerId: "instrumented-provider" }),
		stealth,
		browser: {
			engine: "playwright-stealth",
			newPage: mock(async () => mockPage),
			goto: mock(async (url: string) => ({ url })),
		} as unknown as BrowserClient,
		trace: createTraceContext(),
		auth: {} as AuthContext,
		choice: createTestProviderChoiceContext({
			providerId: "instrumented-provider",
		}),
	};
}

describe("createTraceContext", () => {
	it("collects nested custom spans in start order", async () => {
		const trace = createTraceContext();

		const result = await trace.span("operation", async () => {
			return trace.span("parse", async () => "done");
		});

		const spans = trace.getSpans();

		expect(result).toBe("done");
		expect(spans).toHaveLength(2);
		expect(spans[0]?.name).toBe("operation");
		expect(spans[1]?.name).toBe("parse");
		expect(spans[1]?.parentId).toBe(spans[0]?.id);
		expect(spans[0]?.status).toBe("ok");
		expect(spans[1]?.attributes.duration_ms).toBeNumber();
	});

	it("enforces maxSpans by trimming the oldest completed spans", async () => {
		const trace = createTraceContext({ maxSpans: 2 });

		await trace.span("first", async () => undefined);
		await trace.span("second", async () => undefined);
		await trace.span("third", async () => undefined);

		expect(trace.getSpans().map((span) => span.name)).toEqual(["second", "third"]);
	});
});

describe("wrapWithInstrumentation", () => {
	it("creates spans for http, stealth, and browser method calls", async () => {
		const onSpan = mock(() => {});
		const ctx = createMockContext();
		const instrumented = wrapWithInstrumentation(ctx, { onSpan });

		await instrumented.trace.span("provider.search", async () => {
			await instrumented.http.get("https://api.example.com/items");
			await instrumented.stealth.fetch("https://secure.example.com/login", {
				method: "POST",
			});
			await (
				instrumented.browser as BrowserClient & {
					goto(url: string): Promise<{ url: string }>;
				}
			).goto("https://app.example.com/dashboard");
		});

		const spans = instrumented.trace.getSpans();

		expect(spans.map((span) => span.name)).toEqual([
			"provider.search",
			"http.get",
			"stealth.fetch",
			"browser.goto",
		]);

		const httpSpan = spans[1];
		expect(httpSpan).toMatchObject({
			status: "ok",
			parentId: spans[0]?.id,
			attributes: {
				url: "https://api.example.com/items",
				method: "GET",
				status: 200,
				duration_ms: 15,
			},
		});

		const tlsSpan = spans[2];
		expect(tlsSpan).toMatchObject({
			status: "ok",
			parentId: spans[0]?.id,
			attributes: {
				url: "https://secure.example.com/login",
				method: "POST",
				status: 201,
			},
		});

		const browserSpan = spans[3];
		expect(browserSpan).toMatchObject({
			status: "ok",
			parentId: spans[0]?.id,
			attributes: {
				url: "https://app.example.com/dashboard",
			},
		});

		expect(onSpan).toHaveBeenCalledTimes(4);
	});

	it("wraps browser newPage and page methods with spans", async () => {
		const ctx = createMockContext();
		const instrumented = wrapWithInstrumentation(ctx);

		const page = (await instrumented.browser.newPage()) as {
			goto(url: string): Promise<{ url: string }>;
			fill(selector: string, value: string): Promise<void>;
			click(selector: string): Promise<void>;
			type(selector: string, text: string): Promise<void>;
			waitForSelector(selector: string): Promise<void>;
		};

		await page.goto("https://app.example.com/login");
		await page.fill("#username", "demo");
		await page.click("button[type=submit]");
		await page.type("#otp", "123456");
		await page.waitForSelector(".dashboard");

		const spans = instrumented.trace.getSpans();
		expect(spans.map((span) => span.name)).toEqual([
			"browser.newPage",
			"browser.page.goto",
			"browser.page.fill",
			"browser.page.click",
			"browser.page.type",
			"browser.page.waitForSelector",
		]);
		expect(spans[0]?.attributes).toMatchObject({
			allocate_ms: expect.any(Number),
			page_id: "page-1",
			engine: "playwright-stealth",
		});
		expect(spans[1]?.attributes).toMatchObject({
			url: "https://app.example.com/login",
			navigation_ms: expect.any(Number),
		});
		expect(spans[2]?.attributes).toMatchObject({
			selector: "#username",
			action_ms: expect.any(Number),
		});
		expect(spans[3]?.attributes).toMatchObject({
			selector: "button[type=submit]",
			action_ms: expect.any(Number),
		});
		expect(spans[4]?.attributes).toMatchObject({
			selector: "#otp",
			action_ms: expect.any(Number),
		});
		expect(spans[5]?.attributes).toMatchObject({
			selector: ".dashboard",
			wait_ms: expect.any(Number),
		});
	});

	it("records error spans when instrumented methods throw", async () => {
		const ctx = createMockContext();
		ctx.stealth.fetch = mock(async () => {
			const error = new Error("boom") as Error & { status: number };
			error.status = 503;
			throw error;
		});

		const instrumented = wrapWithInstrumentation(ctx);

		await expect(instrumented.stealth.fetch("https://secure.example.com/fail")).rejects.toThrow(
			"boom",
		);

		expect(instrumented.trace.getSpans()[0]).toMatchObject({
			name: "stealth.fetch",
			status: "error",
			error: "boom",
			attributes: {
				url: "https://secure.example.com/fail",
				method: "GET",
				status: 503,
			},
		});
	});

	it("redacts sensitiveParams from traced transport errors", async () => {
		const secret = "trace-test-secret";
		const ctx = createMockContext();
		ctx.http.get = mock(async () => {
			throw new Error(`Failed https://api.example.com/items?serviceKey=${secret}`);
		});

		const instrumented = wrapWithInstrumentation(ctx);
		await expect(
			instrumented.http.get("https://api.example.com/items", {
				sensitiveParams: { serviceKey: secret },
			}),
		).rejects.toThrow("serviceKey=[REDACTED]");

		const serializedSpan = JSON.stringify(instrumented.trace.getSpans()[0]);
		expect(serializedSpan).toContain("[REDACTED]");
		expect(serializedSpan).not.toContain(secret);
	});
});

describe("synchronous return fidelity (state + stealth factories)", () => {
	// Regression for the 2026-07-27 catchtable CONFIRM_STATE_UNAVAILABLE outage
	// (and the 2026-07-22 reserve internal_error loop): the generic method
	// wrapper span-wrapped EVERY function property, and runSpan always returns
	// a Promise — so the synchronous factory `ctx.state.namespace()` came back
	// as a Promise and every downstream method call threw a raw
	// `TypeError: ns.compareAndSet is not a function`.
	it("keeps ctx.state.namespace() synchronous and instruments the returned namespace's operations", async () => {
		const ctx = createMockContext();
		ctx.state = createMemoryProviderRuntimeState();
		const instrumented = wrapWithInstrumentation(ctx);

		const ns = instrumented.state.namespace("attempt_results", {
			defaultTtl: "1h",
			maxTtl: "1h",
			maxEntries: 5,
			maxValueBytes: 1024,
		});

		expect(isThenableForTest(ns)).toBe(false);
		expect(typeof ns.get).toBe("function");
		expect(typeof ns.compareAndSet).toBe("function");

		await ns.set("k", { v: 1 });
		const stored = await ns.get<{ v: number }>("k");
		expect(stored?.value).toEqual({ v: 1 });

		// The factory itself is not a span; the OPERATIONS are.
		const spanNames = instrumented.trace.getSpans().map((span) => span.name);
		expect(spanNames).toContain("state.set");
		expect(spanNames).toContain("state.get");
		expect(spanNames).not.toContain("state.namespace");
	});

	it("passes branded provider errors from state operations through unchanged (never a raw TypeError)", async () => {
		const ctx = createMockContext();
		ctx.state = createMemoryProviderRuntimeState();
		const instrumented = wrapWithInstrumentation(ctx);

		const ns = instrumented.state.namespace("attempt_results", {
			defaultTtl: "1h",
			maxTtl: "1h",
			maxEntries: 5,
			maxValueBytes: 1024,
		});

		let thrown: unknown;
		try {
			// The in-memory backend deliberately rejects CAS with a BRANDED error;
			// the instrumented path must surface exactly that, not a TypeError.
			await ns.compareAndSet("k", 0, { status: "confirming" }, { ttl: "3m" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).not.toBeInstanceOf(TypeError);
		expect(isProviderError(thrown)).toBe(true);
		expect((thrown as { code?: string }).code).toBe("PROVIDER_STATE_UNSUPPORTED");
	});

	it("records an error span when an instrumented method throws synchronously", async () => {
		const ctx = createMockContext();
		ctx.state = createMemoryProviderRuntimeState();
		// A promise-returning implementation that fails its pre-flight
		// validation SYNCHRONOUSLY: the throw must stay synchronous for the
		// caller, and the failure must still be recorded as an error span.
		(ctx.http as { get: unknown }).get = () => {
			throw new Error("sync pre-flight validation failed");
		};
		const instrumented = wrapWithInstrumentation(ctx);

		expect(() => instrumented.http.get("https://api.example.com/items")).toThrow(
			"sync pre-flight validation failed",
		);

		const spans = instrumented.trace.getSpans();
		const errorSpan = spans.find((span) => span.name === "http.get");
		expect(errorSpan).toBeDefined();
		expect(errorSpan?.status).toBe("error");
	});

	it("keeps stealth.createSession() synchronous with a working session client", async () => {
		const ctx = createMockContext();
		const instrumented = wrapWithInstrumentation(ctx);

		// Same fidelity class: createSession is a sync factory on an
		// instrumented namespace and must not come back as a Promise.
		const session = instrumented.stealth.createSession();
		expect(isThenableForTest(session)).toBe(false);
		const response = await session.fetch("https://secure.example.com/home");
		expect(response.ok).toBe(true);
	});
});

function isThenableForTest(value: unknown): boolean {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}
