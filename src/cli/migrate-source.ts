import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type TS from "typescript";

import { scriptKindForSourceFile, type TypeScriptModule } from "../typescript-module.js";

/**
 * What the TypeScript-backed migrate steps (`errors-hoist`,
 * `health-stale-window`) share: the provider's source files parsed once,
 * text-range edits applied back to front, and the residue/note shape the
 * `apifuse migrate` report prints.
 */

export type MigrateFinding = {
	readonly ruleId: string;
	/** Relative to the provider root. */
	readonly file: string;
	/** 1-based. */
	readonly line: number;
	/** 1-based. */
	readonly column: number;
	readonly message: string;
	readonly note?: string;
};

export type SourceStepResult = {
	readonly filesChanged: readonly string[];
	readonly rewrites: number;
	readonly notes: readonly MigrateFinding[];
	readonly residues: readonly MigrateFinding[];
};

export type ProviderSourceFile = {
	/** Relative to the provider root, forward slashes. */
	readonly path: string;
	readonly absolutePath: string;
	readonly text: string;
	readonly source: TS.SourceFile;
};

const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	".git",
	".worktree",
	".worktrees",
	".tmp",
]);

function isSourceFileName(name: string): boolean {
	if (name.endsWith(".d.ts")) return false;
	if (name.endsWith(".test.ts") || name.endsWith(".spec.ts")) return false;
	return name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mts");
}

function walk(root: string, directory: string, out: string[]): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name === "__tests__") continue;
			walk(root, join(directory, entry.name), out);
		} else if (entry.isFile() && isSourceFileName(entry.name)) {
			out.push(join(directory, entry.name));
		}
	}
}

/** Every provider source file (not tests, not generated output), parsed. */
export function readProviderSources(ts: TypeScriptModule, root: string): ProviderSourceFile[] {
	const files: string[] = [];
	walk(root, root, files);
	return files.sort().map((absolutePath) => parseProviderSource(ts, root, absolutePath));
}

export function parseProviderSource(
	ts: TypeScriptModule,
	root: string,
	absolutePath: string,
): ProviderSourceFile {
	const text = readFileSync(absolutePath, "utf8");
	return {
		path: relative(root, absolutePath).split("\\").join("/"),
		absolutePath,
		text,
		source: ts.createSourceFile(
			absolutePath,
			text,
			ts.ScriptTarget.Latest,
			true,
			scriptKindForSourceFile(ts, absolutePath),
		),
	};
}

export function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export type TextEdit = { readonly start: number; readonly end: number; readonly text: string };

/** Applies non-overlapping edits to `text`; throws on an overlap (a bug in the step, never a provider fault). */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
	const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
	let out = "";
	let cursor = 0;
	for (const edit of ordered) {
		if (edit.start < cursor) {
			throw new Error(`overlapping edits at ${edit.start} (cursor ${cursor})`);
		}
		out += text.slice(cursor, edit.start) + edit.text;
		cursor = edit.end;
	}
	return out + text.slice(cursor);
}

export function positionOf(
	file: ProviderSourceFile,
	position: number,
): { readonly line: number; readonly column: number } {
	const { line, character } = file.source.getLineAndCharacterOfPosition(position);
	return { line: line + 1, column: character + 1 };
}

export function finding(
	file: ProviderSourceFile,
	position: number,
	ruleId: string,
	message: string,
	note?: string,
): MigrateFinding {
	return {
		ruleId,
		file: file.path,
		...positionOf(file, position),
		message,
		...(note === undefined ? {} : { note }),
	};
}

export function byPosition(a: MigrateFinding, b: MigrateFinding): number {
	return (
		a.file.localeCompare(b.file) ||
		a.line - b.line ||
		a.column - b.column ||
		a.ruleId.localeCompare(b.ruleId)
	);
}

/** The indentation unit the file uses (`\t` or the run of spaces on its first indented line). */
export function indentUnitOf(text: string): string {
	const match = /^( +|\t)\S/m.exec(text);
	return match?.[1] ?? "\t";
}

/** The leading whitespace of the line `position` sits on. */
export function lineIndentAt(text: string, position: number): string {
	const lineStart = text.lastIndexOf("\n", position - 1) + 1;
	const match = /^[ \t]*/.exec(text.slice(lineStart, position));
	return match?.[0] ?? "";
}

export function propertyName(ts: TypeScriptModule, name: TS.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
	if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return undefined;
}

export function propertyOf(
	ts: TypeScriptModule,
	object: TS.ObjectLiteralExpression,
	name: string,
): TS.PropertyAssignment | undefined {
	for (const property of object.properties) {
		if (ts.isPropertyAssignment(property) && propertyName(ts, property.name) === name) {
			return property;
		}
	}
	return undefined;
}

export function hasProperty(
	ts: TypeScriptModule,
	object: TS.ObjectLiteralExpression,
	name: string,
): boolean {
	return object.properties.some(
		(property) =>
			(ts.isPropertyAssignment(property) ||
				ts.isShorthandPropertyAssignment(property) ||
				ts.isMethodDeclaration(property)) &&
			propertyName(ts, property.name) === name,
	);
}

/** Strips `as const` / `satisfies T` / parentheses around an expression. */
export function unwrapExpression(ts: TypeScriptModule, node: TS.Expression): TS.Expression {
	let current = node;
	for (;;) {
		if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
			current = current.expression;
		} else if (ts.isParenthesizedExpression(current)) {
			current = current.expression;
		} else {
			return current;
		}
	}
}

/**
 * An object literal that defines an operation: it has a `handler` and at least
 * one declaration-only field. A `docs: { errorCodes }` block or a lookup row
 * has neither.
 */
