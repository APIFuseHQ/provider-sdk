/**
 * Build-time runtime boundary.
 *
 * Provider runtime code reaches the outside world through the SDK context
 * (`ctx.http`, `ctx.stealth`, `ctx.browser`, `ctx.env`, `ctx.credential`,
 * `ctx.files`, `ctx.cache`, `ctx.state`). The boundary is enforced by bundling
 * the provider entry with Bun's bundler and judging what the bundle reaches:
 *
 * - Modules: every import the module graph resolves (static `import`,
 *   `export … from`, `require()`, and `import()` with a literal specifier)
 *   passes through a resolve plugin. Node and Bun built-ins outside
 *   `RUNTIME_MODULE_ALLOWLIST` (any `node:` specifier counts as a built-in,
 *   known to this Bun or not), the browser driver packages, and the SDK's
 *   own browser runtime subpath are violations. An `import()` or `require()`
 *   whose specifier is not a literal cannot be resolved at build time and is a
 *   violation on its own, and so is `require` used as a value (`const r =
 *   require`, `require.main.require(...)`): the bundler rewrites `require` to
 *   its own helper, and every reference to that helper that is not a direct
 *   call is reported.
 * - Globals: `process`, `Bun`, `globalThis`, `global`, `self`, `fetch`,
 *   `WebSocket`, `Worker`, `import.meta.env` and `import.meta.require` are
 *   rewritten by the bundler's `define` to a per-build sentinel. The bundler's
 *   own scope analysis decides what is a free reference (a shadowing parameter
 *   or local is left alone), so the check cannot be fooled by aliasing or by
 *   reaching the global through `globalThis`, `global` or `self` (the three
 *   names Bun binds to the global object; `window`, `frames`, `top` and
 *   `parent` do not exist in Bun), chained to any depth. The bundle is then
 *   parsed and every sentinel reference is judged by member path:
 *   `process.env.APIFUSE__RUNTIME__*` and a few read-only `process` members,
 *   `Bun` helpers that touch neither the filesystem nor the network nor
 *   processes, and `globalThis.<anything not on the denied list>` are allowed.
 *   Everything else is a violation.
 *
 * Positions come from the bundle's source map, so every violation names the
 * provider file, line and column. The graph is rooted at `index.ts` (the
 * provider definition) and at `start.ts` when it exists (the file the pod
 * runs with `bun run start`), so a module reached only from the bootstrap is
 * judged too. Only code reachable from those roots is judged, and only
 * bindings the bundler keeps (an imported-but-unused binding is dropped before
 * resolution): this is the code the pod executes, not a directory walk.
 * Findings inside the root bootstrap files themselves (`dev.ts`, `start.ts`,
 * `deploy.ts`) are dropped, as the source rules this check replaced dropped
 * them: they read the port and pod identity before a context exists. Tests
 * and scripts are outside the graph by construction.
 *
 * Browser driver findings are warnings in `standalone` lint mode (the bounty
 * mode `apifuse submit-check` runs in) and errors otherwise; every other
 * finding is an error in both modes.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { ProviderLintMode } from "../lint.js";
import { getTypeScript, scriptKindForSourceFile, type TypeScriptModule } from "../typescript-module.js";

export type BoundaryViolationKind = "module" | "global" | "dynamic-import" | "build";

export type BoundaryViolation = {
	kind: BoundaryViolationKind;
	level: "error" | "warn";
	/** What was reached: a module specifier, a global member path, `import(<expr>)`, or `build` for a bundler error. */
	subject: string;
	/** Provider-root-relative path (absolute when the file lies outside the root). */
	file: string;
	/** 1-based; 0 when the bundler reported the file without a position. */
	line: number;
	/** 1-based, the nearest token the bundler's source map records (the statement for an import); 0 when unknown. */
	column: number;
	message: string;
};

export type ProviderBundle = {
	/** True when no error-level violation was found. */
	ok: boolean;
	violations: BoundaryViolation[];
};

export type BundleProviderOptions = {
	mode?: ProviderLintMode;
};

/** The provider definition; always a graph root. */
const PROVIDER_ENTRY_FILE = "index.ts";
/** What the pod runs (`bun run start`); a graph root when present. */
const POD_ENTRY_FILE = "start.ts";
/**
 * Root bootstrap files `serve()` / `startDevServer()` are called from. They
 * are in the graph (so what they import is judged) but their own findings are
 * dropped, as the retired source rules dropped them.
 */
