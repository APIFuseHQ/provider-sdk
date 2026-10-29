import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type TS from "typescript";

import {
	SDK_ERROR_REGISTRY,
	SDK_RUNTIME_OWNED_ERROR_CODES,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
	type SdkErrorCode,
} from "../error-resolution.js";
import { isRetryableCategory, type ProviderErrorCategory } from "../observability.js";
import { VALID_OPERATION_ERROR_STATUSES } from "../types.js";
import { getTypeScript, type TypeScriptModule } from "../typescript-module.js";
import {
	applyEdits,
	byPosition,
	commentsAround,
	finding,
	hasProperty,
	importInsertionPoint,
	importSpecifierOf,
	importStyleOf,
	importsOf,
	indentUnitOf,
	isOperationObject,
	lineIndentAt,
	type MigrateFinding,
	namedImportsOf,
	type ProviderSourceFile,
	propertyName,
	propertyOf,
	readProviderSources,
	relativeSpecifier,
	resolveRelativeImport,
	type SourceStepResult,
	type TextEdit,
	unwrapExpression,
} from "./migrate-source.js";

/**
 * `errors-hoist`: the inline `errorCodes` rows that carry their contract
 * (`{ code, status, description, retryable }` written straight into an
 * operation) move into the provider's one `defineErrors` map, and the
 * operation lists the factories instead (`errors: [errors.CODE, ...]`).
 *
 * The map is the provider's existing `export const errors = defineErrors({`
 * when it has one, else `domain/errors.ts` (created, or appended to). A code
 * several operations list gets one entry. What one entry cannot serve stays
 * in `errorCodes` as a residue naming the fix: a registered code whose row
 * differs from the SDK registry, a code whose rows disagree on status,
 * retryable or locale keys, a row whose values are not literals, a spread
 * that is not a plain table name.
 *
 * The entry serves what the legacy path served: the row's status; the row's
 * retryable, else `false` (the legacy default); the category every throw site
 * of the code served (a literal per-throw `category`, or for a site without
 * one the serve default: `upstream_rejected` for a 409/410/422 row, else
 * `provider_error`, `input_validation` for a 4xx `ValidationError`), when they
 * all served one value; else the serve default, and each site that served
 * something else is a residue. The description is the first one seen when
 * rows differ; each dropped one is a note.
 *
 * The same rule fills `category` into the entries the errors-factory codemod
 * made from a `const T = [...] as const` table (its rows never stated one), so
 * the provider loads without a by-hand step and nothing it served changes.
 *
 * The throw sites errors-factory leaves to this step (a provider-owned code's
 * site stating a literal `category` / `retryable`, or a site inside a
 * function that binds its own `errors`) are rewritten to `errors.CODE({...})`
 * only when the declaration serves the same category and retryable the site
 * states; a site that states something else is a residue naming both values,
 * left as it is so it keeps serving what it served.
 */

const SDK_IMPORT = "@apifuse/provider-sdk/provider";
const DEFAULT_MODULE = "domain/errors.ts";
const MAP_NAME = "errors";

export const ERRORS_HOIST_RULES = {
	sdkRowConflict: "errors-hoist-sdk-row-conflict",
	sdkRowLocaleKeys: "errors-hoist-sdk-row-locale-keys",
	sdkOwnedCode: "errors-hoist-sdk-owned-code",
	codeConflict: "errors-hoist-code-conflict",
	rowNotLiteral: "errors-hoist-row-not-literal",
	rowWithoutStatus: "errors-hoist-row-without-status",
	rowWithoutDescription: "errors-hoist-row-without-description",
	statusNotEmittable: "errors-hoist-status-not-emittable",
	spreadNotATable: "errors-hoist-spread-not-a-table",
	entryNotARow: "errors-hoist-entry-not-a-row",
	outsideOperation: "errors-hoist-outside-operation",
	nameTaken: "errors-hoist-name-taken",
	declaredDifferently: "errors-hoist-declared-differently",
	descriptionDropped: "errors-hoist-description-dropped",
	categoryFromSites: "errors-hoist-category-from-sites",
	referenceUndeclared: "errors-hoist-reference-undeclared",
	throwSiteConflict: "errors-hoist-throw-site-conflict",
	throwSiteRowConflict: "errors-hoist-throw-site-row-conflict",
	throwSiteDerivedCategory: "errors-hoist-throw-site-derived-category",
	throwSiteShadowed: "errors-hoist-throw-site-shadowed",
	throwSiteUndeclared: "errors-hoist-throw-site-undeclared",
} as const;

export type ErrorsHoistOptions = {
	readonly providerRoot: string;
	readonly dryRun: boolean;
	readonly ts?: TypeScriptModule;
};

type Row = {
	readonly file: ProviderSourceFile;
	readonly node: TS.ObjectLiteralExpression;
	/** The list element that names this row when it is a constant referenced by name. */
	readonly listed?: TS.Expression;
	readonly code: string;
	readonly status?: number;
	readonly descriptionText?: string;
	readonly descriptionValue?: string;
	readonly retryable?: boolean;
	readonly category?: string;
	readonly messageKey?: string;
	readonly fixKey?: string;
};

type Entry =
	| { readonly kind: "row"; readonly row: Row; readonly bare: boolean }
	| { readonly kind: "spread"; readonly node: TS.SpreadElement; readonly name?: string }
	| { readonly kind: "other"; readonly node: TS.Expression };

type ErrorList = {
	readonly file: ProviderSourceFile;
	readonly pair: TS.PropertyAssignment;
	readonly array: TS.ArrayLiteralExpression;
	/** The object that gets `errors: [...]`: the operation, or the meta object spread into one. */
	readonly operation: TS.ObjectLiteralExpression;
	/** The property `errors` is inserted before: the list itself, or the pre-#238 `docs` block holding it. */
	readonly anchor: TS.PropertyAssignment;
	readonly entries: readonly Entry[];
	/** `errorCodes: NAME` (a table named whole, no array literal): becomes `errors: Object.values(NAME)`. */
	readonly wholeName?: string;
};

type Declaration =
	| { readonly kind: "sdk"; readonly code: SdkErrorCode }
	| {
			readonly kind: "provider";
			readonly code: string;
			readonly status: number;
			readonly retryable: boolean;
			readonly category: string;
			readonly descriptionText: string;
			readonly messageKey?: string;
			readonly fixKey?: string;
			readonly comments: readonly string[];
	  };

/** One entry of a defineErrors map (or, in a dry run, one row of the table errors-factory converts). */
type MapEntry = {
	readonly status?: number;
	readonly retryable?: boolean;
	readonly category?: string;
	/** The entry states a messageKey or fixKey. */
	readonly localeKey?: boolean;
	readonly sdk: boolean;
	/** The entry's object literal, absent for `X: sdkErrors.X`. */
	readonly node?: TS.ObjectLiteralExpression;
};

type ExistingMap = {
	readonly file: ProviderSourceFile;
	readonly object: TS.ObjectLiteralExpression;
	readonly entries: ReadonlyMap<string, MapEntry>;
};

/** What a declaration (the map's entry, or the one this step writes) serves for a code. */
type DeclaredView = {
	readonly status?: number;
	readonly category: string;
	readonly retryable: boolean;
	/** True when this run chose the category (a hoisted row, a filled entry); false when the map already stated it. */
	readonly resolved: boolean;
};

const ERROR_CONSTRUCTORS = new Set([
	"ProviderError",
	"AuthError",
	"ValidationError",
	"TransportError",
	"SessionExpiredError",
]);

/**
 * One `new ProviderError(...)` (or subclass) site naming a code literally,
 * read before any step rewrites it; and, after errors-factory ran, each
 * `errors.CODE({...})` it produced, which serves the declaration (`factory`).
 */
type ThrowSite = {
	readonly file: ProviderSourceFile;
	readonly node: TS.NewExpression | TS.CallExpression;
	readonly constructor: string;
	readonly code: string;
	readonly options?: TS.ObjectLiteralExpression;
	/** The literal per-throw category, when the site states one. */
	readonly category?: string;
	/** The literal per-throw retryable, when the site states one. */
	readonly retryable?: boolean;
	/** A category or retryable written as a shorthand or a non-literal value. */
	readonly dynamic: boolean;
	/** The site writes a category (literal or not), so the bare default does not apply. */
	readonly categoryStated: boolean;
	readonly localeKey: boolean;
	/** Inside a function that binds its own `errors` somewhere (the errors-factory guard), so rule 1 left it. */
	readonly bindsScope: boolean;
	/** A local `errors` binding is in scope at the site, so `errors.CODE` there would not reach the map import. */
	readonly shadowed: boolean;
};

type ThrowSites = ReadonlyMap<string, readonly ThrowSite[]>;

const REJECTION_STATUSES = new Set([409, 410, 422]);

type FileEdits = { readonly file: ProviderSourceFile; readonly edits: TextEdit[] };

