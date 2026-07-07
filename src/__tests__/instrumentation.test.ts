import { describe, expect, it, mock } from "bun:test";
import { createProviderCache } from "../runtime/cache";
import { createTestProviderChoiceContext } from "../runtime/choice";
import { createCredentialContext } from "../runtime/credential";
import { createEnvContext } from "../runtime/env";
import { wrapWithInstrumentation } from "../runtime/instrumentation";
import { createUnsupportedNativeNetworkClient } from "../runtime/native-network";
import { createUnsupportedProviderRuntimeState } from "../runtime/state";
import { createUnsupportedSttClient } from "../runtime/stt";
import { createTraceContext } from "../runtime/trace";
import type {
	AuthContext,
	BrowserClient,
	HttpClient,
	ProviderContext,
	StealthClient,
} from "../types";

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
			bodyBytes.buffer.slice(
				bodyBytes.byteOffset,
				bodyBytes.byteOffset + bodyBytes.byteLength,
			),
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
		native: {
			network: createUnsupportedNativeNetworkClient(),
		},
		cache: createProviderCache({ providerId: "instrumented-provider" }),
		state: createUnsupportedProviderRuntimeState(),
		stealth,
		browser: {
			engine: "playwright-stealth",
			newPage: mock(async () => mockPage),
			goto: mock(async (url: string) => ({ url })),
		} as unknown as BrowserClient,
		trace: createTraceContext(),
		auth: {} as AuthContext,
		stt: createUnsupportedSttClient(),
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

		expect(trace.getSpans().map((span) => span.name)).toEqual([
			"second",
			"third",
		]);
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

		await expect(
			instrumented.stealth.fetch("https://secure.example.com/fail"),
		).rejects.toThrow("boom");

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
});
