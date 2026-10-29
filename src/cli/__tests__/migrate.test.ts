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

import {
	CODEMOD_IDS,
	CODEMODS,
	formatMigrateReport,
	type MigrateReport,
	migrateExitCode,
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

function countsByCodemod(report: MigrateReport): Record<string, [string[], number, number]> {
	return Object.fromEntries(
		report.codemods.map((result) => [
			result.id,
			[[...result.filesChanged], result.rewrites, result.residues.length],
		]),
	);
}

const DRY_RUN_RESIDUES = ["errors-factory errors-factory-sdk-row-conflict operations/search.ts:7"];

describe("apifuse migrate", () => {
	it("runs the codemods in dependency order: the error-table steps before the codemods that reference their map", () => {
		expect(CODEMODS.map((codemod) => codemod.id)).toEqual([
			"errors-factory",
			"errors-hoist",
			"health-refs",
			"health-stale-window",
			"handles",
			"runtime-boundary-allow-comments",
			"schema",
			"declaration",
		]);
		expect(CODEMOD_IDS).toEqual(CODEMODS.map((codemod) => codemod.id));
	});

	it("resolves the ast-grep binary from the SDK checkout", () => {
		expect(resolveAstGrep(providerRoot)).toBe(join(SDK_ROOT, "node_modules/.bin/ast-grep"));
	});

	it("dry run reports every codemod's pending rewrites and residues without writing", async () => {
		const before = sourceFiles();
		const report = await runMigrate({ providerRoot, dryRun: true });

		expect(sourceFiles()).toEqual(before);
		expect(countsByCodemod(report)).toEqual({
			"errors-factory": [["operations/search.ts"], 4, 1],
			"errors-hoist": [["domain/errors.ts", "operations/detail.ts"], 2, 0],
			"health-refs": [["operations/search.ts"], 1, 0],
			"health-stale-window": [["index.ts", "operations/search.ts"], 3, 0],
			handles: [["index.ts"], 2, 0],
			"runtime-boundary-allow-comments": [["operations/search.ts"], 1, 0],
			schema: [["operations/detail.ts"], 1, 0],
			declaration: [[], 0, 0],
		});
		expect(residueTable(report)).toEqual(DRY_RUN_RESIDUES);
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
		expect(search).toContain(
			'"429": { status: 429, description: "Too many searches.", retryable: true }',
		);
		expect(search).toContain("errors: [...Object.values(SEARCH_ERRORS)]");
		expect(search).toContain('errors.NOT_FOUND({ message: "No item matches.", details: {\n');
		expect(search).toContain('throw errors["429"]({ message: "Too many searches." });');
		expect(search).toContain('export const AREAS = [\n\t{ code: "010", name: "Sapporo" },');
		expect(search).not.toContain("retryable: false,\n\t\t\t\tdetails");
		expect(search).not.toContain("@apifuse-allow");
		expect(search).toContain('expectedErrors: [{ error: errors.NOT_FOUND, attribute: "query" }]');
		// health-stale-window moved the per-call window onto the operation and
		// the provider declaration gained the cache capability it needs.
		expect(search).toContain(
			'descriptionKey: "operations.search.description",\n\terrors: [...Object.values(SEARCH_ERRORS)],\n\tcache: { staleIfErrorMs: 300_000 },\n\thandler:',
		);
		expect(search).toContain("{ ttlMs: 60_000 },");
		expect(search).not.toContain("staleIfErrorMs: 300_000,");

		// errors-hoist moved the inline row into domain/errors.ts and listed the
		// reference beside the table spread that errors-factory turned into a map.
		const detail = after["operations/detail.ts"] ?? "";
		expect(detail).toContain(
			"\terrors: [\n\t\t...Object.values(SEARCH_ERRORS),\n\t\terrors.ITEM_GONE,\n\t],\n\thandler:",
		);
		expect(detail).toContain('import { errors } from "../domain/errors";');
		expect(detail).not.toContain("errorCodes");
		expect(detail).toContain('itemId: z.string().describeKey("schema.itemId")');
		expect(after["domain/errors.ts"]).toBe(
			'import { defineErrors } from "@apifuse/provider-sdk/provider";\n\nexport const errors = defineErrors({\n\tITEM_GONE: {\n\t\tstatus: 410,\n\t\tcategory: "upstream_rejected",\n\t\tretryable: false,\n\t\tdescription: "The item was removed.",\n\t},\n});\n',
		);

		const index = after["index.ts"] ?? "";
		expect(index).not.toContain("fieldName");
		expect(index).not.toContain("issuedBy");
		expect(index).toContain('name: "page",\n\tschema: CursorSchema,');
		expect(index).toContain("\tstate: true,\n\tcache: true,\n});");

		expect(countsByCodemod(report)).toEqual({
			"errors-factory": [["operations/search.ts"], 4, 1],
			"errors-hoist": [["domain/errors.ts", "operations/detail.ts"], 2, 0],
			"health-refs": [["operations/search.ts"], 1, 0],
			"health-stale-window": [["index.ts", "operations/search.ts"], 3, 0],
			handles: [["index.ts"], 2, 0],
			"runtime-boundary-allow-comments": [["operations/search.ts"], 1, 0],
			schema: [["operations/detail.ts"], 1, 0],
			declaration: [[], 0, 0],
		});
		expect(residueTable(report)).toEqual(DRY_RUN_RESIDUES);
		expect(report.codemods.find((result) => result.id === "schema")?.notes).toEqual([
			{
				codemod: "schema",
				ruleId: "schema-describe-prose-on-property",
				file: "operations/detail.ts",
				line: 9,
				column: 10,
				message:
					'Raw .describe() prose on property itemId; replaced by describeKey("schema.itemId"). Add "schema.itemId": "The item id from a search result." to locales/en.json (and the other catalogs).',
			},
		]);
		expect(migrateExitCode(report)).toBe(1);

		const again = await runMigrate({ providerRoot, dryRun: true });
		expect(again.codemods.map((result) => result.rewrites)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		expect(residueTable(again)).toEqual([]);
		expect(again.clean).toBe(true);
	});

	it("--only errors-factory leaves a list with an inline row whole and reports it", async () => {
		const report = await runMigrate({ providerRoot, dryRun: false, only: ["errors-factory"] });
		const detail = readFileSync(join(providerRoot, "operations/detail.ts"), "utf8");
		expect(detail).toContain(
			'errorCodes: [\n\t\t...SEARCH_ERRORS,\n\t\t{ code: "ITEM_GONE", status: 410, description: "The item was removed.", retryable: false },\n\t],',
		);
		expect(detail).not.toContain("errors.ITEM_GONE");
		expect(residueTable(report)).toEqual([
			"errors-factory errors-factory-inline-row-hoist operations/detail.ts:16",
			"errors-factory errors-factory-sdk-row-conflict operations/search.ts:7",
		]);
		// Now the step that owns the row runs: the YAML diagnostic is dropped and
		// the row leaves the list (the table conflict was reported on the first
		// run and now sits in a map entry, outside the table rule's reach).
		const hoist = await runMigrate({
			providerRoot,
			dryRun: false,
			only: ["errors-factory", "errors-hoist"],
		});
		expect(residueTable(hoist)).toEqual([]);
		expect(readFileSync(join(providerRoot, "operations/detail.ts"), "utf8")).toContain(
			"errors.ITEM_GONE",
		);
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
		expect(text).toContain("errors-hoist                     2                   2         0");
		expect(text).toContain("health-stale-window              2                   3         0");
		expect(text).toContain("operations/search.ts:7:2 [errors-factory-sdk-row-conflict]");
		expect(text).not.toContain("[errors-factory-inline-row-hoist]");
		expect(text).not.toContain("[health-stale-window-per-call]");
		expect(text).toContain("by hand: import { defineErrors, sdkErrors }");
		expect(text).toContain("by hand: a row left in errorCodes names its reason");
		expect(text).toContain(
			'operations/detail.ts:8:10 Raw .describe() prose on property itemId; replaced by describeKey("schema.itemId").',
		);
		expect(text).toContain("run without --dry-run to apply the rewrites.");
	});

	it("rejects a failed scan instead of reading its empty output as clean", async () => {
		const broken = join(providerRoot, "broken-ast-grep");
		writeFileSync(broken, "#!/bin/sh\necho 'scanner broke' >&2\nexit 2\n", { mode: 0o755 });
		await expect(runMigrate({ providerRoot, dryRun: true, astGrep: broken })).rejects.toThrow(
			/ast-grep scan failed .*exit 2.*scanner broke/,
		);
	});

	it("fails loudly when the ast-grep binary does not exist", async () => {
		await expect(
			runMigrate({ providerRoot, dryRun: true, astGrep: join(providerRoot, "missing-ast-grep") }),
		).rejects.toThrow(/ENOENT/);
	});
});
