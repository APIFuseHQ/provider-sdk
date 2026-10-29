import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	countWindowRules,
	judge,
	parseFixtureTestOutput,
	renderReport,
	type ScanReport,
	stripComments,
	type TargetReport,
} from "./bump-safety-scan.js";

const SDK = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(SDK, "scripts", "bump-safety-scan.ts");
const FIXTURES = path.join(SDK, "scripts", "__fixtures__", "bump-safety-scan");

let scratch: string;
let head: string;

function breakingHeadBuild(root: string): string {
	const dir = path.join(root, "head-sdk");
	cpSync(path.join(SDK, "package.json"), path.join(dir, "package.json"));
	cpSync(path.join(SDK, "dist"), path.join(dir, "dist"), { recursive: true });
	symlinkSync(path.join(SDK, "node_modules"), path.join(dir, "node_modules"));
	renameSync(path.join(dir, "dist", "define.js"), path.join(dir, "dist", "define.original.js"));
	writeFileSync(
		path.join(dir, "dist", "define.js"),
		[
			'export * from "./define.original.js";',
			'import { defineProvider as upstream } from "./define.original.js";',
			"export function defineProvider(declaration) {",
			'\tif (declaration?.id === "bump-scan-breaks") {',
			'\t\tthrow new Error("Provider " + JSON.stringify(declaration.id) + " must declare reviewed as first-party or community");',
			"\t}",
			"\treturn upstream(declaration);",
			"}",
			"",
		].join("\n"),
	);
	renameSync(path.join(dir, "dist", "contract.js"), path.join(dir, "dist", "contract.original.js"));
	writeFileSync(
		path.join(dir, "dist", "contract.js"),
		[
			'export * from "./contract.original.js";',
			'import { extractProviderContract as upstream } from "./contract.original.js";',
			"export function extractProviderContract(provider) {",
			'\tif (provider?.id === "bump-scan-digest") throw new Error("contract extraction refused for " + provider.id);',
			"\treturn upstream(provider);",
			"}",
			"",
		].join("\n"),
	);
	return dir;
}

function runScan(targets: string, scratchName: string, json: boolean) {
	return spawnSync(
		"bun",
		[
			SCRIPT,
			"--base",
			SDK,
			"--head",
			head,
			"--targets",
			targets,
			"--no-fixture-tests",
			"--scratch",
			path.join(scratch, scratchName),
			"--jobs",
			"2",
			...(json ? ["--json"] : []),
		],
		{ cwd: SDK, encoding: "utf8", timeout: 240_000 },
	);
}

