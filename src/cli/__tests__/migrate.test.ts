import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

import {
	CODEMOD_IDS,
	formatMigrateReport,
	migrateExitCode,
	type MigrateReport,
	resolveAstGrep,
	runMigrate,
} from "../migrate.js";

const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "migrate");
const SDK_ROOT = join(import.meta.dir, "../../..");

let providerRoot: string;

beforeEach(() => {
	providerRoot = mkdtempSync(join(tmpdir(), "apifuse-migrate-"));
	cpSync(FIXTURE_ROOT, providerRoot, { recursive: true });
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

function sourceFiles(): Record<string, string> {
	return Object.fromEntries(
		walk(providerRoot)
			.filter((file) => file.endsWith(".ts"))
			.map((file) => [file.slice(providerRoot.length + 1), readFileSync(file, "utf8")]),
	);
}

function parseErrors(fileName: string, code: string): string[] {
	const source = ts.createSourceFile(
		fileName,
		code,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const diagnostics =
		(source as ts.SourceFile & { parseDiagnostics?: ts.DiagnosticWithLocation[] })
			.parseDiagnostics ?? [];
	return diagnostics.map((diagnostic) =>
		ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
	);
}

function residueTable(report: MigrateReport): string[] {
	return report.codemods.flatMap((result) =>
		result.residues.map(
			(residue) => `${result.id} ${residue.ruleId} ${residue.file}:${residue.line}`,
		),
	);
}

describe("apifuse migrate", () => {
	it("resolves the ast-grep binary from the SDK checkout", () => {
		expect(resolveAstGrep(providerRoot)).toBe(join(SDK_ROOT, "node_modules/.bin/ast-grep"));
	});

	it("dry run reports every codemod's pending rewrites and residues without writing", async () => {
		const before = sourceFiles();
		const report = await runMigrate({ providerRoot, dryRun: true });

		expect(sourceFiles()).toEqual(before);
		expect(report.codemods.map((result) => result.id)).toEqual([...CODEMOD_IDS]);
		expect(
			Object.fromEntries(
				report.codemods.map((result) => [result.id, [result.filesChanged, result.rewrites]]),
			),
		).toEqual({
			"errors-factory": [["operations/search.ts"], 4],
			"health-refs": [["operations/search.ts"], 1],
			handles: [["index.ts"], 2],
			"runtime-boundary-allow-comments": [["operations/search.ts"], 1],
		});
		expect(residueTable(report)).toEqual([
			"errors-factory errors-factory-sdk-row-conflict operations/search.ts:7",
			"health-refs health-stale-window-per-call operations/search.ts:25",
		]);
		expect(report.clean).toBe(false);
		expect(migrateExitCode(report)).toBe(1);
	});

	it("applies every codemod in order, leaves source that parses, and keeps the residue table", async () => {
		const report = await runMigrate({ providerRoot, dryRun: false });
		const after = sourceFiles();

		for (const [file, code] of Object.entries(after)) {
			expect(parseErrors(file, code)).toEqual([]);
		}
		const search = after["operations/search.ts"] ?? "";
		expect(search).toContain("defineErrors({");
		expect(search).toContain("NOT_FOUND: sdkErrors.NOT_FOUND");
		expect(search).toContain(
			'"UPSTREAM_ERROR": { status: 502, description: "The shop answered 5xx.", retryable: false }',
		);
		expect(search).toContain('"SHOP_CLOSED": { category: "upstream_rejected", status: 409');
		expect(search).toContain("errors: [...Object.values(SEARCH_ERRORS)]");
		expect(search).toContain('errors.NOT_FOUND({ message: "No item matches.", details: {\n');
		expect(search).not.toContain("retryable: false,\n\t\t\t\tdetails");
		expect(search).toContain('expectedErrors: [{ error: errors.NOT_FOUND, attribute: "query" }]');
		expect(search).toContain(
			'"429": { status: 429, description: "Too many searches.", retryable: true }',
		);
		expect(search).toContain('throw errors["429"]({ message: "Too many searches." });');
		expect(search).toContain('export const AREAS = [\n\t{ code: "010", name: "Sapporo" },');
		expect(search).not.toContain("@apifuse-allow");
		expect(search).toContain("staleIfErrorMs: 300_000");
		const index = after["index.ts"] ?? "";
		expect(index).not.toContain("fieldName");
		expect(index).not.toContain("issuedBy");
		expect(index).toContain('name: "page",\n\tschema: CursorSchema,');

		expect(
			Object.fromEntries(report.codemods.map((result) => [result.id, result.rewrites])),
		).toEqual({
			"errors-factory": 4,
			"health-refs": 1,
			handles: 2,
			"runtime-boundary-allow-comments": 1,
		});
		expect(residueTable(report)).toEqual([
			"errors-factory errors-factory-sdk-row-conflict operations/search.ts:7",
			"health-refs health-stale-window-per-call operations/search.ts:20",
		]);
		expect(migrateExitCode(report)).toBe(1);

		const again = await runMigrate({ providerRoot, dryRun: true });
		expect(again.codemods.map((result) => result.rewrites)).toEqual([0, 0, 0, 0]);
		expect(residueTable(again)).toEqual([
			"health-refs health-stale-window-per-call operations/search.ts:20",
		]);
	});

	it("--only runs the named codemod and is clean once nothing is left", async () => {
		const report = await runMigrate({ providerRoot, dryRun: false, only: ["handles"] });
		expect(report.codemods.map((result) => result.id)).toEqual(["handles"]);
		expect(report.codemods[0]?.filesChanged).toEqual(["index.ts"]);
		expect(migrateExitCode(report)).toBe(0);

		const again = await runMigrate({ providerRoot, dryRun: true, only: ["handles"] });
		expect(again.clean).toBe(true);
		expect(migrateExitCode(again)).toBe(0);
	});

	it("prints one row per codemod and each residue with file:line and the manual step", async () => {
		const report = await runMigrate({ providerRoot, dryRun: true });
		const text = formatMigrateReport(report);
		expect(text).toContain(
			"codemod                          files would change  rewrites  residues",
		);
		expect(text).toContain("errors-factory                   1                   4         1");
		expect(text).toContain("operations/search.ts:7:2 [errors-factory-sdk-row-conflict]");
		expect(text).toContain("operations/search.ts:25:21 [health-stale-window-per-call]");
		expect(text).toContain("by hand: import { defineErrors, sdkErrors }");
		expect(text).toContain("run without --dry-run to apply the rewrites.");
	});

	it("fails loudly when the ast-grep binary does not exist", async () => {
		await expect(
			runMigrate({ providerRoot, dryRun: true, astGrep: join(providerRoot, "missing-ast-grep") }),
		).rejects.toThrow(/ENOENT/);
	});
});
