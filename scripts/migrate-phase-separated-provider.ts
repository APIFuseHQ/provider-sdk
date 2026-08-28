#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import ts from "typescript";

type Edit = { start: number; end: number; text: string };
type Result = { file: string; changed: boolean; reason?: string };

const ignoredDirectories = new Set([".git", ".worktree", ".worktrees", "dist", "node_modules"]);
const operationHelpers = new Set(["defineOperation", "defineStreamOperation"]);
const providerSdkSpecifiers = new Set(["@apifuse/provider-sdk", "@apifuse/provider-sdk/provider"]);

function sourceFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory)) {
			if (ignoredDirectories.has(entry)) continue;
			const path = resolve(directory, entry);
			const stats = statSync(path);
			if (stats.isDirectory()) visit(path);
			else if (/\.[cm]?tsx?$/.test(entry) && !entry.endsWith(".d.ts")) files.push(path);
		}
	};
	visit(root);
	return files.sort();
}

function parsed(file: string, source: string): ts.SourceFile {
	return ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}

function callsNamed(sourceFile: ts.SourceFile, names: ReadonlySet<string>): ts.CallExpression[] {
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			names.has(node.expression.text)
		)
			calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return calls;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
	if (!property.name) return undefined;
	if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
		return property.name.text;
	return undefined;
}

function withoutProperty(
	source: string,
	object: ts.ObjectLiteralExpression,
	property: ts.ObjectLiteralElementLike,
): string {
	const properties = object.properties;
	const index = properties.indexOf(property);
	const previous = properties[index - 1];
	const next = properties[index + 1];
	let start: number;
	let end: number;
	if (previous) {
		start = previous.end;
		end = property.end;
	} else if (next) {
		start = property.getStart(object.getSourceFile());
		end = next.getStart(object.getSourceFile());
	} else {
		start = property.getStart(object.getSourceFile());
		end = property.end;
	}
	return source.slice(object.getStart(), start) + source.slice(end, object.end);
}

function operationPropertyText(
	source: string,
	property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): string {
	let text = source.slice(property.getStart(), property.end);
	const nested = callsNamed(property.getSourceFile(), operationHelpers)
		.filter((call) => call.getStart() >= property.getStart() && call.end <= property.end)
		.sort((left, right) => right.getStart() - left.getStart());
	for (const call of nested) {
		if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0]))
			throw new Error(`${call.expression.getText()}: expected one object-literal argument`);
		const argument = call.arguments[0];
		const start = call.getStart() - property.getStart();
		const end = call.end - property.getStart();
		text = text.slice(0, start) + source.slice(argument.getStart(), argument.end) + text.slice(end);
	}
	return text;
}

function applyEdits(source: string, edits: Edit[]): string {
	let output = source;
	for (const edit of edits.sort((left, right) => right.start - left.start))
		output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	return output;
}

function exportedEntryTargets(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(exportedEntryTargets);
	if (!value || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	if ("." in record) return exportedEntryTargets(record["."]);
	if (Object.keys(record).some((key) => key.startsWith("."))) return [];
	return Object.entries(record)
		.filter(([condition]) => condition !== "types")
		.flatMap(([, target]) => exportedEntryTargets(target));
}

function sourceEntryForTarget(
	root: string,
	target: string,
	files: ReadonlySet<string>,
): string | undefined {
	const absolute = resolve(root, target);
	const candidates = [absolute];
	const extension = extname(absolute);
	const sourceExtension = new Map([
		[".js", ".ts"],
		[".jsx", ".tsx"],
		[".mjs", ".mts"],
		[".cjs", ".cts"],
	]).get(extension);
	if (sourceExtension) candidates.push(absolute.slice(0, -extension.length) + sourceExtension);
	if (!extension) {
		for (const candidateExtension of [".ts", ".tsx", ".mts", ".cts"])
			candidates.push(absolute + candidateExtension);
		for (const candidateExtension of [".ts", ".tsx", ".mts", ".cts"])
			candidates.push(resolve(absolute, `index${candidateExtension}`));
	}
	return candidates.find((candidate) => files.has(candidate));
}

function defaultExportedProviderCall(file: string, source: string): boolean {
	const sourceFile = parsed(file, source);
	return callsNamed(sourceFile, new Set(["defineProvider"])).some(
		(call) => ts.isExportAssignment(call.parent) && call.parent.expression === call,
	);
}

function selectProviderEntry(
	root: string,
	files: string[],
	originals: ReadonlyMap<string, string>,
): string | undefined {
	const fileSet = new Set(files);
	const packagePath = resolve(root, "package.json");
	if (existsSync(packagePath)) {
		const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
			exports?: unknown;
			main?: unknown;
		};
		const targetGroups = [
			exportedEntryTargets(packageJson.exports),
			typeof packageJson.main === "string" ? [packageJson.main] : [],
		];
		for (const targets of targetGroups) {
			const entries = [
				...new Set(
					targets
						.map((target) => sourceEntryForTarget(root, target, fileSet))
						.filter((entry): entry is string => entry !== undefined),
				),
			];
			if (entries.length === 1) return entries[0];
			if (entries.length > 1) return undefined;
		}
	}

	const conventionalEntries = ["index.ts", "index.tsx", "index.mts", "index.cts"]
		.map((entry) => resolve(root, entry))
		.filter((entry) => fileSet.has(entry));
	if (conventionalEntries.length === 1) return conventionalEntries[0];

	const defaultExportEntries = files.filter((file) =>
		defaultExportedProviderCall(file, originals.get(file) ?? ""),
	);
	return defaultExportEntries.length === 1 ? defaultExportEntries[0] : undefined;
}

