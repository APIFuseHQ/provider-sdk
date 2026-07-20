import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { exportSpansOTLP, spansToOTLP } from "../runtime/otlp.js";
import type { TraceSpan } from "../types.js";

function makeSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
	return {
		id: overrides.id ?? "span-1",
		name: overrides.name ?? "provider.search",
		startedAt: overrides.startedAt ?? 1_000,
		endedAt: overrides.endedAt ?? 1_025,
		duration_ms: overrides.duration_ms ?? 25,
		status: overrides.status ?? "ok",
		attributes: overrides.attributes ?? {
			method: "GET",
			status: 200,
			success: true,
		},
		...(overrides.parentId ? { parentId: overrides.parentId } : {}),
		...(overrides.error ? { error: overrides.error } : {}),
	};
}

describe("otlp export", () => {
	let originalFetch: typeof fetch;
	let originalWarn: typeof console.warn;

	beforeEach(() => {
		originalFetch = global.fetch;
		originalWarn = console.warn;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		console.warn = originalWarn;
	});

	it("spansToOTLP() returns OTLP resource and scope span payload", () => {
		const payload = spansToOTLP(
			[makeSpan({ id: "abc123", parentId: "def456", name: "stealth.fetch" })],
			{ "service.name": "provider-sdk-test" },
		);

		expect(payload).toEqual({
			resourceSpans: [
				{
					resource: {
						attributes: [
							{
								key: "service.name",
								value: { stringValue: "provider-sdk-test" },
							},
						],
					},
					scopeSpans: [
						{
							scope: {
								name: "apifuse-provider-sdk",
								version: "0.1.0",
							},
							spans: [
								{
									attributes: [
										{
											key: "method",
											value: { stringValue: "GET" },
										},
										{
											key: "status",
											value: { doubleValue: 200 },
										},
										{
											key: "success",
											value: { boolValue: true },
										},
									],
									endTimeUnixNano: "1025000000",
									kind: 2,
									name: "stealth.fetch",
									parentSpanId: "0000000000def456",
									spanId: "0000000000abc123",
									startTimeUnixNano: "1000000000",
									status: { code: 1 },
									traceId: "00000000000000000000000000000001",
								},
							],
						},
					],
				},
			],
		});
	});

	it("exportSpansOTLP() posts OTLP JSON with merged headers", async () => {
		let requestUrl: string | undefined;
		let requestInit: RequestInit | undefined;

		global.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			requestUrl = typeof url === "string" ? url : url.toString();
			requestInit = init;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		await exportSpansOTLP([makeSpan()], {
			endpoint: "http://localhost:4318/v1/traces",
			headers: { Authorization: "Bearer test" },
			timeout: 100,
		});

		expect(requestUrl).toBe("http://localhost:4318/v1/traces");
		expect(requestInit?.method).toBe("POST");
		expect(requestInit?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer test",
		});
		expect(JSON.parse(String(requestInit?.body))).toEqual(spansToOTLP([makeSpan()]));
	});

	it("exportSpansOTLP() swallows fetch errors and warns", async () => {
		const warn = mock(() => {});
		console.warn = warn;
		global.fetch = mock(async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;

		await expect(
			exportSpansOTLP([makeSpan()], {
				endpoint: "http://localhost:4318/v1/traces",
			}),
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledWith("[apifuse] OTLP export failed:", "network down");
	});
});
