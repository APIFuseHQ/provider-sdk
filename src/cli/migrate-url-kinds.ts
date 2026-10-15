import { existsSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import type TS from "typescript";

import { appendPropertyPath, image, itemPage, link } from "../output-url.js";
import {
	collectFixtureStrings,
	imageFileExtension,
	isAbsoluteHttpUrl,
	looksLikeImageFile,
	outputPathMatches,
	urlOrigin,
} from "../output-url-coverage.js";
import { getTypeScript } from "../typescript-module.js";

/**
 * `apifuse migrate-url-kinds`: moves output URL fields to the URL kind helpers
 * (openspec `add-output-url-kinds`, task 2.2). A detector, not a gate:
 *
 * - Declarations reached from an operation's `output` whose name is a fleet
 *   name (`image_url`, `image_urls`, `thumbnail_url`, `thumbnail_urls`, `url`)
 *   and whose recorded fixture values are absolute URLs (or that are declared
 *   `.url()`) become `image()`, `imageList()`, `image({ thumbnail: true })`,
 *   `imageList({ thumbnail: true })` or `itemPage()`. `url` becomes
 *   `itemPage()` only with evidence beyond the name (`itemPageDoubts`),
 *   otherwise it gets a `TODO(url-kind)` marker naming the doubt. The field's own
 *   `.nullable()` is dropped (the helpers admit `null`), `.nullish()` becomes
 *   `.optional()`, `.optional()`/`.describe*()`/`.meta()` are kept.
 * - Mapper assignments it can trace statically (from the handler's return
 *   value, and object literals validated with `<schema>.parse()`) are wrapped
 *   in the matching constructor. The value types point at the ones it missed;
 *   the run reports the type errors its edits introduce.
 * - Other names with absolute-URL evidence get a `TODO(url-kind)` marker.
 *
 * Everything else is listed with the reason it was left alone. A second run
 * changes nothing.
 */

type HelperKind = "image" | "thumbnail" | "imageList" | "thumbnailList" | "itemPage" | "link";

const FLEET_FIELD_HELPERS: ReadonlyMap<string, HelperKind> = new Map([
	["image_url", "image"],
	["thumbnail_url", "thumbnail"],
	["image_urls", "imageList"],
	["thumbnail_urls", "thumbnailList"],
	["url", "itemPage"],
]);

const HELPER_CALL: Readonly<Record<HelperKind, string>> = {
	image: "image()",
	thumbnail: "image({ thumbnail: true })",
	imageList: "imageList()",
	thumbnailList: "imageList({ thumbnail: true })",
	itemPage: "itemPage()",
	link: "link()",
};

const HELPER_IMPORT: Readonly<Record<HelperKind, string>> = {
	image: "image",
	thumbnail: "image",
	imageList: "imageList",
	thumbnailList: "imageList",
	itemPage: "itemPage",
	link: "link",
};

const CONSTRUCTOR: Readonly<Record<HelperKind, string>> = {
	image: "toImageUrl",
	thumbnail: "toImageUrl",
	imageList: "toImageUrls",
	thumbnailList: "toImageUrls",
	itemPage: "toItemPageUrl",
	link: "toLinkUrl",
};

const LIST_HELPERS: ReadonlySet<HelperKind> = new Set(["imageList", "thumbnailList"]);
const LINK_HELPERS: ReadonlySet<HelperKind> = new Set(["itemPage", "link"]);
const HELPER_FUNCTIONS = new Set(["image", "imageList", "itemPage", "link"]);
const CONSTRUCTOR_FUNCTIONS = new Set([
	"toImageUrl",
	"toImageUrls",
	"toItemPageUrl",
	"itemPageFrom",
	"toLinkUrl",
]);
const SDK_MODULES = new Set(["@apifuse/provider-sdk", "@apifuse/provider-sdk/provider"]);
const ZOD_NAMESPACES = new Set(["z", "zod"]);
const PARSE_METHODS = new Set(["parse", "parseAsync", "safeParse", "safeParseAsync"]);
const PASS_THROUGH_ARRAY_METHODS = new Set([
	"filter",
	"slice",
	"concat",
	"sort",
	"toSorted",
	"reverse",
	"toReversed",
	"flat",
	"with",
	"toSpliced",
]);
// Built-ins whose result carries their arguments' properties unchanged.
const PASS_THROUGH_CALLS = new Set([
	"Object.fromEntries",
	"Object.entries",
	"Object.assign",
	"Object.freeze",
	"Array.from",
	"Array.of",
]);
const SKIP_DIRECTORIES = ["node_modules", ".git", "dist", ".worktree", ".worktrees"];
// Words of a parent property that name something other than the item itself
// (`booking_links[].url`, `seller.url`, `nav_items[].url`): its `url` is that
// thing's page, not the item's.
const NON_ITEM_CONTAINER_WORDS = new Set([
	"link",
	"links",
	"related",
	"seller",
	"sellers",
	"shop",
	"shops",
	"store",
	"stores",
	"nav",
	"navigation",
	"menu",
	"menus",
]);
// Words of a sibling property that identify the item the object describes.
const IDENTITY_WORDS = new Set(["id", "name", "title"]);
// Second-level labels registries sell under a two-letter country code
// (`co.jp`, `or.kr`, `com.au`): the site is one label further left.
const COUNTRY_SECOND_LEVEL = new Set([
	"ac",
	"ad",
	"co",
	"com",
	"ed",
	"edu",
	"go",
	"gov",
	"gr",
	"lg",
	"mil",
	"ne",
	"net",
	"or",
	"org",
	"re",
]);
const SDK_PACKAGE = "@apifuse/provider-sdk";
const TODO_MARKER = "TODO(url-kind)";
// Upper bound on the nodes one walk visits, so a pathological call graph ends.
const WALK_BUDGET = 100_000;
const OBJECT_CONSTRUCTORS = new Set(["object", "strictObject", "looseObject", "interface"]);
// Chain methods whose arguments add keys that replace the receiver's.
const EXTENDING_METHODS = new Set(["extend", "safeExtend", "merge"]);

// Single-string chain: kept, dropped (implied by the helper), or refused.
const SINGLE_KEEP = new Set(["optional", "describe", "describeKey", "meta"]);
const SINGLE_DROP = new Set(["url", "nullable", "min", "nonempty", "trim"]);
// imageList() items are never null, so an item's own .nullable() is not implied.
const ELEMENT_DROP = new Set(["url", "min", "nonempty", "trim"]);
const ARRAY_KEEP = new Set([
	"optional",
	"nullable",
	"nullish",
	"describe",
	"describeKey",
	"meta",
	"min",
	"max",
	"length",
	"nonempty",
]);

export type UrlKindSkipReason =
	| "no_url_evidence"
	| "non_url_fixture_value"
	| "insecure_image_fixture"
	| "unpublishable_fixture_value"
	| "unsupported_chain"
	| "shape_mismatch"
	| "kind_ambiguous"
	| "shared_schema"
	| "name_collision"
	| "overlapping_edit";

export type UrlKindFieldRewrite = {
	readonly file: string;
	readonly line: number;
	readonly property: string;
	readonly paths: readonly string[];
	readonly helper: string;
	readonly before: string;
	readonly after: string;
	/** What the author still decides, e.g. a picture host that also serves `http://` elsewhere. */
	readonly notes?: readonly string[];
};

export type UrlKindMapperWrap = {
	readonly file: string;
	readonly line: number;
	readonly property: string;
	readonly constructor: string;
};

/**
 * Why a URL field got a marker instead of a helper: a name the codemod does
 * not map (`other_name`), or a `url` without evidence that it is the item's
 * own page (`item_page_unproven`, the doubts in `detail`).
 */
export type UrlKindTodoReason = "other_name" | "item_page_unproven";

export type UrlKindTodo = {
	readonly file: string;
	readonly line: number;
	readonly property: string;
	readonly paths: readonly string[];
	readonly evidence: string;
	readonly reason: UrlKindTodoReason;
	readonly detail?: string;
};

export type UrlKindSkip = {
	readonly file: string;
	readonly line: number;
	readonly property: string;
	readonly paths: readonly string[];
	readonly reason: UrlKindSkipReason;
	readonly detail: string;
};

export type UrlKindResidual = {
	readonly file: string;
	readonly line: number;
	/** TypeScript diagnostic code (`TS2322` is 2322). */
	readonly code: number;
	readonly message: string;
};

/**
 * Whether the SDK the provider resolves exports what the edits import.
 * `missing`: `@apifuse/provider-sdk` does not resolve (dependencies not
 * installed); `outdated`: it resolves but lacks a helper or constructor (an
 * older pin). Either way nothing is written and the type check does not run.
 */
export type UrlKindSdkCheck = {
	readonly status: "ok" | "missing" | "outdated" | "not-needed";
	readonly version?: string;
	readonly detail?: string;
};

export type MigrateUrlKindsResult = {
	/**
	 * `refused`: nothing was written, see `reason` (not a provider root, an
	 * unreadable tsconfig, no operation found, or an SDK without the helpers
	 * outside `--check`).
	 */
	readonly status: "migrated" | "would-migrate" | "unchanged" | "refused";
	readonly reason?: string;
	readonly operations: number;
	readonly changedFiles: readonly string[];
	readonly rewrites: readonly UrlKindFieldRewrite[];
	readonly mapperWraps: readonly UrlKindMapperWrap[];
	readonly todos: readonly UrlKindTodo[];
	readonly skipped: readonly UrlKindSkip[];
	/** Type errors the edits introduce (a mapper site the codemod could not trace). */
	readonly residual: readonly UrlKindResidual[];
	/** `unresolved`: not run because the SDK precondition failed (see `sdk`). */
	readonly residualCheck: "ran" | "skipped" | "unresolved";
	readonly sdk: UrlKindSdkCheck;
	/** Recoverable `tsconfig.json` diagnostics; the scan ran with what TypeScript could read. */
	readonly configDiagnostics: readonly string[];
};

export type MigrateUrlKindsOptions = {
	/** Compute and report without writing. */
	readonly check?: boolean;
	/** Type-check the result in memory and report the type errors the edits introduce (default true). */
	readonly typecheck?: boolean;
};

type Edit = { readonly start: number; readonly end: number; readonly text: string };

type FieldNode = TS.PropertyAssignment | TS.ShorthandPropertyAssignment;

type Operation = {
	readonly name: string;
	readonly node: TS.ObjectLiteralExpression;
	readonly fixtureStrings: Map<string, string[]>;
};

type Reach = { readonly operation: Operation; readonly path: string };

type ChainCall = { readonly name: string; readonly text: string };

type ParsedField =
	| {
			readonly kind: "string";
			readonly list: boolean;
			readonly declaredUrl: boolean;
			readonly elementMethods: readonly ChainCall[];
			readonly methods: readonly ChainCall[];
			/** `describeKey(<field>, key)` written as a call around the chain. */
			readonly wrap?: { readonly before: string; readonly after: string };
	  }
	| { readonly kind: "helper"; readonly helper: HelperKind }
	| { readonly kind: "other" };

type Env = { readonly id: number; readonly bindings: ReadonlyMap<TS.Symbol, Bound> };
type Bound = { readonly expression: TS.Expression; readonly env: Env };

type ValueWalk = {
	readonly lookup: (path: string) => ReadonlySet<FieldNode> | undefined;
	readonly onSite: (site: FieldNode, fields: ReadonlySet<FieldNode>) => void;
	readonly seen: Set<string>;
};

/** What a schema walk reports. */
type SchemaSink = {
	/** A declaration the output reaches, at `path`. */
	readonly field: (field: FieldNode, path: string) => void;
	/** A projection whose keys the run cannot read: nothing behind it is reached. */
	readonly opaque?: (node: TS.Node, path: string, detail: string) => void;
};

/**
 * The own keys of an object schema the chain around it keeps: those in `only`
 * (a `.pick()`) and not in `except` (an `.omit()`, or a key a later
 * `.extend()`/`.merge()`/property redeclares).
 */
type Keep = { readonly only?: ReadonlySet<string>; readonly except: ReadonlySet<string> };

const KEEP_ALL: Keep = { except: new Set() };

/** A field the run declares with a helper (rewritten now, or already a helper). */
type Target = { readonly helper: HelperKind; readonly label: string | undefined };

const UNKNOWN: unique symbol = Symbol("unknown");

export function migrateUrlKindsRepository(
	providerRoot: string,
	options: MigrateUrlKindsOptions = {},
): MigrateUrlKindsResult {
	const ts = getTypeScript();
	const root = resolve(providerRoot);
	const refused = (reason: string, configDiagnostics: readonly string[] = []) =>
		({
			status: "refused",
			reason,
			operations: 0,
			changedFiles: [],
			rewrites: [],
			mapperWraps: [],
			todos: [],
			skipped: [],
			residual: [],
			residualCheck: "skipped",
			sdk: { status: "not-needed" },
			configDiagnostics,
		}) satisfies MigrateUrlKindsResult;
	if (!existsSync(root) || !statSync(root).isDirectory())
		return refused(`${root} is not a directory.`);
	if (!existsSync(resolve(root, "index.ts")))
		return refused(`${root} has no index.ts; pass the provider repository root.`);
	const created = createProgram(ts, root);
	if ("error" in created) return refused(created.error);
	const { program, configDiagnostics } = created;
	const checker = program.getTypeChecker();
	const analysis = new Analysis(ts, program, checker, root);
	if (!program.getSourceFiles().some((source) => analysis.isProjectFile(source)))
		return refused(`${root} has no TypeScript source file to scan.`, configDiagnostics);
	if (analysis.operations.length === 0)
		return refused(
			`${root} declares no operation (an object with output and a handler or fixtures).`,
			configDiagnostics,
		);
	const plan = analysis.plan();

	const changedTexts = new Map<string, string>();
	for (const [fileName, edits] of plan.edits) {
		const source = program.getSourceFile(fileName);
		if (!source) continue;
		const next = applyEdits(source.text, edits);
		if (next !== source.text) changedTexts.set(fileName, next);
	}
	const changedFiles = [...changedTexts.keys()].map((file) => analysis.display(file)).sort();
	const report = {
		operations: analysis.operations.length,
		changedFiles,
		rewrites: plan.rewrites,
		mapperWraps: plan.mapperWraps,
		todos: plan.todos,
		skipped: plan.skipped,
		configDiagnostics,
	};

	// The edits import helpers and constructors: an SDK that does not export
	// them would turn every edit into a module error, and a type check against
	// it would report those as untraced values.
	const sdk =
		changedTexts.size === 0
			? ({ status: "not-needed" } as const)
			: inspectSdk(ts, program, plan.imports, analysis);
	if (sdk.status === "missing" || sdk.status === "outdated") {
		if (!options.check)
			return {
				...report,
				status: "refused",
				reason: `${sdk.detail} Nothing was written; --check previews the edits.`,
				residual: [],
				residualCheck: "unresolved",
				sdk,
			};
		return {
			...report,
			status: "would-migrate",
			residual: [],
			residualCheck: "unresolved",
			sdk,
		};
	}

	let residual: UrlKindResidual[] = [];
	const typecheck = options.typecheck ?? true;
	if (typecheck && changedTexts.size > 0)
		residual = residualDiagnostics(ts, program, changedTexts, analysis);

	if (!options.check)
		for (const [fileName, text] of changedTexts) writeFileSync(fileName, text, "utf8");

	return {
		...report,
		status: changedTexts.size === 0 ? "unchanged" : options.check ? "would-migrate" : "migrated",
		residual,
		residualCheck: typecheck && changedTexts.size > 0 ? "ran" : "skipped",
		sdk,
	};
}

/**
 * Resolves each module the edits import from (as the provider's own type
 * check would) and checks it exports the names. Reads the version from the
 * resolved package.
 */
function inspectSdk(
	ts: typeof import("typescript"),
	program: TS.Program,
	imports: ReadonlyMap<string, { readonly names: ReadonlySet<string>; readonly from: string }>,
	analysis: Analysis,
): UrlKindSdkCheck {
	const options = program.getCompilerOptions();
	let version: string | undefined;
	const missing: string[] = [];
	for (const [module, { names, from }] of [...imports].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const resolved = ts.resolveModuleName(module, from, options, ts.sys).resolvedModule;
		if (!resolved)
			return {
				status: "missing",
				detail: `${module} does not resolve from ${analysis.display(from)}: install the provider's dependencies (bun install) and rerun.`,
			};
		version ??= resolved.packageId?.version;
		const exported = moduleExports(ts, program, resolved.resolvedFileName);
		for (const name of [...names].sort())
			if (!exported.has(name)) missing.push(`${name} (${module})`);
	}
	const label = `${SDK_PACKAGE}${version ? ` ${version}` : ""}`;
	if (missing.length > 0)
		return {
			status: "outdated",
			...(version ? { version } : {}),
			detail: `${label} does not export ${missing.join(", ")}: bump the provider's SDK pin to a release with the URL kind helpers first, then rerun.`,
		};
	return { status: "ok", ...(version ? { version } : {}) };
}

function moduleExports(
	ts: typeof import("typescript"),
	program: TS.Program,
	fileName: string,
): Set<string> {
	let candidate = program;
	let source = program.getSourceFile(fileName);
	if (!source) {
		candidate = ts.createProgram({
			rootNames: [fileName],
			options: { ...program.getCompilerOptions(), noEmit: true },
		});
		source = candidate.getSourceFile(fileName);
	}
	if (!source) return new Set();
	const checker = candidate.getTypeChecker();
	const symbol = checker.getSymbolAtLocation(source);
	if (!symbol) return new Set();
	return new Set(checker.getExportsOfModule(symbol).map((exported) => exported.name));
}

function createProgram(
	ts: typeof import("typescript"),
	root: string,
): { program: TS.Program; configDiagnostics: string[] } | { error: string } {
	const configPath = resolve(root, "tsconfig.json");
	let rootNames: string[];
	let compilerOptions: TS.CompilerOptions;
	const configDiagnostics: string[] = [];
	if (existsSync(configPath)) {
		let unrecoverable: TS.Diagnostic | undefined;
		const parsed = ts.getParsedCommandLineOfConfigFile(
			configPath,
			{},
			{
				...ts.sys,
				onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
					unrecoverable = diagnostic;
				},
			},
		);
		if (!parsed || unrecoverable)
			return {
				error: `tsconfig.json cannot be read: ${unrecoverable ? ts.flattenDiagnosticMessageText(unrecoverable.messageText, " ") : "no configuration"}.`,
			};
		const diagnostics = ts.getConfigFileParsingDiagnostics(parsed);
		const format = (diagnostic: TS.Diagnostic) =>
			`TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
		// A JSON syntax error (TS1xxx) leaves the configuration half read.
		const syntax = diagnostics.find(
			(diagnostic) => diagnostic.code >= 1000 && diagnostic.code < 2000,
		);
		if (syntax) return { error: `tsconfig.json cannot be parsed: ${format(syntax)}.` };
		for (const diagnostic of diagnostics) configDiagnostics.push(format(diagnostic));
		rootNames = parsed.fileNames;
		compilerOptions = parsed.options;
	} else {
		rootNames = ts.sys.readDirectory(root, [".ts", ".tsx"], SKIP_DIRECTORIES, ["**/*"]);
		compilerOptions = {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			strict: true,
			skipLibCheck: true,
		};
	}
	return {
		program: ts.createProgram({
			rootNames: rootNames.filter((file) => !isSkippedPath(root, file)),
			options: { ...compilerOptions, noEmit: true, resolveJsonModule: true, skipLibCheck: true },
		}),
		configDiagnostics,
	};
}

function isSkippedPath(root: string, fileName: string): boolean {
	const rel = relative(root, fileName);
	if (rel.startsWith("..")) return true;
	return rel.split(sep).some((segment) => SKIP_DIRECTORIES.includes(segment));
}

function isTestPath(rel: string): boolean {
	return /(?:^|\/)__tests__\//.test(rel) || /\.(?:test|spec)\.tsx?$/.test(rel);
}

function applyEdits(text: string, edits: readonly Edit[]): string {
	let next = text;
	for (const edit of [...edits].sort(
		(left, right) => right.start - left.start || right.end - left.end,
	))
		next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
	return next;
}

function diagnosticKey(ts: typeof import("typescript"), diagnostic: TS.Diagnostic): string {
	return `${diagnostic.file?.fileName ?? ""}\u0000${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
}

function residualDiagnostics(
	ts: typeof import("typescript"),
	program: TS.Program,
	changedTexts: ReadonlyMap<string, string>,
	analysis: Analysis,
): UrlKindResidual[] {
	const projectFiles = (candidate: TS.Program) =>
		candidate.getSourceFiles().filter((source) => analysis.isProjectFile(source));
	const collect = (candidate: TS.Program) =>
		projectFiles(candidate).flatMap((source) => [
			...candidate.getSyntacticDiagnostics(source),
			...candidate.getSemanticDiagnostics(source),
		]);
	const before = new Map<string, number>();
	for (const diagnostic of collect(program)) {
		const key = diagnosticKey(ts, diagnostic);
		before.set(key, (before.get(key) ?? 0) + 1);
	}
	const options = program.getCompilerOptions();
	const host = ts.createCompilerHost(options, true);
	const readFile = host.readFile.bind(host);
	const getSourceFile = host.getSourceFile.bind(host);
	host.readFile = (fileName) => changedTexts.get(resolve(fileName)) ?? readFile(fileName);
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
		const text = changedTexts.get(resolve(fileName));
		if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
		return getSourceFile(fileName, languageVersion, onError, shouldCreate);
	};
	const after = ts.createProgram({
		rootNames: program.getRootFileNames(),
		options,
		host,
		oldProgram: program,
	});
	const residual: UrlKindResidual[] = [];
	for (const diagnostic of collect(after)) {
		const key = diagnosticKey(ts, diagnostic);
		const remaining = before.get(key) ?? 0;
		if (remaining > 0) {
			before.set(key, remaining - 1);
			continue;
		}
		const file = diagnostic.file;
		const line =
			file && diagnostic.start !== undefined
				? file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
				: 0;
		const message =
			ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").split("\n")[0] ?? "";
		residual.push({
			file: file ? analysis.display(file.fileName) : "",
			line,
			code: diagnostic.code,
			message: message.length > 240 ? `${message.slice(0, 239)}…` : message,
		});
	}
	return residual.sort(
		(left, right) => left.file.localeCompare(right.file) || left.line - right.line,
	);
}

function publishable(helper: HelperKind, value: string): boolean {
	const schema = helper === "itemPage" ? itemPage() : helper === "link" ? link() : image();
	return schema.safeParse(value).success;
}

function keeps(keep: Keep, name: string): boolean {
	return (keep.only === undefined || keep.only.has(name)) && !keep.except.has(name);
}

/** `inner` inside `outer`: a key survives only where both keep it. */
function narrowKeep(outer: Keep, inner: Keep): Keep {
	if (inner === KEEP_ALL) return outer;
	if (outer === KEEP_ALL) return inner;
	const only =
		outer.only && inner.only
			? new Set([...outer.only].filter((key) => inner.only?.has(key)))
			: (outer.only ?? inner.only);
	return { only, except: new Set([...outer.except, ...inner.except]) };
}

function keepKey(keep: Keep): string {
	if (keep.only === undefined && keep.except.size === 0) return "";
	const only = keep.only ? [...keep.only].sort().join(",") : "*";
	return `${only}-${[...keep.except].sort().join(",")}`;
}

function propertyNameText(
	ts: typeof import("typescript"),
	name: TS.PropertyName,
): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
		return name.text;
	if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression))
		return name.expression.text;
	return undefined;
}

