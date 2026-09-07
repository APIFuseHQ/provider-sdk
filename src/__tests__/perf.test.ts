import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computePercentile, computeStats, groupSpansByName } from "../runtime/perf.js";
import type { Span } from "../runtime/trace.js";

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
			cmd: ["bun", join(import.meta.dir, "../../bin/apifuse-record.ts"), "--help"],
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
			cmd: ["bun", join(import.meta.dir, "../../bin/apifuse-perf.ts"), "--help"],
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

describe("perf JSON export", () => {
	it("sanitizes recorded spans before writing --export without a server request scope", async () => {
		const directory = await mkdtemp(join(tmpdir(), "apifuse-perf-redaction-"));
		const exportedPath = join(directory, "results.json");
		const wordKey = "hrfcokey1234";
		const uuidKey = "978942c2-e20b-4c2c-b7a3-50b3d1b0f980";
		const hexKey = "0123456789abcdef0123456789abcdef";
		try {
			await writeFile(
				join(directory, "index.ts"),
				`
import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
import { createProviderDefinitionDouble } from ${JSON.stringify(join(import.meta.dir, "test-utils.ts"))};
import { getTraceRecorder } from ${JSON.stringify(join(import.meta.dir, "../runtime/trace.ts"))};
export default createProviderDefinitionDouble({
  operations: {
    inspect: {
      riskClass: "read", input: z.object({}), output: z.object({ ok: z.boolean() }),
      handler: async (ctx) => {
        await getTraceRecorder(ctx.trace).runSpan("provider.inspect", () => undefined, {
          attributes: {
            api_key: ${JSON.stringify(wordKey)},
            uuid_url: ${JSON.stringify(`https://vendor.test/${uuidKey}/items`)},
            hex_url: ${JSON.stringify(`https://vendor.test/${hexKey}/items`)},
            query_url: ${JSON.stringify(`https://vendor.test/items?api_key=${wordKey}`)},
          },
        });
        return { ok: true };
      },
    },
  },
});
`,
			);
			const proc = Bun.spawn({
				cmd: [
					"bun",
					join(import.meta.dir, "../../bin/apifuse-perf.ts"),
					directory,
					"--operation",
					"inspect",
					"--runs",
					"1",
					"--warmup",
					"0",
					"--export",
					exportedPath,
				],
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			expect(stdout).toContain("Exported JSON:");
			const serialized = await readFile(exportedPath, "utf8");
			for (const secret of [wordKey, uuidKey, hexKey]) expect(serialized).not.toContain(secret);
			const payload = JSON.parse(serialized) as { direct: { runs: Array<{ spans: Span[] }> } };
			const span = payload.direct.runs[0]?.spans.find((entry) => entry.name === "provider.inspect");
			expect(span?.attributes).toEqual({
				api_key: "[REDACTED]",
				uuid_url: "https://vendor.test/[REDACTED]/items",
				hex_url: "https://vendor.test/[REDACTED]/items",
				query_url: "https://vendor.test/items?[REDACTED]",
				duration_ms: expect.any(Number),
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

// Ported from the review's main/perf.test.ts: this path evades output heuristics.
it("redacts an env-known dictionary path in the actual perf export", async () => {
	const directory = await mkdtemp(join(tmpdir(), "apifuse-perf-registry-"));
	const exportedPath = join(directory, "results.json");
	const secret = "orchardgrove";
	expect(secret.length).toBe(12);
	try {
		await writeFile(
			join(directory, "index.ts"),
			`
import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
import { createProviderDefinitionDouble } from ${JSON.stringify(join(import.meta.dir, "test-utils.ts"))};
import { getTraceRecorder } from ${JSON.stringify(join(import.meta.dir, "../runtime/trace.ts"))};
export default createProviderDefinitionDouble({
 secrets: [{ name: 'P4_PERF_KEY' }],
 operations: { inspect: { riskClass: 'read', input: z.object({}), output: z.object({ok:z.boolean()}),
 handler: async ctx => {
  await getTraceRecorder(ctx.trace).runSpan('provider.inspect', () => {}, {
   attributes: { url: 'https://vendor.test/' + ctx.env.get('P4_PERF_KEY') + '/items' }
  });
  return {ok:true};
 } } }
});
`,
		);
		const proc = Bun.spawn(
			[
				"bun",
				join(import.meta.dir, "../../bin/apifuse-perf.ts"),
				directory,
				"--operation",
				"inspect",
				"--runs",
				"1",
				"--warmup",
				"0",
				"--export",
				exportedPath,
			],
			{
				env: { ...process.env, P4_PERF_KEY: secret },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exit] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		expect(stdout).toContain("Exported JSON:");
		const serialized = await readFile(exportedPath, "utf8");
		expect(serialized).not.toContain(secret);
		const payload: { direct: { runs: Array<{ spans: Span[] }> } } = JSON.parse(serialized);
		expect(
			payload.direct.runs[0]?.spans.find((span) => span.name === "provider.inspect")?.attributes
				.url,
		).toBe("https://vendor.test/[REDACTED]/items");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