function topLevelBindingExists(sourceFile: ts.SourceFile, name: string): boolean {
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (clause?.name?.text === name) return true;
			const bindings = clause?.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) return true;
			if (
				bindings &&
				ts.isNamedImports(bindings) &&
				bindings.elements.some((element) => element.name.text === name)
			)
				return true;
			continue;
		}
		if (
			(ts.isTypeAliasDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isFunctionDeclaration(statement) ||
				ts.isEnumDeclaration(statement)) &&
			statement.name?.text === name
		)
			return true;
		if (
			ts.isVariableStatement(statement) &&
			statement.declarationList.declarations.some(
				(declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
			)
		)
			return true;
	}
	return false;
}

type ContextImportRewrite = {
	output: string;
	localNames: string[];
};

function removeSdkProviderContextImports(file: string, source: string): ContextImportRewrite {
	const sourceFile = parsed(file, source);
	const edits: Edit[] = [];
	const localNames: string[] = [];
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
			continue;
		if (!providerSdkSpecifiers.has(statement.moduleSpecifier.text)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		const matching = bindings.elements.filter(
			(element) => (element.propertyName?.text ?? element.name.text) === "ProviderContext",
		);
		if (matching.length === 0) continue;
		if (matching.length > 1)
			throw new Error("SDK import contains multiple ProviderContext bindings");
		const element = matching[0];
		localNames.push(element.name.text);
		if (bindings.elements.length === 1) {
			if (statement.importClause?.name) {
				edits.push({ start: statement.importClause.name.end, end: bindings.end, text: "" });
			} else {
				edits.push({ start: statement.getStart(), end: statement.end, text: "" });
			}
			continue;
		}
		const index = bindings.elements.indexOf(element);
		const previous = bindings.elements[index - 1];
		const next = bindings.elements[index + 1];
		edits.push(
			previous
				? { start: previous.end, end: element.end, text: "" }
				: { start: element.getStart(), end: next.getStart(), text: "" },
		);
	}
	return { output: applyEdits(source, edits), localNames: [...new Set(localNames)] };
}

function addContextImport(
	file: string,
	source: string,
	providerFile: string,
	localNames: string[],
): string {
	const specifiers = localNames.map((name) =>
		name === "ProviderContext" ? name : `ProviderContext as ${name}`,
	);
	const sourceFile = parsed(file, source);
	const imports = sourceFile.statements.filter(ts.isImportDeclaration);
	const insertion = imports.at(-1)?.end ?? 0;
	const prefix = insertion === 0 ? "" : "\n";
	const importLine = `${prefix}import type { ${specifiers.join(", ")} } from "${contextImportPath(
		file,
		providerFile,
	)}";`;
	return source.slice(0, insertion) + importLine + source.slice(insertion);
}

function addProviderContextOfImport(source: string, sourceFile: ts.SourceFile): string {
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
			continue;
		if (!statement.moduleSpecifier.text.startsWith("@apifuse/provider-sdk")) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		if (!bindings.elements.some((element) => element.name.text === "defineProvider")) continue;
		if (bindings.elements.some((element) => element.name.text === "ProviderContextOf"))
			return source;
		const bindingsText = source.slice(bindings.getStart(), bindings.end);
		if (bindingsText.includes("\n") || bindings.elements.hasTrailingComma) {
			const closingBrace = bindings.end - 1;
			const lastElement = bindings.elements.at(-1);
			const lineStart = lastElement
				? source.lastIndexOf("\n", lastElement.getStart()) + 1
				: closingBrace;
			const indentation = lastElement ? source.slice(lineStart, lastElement.getStart()) : "";
			const newElement = bindingsText.includes("\n")
				? `${indentation}type ProviderContextOf,\n`
				: "type ProviderContextOf, ";
			return (
				source.slice(0, bindings.elements.end) +
				(bindings.elements.hasTrailingComma ? "" : ",") +
				source.slice(bindings.elements.end, closingBrace) +
				newElement +
				source.slice(closingBrace)
			);
		}
		return (
			source.slice(0, bindings.elements.end) +
			", type ProviderContextOf" +
			source.slice(bindings.elements.end)
		);
	}
	throw new Error("defineProvider must be a named SDK import");
}