class Analysis {
	readonly operations: Operation[] = [];
	private readonly reaches = new Map<FieldNode, Reach[]>();
	private readonly operationTables = new Map<Operation, Map<string, Set<FieldNode>>>();
	/** Projections in an output whose keys the run cannot read, with the paths reaching them. */
	private readonly unreadable = new Map<TS.Node, { detail: string; paths: Set<string> }>();
	private envCounter = 0;
	private readonly emptyEnv: Env = { id: 0, bindings: new Map() };

	constructor(
		private readonly ts: typeof import("typescript"),
		private readonly program: TS.Program,
		private readonly checker: TS.TypeChecker,
		private readonly root: string,
	) {
		for (const source of this.sourceFiles()) this.findOperations(source);
		for (const operation of this.operations) {
			const output = this.property(operation.node, "output");
			if (!output) continue;
			const table = new Map<string, Set<FieldNode>>();
			this.operationTables.set(operation, table);
			this.walkSchema(output, "", this.emptyEnv, new Set(), {
				field: (field, path) => {
					const reaches = this.reaches.get(field) ?? [];
					if (!reaches.some((reach) => reach.operation === operation && reach.path === path))
						reaches.push({ operation, path });
					this.reaches.set(field, reaches);
					const fields = table.get(path) ?? new Set<FieldNode>();
					fields.add(field);
					table.set(path, fields);
				},
				opaque: (node, path, detail) => {
					const entry = this.unreadable.get(node) ?? { detail, paths: new Set<string>() };
					entry.paths.add(path);
					this.unreadable.set(node, entry);
				},
			});
		}
	}