export function hoistInlineErrorRows(options: ErrorsHoistOptions): SourceStepResult {
	const ts = options.ts ?? getTypeScript();
	const sources = readProviderSources(ts, options.providerRoot);
	const residues: MigrateFinding[] = [];
	const notes: MigrateFinding[] = [];

	const lists = collectLists(ts, sources, residues);
	const existing = findExistingMap(ts, sources);
	const sites = collectThrowSites(ts, sources);
	const declarations = declareCodes(ts, lists, existing, sites, residues, notes);
	const maps = defineErrorsMaps(ts, sources);

	const hoisted = new Set<string>();
	const edits = new Map<string, FileEdits>();
	const imports = new Map<string, FileEdits>();
	let rewrites = 0;

	// The entries errors-factory made from a table state no category (rule 3
	// keeps the row's fields, and a legacy row never had one): each gets the
	// category its throw sites served, so the provider loads and serves the same.
	const views = new Map<string, DeclaredView | null>();
	const filled = fillEntryCategories(maps, sites, views, notes, options.dryRun);
	for (const pending of filled.edits.values()) {
		editsFor(edits, pending.file).push(...pending.edits);
	}
	const pendingFiles = new Set<string>(filled.files);
	rewrites += filled.rewrites;

	for (const list of lists) {
		if (list.wholeName !== undefined) {
			if (isDefineErrorsMap(ts, maps, list.file, list.wholeName)) {
				rewrites += 1;
				editsFor(edits, list.file).push({
					start: list.pair.getStart(list.file.source),
					end: list.pair.end,
					text: `errors: Object.values(${list.wholeName})`,
				});
			} else {
				residues.push(
					finding(
						list.file,
						list.pair.getStart(list.file.source),
						ERRORS_HOIST_RULES.spreadNotATable,
						`errorCodes names ${list.wholeName}, which is not declared with defineErrors, so it cannot become errors: Object.values(${list.wholeName}); it is left in place.`,
						"Give the rows a defineErrors map and name that, then re-run apifuse migrate. A `const T = [...] as const` table becomes one through the errors-factory codemod when its rows carry code and status.",
					),
				);
			}
			continue;
		}
		const moved: string[] = [];
		const movedCodes: string[] = [];
		const kept: TS.Expression[] = [];
		let blocked = false;
		for (const entry of list.entries) {
			if (entry.kind === "row") {
				const code = entry.row.code;
				const declaration = declarations.get(code);
				if (declaration !== undefined && declaration.kind !== "residue") {
					moved.push(reference(code));
					movedCodes.push(code);
				} else if (entry.bare && declaration === undefined) {
					moved.push(reference(code));
					notes.push(
						finding(
							list.file,
							entry.row.node.getStart(list.file.source),
							ERRORS_HOIST_RULES.entryNotARow,
							`Row ${JSON.stringify(code)} carries no contract; it is listed as ${reference(code)} and the map must declare it (tsc names it when not).`,
						),
					);
				} else {
					kept.push(entry.row.listed ?? entry.row.node);
				}
			} else if (entry.kind === "spread") {
				if (entry.name !== undefined && isDefineErrorsMap(ts, maps, list.file, entry.name)) {
					moved.push(`...Object.values(${entry.name})`);
				} else {
					// A spread whose rows the step cannot see may repeat a code the list
					// also writes inline; `errors` and `errorCodes` naming one code twice
					// is refused by defineProvider, so the whole list waits.
					blocked = true;
					residues.push(
						finding(
							list.file,
							entry.node.getStart(list.file.source),
							ERRORS_HOIST_RULES.spreadNotATable,
							`This errorCodes spread is not the name of a defineErrors map${entry.name === undefined ? "" : ` (${entry.name} is not declared with defineErrors)`}, so the list cannot become references; it is left whole.`,
							"Give the spread rows a defineErrors map and spread that name, then re-run apifuse migrate. A `const T = [...] as const` table becomes one through the errors-factory codemod when its rows carry code and status; a row of a registered code that states no status needs `CODE: sdkErrors.CODE` written by hand.",
						),
					);
				}
			} else {
				blocked = true;
				residues.push(
					finding(
						list.file,
						entry.node.getStart(list.file.source),
						ERRORS_HOIST_RULES.entryNotARow,
						"This errorCodes entry is not a { code, ... } row literal, so the list cannot become references; it is left whole.",
						"Write the entry as a row, or declare its code in the defineErrors map and list errors.CODE, then re-run apifuse migrate.",
					),
				);
			}
		}
		if (moved.length === 0 || blocked) continue;
		// A list that only spreads maps references no `errors.CODE`: no import,
		// and no map to create for it.
		const needsMap = moved.some(
			(item) => item.startsWith(`${MAP_NAME}.`) || item.startsWith(`${MAP_NAME}[`),
		);
		if (needsMap && !ensureMapImport(ts, list.file, existing, residues, imports)) continue;
		for (const code of movedCodes) hoisted.add(code);
		rewrites += 1;
		editsFor(edits, list.file).push(...listEdits(ts, list, moved, kept));
	}
	const mergedImports = new Set<string>();
	for (const [path, pending] of imports) {
		if (edits.has(path)) {
			editsFor(edits, pending.file).push(...pending.edits);
			mergedImports.add(path);
		}
	}

	// A hoisted row is declared by this step: its view is the declaration.
	for (const [code, declaration] of declarations) {
		if (declaration.kind === "provider" && hoisted.has(code)) {
			views.set(code, {
				status: declaration.status,
				category: declaration.category,
				retryable: declaration.retryable,
				resolved: true,
			});
		}
	}
	const siteItems = resolveThrowSites(
		sites,
		views,
		registryRowConflicts(declarations, maps),
		residues,
	);
	const references = collectReferences(
		ts,
		sources,
		existing?.file.path ?? DEFAULT_MODULE,
		siteItems,
	);

	// A registered code a throw site names that no map in the file's scope
	// declares (its row sat in a table rule 3 does not convert, or in another
	// operation's table) is declared by value in the provider map.
	const referencedSdk = new Set<string>();
	for (const fileReferences of references) {
		const scope = mapsInScope(ts, maps, fileReferences.file);
		for (const item of fileReferences.items) {
			const code = item.code;
			// An inline row of the same code that stayed in errorCodes (a residue, or
			// a list this step left whole) does not stop the throw sites:
			// errors.CODE serves the registry value.
			const declared = declarations.get(code);
			if (
				Object.hasOwn(SDK_ERROR_REGISTRY, code) &&
				(declared === undefined || declared.kind === "residue" || !hoisted.has(code)) &&
				!existing?.entries.has(code) &&
				![...scope].some(([name, codes]) => name !== MAP_NAME && codes.has(code))
			) {
				referencedSdk.add(code);
			}
		}
	}

	const newCodes: Array<[string, DeclarationOrResidue]> = [...declarations.entries()].filter(
		([code, declaration]) =>
			declaration.kind !== "residue" && hoisted.has(code) && !existing?.entries.has(code),
	);
	for (const code of referencedSdk) {
		if (!newCodes.some(([existingCode]) => existingCode === code)) {
			newCodes.push([code, { kind: "sdk", code: code as SdkErrorCode }]);
		}
	}
	const moduleResult = writeMap(
		ts,
		options,
		sources,
		existing,
		newCodes.map(([, declaration]) => declaration as Declaration),
	);
	if (moduleResult !== undefined) {
		rewrites += 1;
		if (moduleResult.edits.length > 0) {
			editsFor(edits, moduleResult.file).push(...moduleResult.edits);
		}
	}

	const moduleCodes = new Set<string>([
		...(existing?.entries.keys() ?? []),
		...newCodes.map(([code]) => code),
	]);
	const modulePath =
		existing?.file.path ?? (moduleResult === undefined ? undefined : DEFAULT_MODULE);
	rewrites += resolveReferences(ts, references, {
		existing,
		modulePath,
		moduleCodes,
		maps,
		edits,
		imports,
		residues,
	});
	for (const [path, pending] of imports) {
		if (!mergedImports.has(path)) editsFor(edits, pending.file).push(...pending.edits);
	}

	const filesChanged = new Set<string>(pendingFiles);
	for (const [path, { file, edits: fileEdits }] of edits) {
		if (fileEdits.length === 0) continue;
		filesChanged.add(path);
		if (!options.dryRun) {
			writeFileSync(file.absolutePath, applyEdits(file.text, fileEdits));
		}
	}
	if (moduleResult?.created !== undefined) {
		filesChanged.add(moduleResult.file.path);
		if (!options.dryRun) {
			mkdirSync(dirname(moduleResult.file.absolutePath), { recursive: true });
			writeFileSync(moduleResult.file.absolutePath, moduleResult.created);
		}
	}

	return {
		filesChanged: [...filesChanged].sort(),
		rewrites,
		notes: dedupe(notes).sort(byPosition),
		residues: dedupe(residues).sort(byPosition),
	};
}

// A row constant several operations reference by name is one row: one finding.
function dedupe(findings: readonly MigrateFinding[]): MigrateFinding[] {
	const seen = new Set<string>();
	return findings.filter((item) => {
		const key = `${item.ruleId}\0${item.file}\0${item.line}\0${item.column}\0${item.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

type Reference = {
	readonly node: TS.Node;
	readonly code: string;
	/** The `errors` identifier to retarget; absent for a site the factory has not rewritten yet (a dry run). */
	readonly target?: TS.Identifier;
	/** A throw site this step rewrites itself once the map that declares the code is known. */
	readonly site?: ThrowSite;
};

type FileReferences = {
	readonly file: ProviderSourceFile;
	/** Top-level names the file binds, with `errors` dropped when it is the module's own import. */
	readonly bound: Set<string>;
	readonly items: readonly Reference[];
};

/**
 * Every `errors.CODE` a file names (a throw site errors-factory rewrote, a
 * health scenario health-refs rewrote), plus, so a dry run reports what the
 * apply does, the sites the two will rewrite. A file that binds `errors` to
 * anything but the module's import is left alone.
 */
function collectReferences(
	ts: TypeScriptModule,
	sources: readonly ProviderSourceFile[],
	modulePath: string,
	siteItems: ReadonlyMap<string, readonly Reference[]>,
): FileReferences[] {
	const out: FileReferences[] = [];
	for (const file of sources) {
		const bound = topLevelBindings(ts, file);
		if (bound.has(MAP_NAME) && importsModuleMap(ts, file, modulePath)) bound.delete(MAP_NAME);
		if (bound.has(MAP_NAME) && file.path !== modulePath) continue;
		const items: Reference[] = [...(siteItems.get(file.path) ?? [])];
		const visit = (node: TS.Node): void => {
			if (
				(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === MAP_NAME &&
				// `errors.length` on a local array is not a reference to the map.
				!shadowedByLocalBinding(ts, node, MAP_NAME)
			) {
				const code = ts.isPropertyAccessExpression(node)
					? node.name.text
					: literalString(ts, node.argumentExpression);
				if (code !== undefined) items.push({ node, code, target: node.expression });
			} else if (
				ts.isNewExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "ProviderError" &&
				!factoryLeavesSite(ts, node) &&
				!insideFunctionBinding(ts, node, MAP_NAME)
			) {
				const code = factoryRewriteCode(ts, node);
				if (code !== undefined) items.push({ node, code });
			} else if (ts.isObjectLiteralExpression(node)) {
				const code = healthRefsRewriteCode(ts, node);
				if (code !== undefined) items.push({ node, code });
			}
			ts.forEachChild(node, visit);
		};
		visit(file.source);
		out.push({ file, bound, items });
	}
	return out;
}

/**
 * Per file: a reference to a code the provider map declares gets
 * `import { errors }` from the module; a reference to a code a map in the
 * file's scope declares (its own table that became a map, or one it imports)
 * is retargeted to that map; a code exactly one map elsewhere declares gets
 * that map imported and the reference retargeted; a code no map declares is
 * a residue. A file that converted a table, or names `sdkErrors`, gets the
 * SDK import.
 */
function resolveReferences(
	ts: TypeScriptModule,
	references: readonly FileReferences[],
	context: {
		readonly existing: ExistingMap | undefined;
		readonly modulePath: string | undefined;
		readonly moduleCodes: ReadonlySet<string>;
		readonly maps: MapsByFile;
		readonly edits: Map<string, FileEdits>;
		readonly imports: Map<string, FileEdits>;
		readonly residues: MigrateFinding[];
	},
): number {
	let rewrites = 0;
	const declaringMaps = (code: string): Array<{ path: string; name: string }> => {
		const out: Array<{ path: string; name: string }> = [];
		for (const [path, byName] of context.maps) {
			for (const [name, entry] of byName) {
				if (name !== MAP_NAME && entry.codes.has(code)) out.push({ path, name });
			}
		}
		return out;
	};
	for (const { file, bound, items } of references) {
		const scope = mapsInScope(ts, context.maps, file);
		const fileEdits: TextEdit[] = [];
		let needsModule = false;
		const pendingBefore = context.imports.get(file.path)?.edits.length ?? 0;
		const retarget = (item: Reference, name: string): void => {
			if (item.site !== undefined) {
				fileEdits.push(throwSiteEdit(ts, item.site, name));
				return;
			}
			if (item.target === undefined) return;
			fileEdits.push({
				start: item.target.getStart(file.source),
				end: item.target.end,
				text: name,
			});
		};
		for (const item of items) {
			const code = item.code;
			if (context.moduleCodes.has(code)) {
				if (file.path !== context.modulePath) needsModule = true;
				if (item.site !== undefined) retarget(item, MAP_NAME);
				continue;
			}
			const local = [...scope].find(([name, codes]) => name !== MAP_NAME && codes.has(code));
			if (local !== undefined) {
				retarget(item, local[0]);
				continue;
			}
			const remote = declaringMaps(code).filter((candidate) => candidate.path !== file.path);
			const [only] = remote;
			if (only !== undefined && remote.length === 1 && !bound.has(only.name)) {
				if (ensureImport(ts, file, only.name, only.path, context.residues, context.imports)) {
					retarget(item, only.name);
					continue;
				}
			}
			if (item.site !== undefined) {
				// A site this step owns is never rewritten to a name no map declares.
				context.residues.push(
					finding(
						file,
						item.node.getStart(file.source),
						ERRORS_HOIST_RULES.throwSiteUndeclared,
						`Throw site of ${JSON.stringify(code)} cannot reach a defineErrors map that declares ${code} from this file${remote.length > 1 ? ` (${remote.length} maps declare it: ${remote.map((candidate) => `${candidate.name} in ${candidate.path}`).join(", ")})` : ""}; it is left as new ProviderError(...).`,
						`Declare ${code} once in the provider's defineErrors map (status, the category and retryable this site states, description), then re-run apifuse migrate.`,
					),
				);
				continue;
			}
			if (context.modulePath !== undefined && file.path !== context.modulePath) needsModule = true;
			context.residues.push(
				finding(
					file,
					item.node.getStart(file.source),
					ERRORS_HOIST_RULES.referenceUndeclared,
					`${MAP_NAME}.${code} names a code no defineErrors map in this provider declares${remote.length > 1 ? ` (${remote.length} maps declare it: ${remote.map((candidate) => `${candidate.name} in ${candidate.path}`).join(", ")})` : context.modulePath === undefined ? " (and the provider has no errors map)" : ""}; tsc names it until it is declared.`,
					`Declare ${code} in the provider's defineErrors map (status, category, description) or throw a declared code here, then re-run apifuse migrate.`,
				),
			);
		}

		const sdkWanted = sdkNamesWanted(ts, file, context.maps);
		if (sdkWanted.length > 0 && file.path !== context.modulePath) {
			fileEdits.push(...sdkImportEdits(ts, file, sdkWanted));
		}
		if (needsModule && !bound.has(MAP_NAME)) {
			if (!ensureMapImport(ts, file, context.existing, context.residues, context.imports)) {
				continue;
			}
		}
		const importedAny = (context.imports.get(file.path)?.edits.length ?? 0) > pendingBefore;
		if (fileEdits.length > 0) editsFor(context.edits, file).push(...fileEdits);
		if (fileEdits.length > 0 || importedAny) rewrites += 1;
	}
	return rewrites;
}

