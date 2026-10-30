import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	countWindowRules,
	dedupeClones,
	groupRepositories,
	judge,
	normalizeRemote,
	type ProviderProbe,
	parseFixtureTestOutput,
	parseTscOutput,
	renderReport,
	type ScanReport,
	type TargetReport,
	WINDOW_RULES,
	windowSignalLabel,
} from "./bump-safety-scan.js";

const SDK = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(SDK, "scripts", "bump-safety-scan.ts");
const FIXTURES = path.join(SDK, "scripts", "__fixtures__", "bump-safety-scan");
/** One provider per window rule, named after the rule, that trips it under the SDK build under test. */
const WINDOW_FIXTURES = path.join(FIXTURES, "window");

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

function runScan(targets: string, scratchName: string, json: boolean, headBuild = head) {
	return spawnSync(
		"bun",
		[
			SCRIPT,
			"--base",
			SDK,
			"--head",
			headBuild,
			"--targets",
			targets,
			"--no-fixture-tests",
			"--scratch",
			path.join(scratch, scratchName),
			"--jobs",
			"4",
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
		expect(report.duplicateClones).toEqual([]);
		expect(report.targets.every((target) => target.staleCloneOf === undefined)).toBe(true);
		expect(report.windowRules.map((usage) => usage.rule)).toEqual(
			WINDOW_RULES.map((entry) => entry.rule),
		);
		expect(report.windowRules.map((usage) => usage.signal)).toEqual(
			WINDOW_RULES.map((entry) => windowSignalLabel(entry.signal)),
		);
		const expectedUsage = Object.fromEntries(
			countWindowRules(report.targets).map((usage) => [usage.rule, usage.sites]),
		);
		expect(
			Object.fromEntries(report.windowRules.map((usage) => [usage.rule, usage.sites])),
		).toEqual(expectedUsage);
		for (const target of report.targets) {
			for (const entry of WINDOW_RULES) {
				if ("lint" in entry.signal)
					expect(target.base.probe?.lint[entry.signal.lint]).toBeUndefined();
			}
		}
		// The four verdict fixtures leave public fields undescribed, so the missing-key row lists exactly the
		// targets whose base warning carries that tag, and the raw-prose row lists none.
		const missingKeyUsers = report.targets
			.filter((target) =>
				target.base.probe?.warnings.some((line) => line.includes("(no description)")),
			)
			.map((target) => target.name)
			.sort();
		expect(missingKeyUsers.length).toBeGreaterThan(0);
		for (const usage of report.windowRules) {
			if (usage.rule === "schema-missing-key")
				expect([...usage.providers].sort()).toEqual(missingKeyUsers);
			else expect(usage.providers).toEqual([]);
		}
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
		expect(result.stdout).toContain("read DELETABLE together with a BREAK-free verdict table");
	}, 120_000);

	it("counts every window rule from the base SDK's own signal: one fixture provider per rule trips exactly its rule", () => {
		const fixtureNames = readdirSync(WINDOW_FIXTURES).sort();
		expect(fixtureNames).toEqual(WINDOW_RULES.map((entry) => entry.rule).sort());
		const result = runScan(path.join(WINDOW_FIXTURES, "*"), "scan-window", true, SDK);
		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout) as ScanReport;
		for (const target of report.targets) {
			expect(target.base.probe?.load.status).toBe("ok");
			expect(target.base.tsc?.errors).toBe(0);
		}
		for (const usage of report.windowRules) {
			expect(usage.providers).toEqual([usage.rule]);
			expect(usage.sites).toBeGreaterThan(0);
		}
	}, 180_000);
});

