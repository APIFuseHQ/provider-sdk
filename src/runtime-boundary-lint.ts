/**
 * Runtime boundary lint: provider runtime source must reach the outside world
 * through the SDK context (`ctx.http`, `ctx.stealth`, `ctx.env`,
 * `ctx.credential`, `ctx.browser`), not through ambient Node/Bun globals.
 *
 * Three rules, all reported at `warn` level in this first release so the
 * fleet can migrate before the level is raised:
 *
 * - `process-env-direct-read`: `process.env.X`, `process.env["X"]`, a bare
 *   `process.env` object use, and the `Bun.env` equivalents. Runtime bootstrap
 *   keys (`APIFUSE__RUNTIME__*`) are exempt everywhere because `serve()`
 *   callers read the port and pod identity before a context exists.
 * - `node-runtime-module-import`: value imports of `fs`, `fs/promises`, `net`,
 *   `tls`, `dgram`, `http`, `https`, `http2`, `child_process` (with or without
 *   the `node:` prefix) via import/export declarations, `require()`, or dynamic
 *   `import()`, plus the Bun equivalents `Bun.spawn`, `Bun.spawnSync`, `Bun.$`,
 *   `Bun.file`, `Bun.write`. Type-only imports are not runtime reach and are
 *   ignored.
 * - `direct-fetch-call`: a call to the global `fetch` (bare identifier, or
 *   `globalThis`/`window`/`self`/`global` member). A bare `fetch` call whose
 *   enclosing scope declares a `fetch` binding (parameter, variable, import,
 *   function, catch clause) is calling that binding, not the global, and is
 *   left alone; the check is lexical, so a wrapper that takes `fetch` as a
 *   parameter does not hide a global `fetch()` elsewhere in the same file.
 *   `ctx.stealth.fetch()` is a member call and never matches.
 *
 * Files are parsed with the script kind their extension implies (`.ts` as
 * TypeScript, `.tsx` as TSX, …). Parsing everything as TSX would make a
 * generic arrow (`<T>(value: T) => value`) or an angle-bracket assertion in an
 * ordinary `.ts` file read as JSX, and everything after it would silently drop
 * out of the AST.
 *
 * Scope is the provider *runtime* source: JavaScript/TypeScript files under
 * `providerSourceFiles` minus tests, recorded fixtures, the root bootstrap
 * entrypoints (`dev.ts`, `start.ts`, `deploy.ts`) and the operator tooling
 * directories (`scripts/`, `tools/`, `bin/`). Tooling legitimately reads the
 * ambient environment and the filesystem when a human runs it; the rule is
 * about code the pod executes on behalf of a request.
 *
 * A deliberate exception is acknowledged with the same escape hatch the submit
 * check uses: `// @apifuse-allow <rule>: <reason>` on the finding line or the
 * line directly above it. Acknowledged findings are reported as information so
 * `apifuse check` still lists them.
 */

import type { LintDiagnostic, ProviderLintInformation } from "./lint.js";

type TypeScriptModule = typeof import("typescript");
type TsNode = import("typescript").Node;
type TsSourceFile = import("typescript").SourceFile;

export const PROCESS_ENV_DIRECT_READ_RULE = "process-env-direct-read";
export const NODE_RUNTIME_MODULE_IMPORT_RULE = "node-runtime-module-import";
export const DIRECT_FETCH_CALL_RULE = "direct-fetch-call";

export const RUNTIME_BOUNDARY_RULES = [
	PROCESS_ENV_DIRECT_READ_RULE,
	NODE_RUNTIME_MODULE_IMPORT_RULE,
	DIRECT_FETCH_CALL_RULE,
] as const;

export type RuntimeBoundaryRule = (typeof RUNTIME_BOUNDARY_RULES)[number];

/**
 * Environment names a provider may read from `process.env` directly. These
 * are consumed before `serve()` builds a context (port, pod identity), so
 * `ctx.env` cannot carry them. The whole `APIFUSE__RUNTIME__` family is the
 * bootstrap contract; nothing else is exempt.
 */
export const BOOTSTRAP_ENV_NAME_PREFIX = "APIFUSE__RUNTIME__";

export function isBootstrapEnvName(name: string): boolean {
	return name.startsWith(BOOTSTRAP_ENV_NAME_PREFIX);
}