function importsModuleMap(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	modulePath: string | undefined,
): boolean {
	if (modulePath === undefined) return false;
	for (const declaration of importsOf(ts, file.source)) {
		if (namedImportsOf(ts, declaration).get(MAP_NAME) !== MAP_NAME) continue;
		const specifier = (importSpecifierOf(ts, declaration) ?? "").replace(/\.[cm]?js$/, "");
		return specifier === relativeSpecifier(file.path, modulePath);
	}
	return false;
}

/** The code rule 1 rewrites this throw site to, or undefined when it leaves the site (no literal code, or a per-throw value that contradicts the registry). */
function factoryRewriteCode(ts: TypeScriptModule, node: TS.NewExpression): string | undefined {
	const options = node.arguments?.[1];
	if (options === undefined || !ts.isObjectLiteralExpression(options)) return undefined;
	const codePair = propertyOf(ts, options, "code");
	const code = codePair === undefined ? undefined : literalString(ts, codePair.initializer);
	if (code === undefined) return undefined;
	if (
		propertyOf(ts, options, "messageKey") !== undefined ||
		propertyOf(ts, options, "fixKey") !== undefined
	) {
		return undefined;
	}
	if (!Object.hasOwn(SDK_ERROR_REGISTRY, code) && isSdkOwnedCode(code)) return undefined;
	for (const property of options.properties) {
		if (ts.isSpreadAssignment(property)) continue;
		const name = property.name === undefined ? undefined : propertyName(ts, property.name);
		if (name !== "retryable" && name !== "category") continue;
		if (ts.isShorthandPropertyAssignment(property)) return undefined;
		if (ts.isPropertyAssignment(property)) {
			const value = unwrapExpression(ts, property.initializer);
			if (
				value.kind !== ts.SyntaxKind.TrueKeyword &&
				value.kind !== ts.SyntaxKind.FalseKeyword &&
				!ts.isStringLiteral(value)
			) {
				return undefined;
			}
		}
	}
	if (Object.hasOwn(SDK_ERROR_REGISTRY, code)) {
		const registry = SDK_ERROR_REGISTRY[code as SdkErrorCode];
		const retryable = propertyOf(ts, options, "retryable");
		const category = propertyOf(ts, options, "category");
		const stated = retryable === undefined ? undefined : literalBoolean(ts, retryable.initializer);
		const statedCategory =
			category === undefined ? undefined : literalString(ts, category.initializer);
		if (
			(retryable !== undefined && stated !== registry.retryable) ||
			(category !== undefined && statedCategory !== registry.category)
		) {
			return undefined;
		}
	}
	return code;
}

/** The code health-refs rewrites this `expectedErrors` entry to, or undefined when it is not one. */
function healthRefsRewriteCode(
	ts: TypeScriptModule,
	node: TS.ObjectLiteralExpression,
): string | undefined {
	const array = node.parent;
	if (!ts.isArrayLiteralExpression(array)) return undefined;
	const pair = array.parent;
	if (!ts.isPropertyAssignment(pair) || propertyName(ts, pair.name) !== "expectedErrors") {
		return undefined;
	}
	const code = propertyOf(ts, node, "code");
	if (
		code === undefined ||
		!hasProperty(ts, node, "status") ||
		!hasProperty(ts, node, "attribute")
	) {
		return undefined;
	}
	return literalString(ts, code.initializer);
}

/** A code the SDK runtime throws itself: defineErrors refuses it, so no factory exists and the throw site stays. */
export function isSdkOwnedCode(code: string): boolean {
	return (
		SDK_RUNTIME_OWNED_ERROR_CODES.has(code) || SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.has(code)
	);
}

/** Top-level names a file binds (declarations and imports), which a reference to `errors` resolves to before any import this step adds. */
function topLevelBindings(ts: TypeScriptModule, file: ProviderSourceFile): Set<string> {
	const names = new Set<string>();
	for (const statement of file.source.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
			}
		} else if (
			(ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
			statement.name !== undefined
		) {
			names.add(statement.name.text);
		} else if (ts.isImportDeclaration(statement)) {
			for (const local of namedImportsOf(ts, statement).keys()) names.add(local);
			const name = statement.importClause?.name;
			if (name !== undefined) names.add(name.text);
		}
	}
	return names;
}