const BOOTSTRAP_FILE_PATTERN = /^(?:dev|start|deploy)\.[cm]?[jt]sx?$/;

/**
 * Node built-ins provider runtime code may import (with or without `node:`).
 * Pure helpers only: nothing here opens a file, a socket, or a process.
 */
export const RUNTIME_MODULE_ALLOWLIST: readonly string[] = Object.freeze([
	"assert",
	"assert/strict",
	"async_hooks",
	"buffer",
	"crypto",
	"diagnostics_channel",
	"events",
	"path",
	"path/posix",
	"path/win32",
	"perf_hooks",
	"punycode",
	"querystring",
	"stream",
	"stream/consumers",
	"stream/promises",
	"stream/web",
	"string_decoder",
	"timers",
	"timers/promises",
	"url",
	"util",
	"util/types",
	"zlib",
]);

/** Packages that launch or drive a browser outside the managed CDP pool. */
export const BROWSER_DRIVER_PACKAGES: readonly string[] = Object.freeze([
	"playwright",
	"playwright-core",
	"playwright-extra",
	"puppeteer",
	"puppeteer-core",
	"puppeteer-extra",
]);

/** The SDK subpath that can open a CDP connection to an arbitrary endpoint. */
export const SDK_BROWSER_RUNTIME_SUBPATH = "@apifuse/provider-sdk/runtime/browser";

/**
 * Environment names a provider may read from `process.env` directly. They are
 * consumed before `serve()` builds a context (port, pod identity), so
 * `ctx.env` cannot carry them. The whole `APIFUSE__RUNTIME__` family is the
 * bootstrap contract; nothing else is exempt.
 */
export const BOOTSTRAP_ENV_NAME_PREFIX = "APIFUSE__RUNTIME__";

/** Read-only `process` members that describe the host without reaching it. */
export const PROCESS_MEMBER_ALLOWLIST: readonly string[] = Object.freeze([
	"arch",
	"hrtime",
	"nextTick",
	"platform",
	"version",
	"versions",
]);

/** `Bun.*` helpers that touch neither the filesystem, the network, nor processes. */
export const BUN_MEMBER_ALLOWLIST: readonly string[] = Object.freeze([
	"ArrayBufferSink",
	"CryptoHasher",
	"concatArrayBuffers",
	"deepEquals",
	"deflateSync",
	"escapeHTML",
	"fileURLToPath",
	"gunzipSync",
	"gzipSync",
	"hash",
	"inflateSync",
	"inspect",
	"nanoseconds",
	"pathToFileURL",
	"peek",
	"randomUUIDv7",
	"readableStreamToArray",
	"readableStreamToArrayBuffer",
	"readableStreamToBlob",
	"readableStreamToBytes",
	"readableStreamToJSON",
	"readableStreamToText",
	"revision",
	"semver",
	"sleep",
	"sleepSync",
	"stringWidth",
	"version",
	"zstdCompressSync",
	"zstdDecompressSync",
]);

const CONTEXT_HINT =
	"Use the SDK context instead: ctx.http / ctx.stealth for HTTP, ctx.browser for browser work, ctx.env.get(name) / ctx.credential for configuration, ctx.files / ctx.cache / ctx.state for data.";

/**
 * Free identifiers the bundler rewrites to the sentinel. The value is the
 * member name the rewritten reference starts with, so `import.meta.env`
 * becomes `<sentinel>.import_meta_env`.
 */
const DEFINED_GLOBALS: Readonly<Record<string, string>> = Object.freeze({
	process: "process",
	Bun: "Bun",
	globalThis: "globalThis",
	global: "global",
	self: "self",
	fetch: "fetch",
	WebSocket: "WebSocket",
	Worker: "Worker",
	"import.meta.env": "import_meta_env",
	"import.meta.require": "import_meta_require",
});

/** The names Bun binds to the global object itself (`self === globalThis`). */
const GLOBAL_OBJECT_ALIASES: ReadonlySet<string> = new Set(["globalThis", "global", "self"]);
const PROCESS_MEMBERS: ReadonlySet<string> = new Set(PROCESS_MEMBER_ALLOWLIST);
const BUN_MEMBERS: ReadonlySet<string> = new Set(BUN_MEMBER_ALLOWLIST);
const ALLOWED_MODULES: ReadonlySet<string> = new Set(RUNTIME_MODULE_ALLOWLIST);
const BUNDLER_REQUIRE_HELPER_PATTERN = /^__require\d*$/;