/** Root entrypoints `serve()`/`startDevServer()` are called from; never request-path code. */
const BOOTSTRAP_ENTRYPOINT_FILE_PATTERN = /^(?:dev|start|deploy)\.[cm]?[jt]sx?$/;
/** Operator tooling directories at the provider root (fixture recorders, smoke scripts). */
const TOOLING_DIRECTORY_PATTERN = /^(?:scripts|tools|bin)\//;
const TEST_SOURCE_FILE_PATTERN =
	/(?:^|\/)(?:__tests__|__mocks__|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const RECORDED_FIXTURE_SOURCE_FILE_PATTERN =
	/(?:^|\/)__fixtures__(?:\/|$)|(?:^|\/)__tests__\/fixtures(?:\/|$)/;
const JAVASCRIPT_SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/;

/**
 * Node built-ins whose value import means the provider talks to the
 * filesystem, the network, or child processes on its own. Deliberately not the
 * whole `node:` namespace: `node:path`, `node:crypto`, `node:url`,
 * `node:buffer` and friends are pure helpers the SDK itself uses.
 */
const FORBIDDEN_NODE_MODULES: ReadonlySet<string> = new Set([
	"fs",
	"fs/promises",
	"net",
	"tls",
	"dgram",
	"http",
	"https",
	"http2",
	"child_process",
]);

const FORBIDDEN_BUN_MEMBERS: ReadonlySet<string> = new Set([
	"spawn",
	"spawnSync",
	"$",
	"file",
	"write",
]);

const GLOBAL_OBJECT_NAMES: ReadonlySet<string> = new Set([
	"globalThis",
	"window",
	"self",
	"global",
]);

const COMMENT_ONLY_LINE_PATTERN = /^\s*(?:\/\/|\/\*|\*)/;
const ALLOW_COMMENT_PATTERN =
	/@apifuse-allow\s+([a-z][a-z0-9-]*)\b(?:\s*:\s*(.*?))?\s*(?:\*\/)?\s*$/;

type RuntimeBoundaryFinding = {
	rule: RuntimeBoundaryRule;
	/** 1-based line. */
	line: number;
	/** What was reached: the env name, module specifier, or call text. */
	subject: string;
};

type RuntimeBoundaryFileReport = {
	findings: RuntimeBoundaryFinding[];
	acknowledged: Array<RuntimeBoundaryFinding & { reason: string }>;
};

/** True for the files the runtime boundary rules look at. */
export function isRuntimeBoundarySourceFile(relativePath: string): boolean {
	const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
	return (
		JAVASCRIPT_SOURCE_FILE_PATTERN.test(normalized) &&
		!DECLARATION_FILE_PATTERN.test(normalized) &&
		!TEST_SOURCE_FILE_PATTERN.test(normalized) &&
		!RECORDED_FIXTURE_SOURCE_FILE_PATTERN.test(normalized) &&
		!BOOTSTRAP_ENTRYPOINT_FILE_PATTERN.test(normalized) &&
		!TOOLING_DIRECTORY_PATTERN.test(normalized)
	);
}

function normalizeModuleSpecifier(specifier: string): string {
	return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}

function isForbiddenNodeModule(specifier: string): boolean {
	return FORBIDDEN_NODE_MODULES.has(normalizeModuleSpecifier(specifier));
}

function staticString(ts: TypeScriptModule, node: TsNode | undefined): string | undefined {
	if (!node) return undefined;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	return undefined;
}

function unwrapExpression(
	ts: TypeScriptModule,
	expression: import("typescript").Expression,
): import("typescript").Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isTypeAssertionExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

/** `process` / `globalThis.process` / `Bun` / `globalThis.Bun` */
function isGlobalReference(ts: TypeScriptModule, node: TsNode, name: string): boolean {
	if (ts.isIdentifier(node)) return node.text === name;
	if (ts.isPropertyAccessExpression(node)) {
		return (
			ts.isIdentifier(node.expression) &&
			GLOBAL_OBJECT_NAMES.has(node.expression.text) &&
			node.name.text === name
		);
	}
	if (ts.isElementAccessExpression(node)) {
		return (
			ts.isIdentifier(node.expression) &&
			GLOBAL_OBJECT_NAMES.has(node.expression.text) &&
			staticString(ts, node.argumentExpression) === name
		);
	}
	return false;
}

/** `process.env`, `process["env"]`, `Bun.env`, and their globalThis-prefixed forms. */
function envObjectOwner(ts: TypeScriptModule, node: TsNode): "process" | "Bun" | undefined {
	let owner: TsNode | undefined;
	let member: string | undefined;
	if (ts.isPropertyAccessExpression(node)) {
		owner = node.expression;
		member = node.name.text;
	} else if (ts.isElementAccessExpression(node)) {
		owner = node.expression;
		member = staticString(ts, node.argumentExpression);
	}
	if (!owner || member !== "env") return undefined;
	const unwrapped = unwrapExpression(ts, owner as import("typescript").Expression);
	if (isGlobalReference(ts, unwrapped, "process")) return "process";
	if (isGlobalReference(ts, unwrapped, "Bun")) return "Bun";
	return undefined;
}

/**
 * For an env-object node, the statically known key read from it
 * (`process.env.KEY`, `process.env["KEY"]`), or `undefined` when the object
 * itself is used (spread, passed along, dynamic key).
 */
function envKeyReadFrom(ts: TypeScriptModule, envNode: TsNode): string | undefined {
	const parent = envNode.parent;
	if (!parent) return undefined;
	if (ts.isPropertyAccessExpression(parent) && parent.expression === envNode) {
		return parent.name.text;
	}
	if (ts.isElementAccessExpression(parent) && parent.expression === envNode) {
		return staticString(ts, parent.argumentExpression);
	}
	return undefined;
}

/**
 * True when the import statement still loads the module at runtime. A
 * clause-level `import type`, and a named import whose every binding is
 * inline `type`, are erased by Bun and by tsc (without
 * `verbatimModuleSyntax`), so they never reach the module. A side-effect
 * import (`import "node:fs"`), a default or namespace binding, or any
 * value-level named binding does load it.
 */
function importDeclarationLoadsModule(
	ts: TypeScriptModule,
	node: import("typescript").ImportDeclaration,
): boolean {
	const clause = node.importClause;
	if (!clause) return true;
	if (clause.isTypeOnly) return false;
	if (clause.name) return true;
	const bindings = clause.namedBindings;
	if (!bindings) return true;
	if (ts.isNamespaceImport(bindings)) return true;
	return bindings.elements.some((element) => !element.isTypeOnly);
}

/** Same rule for `export … from`: erased when type-only at the clause or on every specifier. */
function exportDeclarationLoadsModule(
	ts: TypeScriptModule,
	node: import("typescript").ExportDeclaration,
): boolean {
	if (node.isTypeOnly) return false;
	const clause = node.exportClause;
	if (!clause) return true;
	if (ts.isNamespaceExport(clause)) return true;
	return clause.elements.some((element) => !element.isTypeOnly);
}

/**
 * Script kind for a provider source file, from its extension. `.tsx`/`.jsx`
 * enable JSX; everything else (`.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`,
 * and the synthetic names used for in-memory sources) does not, so a generic
 * arrow or `<T>value` assertion in a `.ts` file parses as TypeScript instead
 * of swallowing the rest of the file as unterminated JSX.
 */
export function scriptKindForSourceFile(
	ts: TypeScriptModule,
	fileName: string,
): import("typescript").ScriptKind {
	const lower = fileName.toLowerCase();
	if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
	if (/\.[cm]?js$/.test(lower)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

/** Scope node → value bindings declared directly in that scope. */
type ScopeBindings = Map<TsNode, Set<string>>;

/** Containers that own `let`/`const`/`class`/`function` declarations. */
function isBlockScopeContainer(ts: TypeScriptModule, node: TsNode): boolean {
	return (
		ts.isSourceFile(node) ||
		ts.isBlock(node) ||
		ts.isModuleBlock(node) ||
		ts.isCaseBlock(node) ||
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node)
	);
}

/** Containers that own `var` declarations (hoisted past blocks). */
function isFunctionScopeContainer(ts: TypeScriptModule, node: TsNode): boolean {
	return (
		ts.isSourceFile(node) ||
		ts.isModuleBlock(node) ||
		ts.isFunctionLike(node) ||
		ts.isClassStaticBlockDeclaration(node)
	);
}

function nearestAncestor(
	node: TsNode,
	sourceFile: TsSourceFile,
	predicate: (candidate: TsNode) => boolean,
): TsNode {
	let current: TsNode | undefined = node.parent;
	while (current && !predicate(current)) current = current.parent;
	return current ?? sourceFile;
}

/**
 * Value bindings per lexical scope: parameters on their function, `let`/`const`
 * and named function/class declarations on the enclosing block, `var` on the
 * enclosing function, imports on the file, a catch variable on its clause, a
 * named function/class expression on itself. Destructuring patterns contribute
 * every leaf name.
 */
function collectScopeBindings(ts: TypeScriptModule, sourceFile: TsSourceFile): ScopeBindings {
	const bindings: ScopeBindings = new Map();
	const bind = (scope: TsNode, name: string) => {
		const names = bindings.get(scope) ?? new Set<string>();
		names.add(name);
		bindings.set(scope, names);
	};
	const bindPattern = (scope: TsNode, name: import("typescript").BindingName) => {
		if (ts.isIdentifier(name)) {
			bind(scope, name.text);
			return;
		}
		for (const element of name.elements) {
			if (ts.isBindingElement(element)) bindPattern(scope, element.name);
		}
	};
	const blockScopeOf = (node: TsNode) =>
		nearestAncestor(node, sourceFile, (candidate) => isBlockScopeContainer(ts, candidate));
	const functionScopeOf = (node: TsNode) =>
		nearestAncestor(node, sourceFile, (candidate) => isFunctionScopeContainer(ts, candidate));

	const visit = (node: TsNode) => {
		if (ts.isVariableDeclaration(node)) {
			if (ts.isCatchClause(node.parent)) {
				bindPattern(node.parent, node.name);
			} else if (ts.getCombinedNodeFlags(node) & ts.NodeFlags.BlockScoped) {
				bindPattern(blockScopeOf(node.parent), node.name);
			} else {
				bindPattern(functionScopeOf(node.parent), node.name);
			}
		} else if (ts.isParameter(node)) {
			bindPattern(node.parent, node.name);
		} else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
			if (node.name) bind(blockScopeOf(node), node.name.text);
		} else if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
			if (node.name) bind(node, node.name.text);
		} else if (ts.isEnumDeclaration(node)) {
			bind(blockScopeOf(node), node.name.text);
		} else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
			bind(blockScopeOf(node), node.name.text);
		} else if (ts.isImportClause(node) || ts.isImportSpecifier(node)) {
			if (node.name) bind(sourceFile, node.name.text);
		} else if (ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node)) {
			bind(sourceFile, node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return bindings;
}

/** True when a scope enclosing `node` (or `node` itself) declares `name`. */
function isBindingInScope(bindings: ScopeBindings, node: TsNode, name: string): boolean {
	let current: TsNode | undefined = node;
	while (current) {
		if (bindings.get(current)?.has(name)) return true;
		current = current.parent;
	}
	return false;
}

function readAllowComment(
	lines: readonly string[],
	line: number,
	rule: RuntimeBoundaryRule,
): string | undefined {
	const current = lines[line - 1];
	const previous = lines[line - 2];
	// A trailing comment on the finding line, or a comment-only line directly
	// above it. A trailing acknowledgement on the previous line belongs to that
	// line's finding and must not leak onto this one.
	const candidates = [current, previous?.match(COMMENT_ONLY_LINE_PATTERN) ? previous : undefined];
	for (const candidate of candidates) {
		if (candidate === undefined) continue;
		const match = ALLOW_COMMENT_PATTERN.exec(candidate);
		if (match && match[1] === rule) {
			return match[2]?.trim() || "(no reason given)";
		}
	}
	return undefined;
}

export function analyzeRuntimeBoundary(
	ts: TypeScriptModule,
	fileName: string,
	source: string,
): RuntimeBoundaryFileReport {
	const sourceFile = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForSourceFile(ts, fileName),
	);
	const lines = source.split(/\r?\n/);
	const scopeBindings = collectScopeBindings(ts, sourceFile);
	const raw: RuntimeBoundaryFinding[] = [];
	const seen = new Set<string>();

	const record = (rule: RuntimeBoundaryRule, node: TsNode, subject: string) => {
		const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
		const key = `${rule}:${line}:${subject}`;
		if (seen.has(key)) return;
		seen.add(key);
		raw.push({ rule, line, subject });
	};

	const visit = (node: TsNode) => {
		// --- process.env / Bun.env ---------------------------------------
		const envOwner = envObjectOwner(ts, node);
		if (envOwner) {
			const key = envKeyReadFrom(ts, node);
			if (key === undefined || !isBootstrapEnvName(key)) {
				record(
					PROCESS_ENV_DIRECT_READ_RULE,
					node,
					key === undefined ? `${envOwner}.env` : `${envOwner}.env.${key}`,
				);
			}
			// Do not descend: the owner is a global, nothing below is interesting.
			return;
		}

		// --- node:fs / node:net / node:child_process … ---------------------
		if (ts.isImportDeclaration(node)) {
			const specifier = staticString(ts, node.moduleSpecifier);
			if (specifier && importDeclarationLoadsModule(ts, node) && isForbiddenNodeModule(specifier)) {
				record(NODE_RUNTIME_MODULE_IMPORT_RULE, node, specifier);
			}
			return;
		}
		if (ts.isExportDeclaration(node)) {
			const specifier = staticString(ts, node.moduleSpecifier);
			if (specifier && exportDeclarationLoadsModule(ts, node) && isForbiddenNodeModule(specifier)) {
				record(NODE_RUNTIME_MODULE_IMPORT_RULE, node, specifier);
			}
			return;
		}
		if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
			const reference = node.moduleReference;
			if (ts.isExternalModuleReference(reference)) {
				const specifier = staticString(ts, reference.expression);
				if (specifier && isForbiddenNodeModule(specifier)) {
					record(NODE_RUNTIME_MODULE_IMPORT_RULE, node, specifier);
				}
			}
			return;
		}
		if (ts.isCallExpression(node)) {
			const callee = unwrapExpression(ts, node.expression);
			// require("node:fs") / import("node:fs")
			if (
				(ts.isIdentifier(callee) && callee.text === "require") ||
				callee.kind === ts.SyntaxKind.ImportKeyword
			) {
				const specifier = staticString(ts, node.arguments[0]);
				if (specifier && isForbiddenNodeModule(specifier)) {
					record(NODE_RUNTIME_MODULE_IMPORT_RULE, node, specifier);
				}
			}
			// Bun.spawn(...) / Bun.file(...) / Bun.write(...) / Bun.$(...)
			if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
				const owner = unwrapExpression(ts, callee.expression);
				const member = ts.isPropertyAccessExpression(callee)
					? callee.name.text
					: staticString(ts, callee.argumentExpression);
				if (
					member !== undefined &&
					FORBIDDEN_BUN_MEMBERS.has(member) &&
					isGlobalReference(ts, owner, "Bun")
				) {
					record(NODE_RUNTIME_MODULE_IMPORT_RULE, node, `Bun.${member}()`);
				}
			}
			// fetch(...) / globalThis.fetch(...)
			if (
				ts.isIdentifier(callee) &&
				callee.text === "fetch" &&
				!isBindingInScope(scopeBindings, node, "fetch")
			) {
				record(DIRECT_FETCH_CALL_RULE, node, "fetch()");
			} else if (
				(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
				isGlobalReference(ts, callee, "fetch")
			) {
				record(DIRECT_FETCH_CALL_RULE, node, "globalThis.fetch()");
			}
		}
		// Bun.$`…` tagged template
		if (ts.isTaggedTemplateExpression(node)) {
			const tag = unwrapExpression(ts, node.tag);
			if (
				ts.isPropertyAccessExpression(tag) &&
				tag.name.text === "$" &&
				isGlobalReference(ts, unwrapExpression(ts, tag.expression), "Bun")
			) {
				record(NODE_RUNTIME_MODULE_IMPORT_RULE, node, "Bun.$``");
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	const findings: RuntimeBoundaryFinding[] = [];
	const acknowledged: Array<RuntimeBoundaryFinding & { reason: string }> = [];
	for (const finding of raw) {
		const reason = readAllowComment(lines, finding.line, finding.rule);
		if (reason === undefined) findings.push(finding);
		else acknowledged.push({ ...finding, reason });
	}
	return { findings, acknowledged };
}

function describeSubjects(findings: readonly RuntimeBoundaryFinding[]): string {
	const bySubject = new Map<string, number[]>();
	for (const finding of findings) {
		const lines = bySubject.get(finding.subject) ?? [];
		lines.push(finding.line);
		bySubject.set(finding.subject, lines);
	}
	return [...bySubject.entries()]
		.map(([subject, lines]) => `${subject} (line ${lines.join(", ")})`)
		.join("; ");
}

function remediation(rule: RuntimeBoundaryRule): string {
	switch (rule) {
		case PROCESS_ENV_DIRECT_READ_RULE:
			return `Provider runtime source reads the ambient environment directly. Declare the value in defineProvider (secrets: [{ name, required }] for credentials, env: true for plain settings) and read it with ctx.env.get(name) so the SDK presence gate, redaction, and Doppler projection see it. Only the ${BOOTSTRAP_ENV_NAME_PREFIX}* bootstrap family may be read from process.env, and only dev.ts/start.ts/deploy.ts and scripts/, tools/, bin/ are outside this rule. Acknowledge a deliberate exception with \`// @apifuse-allow ${PROCESS_ENV_DIRECT_READ_RULE}: <reason>\`.`;
		case NODE_RUNTIME_MODULE_IMPORT_RULE:
			return `Provider runtime source reaches the filesystem, the network, or child processes on its own. Use ctx.http / ctx.stealth for HTTP, ctx.browser for browser work, ctx.files / ctx.cache / ctx.state for data that must persist, and keep recorder or smoke tooling under scripts/. Acknowledge a deliberate exception with \`// @apifuse-allow ${NODE_RUNTIME_MODULE_IMPORT_RULE}: <reason>\`.`;
		case DIRECT_FETCH_CALL_RULE:
			return `Provider runtime source calls the global fetch(), bypassing allowedHosts, proxy policy, retries, redaction, and telemetry. Use ctx.http.get/post/request for ordinary HTTP and ctx.stealth.fetch() for browser-shaped requests. Acknowledge a deliberate exception with \`// @apifuse-allow ${DIRECT_FETCH_CALL_RULE}: <reason>\`.`;
	}
}

export type RuntimeBoundaryLintInput = {
	authFlowSource?: string;
	providerSourceFiles?: Record<string, string>;
	operations?: Record<string, { handler?: unknown; source?: string }>;
};

/**
 * Lint the provider runtime boundary. Returns warn-level diagnostics (one per
 * file and rule, listing every line) and information entries for findings
 * acknowledged with `@apifuse-allow`.
 */
export function lintRuntimeBoundary(
	ts: TypeScriptModule,
	provider: RuntimeBoundaryLintInput,
	readOperationSource: (operation: { handler?: unknown; source?: string }) => string,
): { diagnostics: LintDiagnostic[]; information: ProviderLintInformation[] } {
	const sources: Array<{ field: string; fileName: string; source: string }> = [];
	const sourceFiles = Object.entries(provider.providerSourceFiles ?? {}).filter(([filePath]) =>
		isRuntimeBoundarySourceFile(filePath),
	);
	if (Object.keys(provider.providerSourceFiles ?? {}).length > 0) {
		for (const [filePath, source] of sourceFiles) {
			sources.push({ field: `sourceFiles.${filePath}`, fileName: filePath, source });
		}
	} else {
		// In-memory providers (tests, embedded definitions) have no file tree;
		// fall back to the auth flow and operation sources the way the other
		// source rules do.
		if (provider.authFlowSource) {
			sources.push({
				field: "auth.flow",
				fileName: "auth-flow.ts",
				source: provider.authFlowSource,
			});
		}
		for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
			const source = readOperationSource(operation);
			if (source) {
				sources.push({
					field: `operations.${operationKey}.handler`,
					fileName: `${operationKey}.ts`,
					source,
				});
			}
		}
	}

	const diagnostics: LintDiagnostic[] = [];
	const information: ProviderLintInformation[] = [];
	for (const { field, fileName, source } of sources) {
		const report = analyzeRuntimeBoundary(ts, fileName, source);
		for (const rule of RUNTIME_BOUNDARY_RULES) {
			const findings = report.findings.filter((finding) => finding.rule === rule);
			if (findings.length > 0) {
				diagnostics.push({
					rule,
					level: "warn",
					field,
					message: `${describeSubjects(findings)}: ${remediation(rule)}`,
				});
			}
			for (const finding of report.acknowledged.filter((entry) => entry.rule === rule)) {
				information.push({
					rule,
					field,
					message: `Acknowledged ${finding.subject} at line ${finding.line}. Reason: ${finding.reason}`,
				});
			}
		}
	}
	return { diagnostics, information };
}