/** `defineErrors` / `sdkErrors` a file uses (or will, once its table is a map) without importing them. */
function sdkNamesWanted(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	maps: MapsByFile,
): string[] {
	const bound = topLevelBindings(ts, file);
	const used = new Set<string>();
	const visit = (node: TS.Node): void => {
		if (ts.isIdentifier(node) && (node.text === "defineErrors" || node.text === "sdkErrors")) {
			used.add(node.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(file.source);
	// A table the factory converts (a dry run) will name defineErrors, and
	// sdkErrors for a registered code; a map already names what it uses.
	for (const entry of (maps.get(file.path) ?? new Map<string, MapInfo>()).values()) {
		if (!entry.table) continue;
		used.add("defineErrors");
		if ([...entry.codes.keys()].some((code) => Object.hasOwn(SDK_ERROR_REGISTRY, code))) {
			used.add("sdkErrors");
		}
	}
	return ["defineErrors", "sdkErrors"].filter((name) => used.has(name) && !bound.has(name));
}

function editsFor(edits: Map<string, FileEdits>, file: ProviderSourceFile): TextEdit[] {
	let entry = edits.get(file.path);
	if (entry === undefined) {
		entry = { file, edits: [] };
		edits.set(file.path, entry);
	}
	return entry.edits;
}

function reference(code: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(code)
		? `${MAP_NAME}.${code}`
		: `${MAP_NAME}[${JSON.stringify(code)}]`;
}

function mapKey(code: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(code) ? code : JSON.stringify(code);
}

function collectLists(
	ts: TypeScriptModule,
	sources: readonly ProviderSourceFile[],
	residues: MigrateFinding[],
): ErrorList[] {
	const lists: ErrorList[] = [];
	for (const file of sources) {
		const visit = (node: TS.Node): void => {
			if (
				ts.isPropertyAssignment(node) &&
				propertyName(ts, node.name) === "errorCodes" &&
				ts.isObjectLiteralExpression(node.parent)
			) {
				const array = unwrapExpression(ts, node.initializer);
				if (ts.isIdentifier(array)) {
					const placement = listPlacement(ts, node);
					if (placement !== undefined) {
						lists.push({
							file,
							pair: node,
							array: ts.factory.createArrayLiteralExpression([]),
							...placement,
							entries: [],
							wholeName: array.text,
						});
					}
				} else if (ts.isArrayLiteralExpression(array)) {
					const entries = array.elements.map((element) =>
						classifyEntry(ts, file, element, sources),
					);
					// A list is this step's when it holds something only this step can
					// place: a row with its contract, a row referenced by name, a spread
					// (resolved across files). A list of bare { code } rows is rule 2's.
					const owned = entries.filter(
						(entry) =>
							entry.kind === "spread" ||
							(entry.kind === "row" && (!entry.bare || entry.row.listed !== undefined)),
					);
					if (owned.length > 0) {
						const placement = listPlacement(ts, node);
						if (placement !== undefined) {
							lists.push({ file, pair: node, array, ...placement, entries });
						} else {
							residues.push(
								finding(
									file,
									node.getStart(file.source),
									ERRORS_HOIST_RULES.outsideOperation,
									"errorCodes rows with status or description sit outside an operation object (no handler beside them); they are left in place.",
									"Move the rows into the operation that serves them (or into the defineErrors map and list errors.CODE there), then re-run apifuse migrate.",
								),
							);
						}
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file.source);
	}
	return lists;
}

// Where the list's `errors` goes. Three shapes serve an operation's codes:
// the operation object itself; a meta object (`{ input, output, errorCodes }`
// spread into the operation elsewhere); and the pre-#238 `docs: { errorCodes }`
// block inside the operation, which the flattened declaration no longer reads.
function listPlacement(
	ts: TypeScriptModule,
	pair: TS.PropertyAssignment,
): { operation: TS.ObjectLiteralExpression; anchor: TS.PropertyAssignment } | undefined {
	const owner = pair.parent;
	if (!ts.isObjectLiteralExpression(owner)) return undefined;
	if (isOperationObject(ts, owner) || isOperationMeta(ts, owner)) {
		return { operation: owner, anchor: pair };
	}
	const docs = owner.parent;
	if (
		ts.isPropertyAssignment(docs) &&
		propertyName(ts, docs.name) === "docs" &&
		ts.isObjectLiteralExpression(docs.parent) &&
		isOperationObject(ts, docs.parent)
	) {
		return { operation: docs.parent, anchor: docs };
	}
	return undefined;
}

function isOperationMeta(ts: TypeScriptModule, object: TS.ObjectLiteralExpression): boolean {
	if (hasProperty(ts, object, "handler")) return false;
	return ["input", "output", "riskClass", "healthCheck", "connectionMode"].some((name) =>
		hasProperty(ts, object, name),
	);
}

function literalString(ts: TypeScriptModule, node: TS.Expression): string | undefined {
	const value = unwrapExpression(ts, node);
	if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
	return undefined;
}

function literalNumber(ts: TypeScriptModule, node: TS.Expression): number | undefined {
	const value = unwrapExpression(ts, node);
	if (ts.isNumericLiteral(value)) return Number(value.text.replace(/_/g, ""));
	return undefined;
}

function literalBoolean(ts: TypeScriptModule, node: TS.Expression): boolean | undefined {
	const value = unwrapExpression(ts, node);
	if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
	return undefined;
}

function classifyEntry(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	element: TS.Expression,
	sources: readonly ProviderSourceFile[],
): Entry {
	if (ts.isSpreadElement(element)) {
		const spread = unwrapExpression(ts, element.expression);
		return ts.isIdentifier(spread)
			? { kind: "spread", node: element, name: spread.text }
			: { kind: "spread", node: element };
	}
	const value = unwrapExpression(ts, element);
	if (ts.isIdentifier(value)) {
		// A row referenced by name: the constant it names, in this file or the
		// one it is imported from, is the row (its own position reports it).
		const named = namedRowConstant(ts, file, value.text, sources);
		if (named === undefined) return { kind: "other", node: element };
		const entry = classifyEntry(ts, named.file, named.initializer, sources);
		return entry.kind === "row"
			? { ...entry, row: { ...entry.row, listed: element } }
			: { kind: "other", node: element };
	}
	const object = value;
	if (!ts.isObjectLiteralExpression(object)) return { kind: "other", node: element };
	const fields = new Map<string, TS.Expression>();
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property)) return { kind: "other", node: element };
		const name = propertyName(ts, property.name);
		if (name === undefined) return { kind: "other", node: element };
		fields.set(name, property.initializer);
	}
	const codeNode = fields.get("code");
	const code = codeNode === undefined ? undefined : literalString(ts, codeNode);
	if (code === undefined) return { kind: "other", node: element };
	const descriptionNode = fields.get("description");
	const statusNode = fields.get("status");
	const row: Row = {
		file,
		node: object,
		code,
		...(statusNode === undefined ? {} : { status: literalNumber(ts, statusNode) }),
		...(descriptionNode === undefined
			? {}
			: {
					descriptionValue: literalString(ts, descriptionNode),
					descriptionText: file.text.slice(
						unwrapExpression(ts, descriptionNode).getStart(file.source),
						unwrapExpression(ts, descriptionNode).end,
					),
				}),
		...(fields.has("retryable")
			? { retryable: literalBoolean(ts, fields.get("retryable") as TS.Expression) }
			: {}),
		...(fields.has("category")
			? { category: literalString(ts, fields.get("category") as TS.Expression) }
			: {}),
		...(fields.has("messageKey")
			? { messageKey: literalString(ts, fields.get("messageKey") as TS.Expression) }
			: {}),
		...(fields.has("fixKey")
			? { fixKey: literalString(ts, fields.get("fixKey") as TS.Expression) }
			: {}),
	};
	const bare = statusNode === undefined && descriptionNode === undefined;
	return { kind: "row", row, bare };
}

function namedRowConstant(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	name: string,
	sources: readonly ProviderSourceFile[],
): { readonly file: ProviderSourceFile; readonly initializer: TS.Expression } | undefined {
	for (const statement of file.source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (
				ts.isIdentifier(declaration.name) &&
				declaration.name.text === name &&
				declaration.initializer !== undefined
			) {
				return { file, initializer: declaration.initializer };
			}
		}
	}
	for (const declaration of importsOf(ts, file.source)) {
		const imported = namedImportsOf(ts, declaration).get(name);
		if (imported === undefined) continue;
		const specifier = importSpecifierOf(ts, declaration);
		if (specifier === undefined) return undefined;
		const target = resolveRelativeImport(file.path, specifier, (candidate) =>
			sources.some((source) => source.path === candidate),
		);
		const declaredIn = sources.find((source) => source.path === target);
		if (declaredIn === undefined) return undefined;
		return namedRowConstant(ts, declaredIn, imported, sources);
	}
	return undefined;
}

function nonLiteralField(row: Row, fields: Map<string, TS.Expression>): string | undefined {
	for (const name of fields.keys()) {
		if (
			!["code", "status", "description", "retryable", "category", "messageKey", "fixKey"].includes(
				name,
			)
		) {
			return name;
		}
	}
	if (fields.has("status") && row.status === undefined) return "status";
	if (fields.has("description") && row.descriptionValue === undefined) return "description";
	if (fields.has("retryable") && row.retryable === undefined) return "retryable";
	if (fields.has("category") && row.category === undefined) return "category";
	if (fields.has("messageKey") && row.messageKey === undefined) return "messageKey";
	if (fields.has("fixKey") && row.fixKey === undefined) return "fixKey";
	return undefined;
}

function rowFields(ts: TypeScriptModule, row: Row): Map<string, TS.Expression> {
	const fields = new Map<string, TS.Expression>();
	for (const property of row.node.properties) {
		if (ts.isPropertyAssignment(property)) {
			const name = propertyName(ts, property.name);
			if (name !== undefined) fields.set(name, property.initializer);
		}
	}
	return fields;
}

type DeclarationOrResidue = Declaration | { readonly kind: "residue" };

function declareCodes(
	ts: TypeScriptModule,
	lists: readonly ErrorList[],
	existing: ExistingMap | undefined,
	sites: ThrowSites,
	residues: MigrateFinding[],
	notes: MigrateFinding[],
): Map<string, DeclarationOrResidue> {
	const byCode = new Map<string, Row[]>();
	for (const list of lists) {
		for (const entry of list.entries) {
			if (entry.kind !== "row" || entry.bare) continue;
			const rows = byCode.get(entry.row.code) ?? [];
			rows.push(entry.row);
			byCode.set(entry.row.code, rows);
		}
	}

	const declarations = new Map<string, DeclarationOrResidue>();
	for (const [code, rows] of byCode) {
		const residue = (row: Row, ruleId: string, message: string, note?: string): void => {
			residues.push(finding(row.file, row.node.getStart(row.file.source), ruleId, message, note));
		};
		let refused = false;
		for (const row of rows) {
			const bad = nonLiteralField(row, rowFields(ts, row));
			if (bad !== undefined) {
				residue(
					row,
					ERRORS_HOIST_RULES.rowNotLiteral,
					`Row ${JSON.stringify(code)} has a ${bad} that is not a literal defineErrors can carry; it is left in errorCodes.`,
					"Write status as a number, description/messageKey/fixKey as a string literal and retryable as true/false (or drop a field defineErrors does not declare), then re-run apifuse migrate.",
				);
				refused = true;
			}
		}
		if (refused) {
			declarations.set(code, { kind: "residue" });
			continue;
		}

		if (Object.hasOwn(SDK_ERROR_REGISTRY, code)) {
			const registry = SDK_ERROR_REGISTRY[code as SdkErrorCode];
			for (const row of rows) {
				const statusDiffers = row.status !== undefined && row.status !== registry.status;
				const retryableDiffers =
					row.retryable !== undefined && row.retryable !== registry.retryable;
				if (statusDiffers || retryableDiffers) {
					residue(
						row,
						ERRORS_HOIST_RULES.sdkRowConflict,
						`Row ${JSON.stringify(code)} states a status or retryable that differs from the SDK registry (sdkErrors.${code}: ${registry.status}, retryable ${registry.retryable}); it is left in errorCodes.`,
						`Two choices: (a) accept the SDK value: delete the row and list ${reference(code)} in this operation's errors (the map gets ${mapKey(code)}: sdkErrors.${code}); or (b) declare a distinct provider code for this condition (a deterministic refusal is UPSTREAM_REJECTED: sdkErrors.UPSTREAM_REJECTED, 409 non-retryable; otherwise a provider code with its own status, category and retryable) and throw it at the sites that meant this row. Then re-run apifuse migrate.`,
					);
					refused = true;
				} else if (row.messageKey !== undefined || row.fixKey !== undefined) {
					residue(
						row,
						ERRORS_HOIST_RULES.sdkRowLocaleKeys,
						`Row ${JSON.stringify(code)} carries a messageKey or fixKey that sdkErrors.${code} cannot; it is left in errorCodes.`,
						`Either drop the key (the SDK message applies) and list ${reference(code)}, or declare a distinct provider code that carries the key, then re-run apifuse migrate.`,
					);
					refused = true;
				}
			}
			declarations.set(
				code,
				refused ? { kind: "residue" } : { kind: "sdk", code: code as SdkErrorCode },
			);
			continue;
		}

		if (SDK_RUNTIME_OWNED_ERROR_CODES.has(code)) {
			for (const row of rows) {
				residue(
					row,
					ERRORS_HOIST_RULES.sdkOwnedCode,
					`Row ${JSON.stringify(code)} names a code the SDK runtime throws itself; a provider cannot declare it, so the row is left in errorCodes.`,
					"Delete the row (the SDK serves this code) or throw a provider-owned code for the condition, then re-run apifuse migrate.",
				);
			}
			declarations.set(code, { kind: "residue" });
			continue;
		}

		for (const row of rows) {
			if (row.status === undefined) {
				residue(
					row,
					ERRORS_HOIST_RULES.rowWithoutStatus,
					`Row ${JSON.stringify(code)} states no status; the legacy path served 500 for it, and defineErrors needs the status stated. It is left in errorCodes.`,
					`Add status: <one of ${VALID_OPERATION_ERROR_STATUSES.join(", ")}> to the row, then re-run apifuse migrate.`,
				);
				refused = true;
			} else if (!(VALID_OPERATION_ERROR_STATUSES as readonly number[]).includes(row.status)) {
				residue(
					row,
					ERRORS_HOIST_RULES.statusNotEmittable,
					`Row ${JSON.stringify(code)} states status ${row.status}, which a provider error cannot serve; it is left in errorCodes.`,
					`Set status to one of ${VALID_OPERATION_ERROR_STATUSES.join(", ")}, then re-run apifuse migrate.`,
				);
				refused = true;
			}
			if (row.descriptionValue === undefined || row.descriptionValue.trim().length === 0) {
				residue(
					row,
					ERRORS_HOIST_RULES.rowWithoutDescription,
					`Row ${JSON.stringify(code)} has no description; defineErrors publishes one per code. It is left in errorCodes.`,
					"Add a one-sentence English description to the row, then re-run apifuse migrate.",
				);
				refused = true;
			}
		}
		if (refused) {
			declarations.set(code, { kind: "residue" });
			continue;
		}

		const served = (row: Row): string =>
			JSON.stringify([row.status, row.retryable ?? false, row.messageKey, row.fixKey]);
		const first = rows[0] as Row;
		const variants = new Map<string, Row>();
		for (const row of rows) if (!variants.has(served(row))) variants.set(served(row), row);
		if (variants.size > 1) {
			const where = [...variants.values()]
				.map((row) => {
					const at = finding(row.file, row.node.getStart(row.file.source), "", "");
					return `${at.file}:${at.line} (status ${row.status}, retryable ${row.retryable ?? false}${row.messageKey === undefined ? "" : `, messageKey ${row.messageKey}`}${row.fixKey === undefined ? "" : `, fixKey ${row.fixKey}`})`;
				})
				.join("; ");
			for (const row of rows) {
				residue(
					row,
					ERRORS_HOIST_RULES.codeConflict,
					`Code ${JSON.stringify(code)} is declared with different status, retryable or locale keys across operations: ${where}. One defineErrors entry serves one contract, so every row of this code is left in errorCodes.`,
					"Give each distinct contract its own code (or unify the rows), then re-run apifuse migrate.",
				);
			}
			declarations.set(code, { kind: "residue" });
			continue;
		}

		const existingEntry = existing?.entries.get(code);
		if (existingEntry !== undefined) {
			const same =
				!existingEntry.sdk &&
				(existingEntry.status === undefined || existingEntry.status === first.status) &&
				(existingEntry.retryable === undefined ||
					existingEntry.retryable === (first.retryable ?? false));
			if (!same) {
				for (const row of rows) {
					residue(
						row,
						ERRORS_HOIST_RULES.declaredDifferently,
						`Code ${JSON.stringify(code)} is already declared in ${existing?.file.path} with a different status or retryable; the row is left in errorCodes.`,
						`Make the row and the map entry agree (or give this condition its own code), then re-run apifuse migrate.`,
					);
				}
				declarations.set(code, { kind: "residue" });
				continue;
			}
		}

		for (const row of rows) {
			if (row.descriptionValue !== first.descriptionValue) {
				const at = finding(first.file, first.node.getStart(first.file.source), "", "");
				notes.push(
					finding(
						row.file,
						row.node.getStart(row.file.source),
						ERRORS_HOIST_RULES.descriptionDropped,
						`Code ${JSON.stringify(code)} is declared once with the description from ${at.file}:${at.line}; this operation's own wording ${JSON.stringify(row.descriptionValue ?? "")} is dropped.`,
					),
				);
			}
		}

		const stated = rows.map((row) => row.category).find((value) => value !== undefined);
		let category: string;
		if (stated !== undefined) {
			category = stated;
		} else {
			const served = categoryServedBySites(code, first.status as number, sites);
			category = served.category;
			if (served.fromSites) {
				notes.push(categoryFromSitesNote(first.file, first.node, code, served));
			}
		}

		declarations.set(code, {
			kind: "provider",
			code,
			status: first.status as number,
			retryable: first.retryable ?? false,
			category,
			descriptionText: first.descriptionText as string,
			...(first.messageKey === undefined ? {} : { messageKey: first.messageKey }),
			...(first.fixKey === undefined ? {} : { fixKey: first.fixKey }),
			comments: commentsAround(ts, first.file, first.node),
		});
	}
	return declarations;
}

/** The category the server reports for a declaration that states none. */
function fallbackCategory(status: number | undefined): string {
	return status !== undefined && REJECTION_STATUSES.has(status)
		? "upstream_rejected"
		: "provider_error";
}

/**
 * What a site that states no category served under a declaration without
 * one (serve-implementation's per-constructor default); undefined for a
 * `TransportError`, whose category the server derives from the transport
 * failure, so no declared value can equal it.
 */
function categoryServedByBareSite(site: ThrowSite, status: number | undefined): string | undefined {
	switch (site.constructor) {
		case "TransportError":
			return undefined;
		case "ValidationError":
			if (status !== undefined && REJECTION_STATUSES.has(status)) return "upstream_rejected";
			return status !== undefined && status >= 500 ? "provider_error" : "input_validation";
		case "SessionExpiredError":
			return "credential_expired";
		default:
			return fallbackCategory(status);
	}
}

/** What one site served for its category: its literal, else the bare default; undefined when it cannot be known. */
function categoryServedBySite(site: ThrowSite, status: number | undefined): string | undefined {
	if (site.category !== undefined) return site.category;
	if (site.categoryStated) return undefined;
	return categoryServedByBareSite(site, status);
}

type ServedCategory = {
	readonly category: string;
	/** True when every site served one value that differs from the status fallback. */
	readonly fromSites: boolean;
	readonly sites: number;
};

/**
 * The category a declaration for `code` must state so that every throw site
 * keeps serving what it served: the one value all sites served (a literal
 * per-throw category, or the serve default for a site without one), else the
 * serve default for the status, with each site that served something else
 * reported by `resolveThrowSites`. A site whose category cannot be known (a
 * variable, a transport-derived value) never decides it.
 */
function categoryServedBySites(code: string, status: number | undefined, sites: ThrowSites): ServedCategory {
	const fallback = fallbackCategory(status);
	const served = new Set<string>();
	let counted = 0;
	for (const site of sites.get(code) ?? []) {
		const value = categoryServedBySite(site, status);
		if (value === undefined) return { category: fallback, fromSites: false, sites: 0 };
		served.add(value);
		counted += 1;
	}
	if (served.size !== 1) return { category: fallback, fromSites: false, sites: 0 };
	const [only] = served;
	return { category: only as string, fromSites: only !== fallback, sites: counted };
}

function categoryFromSitesNote(
	file: ProviderSourceFile,
	node: TS.Node,
	code: string,
	served: ServedCategory,
): MigrateFinding {
	return finding(
		file,
		node.getStart(file.source),
		ERRORS_HOIST_RULES.categoryFromSites,
		`Code ${JSON.stringify(code)} is declared with category ${JSON.stringify(served.category)}, the value its ${served.sites} throw site${served.sites === 1 ? "" : "s"} served.`,
	);
}

/**
 * Every `new ProviderError(...)` (or subclass) site that names a code
 * literally, as written before this run's rewrites, plus each
 * `errors.CODE({...})` errors-factory already produced from a bare site
 * (it serves the declaration, which a bare site always did). By code.
 */
function collectThrowSites(ts: TypeScriptModule, sources: readonly ProviderSourceFile[]): ThrowSites {
	const out = new Map<string, ThrowSite[]>();
	const add = (site: ThrowSite): void => {
		const list = out.get(site.code) ?? [];
		list.push(site);
		out.set(site.code, list);
	};
	for (const file of sources) {
		const visit = (node: TS.Node): void => {
			if (
				ts.isNewExpression(node) &&
				ts.isIdentifier(node.expression) &&
				ERROR_CONSTRUCTORS.has(node.expression.text)
			) {
				const options = node.arguments?.[1];
				if (options !== undefined && ts.isObjectLiteralExpression(options)) {
					const codePair = propertyOf(ts, options, "code");
					const code = codePair === undefined ? undefined : literalString(ts, codePair.initializer);
					if (code !== undefined) {
						const category = propertyOf(ts, options, "category");
						const retryable = propertyOf(ts, options, "retryable");
						const categoryValue =
							category === undefined ? undefined : literalString(ts, category.initializer);
						const retryableValue =
							retryable === undefined ? undefined : literalBoolean(ts, retryable.initializer);
						const shorthand = options.properties.some(
							(property) =>
								ts.isShorthandPropertyAssignment(property) &&
								(property.name.text === "category" || property.name.text === "retryable"),
						);
						const categoryStated =
							category !== undefined ||
							options.properties.some(
								(property) =>
									ts.isShorthandPropertyAssignment(property) && property.name.text === "category",
							);
						add({
							file,
							node,
							constructor: node.expression.text,
							code,
							options,
							...(categoryValue === undefined ? {} : { category: categoryValue }),
							...(retryableValue === undefined ? {} : { retryable: retryableValue }),
							dynamic:
								shorthand ||
								(category !== undefined && categoryValue === undefined) ||
								(retryable !== undefined && retryableValue === undefined),
							categoryStated,
							localeKey:
								propertyOf(ts, options, "messageKey") !== undefined ||
								propertyOf(ts, options, "fixKey") !== undefined,
							bindsScope: insideFunctionBinding(ts, node, MAP_NAME),
							shadowed: shadowedByLocalBinding(ts, node, MAP_NAME),
						});
					}
				}
			} else if (
				ts.isCallExpression(node) &&
				(ts.isPropertyAccessExpression(node.expression) ||
					ts.isElementAccessExpression(node.expression)) &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === MAP_NAME &&
				!shadowedByLocalBinding(ts, node, MAP_NAME)
			) {
				const code = ts.isPropertyAccessExpression(node.expression)
					? node.expression.name.text
					: literalString(ts, node.expression.argumentExpression);
				if (code !== undefined) {
					add({
						file,
						node,
						constructor: "factory",
						code,
						dynamic: false,
						categoryStated: false,
						localeKey: false,
						bindsScope: false,
						shadowed: false,
					});
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file.source);
	}
	return out;
}

/** True when errors-factory rule 1 leaves this `new ProviderError` site to this step: a registered code (the provider's row for it may differ from the registry), or a provider-owned code stating a literal category or retryable. */
function factoryLeavesSite(ts: TypeScriptModule, node: TS.NewExpression): boolean {
	const options = node.arguments?.[1];
	if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
	const codePair = propertyOf(ts, options, "code");
	const code = codePair === undefined ? undefined : literalString(ts, codePair.initializer);
	if (code === undefined) return false;
	if (Object.hasOwn(SDK_ERROR_REGISTRY, code)) return true;
	for (const name of ["category", "retryable"]) {
		const pair = propertyOf(ts, options, name);
		if (pair === undefined) continue;
		const value = unwrapExpression(ts, pair.initializer);
		if (
			value.kind === ts.SyntaxKind.TrueKeyword ||
			value.kind === ts.SyntaxKind.FalseKeyword ||
			ts.isStringLiteral(value)
		) {
			return true;
		}
	}
	return false;
}

function isFunctionLike(ts: TypeScriptModule, node: TS.Node): node is TS.SignatureDeclaration {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

/** Every identifier a binding name (a plain name or a destructuring pattern) binds. */
function boundNames(ts: TypeScriptModule, name: TS.BindingName, out: Set<string>): void {
	if (ts.isIdentifier(name)) {
		out.add(name.text);
		return;
	}
	for (const element of name.elements) {
		if (ts.isBindingElement(element)) boundNames(ts, element.name, out);
	}
}

/** The names a scope node binds directly: its parameters, its own variable statements, its catch variable, its loop initializer. Nested functions are not entered. */
function namesBoundBy(ts: TypeScriptModule, scope: TS.Node): Set<string> {
	const out = new Set<string>();
	if (isFunctionLike(ts, scope)) {
		for (const parameter of scope.parameters) boundNames(ts, parameter.name, out);
		return out;
	}
	if (ts.isCatchClause(scope)) {
		if (scope.variableDeclaration !== undefined) boundNames(ts, scope.variableDeclaration.name, out);
		return out;
	}
	const declarations = (list: TS.ForInitializer | undefined): void => {
		if (list !== undefined && ts.isVariableDeclarationList(list)) {
			for (const declaration of list.declarations) boundNames(ts, declaration.name, out);
		}
	};
	if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
		declarations(scope.initializer);
		return out;
	}
	if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
		for (const statement of scope.statements) {
			if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					boundNames(ts, declaration.name, out);
				}
			} else if (
				(ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
				statement.name !== undefined
			) {
				out.add(statement.name.text);
			}
		}
	}
	return out;
}

/** True when a binding named `name` below the top level is in scope at `node`, so `name` there is not the file's import. */
function shadowedByLocalBinding(ts: TypeScriptModule, node: TS.Node, name: string): boolean {
	for (let scope = node.parent; scope !== undefined && !ts.isSourceFile(scope); scope = scope.parent) {
		if (namesBoundBy(ts, scope).has(name)) return true;
	}
	return false;
}

/**
 * True when a function enclosing `node` binds `name` anywhere inside it (a
 * parameter, a local, a destructured name, a catch variable, also in a nested
 * function): the guard errors-factory rule 1 applies, so that site is this
 * step's whether or not the binding really is in scope.
 */
function insideFunctionBinding(ts: TypeScriptModule, node: TS.Node, name: string): boolean {
	for (let scope = node.parent; scope !== undefined && !ts.isSourceFile(scope); scope = scope.parent) {
		if (!isFunctionLike(ts, scope)) continue;
		let found = false;
		const visit = (current: TS.Node): void => {
			if (found) return;
			if (
				(ts.isVariableDeclaration(current) || ts.isParameter(current) || ts.isBindingElement(current)) &&
				ts.isIdentifier(current.name) &&
				current.name.text === name
			) {
				found = true;
				return;
			}
			if (ts.isCatchClause(current) && current.variableDeclaration !== undefined) {
				const names = new Set<string>();
				boundNames(ts, current.variableDeclaration.name, names);
				if (names.has(name)) {
					found = true;
					return;
				}
			}
			ts.forEachChild(current, visit);
		};
		visit(scope);
		if (found) return true;
	}
	return false;
}

/** The view a map entry serves: its category and retryable as defineErrors resolves them. */
function viewOfEntry(code: string, entry: MapEntry): DeclaredView | null {
	if (entry.sdk) {
		const registry = Object.hasOwn(SDK_ERROR_REGISTRY, code)
			? SDK_ERROR_REGISTRY[code as SdkErrorCode]
			: undefined;
		return registry === undefined
			? null
			: {
					status: registry.status,
					category: registry.category,
					retryable: registry.retryable,
					resolved: false,
				};
	}
	if (entry.category === undefined) return null;
	return {
		...(entry.status === undefined ? {} : { status: entry.status }),
		category: entry.category,
		retryable: entry.retryable ?? isRetryableCategory(entry.category as ProviderErrorCategory),
		resolved: false,
	};
}

/**
 * Each provider-owned entry of a defineErrors map that states no category
 * (a table errors-factory converted) gets the category its throw sites
 * served, and `retryable: false` where that category's default would flip
 * the legacy default; in a dry run the table's row stands for the entry.
 * Records the view every map entry serves, for the throw-site pass.
 */
function fillEntryCategories(
	maps: MapsByFile,
	sites: ThrowSites,
	views: Map<string, DeclaredView | null>,
	notes: MigrateFinding[],
	dryRun: boolean,
): { edits: Map<string, FileEdits>; files: string[]; rewrites: number } {
	const edits = new Map<string, FileEdits>();
	const files = new Set<string>();
	let rewrites = 0;
	const record = (code: string, view: DeclaredView | null): void => {
		const known = views.get(code);
		if (known === undefined) {
			views.set(code, view);
		} else if (
			known === null ||
			view === null ||
			known.category !== view.category ||
			known.retryable !== view.retryable
		) {
			// Two maps declaring one code differently: no single answer.
			views.set(code, null);
		}
	};
	for (const [, byName] of maps) {
		for (const [, info] of byName) {
			for (const [code, entry] of info.codes) {
				if (entry.sdk || Object.hasOwn(SDK_ERROR_REGISTRY, code) || isSdkOwnedCode(code)) {
					record(code, viewOfEntry(code, entry));
					continue;
				}
				if (entry.category !== undefined || entry.status === undefined) {
					record(code, viewOfEntry(code, entry));
					continue;
				}
				// A table still an array after the apply is one errors-factory did not
				// convert: nothing to fill. In a dry run the table stands for the map.
				if (info.table && !dryRun) {
					record(code, viewOfEntry(code, entry));
					continue;
				}
				const served = categoryServedBySites(code, entry.status, sites);
				const writeRetryable =
					entry.retryable === undefined &&
					isRetryableCategory(served.category as ProviderErrorCategory);
				record(code, {
					status: entry.status,
					category: served.category,
					retryable: entry.retryable ?? false,
					resolved: true,
				});
				files.add(info.file.path);
				rewrites += 1;
				if (served.fromSites && entry.node !== undefined) {
					notes.push(categoryFromSitesNote(info.file, entry.node, code, served));
				}
				if (info.table || entry.node === undefined) continue;
				editsFor(edits, info.file).push(
					...entryCategoryEdits(info.file, entry.node, served.category, writeRetryable),
				);
			}
		}
	}
	return { edits, files: [...files], rewrites };
}

function entryCategoryEdits(
	file: ProviderSourceFile,
	node: TS.ObjectLiteralExpression,
	category: string,
	writeRetryable: boolean,
): TextEdit[] {
	const first = node.properties[0];
	if (first === undefined) return [];
	const text = file.text;
	const at = first.getStart(file.source);
	const fields = [
		`category: ${JSON.stringify(category)}`,
		...(writeRetryable ? ["retryable: false"] : []),
	];
	const multiline = text.slice(node.getStart(file.source) + 1, at).includes("\n");
	const separator = multiline ? `,\n${lineIndentAt(text, at)}` : ", ";
	return [{ start: at, end: at, text: `${fields.join(separator)}${separator}` }];
}

/**
 * The throw sites errors-factory leaves to this step: a `new ProviderError`
 * of a provider-owned code stating a literal category/retryable, or one
 * inside a function that binds `errors`. A site whose values equal what the
 * declaration serves becomes a reference (rewritten once the map is known);
 * every other site is a residue naming both values and stays as written. A
 * subclass site (`AuthError`, `ValidationError`, ...) is never rewritten; it
 * is reported when the declaration serves something else than it did.
 */
function resolveThrowSites(
	sites: ThrowSites,
	views: ReadonlyMap<string, DeclaredView | null>,
	rowConflicts: ReadonlySet<string>,
	residues: MigrateFinding[],
): Map<string, Reference[]> {
	const items = new Map<string, Reference[]>();
	const rewrite = (site: ThrowSite, code: string): void => {
		const fileItems = items.get(site.file.path) ?? [];
		fileItems.push({ node: site.node, code, site });
		items.set(site.file.path, fileItems);
	};
	const shadowedResidue = (site: ThrowSite, code: string, at: number): MigrateFinding =>
		finding(
			site.file,
			at,
			ERRORS_HOIST_RULES.throwSiteShadowed,
			`Throw site of ${JSON.stringify(code)} sits where a local \`${MAP_NAME}\` binding is in scope, so ${reference(code)}(...) here would not reach the map; it is left as new ProviderError(...).`,
			`Rename the local \`${MAP_NAME}\`, then re-run apifuse migrate.`,
		);
	for (const [code, list] of sites) {
		if (Object.hasOwn(SDK_ERROR_REGISTRY, code)) {
			// A registered code: the site serves the registry unless a row of this
			// provider departs from it, in which case it serves that row and stays.
			const registry = SDK_ERROR_REGISTRY[code as SdkErrorCode];
			for (const site of list) {
				if (site.constructor !== "ProviderError" || site.localeKey || site.dynamic) continue;
				if (
					(site.category !== undefined && site.category !== registry.category) ||
					(site.retryable !== undefined && site.retryable !== registry.retryable)
				) {
					continue; // errors-factory-throw-site-registry-conflict names it
				}
				const at = site.node.getStart(site.file.source);
				if (rowConflicts.has(code)) {
					residues.push(
						finding(
							site.file,
							at,
							ERRORS_HOIST_RULES.throwSiteRowConflict,
							`Throw site of ${JSON.stringify(code)} serves this provider's own row for ${code}, which states a status, retryable or locale key that differs from the SDK registry (sdkErrors.${code}: ${registry.status}, retryable ${registry.retryable}); ${reference(code)}(...) would serve the registry, so the site is left as new ProviderError(...).`,
							`Two choices: (a) accept the registry value: make every row of ${code} the registry's (sdkErrors.${code}, no own status, retryable or locale key) and re-run apifuse migrate; or (b) declare a distinct provider code for this condition (its own status, category and retryable) and throw it here.`,
						),
					);
				} else if (site.shadowed) {
					residues.push(shadowedResidue(site, code, at));
				} else {
					rewrite(site, code);
				}
			}
			continue;
		}
		if (isSdkOwnedCode(code)) continue;
		const view = views.get(code);
		for (const site of list) {
			if (site.constructor === "factory" || site.localeKey) continue;
			const at = site.node.getStart(site.file.source);
			const own =
				site.constructor === "ProviderError" &&
				!site.dynamic &&
				(site.category !== undefined || site.retryable !== undefined || site.bindsScope);
			if (view === undefined || view === null) {
				if (own) {
					residues.push(
						finding(
							site.file,
							at,
							ERRORS_HOIST_RULES.throwSiteUndeclared,
							view === null
								? `Throw site of ${JSON.stringify(code)}: the maps of this provider declare ${code} with different values, so what it serves cannot be checked; it is left as new ProviderError(...).`
								: `Throw site of ${JSON.stringify(code)}: no defineErrors map in this provider declares ${code} to check what it serves against; it is left as new ProviderError(...).`,
							`Declare ${code} once in the provider's defineErrors map (status, the category and retryable this site states, description), then re-run apifuse migrate.`,
						),
					);
				}
				continue;
			}
			const servedCategory = site.dynamic ? undefined : categoryServedBySite(site, view.status);
			const categoryDiffers =
				!site.dynamic && servedCategory !== undefined && servedCategory !== view.category;
			const retryableDiffers = site.retryable !== undefined && site.retryable !== view.retryable;
			if (own) {
				if (site.shadowed) {
					residues.push(shadowedResidue(site, code, at));
				} else if (categoryDiffers || retryableDiffers) {
					residues.push(throwSiteConflict(site, view, at, servedCategory));
				} else {
					rewrite(site, code);
				}
				continue;
			}
			if (site.constructor === "ProviderError") continue;
			// A subclass site keeps its own per-throw value; a bare one serves the
			// declaration, so it is reported on the run that gives the declaration
			// a category it did not have (a map that already stated one served it
			// to this site before).
			if (!site.categoryStated && !view.resolved) {
				if (retryableDiffers) residues.push(throwSiteConflict(site, view, at, servedCategory));
				continue;
			}
			if (site.category === undefined && !site.dynamic && servedCategory === undefined) {
				residues.push(
					finding(
						site.file,
						at,
						ERRORS_HOIST_RULES.throwSiteDerivedCategory,
						`This ${site.constructor} site of ${JSON.stringify(code)} states no category, so the server derived one from the transport failure; the declaration now states ${JSON.stringify(view.category)}, which this site will serve instead.`,
						`State the category this site means (category: "..." here, for one more release) or throw a distinct code declared with it, then re-run apifuse migrate.`,
					),
				);
			} else if (categoryDiffers || retryableDiffers) {
				residues.push(throwSiteConflict(site, view, at, servedCategory));
			}
		}
	}
	return items;
}

function throwSiteConflict(
	site: ThrowSite,
	view: DeclaredView,
	at: number,
	servedCategory: string | undefined,
): MigrateFinding {
	const stated = [
		...(site.category !== undefined
			? [`category ${JSON.stringify(site.category)}`]
			: servedCategory !== undefined && servedCategory !== view.category
				? [`category ${JSON.stringify(servedCategory)} (the ${site.constructor} default)`]
				: []),
		...(site.retryable !== undefined ? [`retryable ${site.retryable}`] : []),
	].join(" and ");
	const declared = `category ${JSON.stringify(view.category)}, retryable ${view.retryable}`;
	const kept =
		site.constructor === "ProviderError"
			? "it is left as new ProviderError(...) and keeps serving its own value"
			: `it is left as new ${site.constructor}(...) and keeps serving its own value for one more release`;
	return finding(
		site.file,
		at,
		ERRORS_HOIST_RULES.throwSiteConflict,
		`Throw site of ${JSON.stringify(site.code)} serves ${stated}, and the declaration serves ${declared}; ${kept}.`,
		"Two choices: (a) accept the declared value: delete the per-throw category/retryable here and re-run apifuse migrate; or (b) declare a distinct code for this condition in the defineErrors map (its own status, category and retryable) and throw that factory here.",
	);
}

/** The `errors.CODE({ message, ...rest })` text errors-factory rule 1 writes, under the map name the file reaches the code by. */
function throwSiteEdit(ts: TypeScriptModule, site: ThrowSite, mapName: string): TextEdit {
	const node = site.node as TS.NewExpression;
	const file = site.file;
	const message = node.arguments?.[0];
	const options = site.options as TS.ObjectLiteralExpression;
	const messageText =
		message === undefined ? '""' : file.text.slice(message.getStart(file.source), message.end);
	const rest = options.properties
		.filter((property) => {
			if (!ts.isPropertyAssignment(property)) return true;
			const name = propertyName(ts, property.name);
			return name !== "code" && name !== "category" && name !== "retryable";
		})
		.map((property) => file.text.slice(property.getStart(file.source), property.end));
	const accessor = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(site.code)
		? `${mapName}.${site.code}`
		: `${mapName}[${JSON.stringify(site.code)}]`;
	return {
		start: node.getStart(file.source),
		end: node.end,
		text: `${accessor}({ message: ${messageText}${rest.length === 0 ? "" : `, ${rest.join(", ")}`} })`,
	};
}

/**
 * Every name that is a `defineErrors` map, or will be once `errors-factory`
 * runs (a `const NAME = [...]` whose rows carry `code` and `status`: rule 3's
 * own match), by file. The second form keeps a dry run, where the table is
 * still an array, reporting what the apply does.
 */
/** Per file, each defineErrors map (or a table the factory converts) by name: its entries by code, and whether it is still a table. */
type MapInfo = {
	readonly file: ProviderSourceFile;
	readonly codes: Map<string, MapEntry>;
	readonly table: boolean;
};
type MapsByFile = Map<string, Map<string, MapInfo>>;

function defineErrorsMaps(
	ts: TypeScriptModule,
	sources: readonly ProviderSourceFile[],
): MapsByFile {
	const out: MapsByFile = new Map();
	for (const file of sources) {
		const names = new Map<string, MapInfo>();
		for (const statement of file.source.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			for (const declaration of statement.declarationList.declarations) {
				const initializer =
					declaration.initializer === undefined
						? undefined
						: unwrapExpression(ts, declaration.initializer);
				if (!ts.isIdentifier(declaration.name) || initializer === undefined) continue;
				const isMap =
					ts.isCallExpression(initializer) &&
					ts.isIdentifier(initializer.expression) &&
					initializer.expression.text === "defineErrors";
				let codes = new Map<string, MapEntry>();
				if (isMap) {
					const object = initializer.arguments[0];
					if (object !== undefined && ts.isObjectLiteralExpression(object)) {
						codes = existingEntries(ts, object);
					}
				}
				let isConvertibleTable = false;
				if (ts.isArrayLiteralExpression(initializer)) {
					for (const element of initializer.elements) {
						const row = unwrapExpression(ts, element);
						if (
							ts.isObjectLiteralExpression(row) &&
							hasProperty(ts, row, "code") &&
							hasProperty(ts, row, "status")
						) {
							isConvertibleTable = true;
							const code = propertyOf(ts, row, "code");
							const value = code === undefined ? undefined : literalString(ts, code.initializer);
							// A registered row becomes `sdkErrors.X` when its values equal the
							// registry's; the view is the registry's either way it loads. A
							// 409/410/422 row gets `upstream_rejected` from rule 3 (rejection-row).
							if (value !== undefined) {
								const fields = entryFields(ts, row);
								codes.set(
									value,
									Object.hasOwn(SDK_ERROR_REGISTRY, value) &&
										!rowDepartsFromRegistry(value as SdkErrorCode, fields)
										? { sdk: true }
										: {
												...fields,
												...(fields.category === undefined &&
												fields.status !== undefined &&
												REJECTION_STATUSES.has(fields.status)
													? { category: "upstream_rejected" }
													: {}),
												sdk: false,
												node: row,
											},
								);
							}
						}
					}
				}
				if (isMap || isConvertibleTable) {
					names.set(declaration.name.text, { file, codes, table: !isMap });
				}
			}
		}
		out.set(file.path, names);
	}
	return out;
}

/** True when `name`, as seen from `file`, is a defineErrors map: declared there, or imported from a file that declares it. */
function isDefineErrorsMap(
	ts: TypeScriptModule,
	maps: MapsByFile,
	file: ProviderSourceFile,
	name: string,
): boolean {
	return mapsInScope(ts, maps, file).has(name);
}

/** The defineErrors maps a file can name: its own, and the ones it imports from a file that declares them; local name -> codes. */
function mapsInScope(
	ts: TypeScriptModule,
	maps: MapsByFile,
	file: ProviderSourceFile,
): Map<string, ReadonlySet<string>> {
	const out = new Map<string, ReadonlySet<string>>();
	for (const [name, entry] of maps.get(file.path) ?? []) out.set(name, new Set(entry.codes.keys()));
	for (const declaration of importsOf(ts, file.source)) {
		const specifier = importSpecifierOf(ts, declaration);
		if (specifier === undefined) continue;
		const target = resolveRelativeImport(file.path, specifier, (candidate) => maps.has(candidate));
		if (target === undefined) continue;
		for (const [local, imported] of namedImportsOf(ts, declaration)) {
			const entry = maps.get(target)?.get(imported);
			if (entry !== undefined && !out.has(local)) out.set(local, new Set(entry.codes.keys()));
		}
	}
	return out;
}

function findExistingMap(
	ts: TypeScriptModule,
	sources: readonly ProviderSourceFile[],
): ExistingMap | undefined {
	const candidates: ExistingMap[] = [];
	for (const file of sources) {
		for (const statement of file.source.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || declaration.name.text !== MAP_NAME) continue;
				const initializer = declaration.initializer;
				if (
					initializer === undefined ||
					!ts.isCallExpression(initializer) ||
					!ts.isIdentifier(initializer.expression) ||
					initializer.expression.text !== "defineErrors"
				) {
					continue;
				}
				const object = initializer.arguments[0];
				if (object === undefined || !ts.isObjectLiteralExpression(object)) continue;
				candidates.push({ file, object, entries: existingEntries(ts, object) });
			}
		}
	}
	candidates.sort(
		(a, b) =>
			Number(b.file.path === DEFAULT_MODULE) - Number(a.file.path === DEFAULT_MODULE) ||
			a.file.path.length - b.file.path.length ||
			a.file.path.localeCompare(b.file.path),
	);
	return candidates[0];
}

