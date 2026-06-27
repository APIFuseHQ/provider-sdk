import { describe, expect, it } from "bun:test";

import {
	generateInsights,
	type Insight,
	type InsightSeverity,
} from "../runtime/insights";
import type { Span } from "../runtime/trace";

function makeSpan(
	name: string,
	overrides: Partial<Span> = {},
	attributes: Span["attributes"] = {},
): Span {
	const duration_ms = overrides.duration_ms ?? 10;
	return {
		id: overrides.id ?? crypto.randomUUID(),
		name,
		startedAt: overrides.startedAt ?? 1_000,
		endedAt: overrides.endedAt ?? 1_000 + duration_ms,
		duration_ms,
		status: overrides.status ?? "ok",
		attributes: overrides.attributes ?? attributes,
		...(overrides.parentId ? { parentId: overrides.parentId } : {}),
		...(overrides.error ? { error: overrides.error } : {}),
	};
}

function findInsight(insights: Insight[], id: string): Insight {
	const insight = insights.find((item) => item.id === id);
	if (!insight) {
		throw new Error(`Missing insight: ${id}`);
	}

	return insight;
}

function expectSeverity(
	insights: Insight[],
	id: string,
	severity: InsightSeverity,
): Insight {
	const insight = findInsight(insights, id);
	expect(insight.severity).toBe(severity);
	return insight;
}

describe("generateInsights", () => {
	it("returns empty array for empty spans", () => {
		expect(generateInsights([])).toEqual([]);
	});

	it("detects stealth reuse failure when less than 20% are reused", () => {
		const spans: Span[] = [
			makeSpan("stealth.fetch", {}, { connection_reused: false }),
			makeSpan("stealth.fetch", {}, { connection_reused: false }),
			makeSpan("stealth.fetch", {}, { connection_reused: false }),
			makeSpan("stealth.fetch", {}, { connection_reused: false }),
			makeSpan("stealth.fetch", {}, { connection_reused: true }),
		];

		const insight = expectSeverity(
			generateInsights(spans),
			"tls_reuse_failure",
			"warning",
		);

		expect(insight.message).toContain("Stealth connection reuse");
		expect(insight.fix).toContain("ctx.stealth.createSession");
	});

	it("marks stealth reuse as OK when at least 80% are reused", () => {
		const spans: Span[] = [
			makeSpan("stealth.fetch", {}, { connection_reused: true }),
			makeSpan("stealth.fetch", {}, { connection_reused: true }),
			makeSpan("stealth.fetch", {}, { connection_reused: true }),
			makeSpan("stealth.fetch", {}, { connection_reused: true }),
			makeSpan("stealth.fetch", {}, { connection_reused: false }),
		];

		const insight = expectSeverity(
			generateInsights(spans),
			"tls_reuse_failure",
			"info",
		);

		expect(insight.message.startsWith("✓")).toBe(true);
		expect(insight.message).toContain("80%");
	});

	it("detects slow transform spans by p95", () => {
		const spans: Span[] = [
			makeSpan("transformResponse", { duration_ms: 5 }),
			makeSpan("transformResponse", { duration_ms: 8 }),
			makeSpan("transformResponse", { duration_ms: 20 }),
			makeSpan("transformResponse", { duration_ms: 25 }),
		];

		const insight = expectSeverity(
			generateInsights(spans),
			"slow_transform",
			"warning",
		);

		expect(insight.message).toContain("p95");
		expect(insight.fix).toContain("transformResponse");
	});

	it("detects large responses over 100KB", () => {
		const spans: Span[] = [
			makeSpan("stealth.fetch", {}, { response_size: 120_000 }),
			makeSpan("http.get", {}, { response_size: 5_000 }),
		];

		const insight = expectSeverity(
			generateInsights(spans),
			"large_response",
			"warning",
		);

		expect(insight.message).toContain("Response size");
		expect(insight.fix).toContain("limit");
	});

	it("detects repeated DNS latency for the same host without reuse", () => {
		const spans: Span[] = [
			makeSpan(
				"stealth.fetch",
				{},
				{
					url: "https://api.example.com/a",
					dns_ms: 8,
					connection_reused: false,
				},
			),
			makeSpan(
				"stealth.fetch",
				{},
				{
					url: "https://api.example.com/b",
					dns_ms: 12,
					connection_reused: false,
				},
			),
		];

		const insight = expectSeverity(
			generateInsights(spans),
			"dns_repeated",
			"warning",
		);

		expect(insight.message).toContain("api.example.com");
		expect(insight.fix).toContain("DNS");
	});

	it("detects proxy overhead when proxied requests are twice as slow", () => {
		const spans: Span[] = [
			makeSpan("stealth.fetch", { duration_ms: 100 }, { proxy: false }),
			makeSpan("stealth.fetch", { duration_ms: 120 }, { proxy: false }),
			makeSpan("stealth.fetch", { duration_ms: 250 }, { proxy: true }),
			makeSpan("stealth.fetch", { duration_ms: 260 }, { proxy: true }),
		];

		const insight = expectSeverity(
			generateInsights(spans),
			"proxy_overhead",
			"warning",
		);

		expect(insight.message).toContain("with proxy");
		expect(insight.fix).toContain("proxy");
	});

	it("detects browser idle waits over five seconds", () => {
		const spans: Span[] = [
			makeSpan("page.waitForSelector", {}, { wait_ms: 6_200 }),
			makeSpan("page.click", { duration_ms: 20 }),
		];

		const insight = expectSeverity(
			generateInsights(spans),
			"browser_idle",
			"warning",
		);

		expect(insight.message).toContain("6200ms");
		expect(insight.fix).toContain("waitForSelector");
	});

	it("detects frequent session refreshes", () => {
		const spans: Span[] = [
			makeSpan("stealth.fetch"),
			makeSpan("stealth.fetch"),
			makeSpan("stealth.fetch"),
			makeSpan("stealth.fetch"),
			makeSpan("stealth.fetch"),
			makeSpan("credential.refresh"),
		];

		const insight = expectSeverity(
			generateInsights(spans),
			"session_expiry_frequent",
			"warning",
		);

		expect(insight.message).toContain("20%");
		expect(insight.fix).toContain("ttl");
	});
});