function migrateProviderFile(
	file: string,
	source: string,
	contextAliases: string[] = [],
): Result & { output?: string } {
	const sourceFile = parsed(file, source);
	const calls = callsNamed(sourceFile, new Set(["defineProvider"])).filter(
		(call) => call.arguments.length === 1,
	);
	if (calls.length === 0) return { file, changed: false };
	if (calls.length !== 1)
		return { file, changed: false, reason: `found ${calls.length} old defineProvider calls` };
	const call = calls[0];
	const config = call.arguments[0];
	if (!ts.isObjectLiteralExpression(config))
		return { file, changed: false, reason: "defineProvider argument is not an object literal" };
	const operationProperties = config.properties.filter(
		(property) => propertyName(property) === "operations",
	);
	if (operationProperties.length !== 1)
		return { file, changed: false, reason: "expected one direct operations property" };
	const operations = operationProperties[0];
	if (!ts.isPropertyAssignment(operations) && !ts.isShorthandPropertyAssignment(operations))
		return {
			file,
			changed: false,
			reason: "operations must be a property assignment or shorthand",
		};

	let declaration: string;
	let implementation: string;
	try {
		declaration = withoutProperty(source, config, operations);
		implementation = operationPropertyText(source, operations);
	} catch (error) {
		return { file, changed: false, reason: error instanceof Error ? error.message : String(error) };
	}

	if (
		topLevelBindingExists(sourceFile, "buildProvider") ||
		topLevelBindingExists(sourceFile, "ProviderContext")
	)
		return { file, changed: false, reason: "buildProvider or ProviderContext already exists" };
	let topLevelStatement: ts.Node = call;
	while (topLevelStatement.parent !== sourceFile) topLevelStatement = topLevelStatement.parent;
	let setup = `const buildProvider = defineProvider(${declaration});\n\n`;
	setup += "export type ProviderContext = ProviderContextOf<typeof buildProvider>;\n\n";
	for (const alias of contextAliases)
		if (alias !== "ProviderContext") setup += `type ${alias} = ProviderContext;\n\n`;
	let output = applyEdits(source, [
		{ start: topLevelStatement.getStart(), end: topLevelStatement.getStart(), text: setup },
		{ start: call.getStart(), end: call.end, text: `buildProvider({ ${implementation} })` },
	]);
	try {
		output = addProviderContextOfImport(output, parsed(file, output));
	} catch (error) {
		return {
			file,
			changed: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	return { file, changed: output !== source, output };
}

function migrateInlineProviderCalls(file: string, source: string): Result & { output?: string } {
	const sourceFile = parsed(file, source);
	const calls = callsNamed(sourceFile, new Set(["defineProvider"])).filter(
		(call) => call.arguments.length === 1,
	);
	if (calls.length === 0) return { file, changed: false };
	const edits: Edit[] = [];
	try {
		for (const call of calls) {
			const config = call.arguments[0];
			if (!ts.isObjectLiteralExpression(config))
				throw new Error("defineProvider argument is not an object literal");
			const operationProperties = config.properties.filter(
				(property) => propertyName(property) === "operations",
			);
			if (operationProperties.length !== 1)
				throw new Error("expected one direct operations property");
			const operations = operationProperties[0];
			if (!ts.isPropertyAssignment(operations) && !ts.isShorthandPropertyAssignment(operations))
				throw new Error("operations must be a property assignment or shorthand");
			const declaration = withoutProperty(source, config, operations);
			const implementation = operationPropertyText(source, operations);
			edits.push({
				start: call.getStart(),
				end: call.end,
				text: `defineProvider(${declaration})({ ${implementation} })`,
			});
		}
	} catch (error) {
		return { file, changed: false, reason: error instanceof Error ? error.message : String(error) };
	}
	return { file, changed: true, output: applyEdits(source, edits) };
}

function contextImportPath(file: string, providerFile: string): string {
	let path = relative(dirname(file), providerFile)
		.split(sep)
		.join("/")
		.replace(/\.[cm]?tsx?$/, "");
	if (!path.startsWith(".")) path = `./${path}`;
	return path;
}

function migrateOperationFile(
	file: string,
	source: string,
	providerFile: string,
	hasContextImport: boolean,
): Result & { output?: string } {
	const sourceFile = parsed(file, source);
	const calls = callsNamed(sourceFile, operationHelpers).filter(
		(call) => call.arguments.length > 0,
	);
	if (calls.length === 0) return { file, changed: false };
	if (!hasContextImport && /\bProviderContext\b/.test(source))
		return { file, changed: false, reason: "ProviderContext identifier already exists" };
	for (const call of calls) {
		if (
			call.arguments.length !== 1 ||
			!ts.isObjectLiteralExpression(call.arguments[0]) ||
			!ts.isIdentifier(call.expression)
		)
			return { file, changed: false, reason: "operation helper has an unsupported call shape" };
	}
	const edits = calls.map(
		(call): Edit => ({
			start: call.expression.end,
			end: call.expression.end,
			text: "<ProviderContext>()",
		}),
	);
	let output = applyEdits(source, edits);
	if (!hasContextImport) output = addContextImport(file, output, providerFile, ["ProviderContext"]);
	return { file, changed: true, output };
}

export function migrate(root: string, write: boolean): Result[] {
	const files = sourceFiles(root);
	const originals = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
	const selectedProviderFile = selectProviderEntry(root, files, originals);
	let provider: (Result & { output?: string }) | undefined;
	if (selectedProviderFile) {
		const original = originals.get(selectedProviderFile) ?? "";
		try {
			const rewritten = removeSdkProviderContextImports(selectedProviderFile, original);
			provider = migrateProviderFile(selectedProviderFile, rewritten.output, rewritten.localNames);
		} catch (error) {
			provider = {
				file: selectedProviderFile,
				changed: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}
	const results: Result[] = provider?.reason ? [provider] : [];
	if (!provider?.changed || provider.output === undefined) {
		const operationFiles = files.filter((file) =>
			callsNamed(parsed(file, originals.get(file) ?? ""), operationHelpers).some(
				(call) => call.arguments.length > 0,
			),
		);
		for (const file of operationFiles)
			results.push({
				file,
				changed: false,
				reason: provider?.reason
					? "cannot convert the selected provider entry"
					: "cannot select a convertible provider entry",
			});
	} else {
		const providerFile = provider.file;
		results.push(provider);
		for (const file of files) {
			if (file === providerFile) continue;
			const original = originals.get(file) ?? "";
			let result: Result & { output?: string };
			try {
				const rewritten = removeSdkProviderContextImports(file, original);
				const contextNames = [...rewritten.localNames];
				const hasOperationCalls = callsNamed(parsed(file, rewritten.output), operationHelpers).some(
					(call) => call.arguments.length > 0,
				);
				if (hasOperationCalls && !contextNames.includes("ProviderContext"))
					contextNames.push("ProviderContext");
				const withContextImport =
					contextNames.length > 0
						? addContextImport(file, rewritten.output, providerFile, contextNames)
						: rewritten.output;
				result = migrateOperationFile(
					file,
					withContextImport,
					providerFile,
					contextNames.includes("ProviderContext"),
				);
				if (!result.changed && !result.reason && withContextImport !== original)
					result = { file, changed: true, output: withContextImport };
			} catch (error) {
				result = {
					file,
					changed: false,
					reason: error instanceof Error ? error.message : String(error),
				};
			}
			if (result.changed || result.reason) results.push(result);
		}
	}

	if (write) {
		for (const result of results) {
			if (!result.changed) continue;
			const output = (result as Result & { output?: string }).output;
			if (output !== undefined) writeFileSync(result.file, output);
		}
	}
	return results;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const write = args.includes("--write");
	const inlineOnly = args.includes("--inline-only");
	const positional = args.filter(
		(argument) => argument !== "--write" && argument !== "--inline-only",
	);
	const root = resolve(positional[0] ?? ".");
	const results = inlineOnly
		? sourceFiles(root)
				.map((file) => migrateInlineProviderCalls(file, readFileSync(file, "utf8")))
				.filter((result) => result.changed || result.reason)
		: migrate(root, write);
	if (write && inlineOnly) {
		for (const result of results) {
			if (!result.changed || result.output === undefined) continue;
			writeFileSync(result.file, result.output);
		}
	}
	for (const result of results) {
		const path = relative(root, result.file) || result.file;
		if (result.changed) console.log(`${write ? "converted" : "would convert"}: ${path}`);
		else if (result.reason) console.error(`unchanged: ${path}: ${result.reason}`);
	}
	const changed = results.filter((result) => result.changed).length;
	const declined = results.filter((result) => result.reason).length;
	console.log(
		`${write ? "converted" : "convertible"} ${changed} file(s); declined ${declined} file(s)`,
	);
	if (declined > 0) process.exitCode = 1;
}
