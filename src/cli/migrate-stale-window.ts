import { writeFileSync } from "node:fs";

import type TS from "typescript";

import { getTypeScript, type TypeScriptModule } from "../typescript-module.js";
import {
	applyEdits,
	byPosition,
	fileExists,
	finding,
	importInsertionPoint,
	importSpecifierOf,
	importStyleOf,
	importsOf,
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
 * `health-stale-window`: a per-call `staleIfErrorMs` on `ctx.cache.getOrSet`
 * / `ctx.cache.set` becomes the operation's own declaration
 * (`cache: { staleIfErrorMs }`) and leaves the call.
 *
 * The call usually sits in a helper (`cachedJson`, `getRakuten`) that several
 * operations reach, so the operation is found through the handler's call
 * graph: every function the handler calls, by name, across the provider's
 * files, following imports. An operation that reaches two different windows,
 * a call no operation reaches, an operation already declaring another window,
 * and a window that is not a number or a named constant are residues; their
 * calls keep the option so stale serving never switches off silently.
 */

export const STALE_WINDOW_RULES = {
	twoValues: "health-stale-window-two-values",
	unreachable: "health-stale-window-unreachable",
	declaredDifferently: "health-stale-window-declared-differently",
	valueNotPortable: "health-stale-window-value-not-portable",
	nameTaken: "health-stale-window-name-taken",
	noCacheCapability: "health-stale-window-no-cache-capability",
} as const;

export type StaleWindowOptions = {
	readonly providerRoot: string;
	readonly dryRun: boolean;
	readonly ts?: TypeScriptModule;
};

type FunctionNode =
	| TS.FunctionDeclaration
	| TS.FunctionExpression
	| TS.ArrowFunction
	| TS.MethodDeclaration;

type Definition = {
	readonly name: string;
	readonly file: ProviderSourceFile;
	readonly node: FunctionNode;
	readonly exported: boolean;
};

type Site = {
	readonly file: ProviderSourceFile;
	readonly call: TS.CallExpression;
	readonly options: TS.ObjectLiteralExpression;
	readonly pair: TS.PropertyAssignment;
	readonly window: TS.Expression;
	readonly lexicalOperation?: Operation;
	readonly owner?: Definition;
};

type Operation = {
	readonly file: ProviderSourceFile;
	readonly object: TS.ObjectLiteralExpression;
	readonly handler: TS.PropertyAssignment | TS.MethodDeclaration;
};

type Window = {
	readonly text: string;
	readonly identifier?: {
		readonly name: string;
		readonly declaredIn: ProviderSourceFile;
		readonly exported: boolean;
		readonly statement: TS.VariableStatement;
	};
};

type FileEdits = { readonly file: ProviderSourceFile; readonly edits: TextEdit[] };

export function moveStaleWindowToOperations(options: StaleWindowOptions): SourceStepResult {
	const ts = options.ts ?? getTypeScript();
	const sources = readProviderSources(ts, options.providerRoot);
	const residues: MigrateFinding[] = [];
	const notes: MigrateFinding[] = [];
	const graph = new CallGraph(ts, sources);

	const operations = collectOperations(ts, sources);
	const sites = collectSites(ts, sources, graph);
	if (sites.length === 0) {
		return { filesChanged: [], rewrites: 0, notes, residues };
	}

	const reach = new Map<Operation, Set<Definition>>();
	for (const operation of operations) {
		reach.set(operation, graph.reachableFrom(operation));
	}

	const sitesOf = new Map<Operation, Site[]>();
	const operationsOf = new Map<Site, Operation[]>();
	for (const site of sites) {
		const reaching: Operation[] = [];
		for (const operation of operations) {
			const lexical = site.lexicalOperation?.object === operation.object;
			const viaGraph = site.owner !== undefined && (reach.get(operation)?.has(site.owner) ?? false);
			if (lexical || viaGraph) {
				reaching.push(operation);
				const list = sitesOf.get(operation) ?? [];
				list.push(site);
				sitesOf.set(operation, list);
			}
		}
		operationsOf.set(site, reaching);
		if (reaching.length === 0) {
			residues.push(
				finding(
					site.file,
					site.pair.getStart(site.file.source),
					STALE_WINDOW_RULES.unreachable,
					"staleIfErrorMs is passed per cache call and no operation handler reaches this call by name; the option is left in place.",
					"Declare the window on each operation that serves this cache (defineOperation({ cache: { staleIfErrorMs } })), then delete the option here.",
				),
			);
		}
	}

	const satisfied = new Set<Operation>();
	const edits = new Map<string, FileEdits>();
	let rewrites = 0;
	const capability = cacheCapability(ts, sources);
	if (capability.kind === "missing" && sitesOf.size > 0) {
		residues.push(
			finding(
				sources[0] as ProviderSourceFile,
				0,
				STALE_WINDOW_RULES.noCacheCapability,
				"No defineProvider declaration with a `cache` capability was found, and an operation-level stale window needs one; the per-call options are left in place.",
				"Add `cache: true` to the provider declaration passed to defineProvider, then re-run apifuse migrate.",
			),
		);
		sitesOf.clear();
	}
	let declaredAny = false;
	for (const [operation, operationSites] of sitesOf) {
		const windows = new Map<string, Window>();
		let portable = true;
		for (const site of operationSites) {
			const window = resolveWindow(ts, sources, site);
			if (window === undefined) {
				residues.push(
					finding(
						site.file,
						site.window.getStart(site.file.source),
						STALE_WINDOW_RULES.valueNotPortable,
						"staleIfErrorMs is neither a number nor a named top-level constant, so it cannot be declared on the operation; the option is left in place.",
						"Name the window as a top-level constant (export const STALE_IF_ERROR_MS = ...), then re-run apifuse migrate.",
					),
				);
				portable = false;
				continue;
			}
			windows.set(windowKey(window), window);
		}
		if (!portable) continue;
		const handlerStart = operation.handler.getStart(operation.file.source);
		if (windows.size > 1) {
			residues.push(
				finding(
					operation.file,
					handlerStart,
					STALE_WINDOW_RULES.twoValues,
					`This operation reaches cache calls with different stale windows (${[...windows.values()].map((window) => window.text).join(", ")}); one declaration serves one window, so the per-call options are left in place.`,
					"Declare the one window this operation wants (defineOperation({ cache: { staleIfErrorMs } })), delete the per-call options it reaches, and give the other window its own operation or cache key.",
				),
			);
			continue;
		}
		const window = [...windows.values()][0] as Window;
		const declared = propertyOf(ts, operation.object, "cache");
		if (declared !== undefined) {
			const declaredWindow = declaredStaleWindow(ts, operation.file, declared);
			if (declaredWindow === window.text) {
				satisfied.add(operation);
				continue;
			}
			residues.push(
				finding(
					operation.file,
					declared.getStart(operation.file.source),
					STALE_WINDOW_RULES.declaredDifferently,
					`This operation declares cache.staleIfErrorMs ${declaredWindow ?? "(unreadable)"} while a cache call it reaches passes ${window.text}; the per-call option is left in place.`,
					"Make the declaration and the call agree, then delete the per-call option.",
				),
			);
			continue;
		}
		const importEdits = importWindow(ts, operation.file, window, residues);
		if (importEdits === undefined) continue;
		const text = operation.file.text;
		const indent = lineIndentAt(text, handlerStart);
		editsFor(edits, operation.file).push(
			{
				start: handlerStart,
				end: handlerStart,
				text: `cache: { staleIfErrorMs: ${window.text} },\n${indent}`,
			},
			...importEdits.importing,
		);
		if (importEdits.exporting !== undefined) {
			editsFor(edits, importEdits.exporting.file).push(importEdits.exporting.edit);
		}
		rewrites += 1;
		satisfied.add(operation);
		declaredAny = true;
	}
	if (capability.kind === "declare" && declaredAny) {
		editsFor(edits, capability.file).push(capability.edit);
		rewrites += 1;
	}

	for (const site of sites) {
		const reaching = operationsOf.get(site) ?? [];
		if (reaching.length === 0 || !reaching.every((operation) => satisfied.has(operation))) {
			continue;
		}
		editsFor(edits, site.file).push(removeOptionEdit(site));
		rewrites += 1;
	}

	const filesChanged: string[] = [];
	for (const [path, { file, edits: fileEdits }] of edits) {
		const deduped = dedupeEdits(fileEdits);
		if (deduped.length === 0) continue;
		filesChanged.push(path);
		if (!options.dryRun) writeFileSync(file.absolutePath, applyEdits(file.text, deduped));
	}
	return {
		filesChanged: filesChanged.sort(),
		rewrites,
		notes: notes.sort(byPosition),
		residues: residues.sort(byPosition),
	};
}

// An operation-level stale window needs the provider's `cache` capability
// (`defineProvider({ cache: true })`); a per-call window never did. One
// defineProvider call without a `cache` property gets `cache: true` added.
function cacheCapability(
	ts: TypeScriptModule,
	sources: readonly ProviderSourceFile[],
):
	| { readonly kind: "present" }
	| { readonly kind: "declare"; readonly file: ProviderSourceFile; readonly edit: TextEdit }
	| { readonly kind: "missing" } {
	const declarations: Array<{ file: ProviderSourceFile; object: TS.ObjectLiteralExpression }> = [];
	for (const file of sources) {
		const visit = (node: TS.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "defineProvider"
			) {
				const argument = node.arguments[0];
				const object = argument === undefined ? undefined : unwrapExpression(ts, argument);
				if (object !== undefined && ts.isObjectLiteralExpression(object)) {
					declarations.push({ file, object });
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file.source);
	}
	if (declarations.some(({ object }) => propertyOf(ts, object, "cache") !== undefined)) {
		return { kind: "present" };
	}
	const [declaration] = declarations;
	if (declaration === undefined || declarations.length > 1) return { kind: "missing" };
	const { file, object } = declaration;
	const last = object.properties[object.properties.length - 1];
	if (last === undefined) return { kind: "missing" };
	const indent = lineIndentAt(file.text, last.getStart(file.source));
	const afterLast = file.text.slice(last.end, object.end);
	const comma = afterLast.indexOf(",");
	const at = comma === -1 ? last.end : last.end + comma + 1;
	const text = comma === -1 ? `,\n${indent}cache: true` : `\n${indent}cache: true,`;
	return { kind: "declare", file, edit: { start: at, end: at, text } };
}

function editsFor(edits: Map<string, FileEdits>, file: ProviderSourceFile): TextEdit[] {
	let entry = edits.get(file.path);
	if (entry === undefined) {
		entry = { file, edits: [] };
		edits.set(file.path, entry);
	}
	return entry.edits;
}

function dedupeEdits(edits: readonly TextEdit[]): TextEdit[] {
	const seen = new Set<string>();
	const out: TextEdit[] = [];
	for (const edit of edits) {
		const key = `${edit.start}:${edit.end}:${edit.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(edit);
	}
	return out;
}

function windowKey(window: Window): string {
	return window.identifier === undefined
		? `literal:${window.text}`
		: `${window.identifier.declaredIn.path}:${window.identifier.name}`;
}

function collectOperations(
	ts: TypeScriptModule,
	sources: readonly ProviderSourceFile[],
): Operation[] {
	const operations: Operation[] = [];
	for (const file of sources) {
		const visit = (node: TS.Node): void => {
			if (ts.isObjectLiteralExpression(node) && isOperationObject(ts, node)) {
				const handler = node.properties.find(
					(property) =>
						(ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
						propertyName(ts, property.name) === "handler",
				) as TS.PropertyAssignment | TS.MethodDeclaration | undefined;
				if (handler !== undefined) operations.push({ file, object: node, handler });
			}
			ts.forEachChild(node, visit);
		};
		visit(file.source);
	}
	return operations;
}

function collectSites(
	ts: TypeScriptModule,
	sources: readonly ProviderSourceFile[],
	graph: CallGraph,
): Site[] {
	const sites: Site[] = [];
	for (const file of sources) {
		const visit = (node: TS.Node): void => {
			if (ts.isCallExpression(node)) {
				const callee = node.expression;
				if (
					ts.isPropertyAccessExpression(callee) &&
					(callee.name.text === "getOrSet" || callee.name.text === "set") &&
					ts.isPropertyAccessExpression(callee.expression) &&
					callee.expression.name.text === "cache"
				) {
					const last = node.arguments[node.arguments.length - 1];
					const options = last === undefined ? undefined : unwrapExpression(ts, last);
					if (options !== undefined && ts.isObjectLiteralExpression(options)) {
						const pair = propertyOf(ts, options, "staleIfErrorMs");
						if (pair !== undefined) {
							const lexicalOperation = lexicalOperationOf(ts, file, node);
							const owner = graph.ownerOf(node);
							sites.push({
								file,
								call: node,
								options,
								pair,
								window: unwrapExpression(ts, pair.initializer),
								...(lexicalOperation === undefined ? {} : { lexicalOperation }),
								...(owner === undefined ? {} : { owner }),
							});
						}
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file.source);
	}
	return sites;
}

function lexicalOperationOf(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	node: TS.Node,
): Operation | undefined {
	let current: TS.Node = node;
	while (current.parent !== undefined) {
		const parent: TS.Node = current.parent;
		if (
			ts.isObjectLiteralExpression(parent) &&
			isOperationObject(ts, parent) &&
			(ts.isPropertyAssignment(current) || ts.isMethodDeclaration(current)) &&
			propertyName(ts, current.name) === "handler"
		) {
			return { file, object: parent, handler: current };
		}
		current = parent;
	}
	return undefined;
}

function resolveWindow(
	ts: TypeScriptModule,
	sources: readonly ProviderSourceFile[],
	site: Site,
): Window | undefined {
	const expression = site.window;
	if (ts.isNumericLiteral(expression)) {
		return { text: site.file.text.slice(expression.getStart(site.file.source), expression.end) };
	}
	if (!ts.isIdentifier(expression)) return undefined;
	const name = expression.text;
	const local = topLevelConst(ts, site.file, name);
	if (local !== undefined) {
		return { text: name, identifier: { name, declaredIn: site.file, ...local } };
	}
	for (const declaration of importsOf(ts, site.file.source)) {
		const named = namedImportsOf(ts, declaration);
		const imported = named.get(name);
		if (imported === undefined) continue;
		const specifier = importSpecifierOf(ts, declaration);
		if (specifier === undefined) return undefined;
		const target = resolveRelativeImport(site.file.path, specifier, (candidate) =>
			sources.some((file) => file.path === candidate),
		);
		const declaredIn = sources.find((file) => file.path === target);
		if (declaredIn === undefined) return undefined;
		const remote = topLevelConst(ts, declaredIn, imported);
		if (remote === undefined) return undefined;
		return { text: imported, identifier: { name: imported, declaredIn, ...remote } };
	}
	return undefined;
}

function topLevelConst(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	name: string,
): { exported: boolean; statement: TS.VariableStatement } | undefined {
	for (const statement of file.source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
				const exported =
					statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
					false;
				return { exported, statement };
			}
		}
	}
	return undefined;
}

function declaredStaleWindow(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	declared: TS.PropertyAssignment,
): string | undefined {
	const object = unwrapExpression(ts, declared.initializer);
	if (!ts.isObjectLiteralExpression(object)) return undefined;
	const pair = propertyOf(ts, object, "staleIfErrorMs");
	if (pair === undefined) return undefined;
	const value = unwrapExpression(ts, pair.initializer);
	return file.text.slice(value.getStart(file.source), value.end);
}

function importWindow(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	window: Window,
	residues: MigrateFinding[],
):
	| {
			readonly importing: TextEdit[];
			readonly exporting?: { readonly file: ProviderSourceFile; readonly edit: TextEdit };
	  }
	| undefined {
	if (window.identifier === undefined || window.identifier.declaredIn.path === file.path) {
		return { importing: [] };
	}
	const { name, declaredIn, exported, statement } = window.identifier;
	const specifier = relativeSpecifier(file.path, declaredIn.path);
	for (const declaration of importsOf(ts, file.source)) {
		const named = namedImportsOf(ts, declaration);
		if (!named.has(name)) continue;
		const target = (importSpecifierOf(ts, declaration) ?? "").replace(/\.[cm]?js$/, "");
		if (target === specifier && named.get(name) === name) return { importing: [] };
		residues.push(
			finding(
				file,
				declaration.getStart(file.source),
				STALE_WINDOW_RULES.nameTaken,
				`This file already imports a different \`${name}\`, so the stale window constant cannot be imported under that name; the per-call option is left in place.`,
				"Rename one of the two constants, then re-run apifuse migrate.",
			),
		);
		return undefined;
	}
	if (topLevelConst(ts, file, name) !== undefined) {
		residues.push(
			finding(
				file,
				file.source.statements[0]?.getStart(file.source) ?? 0,
				STALE_WINDOW_RULES.nameTaken,
				`This file declares its own \`${name}\`, so the stale window constant cannot be imported under that name; the per-call option is left in place.`,
				"Rename one of the two constants, then re-run apifuse migrate.",
			),
		);
		return undefined;
	}
	const style = importStyleOf(ts, file);
	const at = importInsertionPoint(ts, file);
	const importing: TextEdit[] = [
		{
			start: at,
			end: at,
			text: `import { ${name} } from ${style.quote}${specifier}${style.extension}${style.quote}${style.semi}\n`,
		},
	];
	if (exported) return { importing };
	const start = statement.getStart(declaredIn.source);
	return {
		importing,
		exporting: { file: declaredIn, edit: { start, end: start, text: "export " } },
	};
}