function existingEntries(
	ts: TypeScriptModule,
	object: TS.ObjectLiteralExpression,
): Map<string, MapEntry> {
	const out = new Map<string, MapEntry>();
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property)) continue;
		const name = propertyName(ts, property.name);
		if (name === undefined) continue;
		const value = unwrapExpression(ts, property.initializer);
		if (ts.isObjectLiteralExpression(value)) {
			out.set(name, { ...entryFields(ts, value), sdk: false, node: value });
		} else {
			out.set(name, { sdk: true });
		}
	}
	return out;
}

/** The literal status, retryable and category an entry (or a table row) states; a non-literal value reads as absent. */
function entryFields(
	ts: TypeScriptModule,
	value: TS.ObjectLiteralExpression,
): { status?: number; retryable?: boolean; category?: string; localeKey?: boolean } {
	const status = propertyOf(ts, value, "status");
	const retryable = propertyOf(ts, value, "retryable");
	const category = propertyOf(ts, value, "category");
	const localeKey =
		propertyOf(ts, value, "messageKey") !== undefined ||
		propertyOf(ts, value, "fixKey") !== undefined;
	const statusValue = status === undefined ? undefined : literalNumber(ts, status.initializer);
	const retryableValue =
		retryable === undefined ? undefined : literalBoolean(ts, retryable.initializer);
	const categoryValue =
		category === undefined ? undefined : literalString(ts, category.initializer);
	return {
		...(statusValue === undefined ? {} : { status: statusValue }),
		...(retryableValue === undefined ? {} : { retryable: retryableValue }),
		...(categoryValue === undefined ? {} : { category: categoryValue }),
		...(localeKey ? { localeKey } : {}),
	};
}

