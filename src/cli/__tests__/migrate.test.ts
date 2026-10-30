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

import { resolveProviderErrorContract } from "../../error-resolution.js";
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

const DRY_RUN_RESIDUES = [
	"errors-factory errors-factory-throw-site-dynamic-option mappers/item.ts:24",
	"errors-factory errors-factory-sdk-row-conflict operations/search.ts:7",
	"errors-factory errors-factory-throw-site-registry-conflict operations/search.ts:33",
	"errors-hoist errors-hoist-throw-site-row-unknown mappers/item.ts:8",
	"errors-hoist errors-hoist-outside-operation operations/booking.ts:7",
	"errors-hoist errors-hoist-array-spread-in-map operations/booking.ts:15",
	"errors-hoist errors-hoist-array-spread-in-map operations/booking.ts:20",
	"errors-hoist errors-hoist-spread-not-a-table operations/booking.ts:26",
	"errors-hoist errors-hoist-map-spread-in-array operations/booking.ts:26",
	"errors-hoist errors-hoist-throw-site-undeclared operations/booking.ts:28",
	"errors-hoist errors-hoist-spread-not-a-table operations/checkout.ts:14",
	"errors-hoist errors-hoist-throw-site-undeclared operations/checkout.ts:17",
	"errors-hoist errors-hoist-map-spread-in-array operations/legal.ts:10",
	"errors-hoist errors-hoist-map-spread-in-array operations/legal.ts:10",
	"errors-hoist errors-hoist-outside-operation operations/legal.ts:13",
	"errors-hoist errors-hoist-list-not-readable operations/legal.ts:22",
	"errors-hoist errors-hoist-list-not-readable operations/legal.ts:28",
	"errors-hoist errors-hoist-throw-site-code-conflict operations/legal.ts:31",
	"errors-hoist errors-hoist-throw-site-undeclared operations/own.ts:19",
	"errors-hoist errors-hoist-sdk-entry-conflict operations/search.ts:7",
	"errors-hoist errors-hoist-throw-site-row-unknown operations/search.ts:40",
	"errors-hoist errors-hoist-spread-not-a-table operations/statusless.ts:8",
	"errors-hoist errors-hoist-throw-site-row-unknown upstream/client.ts:6",
	"errors-hoist errors-hoist-throw-site-undeclared upstream/client.ts:7",
	"errors-hoist errors-hoist-throw-site-row-unknown upstream/client.ts:8",
	"errors-hoist errors-hoist-throw-site-dynamic-code upstream/raise.ts:8",
	"errors-hoist errors-hoist-throw-site-dynamic-code upstream/raise.ts:16",
	"errors-hoist errors-hoist-throw-site-dynamic-option upstream/raise.ts:20",
	"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:17",
	"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:25",
	"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:37",
	"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:41",
	"errors-hoist errors-hoist-throw-site-code-conflict upstream/sites.ts:49",
	"errors-hoist errors-hoist-throw-site-row-conflict upstream/sites.ts:53",
	"errors-hoist errors-hoist-throw-site-shadowed upstream/sites.ts:58",
	"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:63",
	"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:72",
	"errors-hoist errors-hoist-throw-site-sdk-conflict upstream/sites.ts:84",
	"errors-hoist errors-hoist-throw-site-code-conflict upstream/sites.ts:88",
];

// The errors-hoist findings a dry run and an apply share, line numbers aside
// (the apply's rewrites move the lines): one decision per site, made from the
// same unrewritten sites either way.
function hoistOf(report: MigrateReport) {
	return report.codemods.find((result) => result.id === "errors-hoist");
}

function hoistDecisions(report: MigrateReport): string[] {
	const hoist = hoistOf(report);
	return [
		...(hoist?.residues ?? []).map((item) => `residue ${item.ruleId} ${item.file}`),
		...(hoist?.notes ?? []).map((item) => `note ${item.ruleId} ${item.file} ${item.message}`),
	];
}