function removeOptionEdit(site: Site): TextEdit {
	const text = site.file.text;
	const properties = site.options.properties;
	if (properties.length === 1) {
		const arguments_ = site.call.arguments;
		const previous = arguments_[arguments_.length - 2];
		const start = previous === undefined ? site.options.getStart(site.file.source) : previous.end;
		return { start, end: site.options.end, text: "" };
	}
	const index = properties.indexOf(site.pair);
	const previous = properties[index - 1];
	const next = properties[index + 1];
	if (next !== undefined) {
		return {
			start: site.pair.getStart(site.file.source),
			end: next.getStart(site.file.source),
			text: "",
		};
	}
	const start = previous === undefined ? site.pair.getStart(site.file.source) : previous.end;
	let end = site.pair.end;
	while (end < text.length && /[ \t]/.test(text[end] as string)) end += 1;
	return { start, end: text[end] === "," ? end + 1 : site.pair.end, text: "" };
}

class CallGraph {
	private readonly definitions = new Map<string, Definition[]>();
	private readonly byNode = new Map<TS.Node, Definition>();

	constructor(
		private readonly ts: TypeScriptModule,
		private readonly sources: readonly ProviderSourceFile[],
	) {
		for (const file of sources) this.index(file);
	}

	private index(file: ProviderSourceFile): void {
		const ts = this.ts;
		const add = (name: string, node: FunctionNode, exported: boolean): void => {
			const definition: Definition = { name, file, node, exported };
			const list = this.definitions.get(name) ?? [];
			list.push(definition);
			this.definitions.set(name, list);
			this.byNode.set(node, definition);
		};
		const isExported = (node: TS.Node): boolean =>
			ts.canHaveModifiers(node) &&
			(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
				false);
		const visit = (node: TS.Node): void => {
			if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
				add(node.name.text, node, isExported(node));
			} else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
				const initializer =
					node.initializer === undefined ? undefined : unwrapExpression(ts, node.initializer);
				if (
					initializer !== undefined &&
					(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
				) {
					const statement = node.parent.parent;
					add(node.name.text, initializer, isExported(statement));
				}
			} else if (ts.isMethodDeclaration(node)) {
				const name = propertyName(ts, node.name);
				if (name !== undefined) add(name, node, true);
			} else if (ts.isPropertyAssignment(node)) {
				const name = propertyName(ts, node.name);
				const initializer = unwrapExpression(ts, node.initializer);
				if (
					name !== undefined &&
					(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
				) {
					add(name, initializer, true);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file.source);
	}

	/** The outermost function definition that contains `node`, when it has a name. */
	ownerOf(node: TS.Node): Definition | undefined {
		let owner: Definition | undefined;
		let current: TS.Node | undefined = node;
		while (current !== undefined) {
			const definition = this.byNode.get(current);
			if (definition !== undefined) owner = definition;
			current = current.parent;
		}
		return owner;
	}

	/** Every function definition the operation's handler reaches by name. */
	reachableFrom(operation: Operation): Set<Definition> {
		const ts = this.ts;
		const reached = new Set<Definition>();
		const queue: Array<{ file: ProviderSourceFile; node: TS.Node }> = [];
		const handler = operation.handler;
		if (ts.isMethodDeclaration(handler)) {
			queue.push({ file: operation.file, node: handler });
		} else {
			const initializer = unwrapExpression(ts, handler.initializer);
			const named = this.candidatesFor(operation.file, initializer);
			if (named !== undefined) {
				for (const definition of named) {
					if (!reached.has(definition)) {
						reached.add(definition);
						queue.push({ file: definition.file, node: definition.node });
					}
				}
			} else {
				queue.push({ file: operation.file, node: initializer });
			}
		}
		while (queue.length > 0) {
			const { file, node } = queue.shift() as { file: ProviderSourceFile; node: TS.Node };
			const visit = (child: TS.Node): void => {
				let callee: TS.Expression | undefined;
				if (ts.isCallExpression(child)) callee = child.expression;
				else if (ts.isIdentifier(child) && !ts.isCallExpression(child.parent)) callee = child;
				for (const definition of callee === undefined
					? []
					: (this.candidatesFor(file, callee) ?? [])) {
					if (!reached.has(definition)) {
						reached.add(definition);
						queue.push({ file: definition.file, node: definition.node });
					}
				}
				ts.forEachChild(child, visit);
			};
			visit(node);
		}
		return reached;
	}

	/**
	 * The definitions an expression may call: a bare identifier resolves
	 * through imports; `a.f` and `a["f"]` match every definition named `f`
	 * (the receiver is not typed here). Undefined for a shape with no name.
	 */
	private candidatesFor(file: ProviderSourceFile, callee: TS.Expression): Definition[] | undefined {
		const ts = this.ts;
		if (ts.isIdentifier(callee)) return this.resolve(file, callee.text);
		if (ts.isPropertyAccessExpression(callee)) return this.definitions.get(callee.name.text) ?? [];
		if (ts.isElementAccessExpression(callee)) {
			const argument = unwrapExpression(ts, callee.argumentExpression);
			if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
				return this.definitions.get(argument.text) ?? [];
			}
		}
		return undefined;
	}

	/** The definitions a bare identifier in `file` names: a local one, else the imported module's export of that name. */
	private resolve(file: ProviderSourceFile, name: string): Definition[] {
		const ts = this.ts;
		const all = this.definitions.get(name) ?? [];
		const local = all.filter((definition) => definition.file === file);
		if (local.length > 0) return local;
		for (const declaration of importsOf(ts, file.source)) {
			const imported = namedImportsOf(ts, declaration).get(name);
			if (imported === undefined) continue;
			const specifier = importSpecifierOf(ts, declaration);
			if (specifier === undefined) return [];
			const target = resolveRelativeImport(
				file.path,
				specifier,
				(candidate) =>
					this.sources.some((source) => source.path === candidate) || fileExists(candidate),
			);
			const remote = (this.definitions.get(imported) ?? []).filter(
				(definition) => definition.file.path === target,
			);
			return remote;
		}
		return [];
	}
}