/** True when a row or entry under a registered key states a status, retryable or locale key the registry's row does not serve. */
function rowDepartsFromRegistry(
	code: SdkErrorCode,
	fields: { status?: number; retryable?: boolean; localeKey?: boolean },
): boolean {
	const registry = SDK_ERROR_REGISTRY[code];
	return (
		(fields.status !== undefined && fields.status !== registry.status) ||
		(fields.retryable !== undefined && fields.retryable !== registry.retryable) ||
		fields.localeKey === true
	);
}

/**
 * The registered codes some row of this provider declares with its own
 * values (an inline row this step refused, a table row or map entry under
 * the registered key): a throw site of such a code serves that row, and
 * `errors.CODE(...)` would serve the registry, so the site stays.
 */
function registryRowConflicts(
	declarations: ReadonlyMap<string, DeclarationOrResidue>,
	maps: MapsByFile,
): Set<string> {
	const out = new Set<string>();
	for (const [code, declaration] of declarations) {
		if (Object.hasOwn(SDK_ERROR_REGISTRY, code) && declaration.kind === "residue") out.add(code);
	}
	for (const byName of maps.values()) {
		for (const info of byName.values()) {
			for (const [code, entry] of info.codes) {
				if (
					!entry.sdk &&
					Object.hasOwn(SDK_ERROR_REGISTRY, code) &&
					rowDepartsFromRegistry(code as SdkErrorCode, entry)
				) {
					out.add(code);
				}
			}
		}
	}
	return out;
}

