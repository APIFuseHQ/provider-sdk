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

import { countWindowRules, judge, type ScanReport } from "./bump-safety-scan.js";

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
	return dir;
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
	it("marks the provider the head build refuses BREAK and the untouched one SAME", () => {
		const result = spawnSync(
			"bun",
			[
				SCRIPT,
				"--base",
				SDK,
				"--head",
				head,
				"--targets",
				path.join(FIXTURES, "*"),
				"--no-fixture-tests",
				"--scratch",
				path.join(scratch, "scan"),
				"--jobs",
				"2",
				"--json",
			],
			{ cwd: SDK, encoding: "utf8", timeout: 240_000 },
		);
		expect(result.status).toBe(1);
		const report = JSON.parse(result.stdout) as ScanReport;
		const rows = Object.fromEntries(report.targets.map((target) => [target.name, target]));

		expect(Object.keys(rows).sort()).toEqual(["breaks", "clean"]);
		expect(rows.clean?.verdict).toBe("SAME");
		expect(rows.clean?.base.probe?.load.status).toBe("ok");
		expect(rows.clean?.head.probe?.load.status).toBe("ok");
		expect(rows.clean?.base.probe?.digest).toBeString();
		expect(rows.clean?.head.probe?.digest).toBe(rows.clean?.base.probe?.digest as string);
		expect(rows.clean?.base.tsc?.errors).toBe(0);
		expect(rows.clean?.head.tsc?.errors).toBe(0);

		expect(rows.breaks?.verdict).toBe("BREAK");
		expect(rows.breaks?.base.probe?.load.status).toBe("ok");
		expect(rows.breaks?.head.probe?.load.status).toBe("error");
		expect(rows.breaks?.reasons[0]).toContain("loads on base, fails on head");
		expect(report.summary).toEqual({ SAME: 1, BREAK: 1, WARN: 0, SKIP: 0 });
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

	it("renders the verdict table with a BREAK row and exits 1", () => {
		const result = spawnSync(
			"bun",
			[
				SCRIPT,
				"--base",
				SDK,
				"--head",
				head,
				"--targets",
				path.join(FIXTURES, "breaks"),
				"--no-fixture-tests",
				"--scratch",
				path.join(scratch, "scan-table"),
				"--jobs",
				"2",
			],
			{ cwd: SDK, encoding: "utf8", timeout: 240_000 },
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("summary: 1 BREAK, 0 WARN, 0 SAME, 0 SKIP");
		expect(result.stdout).toMatch(/^breaks\s+ok \/ ERR Error\s+0 \/ 0\s+-\s+.*BREAK/m);
		expect(result.stdout).toContain("DELETABLE");
	}, 120_000);
});

describe("judge", () => {
	const ok = (digest: string) => ({
		probe: { load: { status: "ok" as const }, digest, lint: {}, warnings: [] },
		tsc: { errors: 0, sample: [] },
	});

	it("is SAME when both sides load, compile and digest alike", () => {
		expect(judge({ kind: "provider", base: ok("a"), head: ok("a") })).toEqual({
			verdict: "SAME",
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

	it("is SAME when a provider fails identically on both sides", () => {
		const failing = {
			probe: {
				load: { status: "error" as const, errorClass: "ValidationError", message: "x" },
				lint: {},
				warnings: [],
			},
		};
		expect(judge({ kind: "provider", base: failing, head: failing }).verdict).toBe("SAME");
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
		expect(judge({ kind: "fixture-tests", base: tests(1), head: tests(1) }).verdict).toBe("SAME");
	});
});

describe("countWindowRules", () => {
	it("counts each window rule per target and skips comments", () => {
		const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "window-rules-"));
		try {
			const file = path.join(dir, "ops.ts");
			writeFileSync(
				file,
				[
					'throw new ProviderError("x", { code: "X", retryable: false });',
					'throw new ProviderError("y", { code: "Y" });',
					"// throw new ProviderError('z', { category: 'upstream_http' });",
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
				"legacy-error-options": 1,
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