type ModuleDecision = { allowed: true } | { allowed: false; level: "error" | "warn"; message: string };

type Position = { file: string; line: number; column: number };

/** One segment of a sentinel member chain: a static name or a computed access. */
type ChainSegment = { name: string } | { computed: true };

function stripNodePrefix(specifier: string): string {
	return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}

function isBunModule(specifier: string): boolean {
	return specifier === "bun" || specifier.startsWith("bun:");
}

function matchesPackage(specifier: string, packageName: string): boolean {
	return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

/**
 * A node built-in: one this Bun knows, or any `node:` specifier. A `node:`
 * module this Bun does not ship (`node:sqlite`) is still a reach outside the
 * boundary once a Bun that ships it runs the pod.
 */
function isNodeModule(specifier: string): boolean {
	return (isBuiltin(specifier) && !isBunModule(specifier)) || specifier.startsWith("node:");
}

/** Specifier as the bundle names it, so plugin decisions and output positions meet. */
function moduleKey(specifier: string): string {
	return isNodeModule(specifier) ? stripNodePrefix(specifier) : specifier;
}

function decideModule(specifier: string, mode: ProviderLintMode): ModuleDecision {
	const browserLevel = mode === "standalone" ? "warn" : "error";
	if (isBunModule(specifier)) {
		return {
			allowed: false,
			level: "error",
			message: `"${specifier}" is outside the provider runtime boundary. ${CONTEXT_HINT}`,
		};
	}
	if (isNodeModule(specifier)) {
		if (ALLOWED_MODULES.has(stripNodePrefix(specifier))) return { allowed: true };
		return {
			allowed: false,
			level: "error",
			message: `"${specifier}" is outside the provider runtime boundary. ${CONTEXT_HINT} Allowed node built-ins: ${RUNTIME_MODULE_ALLOWLIST.join(", ")}.`,
		};
	}
	if (BROWSER_DRIVER_PACKAGES.some((name) => matchesPackage(specifier, name))) {
		return {
			allowed: false,
			level: browserLevel,
			message: `"${specifier}" launches or drives a browser outside the managed CDP pool. Use ctx.browser (newPage(), withIsolatedContext()) instead of importing a browser driver.`,
		};
	}
	if (matchesPackage(specifier, SDK_BROWSER_RUNTIME_SUBPATH)) {
		return {
			allowed: false,
			level: browserLevel,
			message: `"${specifier}" exposes createBrowserClient, which can open a CDP connection to any endpoint. Provider code uses ctx.browser; import the subpath for types only (import type).`,
		};
	}
	return { allowed: true };
}

function segmentName(segment: ChainSegment | undefined): string | undefined {
	return segment && "name" in segment ? segment.name : undefined;
}

function formatChain(root: string, chain: readonly ChainSegment[]): string {
	return chain.reduce<string>(
		(text, segment) => ("name" in segment ? `${text}.${segment.name}` : `${text}[…]`),
		root,
	);
}

/**
 * Judge one rewritten global reference. `chain` is the member path after the
 * global itself (`process.env.FOO` → root `process`, chain `[env, FOO]`).
 * Returns the violation message, or `undefined` when the reach is allowed.
 */
function judgeGlobal(root: string, chain: readonly ChainSegment[]): string | undefined {
	const subject = formatChain(root, chain);
	switch (root) {
		case "globalThis":
		case "global":
		case "self": {
			const first = chain[0];
			if (!first) {
				return `${root} is passed around as a value; provider runtime code reaches globals by name, and only the ones the SDK context does not already cover.`;
			}
			if (!("name" in first)) {
				return `${subject} is a computed global lookup, which the build cannot check. Name the global directly.`;
			}
			if (!Object.hasOwn(DEFINED_GLOBALS, first.name)) return undefined;
			return judgeGlobal(first.name, chain.slice(1));
		}
		case "process":
		case "import_meta_env": {
			const isEnvObject = root === "import_meta_env";
			const member = isEnvObject ? "env" : segmentName(chain[0]);
			const keySegment = isEnvObject ? chain[0] : chain[1];
			const display = isEnvObject ? subject.replace("import_meta_env", "import.meta.env") : subject;
			if (member === "env") {
				const key = segmentName(keySegment);
				if (key?.startsWith(BOOTSTRAP_ENV_NAME_PREFIX)) return undefined;
				const what = key ? `${display}` : `the ${display} object`;
				return `${what} is read outside the provider runtime boundary. Declare the name under secrets: [{ name, required }] in defineProvider and read it with ctx.env.get(name); only the ${BOOTSTRAP_ENV_NAME_PREFIX}* bootstrap family may be read directly.`;
			}
			if (member !== undefined && PROCESS_MEMBERS.has(member)) return undefined;
			if (member === undefined) {
				return `process is used as a value outside the provider runtime boundary. ${CONTEXT_HINT}`;
			}
			return `${subject} is outside the provider runtime boundary. ${CONTEXT_HINT} Allowed process members: ${PROCESS_MEMBER_ALLOWLIST.join(", ")}.`;
		}
		case "Bun": {
			const member = segmentName(chain[0]);
			if (member === "env") {
				const key = segmentName(chain[1]);
				if (key?.startsWith(BOOTSTRAP_ENV_NAME_PREFIX)) return undefined;
				return `${subject} is read outside the provider runtime boundary. Declare the name under secrets: [{ name, required }] in defineProvider and read it with ctx.env.get(name).`;
			}
			if (member !== undefined && BUN_MEMBERS.has(member)) return undefined;
			return `${subject} is outside the provider runtime boundary. ${CONTEXT_HINT} Allowed Bun helpers: ${BUN_MEMBER_ALLOWLIST.join(", ")}.`;
		}
		case "fetch":
			return `The global fetch bypasses allowedHosts, proxy policy, retries, redaction and telemetry. Use ctx.http or ctx.stealth.fetch().`;
		case "WebSocket":
			return `The global WebSocket opens a connection outside the SDK transport. Use ctx.http or ctx.stealth, or ctx.browser for a page-side socket.`;
		case "Worker":
			return `Worker loads a module outside the checked runtime graph. Keep provider code in the module graph of index.ts.`;
		case "import_meta_require":
			return `import.meta.require loads modules at runtime, outside the build-time check. Use a static import.`;
		default:
			return `${subject} is outside the provider runtime boundary. ${CONTEXT_HINT}`;
	}
}

// Source-map decoding: the bundle's `mappings` field in standard VLQ form.
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

type MappingSegment = { generatedColumn: number; source: number; line: number; column: number };

function decodeVlq(segment: string): number[] {
	const values: number[] = [];
	let shift = 0;
	let value = 0;
	for (const character of segment) {
		const digit = BASE64_ALPHABET.indexOf(character);
		if (digit < 0) throw new Error(`invalid source map character "${character}"`);
		value += (digit & 31) << shift;
		if (digit & 32) {
			shift += 5;
			continue;
		}
		const negative = value & 1;
		value >>= 1;
		values.push(negative ? -value : value);
		shift = 0;
		value = 0;
	}
	return values;
}

function decodeMappings(mappings: string): MappingSegment[][] {
	const lines: MappingSegment[][] = [];
	let source = 0;
	let line = 0;
	let column = 0;
	for (const generatedLine of mappings.split(";")) {
		const segments: MappingSegment[] = [];
		let generatedColumn = 0;
		if (generatedLine.length > 0) {
			for (const encoded of generatedLine.split(",")) {
				const values = decodeVlq(encoded);
				generatedColumn += values[0] ?? 0;
				if (values.length < 4) continue;
				source += values[1] ?? 0;
				line += values[2] ?? 0;
				column += values[3] ?? 0;
				segments.push({ generatedColumn, source, line, column });
			}
		}
		lines.push(segments);
	}
	return lines;
}

class SourceMapIndex {
	private readonly lines: MappingSegment[][];
	private readonly files: string[];

	constructor(map: { sources: string[]; mappings: string }, providerRoot: string) {
		this.lines = decodeMappings(map.mappings);
		this.files = map.sources.map((source) => {
			const fromCwd = resolve(process.cwd(), source);
			const absolute = existsSync(fromCwd) ? fromCwd : resolve(providerRoot, source);
			return displayPath(providerRoot, absolute);
		});
	}

	/** Original position for a 0-based generated line/column, or undefined. */
	lookup(generatedLine: number, generatedColumn: number): Position | undefined {
		let best: MappingSegment | undefined;
		for (const segment of this.lines[generatedLine] ?? []) {
			if (segment.generatedColumn > generatedColumn) break;
			best = segment;
		}
		if (!best) return undefined;
		const file = this.files[best.source];
		if (file === undefined) return undefined;
		return { file, line: best.line + 1, column: best.column + 1 };
	}
}

function displayPath(providerRoot: string, absolute: string): string {
	const relativePath = relative(providerRoot, absolute).split("\\").join("/");
	return relativePath.startsWith("..") || isAbsolute(relativePath) ? absolute : relativePath;
}

/** First line of `file` that mentions `specifier` as a string, for an import the bundle did not keep. */
function locateSpecifier(providerRoot: string, importer: string, specifier: string): Position {
	const file = displayPath(providerRoot, importer);
	let text: string;
	try {
		text = readFileSync(importer, "utf8");
	} catch {
		return { file, line: 0, column: 0 };
	}
	const lines = text.split(/\r?\n/);
	for (const [index, lineText] of lines.entries()) {
		for (const quoted of [`"${specifier}"`, `'${specifier}'`, `\`${specifier}\``]) {
			const column = lineText.indexOf(quoted);
			if (column >= 0) return { file, line: index + 1, column: column + 1 };
		}
	}
	return { file, line: 0, column: 0 };
}

type ReachedModule = { specifier: string; importer: string; decision: ModuleDecision };

function staticText(ts: TypeScriptModule, node: import("typescript").Node | undefined): string | undefined {
	if (!node) return undefined;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	return undefined;
}

/**
 * Walk the bundle and collect, with generated positions, every external
 * module reference, every unresolvable dynamic load, and every sentinel
 * reference with its member chain.
 */
function scanBundle(
	ts: TypeScriptModule,
	code: string,
	sentinel: string,
): {
	sourceFile: import("typescript").SourceFile;
	modules: Array<{ specifier: string; offset: number }>;
	dynamic: Array<{ subject: string; offset: number }>;
	/** The bundler's `require` helper referenced other than as a call's callee. */
	requireValues: Array<{ offset: number }>;
	globals: Array<{ root: string; chain: ChainSegment[]; offset: number }>;
} {
	const sourceFile = ts.createSourceFile("bundle.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const modules: Array<{ specifier: string; offset: number }> = [];
	const dynamic: Array<{ subject: string; offset: number }> = [];
	const requireValues: Array<{ offset: number }> = [];
	const globals: Array<{ root: string; chain: ChainSegment[]; offset: number }> = [];

	const recordLoad = (argument: import("typescript").Node | undefined, call: import("typescript").CallExpression, form: string) => {
		const specifier = staticText(ts, argument);
		if (specifier !== undefined) {
			modules.push({ specifier, offset: (argument as import("typescript").Node).getStart(sourceFile) });
			return;
		}
		dynamic.push({ subject: `${form}(${argument ? argument.getText(sourceFile) : ""})`, offset: call.getStart(sourceFile) });
	};

	const visit = (node: import("typescript").Node): void => {
		if (ts.isImportDeclaration(node)) {
			const specifier = staticText(ts, node.moduleSpecifier);
			if (specifier !== undefined) modules.push({ specifier, offset: node.moduleSpecifier.getStart(sourceFile) });
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
			const specifier = staticText(ts, node.moduleSpecifier);
			if (specifier !== undefined) modules.push({ specifier, offset: node.moduleSpecifier.getStart(sourceFile) });
		} else if (ts.isCallExpression(node)) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				recordLoad(node.arguments[0], node, "import");
			} else if (ts.isIdentifier(node.expression) && BUNDLER_REQUIRE_HELPER_PATTERN.test(node.expression.text)) {
				recordLoad(node.arguments[0], node, "require");
			}
		} else if (ts.isIdentifier(node) && BUNDLER_REQUIRE_HELPER_PATTERN.test(node.text)) {
			// The helper's own declaration (`var __require = createRequire(...)`)
			// and a direct call (handled above) are the bundler's doing; any other
			// reference is provider code holding `require` as a value.
			const parent = node.parent;
			const declared = ts.isVariableDeclaration(parent) && parent.name === node;
			const called = ts.isCallExpression(parent) && parent.expression === node;
			const probed = ts.isTypeOfExpression(parent);
			if (!declared && !called && !probed) requireValues.push({ offset: node.getStart(sourceFile) });
		} else if (ts.isIdentifier(node) && node.text === sentinel) {
			const chain: ChainSegment[] = [];
			let current: import("typescript").Node = node;
			for (;;) {
				const parent = current.parent;
				if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
					chain.push({ name: parent.name.text });
				} else if (ts.isElementAccessExpression(parent) && parent.expression === current) {
					const name = staticText(ts, parent.argumentExpression);
					chain.push(name === undefined ? { computed: true } : { name });
				} else {
					break;
				}
				current = parent;
			}
			const root = segmentName(chain[0]);
			// `typeof process` / `typeof globalThis.Bun` probe the host without reaching it;
			// `typeof process.env.X` still reads the environment.
			const probed =
				current.parent !== undefined &&
				ts.isTypeOfExpression(current.parent) &&
				(chain.length === 1 || (chain.length === 2 && root !== undefined && GLOBAL_OBJECT_ALIASES.has(root)));
			if (!probed && root !== undefined) {
				globals.push({ root, chain: chain.slice(1), offset: node.getStart(sourceFile) });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return { sourceFile, modules, dynamic, requireValues, globals };
}

/**
 * Bundle the provider roots (`index.ts`, and `start.ts` when present) and
 * report everything the runtime graph reaches outside the boundary. Throws
 * only when `index.ts` is missing; a bundle that does not build (syntax error,
 * unresolvable relative import) is reported as violations carrying the
 * bundler's own file and line.
 */
export async function bundleProvider(
	providerRoot: string,
	options: BundleProviderOptions = {},
): Promise<ProviderBundle> {
	const root = resolve(providerRoot);
	const entry = resolve(root, PROVIDER_ENTRY_FILE);
	if (!existsSync(entry)) {
		throw new Error(`Provider entry not found: ${entry}`);
	}
	const podEntry = resolve(root, POD_ENTRY_FILE);
	return bundleGraph(root, {
		mode: options.mode ?? "official",
		entrypoints: existsSync(podEntry) ? [entry, podEntry] : [entry],
		sourceSet: false,
	});
}

/**
 * Judge a file set rather than a checkout, for the deprecated
 * `lintRuntimeBoundarySources` shim: `entry` is a root-relative file that
 * imports every file to judge. A relative import the root lacks (a `.json`,
 * an asset, a file the caller did not supply) loads as an empty module
 * instead of failing the build, and a value import the TypeScript transpiler
 * would drop as unused still counts as a reach, as it did for the source
 * rules this replaces. Not part of the package entry points; removed with the
 * shim in the next major.
 */
export async function bundleSourceSet(
	providerRoot: string,
	entry: string,
	mode: ProviderLintMode,
): Promise<ProviderBundle> {
	const root = resolve(providerRoot);
	return bundleGraph(root, { mode, entrypoints: [resolve(root, entry)], sourceSet: true });
}

const MISSING_MODULE_NAMESPACE = "apifuse-missing";
const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const TYPESCRIPT_SOURCE_PATTERN = /\.[cm]?tsx?$/;

/** True when a relative or absolute specifier resolves to something on disk. */
function relativeImportExists(importer: string, specifier: string): boolean {
	const base = isAbsolute(specifier) ? specifier : resolve(dirname(importer), specifier);
	if (existsSync(base)) return true;
	return (
		RESOLVABLE_EXTENSIONS.some((extension) => existsSync(base + extension)) ||
		RESOLVABLE_EXTENSIONS.some((extension) => existsSync(resolve(base, `index${extension}`)))
	);
}

/**
 * Append `import "<specifier>";` on the same line as every value import or
 * re-export, so the bundler keeps the reach of a binding nobody uses. Lines
 * are unchanged, so the source map still names the original line.
 */
function keepValueImports(ts: TypeScriptModule, fileName: string, source: string): string {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, scriptKindForSourceFile(ts, fileName));
	const insertions: Array<{ offset: number; specifier: string }> = [];
	for (const statement of sourceFile.statements) {
		let specifier: string | undefined;
		if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
			const clause = statement.importClause;
			const typeOnly =
				clause?.isTypeOnly === true ||
				(clause?.namedBindings !== undefined &&
					ts.isNamedImports(clause.namedBindings) &&
					clause.name === undefined &&
					clause.namedBindings.elements.length > 0 &&
					clause.namedBindings.elements.every((element) => element.isTypeOnly));
			if (!typeOnly) specifier = statement.moduleSpecifier.text;
		} else if (
			ts.isExportDeclaration(statement) &&
			statement.moduleSpecifier &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			!statement.isTypeOnly
		) {
			specifier = statement.moduleSpecifier.text;
		}
		if (specifier !== undefined) insertions.push({ offset: statement.end, specifier });
	}
	let text = source;
	for (const { offset, specifier } of insertions.reverse()) {
		text = `${text.slice(0, offset)} import ${JSON.stringify(specifier)};${text.slice(offset)}`;
	}
	return text;
}

