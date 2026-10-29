import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

import { ERRORS_HOIST_RULES, hoistInlineErrorRows } from "../migrate-errors-hoist.js";
import type { MigrateFinding, SourceStepResult } from "../migrate-source.js";

const FIXTURES = join(import.meta.dir, "fixtures");

let providerRoot: string;

function stage(fixture: string): void {
	providerRoot = mkdtempSync(join(tmpdir(), "apifuse-errors-hoist-"));
	cpSync(join(FIXTURES, fixture), providerRoot, { recursive: true });
	for (const file of walk(providerRoot)) {
		if (file.endsWith(".ts.txt")) renameSync(file, file.slice(0, -".txt".length));
	}
}

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

describe("errors-hoist", () => {
	describe("a provider without a defineErrors map", () => {
		beforeEach(() => stage("migrate-errors-hoist"));

		let result: SourceStepResult;
		beforeEach(() => {
			result = hoistInlineErrorRows({ providerRoot, dryRun: false });
		});

		it("creates domain/errors.ts with one entry per hoisted code, registry rows as sdkErrors refs", () => {
			expect(result.filesChanged).toEqual([
				"domain/errors.ts",
				"operations/detail.ts",
				"operations/legacy.ts",
				"operations/list.ts",
				"operations/meta.ts",
			]);
			expect(result.rewrites).toBe(5);
			const map = read("domain/errors.ts");
			expect(
				map.startsWith(
					'import { defineErrors, sdkErrors } from "@apifuse/provider-sdk/provider";\n\nexport const errors = defineErrors({\n',
				),
			).toBe(true);
			// Files are visited in path order, so detail.ts declares the shared code
			// first and its description wins; the throw site in list.ts gives the category.
			expect(map).toContain(
				'\tITEM_NOT_FOUND: {\n\t\tstatus: 404,\n\t\tcategory: "upstream_http",\n\t\tretryable: false,\n\t\tdescription: "The detail page is gone.",\n\t},\n',
			);
			expect(map).toContain("\tUPSTREAM_ERROR: sdkErrors.UPSTREAM_ERROR,\n");
			expect(map).toContain(
				'\t// 410: the shop was removed; a retry returns the same page.\n\tSHOP_CLOSED: {\n\t\tstatus: 410,\n\t\tcategory: "upstream_rejected",\n\t\tretryable: false,\n\t\tdescription: "The shop is closed.",\n\t},\n',
			);
			expect(map).toContain(
				'\t"429": {\n\t\tstatus: 429,\n\t\tcategory: "provider_error",\n\t\tretryable: true,\n',
			);
			expect(map).toContain(
				'\t\tdescription: "Carries locale keys.",\n\t\tmessageKey: "errors.localized.message",\n\t\tfixKey: "errors.localized.fix",\n',
			);
			expect(map).toContain('\tLEGACY_GONE: {\n\t\tstatus: 404,\n\t\tcategory: "provider_error",');
			expect(map).toContain(
				'\tMETA_REFUSED: {\n\t\tstatus: 422,\n\t\tcategory: "upstream_rejected",',
			);
			expect(map).not.toContain("\tNOT_FOUND:");
			expect(map).not.toContain("TWO_WAYS");
			expect(map).not.toContain("DYNAMIC");
			expect(map).not.toContain("NOT_AN_OPERATION");
			expect(map.match(/ITEM_NOT_FOUND/g)).toHaveLength(1);
			expect(parses("domain/errors.ts")).toBe(true);
		});

		it("lists the references in the original order and keeps the refused rows in errorCodes", () => {
			const list = read("operations/list.ts");
			expect(list).toContain(
				'import type { ProviderContext } from "../index";\nimport { errors } from "../domain/errors";\n',
			);
			expect(list).toContain(
				'\terrors: [\n\t\terrors.ITEM_NOT_FOUND,\n\t\terrors.UPSTREAM_ERROR,\n\t\terrors.SHOP_CLOSED,\n\t\terrors["429"],\n\t\terrors.LOCALIZED,\n\t],\n\terrorCodes: [\n\t\t{ code: "NOT_FOUND", status: 404, description: "Registry row with the wrong retryable.", retryable: true },\n\t\t{ code: "TWO_WAYS", status: 400, description: "Declared 400 here.", retryable: false },\n\t],\n\thandler:',
			);
			const detail = read("operations/detail.ts");
			expect(detail).toContain(
				'\terrors: [\n\t\t...Object.values(COMMON_ERRORS),\n\t\terrors.ITEM_NOT_FOUND,\n\t],\n\terrorCodes: [\n\t\t{ code: "TWO_WAYS", status: 404, description: "Declared 404 here.", retryable: false },\n\t\t{ code: "DYNAMIC", status: STATUS, description: "Status from a constant." },\n\t],',
			);
			// A list beside a spread the step cannot read (a call) is left whole: its
			// rows may repeat a code, which errors + errorCodes may not share. A table
			// errors-factory converts (LEGACY_TABLE) would have been spread as a map.
			expect(detail).toContain(
				'\terrorCodes: [\n\t\t...LEGACY_TABLE,\n\t\t...buildCodes(),\n\t\t{ code: "BUILT_ONLY", status: 404, description: "Beside a spread the step cannot read.", retryable: false },\n\t],',
			);
			expect(read("domain/errors.ts")).not.toContain("BUILT_ONLY");
			for (const file of ["operations/list.ts", "operations/detail.ts"])
				expect(parses(file)).toBe(true);
		});

		it("hoists the pre-#238 docs block and a meta object spread into an operation", () => {
			const legacy = read("operations/legacy.ts");
			expect(legacy).toContain(
				'\t\terrors: [\n\t\t\terrors.LEGACY_GONE,\n\t\t],\n\t\tdocs: {\n\t\t\ttitleKey: "operations.legacy.docs.title",\n\t\t},\n',
			);
			expect(legacy).toContain('import { errors } from "../domain/errors";');
			const meta = read("operations/meta.ts");
			expect(meta).toContain("\terrors: [\n\t\terrors.META_REFUSED,\n\t],\n};");
			expect(meta).not.toContain("errorCodes");
			for (const file of ["operations/legacy.ts", "operations/meta.ts"])
				expect(parses(file)).toBe(true);
		});

		it("names every refused row with its reason and notes the dropped description", () => {
			expect(table(result.residues)).toEqual([
				`${ERRORS_HOIST_RULES.outsideOperation} docs/notes.ts:1`,
				`${ERRORS_HOIST_RULES.codeConflict} operations/detail.ts:11`,
				`${ERRORS_HOIST_RULES.rowNotLiteral} operations/detail.ts:12`,
				`${ERRORS_HOIST_RULES.spreadNotATable} operations/detail.ts:21`,
				`${ERRORS_HOIST_RULES.sdkRowConflict} operations/list.ts:10`,
				`${ERRORS_HOIST_RULES.codeConflict} operations/list.ts:18`,
			]);
			const conflict = result.residues.find(
				(residue) => residue.ruleId === ERRORS_HOIST_RULES.sdkRowConflict,
			);
			expect(conflict?.message).toContain("sdkErrors.NOT_FOUND: 404, retryable false");
			expect(conflict?.note).toContain("list errors.NOT_FOUND in this operation's errors");
			const twoWays = result.residues.find(
				(residue) => residue.ruleId === ERRORS_HOIST_RULES.codeConflict,
			);
			expect(twoWays?.message).toContain(
				"operations/detail.ts:11 (status 404, retryable false); operations/list.ts:18 (status 400, retryable false)",
			);
			expect(table(result.notes)).toEqual([
				`${ERRORS_HOIST_RULES.descriptionDropped} operations/list.ts:8`,
			]);
			expect(result.notes[0]?.message).toContain(
				'description from operations/detail.ts:10; this operation\'s own wording "No item matches the id." is dropped',
			);
		});

		it("is a no-op on the second run and keeps the residues", () => {
			const before = Object.fromEntries(
				walk(providerRoot).map((file) => [file, readFileSync(file, "utf8")]),
			);
			const again = hoistInlineErrorRows({ providerRoot, dryRun: false });
			expect(again.filesChanged).toEqual([]);
			expect(again.rewrites).toBe(0);
			const withoutLine = (findings: readonly MigrateFinding[]) =>
				findings.map((finding) => `${finding.ruleId} ${finding.file}`);
			expect(withoutLine(again.residues)).toEqual(withoutLine(result.residues));
			expect(
				Object.fromEntries(walk(providerRoot).map((file) => [file, readFileSync(file, "utf8")])),
			).toEqual(before);
		});
	});

	it("dry run reports the same result and writes nothing", () => {
		stage("migrate-errors-hoist");
		const before = Object.fromEntries(
			walk(providerRoot).map((file) => [file, readFileSync(file, "utf8")]),
		);
		const result = hoistInlineErrorRows({ providerRoot, dryRun: true });
		expect(result.filesChanged).toContain("domain/errors.ts");
		expect(result.rewrites).toBe(5);
		expect(existsSync(join(providerRoot, "domain/errors.ts"))).toBe(false);
		expect(
			Object.fromEntries(walk(providerRoot).map((file) => [file, readFileSync(file, "utf8")])),
		).toEqual(before);
	});

	describe("a provider with an existing map", () => {
		beforeEach(() => stage("migrate-errors-hoist-existing"));

		it("extends the map, skips a code it already declares the same way, and refuses one declared differently", () => {
			const result = hoistInlineErrorRows({ providerRoot, dryRun: false });
			expect(result.filesChanged).toEqual(["domain/errors.ts", "operations/list.ts"]);
			const map = read("domain/errors.ts");
			expect(map).toContain(
				'import { defineErrors, sdkErrors } from "@apifuse/provider-sdk/provider";',
			);
			expect(map).toContain(
				'\t\tdescription: "No item matches the id.",\n\t},\n\tUPSTREAM_ERROR: sdkErrors.UPSTREAM_ERROR,\n\tSHOP_CLOSED: {\n\t\tstatus: 409,\n\t\tcategory: "upstream_rejected",\n\t\tretryable: false,\n\t\tdescription: "The shop is closed.",\n\t},\n});\n',
			);
			const list = read("operations/list.ts");
			expect(list).toContain(
				"\terrors: [errors.ITEM_NOT_FOUND, errors.UPSTREAM_ERROR, errors.SHOP_CLOSED],\n",
			);
			expect(list).toContain(
				'\terrorCodes: [\n\t\t{ code: "ITEM_NOT_FOUND", status: 410, description: "Disagrees with the map.", retryable: false },\n\t],',
			);
			expect(list.match(/import \{ errors \}/g)).toHaveLength(1);
			expect(table(result.residues)).toEqual([
				`${ERRORS_HOIST_RULES.declaredDifferently} operations/list.ts:10`,
				`${ERRORS_HOIST_RULES.nameTaken} operations/taken.ts:5`,
			]);
			expect(read("operations/taken.ts")).toContain('errorCodes: [{ code: "TAKEN"');
			expect(map).not.toContain("TAKEN");
			for (const file of ["domain/errors.ts", "operations/list.ts"])
				expect(parses(file)).toBe(true);
		});
	});
});