	display(fileName: string): string {
		return relative(this.root, fileName).split(sep).join("/");
	}

	isProjectFile(source: TS.SourceFile): boolean {
		return (
			!source.isDeclarationFile &&
			!source.fileName.endsWith(".json") &&
			!isSkippedPath(this.root, source.fileName)
		);
	}

	private isRewritableFile(source: TS.SourceFile): boolean {
		return this.isProjectFile(source) && !isTestPath(this.display(source.fileName));
	}

	private sourceFiles(): TS.SourceFile[] {
		return this.program.getSourceFiles().filter((source) => this.isRewritableFile(source));
	}

	private line(node: TS.Node): number {
		const source = node.getSourceFile();
		return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	}

	// -------------------------------------------------------------------------
	// Discovery

	private property(object: TS.ObjectLiteralExpression, name: string): TS.Expression | undefined {
		const ts = this.ts;
		for (const element of object.properties) {
			if (ts.isPropertyAssignment(element) && propertyNameText(ts, element.name) === name)
				return element.initializer;
			if (ts.isShorthandPropertyAssignment(element) && element.name.text === name)
				return element.name;
			if (ts.isMethodDeclaration(element) && propertyNameText(ts, element.name) === name)
				return undefined;
		}
		return undefined;
	}

	private hasMember(object: TS.ObjectLiteralExpression, name: string): boolean {
		const ts = this.ts;
		return object.properties.some(
			(element) =>
				(ts.isPropertyAssignment(element) ||
					ts.isShorthandPropertyAssignment(element) ||
					ts.isMethodDeclaration(element)) &&
				element.name !== undefined &&
				propertyNameText(ts, element.name) === name,
		);
	}

	private findOperations(source: TS.SourceFile): void {
		const ts = this.ts;
		const visit = (node: TS.Node): void => {
			if (
				ts.isObjectLiteralExpression(node) &&
				this.hasMember(node, "output") &&
				(this.hasMember(node, "handler") || this.hasMember(node, "fixtures"))
			) {
				const fixtures = this.property(node, "fixtures");
				const evaluated = fixtures ? this.evaluate(fixtures, 0, new Set()) : UNKNOWN;
				const response =
					evaluated !== null && typeof evaluated === "object" && !Array.isArray(evaluated)
						? (evaluated as Record<string, unknown>).response
						: undefined;
				this.operations.push({
					name: this.operationName(node),
					node,
					fixtureStrings: collectFixtureStrings(response),
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}

	private operationName(node: TS.ObjectLiteralExpression): string {
		const ts = this.ts;
		const id = this.property(node, "id");
		if (id && ts.isStringLiteralLike(id)) return id.text;
		for (let current: TS.Node = node.parent; current; current = current.parent) {
			if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name))
				return current.name.text;
			if (ts.isPropertyAssignment(current)) {
				const name = propertyNameText(ts, current.name);
				if (name) return name;
			}
			if (ts.isSourceFile(current)) break;
		}
		return `${this.display(node.getSourceFile().fileName)}:${this.line(node)}`;
	}

	// -------------------------------------------------------------------------
	// Symbol resolution

	private unwrap(node: TS.Expression): TS.Expression {
		const ts = this.ts;
		let current = node;
		for (;;) {
			if (
				ts.isParenthesizedExpression(current) ||
				ts.isAsExpression(current) ||
				ts.isSatisfiesExpression(current) ||
				ts.isNonNullExpression(current) ||
				ts.isTypeAssertionExpression(current)
			)
				current = current.expression;
			else return current;
		}
	}

	private declarationOf(node: TS.Node): { declaration: TS.Node; symbol: TS.Symbol } | undefined {
		const ts = this.ts;
		let symbol =
			node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
				? this.checker.getShorthandAssignmentValueSymbol(node.parent)
				: this.checker.getSymbolAtLocation(node);
		if (!symbol) return undefined;
		if (symbol.flags & ts.SymbolFlags.Alias) {
			try {
				symbol = this.checker.getAliasedSymbol(symbol);
			} catch {
				return undefined;
			}
		}
		const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
		if (!declaration) return undefined;
		const source = declaration.getSourceFile();
		if (source.fileName.endsWith(".json")) return { declaration, symbol };
		if (!this.isProjectFile(source)) return undefined;
		return { declaration, symbol };
	}

	/** The expression a name stands for: a const initializer, or the argument bound to a parameter. */
	private valueOf(
		node: TS.Expression,
		env: Env,
	): { expression: TS.Expression; env: Env } | undefined {
		const ts = this.ts;
		const resolved = this.declarationOf(node);
		if (!resolved) return undefined;
		const { declaration, symbol } = resolved;
		if (ts.isParameter(declaration)) {
			const bound = env.bindings.get(symbol);
			return bound ? { expression: bound.expression, env: bound.env } : undefined;
		}
		if (ts.isVariableDeclaration(declaration) && declaration.initializer)
			return { expression: declaration.initializer, env: this.emptyEnv };
		if (ts.isPropertyAssignment(declaration))
			return { expression: declaration.initializer, env: this.emptyEnv };
		return undefined;
	}

	private functionOf(node: TS.Expression): TS.SignatureDeclaration | undefined {
		const ts = this.ts;
		const target = this.unwrap(node);
		if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) return target;
		const resolved = this.declarationOf(
			ts.isPropertyAccessExpression(target) ? target.name : target,
		);
		if (!resolved) return undefined;
		const { declaration } = resolved;
		if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))
			return declaration;
		if (
			(ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
			declaration.initializer
		) {
			const initializer = this.unwrap(declaration.initializer);
			if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
				return initializer;
		}
		return undefined;
	}

	private returnsOf(fn: TS.SignatureDeclaration): TS.Expression[] {
		const ts = this.ts;
		const body = (fn as { body?: TS.Node }).body;
		if (!body) return [];
		if (!ts.isBlock(body)) return [body as TS.Expression];
		const out: TS.Expression[] = [];
		const visit = (node: TS.Node): void => {
			if (ts.isFunctionLike(node)) return;
			if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
			ts.forEachChild(node, visit);
		};
		ts.forEachChild(body, visit);
		return out;
	}

	private readonly bindings = new Map<string, Env>();

	/** The environment a call to `fn` runs in: its parameters bound to the call's arguments. */
	private bind(
		fn: TS.SignatureDeclaration,
		args: readonly TS.Expression[],
		env: Env,
		site: TS.Node,
	): Env {
		const ts = this.ts;
		if (fn.parameters.length === 0 || args.length === 0) return env;
		const key = `${this.nodeKey(site, "", env)}`;
		const cached = this.bindings.get(key);
		if (cached) return cached;
		const bindings = new Map<TS.Symbol, Bound>();
		fn.parameters.forEach((parameter, index) => {
			const argument = args[index];
			if (!argument || !ts.isIdentifier(parameter.name)) return;
			const symbol = this.checker.getSymbolAtLocation(parameter.name);
			if (symbol) bindings.set(symbol, { expression: argument, env });
		});
		this.envCounter += 1;
		const bound: Env = { id: this.envCounter, bindings };
		this.bindings.set(key, bound);
		return bound;
	}

	private nodeKey(node: TS.Node, path: string, env: Env, flag = ""): string {
		return `${node.getSourceFile().fileName}:${node.pos}:${node.end}|${path}|${env.id}|${flag}`;
	}

	private isZod(node: TS.Expression): boolean {
		return this.ts.isIdentifier(node) && ZOD_NAMESPACES.has(node.text);
	}

	// -------------------------------------------------------------------------
	// Schema walk: which declarations an operation's output reaches, at which path