describe("judge", () => {
	const ok = (digest: string) => ({
		probe: { load: { status: "ok" as const }, digest, lint: {}, warnings: [] },
		tsc: { errors: 0, sample: [], keys: [] },
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
		const head = { ...ok("a"), tsc: parseTscOutput(TSC_RED, "/p", []) };
		const judged = judge({ kind: "provider", base: ok("a"), head });
		expect(judged.verdict).toBe("BREAK");
		expect(judged.reasons[0]).toContain(
			`tsc 0 -> ${head.tsc.errors}, ${head.tsc.errors} new on head`,
		);
	});

	it("is BREAK when head has a tsc error base does not, even at the same count", () => {
		const base = { ...ok("a"), tsc: parseTscOutput(TSC_RED, "/p", []) };
		const head = { ...ok("a"), tsc: parseTscOutput(TSC_RED_ELSEWHERE, "/p", []) };
		expect(head.tsc.errors).toBe(base.tsc.errors);
		expect(head.tsc.keys.some((key) => !base.tsc.keys.includes(key))).toBe(true);
		const judged = judge({ kind: "provider", base, head });
		expect(judged.verdict).toBe("BREAK");
		const introduced = head.tsc.keys.filter((key) => !base.tsc.keys.includes(key));
		expect(judged.reasons[0]).toBe(
			`tsc ${base.tsc.errors} -> ${head.tsc.errors}, ${introduced.length} new on head: ${introduced[0]}`,
		);
	});

	it("is not BREAK when head only repeats or drops base tsc errors, or when tsc did not run on a side", () => {
		const red = { ...ok("a"), tsc: parseTscOutput(TSC_RED, "/p", []) };
		expect(judge({ kind: "provider", base: red, head: red }).verdict).toBe("SAME");
		const fewer = {
			...ok("a"),
			tsc: parseTscOutput(TSC_RED.split("\n").slice(1).join("\n"), "/p", []),
		};
		expect(fewer.tsc.errors).toBe(red.tsc.errors - 1);
		expect(judge({ kind: "provider", base: red, head: fewer }).verdict).toBe("SAME");
		const notRun = { ...ok("a"), tsc: { errors: -1, sample: ["no tsconfig"], keys: [] } };
		expect(judge({ kind: "provider", base: notRun, head: red }).verdict).toBe("SAME");
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
			duplicateClones: [],
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

describe("parseTscOutput", () => {
	it("keys each diagnostic by file, line, column and code with the per-side roots removed", () => {
		const parsed = parseTscOutput(
			[
				"/scratch/head/p/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
				"/scratch/sdk/abc/dist/types.d.ts(9,1): error TS1005: ';' expected.",
				"Found 2 errors.",
			].join("\n"),
			"/scratch/head/p",
			["/scratch/head/p", "/scratch/sdk/abc"],
		);
		expect(parsed.errors).toBe(2);
		expect(parsed.keys).toEqual([
			"dist/types.d.ts(9,1): error TS1005",
			"index.ts(3,7): error TS2322",
		]);
		expect(parsed.sample).toEqual([
			"index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
			"dist/types.d.ts(9,1): error TS1005: ';' expected.",
		]);
	});

	it("resolves a path tsc printed relative to its cwd, so the same SDK diagnostic keys alike under two per-side SHAs", () => {
		const sdkLine = (sha: string) =>
			`../../sdk/${sha}/dist/types.d.ts(9,1): error TS1005: ';' expected.`;
		const sideA = parseTscOutput(sdkLine("aaaa1111"), "/scratch/run/base/p", [
			"/scratch/run/base/p",
			"/scratch/run/sdk/aaaa1111",
		]);
		const sideB = parseTscOutput(sdkLine("bbbb2222"), "/scratch/run/head/p", [
			"/scratch/run/head/p",
			"/scratch/run/sdk/bbbb2222",
		]);
		expect(sideA.keys).toEqual(["dist/types.d.ts(9,1): error TS1005"]);
		expect(sideB.keys).toEqual(sideA.keys);
		const ok = { probe: { load: { status: "ok" as const }, digest: "d", lint: {}, warnings: [] } };
		expect(
			judge({ kind: "provider", base: { ...ok, tsc: sideA }, head: { ...ok, tsc: sideB } }).verdict,
		).toBe("SAME");
		const headWithNew = parseTscOutput(
			`${sdkLine("bbbb2222")}\nindex.ts(1,1): error TS2304: Cannot find name 'x'.`,
			"/scratch/run/head/p",
			["/scratch/run/head/p", "/scratch/run/sdk/bbbb2222"],
		);
		const judged = judge({
			kind: "provider",
			base: { ...ok, tsc: sideA },
			head: { ...ok, tsc: headWithNew },
		});
		expect(judged.verdict).toBe("BREAK");
		expect(judged.reasons[0]).toContain("index.ts(1,1): error TS2304");
		expect(
			parseTscOutput("/elsewhere/x.ts(1,1): error TS1: m", "/scratch/run/head/p", [
				"/scratch/run/head/p",
			]).keys,
		).toEqual(["/elsewhere/x.ts(1,1): error TS1"]);
	});
});

const TSC_RED = [
	"index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
	"index.ts(10,2): error TS2345: Argument of type 'A' is not assignable to parameter of type 'B'.",
	"upstream/client.ts(44,12): error TS2339: Property 'x' does not exist on type 'Y'.",
].join("\n");

/** The same count as TSC_RED, every diagnostic at another site. */
const TSC_RED_ELSEWHERE = [
	"index.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.",
	"index.ts(10,2): error TS2554: Expected 1 arguments, but got 2.",
	"upstream/other.ts(44,12): error TS2339: Property 'x' does not exist on type 'Y'.",
].join("\n");

describe("countWindowRules", () => {
	const probe = (lint: ProviderProbe["lint"], warnings: string[] = []): ProviderProbe => ({
		load: { status: "ok" },
		digest: "d",
		lint,
		warnings,
	});
	const lintRules = WINDOW_RULES.flatMap((entry) =>
		"lint" in entry.signal ? [[entry.rule, entry.signal.lint] as const] : [],
	);
	const warningRules = WINDOW_RULES.filter((entry) => !("lint" in entry.signal));
	const localeKeyWarning = (fields: Array<[string, "raw .describe() prose" | "no description"]>) =>
		`[provider-sdk] Provider "p" has ${fields.length} public schema field${fields.length === 1 ? "" : "s"} without a locale key: ${fields.map(([path, reason]) => `operations.ping.${path} (${reason})`).join(", ")}. Describe each with .describeKey("<locale key>") instead of .describe("prose") (codemod: scripts/codemods/schema.yml); the next release refuses them at defineProvider.`;

	it("counts a user per base lint diagnostic of the rule's lint id and nothing from source text, skipping stale and probe-less targets", () => {
		const lintOnA = Object.fromEntries(
			lintRules.map(([, lintId], index) => [lintId, { level: "warn" as const, count: index + 2 }]),
		);
		const fields: Array<[string, "raw .describe() prose" | "no description"]> = [
			["output.a", "raw .describe() prose"],
			["output.b", "no description"],
		];
		const targets = [
			{ name: "a", base: { probe: probe(lintOnA, [localeKeyWarning(fields)]) } },
			{
				name: "b",
				base: { probe: probe({ "allowed-hosts-required": { level: "error", count: 1 } }) },
			},
			{ name: "c", base: { probe: probe(lintOnA, [localeKeyWarning(fields)]) }, staleCloneOf: "a" },
			{ name: "d", base: {} },
		];
		const usage = Object.fromEntries(countWindowRules(targets).map((entry) => [entry.rule, entry]));
		for (const [rule, lintId] of lintRules) {
			expect(usage[rule]?.providers).toEqual(["a"]);
			expect(usage[rule]?.sites).toBe(lintOnA[lintId]?.count);
			expect(usage[rule]?.signal).toBe(`lint ${lintId}`);
		}
		for (const entry of warningRules) {
			expect(usage[entry.rule]?.providers).toEqual(["a"]);
			expect(usage[entry.rule]?.signal).toBe("defineProvider warning");
		}
	});

	it("reads each public-schema reason of the base locale-key warning as its own row, sites = fields with that tag", () => {
		const fields: Array<[string, "raw .describe() prose" | "no description"]> = [
			["output.a", "raw .describe() prose"],
			["output.b", "no description"],
			["output.c", "no description"],
			["input.value", "raw .describe() prose"],
		];
		const byReason = (reason: string) => fields.filter(([, tag]) => tag === reason).length;
		const warnings = [
			localeKeyWarning(fields),
			"[provider-sdk] some unrelated warning mentioning describe and (no description) outside the locale-key warning",
		];
		const usage = Object.fromEntries(
			countWindowRules([{ name: "p", base: { probe: probe({}, warnings) } }]).map((entry) => [
				entry.rule,
				entry,
			]),
		);
		expect(usage["schema-describe-prose"]).toMatchObject({
			providers: ["p"],
			sites: byReason("raw .describe() prose"),
		});
		expect(usage["schema-missing-key"]).toMatchObject({
			providers: ["p"],
			sites: byReason("no description"),
		});
		for (const [rule] of lintRules) expect(usage[rule]?.providers).toEqual([]);
	});

	it("keeps the two schema reasons apart: a provider with only undescribed fields is not a raw-prose user and vice versa", () => {
		const onlyMissing = countWindowRules([
			{
				name: "p",
				base: { probe: probe({}, [localeKeyWarning([["output.a", "no description"]])]) },
			},
		]);
		expect(onlyMissing.find((entry) => entry.rule === "schema-describe-prose")).toMatchObject({
			providers: [],
			sites: 0,
		});
		expect(onlyMissing.find((entry) => entry.rule === "schema-missing-key")).toMatchObject({
			providers: ["p"],
			sites: 1,
		});
		const onlyProse = countWindowRules([
			{
				name: "p",
				base: { probe: probe({}, [localeKeyWarning([["output.a", "raw .describe() prose"]])]) },
			},
		]);
		expect(onlyProse.find((entry) => entry.rule === "schema-missing-key")).toMatchObject({
			providers: [],
			sites: 0,
		});
		expect(onlyProse.find((entry) => entry.rule === "schema-describe-prose")).toMatchObject({
			providers: ["p"],
			sites: 1,
		});
	});
});

describe("normalizeRemote", () => {
	it("maps scp, ssh and https spellings of one repository to one key", () => {
		const spellings = [
			"git@github.com:APIFuseHQ/apifuse-provider-catchtable.git",
			"ssh://git@github.com/APIFuseHQ/apifuse-provider-catchtable",
			"https://github.com/APIFuseHQ/apifuse-provider-catchtable.git",
			"https://user@github.com/apifusehq/apifuse-provider-catchtable/\n",
		];
		expect(new Set(spellings.map(normalizeRemote))).toEqual(
			new Set(["github.com/apifusehq/apifuse-provider-catchtable"]),
		);
		expect(normalizeRemote("https://github.com/a/b")).not.toBe(
			normalizeRemote("https://github.com/a/c"),
		);
	});
});

describe("groupRepositories", () => {
	const clone = (remote: string, roots: string[], head = "h", committedAt = 0) => ({
		remote: normalizeRemote(remote),
		roots: [...roots].sort(),
		head,
		committedAt,
		dirty: false,
	});

	it("joins clones that share a root commit or a remote, and keeps unrelated repositories apart", () => {
		const clones = [
			clone("https://github.com/O/modu-parking.git", ["ac83"]),
			clone("https://github.com/O/modu-phone-otp.git", ["ac83"]),
			clone("git@github.com:O/catchtable.git", ["1111"]),
			clone("https://github.com/O/catchtable", ["1111"]),
			clone("https://github.com/O/careem", ["2222"]),
			clone("https://github.com/O/careem", []),
			clone("https://github.com/O/orphan", []),
			clone("https://github.com/O/grafted", ["3333", "4444"]),
			clone("https://github.com/O/grafted-fork", ["4444"]),
		];
		const groups = groupRepositories(clones);
		const same = (left: number, right: number) => groups[left] === groups[right];
		expect(same(0, 1)).toBe(true);
		expect(same(2, 3)).toBe(true);
		expect(same(4, 5)).toBe(true);
		expect(same(7, 8)).toBe(true);
		for (const [left, right] of [
			[0, 2],
			[0, 4],
			[0, 6],
			[2, 4],
			[4, 6],
			[6, 7],
			[0, 7],
		] as const) {
			expect(same(left, right)).toBe(false);
		}
		expect(new Set(groups).size).toBe(5);
	});
});

describe("dedupeClones", () => {
	const clone = (
		remote: string,
		roots: string[],
		head: string,
		committedAt: number,
		dirty = false,
	) => ({
		remote: normalizeRemote(remote),
		roots: [...roots].sort(),
		head,
		committedAt,
		dirty,
	});
	/** The real shapes: catchtable clones under several URL spellings, and the renamed modu repository (two origin URLs, one root commit). */
	const fixtures = [
		{
			name: "catchtable",
			clone: clone("https://github.com/O/catchtable.git", ["1111"], "c26a", 300),
		},
		{
			name: "catchtable-agent",
			clone: clone("git@github.com:O/catchtable.git", ["1111"], "8c14", 100),
		},
		{
			name: "catchtable-w3507-a",
			clone: clone("https://github.com/O/catchtable", ["1111"], "c26a", 300),
		},
		{
			name: "catchtable-w3507-b",
			clone: clone("https://github.com/O/catchtable", ["1111"], "8c14", 100),
		},
		{
			name: "modu-parking",
			clone: clone("https://github.com/O/apifuse-provider-modu-parking.git", ["ac83"], "5e00", 200),
		},
		{
			name: "modu-phone-otp",
			clone: clone(
				"https://github.com/O/apifuse-provider-modu-phone-otp.git",
				["ac83"],
				"ef60",
				150,
			),
		},
		{
			name: "fleet/modu-parking",
			clone: clone("https://github.com/O/apifuse-provider-modu-parking.git", ["ac83"], "3607", 400),
		},
		{
			name: "fleet/modu-phone-otp",
			clone: clone(
				"https://github.com/O/apifuse-provider-modu-phone-otp.git",
				["ac83"],
				"3607",
				400,
			),
		},
		{ name: "careem", clone: clone("https://github.com/O/careem", ["2222"], "cccc", 50) },
		{ name: "plain-copy" },
	];
	const withClone = fixtures.filter((target) => target.clone !== undefined);
	const repositoryOf = new Map<(typeof fixtures)[number], number>(
		groupRepositories(withClone.map((target) => target.clone!)).map((group, index) => [
			withClone[index]!,
			group,
		]),
	);

	it("scans one clone per repository and HEAD, keeps every HEAD, and marks the older HEADs stale", () => {
		const result = dedupeClones(fixtures);
		const byIdentity = new Map<string, string>();
		for (const target of fixtures) {
			if (!target.clone) continue;
			const key = `${repositoryOf.get(target)}@${target.clone.head}`;
			if (!byIdentity.has(key)) byIdentity.set(key, target.name);
		}
		const expectedKept = fixtures.filter(
			(target) =>
				!target.clone ||
				byIdentity.get(`${repositoryOf.get(target)}@${target.clone.head}`) === target.name,
		);
		expect(result.kept).toEqual(expectedKept);
		expect(result.duplicates.map((entry) => [entry.dropped.name, entry.keptAs.name])).toEqual(
			fixtures
				.filter((target) => !expectedKept.includes(target))
				.map((target) => [
					target.name,
					byIdentity.get(`${repositoryOf.get(target)}@${target.clone?.head}`),
				]),
		);
		const newestByRepository = new Map<number, (typeof fixtures)[number]>();
		for (const target of result.kept) {
			if (!target.clone) continue;
			const repository = repositoryOf.get(target)!;
			const best = newestByRepository.get(repository);
			if (!best || (best.clone?.committedAt ?? 0) < target.clone.committedAt)
				newestByRepository.set(repository, target);
		}
		const expectedStale = result.kept.filter((target) => {
			if (!target.clone) return false;
			const newest = newestByRepository.get(repositoryOf.get(target)!)!;
			return newest !== target && newest.clone?.head !== target.clone.head;
		});
		expect(result.stale.map((entry) => entry.clone)).toEqual(expectedStale);
		for (const entry of result.stale) {
			expect(entry.newest).toBe(newestByRepository.get(repositoryOf.get(entry.clone)!)!);
			expect(entry.newest.clone!.committedAt).toBeGreaterThan(entry.clone.clone!.committedAt);
		}
		expect(expectedStale.length).toBeGreaterThan(0);
		expect(result.duplicates.length).toBeGreaterThan(0);
	});

	it("treats the renamed modu repository as one: the old-name clone at the same HEAD is a duplicate, at an older HEAD a stale clone", () => {
		const result = dedupeClones(fixtures);
		const byName = (name: string) => fixtures.find((target) => target.name === name)!;
		expect(result.duplicates).toContainEqual({
			dropped: byName("fleet/modu-phone-otp"),
			keptAs: byName("fleet/modu-parking"),
		});
		const staleNames = result.stale.map((entry) => [entry.clone.name, entry.newest.name]);
		expect(staleNames).toContainEqual(["modu-phone-otp", "fleet/modu-parking"]);
		expect(staleNames).toContainEqual(["modu-parking", "fleet/modu-parking"]);
		expect(result.kept.map((target) => target.name)).not.toContain("fleet/modu-phone-otp");
	});

	it("never folds a dirty clone: same repository and HEAD with one dirty side scans both, both clean scans one", () => {
		const cleanA = { name: "clean-a", clone: clone("https://github.com/O/x", ["r1"], "h1", 100) };
		const cleanB = { name: "clean-b", clone: clone("https://github.com/O/x", ["r1"], "h1", 100) };
		const dirtyB = {
			name: "dirty-b",
			clone: clone("https://github.com/O/x", ["r1"], "h1", 100, true),
		};
		const dirtyFirst = {
			name: "dirty-first",
			clone: clone("https://github.com/O/x", ["r1"], "h1", 100, true),
		};
		expect(dedupeClones([cleanA, cleanB])).toEqual({
			kept: [cleanA],
			duplicates: [{ dropped: cleanB, keptAs: cleanA }],
			stale: [],
		});
		expect(dedupeClones([cleanA, dirtyB])).toEqual({
			kept: [cleanA, dirtyB],
			duplicates: [],
			stale: [],
		});
		// A dirty clone found first does not absorb a clean twin either.
		expect(dedupeClones([dirtyFirst, cleanA])).toEqual({
			kept: [dirtyFirst, cleanA],
			duplicates: [],
			stale: [],
		});
		// Dirty does not exempt a clone from the stale rule across HEADs.
		const dirtyOld = {
			name: "dirty-old",
			clone: clone("https://github.com/O/x", ["r1"], "h0", 50, true),
		};
		const result = dedupeClones([cleanA, dirtyOld]);
		expect(result.kept).toEqual([cleanA, dirtyOld]);
		expect(result.stale).toEqual([{ clone: dirtyOld, newest: cleanA }]);
	});

	it("leaves targets without a clone identity and single clones alone", () => {
		const lone = fixtures.filter((target) => !target.clone || target.name === "careem");
		expect(dedupeClones(lone)).toEqual({ kept: lone, duplicates: [], stale: [] });
	});
});

describe("renderReport stale clones", () => {
	it("shows a stale clone's verdict as non-gating and keeps it out of the summary lines", () => {
		const ok = (digest: string) => ({
			probe: { load: { status: "ok" as const }, digest, lint: {}, warnings: [] },
			tsc: { errors: 0, sample: [], keys: [] },
		});
		const row = (
			name: string,
			head: ReturnType<typeof ok>,
			staleCloneOf?: string,
		): TargetReport => {
			const target: TargetReport = {
				name,
				kind: "provider",
				path: `/clones/${name}`,
				clone: {
					remote: "github.com/o/catchtable",
					roots: ["1111"],
					head: `${name}-sha-000000`,
					committedAt: 1,
					dirty: name === "catchtable-agent",
				},
				...(staleCloneOf === undefined ? {} : { staleCloneOf }),
				base: ok("a"),
				head,
				verdict: "SKIP",
				covered: false,
				reasons: [],
			};
			return Object.assign(target, judge(target));
		};
		const targets = [row("catchtable", ok("a")), row("catchtable-agent", ok("b"), "catchtable")];
		expect(targets[1]?.verdict).toBe("BREAK");
		const rendered = renderReport({
			base: { spec: "a", dir: "/a", version: "1" },
			head: { spec: "b", dir: "/b", version: "1" },
			targetPatterns: ["/clones/*"],
			targets,
			duplicateClones: [{ path: "/clones/catchtable-w3507-a", scannedAs: "catchtable" }],
			windowRules: countWindowRules(targets),
			summary: { SAME: 1, BREAK: 0, WARN: 0, "NOT COVERED": 0, SKIP: 0 },
		});
		expect(rendered).toContain(
			"targets: 1 from /clones/* (+1 stale clone(s), not gating) (1 duplicate clone(s) scanned once)",
		);
		expect(rendered).toMatch(
			/^catchtable-agent\s+.*stale clone \(BREAK\) dirty\s+newest clone is catchtable; contract digest/m,
		);
		expect(rendered).toContain("(dirty working tree, local changes were not gated)");
		expect(rendered).toContain("summary: 0 BREAK, 0 WARN, 1 SAME, 0 NOT COVERED, 0 SKIP");
		expect(rendered).not.toMatch(/^ {2}BREAK catchtable-agent/m);
		expect(rendered).toContain(
			"stale clones: 1 target(s) share a repository with a newer clone; reported, not gating",
		);
		expect(rendered).toContain(
			`  catchtable-agent: BREAK, ${targets[1]?.clone?.head.slice(0, 12)} is older than catchtable (dirty working tree, local changes were not gated): contract digest`,
		);
		expect(rendered).toContain("  /clones/catchtable-w3507-a = catchtable");
		expect(rendered).toContain("window rules over the 1 target(s) above");
	});
});