describe("apifuse migrate", () => {
	it("runs the codemods in dependency order: the error-table steps before the codemods that reference their map", () => {
		expect(CODEMODS.map((codemod) => codemod.id)).toEqual([
			"errors-factory",
			"health-refs",
			"errors-hoist",
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
			"errors-factory": [
				[
					"operations/booking.ts",
					"operations/legal.ts",
					"operations/own.ts",
					"operations/parcel.ts",
					"operations/search.ts",
				],
				5,
				3,
			],
			"errors-hoist": [
				[
					"domain/errors.ts",
					"mappers/item.ts",
					"operations/booking.ts",
					"operations/detail.ts",
					"operations/legal.ts",
					"operations/named.ts",
					"operations/own.ts",
					"operations/parcel.ts",
					"operations/search.ts",
					"operations/whole.ts",
					"upstream/dispatch.ts",
					"upstream/sites.ts",
				],
				22,
				36,
			],
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

		// The dry run decides every throw site and declaration the way the apply
		// does: errors-factory writes nothing under --dry-run, and errors-hoist
		// reads the sites it leaves unrewritten either way.
		const applied = await runMigrate({ providerRoot, dryRun: false });
		expect(hoistDecisions(applied)).toEqual(hoistDecisions(report));
		expect(countsByCodemod(applied)).toEqual(countsByCodemod(report));
	});

	it("applies every codemod in order, leaves source that parses, and keeps the residue table", async () => {
		const before = sourceFiles();
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
		// A converted table's provider rows state no category: errors-hoist fills
		// the one the throw sites served (the serve default when none states one),
		// and `retryable: false` where the category's default would flip it.
		expect(search).toContain(
			'"429": { category: "provider_error", status: 429, description: "Too many searches.", retryable: true }',
		);
		expect(search).toContain(
			'"SHOP_SLOW": { category: "timeout", retryable: false, status: 502, description: "The shop timed out." }',
		);
		expect(search).toContain(
			'"PAGE_CHANGED": { category: "provider_error", status: 502, description: "The page changed.", retryable: false }',
		);
		expect(search).toContain("\terrors: [\n\t\t...Object.values(SEARCH_ERRORS),\n\t],\n");
		// A registered code's site is not rewritten to the registry factory while
		// a list this run cannot read (legal.ts's call, detail.ts's spread) may
		// hold a row of that code that departs from the registry; it is named.
		expect(search).toContain(
			'throw new ProviderError("No item matches.", {\n\t\t\t\tcode: "NOT_FOUND",\n\t\t\t\tretryable: false,\n\t\t\t\tdetails: {\n',
		);
		const rowUnknown = hoistOf(report)?.residues.filter(
			(residue) => residue.ruleId === "errors-hoist-throw-site-row-unknown",
		);
		expect(rowUnknown?.map((residue) => `${residue.file}:${residue.line}`)).toEqual([
			"mappers/item.ts:8",
			"operations/search.ts:33",
			"upstream/client.ts:6",
			"upstream/client.ts:8",
		]);
		expect(rowUnknown?.[1]?.message).toBe(
			'Throw site of "NOT_FOUND": an errorCodes list of this provider holds rows this run cannot read (a list named above), and such a row of NOT_FOUND may state a status or retryable that differs from the SDK registry (sdkErrors.NOT_FOUND: 404, retryable false); errors.NOT_FOUND(...) would serve the registry, so the site is left as new ProviderError(...).',
		);
		expect(search).toContain('throw SEARCH_ERRORS["429"]({ message: "Too many searches." });');
		expect(search).toContain('export const AREAS = [\n\t{ code: "010", name: "Sapporo" },');
		expect(search).not.toContain("@apifuse-allow");
		// health-stale-window moved the per-call window onto the operation and
		// the provider declaration gained the cache capability it needs.
		expect(search).toContain(
			'descriptionKey: "operations.search.description",\n\terrors: [\n\t\t...Object.values(SEARCH_ERRORS),\n\t],\n\tcache: { staleIfErrorMs: 300_000 },\n\thandler:',
		);
		// A spread of a table whose rows state no status (rule 3 never converts
		// it) is left in errorCodes with a residue, never spread from an array.
		expect(after["operations/statusless.ts"]).toBe(before["operations/statusless.ts"]);
		// A list that only spreads a map references no errors.CODE: no import.
		expect(search).not.toContain("domain/errors");
		// errorCodes naming a table whole becomes errors: Object.values(T).
		expect(after["operations/whole.ts"]).toContain("\terrors: Object.values(SEARCH_ERRORS),\n");
		expect(search).toContain("{ ttlMs: 60_000 },");
		expect(search).not.toContain("staleIfErrorMs: 300_000,");

		// errors-hoist moved the inline row into domain/errors.ts and listed the
		// reference beside the table spread that errors-factory turned into a map.
		const detail = after["operations/detail.ts"] ?? "";
		expect(detail).toContain(
			"\terrors: [\n\t\t...Object.values(SEARCH_ERRORS),\n\t\terrors.ITEM_GONE,\n\t\terrors.SHOP_DOWN,\n\t\terrors.SHOP_BUSY,\n\t\terrors.SLOT_GONE,\n\t\terrors.SLOT_HELD,\n\t\terrors.PAGE_CHANGED,\n\t],\n\thandler:",
		);
		expect(detail).toContain('import { errors } from "../domain/errors";');
		expect(detail).not.toContain("errorCodes");
		expect(detail).toContain('itemId: z.string().describeKey("schema.itemId")');
		// A hoisted row's category is the one every throw site served: SHOP_DOWN's
		// two sites both state upstream_http; SHOP_BUSY's sites state none (the
		// serve default); SLOT_GONE's and SLOT_HELD's sites disagree (two say
		// timeout, one says nothing), so the declaration keeps the status default
		// and each site that served something else is a residue, never a majority.
		expect(after["domain/errors.ts"]).toBe(
			'import { defineErrors, sdkErrors } from "@apifuse/provider-sdk/provider";\n\nexport const errors = defineErrors({\n\tITEM_GONE: {\n\t\tstatus: 410,\n\t\tcategory: "upstream_rejected",\n\t\tretryable: false,\n\t\tdescription: "The item was removed.",\n\t},\n\tSHOP_DOWN: {\n\t\tstatus: 502,\n\t\tcategory: "upstream_http",\n\t\tretryable: false,\n\t\tdescription: "The shop is down.",\n\t},\n\tSHOP_BUSY: {\n\t\tstatus: 503,\n\t\tcategory: "provider_error",\n\t\tretryable: false,\n\t\tdescription: "The shop is busy.",\n\t},\n\tSLOT_GONE: {\n\t\tstatus: 410,\n\t\tcategory: "upstream_rejected",\n\t\tretryable: false,\n\t\tdescription: "The slot is gone.",\n\t},\n\tSLOT_HELD: {\n\t\tstatus: 409,\n\t\tcategory: "upstream_rejected",\n\t\tretryable: false,\n\t\tdescription: "The slot is held.",\n\t},\n\tPAGE_CHANGED: {\n\t\tstatus: 502,\n\t\tcategory: "provider_error",\n\t\tretryable: true,\n\t\tdescription: "The page changed.",\n\t},\n\tUPSTREAM_ERROR: sdkErrors.UPSTREAM_ERROR,\n});\n',
		);
		// The sites errors-factory left (a literal per-throw category/retryable on
		// a provider-owned code): rewritten where the declaration serves the same
		// value, left with a residue where it does not, so nothing served changes.
		const sites = after["upstream/sites.ts"] ?? "";
		expect(sites).toContain(
			'import { SEARCH_ERRORS } from "../operations/search";\nimport { errors } from "../domain/errors";\n',
		);
		expect(sites).toContain(
			'throw errors.SHOP_DOWN({ message: "The shop is down.", details: { detail } });',
		);
		expect(sites).toContain('throw errors.SHOP_DOWN({ message: "The shop is still down." });');
		// retryable: true against a row that says false (B2) stays and is named.
		expect(sites).toContain(
			'throw new ProviderError("The shop is busy.", { code: "SHOP_BUSY", retryable: true });',
		);
		// The server resolves a TransportError without the declaration: the site
		// neither votes nor is reported.
		expect(sites).toContain(
			'throw new TransportError("The shop did not answer.", { code: "SHOP_BUSY" });',
		);
		// A code declared with two contracts (detail's row retryable true, the
		// search table retryable false): a factory would carry one of them to every
		// operation, so the bare site stays and names both.
		expect(sites).toContain(
			'throw new ProviderError("The page changed.", { code: "PAGE_CHANGED" });',
		);
		const codeConflict = hoistOf(report)?.residues.find(
			(residue) =>
				residue.ruleId === "errors-hoist-throw-site-code-conflict" &&
				residue.file === "upstream/sites.ts",
		);
		expect(codeConflict?.message).toBe(
			'Throw site of "PAGE_CHANGED": this provider declares PAGE_CHANGED with different contracts (operations/detail.ts:21 status 502, category "provider_error", retryable true; operations/search.ts:5 status 502, category "provider_error", retryable false), and a factory would serve one of them to every operation that reaches this site; it is left as new ProviderError(...) and keeps serving each operation\'s own row.',
		);
		expect(sites).toContain(
			'throw new ProviderError("The slot is gone.", { code: "SLOT_GONE", category: "input_validation" });',
		);
		expect(sites).toContain('throw errors.SLOT_GONE({ message: "The slot is gone." });');
		expect(sites).toContain('throw SEARCH_ERRORS.SHOP_SLOW({ message: "The shop timed out." });');
		expect(sites).toContain(
			'throw new ProviderError("The slot is held.", { code: "SLOT_HELD", category: "timeout" });',
		);
		expect(sites).toContain('throw errors.SLOT_HELD({ message: "The slot is held by someone." });');
		// A registered code's site serves the provider's own row for it where that
		// row departs from the registry (the 502/false UPSTREAM_ERROR table row);
		// errors.UPSTREAM_ERROR would serve the registry, so the site stays, named.
		expect(sites).toContain(
			'throw new ProviderError("The shop answered 5xx.", { code: "UPSTREAM_ERROR" });',
		);
		// A site under a local `errors` binding cannot reach the import: left, named.
		expect(sites).toContain(
			'if (errors.length > 0) throw new ProviderError("The item was removed.", { code: "ITEM_GONE" });',
		);
		// A site the factory cannot replace keeps its per-throw category/retryable
		// here: a site reached outside an operation reads no declaration and would
		// serve the ValidationError default (the migrate-errors-hoist-subclass
		// fixture covers the strip). A code the SDK runtime owns reads no
		// declaration anywhere, so its site is stripped.
		expect(sites).toContain(
			'throw new ValidationError("The shop is down.", {\n\t\tcode: "SHOP_DOWN",\n\t\tcategory: "upstream_http",\n\t\tretryable: false,\n\t\tdetails: { detail },\n\t});',
		);
		const noDeclaration = hoistOf(report)?.residues.find(
			(residue) => residue.file === "upstream/sites.ts" && residue.line === 63,
		);
		expect(noDeclaration?.ruleId).toBe("errors-hoist-throw-site-conflict");
		expect(noDeclaration?.message).toContain(
			'reached outside an operation (an auth flow, a health scenario) the server reads no declaration and would serve category "input_validation", retryable false',
		);
		expect(sites).toContain(
			'throw new ValidationError("The shop is down.", { code: "SHOP_DOWN", category: "upstream_http", retryable: true });',
		);
		expect(sites).toContain(
			'throw new ProviderError(`Secret ${name} missing.`, { code: "MISSING_SECRET" });',
		);
		expect(sites).toContain(
			'throw new ProviderError("Secret missing.", { code: "MISSING_SECRET", category: "provider_error" });',
		);
		// The served contract is the same with and without the stripped options:
		// the SDK's own resolution over what each site reaches (SHOP_DOWN's hoisted
		// declaration; nothing for the runtime-owned MISSING_SECRET, whose serve
		// branch defaults to credential_unavailable / false).
		// A provider throw carries no per-throw contract any more (`new
		// ProviderError` refuses one), so the declaration alone is what the
		// stripped site serves.
		const shopDown = { status: 502, category: "upstream_http", retryable: false } as const;
		expect(
			resolveProviderErrorContract({ code: "SHOP_DOWN", declaration: shopDown, sdkContract: {} }),
		).toEqual({ status: 502, category: "upstream_http", retryable: false });
		expect(
			resolveProviderErrorContract({
				code: "MISSING_SECRET",
				declaration: undefined,
				sdkContract: {},
			}),
		).toEqual({ status: 400, category: undefined, retryable: undefined });
		const hoist = hoistOf(report);
		const sdkConflict = hoist?.residues.find(
			(residue) => residue.ruleId === "errors-hoist-throw-site-sdk-conflict",
		);
		expect(sdkConflict?.message).toBe(
			'Throw site of "MISSING_SECRET" (ProviderError) sets category "provider_error" per throw, and the SDK runtime (which owns this code and reads no declaration for it) serves category "credential_unavailable", retryable false; the per-throw value is served for one more release, so the site is left as written.',
		);
		const retrying = hoist?.residues.find(
			(residue) => residue.file === "upstream/sites.ts" && residue.line === 72,
		);
		expect(retrying?.message).toBe(
			'Throw site of "SHOP_DOWN" serves category "upstream_http" and retryable true, and the declaration serves category "upstream_http", retryable false; it is left as new ValidationError(...) and keeps serving its own value for one more release.',
		);
		// statusless.ts spreads rows this step cannot read, so a legacy row of any
		// code may stay in an operation: a registry-equal ValidationError site
		// keeps its options (that row would serve once they are gone) and is named.
		expect(sites).toContain(
			'throw new ValidationError("No item matches.", { code: "NOT_FOUND", category: "upstream_http", retryable: false });',
		);
		const leftover = hoist?.residues.find(
			(residue) => residue.file === "upstream/sites.ts" && residue.line === 88,
		);
		expect(leftover?.ruleId).toBe("errors-hoist-throw-site-code-conflict");
		expect(leftover?.message).toContain(
			'Throw site of "NOT_FOUND" (ValidationError): a legacy errorCodes row of NOT_FOUND may stay in an operation this run cannot move',
		);
		// A file whose own table is named `errors` (rule 3 makes it a map): its
		// sites of a code that map declares are rewritten to it; a site of a module
		// code cannot import the provider map under the taken name and is named.
		// The local map is never taken for the provider's (it is not exported).
		const own = after["operations/own.ts"] ?? "";
		expect(own).toContain(
			'throw errors.OWN_TOKEN({ message: "The own token is stale.", fix: "Start the search again." });',
		);
		expect(own).toContain(
			'throw new ProviderError("The item was removed.", { code: "ITEM_GONE" });',
		);
		expect(own).not.toContain("domain/errors");
		expect(after["domain/errors.ts"]).not.toContain("OWN_TOKEN");
		const ownSite = hoist?.residues.find((residue) => residue.file === "operations/own.ts");
		expect(ownSite?.message).toBe(
			'Throw site of "ITEM_GONE": this file binds its own `errors`, which does not declare ITEM_GONE, so the provider map cannot be imported under that name here; it is left as new ProviderError(...).',
		);
		expect(hoist?.notes.map((note) => `${note.ruleId} ${note.file} ${note.message}`)).toEqual([
			'errors-hoist-category-from-sites operations/detail.ts Code "SHOP_DOWN" is declared with category "upstream_http", the value its 4 throw sites served.',
			'errors-hoist-category-from-sites operations/legal.ts Code "LEGAL_SOURCE_UNSUPPORTED" is declared with category "input_validation", the value its 1 throw site served.',
			'errors-hoist-category-from-sites operations/own.ts Code "OWN_TOKEN" is declared with category "input_validation", the value its 1 throw site served.',
			'errors-hoist-category-from-sites operations/parcel.ts Code "PARCEL_LOST" is declared with category "upstream_http", the value its 1 throw site served.',
			'errors-hoist-category-from-sites operations/search.ts Code "SHOP_SLOW" is declared with category "timeout", the value its 1 throw site served.',
			'errors-hoist-description-registry operations/statusless.ts Code "NO_DATA" is declared as sdkErrors.NO_DATA; the contract publishes the registry\'s description "The upstream returned no data for the request." instead of this row\'s "No rows; the SDK serves the status.".',
			'errors-hoist-description-registry rows.ts Code "UPSTREAM_ERROR" is declared as sdkErrors.UPSTREAM_ERROR; the contract publishes the registry\'s description "The upstream returned an HTTP failure." instead of this row\'s "The shop answered 5xx.".',
		]);
		const rowConflict = hoist?.residues.find(
			(residue) => residue.ruleId === "errors-hoist-throw-site-row-conflict",
		);
		expect(rowConflict?.message).toContain(
			"serves this provider's own row for UPSTREAM_ERROR, which states a status, retryable or locale key that differs from the SDK registry (sdkErrors.UPSTREAM_ERROR: 502, retryable true)",
		);
		const busy = hoist?.residues.find((residue) => residue.file === "upstream/sites.ts");
		expect(busy?.message).toBe(
			'Throw site of "SHOP_BUSY" serves retryable true, and the declaration serves category "provider_error", retryable false; it is left as new ProviderError(...) and keeps serving its own value.',
		);
		// A list of rows referenced by name (another file) becomes references,
		// never an empty list.
		expect(after["operations/named.ts"]).toContain(
			"\terrors: [\n\t\terrors.UPSTREAM_ERROR,\n\t\terrors.ITEM_GONE,\n\t],\n\thandler:",
		);
		expect(after["operations/named.ts"]).not.toContain("errors: []");
		// A throw site whose per-throw retryable/category contradicts the registry
		// keeps its legacy form and is a residue every run.
		expect(search).toContain(
			'throw new ProviderError("The shop changed its auth page.", {\n\t\t\t\tcode: "UPSTREAM_ERROR",\n\t\t\t\tcategory: "upstream_schema_drift",\n\t\t\t\tretryable: false,\n\t\t\t});',
		);
		// Tests and nested { code, status } objects are not error tables.
		expect(after["__tests__/index.test.ts"]).toBe(before["__tests__/index.test.ts"]);
		expect(after["health/cases.ts"]).toBe(before["health/cases.ts"]);
		expect(after["health/cases.ts"]).not.toContain("defineErrors");

		const index = after["index.ts"] ?? "";
		expect(index).not.toContain("fieldName");
		expect(index).not.toContain("issuedBy");
		expect(index).toContain('name: "page",\n\tschema: CursorSchema,');
		expect(index).toContain("\tstate: true,\n\tcache: true,\n});");

		expect(countsByCodemod(report)).toEqual({
			"errors-factory": [
				[
					"operations/booking.ts",
					"operations/legal.ts",
					"operations/own.ts",
					"operations/parcel.ts",
					"operations/search.ts",
				],
				5,
				3,
			],
			"errors-hoist": [
				[
					"domain/errors.ts",
					"mappers/item.ts",
					"operations/booking.ts",
					"operations/detail.ts",
					"operations/legal.ts",
					"operations/named.ts",
					"operations/own.ts",
					"operations/parcel.ts",
					"operations/search.ts",
					"operations/whole.ts",
					"upstream/dispatch.ts",
					"upstream/sites.ts",
				],
				22,
				36,
			],
			"health-refs": [["operations/search.ts"], 1, 0],
			"health-stale-window": [["index.ts", "operations/search.ts"], 3, 0],
			handles: [["index.ts"], 2, 0],
			"runtime-boundary-allow-comments": [["operations/search.ts"], 1, 0],
			schema: [["operations/detail.ts"], 1, 0],
			declaration: [[], 0, 0],
		});
		// The table above the throw site collapsed to one line, so the residue
		// sits six lines higher than in the dry run.
		expect(residueTable(report)).toEqual([
			"errors-factory errors-factory-throw-site-dynamic-option mappers/item.ts:24",
			"errors-factory errors-factory-sdk-row-conflict operations/search.ts:7",
			"errors-factory errors-factory-throw-site-registry-conflict operations/search.ts:26",
			"errors-hoist errors-hoist-throw-site-row-unknown mappers/item.ts:8",
			"errors-hoist errors-hoist-outside-operation operations/booking.ts:7",
			"errors-hoist errors-hoist-array-spread-in-map operations/booking.ts:15",
			"errors-hoist errors-hoist-array-spread-in-map operations/booking.ts:19",
			"errors-hoist errors-hoist-spread-not-a-table operations/booking.ts:23",
			"errors-hoist errors-hoist-map-spread-in-array operations/booking.ts:23",
			"errors-hoist errors-hoist-throw-site-undeclared operations/booking.ts:25",
			"errors-hoist errors-hoist-spread-not-a-table operations/checkout.ts:14",
			"errors-hoist errors-hoist-throw-site-undeclared operations/checkout.ts:17",
			"errors-hoist errors-hoist-map-spread-in-array operations/legal.ts:8",
			"errors-hoist errors-hoist-map-spread-in-array operations/legal.ts:8",
			"errors-hoist errors-hoist-outside-operation operations/legal.ts:11",
			"errors-hoist errors-hoist-list-not-readable operations/legal.ts:20",
			"errors-hoist errors-hoist-list-not-readable operations/legal.ts:26",
			"errors-hoist errors-hoist-throw-site-code-conflict operations/legal.ts:29",
			"errors-hoist errors-hoist-throw-site-undeclared operations/own.ts:17",
			"errors-hoist errors-hoist-sdk-entry-conflict operations/search.ts:5",
			"errors-hoist errors-hoist-throw-site-row-unknown operations/search.ts:33",
			"errors-hoist errors-hoist-spread-not-a-table operations/statusless.ts:8",
			"errors-hoist errors-hoist-throw-site-row-unknown upstream/client.ts:6",
			"errors-hoist errors-hoist-throw-site-undeclared upstream/client.ts:7",
			"errors-hoist errors-hoist-throw-site-row-unknown upstream/client.ts:8",
			"errors-hoist errors-hoist-throw-site-dynamic-code upstream/raise.ts:8",
			"errors-hoist errors-hoist-throw-site-dynamic-code upstream/raise.ts:16",
			"errors-hoist errors-hoist-throw-site-dynamic-option upstream/raise.ts:20",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:17",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:25",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:37",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:41",
			"errors-hoist errors-hoist-throw-site-code-conflict upstream/sites.ts:49",
			"errors-hoist errors-hoist-throw-site-row-conflict upstream/sites.ts:53",
			"errors-hoist errors-hoist-throw-site-shadowed upstream/sites.ts:58",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:63",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:72",
			"errors-hoist errors-hoist-throw-site-sdk-conflict upstream/sites.ts:84",
			"errors-hoist errors-hoist-throw-site-code-conflict upstream/sites.ts:88",
		]);
		// A table rule 3 does not convert (`[...] satisfies T[]`) stays an array,
		// so it is never a map: the site of its code is not rewritten to
		// TABLE.CODE(...) (a call on an array) and is named; the list naming the
		// table whole is named; the file is byte-identical.
		expect(after["operations/checkout.ts"]).toBe(before["operations/checkout.ts"]);
		expect(after["operations/checkout.ts"]).not.toContain("checkoutErrorCodes.");
		// A table spreading a property access is one rule 3 leaves an array (a
		// map object cannot take an array's rows by spread); a table spreading a
		// plain name rule 3 cannot resolve is converted, and the spread of an
		// array into that map is named in the dry run and the apply alike.
		const booking = after["operations/booking.ts"] ?? "";
		expect(booking).toContain(
			"const BOOKING_FLOW_ERRORS: OperationErrorCode[] = [\n\t...BOOKING_DOCS.errorCodes,\n",
		);
		expect(booking).toContain(
			'const CONFIRM_ERRORS = defineErrors({ ...QUOTE_ERRORS, "CONFIRM_REJECTED": {',
		);
		const arraySpreads = hoistOf(report)?.residues.filter(
			(residue) => residue.ruleId === "errors-hoist-array-spread-in-map",
		);
		expect(arraySpreads?.map((residue) => `${residue.line} ${residue.message}`)).toEqual([
			"15 This table spreads BOOKING_DOCS.errorCodes, which is not the name of a defineErrors map, so errors-factory leaves the table an array (a map object cannot take an array's rows by spread).",
			"19 ...QUOTE_ERRORS spreads an array (not a defineErrors map) into the map object errors-factory makes of this table; the array's indices become keys and defineErrors refuses them at import, so the provider does not load until this is fixed.",
		]);
		// An errorCodes this step cannot read (a property access, a call) is
		// named, and a subclass site of a code such a list may serve keeps its
		// options (the legacy row there would serve once they are gone).
		const legal = after["operations/legal.ts"] ?? "";
		expect(legal).toContain(
			'export const LEGAL_DOCS = {\n\tsearch: { titleKey: "operations.legal.docs.title", errorCodes: [...LEGAL_SEARCH_ROWS] },\n};',
		);
		expect(legal).toContain("\terrorCodes: LEGAL_DOCS.search.errorCodes,\n");
		expect(legal).toContain("\terrorCodes: legalRows(),\n");
		expect(legal).toContain(
			'throw new ValidationError("The legal source is not supported.", {\n\t\t\t\tcode: "LEGAL_SOURCE_UNSUPPORTED",\n\t\t\t\tcategory: "input_validation",\n\t\t\t\tretryable: false,\n\t\t\t});',
		);
		const unreadable = hoistOf(report)?.residues.filter(
			(residue) => residue.ruleId === "errors-hoist-list-not-readable",
		);
		expect(unreadable?.map((residue) => residue.message)).toEqual([
			"errorCodes is a property access, whose rows this step cannot read; the list is left in place, and every throw site whose per-throw options this list's rows may serve keeps them.",
			"errorCodes is a call, whose rows this step cannot read; the list is left in place, and every throw site whose per-throw options this list's rows may serve keeps them.",
		]);
		// A map (one rule 3 made of a table this run, or SEARCH_ERRORS) spread
		// into a plain array throws at import: each such spread is named with
		// the fix, since the provider will not load until it is applied.
		expect(legal).toContain(
			"const LEGAL_SEARCH_ROWS = [...LEGAL_ROWS, ...SEARCH_ERRORS] as const;",
		);
		const spreads = hoistOf(report)?.residues.filter(
			(residue) => residue.ruleId === "errors-hoist-map-spread-in-array",
		);
		expect(
			spreads?.map((residue) => `${residue.line}:${residue.column} ${residue.message}`),
		).toEqual([
			"23:39 ...CONFIRM_ERRORS spreads a defineErrors map (an object; errors-factory makes one of the table) into an array, which throws at import: the provider will not load until this is fixed.",
			"8:28 ...LEGAL_ROWS spreads a defineErrors map (an object; errors-factory makes one of the table) into an array, which throws at import: the provider will not load until this is fixed.",
			"8:43 ...SEARCH_ERRORS spreads a defineErrors map (an object; errors-factory makes one of the table) into an array, which throws at import: the provider will not load until this is fixed.",
		]);
		expect(spreads?.[1]?.note).toBe(
			"Spread Object.values(LEGAL_ROWS) here, or list the map in the operation's errors, then re-run apifuse migrate.",
		);
		// Every errors.CODE the factory and health-refs wrote resolves: the
		// module map by import, the file's own map by retargeting; the undeclared
		// one is the residue above (and still gets the import so tsc names only it).
		const mapper = after["mappers/item.ts"] ?? "";
		expect(mapper).toContain(
			'import { ProviderError } from "@apifuse/provider-sdk/provider";\nimport { errors } from "../domain/errors";\n',
		);
		expect(mapper).toContain('throw errors.ITEM_GONE({ message: "The item was removed." });');
		// A registered code's site stays while rows this run cannot read exist
		// (row-unknown above); nothing is declared by value for it.
		expect(mapper).toContain(
			'throw new ProviderError("Shape drift.", { code: "UPSTREAM_SCHEMA_ERROR" });',
		);
		expect(after["domain/errors.ts"]).not.toContain("UPSTREAM_SCHEMA_ERROR");
		// An SDK-owned code has no factory: the site stays.
		expect(mapper).toContain(
			'throw new ProviderError("Service key missing.", { code: "MISSING_SECRET" });',
		);
		// A per-throw locale key rides into the factory input as written: a
		// literal, a shorthand variable, an identifier-valued fixKey.
		expect(mapper).toContain(
			'throw errors.ITEM_GONE({ message: "Keyed.", messageKey: "errors.itemGone.message" });',
		);
		expect(mapper).toContain(
			'throw errors.ITEM_GONE({ message: "Keyed by variable.", messageKey, fixKey: fix });',
		);
		// A spread in the options rides along into the factory input.
		expect(mapper).toContain(
			"throw errors.ITEM_GONE({ message: error.message, ...error.options });",
		);
		// A shorthand retryable (a variable) cannot be checked: the site stays.
		expect(mapper).toContain(
			'return new ProviderError(message, { code: "UPSTREAM_ERROR", retryable });',
		);
		// Nothing in this file is rewritten (two registered sites wait on the
		// unreadable lists, one code no map declares), so no import is added.
		expect(after["upstream/client.ts"]).toBe(before["upstream/client.ts"]);
		const client = after["upstream/client.ts"] ?? "";
		expect(client).not.toContain("domain/errors");
		expect(client).toContain('throw new ProviderError("No item matches.", { code: "NOT_FOUND" });');
		// A site of a code no map declares stays as written (an errors.X call would
		// be a runtime failure until the code is declared) and is named.
		expect(client).toContain('throw new ProviderError("Unknown.", { code: "NEVER_DECLARED" });');
		expect(client).toContain('throw new ProviderError("Nothing.", { code: "NO_DATA" });');
		expect(after["domain/errors.ts"]).not.toContain("NO_DATA");
		// A map another file must import is exported by this run (parcel.ts's
		// table, which rule 3 converts, was a plain `const`), and the importing
		// file's site is rewritten through it; dry run and apply agree.
		expect(after["operations/parcel.ts"]).toContain(
			'export const PARCEL_ERRORS = defineErrors({ "PARCEL_LOST": { category: "upstream_http", status: 404, description: "The parcel was lost.", retryable: false } })',
		);
		expect(after["upstream/dispatch.ts"]).toBe(
			'import { ProviderError } from "@apifuse/provider-sdk/provider";\nimport { PARCEL_ERRORS } from "../operations/parcel";\n\nexport function parcelLost(parcelId: string): never {\n\tthrow PARCEL_ERRORS.PARCEL_LOST({ message: "The parcel was lost.", details: { parcelId } });\n}\n',
		);
		// A construction whose code is not a literal and that states an option
		// (literally, or through a spread naming it) is named, so the run exits
		// 1 while the lint still counts the site; a literal-code site whose
		// option sits in a spread is named by this step (errors-factory's own
		// dynamic-option rule does not see spreads).
		expect(after["upstream/raise.ts"]).toBe(before["upstream/raise.ts"]);
		const dynamicCode = hoistOf(report)?.residues.filter(
			(residue) => residue.file === "upstream/raise.ts",
		);
		expect(
			dynamicCode?.map((residue) => `${residue.ruleId} ${residue.line} ${residue.message}`),
		).toEqual([
			"errors-hoist-throw-site-dynamic-code 8 new ProviderError(...) here takes its code from a variable and sets category or retryable through a spread per throw; no step can tell which declaration it serves, so it is left as written and new ProviderError(...) refuses it at run time (PER_THROW_ERROR_OPTIONS_RETIRED).",
			"errors-hoist-throw-site-dynamic-code 16 new ValidationError(...) here takes its code from a variable and sets category and retryable per throw; no step can tell which declaration it serves, so it is left as written and new ValidationError(...) refuses it at run time (PER_THROW_ERROR_OPTIONS_RETIRED).",
			'errors-hoist-throw-site-dynamic-option 20 Throw site of "ITEM_GONE" (ProviderError) sets retryable or category from a variable; the value cannot be checked against what the server serves, so the site is left as written.',
		]);
		expect(search).toContain(
			'import { ProviderError, defineOperation, defineErrors, sdkErrors } from "@apifuse/provider-sdk/provider";',
		);
		expect(search).toContain('throw SEARCH_ERRORS["429"]({ message: "Too many searches." });');
		expect(search).toContain(
			'expectedErrors: [{ error: SEARCH_ERRORS.NOT_FOUND, attribute: "query" }]',
		);
		expect(search).not.toContain("domain/errors");
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
		// Every left site is named again.
		expect(residueTable(again)).toEqual([
			"errors-factory errors-factory-throw-site-dynamic-option mappers/item.ts:25",
			"errors-factory errors-factory-throw-site-registry-conflict operations/search.ts:29",
			"errors-hoist errors-hoist-throw-site-row-unknown mappers/item.ts:9",
			"errors-hoist errors-hoist-outside-operation operations/booking.ts:7",
			"errors-hoist errors-hoist-array-spread-in-map operations/booking.ts:15",
			"errors-hoist errors-hoist-array-spread-in-map operations/booking.ts:19",
			"errors-hoist errors-hoist-spread-not-a-table operations/booking.ts:23",
			"errors-hoist errors-hoist-map-spread-in-array operations/booking.ts:23",
			"errors-hoist errors-hoist-throw-site-undeclared operations/booking.ts:25",
			"errors-hoist errors-hoist-spread-not-a-table operations/checkout.ts:14",
			"errors-hoist errors-hoist-throw-site-undeclared operations/checkout.ts:17",
			"errors-hoist errors-hoist-map-spread-in-array operations/legal.ts:8",
			"errors-hoist errors-hoist-map-spread-in-array operations/legal.ts:8",
			"errors-hoist errors-hoist-outside-operation operations/legal.ts:11",
			"errors-hoist errors-hoist-list-not-readable operations/legal.ts:20",
			"errors-hoist errors-hoist-list-not-readable operations/legal.ts:26",
			"errors-hoist errors-hoist-throw-site-code-conflict operations/legal.ts:29",
			"errors-hoist errors-hoist-throw-site-undeclared operations/own.ts:12",
			"errors-hoist errors-hoist-sdk-entry-conflict operations/search.ts:5",
			"errors-hoist errors-hoist-throw-site-row-unknown operations/search.ts:36",
			"errors-hoist errors-hoist-spread-not-a-table operations/statusless.ts:8",
			"errors-hoist errors-hoist-throw-site-row-unknown upstream/client.ts:6",
			"errors-hoist errors-hoist-throw-site-undeclared upstream/client.ts:7",
			"errors-hoist errors-hoist-throw-site-row-unknown upstream/client.ts:8",
			"errors-hoist errors-hoist-throw-site-dynamic-code upstream/raise.ts:8",
			"errors-hoist errors-hoist-throw-site-dynamic-code upstream/raise.ts:16",
			"errors-hoist errors-hoist-throw-site-dynamic-option upstream/raise.ts:20",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:14",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:22",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:34",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:38",
			"errors-hoist errors-hoist-throw-site-code-conflict upstream/sites.ts:46",
			"errors-hoist errors-hoist-throw-site-row-conflict upstream/sites.ts:50",
			"errors-hoist errors-hoist-throw-site-shadowed upstream/sites.ts:55",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:60",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:69",
			"errors-hoist errors-hoist-throw-site-sdk-conflict upstream/sites.ts:77",
			"errors-hoist errors-hoist-throw-site-code-conflict upstream/sites.ts:81",
		]);
		expect(again.clean).toBe(false);
	});

	it("--only errors-factory runs errors-hoist with it: a table and the list that spreads it move together", async () => {
		const report = await runMigrate({ providerRoot, dryRun: false, only: ["errors-factory"] });
		expect(report.codemods.map((result) => result.id)).toEqual(["errors-factory", "errors-hoist"]);
		const search = readFileSync(join(providerRoot, "operations/search.ts"), "utf8");
		expect(search).toContain("export const SEARCH_ERRORS = defineErrors({");
		expect(search).toContain("\terrors: [\n\t\t...Object.values(SEARCH_ERRORS),\n\t],\n");
		expect(search).not.toContain("errorCodes");
		const detail = readFileSync(join(providerRoot, "operations/detail.ts"), "utf8");
		expect(detail).toContain("errors.ITEM_GONE");
		expect(residueTable(report)).toEqual([
			"errors-factory errors-factory-throw-site-dynamic-option mappers/item.ts:24",
			"errors-factory errors-factory-sdk-row-conflict operations/search.ts:7",
			"errors-factory errors-factory-throw-site-registry-conflict operations/search.ts:26",
			"errors-hoist errors-hoist-throw-site-row-unknown mappers/item.ts:8",
			"errors-hoist errors-hoist-outside-operation operations/booking.ts:7",
			"errors-hoist errors-hoist-array-spread-in-map operations/booking.ts:15",
			"errors-hoist errors-hoist-array-spread-in-map operations/booking.ts:19",
			"errors-hoist errors-hoist-spread-not-a-table operations/booking.ts:23",
			"errors-hoist errors-hoist-map-spread-in-array operations/booking.ts:23",
			"errors-hoist errors-hoist-throw-site-undeclared operations/booking.ts:25",
			"errors-hoist errors-hoist-spread-not-a-table operations/checkout.ts:14",
			"errors-hoist errors-hoist-throw-site-undeclared operations/checkout.ts:17",
			"errors-hoist errors-hoist-map-spread-in-array operations/legal.ts:8",
			"errors-hoist errors-hoist-map-spread-in-array operations/legal.ts:8",
			"errors-hoist errors-hoist-outside-operation operations/legal.ts:11",
			"errors-hoist errors-hoist-list-not-readable operations/legal.ts:20",
			"errors-hoist errors-hoist-list-not-readable operations/legal.ts:26",
			"errors-hoist errors-hoist-throw-site-code-conflict operations/legal.ts:29",
			"errors-hoist errors-hoist-throw-site-undeclared operations/own.ts:17",
			"errors-hoist errors-hoist-sdk-entry-conflict operations/search.ts:5",
			"errors-hoist errors-hoist-throw-site-row-unknown operations/search.ts:33",
			"errors-hoist errors-hoist-spread-not-a-table operations/statusless.ts:8",
			"errors-hoist errors-hoist-throw-site-row-unknown upstream/client.ts:6",
			"errors-hoist errors-hoist-throw-site-undeclared upstream/client.ts:7",
			"errors-hoist errors-hoist-throw-site-row-unknown upstream/client.ts:8",
			"errors-hoist errors-hoist-throw-site-dynamic-code upstream/raise.ts:8",
			"errors-hoist errors-hoist-throw-site-dynamic-code upstream/raise.ts:16",
			"errors-hoist errors-hoist-throw-site-dynamic-option upstream/raise.ts:20",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:17",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:25",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:37",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:41",
			"errors-hoist errors-hoist-throw-site-code-conflict upstream/sites.ts:49",
			"errors-hoist errors-hoist-throw-site-row-conflict upstream/sites.ts:53",
			"errors-hoist errors-hoist-throw-site-shadowed upstream/sites.ts:58",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:63",
			"errors-hoist errors-hoist-throw-site-conflict upstream/sites.ts:72",
			"errors-hoist errors-hoist-throw-site-sdk-conflict upstream/sites.ts:84",
			"errors-hoist errors-hoist-throw-site-code-conflict upstream/sites.ts:88",
		]);
		expect(readFileSync(join(providerRoot, "mappers/item.ts"), "utf8")).toContain(
			'import { errors } from "../domain/errors";',
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
		expect(text).toContain("errors-factory                   5                   5         3");
		expect(text).toContain("errors-hoist                     12                  22        36");
		expect(text).toContain(
			"operations/search.ts:33:10 [errors-factory-throw-site-registry-conflict]",
		);
		expect(text).not.toContain("[errors-factory-throw-site-option]");
		expect(text).toContain("health-stale-window              2                   3         0");
		expect(text).toContain("operations/search.ts:7:2 [errors-factory-sdk-row-conflict]");
		expect(text).not.toContain("[errors-factory-inline-row-hoist]");
		expect(text).not.toContain("[health-stale-window-per-call]");
		expect(text).toContain("by hand: a throw site named here keeps a registry conflict");
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
