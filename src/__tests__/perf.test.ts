import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import {
	computePercentile,
	computeStats,
	groupSpansByName,
} from "../runtime/perf";
import type { Span } from "../runtime/trace";

function makeSpan(name: string, duration_ms: number): Span {
	return {
		id: crypto.randomUUID(),
		name,
		startedAt: 1000,
		endedAt: 1000 + duration_ms,
		duration_ms,
		status: "ok",
		attributes: {},
	};
}

describe("computePercentile", () => {
	it("computes p50 correctly", () => {
		expect(computePercentile([10, 20, 30, 40, 50], 50)).toBe(30);
	});

	it("computes p95 correctly", () => {
		expect(computePercentile([10, 20, 30, 40, 50], 95)).toBe(48);
	});

	it("handles single element", () => {
		expect(computePercentile([42], 99)).toBe(42);
	});
});

describe("computeStats", () => {
	it("returns p50/p95/p99/avg for sample data", () => {
		expect(computeStats([10, 20, 30, 40, 50])).toEqual({
			p50: 30,
			p95: 48,
			p99: 49.6,
			avg: 30,
			min: 10,
			max: 50,
		});
	});
});

describe("groupSpansByName", () => {
	it("groups spans across multiple runs", () => {
		const grouped = groupSpansByName([
			[makeSpan("stealth.fetch", 100), makeSpan("transformResponse", 5)],
			[makeSpan("stealth.fetch", 120), makeSpan("normalizeRequest", 1)],
		]);

		expect(grouped.get("stealth.fetch")).toEqual([100, 120]);
		expect(grouped.get("transformResponse")).toEqual([5]);
		expect(grouped.get("normalizeRequest")).toEqual([1]);
	});
});

describe("CLI help", () => {
	it("prints record subcommand help without a stack trace", async () => {
		const proc = Bun.spawn({
			cmd: [
				"bun",
				join(import.meta.dir, "../../bin/apifuse-record.ts"),
				"--help",
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage: apifuse record");
		expect(stderr).not.toContain("Error:");
	});

	it("prints perf subcommand help without a stack trace", async () => {
		const proc = Bun.spawn({
			cmd: [
				"bun",
				join(import.meta.dir, "../../bin/apifuse-perf.ts"),
				"--help",
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage: apifuse perf");
		expect(stdout).toContain("--params");
		expect(stderr).not.toContain("Error:");
	});
});
