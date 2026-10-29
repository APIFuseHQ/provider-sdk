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

import {
	SDK_ERROR_REGISTRY,
	SDK_RUNTIME_OWNED_ERROR_CODES,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
} from "../../error-resolution.js";
import { ERRORS_HOIST_RULES, hoistInlineErrorRows, isSdkOwnedCode } from "../migrate-errors-hoist.js";
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
				"mappers/item.ts",
				"mappers/remote.ts",
				"operations/detail.ts",
				"operations/legacy.ts",
				"operations/list.ts",
				"operations/meta.ts",
				"operations/named.ts",
			]);
			expect(result.rewrites).toBe(8);
			const map = read("domain/errors.ts");
			expect(
				map.startsWith(
					'import { defineErrors, sdkErrors } from "@apifuse/provider-sdk/provider";\n\nexport const errors = defineErrors({\n',
				),
			).toBe(true);
			// Files are visited in path order, so detail.ts declares the shared code
			// first and its description wins. The category is the one every site
			// served: the factory call in mappers/item.ts served the default
			// (provider_error) and the list.ts site states upstream_http, so the
			// declaration keeps the default and that site is a residue.
			expect(map).toContain(
				'\tITEM_NOT_FOUND: {\n\t\tstatus: 404,\n\t\tcategory: "provider_error",\n\t\tretryable: false,\n\t\tdescription: "The detail page is gone.",\n\t},\n',
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
			// Rows referenced by name resolve to their constant, in this file or
			// another; a name that is not a row blocks its list (never an empty one).
			expect(map).toContain('\tLOCAL_ROW: {\n\t\tstatus: 400,\n\t\tcategory: "provider_error",');
			expect(map).toContain(
				'\tNAMED_GONE: {\n\t\tstatus: 410,\n\t\tcategory: "upstream_rejected",\n\t\tretryable: false,\n\t\tdescription: "Referenced by name from another file.",',
			);
			expect(map).not.toContain("BESIDE_UNRESOLVED");
			const named = read("operations/named.ts");
			expect(named).toContain(
				"\terrors: [\n\t\terrors.UPSTREAM_ERROR,\n\t\terrors.LOCAL_ROW,\n\t\terrors.NAMED_GONE,\n\t],\n\terrorCodes: [\n\t\tSESSION_EXPIRED_ROW,\n\t],\n\thandler:",
			);
			expect(named).toContain('errorCodes: [NOT_A_ROW, { code: "BESIDE_UNRESOLVED"');
			expect(named).not.toContain("errors: []");
			expect(parses("operations/named.ts")).toBe(true);
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
				'\terrors: [\n\t\terrors.ITEM_NOT_FOUND,\n\t\terrors.UPSTREAM_ERROR,\n\t\terrors.SHOP_CLOSED,\n\t\terrors["429"],\n\t\terrors.CAT_WAYS,\n\t\terrors.LOCALIZED,\n\t],\n\terrorCodes: [\n\t\t{ code: "NOT_FOUND", status: 404, description: "Registry row with the wrong retryable.", retryable: true },\n\t\t{ code: "TWO_WAYS", status: 400, description: "Declared 400 here.", retryable: false },\n\t],\n\thandler:',
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

		it("resolves every errors.CODE a rewritten throw site names: the module by import, a map in scope by name", () => {
			const mapper = read("mappers/item.ts");
			expect(mapper).toContain(
				'import { COMMON_ERRORS } from "../shared";\nimport { errors } from "../domain/errors";\n',
			);
			expect(mapper).toContain(
				'throw errors.ITEM_NOT_FOUND({ message: "No item matches the id." });',
			);
			expect(mapper).toContain(
				'throw COMMON_ERRORS.UPSTREAM_SCHEMA_ERROR({ message: "Shape drift." });',
			);
			expect(read("domain/errors.ts")).not.toContain("UPSTREAM_SCHEMA_ERROR");
			expect(mapper).toContain('throw errors.NEVER_DECLARED({ message: "Unknown." });');
			expect(parses("mappers/item.ts")).toBe(true);
			// No map in scope: the one map elsewhere that declares the code is
			// imported; a registered code no map declares is declared by value.
			const remote = read("mappers/remote.ts");
			expect(
				remote.startsWith(
					'import { COMMON_ERRORS } from "../shared";\nimport { errors } from "../domain/errors";\n',
				),
			).toBe(true);
			expect(remote).toContain("throw COMMON_ERRORS.SHARED_ONLY({");
			expect(remote).toContain("throw errors.RATE_LIMITED({");
			expect(read("domain/errors.ts")).toContain("\tRATE_LIMITED: sdkErrors.RATE_LIMITED,\n");
			expect(parses("mappers/remote.ts")).toBe(true);
		});

		it("names every refused row with its reason and notes the dropped description", () => {
			expect(table(result.residues)).toEqual([
				`${ERRORS_HOIST_RULES.outsideOperation} docs/notes.ts:1`,
				`${ERRORS_HOIST_RULES.referenceUndeclared} mappers/item.ts:6`,
				`${ERRORS_HOIST_RULES.codeConflict} operations/detail.ts:11`,
				`${ERRORS_HOIST_RULES.rowNotLiteral} operations/detail.ts:12`,
				`${ERRORS_HOIST_RULES.spreadNotATable} operations/detail.ts:21`,
				`${ERRORS_HOIST_RULES.sdkRowConflict} operations/list.ts:10`,
				`${ERRORS_HOIST_RULES.codeConflict} operations/list.ts:18`,
				`${ERRORS_HOIST_RULES.throwSiteConflict} operations/list.ts:30`,
				`${ERRORS_HOIST_RULES.throwSiteCodeConflict} operations/list.ts:35`,
				`${ERRORS_HOIST_RULES.throwSiteCodeConflict} operations/list.ts:36`,
				`${ERRORS_HOIST_RULES.entryNotARow} operations/named.ts:16`,
				`${ERRORS_HOIST_RULES.entryNotARow} operations/named.ts:22`,
				`${ERRORS_HOIST_RULES.sdkOwnedCode} rows.ts:9`,
			]);
			// One row constant named from two lists is one row: one finding, at the constant.
			expect(
				result.residues.filter((residue) => residue.ruleId === ERRORS_HOIST_RULES.sdkOwnedCode),
			).toHaveLength(1);
			// Two lists naming one constant that is not a row: one finding each list, at the list.
			expect(
				result.residues.filter((residue) => residue.ruleId === ERRORS_HOIST_RULES.entryNotARow),
			).toHaveLength(2);
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
			const site = result.residues.find(
				(residue) => residue.ruleId === ERRORS_HOIST_RULES.throwSiteConflict,
			);
			expect(site?.message).toBe(
				'Throw site of "ITEM_NOT_FOUND" serves category "upstream_http", and the declaration serves category "provider_error", retryable false; it is left as new ProviderError(...) and keeps serving its own value.',
			);
			expect(read("operations/list.ts")).toContain(
				'throw new ProviderError("No item matches the id.", {\n\t\t\t\tcode: "ITEM_NOT_FOUND",\n\t\t\t\tcategory: "upstream_http",\n\t\t\t});',
			);
			// A code declared two ways stays at every site, whichever field differs:
			// TWO_WAYS by status alone (404 against 400), CAT_WAYS by category alone
			// (a row without one against a map entry with one, same status and retryable).
			const twoWaySites = result.residues.filter(
				(residue) => residue.ruleId === ERRORS_HOIST_RULES.throwSiteCodeConflict,
			);
			expect(twoWaySites.map((residue) => residue.message)).toEqual([
				'Throw site of "TWO_WAYS": this provider declares TWO_WAYS with different contracts (operations/detail.ts:11 status 404, category "provider_error", retryable false; operations/list.ts:18 status 400, category "provider_error", retryable false), and a factory would serve one of them to every operation that reaches this site; it is left as new ProviderError(...) and keeps serving each operation\'s own row.',
				'Throw site of "CAT_WAYS": this provider declares CAT_WAYS with different contracts (operations/list.ts:19 status 400, category "provider_error", retryable false; shared.ts:7 status 400, category "input_validation", retryable false), and a factory would serve one of them to every operation that reaches this site; it is left as new ProviderError(...) and keeps serving each operation\'s own row.',
			]);
			expect(read("operations/list.ts")).toContain(
				'if (input.id === "two") throw new ProviderError("Two ways.", { code: "TWO_WAYS" });\n\t\tif (input.id === "cat") throw new ProviderError("Category ways.", { code: "CAT_WAYS" });',
			);
			expect(table(result.notes)).toEqual([
				`${ERRORS_HOIST_RULES.descriptionDropped} operations/list.ts:8`,
				`${ERRORS_HOIST_RULES.descriptionRegistry} operations/list.ts:9`,
			]);
			expect(result.notes[1]?.message).toContain(
				'the contract publishes the registry\'s description "The upstream returned an HTTP failure." instead of this row\'s "The shop answered 5xx."',
			);
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
		// One more than the apply: the dry run counts the category it fills into
		// LEGACY_TABLE's row once errors-factory (which always runs with this
		// step under apifuse migrate) has made the table a map.
		expect(result.filesChanged).toContain("shared.ts");
		expect(result.rewrites).toBe(9);
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

describe("a site the factory cannot replace", () => {
	beforeEach(() => stage("migrate-errors-hoist-subclass"));

	it("deletes the per-throw options the server would serve anyway and names every other one", () => {
		const result = hoistInlineErrorRows({ providerRoot, dryRun: false });
		expect(result.filesChanged).toEqual(["domain/errors.ts", "operations/list.ts", "upstream/sites.ts"]);
		const sites = read("upstream/sites.ts");
		// A ProviderError site goes to the factory; a ValidationError site keeps
		// its constructor and loses the options equal to what the server serves
		// without them (the declaration and the no-declaration default for BAD_ID,
		// the registry for NOT_FOUND, the SDK's own value for MISSING_SECRET).
		expect(sites).toContain('throw errors.SHOP_DOWN({ message: "The shop is down." });');
		expect(sites).toContain(
			'throw new ValidationError("The id is malformed.", { code: "BAD_ID", details: { id } });',
		);
		// A value the declaration serves but the constructor's no-declaration
		// default does not (a site reached from an auth flow reads none) stays.
		expect(sites).toContain(
			'throw new ValidationError("The shop is down.", {\n\t\tcode: "SHOP_DOWN",\n\t\tcategory: "upstream_http",\n\t\tretryable: false,\n\t\tdetails: { detail },\n\t});',
		);
		expect(sites).toContain('throw new ValidationError("No item matches.", { code: "NOT_FOUND" });');
		expect(sites).toContain(
			'throw new ProviderError(`Secret ${name} missing.`, { code: "MISSING_SECRET" });',
		);
		// A value the server would not serve, or one it cannot check, stays.
		expect(sites).toContain(
			'throw new ValidationError("The shop is down.", { code: "SHOP_DOWN", category: "upstream_http", retryable: true });',
		);
		expect(sites).toContain(
			'throw new ValidationError("The shop is down.", { code: "SHOP_DOWN", category });',
		);
		expect(sites).toContain(
			'throw new ValidationError("No item matches.", { code: "NOT_FOUND", retryable: true });',
		);
		expect(sites).toContain(
			'throw new ProviderError("Secret missing.", { code: "MISSING_SECRET", category: "provider_error" });',
		);
		expect(table(result.residues)).toEqual([
			`${ERRORS_HOIST_RULES.throwSiteConflict} upstream/sites.ts:8`,
			`${ERRORS_HOIST_RULES.throwSiteConflict} upstream/sites.ts:17`,
			`${ERRORS_HOIST_RULES.throwSiteDynamicOption} upstream/sites.ts:21`,
			`${ERRORS_HOIST_RULES.throwSiteSdkConflict} upstream/sites.ts:33`,
			`${ERRORS_HOIST_RULES.throwSiteSdkConflict} upstream/sites.ts:45`,
		]);
		expect(result.residues[0]?.message).toBe(
			'Throw site of "SHOP_DOWN" (ValidationError) states category "upstream_http" and retryable false; reached outside an operation (an auth flow, a health scenario) the server reads no declaration and would serve category "input_validation", retryable false once the option is gone, so the site is left as written and keeps serving its own value for one more release.',
		);
		expect(result.residues[3]?.message).toBe(
			'Throw site of "NOT_FOUND" (ValidationError) sets retryable true per throw, and the SDK registry (sdkErrors.NOT_FOUND, which this provider\'s rows match) serves category "upstream_http", retryable false; the per-throw value is served for one more release, so the site is left as written.',
		);
		expect(result.residues[4]?.message).toBe(
			'Throw site of "MISSING_SECRET" (ProviderError) sets category "provider_error" per throw, and the SDK runtime (which owns this code and reads no declaration for it) serves category "credential_unavailable", retryable false; the per-throw value is served for one more release, so the site is left as written.',
		);
		expect(parses("upstream/sites.ts")).toBe(true);
		const again = hoistInlineErrorRows({ providerRoot, dryRun: true });
		expect(again.rewrites).toBe(0);
		expect(again.residues.map((residue) => residue.ruleId)).toEqual(
			result.residues.map((residue) => residue.ruleId),
		);
	});

	it("dry run decides the same sites", () => {
		const dry = hoistInlineErrorRows({ providerRoot, dryRun: true });
		expect(dry.rewrites).toBe(6);
		expect(table(dry.residues)).toEqual([
			`${ERRORS_HOIST_RULES.throwSiteConflict} upstream/sites.ts:8`,
			`${ERRORS_HOIST_RULES.throwSiteConflict} upstream/sites.ts:17`,
			`${ERRORS_HOIST_RULES.throwSiteDynamicOption} upstream/sites.ts:21`,
			`${ERRORS_HOIST_RULES.throwSiteSdkConflict} upstream/sites.ts:33`,
			`${ERRORS_HOIST_RULES.throwSiteSdkConflict} upstream/sites.ts:45`,
		]);
	});
});

describe("errors-factory.yml registry lists", () => {
	it("names every registered code wherever a rule tells a registered code from a provider's, and no throw-site rewrite rule remains", () => {
		const yaml = readFileSync(
			join(import.meta.dir, "../../../scripts/codemods/errors-factory.yml"),
			"utf8",
		);
		const lists = [...yaml.matchAll(/regex: "\^\[\\"'\]\(([A-Za-z_|]+)\)\[\\"'\]\$"/g)].map(
			(match) => match[1] as string,
		);
		const registryLists = lists.filter(
			(list) => list.includes("UPSTREAM_ERROR") && list.includes("AUTH_REQUIRED") && list.includes("|"),
		);
		expect(registryLists.length).toBeGreaterThanOrEqual(1);
		for (const list of registryLists) {
			expect(list.split("|").sort()).toEqual(Object.keys(SDK_ERROR_REGISTRY).sort());
		}
		// A throw site is errors-hoist's alone: the YAML names sites, never
		// rewrites one (a factory for a code the runtime owns cannot exist, and a
		// site must be checked against every declaration of its code first).
		const ids = [...yaml.matchAll(/^id: (.*)$/gm)].map((match) => match[1]);
		expect(ids).not.toContain("errors-factory-throw-site");
		expect(ids).not.toContain("errors-factory-throw-site-bracket");
		expect(isSdkOwnedCode("MISSING_SECRET")).toBe(true);
		for (const code of [...SDK_RUNTIME_OWNED_ERROR_CODES, ...SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.keys()]) {
			if (!Object.hasOwn(SDK_ERROR_REGISTRY, code)) expect(isSdkOwnedCode(code)).toBe(true);
		}
	});
});