export function isOperationObject(
	ts: TypeScriptModule,
	object: TS.ObjectLiteralExpression,
): boolean {
	if (!hasProperty(ts, object, "handler")) return false;
	return ["input", "output", "riskClass", "descriptionKey", "description", "healthCheck"].some(
		(name) => hasProperty(ts, object, name),
	);
}

export function importsOf(ts: TypeScriptModule, source: TS.SourceFile): TS.ImportDeclaration[] {
	return source.statements.filter((statement): statement is TS.ImportDeclaration =>
		ts.isImportDeclaration(statement),
	);
}

export function importSpecifierOf(
	ts: TypeScriptModule,
	declaration: TS.ImportDeclaration,
): string | undefined {
	return ts.isStringLiteral(declaration.moduleSpecifier)
		? declaration.moduleSpecifier.text
		: undefined;
}

export function namedImportsOf(
	ts: TypeScriptModule,
	declaration: TS.ImportDeclaration,
): Map<string, string> {
	const out = new Map<string, string>();
	const bindings = declaration.importClause?.namedBindings;
	if (bindings !== undefined && ts.isNamedImports(bindings)) {
		for (const element of bindings.elements) {
			out.set(element.name.text, (element.propertyName ?? element.name).text);
		}
	}
	return out;
}

/**
 * The import style a file already uses: its quote character, whether relative
 * specifiers carry a `.js` extension, and whether statements end in `;`.
 */
export type ImportStyle = {
	readonly quote: string;
	readonly extension: string;
	readonly semi: string;
};

export function importStyleOf(ts: TypeScriptModule, file: ProviderSourceFile): ImportStyle {
	const imports = importsOf(ts, file.source);
	const first = imports[0];
	const quote =
		first !== undefined && file.text[first.moduleSpecifier.getStart(file.source)] === "'"
			? "'"
			: '"';
	const relativeSpecifiers = imports
		.map((declaration) => importSpecifierOf(ts, declaration))
		.filter((specifier): specifier is string => specifier?.startsWith(".") === true);
	const extension = relativeSpecifiers.some((specifier) => /\.[cm]?js$/.test(specifier))
		? ".js"
		: "";
	const semi =
		first === undefined || file.text.slice(first.getStart(file.source), first.end).endsWith(";")
			? ";"
			: "";
	return { quote, extension, semi };
}

/** Where a new import statement goes: after the last import, else at the top (after a shebang). */
export function importInsertionPoint(ts: TypeScriptModule, file: ProviderSourceFile): number {
	const imports = importsOf(ts, file.source);
	const last = imports[imports.length - 1];
	if (last !== undefined) {
		const lineEnd = file.text.indexOf("\n", last.end);
		return lineEnd === -1 ? file.text.length : lineEnd + 1;
	}
	if (file.text.startsWith("#!")) {
		const lineEnd = file.text.indexOf("\n");
		return lineEnd === -1 ? file.text.length : lineEnd + 1;
	}
	return 0;
}

/** A relative module specifier from `fromFile` to `toFile` (both provider-relative, forward slashes), without extension. */
export function relativeSpecifier(fromFile: string, toFile: string): string {
	const fromParts = fromFile.split("/").slice(0, -1);
	const toParts = toFile.replace(/\.[cm]?tsx?$/, "").split("/");
	let common = 0;
	while (
		common < fromParts.length &&
		common < toParts.length - 1 &&
		fromParts[common] === toParts[common]
	) {
		common += 1;
	}
	const up = fromParts.length - common;
	const down = toParts.slice(common);
	const prefix = up === 0 ? "./" : "../".repeat(up);
	return prefix + down.join("/");
}

/** Resolves a relative import specifier against the importing file; provider-relative result or undefined for a bare specifier. */
export function resolveRelativeImport(
	fromFile: string,
	specifier: string,
	exists: (candidate: string) => boolean,
): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = fromFile.split("/").slice(0, -1);
	for (const segment of specifier.split("/")) {
		if (segment === "." || segment === "") continue;
		if (segment === "..") base.pop();
		else base.push(segment);
	}
	const joined = base.join("/");
	const stripped = joined.replace(/\.[cm]?js$/, "");
	const candidates = [
		stripped,
		`${stripped}.ts`,
		`${stripped}.tsx`,
		`${stripped}.mts`,
		`${stripped}/index.ts`,
	];
	return candidates.find((candidate) => candidate.endsWith(".ts") && exists(candidate));
}

/** Every comment (as written, one line each) that leads or sits inside `node`. */
export function commentsAround(
	ts: TypeScriptModule,
	file: ProviderSourceFile,
	node: TS.Node,
): string[] {
	const text = file.text;
	const lines: string[] = [];
	const push = (ranges: readonly TS.CommentRange[] | undefined): void => {
		for (const range of ranges ?? []) {
			for (const line of text.slice(range.pos, range.end).split("\n")) {
				lines.push(line.trim());
			}
		}
	};
	push(ts.getLeadingCommentRanges(text, node.getFullStart()));
	if (ts.isObjectLiteralExpression(node)) {
		for (const property of node.properties) {
			push(ts.getLeadingCommentRanges(text, property.getFullStart()));
			push(ts.getTrailingCommentRanges(text, property.end));
		}
		// A comment after the last property, before the closing brace.
		const last = node.properties[node.properties.length - 1];
		if (last !== undefined) {
			const tail = text.slice(last.end, node.end);
			const commaOffset = tail.indexOf(",");
			if (commaOffset !== -1) {
				push(ts.getTrailingCommentRanges(text, last.end + commaOffset + 1));
				push(ts.getLeadingCommentRanges(text, last.end + commaOffset + 1));
			}
		}
	}
	return [...new Set(lines)].filter((line) => line.length > 0);
}