	private walkSchema(
		node: TS.Expression,
		path: string,
		env: Env,
		seen: Set<string>,
		sink: SchemaSink,
		keep: Keep = KEEP_ALL,
	): void {
		const ts = this.ts;
		const target = this.unwrap(node);
		const key = this.nodeKey(target, path, env, keepKey(keep));
		if (seen.has(key) || seen.size > WALK_BUDGET || path.split(/\.|\[\]/).length > 40) return;
		seen.add(key);

		if (ts.isObjectLiteralExpression(target)) {
			this.walkShape(target, path, env, seen, sink, keep);
			return;
		}
		if (ts.isIdentifier(target)) {
			const value = this.valueOf(target, env);
			if (value) this.walkSchema(value.expression, path, value.env, seen, sink, keep);
			return;
		}
		if (ts.isPropertyAccessExpression(target)) {
			if (target.name.text === "shape") {
				this.walkSchema(target.expression, path, env, seen, sink, keep);
				return;
			}
			const value = this.valueOf(target.name, env);
			if (value) this.walkSchema(value.expression, path, value.env, seen, sink, keep);
			return;
		}
		if (!ts.isCallExpression(target)) return;
		const callee = this.unwrap(target.expression);
		const args = target.arguments;
		if (ts.isPropertyAccessExpression(callee)) {
			const method = callee.name.text;
			const receiver = callee.expression;
			if (this.isZod(receiver)) {
				switch (method) {
					case "object":
					case "strictObject":
					case "looseObject":
					case "interface":
						if (args[0]) this.walkSchema(args[0], path, env, seen, sink, keep);
						return;
					case "array":
						if (args[0]) this.walkSchema(args[0], `${path}[]`, env, seen, sink);
						return;
					case "tuple": {
						const items = args[0] ? this.unwrap(args[0]) : undefined;
						if (items && ts.isArrayLiteralExpression(items))
							for (const item of items.elements)
								this.walkSchema(item, `${path}[]`, env, seen, sink);
						return;
					}
					case "union":
					case "discriminatedUnion":
					case "xor":
						for (const argument of args) {
							const options = this.unwrap(argument);
							if (ts.isArrayLiteralExpression(options))
								for (const option of options.elements)
									this.walkSchema(option, path, env, seen, sink, keep);
						}
						return;
					case "intersection":
					case "optional":
					case "nullable":
					case "nullish":
					case "readonly":
						for (const argument of args) this.walkSchema(argument, path, env, seen, sink, keep);
						return;
					case "record":
					case "partialRecord": {
						const value = args[1] ?? args[0];
						if (value) this.walkSchema(value, `${path}.*`, env, seen, sink);
						return;
					}
					case "lazy": {
						const fn = args[0] ? this.functionOf(args[0]) : undefined;
						if (fn)
							for (const returned of this.returnsOf(fn))
								this.walkSchema(returned, path, env, seen, sink, keep);
						return;
					}
					default:
						return;
				}
			}
			if (method === "array") {
				this.walkSchema(receiver, `${path}[]`, env, seen, sink);
				return;
			}
			// Only the receiver's keys the method keeps are in the output: not
			// what `.pick()` leaves out or `.omit()` removes, nor what
			// `.extend()`/`.merge()` redeclares.
			const own = this.receiverKeep(method, args, env);
			if (own) this.walkSchema(receiver, path, env, seen, sink, narrowKeep(keep, own));
			else
				sink.opaque?.(
					target,
					path,
					`.${method}() ${EXTENDING_METHODS.has(method) ? "adds keys" : "takes a mask"} this run cannot read; the fields behind it are left alone, migrate them by hand.`,
				);
			if (EXTENDING_METHODS.has(method) || method === "and" || method === "or")
				for (const argument of args) this.walkSchema(argument, path, env, seen, sink, keep);
			return;
		}
		if (ts.isIdentifier(callee) && HELPER_FUNCTIONS.has(callee.text)) return;
		const fn = this.functionOf(callee);
		if (fn) {
			const inner = this.bind(fn, args, env, target);
			for (const returned of this.returnsOf(fn))
				this.walkSchema(returned, path, inner, seen, sink, keep);
			return;
		}
		// A schema wrapper outside the project (field(), untrustedContent(), ...).
		for (const argument of args) this.walkSchema(argument, path, env, seen, sink, keep);
	}

	private walkShape(
		object: TS.ObjectLiteralExpression,
		path: string,
		env: Env,
		seen: Set<string>,
		sink: SchemaSink,
		keep: Keep,
	): void {
		const ts = this.ts;
		const elements = object.properties;
		// A key declared later in the literal, directly or by a spread, replaces
		// an earlier one: each member is walked without the keys after it.
		// `undefined`: a later member whose keys the run cannot read.
		const after: (ReadonlySet<string> | undefined)[] = [];
		let later: Set<string> | undefined = new Set();
		for (let index = elements.length - 1; index >= 0; index -= 1) {
			after[index] = later && new Set(later);
			const element = elements[index];
			// The first member's keys replace nothing.
			if (!later || !element || index === 0) continue;
			const keys = ts.isSpreadAssignment(element)
				? (this.objectKeys(element.expression, env) ?? this.typeKeys(element.expression, false))
				: this.memberName(element);
			if (keys === undefined) {
				sink.opaque?.(
					element,
					path,
					"a member whose keys this run cannot read may replace the fields declared before it; those are left alone, migrate them by hand.",
				);
				later = undefined;
			} else for (const name of typeof keys === "string" ? [keys] : keys) later.add(name);
		}
		elements.forEach((element, index) => {
			const shadowed = after[index];
			if (!shadowed) return;
			const local = narrowKeep(keep, { except: shadowed });
			if (ts.isSpreadAssignment(element)) {
				this.walkSchema(element.expression, path, env, seen, sink, local);
				return;
			}
			const name = this.memberName(element);
			if (name === undefined || !keeps(local, name)) return;
			const childPath = appendPropertyPath(path, name);
			if (ts.isPropertyAssignment(element)) {
				if (this.isRewritableFile(element.getSourceFile())) sink.field(element, childPath);
				this.walkSchema(element.initializer, childPath, env, seen, sink);
				return;
			}
			if (ts.isShorthandPropertyAssignment(element))
				this.walkSchema(element.name, childPath, env, seen, sink);
		});
	}

	private memberName(element: TS.ObjectLiteralElementLike): string | undefined {
		const ts = this.ts;
		if (ts.isShorthandPropertyAssignment(element)) return element.name.text;
		if (ts.isSpreadAssignment(element)) return undefined;
		return propertyNameText(ts, element.name);
	}

	/**
	 * Which of its receiver's own keys a chain method keeps; undefined when the
	 * run cannot read them (a mask or an added schema out of reach).
	 */
	private receiverKeep(method: string, args: readonly TS.Expression[], env: Env): Keep | undefined {
		if (method === "pick" || method === "omit") {
			const mask = args[0] ? this.maskKeys(args[0], env) : undefined;
			if (!mask) return undefined;
			return method === "pick" ? { only: mask, except: new Set() } : { except: mask };
		}
		if (EXTENDING_METHODS.has(method)) {
			const except = new Set<string>();
			for (const argument of args) {
				// `.merge()` takes a schema, `.extend()` a shape.
				const keys = this.objectKeys(argument, env) ?? this.typeKeys(argument, method === "merge");
				if (!keys) return undefined;
				for (const name of keys) except.add(name);
			}
			return { except };
		}
		// An enum of the receiver's key names: none of its fields.
		if (method === "keyof") return { only: new Set(), except: new Set() };
		return KEEP_ALL;
	}

	/**
	 * The keys the type checker gives a shape, or a schema's `shape`, the walk
	 * cannot reach (an SDK or external schema); undefined for an open or
	 * untyped one.
	 */
	private typeKeys(node: TS.Expression, schema: boolean): Set<string> | undefined {
		const ts = this.ts;
		let type = this.checker.getTypeAtLocation(node);
		if (schema) {
			const shape = type.getProperty("shape");
			if (!shape) return undefined;
			type = this.checker.getTypeOfSymbolAtLocation(shape, node);
		}
		if (
			type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
			type.isUnion() ||
			this.checker.getIndexInfosOfType(type).length > 0
		)
			return undefined;
		return new Set(type.getProperties().map((property) => property.name));
	}

	/** The keys a `.pick()`/`.omit()` mask selects; undefined unless it is a literal the run reads. */
	private maskKeys(node: TS.Expression, env: Env): Set<string> | undefined {
		const ts = this.ts;
		let expression = this.unwrap(node);
		let scope = env;
		// A mask passed through a factory's parameter or a constant.
		for (let depth = 0; ts.isIdentifier(expression) && depth < 16; depth += 1) {
			const value = this.valueOf(expression, scope);
			if (!value) return undefined;
			expression = this.unwrap(value.expression);
			scope = value.env;
		}
		if (!ts.isObjectLiteralExpression(expression)) return undefined;
		const keys = new Set<string>();
		for (const element of expression.properties) {
			if (!ts.isPropertyAssignment(element)) return undefined;
			const name = propertyNameText(ts, element.name);
			const selected = this.evaluate(element.initializer, 0, new Set());
			if (name === undefined || typeof selected !== "boolean") return undefined;
			if (selected) keys.add(name);
		}
		return keys;
	}