beforeAll(() => {
	if (!existsSync(path.join(SDK, "dist", "index.js"))) {
		const build = spawnSync("bun", ["run", "build"], { cwd: SDK, stdio: "inherit" });
		if (build.status !== 0) throw new Error("bun run build failed");
	}
	scratch = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "bump-safety-scan-test-"));
	head = breakingHeadBuild(scratch);
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("bump-safety-scan", () => {
	it("marks the refused provider BREAK, the untouched one SAME, the unloadable one NOT COVERED and the digest-refused one BREAK", () => {
		const result = runScan(path.join(FIXTURES, "*"), "scan", true);
		expect(result.status).toBe(1);
		const report = JSON.parse(result.stdout) as ScanReport;
		const rows = Object.fromEntries(report.targets.map((target) => [target.name, target]));

		expect(Object.keys(rows).sort()).toEqual(["breaks", "clean", "digest", "unloadable"]);
		expect(rows.clean?.verdict).toBe("SAME");
		expect(rows.clean?.covered).toBe(true);
		expect(rows.clean?.base.probe?.load.status).toBe("ok");
		expect(rows.clean?.head.probe?.load.status).toBe("ok");
		expect(rows.clean?.base.probe?.digest).toBeString();
		expect(rows.clean?.head.probe?.digest).toBe(rows.clean?.base.probe?.digest as string);
		expect(rows.clean?.base.tsc?.errors).toBe(0);
		expect(rows.clean?.head.tsc?.errors).toBe(0);

		expect(rows.breaks?.verdict).toBe("BREAK");
		expect(rows.breaks?.covered).toBe(true);
		expect(rows.breaks?.base.probe?.load.status).toBe("ok");
		expect(rows.breaks?.head.probe?.load.status).toBe("error");
		expect(rows.breaks?.reasons[0]).toContain("loads on base, fails on head");

		expect(rows.unloadable?.verdict).toBe("NOT COVERED");
		expect(rows.unloadable?.covered).toBe(false);
		expect(rows.unloadable?.reasons[0]).toContain("fails to load on both sides");
		expect(rows.unloadable?.reasons[0]).toContain("fixture: cannot load on any SDK");

		expect(rows.digest?.verdict).toBe("BREAK");
		expect(rows.digest?.head.probe?.load.status).toBe("ok");
		expect(rows.digest?.base.probe?.digest).toBeString();
		expect(rows.digest?.head.probe?.digest).toBeUndefined();
		expect(rows.digest?.head.probe?.digestError).toContain("contract extraction refused");
		expect(rows.digest?.reasons[0]).toContain("contract extraction failed on head");

		expect(report.summary).toEqual({ SAME: 1, BREAK: 2, WARN: 0, "NOT COVERED": 1, SKIP: 0 });
		expect(report.targetPatterns).toEqual([path.join(FIXTURES, "*")]);
		expect(report.windowRules.map((usage) => usage.rule)).toEqual([
			"legacy-error-options",
			"legacy-handle-declaration",
			"proxy-session-pool-size",
			"redundant-approval",
			"context-keys",
			"schema-describe-prose",
		]);
		expect(report.windowRules.every((usage) => usage.providers.length === 0)).toBe(true);
	}, 120_000);

	it("renders the verdict table, the not-covered section and exits 1", () => {
		const result = runScan(
			`${path.join(FIXTURES, "breaks")},${path.join(FIXTURES, "unloadable")}`,
			"scan-table",
			false,
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("summary: 1 BREAK, 0 WARN, 0 SAME, 1 NOT COVERED, 0 SKIP");
		expect(result.stdout).toMatch(/^breaks\s+ok \/ ERR Error\s+0 \/ 0\s+-\s+.*BREAK/m);
		expect(result.stdout).toMatch(/^unloadable\s+ERR Error \/ ERR Error\s+.*NOT COVERED/m);
		expect(result.stdout).toContain("not covered: 1 target(s) fail on both sides");
		expect(result.stdout).toMatch(/^ {2}unloadable: Error: fixture: cannot load on any SDK/m);
		expect(result.stdout).toContain("DELETABLE");
	}, 120_000);
});

describe("judge", () => {
	const ok = (digest: string) => ({
		probe: { load: { status: "ok" as const }, digest, lint: {}, warnings: [] },
		tsc: { errors: 0, sample: [] },
	});
	const failing = {
		probe: {
			load: { status: "error" as const, errorClass: "ValidationError", message: "x" },
			lint: {},
			warnings: [],
		},
	};

	it("is SAME and covered when both sides load, compile and digest alike", () => {
		expect(judge({ kind: "provider", base: ok("a"), head: ok("a") })).toEqual({
			verdict: "SAME",
			covered: true,
			reasons: [],
		});
	});

	it("is BREAK when the contract digest changes", () => {
		expect(judge({ kind: "provider", base: ok("a"), head: ok("b") }).verdict).toBe("BREAK");
	});

	it("is BREAK when tsc goes from clean to red", () => {
		const head = { ...ok("a"), tsc: { errors: 3, sample: ["index.ts(1,1): error TS1"] } };
		const judged = judge({ kind: "provider", base: ok("a"), head });
		expect(judged.verdict).toBe("BREAK");
		expect(judged.reasons[0]).toContain("tsc 0 -> 3");
	});

	it("is BREAK when the head SDK cannot extract a contract it extracted on base, NOT COVERED when neither side can", () => {
		const extractionFailed = {
			...ok("a"),
			probe: {
				load: { status: "ok" as const },
				digestError: "walker threw",
				lint: {},
				warnings: [],
			},
		};
		const judged = judge({ kind: "provider", base: ok("a"), head: extractionFailed });
		expect(judged.verdict).toBe("BREAK");
		expect(judged.reasons[0]).toBe("contract extraction failed on head: walker threw");
		const both = judge({ kind: "provider", base: extractionFailed, head: extractionFailed });
		expect(both.verdict).toBe("NOT COVERED");
		expect(both.covered).toBe(false);
		expect(both.reasons[0]).toBe("contract extraction fails on both sides: walker threw");
	});

	it("is NOT COVERED when a provider fails identically on both sides", () => {
		const judged = judge({ kind: "provider", base: failing, head: failing });
		expect(judged.verdict).toBe("NOT COVERED");
		expect(judged.covered).toBe(false);
		expect(judged.reasons[0]).toBe("fails to load on both sides: ValidationError: x");
	});

	it("is WARN for a new lint error or a new runtime warning", () => {
		const lint = {
			...ok("a"),
			probe: {
				...ok("a").probe,
				lint: { "allowed-hosts-required": { level: "error" as const, count: 1 } },
			},
		};
		expect(judge({ kind: "provider", base: ok("a"), head: lint }).verdict).toBe("WARN");
		const warned = { ...ok("a"), probe: { ...ok("a").probe, warnings: ["[provider-sdk] x"] } };
		expect(judge({ kind: "provider", base: ok("a"), head: warned }).verdict).toBe("WARN");
	});

	it("is BREAK for a fixture test file that passes on base and fails on head", () => {
		const tests = (fail: number) => ({
			tests: { pass: 3, fail, files: { "a.test.ts": { pass: 3, fail } } },
		});
		expect(judge({ kind: "fixture-tests", base: tests(0), head: tests(1) }).verdict).toBe("BREAK");
	});

	it("is NOT COVERED for a fixture test file that fails on both sides, even next to a green file", () => {
		const side = {
			tests: {
				pass: 5,
				fail: 2,
				files: {
					"green.test.ts": { pass: 5, fail: 0 },
					"red.test.ts": { pass: 0, fail: 2, firstFailure: "ENOENT: infra/env/registry.yaml" },
				},
			},
		};
		const judged = judge({ kind: "fixture-tests", base: side, head: side });
		expect(judged.verdict).toBe("NOT COVERED");
		expect(judged.covered).toBe(false);
		expect(judged.reasons).toEqual([
			"red.test.ts: 2 fail on both sides: ENOENT: infra/env/registry.yaml",
		]);
	});
});

describe("renderReport", () => {
	it("lists a both-sides failing fixture file under not covered with its first failure", () => {
		const side = {
			tests: {
				pass: 0,
				fail: 86,
				files: {
					"scripts/__tests__/gpm.test.ts": {
						pass: 43,
						fail: 86,
						firstFailure: "ENOENT: infra/env/registry.yaml",
					},
				},
			},
		};
		const target: TargetReport = {
			name: "apifuse fixture-tests",
			kind: "fixture-tests",
			path: "/apifuse",
			base: side,
			head: side,
			verdict: "SKIP",
			covered: true,
			reasons: [],
		};
		Object.assign(target, judge(target));
		const rendered = renderReport({
			base: { spec: "a", dir: "/a", version: "1" },
			head: { spec: "b", dir: "/b", version: "1" },
			targetPatterns: ["/apifuse (fixture-tests)"],
			targets: [target],
			windowRules: [],
			summary: { SAME: 0, BREAK: 0, WARN: 0, "NOT COVERED": 1, SKIP: 0 },
		});
		expect(rendered).toContain("summary: 0 BREAK, 0 WARN, 0 SAME, 1 NOT COVERED, 0 SKIP");
		expect(rendered).toContain("not covered: 1 target(s) fail on both sides");
		expect(rendered).toContain(
			"  apifuse fixture-tests: scripts/__tests__/gpm.test.ts: 86 fail on both sides: ENOENT: infra/env/registry.yaml",
		);
		expect(rendered).toMatch(/^apifuse fixture-tests\s+86 fail \/ 86 fail\s+.*NOT COVERED/m);
	});
});

describe("parseFixtureTestOutput", () => {
	it("counts a nonzero exit with zero failed tests as a failure, whatever the pass count", () => {
		const text =
			"bun test v1.3.14\n(pass) suite > one\nerror: afterAll threw\n\n 1 pass\n 0 fail\n 1 error\nRan 1 test across 1 file.";
		expect(parseFixtureTestOutput(text, 1, false)).toEqual({
			pass: 1,
			fail: 1,
			firstFailure: "error: afterAll threw",
		});
		expect(parseFixtureTestOutput("\n 3 pass\n 0 fail\n", 0, false)).toEqual({ pass: 3, fail: 0 });
		expect(parseFixtureTestOutput("\n 3 pass\n 2 fail\n", 1, false)).toEqual({ pass: 3, fail: 2 });
		expect(parseFixtureTestOutput("", null, true)).toEqual({
			pass: 0,
			fail: 1,
			firstFailure: "timed out after 600s",
		});
	});
});

describe("stripComments", () => {
	it("removes comments but keeps comment-looking text inside strings and templates", () => {
		const source = [
			'const accept = "application/json, text/plain, */*";',
			"// a line comment with new ProviderError(",
			'const url = "https://example.com/path"; // trailing',
			`const tpl = \`https://$\{host}/x\`; /* block */ const after = 1;`,
			"/* multi",
			"   line */",
			'const slash = "contains // slash";',
			"const last = 2;",
		].join("\n");
		const stripped = stripComments(source);
		expect(stripped).toContain('"application/json, text/plain, */*"');
		expect(stripped).toContain('"https://example.com/path"');
		expect(stripped).toContain(`\`https://$\{host}/x\``);
		expect(stripped).toContain('"contains // slash"');
		expect(stripped).toContain("const after = 1;");
		expect(stripped).toContain("const last = 2;");
		expect(stripped).not.toContain("a line comment");
		expect(stripped).not.toContain("trailing");
		expect(stripped).not.toContain("block");
		expect(stripped).not.toContain("multi");
	});
});

describe("countWindowRules", () => {
	it("counts each window rule per target, skips comments and survives */* in strings", () => {
		const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "window-rules-"));
		try {
			const file = path.join(dir, "ops.ts");
			writeFileSync(
				file,
				[
					'const headers = { Accept: "application/json, text/plain, */*" };',
					'throw new ProviderError("x", { code: "X", retryable: false });',
					'throw new ProviderError("y", { code: "Y" });',
					"// throw new ProviderError('z', { category: 'upstream_http' });",
					'const note = "contains // slash"; throw new ProviderError("w", { code: "W", category: "upstream_http" });',
					'const cursor = defineCursor({ name: "page", fieldName: "page_token" });',
					"const session = { poolSize: 3 };",
					'const op = { approval: "always", contextKeys: ["a"] };',
					'const schema = z.string().describe("prose");',
					"/* .describe('in a block comment') */",
				].join("\n"),
			);
			const usage = Object.fromEntries(
				countWindowRules([{ name: "t", sources: [file] }]).map((entry) => [
					entry.rule,
					entry.sites,
				]),
			);
			expect(usage).toEqual({
				"legacy-error-options": 2,
				"legacy-handle-declaration": 1,
				"proxy-session-pool-size": 1,
				"redundant-approval": 1,
				"context-keys": 1,
				"schema-describe-prose": 1,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
