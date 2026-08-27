#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

type Edit = { start: number; end: number; text: string };
type Result = { file: string; changed: boolean; reason?: string };

const ignoredDirectories = new Set([".git", ".worktree", "dist", "node_modules"]);
const operationHelpers = new Set(["defineOperation", "defineStreamOperation"]);

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
		return (
			source.slice(0, bindings.elements.end) +
			", type ProviderContextOf" +
			source.slice(bindings.elements.end)
		);
	}
	throw new Error("defineProvider must be a named SDK import");
}

function migrateProviderFile(file: string, source: string): Result & { output?: string } {
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

	const isDefaultExport = ts.isExportAssignment(call.parent) && call.parent.expression === call;
	if (isDefaultExport) {
		if (/\b(buildProvider|ProviderContext)\b/.test(source))
			return { file, changed: false, reason: "buildProvider or ProviderContext already exists" };
		let output = source.slice(0, call.parent.getStart());
		output += `const buildProvider = defineProvider(${declaration});\n\n`;
		output += "export type ProviderContext = ProviderContextOf<typeof buildProvider>;\n\n";
		output += `export default buildProvider({ ${implementation} });`;
		output += source.slice(call.parent.end);
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

	const replacement = `defineProvider(${declaration})({ ${implementation} })`;
	return {
		file,
		changed: true,
		output: source.slice(0, call.getStart()) + replacement + source.slice(call.end),
	};
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
): Result & { output?: string } {
	const sourceFile = parsed(file, source);
	const calls = callsNamed(sourceFile, operationHelpers).filter(
		(call) => call.arguments.length > 0,
	);
	if (calls.length === 0) return { file, changed: false };
	if (/\bProviderContext\b/.test(source))
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
	const reparsed = parsed(file, output);
	const imports = reparsed.statements.filter(ts.isImportDeclaration);
	const insertion = imports.at(-1)?.end ?? 0;
	const importLine = `\nimport type { ProviderContext } from "${contextImportPath(file, providerFile)}";`;
	output = output.slice(0, insertion) + importLine + output.slice(insertion);
	return { file, changed: true, output };
}

export function migrate(root: string, write: boolean): Result[] {
	const files = sourceFiles(root);
	const originals = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
	const providerResults = files.map((file) => migrateProviderFile(file, originals.get(file) ?? ""));
	const providerCandidates = providerResults.filter((result) => result.changed && result.output);
	const providerDeclines = providerResults.filter((result) => result.reason);
	const results: Result[] = [...providerDeclines];
	if (providerCandidates.length !== 1) {
		const operationFiles = files.filter((file) =>
			callsNamed(parsed(file, originals.get(file) ?? ""), operationHelpers).some(
				(call) => call.arguments.length > 0,
			),
		);
		for (const file of operationFiles)
			results.push({
				file,
				changed: false,
				reason: `cannot select one provider entry (${providerCandidates.length} candidates)`,
			});
	} else {
		const provider = providerCandidates[0];
		const providerFile = provider.file;
		results.push(provider);
		for (const file of files) {
			if (file === providerFile) continue;
			const result = migrateOperationFile(file, originals.get(file) ?? "", providerFile);
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
