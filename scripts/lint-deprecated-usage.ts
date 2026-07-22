#!/usr/bin/env bun
/**
 * General-purpose `@deprecated` usage gate.
 *
 * Fails CI when code references a symbol whose declaration carries a JSDoc
 * `@deprecated` tag. This turns deprecation from an editor-only hint into an
 * accident gate: legacy surfaces stay compilable for backwards compatibility,
 * but any *new* use of them breaks the build. The proxy singular `provider`
 * field is its first target; tagging any other symbol `@deprecated` enrolls it
 * automatically.
 *
 * Legitimate internal references (backcompat adapters that must still read the
 * deprecated field) are declared in `deprecated-usage.allow.json`.
 *
 * Usage: bun run scripts/lint-deprecated-usage.ts [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const TSCONFIG = path.join(ROOT, "tsconfig.json");
const ALLOWLIST_PATH = path.join(ROOT, "deprecated-usage.allow.json");
const asJson = process.argv.includes("--json");

type AllowEntry = { file: string; symbol: string; reason: string };

type Violation = {
	file: string;
	line: number;
	column: number;
	symbol: string;
	message: string;
};

function loadAllowlist(): AllowEntry[] {
	if (!existsSync(ALLOWLIST_PATH)) return [];
	try {
		const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as { allow?: AllowEntry[] };
		return parsed.allow ?? [];
	} catch (error) {
		throw new Error(`Failed to parse ${ALLOWLIST_PATH}: ${String(error)}`);
	}
}

function createProgram(): ts.Program {
	const configFile = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
	if (configFile.error) {
		throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
	}
	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT);
	return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

/** A declaration carries @deprecated if any of its JSDoc tags is `deprecated`. */
function deprecationMessage(declaration: ts.Declaration): string | undefined {
	const tags = ts.getJSDocTags(declaration);
	for (const tag of tags) {
		if (tag.tagName.text === "deprecated") {
			const comment =
				typeof tag.comment === "string"
					? tag.comment
					: (tag.comment ?? []).map((part) => part.text).join("");
			return comment.trim() || "(no replacement note)";
		}
	}
	return undefined;
}

/** True when `node` is the declared name of one of the symbol's declarations. */
function isDeclarationName(node: ts.Node, declarations: readonly ts.Declaration[]): boolean {
	return declarations.some((declaration) => ts.getNameOfDeclaration(declaration) === node);
}

function relativePath(fileName: string): string {
	return path.relative(ROOT, fileName);
}

function isProjectSource(fileName: string): boolean {
	if (fileName.includes("node_modules")) return false;
	if (fileName.includes(`${path.sep}dist${path.sep}`)) return false;
	if (fileName.includes(`${path.sep}.worktree${path.sep}`)) return false;
	return fileName.endsWith(".ts");
}

function main(): void {
	const allowlist = loadAllowlist();
	const program = createProgram();
	const checker = program.getTypeChecker();
	const violations: Violation[] = [];

	const isAllowed = (file: string, symbol: string): boolean =>
		allowlist.some((entry) => entry.file === file && entry.symbol === symbol);

	for (const sourceFile of program.getSourceFiles()) {
		if (!isProjectSource(sourceFile.fileName)) continue;
		const relFile = relativePath(sourceFile.fileName);

		const visit = (node: ts.Node): void => {
			if (ts.isIdentifier(node)) {
				const symbol = checker.getSymbolAtLocation(node);
				const declarations = symbol?.declarations;
				if (symbol && declarations?.length && !isDeclarationName(node, declarations)) {
					// Only enforce first-party deprecations — third-party library
					// @deprecated tags (zod, playwright, …) are their own concern.
					const deprecated = declarations
						.filter((declaration) => !declaration.getSourceFile().fileName.includes("node_modules"))
						.map((declaration) => deprecationMessage(declaration))
						.find((message) => message !== undefined);
					if (deprecated !== undefined && !isAllowed(relFile, symbol.name)) {
						const { line, character } = sourceFile.getLineAndCharacterOfPosition(
							node.getStart(sourceFile),
						);
						violations.push({
							file: relFile,
							line: line + 1,
							column: character + 1,
							symbol: symbol.name,
							message: deprecated,
						});
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}

	if (asJson) {
		console.log(JSON.stringify({ violations }, null, 2));
	} else if (violations.length === 0) {
		console.log("lint:deprecated — no deprecated-symbol usages found.");
	} else {
		console.error(`lint:deprecated — ${violations.length} deprecated-symbol usage(s):\n`);
		for (const violation of violations) {
			console.error(
				`  ${violation.file}:${violation.line}:${violation.column} — ${violation.symbol} — ${violation.message}`,
			);
		}
		console.error(
			`\nMigrate off the deprecated API, or add an entry to deprecated-usage.allow.json with a reason if the use is a required backcompat shim.`,
		);
	}

	process.exit(violations.length > 0 ? 1 : 0);
}

main();
