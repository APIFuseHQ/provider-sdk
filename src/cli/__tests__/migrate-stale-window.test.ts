import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	cpSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

import type { MigrateFinding, SourceStepResult } from "../migrate-source.js";
import { moveStaleWindowToOperations, STALE_WINDOW_RULES } from "../migrate-stale-window.js";

const FIXTURE = join(import.meta.dir, "fixtures", "migrate-stale-window");

let providerRoot: string;

beforeEach(() => {
	providerRoot = mkdtempSync(join(tmpdir(), "apifuse-stale-window-"));
	cpSync(FIXTURE, providerRoot, { recursive: true });
	for (const file of walk(providerRoot)) {
		if (file.endsWith(".ts.txt")) renameSync(file, file.slice(0, -".txt".length));
	}
});

afterEach(() => {
	rmSync(providerRoot, { recursive: true, force: true });
});

function walk(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

function read(file: string): string {
	return readFileSync(join(providerRoot, file), "utf8");
}

function snapshot(): Record<string, string> {
	return Object.fromEntries(walk(providerRoot).map((file) => [file, readFileSync(file, "utf8")]));
}

function parses(file: string): boolean {
	const source = ts.createSourceFile(
		file,
		read(file),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	return ((source as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length === 0;
}

function table(findings: readonly MigrateFinding[]): string[] {
	return findings.map((finding) => `${finding.ruleId} ${finding.file}:${finding.line}`);
}

describe("health-stale-window", () => {
	let result: SourceStepResult;
	beforeEach(() => {
		result = moveStaleWindowToOperations({ providerRoot, dryRun: false });
	});

	it("declares the window on the operation whose handler holds the calls and strips both call shapes", () => {
		const alpha = read("operations/alpha.ts");
		expect(alpha).toContain(
			'\tdescriptionKey: "operations.alpha.description",\n\tcache: { staleIfErrorMs: 300_000 },\n\thandler: async (ctx, input) => {',
		);
		expect(alpha).toContain("{ ttlMs: 60_000, jitterPct: 0.1 },");
		expect(alpha).toContain('await ctx.cache.set("alpha:last", page);');
		expect(alpha).not.toContain("staleIfErrorMs: 300_000,");
		expect(parses("operations/alpha.ts")).toBe(true);
	});

	it("follows the handler's call graph into a helper file, exports the constant it names, and imports it", () => {
		const beta = read("operations/beta.ts");
		expect(beta).toContain(
			'import { cachedJson } from "../upstream/client";\nimport { STALE_IF_ERROR_MS } from "../upstream/client";\n',
		);
		expect(beta).toContain("\tcache: { staleIfErrorMs: STALE_IF_ERROR_MS },\n\thandler:");
		const client = read("upstream/client.ts");
		expect(client).toContain("export const STALE_IF_ERROR_MS = 6 * 60 * 60 * 1000;");
		expect(client).toContain("export const CATALOG_STALE_MS = 24 * 60 * 60 * 1000;");
		for (const file of ["operations/beta.ts", "upstream/client.ts"])
			expect(parses(file)).toBe(true);
	});

	it("keeps a per-call option that an operation with two windows still reaches", () => {
		const client = read("upstream/client.ts");
		// gamma reaches both cachedJson and cachedCatalog, so neither call may lose
		// its option; beta's declaration is added anyway (the runtime warns once).
		expect(client).toContain("\t\tttlMs: TTL_MS,\n\t\tstaleIfErrorMs: STALE_IF_ERROR_MS,\n\t});");
		expect(client).toContain("\t\tstaleIfErrorMs: CATALOG_STALE_MS,\n");
		expect(read("operations/gamma.ts")).not.toContain("cache:");
		expect(table(result.residues)).toEqual([
			`${STALE_WINDOW_RULES.declaredDifferently} operations/declared.ts:12`,
			`${STALE_WINDOW_RULES.twoValues} operations/gamma.ts:8`,
			`${STALE_WINDOW_RULES.unreachable} upstream/client.ts:24`,
		]);
		expect(result.residues[1]?.message).toContain("(STALE_IF_ERROR_MS, CATALOG_STALE_MS)");
	});

	it("resolves a handler taken from a handlers map by element access", () => {
		const delta = read("operations/delta.ts");
		expect(delta).toContain('import { DELTA_STALE_MS } from "../handlers";');
		expect(delta).toContain(
			'\tcache: { staleIfErrorMs: DELTA_STALE_MS },\n\thandler: handlers["delta"],',
		);
		const handlers = read("handlers.ts");
		expect(handlers).toContain("export const DELTA_STALE_MS = 42_000;");
		expect(handlers).toContain("{ ttlMs: 1_000 })).value");
		for (const file of ["operations/delta.ts", "handlers.ts"]) expect(parses(file)).toBe(true);
	});

	it("leaves an operation that already declares the same window alone and refuses one that declares another", () => {
		const declared = read("operations/declared.ts");
		expect(declared.match(/cache: \{ staleIfErrorMs: STALE_IF_ERROR_MS \}/g)).toHaveLength(1);
		expect(declared).toContain("cache: { staleIfErrorMs: 1_000 },");
		// readRows is reached by both; `other` refuses, so the call keeps its option.
		expect(read("upstream/rows.ts")).toContain("staleIfErrorMs: STALE_IF_ERROR_MS");
	});

	it("counts one rewrite per declaration and per stripped call, and is a no-op on the second run", () => {
		expect(result.filesChanged).toEqual([
			"handlers.ts",
			"operations/alpha.ts",
			"operations/beta.ts",
			"operations/delta.ts",
			"upstream/client.ts",
		]);
		expect(result.rewrites).toBe(6);
		const before = snapshot();
		const again = moveStaleWindowToOperations({ providerRoot, dryRun: false });
		expect(again.filesChanged).toEqual([]);
		expect(again.rewrites).toBe(0);
		expect(table(again.residues).map((line) => line.replace(/:\d+$/, ""))).toEqual(
			table(result.residues).map((line) => line.replace(/:\d+$/, "")),
		);
		expect(snapshot()).toEqual(before);
	});
});

describe("health-stale-window without the provider cache capability", () => {
	it("adds cache: true to the one defineProvider declaration it finds", () => {
		const index = join(providerRoot, "index.ts");
		writeFileSync(index, readFileSync(index, "utf8").replace(", cache: true })", " })"));
		const result = moveStaleWindowToOperations({ providerRoot, dryRun: false });
		expect(result.rewrites).toBe(7);
		expect(read("index.ts")).toContain(
			'defineProvider({ id: "fixture", version: "1.0.0", runtime: "standard",\ncache: true })({',
		);
		expect(parses("index.ts")).toBe(true);
	});

	it("declares nothing when no defineProvider declaration can take the capability", () => {
		const index = join(providerRoot, "index.ts");
		writeFileSync(index, readFileSync(index, "utf8").replace("defineProvider(", "buildProvider("));
		const result = moveStaleWindowToOperations({ providerRoot, dryRun: false });
		expect(result.rewrites).toBe(0);
		expect(table(result.residues)).toContain(
			`${STALE_WINDOW_RULES.noCacheCapability} handlers.ts:1`,
		);
		expect(result.filesChanged).toEqual([]);
		expect(read("operations/alpha.ts")).toContain("staleIfErrorMs: 300_000");
	});
});

describe("health-stale-window dry run", () => {
	it("reports the rewrites and writes nothing", () => {
		const before = snapshot();
		const result = moveStaleWindowToOperations({ providerRoot, dryRun: true });
		expect(result.rewrites).toBe(6);
		expect(result.filesChanged).toContain("operations/alpha.ts");
		expect(snapshot()).toEqual(before);
	});
});