function listEdits(
	ts: TypeScriptModule,
	list: ErrorList,
	moved: readonly string[],
	kept: readonly TS.Expression[],
): TextEdit[] {
	const text = list.file.text;
	const pairStart = list.pair.getStart(list.file.source);
	const anchorStart = list.anchor.getStart(list.file.source);
	const indent = lineIndentAt(text, anchorStart);
	const unit = indentUnitOf(text);
	const inner = indent + unit;
	const errorsPair = `errors: [\n${moved.map((item) => `${inner}${item},\n`).join("")}${indent}]`;

	const existingErrors = propertyOf(ts, list.operation, "errors");
	if (existingErrors !== undefined) {
		const array = unwrapExpression(ts, existingErrors.initializer);
		if (ts.isArrayLiteralExpression(array)) {
			const present = new Set(
				array.elements.map((element) =>
					text.slice(element.getStart(list.file.source), element.end),
				),
			);
			const additions = moved.filter((item) => !present.has(item));
			const edits: TextEdit[] = [];
			if (additions.length > 0) {
				const last = array.elements[array.elements.length - 1];
				const insertAt = last === undefined ? array.getStart(list.file.source) + 1 : last.end;
				const prefix = last === undefined ? "" : ", ";
				edits.push({ start: insertAt, end: insertAt, text: `${prefix}${additions.join(", ")}` });
			}
			edits.push(...remainingListEdits(list, kept));
			return edits;
		}
	}

	if (kept.length === 0 && list.anchor === list.pair) {
		return [{ start: pairStart, end: list.pair.end, text: errorsPair }];
	}
	return [
		{ start: anchorStart, end: anchorStart, text: `${errorsPair},\n${indent}` },
		...remainingListEdits(list, kept),
	];
}