	/**
	 * The own keys of the object schema or shape `node` stands for; undefined
	 * when part of it is out of reach (an external schema, an unread mask).
	 */
	private objectKeys(node: TS.Expression, env: Env, depth = 0): Set<string> | undefined {
		const ts = this.ts;
		if (depth > 40) return undefined;
		const target = this.unwrap(node);
		if (ts.isObjectLiteralExpression(target)) {
			const keys = new Set<string>();
			for (const element of target.properties) {
				const found = ts.isSpreadAssignment(element)
					? this.objectKeys(element.expression, env, depth + 1)
					: this.memberName(element);
				if (found === undefined) return undefined;
				for (const name of typeof found === "string" ? [found] : found) keys.add(name);
			}
			return keys;
		}
		if (ts.isPropertyAccessExpression(target) && target.name.text === "shape")
			return this.objectKeys(target.expression, env, depth + 1);
		if (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target)) {
			const value = this.valueOf(ts.isIdentifier(target) ? target : target.name, env);
			return value ? this.objectKeys(value.expression, value.env, depth + 1) : undefined;
		}
		if (!ts.isCallExpression(target)) return undefined;
		const callee = this.unwrap(target.expression);
		const args = target.arguments;
		if (ts.isPropertyAccessExpression(callee)) {
			const method = callee.name.text;
			const receiver = callee.expression;
			if (this.isZod(receiver))
				return OBJECT_CONSTRUCTORS.has(method) && args[0]
					? this.objectKeys(args[0], env, depth + 1)
					: undefined;
			if (method === "array") return undefined;
			const own = this.objectKeys(receiver, env, depth + 1);
			const keep = this.receiverKeep(method, args, env);
			if (!own || !keep) return undefined;
			const keys = new Set([...own].filter((name) => keeps(keep, name)));
			// Added keys: what an extend redeclares, and an intersection's other side.
			if (EXTENDING_METHODS.has(method)) for (const name of keep.except) keys.add(name);
			if (method === "and")
				for (const argument of args) {
					const other = this.objectKeys(argument, env, depth + 1);
					if (!other) return undefined;
					for (const name of other) keys.add(name);
				}
			return keys;
		}
		const fn = this.functionOf(callee);
		const returns = fn ? this.returnsOf(fn) : [];
		if (!fn || returns.length === 0) return undefined;
		const inner = this.bind(fn, args, env, target);
		const keys = new Set<string>();
		for (const returned of returns) {
			const found = this.objectKeys(returned, inner, depth + 1);
			if (!found) return undefined;
			for (const name of found) keys.add(name);
		}
		return keys;
	}

	// -------------------------------------------------------------------------
	// Static evaluation of fixture literals

	private evaluate(node: TS.Node, depth: number, active: Set<TS.Node>): unknown {
		const ts = this.ts;
		if (depth > 64 || active.has(node)) return UNKNOWN;
		if (ts.isSourceFile(node)) {
			const statement = node.statements[0];
			return statement && ts.isExpressionStatement(statement)
				? this.evaluate(statement.expression, depth + 1, active)
				: UNKNOWN;
		}
		if (!ts.isExpression(node)) {
			if (ts.isExpressionStatement(node)) return this.evaluate(node.expression, depth + 1, active);
			return UNKNOWN;
		}
		const target = this.unwrap(node);
		active.add(node);
		try {
			if (ts.isStringLiteralLike(target)) return target.text;
			if (ts.isNumericLiteral(target)) return Number(target.text);
			if (target.kind === ts.SyntaxKind.TrueKeyword) return true;
			if (target.kind === ts.SyntaxKind.FalseKeyword) return false;
			if (target.kind === ts.SyntaxKind.NullKeyword) return null;
			if (
				ts.isPrefixUnaryExpression(target) &&
				target.operator === ts.SyntaxKind.MinusToken &&
				ts.isNumericLiteral(target.operand)
			)
				return -Number(target.operand.text);
			if (ts.isTemplateExpression(target)) {
				let text = target.head.text;
				for (const span of target.templateSpans) {
					const value = this.evaluate(span.expression, depth + 1, active);
					if (value === UNKNOWN || (typeof value === "object" && value !== null)) return UNKNOWN;
					text += String(value) + span.literal.text;
				}
				return text;
			}
			if (ts.isObjectLiteralExpression(target)) {
				const out: Record<string, unknown> = {};
				for (const element of target.properties) {
					if (ts.isPropertyAssignment(element)) {
						const name = propertyNameText(ts, element.name);
						if (name !== undefined)
							out[name] = this.evaluate(element.initializer, depth + 1, active);
					} else if (ts.isShorthandPropertyAssignment(element)) {
						out[element.name.text] = this.evaluate(element.name, depth + 1, active);
					} else if (ts.isSpreadAssignment(element)) {
						const spread = this.evaluate(element.expression, depth + 1, active);
						if (spread !== null && typeof spread === "object" && !Array.isArray(spread))
							Object.assign(out, spread);
					}
				}
				return out;
			}
			if (ts.isArrayLiteralExpression(target)) {
				const out: unknown[] = [];
				for (const element of target.elements) {
					if (ts.isSpreadElement(element)) {
						const spread = this.evaluate(element.expression, depth + 1, active);
						if (Array.isArray(spread)) out.push(...spread);
					} else out.push(this.evaluate(element, depth + 1, active));
				}
				return out;
			}
			if (ts.isIdentifier(target)) {
				if (target.text === "undefined") return undefined;
				const resolved = this.declarationOf(target);
				if (!resolved) return UNKNOWN;
				const { declaration } = resolved;
				if (ts.isSourceFile(declaration)) return this.evaluate(declaration, depth + 1, active);
				if (ts.isVariableDeclaration(declaration) && declaration.initializer)
					return this.evaluate(declaration.initializer, depth + 1, active);
				if (declaration.getSourceFile().fileName.endsWith(".json"))
					return this.evaluate(declaration.getSourceFile(), depth + 1, active);
				return UNKNOWN;
			}
			if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
				const key = ts.isPropertyAccessExpression(target)
					? target.name.text
					: ts.isStringLiteralLike(target.argumentExpression) ||
							ts.isNumericLiteral(target.argumentExpression)
						? target.argumentExpression.text
						: undefined;
				if (key === undefined) return UNKNOWN;
				const base = this.evaluate(target.expression, depth + 1, active);
				if (base === null || typeof base !== "object") return UNKNOWN;
				return (base as Record<string, unknown>)[key];
			}
			if (ts.isCallExpression(target)) {
				const callee = this.unwrap(target.expression);
				const name = ts.isIdentifier(callee)
					? callee.text
					: ts.isPropertyAccessExpression(callee)
						? `${callee.expression.getText()}.${callee.name.text}`
						: "";
				// Values a fixture passes through unchanged: a clone, a freeze, or
				// `<schema>.parse({...})` (a generated fixture validated on import).
				const passThrough =
					["structuredClone", "Object.freeze"].includes(name) ||
					(ts.isPropertyAccessExpression(callee) &&
						(callee.name.text === "parse" || callee.name.text === "parseAsync"));
				if (passThrough && target.arguments[0])
					return this.evaluate(target.arguments[0], depth + 1, active);
			}
			return UNKNOWN;
		} finally {
			active.delete(node);
		}
	}

	// -------------------------------------------------------------------------
	// Field declarations

	private parseField(initializer: TS.Expression): ParsedField {
		const ts = this.ts;
		const calls: ChainCall[] = [];
		let current = this.unwrap(initializer);
		if (
			ts.isCallExpression(current) &&
			ts.isIdentifier(current.expression) &&
			current.expression.text === "describeKey" &&
			current.arguments.length >= 2 &&
			current.arguments[0]
		) {
			const inner = this.parseField(current.arguments[0]);
			if (inner.kind !== "string" || inner.wrap) return inner;
			const rest = current.arguments.slice(1).map((argument) => argument.getText());
			return { ...inner, wrap: { before: "describeKey(", after: `, ${rest.join(", ")})` } };
		}
		for (;;) {
			if (!ts.isCallExpression(current)) return { kind: "other" };
			const callee = this.unwrap(current.expression);
			if (ts.isIdentifier(callee)) {
				if (!HELPER_FUNCTIONS.has(callee.text)) return { kind: "other" };
				const thumbnail = current.arguments.some((argument) =>
					/\bthumbnail\s*:\s*true\b/.test(argument.getText()),
				);
				const helper: HelperKind =
					callee.text === "image"
						? thumbnail
							? "thumbnail"
							: "image"
						: callee.text === "imageList"
							? thumbnail
								? "thumbnailList"
								: "imageList"
							: callee.text === "itemPage"
								? "itemPage"
								: "link";
				return { kind: "helper", helper };
			}
			if (!ts.isPropertyAccessExpression(callee)) return { kind: "other" };
			if (this.isZod(callee.expression)) {
				calls.reverse();
				const root = callee.name.text;
				if (root === "string" || root === "url") {
					const arrayAt = calls.findIndex((call) => call.name === "array");
					const declaredUrl = root === "url" || calls.some((call) => call.name === "url");
					if (arrayAt < 0)
						return { kind: "string", list: false, declaredUrl, elementMethods: [], methods: calls };
					return {
						kind: "string",
						list: true,
						declaredUrl,
						elementMethods: calls.slice(0, arrayAt),
						methods: calls.slice(arrayAt + 1),
					};
				}
				if (root === "array" && current.arguments[0]) {
					const element = this.parseField(current.arguments[0]);
					if (element.kind !== "string" || element.list) return { kind: "other" };
					return {
						kind: "string",
						list: true,
						declaredUrl: element.declaredUrl,
						// A describeKey(...) wrapper on the item is item metadata imageList() cannot carry.
						elementMethods: element.wrap
							? [...element.methods, { name: "describeKey", text: "" }]
							: element.methods,
						methods: calls,
					};
				}
				return { kind: "other" };
			}
			const typeArguments = current.typeArguments
				? `<${current.typeArguments.map((argument) => argument.getText()).join(", ")}>`
				: "";
			calls.push({
				name: callee.name.text,
				text: `.${callee.name.text}${typeArguments}(${current.arguments.map((argument) => argument.getText()).join(", ")})`,
			});
			current = this.unwrap(callee.expression);
		}
	}

	/** The name of a project constant holding a plain string schema the field is declared through. */
	private sharedStringSchema(initializer: TS.Expression): string | undefined {
		const ts = this.ts;
		const target = this.unwrap(initializer);
		if (!ts.isIdentifier(target) && !ts.isPropertyAccessExpression(target)) return undefined;
		const value = this.valueOf(
			ts.isPropertyAccessExpression(target) ? target.name : target,
			this.emptyEnv,
		);
		if (!value || this.parseField(value.expression).kind !== "string") return undefined;
		return target.getText();
	}

	/** The rewritten initializer, or the first method the helper cannot carry. */
	private rewriteField(
		parsed: Extract<ParsedField, { kind: "string" }>,
		helper: HelperKind,
	): { text: string } | { unsupported: string } {
		let text = HELPER_CALL[helper];
		if (!parsed.list) {
			let optional = false;
			for (const call of parsed.methods) {
				if (call.name === "nullish" || call.name === "optional") {
					if (!optional) text += ".optional()";
					optional = true;
				} else if (SINGLE_KEEP.has(call.name)) text += call.text;
				else if (!SINGLE_DROP.has(call.name)) return { unsupported: `.${call.name}()` };
			}
			return { text: parsed.wrap ? `${parsed.wrap.before}${text}${parsed.wrap.after}` : text };
		}
		for (const call of parsed.elementMethods)
			if (!ELEMENT_DROP.has(call.name))
				return {
					unsupported: `the list item's own .${call.name}() (imageList() items carry no description; keeping it means writing the list by hand)`,
				};
		for (const call of parsed.methods) {
			if (!ARRAY_KEEP.has(call.name)) return { unsupported: `.${call.name}()` };
			text += call.text;
		}
		return { text: parsed.wrap ? `${parsed.wrap.before}${text}${parsed.wrap.after}` : text };
	}

	// -------------------------------------------------------------------------
	// Value walk: where a mapper builds a declared field

	/**
	 * Walks an expression that becomes (part of) the output value at `path`,
	 * calling `walk.onSite` for every object-literal property that builds a
	 * declared field. `flat` means the expression is an array whose elements
	 * sit at `path`; `projection` is a chain of properties read off the value
	 * (`result.item`) before it lands at `path`.
	 */
	private walkValue(
		node: TS.Expression,
		path: string,
		env: Env,
		walk: ValueWalk,
		flat = false,
		projection: readonly string[] = [],
		awaited = false,
	): void {
		const ts = this.ts;
		let target = this.unwrap(node);
		while (ts.isAwaitExpression(target)) {
			target = this.unwrap(target.expression);
			awaited = true;
		}
		const key = this.nodeKey(target, path, env, `${flat}|${projection.join(".")}`);
		if (walk.seen.has(key) || walk.seen.size > WALK_BUDGET || path.split(/\.|\[\]/).length > 40)
			return;
		walk.seen.add(key);
		const next = (
			child: TS.Expression,
			childPath = path,
			childEnv = env,
			childFlat = false,
			childProjection: readonly string[] = [],
		) => this.walkValue(child, childPath, childEnv, walk, childFlat, childProjection);
		const elementPath = flat ? path : `${path}[]`;

		if (ts.isObjectLiteralExpression(target)) {
			const [picked, ...rest] = projection;
			for (const element of target.properties) {
				if (ts.isSpreadAssignment(element)) {
					next(element.expression, path, env, false, projection);
					continue;
				}
				if (!ts.isPropertyAssignment(element) && !ts.isShorthandPropertyAssignment(element))
					continue;
				const name = propertyNameText(ts, element.name);
				if (name === undefined) continue;
				const value = ts.isPropertyAssignment(element) ? element.initializer : element.name;
				if (picked !== undefined) {
					if (name === picked) next(value, path, env, flat, rest);
					continue;
				}
				const childPath = appendPropertyPath(path, name);
				const fields = walk.lookup(childPath);
				if (fields && this.isRewritableFile(element.getSourceFile())) walk.onSite(element, fields);
				next(value, childPath);
			}
			return;
		}
		if (ts.isArrayLiteralExpression(target)) {
			if (projection.length > 0) return;
			for (const element of target.elements) {
				if (ts.isSpreadElement(element)) next(element.expression, elementPath, env, true);
				else next(element, elementPath);
			}
			return;
		}
		if (ts.isConditionalExpression(target)) {
			next(target.whenTrue, path, env, flat, projection);
			next(target.whenFalse, path, env, flat, projection);
			return;
		}
		if (ts.isBinaryExpression(target)) {
			const operator = target.operatorToken.kind;
			if (
				operator === ts.SyntaxKind.QuestionQuestionToken ||
				operator === ts.SyntaxKind.BarBarToken
			) {
				next(target.left, path, env, flat, projection);
				next(target.right, path, env, flat, projection);
			} else if (operator === ts.SyntaxKind.AmpersandAmpersandToken)
				next(target.right, path, env, flat, projection);
			return;
		}
		if (ts.isPropertyAccessExpression(target)) {
			next(target.expression, path, env, flat, [target.name.text, ...projection]);
			return;
		}
		if (ts.isElementAccessExpression(target)) {
			const argument = target.argumentExpression;
			if (ts.isNumericLiteral(argument))
				// One element of an array: its elements land where this value does.
				next(target.expression, path, env, true, projection);
			else if (ts.isStringLiteralLike(argument))
				next(target.expression, path, env, flat, [argument.text, ...projection]);
			return;
		}
		if (ts.isIdentifier(target)) {
			const value = this.valueOf(target, env);
			if (value) next(value.expression, path, value.env, flat, projection);
			if (projection.length === 0)
				for (const pushed of this.pushesOf(target)) {
					if (ts.isSpreadElement(pushed)) next(pushed.expression, elementPath, env, true);
					else next(pushed, elementPath);
				}
			return;
		}
		if (!ts.isCallExpression(target)) return;
		const callee = this.unwrap(target.expression);
		const args = target.arguments;
		const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
		if (method !== undefined && ts.isPropertyAccessExpression(callee)) {
			if (method === "map" || method === "flatMap") {
				if (projection.length > 0) return;
				const fn = args[0] ? this.functionOf(args[0]) : undefined;
				if (fn)
					for (const returned of this.returnsOf(fn))
						next(returned, elementPath, env, method === "flatMap");
				return;
			}
			if (PARSE_METHODS.has(method)) {
				if (args[0]) next(args[0], path, env, flat, projection);
				return;
			}
			if (PASS_THROUGH_ARRAY_METHODS.has(method)) {
				next(callee.expression, path, env, flat, projection);
				if (method === "concat")
					for (const argument of args) next(argument, path, env, flat, projection);
				return;
			}
			if (method === "find" || method === "findLast" || method === "at") {
				next(callee.expression, path, env, true, projection);
				return;
			}
		}
		const fn = this.functionOf(callee);
		if (fn) {
			// A project function: its return value is the output. Its arguments
			// reach the output only through the parameters the returns read
			// (`compactRecord(record)` returning a copy of `record`), never as such:
			// `mapItem({ image_url: raw })` passes an input the mapper may resolve.
			const inner = this.bind(fn, args, env, target);
			for (const returned of this.returnsOf(fn)) next(returned, path, inner, flat, projection);
			return;
		}
		// Any other call: only built-ins known to return their argument's
		// properties (Object.fromEntries(Object.entries(x)), Object.assign,
		// structuredClone) pass it through. An unknown function may resolve or
		// drop the value, so its arguments are inputs, not the output.
		if (awaited || !this.isPassThroughCall(callee)) return;
		const builtin = ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
		if (builtin === "of") {
			// Array.of(a, b): each argument is one element.
			for (const argument of args) next(argument, elementPath, env, false, projection);
			return;
		}
		if (builtin === "from" && args[1]) {
			// Array.from(source, mapper): the elements are the mapper's returns.
			const mapper = this.functionOf(args[1]);
			if (mapper)
				for (const returned of this.returnsOf(mapper))
					next(returned, elementPath, env, false, projection);
			return;
		}
		for (const argument of args) next(argument, path, env, flat, projection);
	}

	private isPassThroughCall(callee: TS.Expression): boolean {
		const ts = this.ts;
		if (ts.isIdentifier(callee)) return callee.text === "structuredClone";
		return (
			ts.isPropertyAccessExpression(callee) &&
			ts.isIdentifier(callee.expression) &&
			PASS_THROUGH_CALLS.has(`${callee.expression.text}.${callee.name.text}`)
		);
	}

	private readonly pushes = new Map<TS.Symbol, TS.Expression[]>();
	private readonly pushesScanned = new Set<TS.SourceFile>();

	/** Arguments of `<name>.push(...)`/`.unshift(...)` on the same variable or parameter. */
	private pushesOf(name: TS.Identifier): readonly TS.Expression[] {
		const ts = this.ts;
		const resolved = this.declarationOf(name);
		if (!resolved) return [];
		const source = resolved.declaration.getSourceFile();
		if (!this.pushesScanned.has(source)) {
			this.pushesScanned.add(source);
			const visit = (node: TS.Node): void => {
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					(node.expression.name.text === "push" || node.expression.name.text === "unshift") &&
					ts.isIdentifier(node.expression.expression)
				) {
					const symbol = this.declarationOf(node.expression.expression)?.symbol;
					if (symbol) {
						const list = this.pushes.get(symbol) ?? [];
						list.push(...node.arguments);
						this.pushes.set(symbol, list);
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}
		return this.pushes.get(resolved.symbol) ?? [];
	}

	// -------------------------------------------------------------------------
	// Plan

	plan(): {
		edits: Map<string, Edit[]>;
		rewrites: UrlKindFieldRewrite[];
		mapperWraps: UrlKindMapperWrap[];
		todos: UrlKindTodo[];
		skipped: UrlKindSkip[];
		/** Names the edits import, by module, with a file that imports them. */
		imports: Map<string, { names: Set<string>; from: string }>;
	} {
		const ts = this.ts;
		const edits = new Map<string, Edit[]>();
		const rewrites: UrlKindFieldRewrite[] = [];
		const mapperWraps: UrlKindMapperWrap[] = [];
		const todos: UrlKindTodo[] = [];
		const skipped: UrlKindSkip[] = [];
		const neededImports = new Map<string, Set<string>>();
		const targets = new Map<FieldNode, Target>();
		const addEdit = (source: TS.SourceFile, edit: Edit) => {
			const list = edits.get(source.fileName) ?? [];
			list.push(edit);
			edits.set(source.fileName, list);
		};
		const needImport = (source: TS.SourceFile, name: string) => {
			const names = neededImports.get(source.fileName) ?? new Set<string>();
			names.add(name);
			neededImports.set(source.fileName, names);
		};
		const collisions = new Map<string, Set<string>>();
		const collides = (source: TS.SourceFile, name: string): boolean => {
			let names = collisions.get(source.fileName);
			if (!names) {
				names = this.localNames(source);
				collisions.set(source.fileName, names);
			}
			return names.has(name);
		};

		for (const [node, { detail, paths }] of this.unreadable)
			skipped.push({
				file: this.display(node.getSourceFile().fileName),
				line: this.line(node),
				property: "",
				paths: [...paths].sort(),
				reason: "unsupported_chain",
				detail,
			});

		const fields = [...this.reaches.entries()].sort(
			([left], [right]) =>
				left.getSourceFile().fileName.localeCompare(right.getSourceFile().fileName) ||
				left.pos - right.pos,
		);
		for (const [field, reaches] of fields) {
			if (!ts.isPropertyAssignment(field)) continue;
			const name = propertyNameText(ts, field.name);
			if (name === undefined) continue;
			const source = field.getSourceFile();
			const paths = [...new Set(reaches.map((reach) => reach.path))].sort();
			const label = paths.length === 1 ? paths[0] : undefined;
			const parsed = this.parseField(field.initializer);
			if (parsed.kind === "other") {
				const shared = this.sharedStringSchema(field.initializer);
				if (shared && FLEET_FIELD_HELPERS.has(name))
					skipped.push({
						file: this.display(source.fileName),
						line: this.line(field),
						property: name,
						paths,
						reason: "shared_schema",
						detail: `declared through the shared schema ${shared}; declare the helper there by hand once every field using it is the same kind.`,
					});
				continue;
			}
			if (parsed.kind === "helper") {
				targets.set(field, { helper: parsed.helper, label });
				continue;
			}
			const base = {
				file: this.display(source.fileName),
				line: this.line(field),
				property: name,
				paths,
			};
			const values = reaches.flatMap((reach) => {
				const schemaPath = parsed.list ? `${reach.path}[]` : reach.path;
				return [...reach.operation.fixtureStrings]
					.filter(([valuePath]) => outputPathMatches(schemaPath, valuePath))
					.flatMap(([, found]) =>
						found.map((value) => ({ value, where: `${reach.operation.name}:${reach.path}` })),
					);
			});
			// A blank string is not absent to the helpers: they refuse it, so a
			// fixture holding one would stop validating.
			const absolute = values.filter(({ value }) => isAbsoluteHttpUrl(value));
			const nonUrl = values.filter(({ value }) => !isAbsoluteHttpUrl(value));
			const evidence = absolute.length > 0 || parsed.declaredUrl;
			const helper = FLEET_FIELD_HELPERS.get(name);

			if (helper === undefined) {
				if (!evidence || nonUrl.length > 0) continue;
				if (this.hasTodo(field)) continue;
				const proof = absolute[0] ? `fixture ${origin(absolute[0].value)}` : "declared .url()";
				todos.push({ ...base, evidence: proof, reason: "other_name" });
				addEdit(source, this.todoEdit(field, proof));
				continue;
			}
			const skip = (reason: UrlKindSkipReason, detail: string) =>
				skipped.push({ ...base, reason, detail });
			if (LIST_HELPERS.has(helper) !== parsed.list) {
				skip(
					"shape_mismatch",
					`${name} is declared as ${parsed.list ? "a list" : "a single string"}; the fleet name says ${parsed.list ? "one URL" : "a list"}.`,
				);
				continue;
			}
			if (nonUrl[0]) {
				skip(
					"non_url_fixture_value",
					`fixture ${nonUrl[0].where} holds ${JSON.stringify(truncate(nonUrl[0].value))}; resolve it with { base } in the constructor and declare the helper by hand.`,
				);
				continue;
			}
			if (absolute.length === 0) {
				skip(
					"no_url_evidence",
					parsed.declaredUrl
						? "declared .url() but no recorded fixture value shows which kind it is; record a fixture or declare the helper by hand."
						: "no recorded fixture value; record a fixture or declare the helper by hand if it holds URLs.",
				);
				continue;
			}
			const picture = absolute.find(({ value }) => looksLikeImageFile(value));
			if (helper === "itemPage" && picture) {
				skip(
					"kind_ambiguous",
					`fixture ${picture.where} holds a picture (${origin(picture.value)} ending ${extension(picture.value)}), not a page; declare image() or link() by hand.`,
				);
				continue;
			}
			const rejected = absolute.find(({ value }) => !publishable(helper, value));
			if (rejected) {
				const insecure = /^http:/i.test(rejected.value) && helper !== "itemPage";
				skip(
					insecure ? "insecure_image_fixture" : "unpublishable_fixture_value",
					insecure
						? `fixture ${rejected.where} holds an http:// picture (${origin(rejected.value)}); list the host in upgradeHttp after measuring it serves https, or the value is dropped.`
						: `fixture ${rejected.where} holds ${origin(rejected.value)}, which the helper refuses (host or credentials).`,
				);
				continue;
			}
			if (helper === "itemPage") {
				// The name alone does not make a page the item's own: a booking,
				// related, seller or navigation link is also called `url`.
				const doubts = this.itemPageDoubts(
					name,
					reaches,
					absolute.map(({ value }) => value),
				);
				if (doubts.length > 0) {
					if (this.hasTodo(field)) continue;
					const proof = `fixture ${origin(absolute[0]?.value ?? "")}`;
					todos.push({
						...base,
						evidence: proof,
						reason: "item_page_unproven",
						detail: doubts.join("; "),
					});
					addEdit(source, this.todoEdit(field, proof, doubts));
					continue;
				}
			}
			const rewritten = this.rewriteField(parsed, helper);
			if ("unsupported" in rewritten) {
				skip(
					"unsupported_chain",
					`${rewritten.unsupported} has no helper equivalent; migrate this field by hand.`,
				);
				continue;
			}
			const importName = HELPER_IMPORT[helper];
			if (collides(source, importName)) {
				skip("name_collision", `${importName} is already declared in this file.`);
				continue;
			}
			needImport(source, importName);
			addEdit(source, {
				start: field.initializer.getStart(source),
				end: field.initializer.end,
				text: rewritten.text,
			});
			const notes = LINK_HELPERS.has(helper)
				? []
				: this.insecureHostNotes(absolute.map(({ value }) => value));
			rewrites.push({
				...base,
				helper: HELPER_CALL[helper],
				before: field.initializer
					.getText(source)
					.replace(/\s+/g, " ")
					.replace(/\s*\.\s*/g, "."),
				after: rewritten.text,
				...(notes.length > 0 ? { notes } : {}),
			});
			targets.set(field, { helper, label });
		}

		// Mapper sites.
		const wrapped = new Set<FieldNode>();
		const onSite = (site: FieldNode, declared: ReadonlySet<FieldNode>) => {
			if (wrapped.has(site)) return;
			const kinds = [...declared].map((field) => targets.get(field));
			const first = kinds[0];
			if (
				!first ||
				kinds.some((kind) => !kind || CONSTRUCTOR[kind.helper] !== CONSTRUCTOR[first.helper])
			)
				return;
			const labels = new Set(kinds.map((kind) => kind?.label));
			const label = labels.size === 1 ? first.label : undefined;
			const source = site.getSourceFile();
			const constructorName = CONSTRUCTOR[first.helper];
			const value = ts.isPropertyAssignment(site) ? this.unwrap(site.initializer) : undefined;
			if (value) {
				// A literal is a recorded value (a fixture), not an upstream one; an
				// https literal already has the value type and an http one is
				// reported by the type check.
				if (
					value.kind === ts.SyntaxKind.NullKeyword ||
					(ts.isIdentifier(value) && value.text === "undefined") ||
					ts.isStringLiteralLike(value)
				)
					return;
				if (
					ts.isCallExpression(value) &&
					ts.isIdentifier(this.unwrap(value.expression)) &&
					CONSTRUCTOR_FUNCTIONS.has((this.unwrap(value.expression) as TS.Identifier).text)
				)
					return;
			}
			if (ts.isShorthandPropertyAssignment(site) && site.objectAssignmentInitializer) return;
			wrapped.add(site);
			const property = ts.isPropertyAssignment(site)
				? (propertyNameText(ts, site.name) ?? "")
				: site.name.text;
			if (collides(source, constructorName)) {
				skipped.push({
					file: this.display(source.fileName),
					line: this.line(site),
					property,
					paths: label ? [label] : [],
					reason: "name_collision",
					detail: `${constructorName} is already declared in this file; wrap this value by hand.`,
				});
				return;
			}
			const options = label === undefined ? "" : `, { field: ${JSON.stringify(label)} }`;
			if (ts.isPropertyAssignment(site)) {
				const initializer = site.initializer;
				addEdit(source, {
					start: initializer.getStart(source),
					end: initializer.end,
					text: `${constructorName}(${initializer.getText(source)}${options})`,
				});
			} else {
				addEdit(source, {
					start: site.getStart(source),
					end: site.end,
					text: `${site.name.text}: ${constructorName}(${site.name.text}${options})`,
				});
			}
			needImport(source, constructorName);
			mapperWraps.push({
				file: this.display(source.fileName),
				line: this.line(site),
				property,
				constructor: constructorName,
			});
		};

		if (targets.size > 0) {
			const isTarget = (found: ReadonlySet<FieldNode> | undefined) =>
				found && [...found].some((field) => targets.has(field)) ? found : undefined;
			// Exact path, or a record path (`by_id.*.url`) the concrete key matches.
			const fieldsAt = (table: ReadonlyMap<string, Set<FieldNode>>, path: string) => {
				// Exact and record-wildcard declarations of the same location together.
				const matched = [...table].filter(
					([pattern]) =>
						pattern === path || (pattern.includes("*") && outputPathMatches(pattern, path)),
				);
				return matched.length > 0
					? new Set(matched.flatMap(([, fields]) => [...fields]))
					: undefined;
			};
			for (const operation of this.operations) {
				const table = this.operationTables.get(operation);
				const handler = this.property(operation.node, "handler");
				const fn = handler ? this.functionOf(handler) : this.methodHandler(operation.node);
				if (!table || !fn) continue;
				const walk: ValueWalk = {
					lookup: (path) => isTarget(fieldsAt(table, path)),
					onSite,
					seen: new Set(),
				};
				for (const returned of this.returnsOf(fn))
					this.walkValue(returned, "", this.emptyEnv, walk);
			}
			this.walkParseAnchors((schema, argument) => {
				const table = new Map<string, Set<FieldNode>>();
				this.walkSchema(schema, "", this.emptyEnv, new Set(), {
					field: (field, path) => {
						const found = table.get(path) ?? new Set<FieldNode>();
						found.add(field);
						table.set(path, found);
					},
				});
				if (![...table.values()].some((found) => isTarget(found))) return;
				this.walkValue(argument, "", this.emptyEnv, {
					lookup: (path) => isTarget(fieldsAt(table, path)),
					onSite,
					seen: new Set(),
				});
			});
		}

		const imports = new Map<string, { names: Set<string>; from: string }>();
		for (const [fileName, names] of neededImports) {
			const source = this.program.getSourceFile(fileName);
			if (!source) continue;
			const planned = this.importEdit(source, names);
			if (!planned) continue;
			addEdit(source, planned.edit);
			const entry = imports.get(planned.module) ?? { names: new Set<string>(), from: fileName };
			for (const name of planned.names) entry.names.add(name);
			imports.set(planned.module, entry);
		}

		for (const [fileName, list] of edits) {
			const kept = removeOverlaps(list);
			if (kept.length !== list.length) {
				const source = this.program.getSourceFile(fileName);
				for (const dropped of list.filter((edit) => !kept.includes(edit)))
					skipped.push({
						file: this.display(fileName),
						line: source ? source.getLineAndCharacterOfPosition(dropped.start).line + 1 : 0,
						property: "",
						paths: [],
						reason: "overlapping_edit",
						detail:
							"two edits touch the same text; this one was left out, rerun after reviewing the first.",
					});
			}
			edits.set(fileName, kept);
		}

		const byLocation = <T extends { file: string; line: number }>(items: T[]) =>
			items.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
		return {
			edits,
			rewrites: byLocation(rewrites),
			mapperWraps: byLocation(mapperWraps),
			todos: byLocation(todos),
			skipped: byLocation(skipped),
			imports,
		};
	}

	// -------------------------------------------------------------------------
	// Evidence that a `url` is the item's own page

	/**
	 * Why a `url` field is not proven to be the item's own page; empty when
	 * every place the output reaches it agrees it is. Proof is all of: the
	 * object holding it is not a links/related/seller/shop/store/nav/menu
	 * container, a sibling id/name/title identifies the item, no sibling holds
	 * another page URL, and every fixture value is on a site the provider
	 * declares as upstream (`allowedHosts`, `upstream.baseUrl`).
	 */
	private itemPageDoubts(
		name: string,
		reaches: readonly Reach[],
		values: readonly string[],
	): string[] {
		const doubts = new Set<string>();
		for (const reach of reaches) {
			const parentPath = parentPathOf(reach.path, name);
			if (parentPath === undefined) continue;
			const container = lastKeyOf(parentPath);
			if (
				container !== undefined &&
				words(container).some((word) => NON_ITEM_CONTAINER_WORDS.has(word))
			)
				doubts.add(`it sits under ${container}, which names other pages than the item`);
			const siblings = this.siblingsOf(reach.operation, parentPath, name);
			if (!siblings.some((sibling) => words(sibling.name).some((word) => IDENTITY_WORDS.has(word))))
				doubts.add("no id/name/title field beside it identifies an item");
			for (const sibling of siblings) {
				if (sibling.classified || FLEET_FIELD_HELPERS.has(sibling.name)) continue;
				const page = [...reach.operation.fixtureStrings].find(
					([valuePath, found]) =>
						outputPathMatches(sibling.path, valuePath) &&
						found.some((value) => isAbsoluteHttpUrl(value) && !looksLikeImageFile(value)),
				);
				if (page) doubts.add(`${sibling.name} beside it also holds a page URL`);
			}
		}
		const upstream = this.upstreamSites();
		if (upstream.size === 0)
			doubts.add(
				"the provider declares no upstream host (allowedHosts, upstream.baseUrl) to compare",
			);
		else
			for (const value of values) {
				const host = hostnameOf(value);
				if (host !== undefined && !upstream.has(siteOf(host)))
					doubts.add(
						`fixture host ${host} is not on an upstream site (${[...upstream].sort().join(", ")})`,
					);
			}
		return [...doubts];
	}

	/** Direct children of `parentPath` the operation's output declares, other than `name`. */
	private siblingsOf(
		operation: Operation,
		parentPath: string,
		name: string,
	): { name: string; path: string; classified: boolean }[] {
		const ts = this.ts;
		const table = this.operationTables.get(operation);
		if (!table) return [];
		const out = new Map<string, { name: string; path: string; classified: boolean }>();
		for (const [path, fields] of table)
			for (const field of fields) {
				if (!ts.isPropertyAssignment(field)) continue;
				const sibling = propertyNameText(ts, field.name);
				if (sibling === undefined || sibling === name) continue;
				if (appendPropertyPath(parentPath, sibling) !== path) continue;
				const classified = this.parseField(field.initializer).kind === "helper";
				const known = out.get(path);
				out.set(path, {
					name: sibling,
					path,
					classified: classified || known?.classified === true,
				});
			}
		return [...out.values()];
	}

	private upstreamSiteCache: ReadonlySet<string> | undefined;

	/** Sites (registrable domains) of the hosts the provider declares it calls. */
	private upstreamSites(): ReadonlySet<string> {
		if (this.upstreamSiteCache) return this.upstreamSiteCache;
		const ts = this.ts;
		const hosts = new Set<string>();
		const addHost = (value: unknown) => {
			if (typeof value !== "string") return;
			const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
				? hostnameOf(value)
				: value.replace(/^\*\./, "").toLowerCase();
			if (host) hosts.add(host);
		};
		for (const source of this.sourceFiles()) {
			const visit = (node: TS.Node): void => {
				if (ts.isPropertyAssignment(node) && propertyNameText(ts, node.name) === "allowedHosts") {
					const value = this.evaluate(node.initializer, 0, new Set());
					if (Array.isArray(value)) for (const entry of value) addHost(entry);
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}
		for (const operation of this.operations) {
			const upstream = this.property(operation.node, "upstream");
			const value = upstream ? this.evaluate(upstream, 0, new Set()) : undefined;
			if (value !== null && typeof value === "object" && !Array.isArray(value))
				addHost((value as Record<string, unknown>).baseUrl);
		}
		this.upstreamSiteCache = new Set([...hosts].map(siteOf));
		return this.upstreamSiteCache;
	}

	/**
	 * A picture declared on https evidence whose host serves `http://` in
	 * another recorded fixture: the constructor drops those values unless the
	 * author lists the host in `upgradeHttp`.
	 */
	private insecureHostNotes(values: readonly string[]): string[] {
		const notes: string[] = [];
		const hosts = new Set(values.map(hostnameOf).filter((host) => host !== undefined));
		for (const host of [...hosts].sort()) {
			let where: string | undefined;
			for (const operation of this.operations) {
				for (const [path, found] of operation.fixtureStrings)
					if (
						found.some(
							(value) =>
								/^http:\/\//i.test(value) && isAbsoluteHttpUrl(value) && hostnameOf(value) === host,
						)
					) {
						where = `${operation.name}:${path}`;
						break;
					}
				if (where) break;
			}
			if (where)
				notes.push(
					`${host} serves both schemes (http:// in fixture ${where}); add upgradeHttp: [${JSON.stringify(host)}] to the constructor once it is measured to serve the same path over https, or those values become null.`,
				);
		}
		return notes;
	}

	private methodHandler(object: TS.ObjectLiteralExpression): TS.SignatureDeclaration | undefined {
		const ts = this.ts;
		for (const element of object.properties)
			if (ts.isMethodDeclaration(element) && propertyNameText(ts, element.name) === "handler")
				return element;
		return undefined;
	}

	private walkParseAnchors(
		visitAnchor: (schema: TS.Expression, argument: TS.Expression) => void,
	): void {
		const ts = this.ts;
		for (const source of this.sourceFiles()) {
			const visit = (node: TS.Node): void => {
				// Recorded fixtures are values, not mappers.
				if (
					ts.isPropertyAssignment(node) &&
					["fixtures", "response"].includes(propertyNameText(ts, node.name) ?? "")
				)
					return;
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					PARSE_METHODS.has(node.expression.name.text) &&
					node.arguments[0]
				)
					visitAnchor(node.expression.expression, node.arguments[0]);
				ts.forEachChild(node, visit);
			};
			visit(source);
		}
	}

	private hasTodo(field: TS.PropertyAssignment): boolean {
		const source = field.getSourceFile();
		// The trivia before the field: a marker on its own line, or an inline
		// `/* ... */` one (TypeScript counts that as the previous token's
		// trailing comment, not a leading one).
		return source.text.slice(field.getFullStart(), field.getStart(source)).includes(TODO_MARKER);
	}

	private todoEdit(
		field: TS.PropertyAssignment,
		proof: string,
		doubts: readonly string[] = [],
	): Edit {
		const source = field.getSourceFile();
		const start = field.getStart(source);
		const lineStart = source.text.lastIndexOf("\n", start - 1) + 1;
		const indent = source.text.slice(lineStart, start);
		const message = (
			doubts.length > 0
				? `${TODO_MARKER}: not proven to be the item's own page (${proof}; ${doubts.join("; ")}); declare itemPage() if it is, otherwise link().`
				: `${TODO_MARKER}: absolute URL (${proof}); declare itemPage() if it is the item's own page, image() if it is its picture, otherwise link().`
		)
			.replaceAll("*/", "* /")
			.replaceAll("\n", " ");
		if (/^\s*$/.test(indent)) return { start, end: start, text: `// ${message}\n${indent}` };
		return { start, end: start, text: `/* ${message} */ ` };
	}

	/** Names declared in a file other than through an SDK import. */
	private localNames(source: TS.SourceFile): Set<string> {
		const ts = this.ts;
		const names = new Set<string>();
		const visit = (node: TS.Node): void => {
			if (ts.isImportDeclaration(node)) {
				const module = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
				const clause = node.importClause;
				if (!clause) return;
				if (clause.name) names.add(clause.name.text);
				const bindings = clause.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
				if (bindings && ts.isNamedImports(bindings))
					for (const element of bindings.elements) {
						const imported = (element.propertyName ?? element.name).text;
						if (
							SDK_MODULES.has(module) &&
							!clause.isTypeOnly &&
							!element.isTypeOnly &&
							imported === element.name.text
						)
							continue;
						names.add(element.name.text);
					}
				return;
			}
			if (
				(ts.isVariableDeclaration(node) ||
					ts.isParameter(node) ||
					ts.isFunctionDeclaration(node) ||
					ts.isClassDeclaration(node) ||
					ts.isEnumDeclaration(node) ||
					ts.isBindingElement(node)) &&
				node.name &&
				ts.isIdentifier(node.name)
			)
				names.add(node.name.text);
			ts.forEachChild(node, visit);
		};
		visit(source);
		return names;
	}

	private importEdit(
		source: TS.SourceFile,
		names: ReadonlySet<string>,
	): { edit: Edit; module: string; names: string[] } | undefined {
		const ts = this.ts;
		const imported = new Set<string>();
		let target: TS.NamedImports | undefined;
		let targetModule = SDK_PACKAGE;
		let lastImportEnd = 0;
		let quote = '"';
		for (const statement of source.statements) {
			if (!ts.isImportDeclaration(statement)) continue;
			lastImportEnd = statement.end;
			if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
			quote = statement.moduleSpecifier.getText(source).startsWith("'") ? "'" : '"';
			const module = statement.moduleSpecifier.text;
			const clause = statement.importClause;
			if (!SDK_MODULES.has(module) || !clause || clause.isTypeOnly) continue;
			const bindings = clause.namedBindings;
			if (!bindings || !ts.isNamedImports(bindings)) continue;
			for (const element of bindings.elements)
				if (!element.isTypeOnly && !element.propertyName) imported.add(element.name.text);
			if (!target || module === SDK_PACKAGE) {
				target = bindings;
				targetModule = module;
			}
		}
		const missing = [...names].filter((name) => !imported.has(name)).sort();
		if (missing.length === 0) return undefined;
		if (target && target.elements.length > 0) {
			const last = target.elements[target.elements.length - 1];
			if (last)
				return {
					edit: { start: last.end, end: last.end, text: `, ${missing.join(", ")}` },
					module: targetModule,
					names: missing,
				};
		}
		const text = `import { ${missing.join(", ")} } from ${quote}${SDK_PACKAGE}${quote};`;
		const edit =
			lastImportEnd > 0
				? { start: lastImportEnd, end: lastImportEnd, text: `\n${text}` }
				: { start: 0, end: 0, text: `${text}\n\n` };
		return { edit, module: SDK_PACKAGE, names: missing };
	}
}

function removeOverlaps(edits: readonly Edit[]): Edit[] {
	const sorted = [...edits].sort((left, right) => left.start - right.start || right.end - left.end);
	const kept: Edit[] = [];
	let lastEnd = -1;
	for (const edit of sorted) {
		// An edit starting inside text another edit replaces would be lost.
		if (edit.start < lastEnd) continue;
		kept.push(edit);
		lastEnd = Math.max(lastEnd, edit.end);
	}
	return kept;
}

function extension(value: string): string {
	return imageFileExtension(value) ?? "";
}

function origin(value: string): string {
	return urlOrigin(value) ?? truncate(value);
}

function hostnameOf(value: string): string | undefined {
	try {
		return new URL(value).hostname.toLowerCase().replace(/\.+$/, "") || undefined;
	} catch {
		return undefined;
	}
}

/** The registrable domain of a host, approximately: `item.rakuten.co.jp` is `rakuten.co.jp`. */
function siteOf(host: string): string {
	const labels = host.toLowerCase().replace(/\.+$/, "").split(".");
	if (labels.length <= 2) return labels.join(".");
	const top = labels[labels.length - 1] ?? "";
	const second = labels[labels.length - 2] ?? "";
	const width = top.length === 2 && COUNTRY_SECOND_LEVEL.has(second) ? 3 : 2;
	return labels.slice(-width).join(".");
}

/** Lower-case words of a property name (`relatedLinks`, `nav_items` → `related`, `links`; `nav`, `items`). */
function words(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
}

/** The path of the object holding `name` at `path` (`items[]` for `items[].url`). */
function parentPathOf(path: string, name: string): string | undefined {
	if (path === appendPropertyPath("", name)) return "";
	const bare = `.${name}`;
	if (path.endsWith(bare) && appendPropertyPath(path.slice(0, -bare.length), name) === path)
		return path.slice(0, -bare.length);
	const quoted = `[${JSON.stringify(name)}]`;
	if (path.endsWith(quoted)) return path.slice(0, -quoted.length);
	return undefined;
}

/** The nearest property name of a path, past `[]` and `.*` (`booking_links` for `booking_links[]`). */
function lastKeyOf(path: string): string | undefined {
	const trimmed = path.replace(/(?:\[\]|\.\*)+$/, "");
	const quoted = /\["((?:[^"\\]|\\.)*)"\]$/.exec(trimmed);
	if (quoted?.[1] !== undefined) return JSON.parse(`"${quoted[1]}"`) as string;
	return /(?:^|\.)([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed)?.[1];
}

function truncate(value: string): string {
	return value.length > 60 ? `${value.slice(0, 59)}…` : value;
}
