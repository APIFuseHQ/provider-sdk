import { describe, expect, it } from "bun:test";

import type { Span } from "../runtime/trace.js";
import { renderWaterfall, type WaterfallRequest } from "../runtime/waterfall.js";

function assertDefined<T>(value: T | null | undefined, message?: string): T {
	if (value === null || value === undefined) {
		throw new Error(message ?? "Expected value to be defined");
	}

	return value;
}

function makeSpan(overrides: Partial<Span> & { name: string }): Span {
	return {
		id: crypto.randomUUID(),
		name: overrides.name,
		startedAt: overrides.startedAt ?? 1000,
		endedAt: overrides.endedAt ?? 1100,
		duration_ms: overrides.duration_ms ?? 100,
		status: overrides.status ?? "ok",
		attributes: overrides.attributes ?? {},
		...(overrides.parentId ? { parentId: overrides.parentId } : {}),
		...(overrides.error ? { error: overrides.error } : {}),
		...(overrides.id ? { id: overrides.id } : {}),
	};
}

const defaultRequest: WaterfallRequest = {
	method: "GET",
	path: "/v1/korea-air-quality/realtime",
	status: 200,
	totalMs: 289,
};

describe("renderWaterfall", () => {
	it("renders span name and duration", () => {
		const rootSpan = makeSpan({
			id: "root-1",
			name: "prices",
			startedAt: 1000,
			endedAt: 1289,
			duration_ms: 289,
		});

		const child = makeSpan({
			name: "normalizeRequest",
			parentId: "root-1",
			startedAt: 1000,
			endedAt: 1001,
			duration_ms: 0.1,
		});

		const output = renderWaterfall([rootSpan, child], defaultRequest);

		expect(output).toContain("prices");
		expect(output).toContain("289ms");
		expect(output).toContain("normalizeRequest");
		expect(output).toContain("0.1ms");
	});

	it("indents child spans", () => {
		const root = makeSpan({
			id: "root-1",
			name: "prices",
			startedAt: 1000,
			endedAt: 1289,
			duration_ms: 289,
		});

		const parent = makeSpan({
			id: "parent-1",
			name: "stealth.fetch",
			parentId: "root-1",
			startedAt: 1001,
			endedAt: 1286,
			duration_ms: 285,
		});

		const child = makeSpan({
			name: "dns",
			parentId: "parent-1",
			startedAt: 1001,
			endedAt: 1012,
			duration_ms: 11.3,
		});

		const output = renderWaterfall([root, parent, child], defaultRequest);

		const lines = output.split("\n");

		const stealthFetchLine = lines.find((l) => l.includes("stealth.fetch"));
		const dnsLine = lines.find((l) => l.includes("dns"));

		expect(stealthFetchLine).toBeDefined();
		expect(dnsLine).toBeDefined();

		const stripAnsi = (s: string) => s.replace(new RegExp("\\u001b\\[[0-9;]*m", "g"), "");
		const stealthFetchPos = stripAnsi(assertDefined(stealthFetchLine)).indexOf("├─");
		const dnsPos = stripAnsi(assertDefined(dnsLine)).indexOf("└─");

		expect(dnsPos).toBeGreaterThan(stealthFetchPos);
	});

	it("marks slow spans yellow", () => {
		const root = makeSpan({
			id: "root-1",
			name: "prices",
			startedAt: 1000,
			endedAt: 1600,
			duration_ms: 600,
		});

		const slowChild = makeSpan({
			name: "stealth.fetch",
			parentId: "root-1",
			startedAt: 1000,
			endedAt: 1600,
			duration_ms: 600,
		});

		const output = renderWaterfall(
			[root, slowChild],
			{
				...defaultRequest,
				totalMs: 600,
			},
			{ slowThresholdMs: 500 },
		);

		expect(output).toContain("\x1b[33m");
	});

	it("marks error spans red", () => {
		const root = makeSpan({
			id: "root-1",
			name: "prices",
			startedAt: 1000,
			endedAt: 1100,
			duration_ms: 100,
			status: "error",
			error: "Network failure",
		});

		const output = renderWaterfall([root], {
			...defaultRequest,
			status: 500,
			totalMs: 100,
		});

		expect(output).toContain("\x1b[31m");
	});

	it("marks bottleneck with star", () => {
		const root = makeSpan({
			id: "root-1",
			name: "prices",
			startedAt: 1000,
			endedAt: 1289,
			duration_ms: 289,
		});

		const fast = makeSpan({
			name: "normalizeRequest",
			parentId: "root-1",
			startedAt: 1000,
			endedAt: 1001,
			duration_ms: 0.1,
		});

		const slow = makeSpan({
			name: "stealth.fetch",
			parentId: "root-1",
			startedAt: 1001,
			endedAt: 1286,
			duration_ms: 285,
		});

		const transform = makeSpan({
			name: "transformResponse",
			parentId: "root-1",
			startedAt: 1286,
			endedAt: 1289,
			duration_ms: 3.2,
		});

		const output = renderWaterfall([root, fast, slow, transform], defaultRequest);

		const lines = output.split("\n");
		const stealthFetchLine = lines.find((l) => l.includes("stealth.fetch"));
		expect(stealthFetchLine).toContain("★");

		const normalizeLine = lines.find((l) => l.includes("normalizeRequest"));
		expect(normalizeLine).not.toContain("★");
	});

	it("returns empty string for no spans", () => {
		const output = renderWaterfall([], defaultRequest);
		expect(output).toBe("");
	});

	it("renders status line with method and path", () => {
		const root = makeSpan({
			id: "root-1",
			name: "prices",
			duration_ms: 100,
		});

		const output = renderWaterfall([root], defaultRequest);

		expect(output).toContain("GET");
		expect(output).toContain("/v1/korea-air-quality/realtime");
		expect(output).toContain("200");
		expect(output).toContain("OK");
	});

	it("renders timing bars proportional to total duration", () => {
		const root = makeSpan({
			id: "root-1",
			name: "op",
			startedAt: 1000,
			endedAt: 1200,
			duration_ms: 200,
		});

		const half = makeSpan({
			name: "half",
			parentId: "root-1",
			startedAt: 1000,
			endedAt: 1100,
			duration_ms: 100,
		});

		const full = makeSpan({
			name: "full",
			parentId: "root-1",
			startedAt: 1100,
			endedAt: 1200,
			duration_ms: 200,
		});

		const output = renderWaterfall(
			[root, half, full],
			{
				...defaultRequest,
				totalMs: 200,
			},
			{ maxBarWidth: 20 },
		);

		const stripAnsi = (s: string) => s.replace(new RegExp("\\u001b\\[[0-9;]*m", "g"), "");
		const lines = output.split("\n").map(stripAnsi);

		const halfLine = lines.find((l) => l.includes("half") && !l.includes("full"));
		const fullLine = lines.find((l) => l.includes("full"));

		const countBars = (s: string) => (s.match(/━/g) ?? []).length;
		const halfBars = countBars(halfLine ?? "");
		const fullBars = countBars(fullLine ?? "");

		expect(fullBars).toBeGreaterThan(halfBars);
	});
});