type GraphOptions = {
	mode: ProviderLintMode;
	entrypoints: string[];
	sourceSet: boolean;
};

async function bundleGraph(root: string, { mode, entrypoints, sourceSet }: GraphOptions): Promise<ProviderBundle> {
	const sentinel = `__apifuse_boundary_${randomBytes(8).toString("hex")}__`;
	const reached = new Map<string, ReachedModule>();

	const result = await Bun.build({
		entrypoints,
		root,
		target: "node",
		format: "esm",
		packages: "external",
		env: "disable",
		sourcemap: "external",
		minify: false,
		throw: false,
		define: Object.fromEntries(
			Object.entries(DEFINED_GLOBALS).map(([name, member]) => [name, `${sentinel}.${member}`]),
		),
		plugins: [
			{
				name: "apifuse-runtime-boundary",
				setup(build) {
					build.onResolve({ filter: /.*/ }, (args) => {
						// Bun's own helper imports (`node:module` for the require shim).
						if (args.importer === "runtime") return undefined;
						const specifier = args.path;
						if (specifier.startsWith(".") || isAbsolute(specifier)) {
							if (sourceSet && !relativeImportExists(args.importer, specifier)) {
								return { path: specifier, namespace: MISSING_MODULE_NAMESPACE };
							}
							return undefined;
						}
						const decision = decideModule(specifier, mode);
						// An allowed package (or a tsconfig path alias) is left to Bun's own
						// resolver; a built-in or a denied specifier is pinned external so the
						// bundle keeps the reference the source map can point at.
						const builtin = isNodeModule(specifier) || isBunModule(specifier);
						if (decision.allowed && !builtin) return undefined;
						if (!decision.allowed) {
							reached.set(`${args.importer}\u0000${moduleKey(specifier)}`, {
								specifier,
								importer: args.importer,
								decision,
							});
						}
						return { path: specifier, external: true };
					});
					if (!sourceSet) return;
					// CommonJS, so a named import from the stand-in is not a build error.
					build.onLoad({ filter: /.*/, namespace: MISSING_MODULE_NAMESPACE }, () => ({
						contents: "module.exports = {};",
						loader: "js",
					}));
					build.onLoad({ filter: TYPESCRIPT_SOURCE_PATTERN }, async (args) => {
						if (!args.path.startsWith(root)) return undefined;
						const source = await Bun.file(args.path).text();
						return {
							contents: keepValueImports(getTypeScript(), args.path, source),
							loader: args.path.endsWith("x") ? "tsx" : "ts",
						};
					});
				},
			},
		],
	});

	const violations: BoundaryViolation[] = [];

	if (!result.success) {
		for (const log of result.logs) {
			if (log.level !== "error") continue;
			const position = log.position;
			violations.push({
				kind: "build",
				level: "error",
				subject: "build",
				file: position?.file ? displayPath(root, position.file) : "",
				line: position?.line ?? 0,
				column: position?.column ?? 0,
				message: log.message,
			});
		}
		return { ok: false, violations };
	}

	// Each root is emitted as its own bundle (no code splitting), so a module
	// both roots reach appears in both outputs and its findings are deduplicated
	// below. The source map is paired by path: `<output>.map`.
	const outputs = result.outputs.filter((artifact) => artifact.kind === "entry-point");
	const mapsByPath = new Map(
		result.outputs.filter((artifact) => artifact.kind === "sourcemap").map((artifact) => [artifact.path, artifact]),
	);
	if (outputs.length !== entrypoints.length) {
		throw new Error(`Bun.build produced ${outputs.length} entry-point outputs for ${entrypoints.length} roots`);
	}
	const ts = getTypeScript();

	// Module reaches: the bundle names where each kept import sits; a reach the
	// bundle did not keep (a side-effect-free re-export the bundler folded away)
	// is located in the importer's text instead.
	const deniedBySpecifier = new Map<string, ReachedModule[]>();
	for (const item of reached.values()) {
		if (item.decision.allowed) continue;
		const key = moduleKey(item.specifier);
		deniedBySpecifier.set(key, [...(deniedBySpecifier.get(key) ?? []), item]);
	}
	const located = new Set<ReachedModule>();

	for (const output of outputs) {
		const mapArtifact = mapsByPath.get(`${output.path}.map`);
		if (!mapArtifact) {
			throw new Error(`Bun.build produced no source map for ${output.path}`);
		}
		const sourceMap = new SourceMapIndex(JSON.parse(await mapArtifact.text()), root);
		const scan = scanBundle(ts, await output.text(), sentinel);
		const positionOf = (offset: number): Position | undefined => {
			const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(offset);
			return sourceMap.lookup(line, character);
		};

		for (const { specifier, offset } of scan.modules) {
			const candidates = deniedBySpecifier.get(moduleKey(specifier));
			if (!candidates) continue;
			const position = positionOf(offset);
			const item =
				candidates.find((candidate) => position && displayPath(root, candidate.importer) === position.file) ??
				candidates[0];
			if (!item || item.decision.allowed) continue;
			located.add(item);
			violations.push({
				kind: "module",
				level: item.decision.level,
				subject: item.specifier,
				...(position ?? locateSpecifier(root, item.importer, item.specifier)),
				message: item.decision.message,
			});
		}

		for (const { subject, offset } of scan.dynamic) {
			violations.push({
				kind: "dynamic-import",
				level: "error",
				subject,
				...(positionOf(offset) ?? { file: "", line: 0, column: 0 }),
				message: `${subject} loads a module the build cannot resolve. Use a literal module path so the import is part of the checked runtime graph.`,
			});
		}

		for (const { offset } of scan.requireValues) {
			violations.push({
				kind: "dynamic-import",
				level: "error",
				subject: "require",
				...(positionOf(offset) ?? { file: "", line: 0, column: 0 }),
				message:
					"require is used as a value, so what it loads is outside the build-time check. Call require(<literal>) directly or use a static import.",
			});
		}

		for (const { root: globalRoot, chain, offset } of scan.globals) {
			const message = judgeGlobal(globalRoot, chain);
			if (message === undefined) continue;
			const displayRoot = globalRoot
				.replace("import_meta_env", "import.meta.env")
				.replace("import_meta_require", "import.meta.require");
			violations.push({
				kind: "global",
				level: "error",
				subject: formatChain(displayRoot, chain),
				...(positionOf(offset) ?? { file: "", line: 0, column: 0 }),
				message,
			});
		}
	}

	for (const item of reached.values()) {
		if (item.decision.allowed || located.has(item)) continue;
		violations.push({
			kind: "module",
			level: item.decision.level,
			subject: item.specifier,
			...locateSpecifier(root, item.importer, item.specifier),
			message: item.decision.message,
		});
	}

	const seen = new Set<string>();
	const kept = violations.filter((violation) => {
		if (BOOTSTRAP_FILE_PATTERN.test(violation.file)) return false;
		const key = [
			violation.kind,
			violation.file,
			violation.line,
			violation.kind === "module" ? "" : violation.column,
			violation.subject,
		].join("\u0000");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	kept.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
	return { ok: kept.every((violation) => violation.level !== "error"), violations: kept };
}

/** `ERROR module upstream/session.ts:3:1: node:fs — message`, the line `apifuse check` prints. */
export function formatBoundaryViolation(violation: BoundaryViolation): string {
	const where =
		violation.line > 0 ? `${violation.file}:${violation.line}:${violation.column}` : violation.file || "(unknown file)";
	return `${violation.level.toUpperCase()} ${violation.kind} ${where}: ${violation.subject} — ${violation.message}`;
}