function remainingListEdits(list: ErrorList, kept: readonly TS.Expression[]): TextEdit[] {
	if (kept.length === list.array.elements.length) return [];
	const text = list.file.text;
	const pairStart = list.pair.getStart(list.file.source);
	if (kept.length === 0) {
		return [{ start: pairStart, end: list.pair.end, text: "" }].map((edit) =>
			dropTrailingComma(text, edit),
		);
	}
	const indent = lineIndentAt(text, pairStart);
	const inner = indent + indentUnitOf(text);
	const body = kept
		.map((element) => `${inner}${text.slice(element.getFullStart(), element.end).trim()},\n`)
		.join("");
	return [
		{
			start: list.array.getStart(list.file.source),
			end: list.array.end,
			text: `[\n${body}${indent}]`,
		},
	];
}

function dropTrailingComma(text: string, edit: TextEdit): TextEdit {
	let end = edit.end;
	while (end < text.length && /[ \t]/.test(text[end] as string)) end += 1;
	if (text[end] === ",") end += 1;
	while (end < text.length && /[ \t]/.test(text[end] as string)) end += 1;
	if (text[end] === "\n") end += 1;
	let start = edit.start;
	while (start > 0 && /[ \t]/.test(text[start - 1] as string)) start -= 1;
	return { ...edit, start, end };
}

function ensureMapImport(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	existing: ExistingMap | undefined,
	residues: MigrateFinding[],
	imports: Map<string, FileEdits>,
): boolean {
	return ensureImport(ts, file, MAP_NAME, existing?.file.path ?? DEFAULT_MODULE, residues, imports);
}

/** Ensures `file` imports `name` from the provider file `fromPath`; false (with a residue) when the name is bound to something else. */
function ensureImport(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	name: string,
	fromPath: string,
	residues: MigrateFinding[],
	imports: Map<string, FileEdits>,
): boolean {
	if (file.path === fromPath) return true;
	const specifier = relativeSpecifier(file.path, fromPath);
	for (const declaration of importsOf(ts, file.source)) {
		const named = namedImportsOf(ts, declaration);
		if (!named.has(name)) continue;
		const from = (importSpecifierOf(ts, declaration) ?? "").replace(/\.[cm]?js$/, "");
		if (named.get(name) === name && from === specifier) return true;
		residues.push(
			finding(
				file,
				declaration.getStart(file.source),
				ERRORS_HOIST_RULES.nameTaken,
				`This file binds \`${name}\` to an import from ${JSON.stringify(importSpecifierOf(ts, declaration) ?? "")}, so its error references cannot use ${name} from ${fromPath}; they are left in place.`,
				"Rename that import, then re-run apifuse migrate.",
			),
		);
		return false;
	}
	for (const statement of file.source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
				residues.push(
					finding(
						file,
						declaration.getStart(file.source),
						ERRORS_HOIST_RULES.nameTaken,
						`This file declares its own \`${name}\`, so its error references cannot use ${name} from ${fromPath}; they are left in place.`,
						"Rename that declaration, then re-run apifuse migrate.",
					),
				);
				return false;
			}
		}
	}
	const pending = imports.get(file.path) ?? { file, edits: [] };
	const line = (() => {
		const style = importStyleOf(ts, file);
		return `import { ${name} } from ${style.quote}${specifier}${style.extension}${style.quote}${style.semi}\n`;
	})();
	if (!pending.edits.some((edit) => edit.text === line)) {
		const at = importInsertionPoint(ts, file);
		pending.edits.push({ start: at, end: at, text: line });
	}
	imports.set(file.path, pending);
	return true;
}

function renderEntry(declaration: Declaration, indent: string, unit: string): string {
	if (declaration.kind === "sdk") {
		return `${indent}${mapKey(declaration.code)}: sdkErrors.${declaration.code},\n`;
	}
	const inner = indent + unit;
	const lines = [
		...declaration.comments.map((comment) => `${indent}${comment}\n`),
		`${indent}${mapKey(declaration.code)}: {\n`,
		`${inner}status: ${declaration.status},\n`,
		`${inner}category: ${JSON.stringify(declaration.category)},\n`,
		`${inner}retryable: ${declaration.retryable},\n`,
		`${inner}description: ${declaration.descriptionText},\n`,
		...(declaration.messageKey === undefined
			? []
			: [`${inner}messageKey: ${JSON.stringify(declaration.messageKey)},\n`]),
		...(declaration.fixKey === undefined
			? []
			: [`${inner}fixKey: ${JSON.stringify(declaration.fixKey)},\n`]),
		`${indent}},\n`,
	];
	return lines.join("");
}

function writeMap(
	ts: TypeScriptModule,
	options: ErrorsHoistOptions,
	sources: readonly ProviderSourceFile[],
	existing: ExistingMap | undefined,
	declarations: readonly Declaration[],
):
	| { readonly file: ProviderSourceFile; readonly edits: TextEdit[]; readonly created?: string }
	| undefined {
	if (declarations.length === 0) return undefined;
	const needsSdk = declarations.some((declaration) => declaration.kind === "sdk");

	if (existing !== undefined) {
		const text = existing.file.text;
		const unit = indentUnitOf(text);
		const objectIndent = lineIndentAt(text, existing.object.getStart(existing.file.source));
		const entryIndent =
			existing.object.properties.length > 0
				? lineIndentAt(
						text,
						(existing.object.properties[0] as TS.ObjectLiteralElementLike).getStart(
							existing.file.source,
						),
					)
				: objectIndent + unit;
		const body = declarations
			.map((declaration) => renderEntry(declaration, entryIndent, unit))
			.join("");
		const last = existing.object.properties[existing.object.properties.length - 1];
		const edits: TextEdit[] = [];
		if (last === undefined) {
			const open = existing.object.getStart(existing.file.source) + 1;
			edits.push({ start: open, end: existing.object.end - 1, text: `\n${body}${objectIndent}` });
		} else {
			const afterLast = text.slice(last.end, existing.object.end);
			const comma = afterLast.indexOf(",");
			const insertAt = comma === -1 ? last.end : last.end + comma + 1;
			const lineEnd = text.indexOf("\n", insertAt);
			const at = lineEnd === -1 || lineEnd > existing.object.end - 1 ? insertAt : lineEnd + 1;
			edits.push({
				start: at,
				end: at,
				text: comma === -1 && at === insertAt ? `,\n${body}` : body,
			});
		}
		edits.push(
			...sdkImportEdits(ts, existing.file, ["defineErrors", ...(needsSdk ? ["sdkErrors"] : [])]),
		);
		return { file: existing.file, edits };
	}

	const absolutePath = join(options.providerRoot, DEFAULT_MODULE);
	const current = sources.find((file) => file.path === DEFAULT_MODULE);
	const unit = current === undefined ? "\t" : indentUnitOf(current.text);
	const body = declarations.map((declaration) => renderEntry(declaration, unit, unit)).join("");
	const block = `export const ${MAP_NAME} = defineErrors({\n${body}});\n`;
	const importLine = `import { defineErrors${needsSdk ? ", sdkErrors" : ""} } from "${SDK_IMPORT}";\n`;

	if (current === undefined) {
		const created = `${importLine}\n${block}`;
		const file: ProviderSourceFile = {
			path: DEFAULT_MODULE,
			absolutePath,
			text: created,
			source: ts.createSourceFile(absolutePath, created, ts.ScriptTarget.Latest, true),
		};
		return { file, edits: [], created };
	}
	const edits: TextEdit[] = [
		...sdkImportEdits(ts, current, ["defineErrors", ...(needsSdk ? ["sdkErrors"] : [])]),
		{
			start: current.text.length,
			end: current.text.length,
			text: `${current.text.endsWith("\n") ? "" : "\n"}\n${block}`,
		},
	];
	return { file: current, edits };
}

function sdkImportEdits(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	wanted: readonly string[],
): TextEdit[] {
	for (const declaration of importsOf(ts, file.source)) {
		if (importSpecifierOf(ts, declaration) !== SDK_IMPORT) continue;
		if (declaration.importClause?.isTypeOnly) continue;
		const bindings = declaration.importClause?.namedBindings;
		if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
		const present = new Set(bindings.elements.map((element) => element.name.text));
		const missing = wanted.filter((name) => !present.has(name));
		if (missing.length === 0) return [];
		const last = bindings.elements[bindings.elements.length - 1];
		if (last === undefined) {
			const open = bindings.getStart(file.source) + 1;
			return [{ start: open, end: open, text: ` ${missing.join(", ")} ` }];
		}
		return [{ start: last.end, end: last.end, text: `, ${missing.join(", ")}` }];
	}
	const style = importStyleOf(ts, file);
	const at = importInsertionPoint(ts, file);
	return [
		{
			start: at,
			end: at,
			text: `import { ${wanted.join(", ")} } from ${style.quote}${SDK_IMPORT}${style.quote}${style.semi}\n`,
		},
	];
}
