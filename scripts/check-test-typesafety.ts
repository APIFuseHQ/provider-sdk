import { glob } from "node:fs/promises";

const forbidden = [
	/\bas(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/)+unknown(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/)+as\b/u,
	/\bas(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/)+any\b/u,
	/\bas(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/)+Error\b/u,
	/\bas(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/)+T\s*;/u,
	/(?<![\p{ID_Continue}$])<\s*any\s*>(?=\s*(?:[\p{ID_Start}$_0-9"'`({[]|[-!~+/]))/u,
	/(?<![\p{ID_Continue}$])<\s*Error\s*>(?=\s*(?:[\p{ID_Start}$_0-9"'`({[]|[-!~+/]))/u,
	/(?<![\p{ID_Continue}$])<\s*[\p{ID_Start}$_][\p{ID_Continue}.$]*(?:\s*\[\s*\])*\s*>\s*<\s*unknown\s*>(?=\s*(?:[\p{ID_Start}$_0-9"'`({[]|[-!~+/]))/u,
	/(?<![\p{ID_Continue}$])<\s*unknown\s*>\s*[\p{ID_Start}$_][\p{ID_Continue}$]*(?:\s*(?:\.\s*[\p{ID_Start}$_][\p{ID_Continue}$]*|\([^,;]*\)))*(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/)+as(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/)+(?=[\p{ID_Start}$_])/u,
];

const justified = [
	/\bReflect\.apply\s*\(/u,
	/\bas(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/)+never\b/u,
	/(?<![\p{ID_Continue}$])<\s*never\s*>(?=\s*(?:[\p{ID_Start}$_0-9"'`({[]|[-!~+/]))/u,
	/\b(?:new\s+)?Function\s*\(/u,
];

const justificationMarker = "test-invalid:";

function commentHasJustification(line: string): boolean {
	let quote: '"' | "'" | "`" | undefined;

	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		if (quote !== undefined) {
			if (character === "\\") {
				index += 1;
			} else if (character === quote) {
				quote = undefined;
			}
			continue;
		}

		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character !== "/") continue;

		const nextCharacter = line[index + 1];
		if (nextCharacter === "/") {
			return line.slice(index + 2).includes(justificationMarker);
		}
		if (nextCharacter !== "*") continue;

		const commentEnd = line.indexOf("*/", index + 2);
		const contentEnd = commentEnd === -1 ? line.length : commentEnd;
		if (line.slice(index + 2, contentEnd).includes(justificationMarker)) return true;
		if (commentEnd === -1) return false;
		index = commentEnd + 1;
	}

	return false;
}

function standaloneCommentHasJustification(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.startsWith("//")) return trimmed.includes(justificationMarker);
	if (!trimmed.startsWith("/*") || !trimmed.endsWith("*/")) return false;
	return (
		trimmed.indexOf("*/", 2) === trimmed.length - 2 &&
		trimmed.slice(2, -2).includes(justificationMarker)
	);
}

export interface TestTypesafetyViolation {
	line: number;
	message: string;
}

export function scanTestTypesafety(lines: readonly string[]): TestTypesafetyViolation[] {
	const violations: TestTypesafetyViolation[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const hasSameLineJustification = commentHasJustification(line);
		if (line.includes("@ts-expect-error") && !hasSameLineJustification) {
			violations.push({
				line: index + 1,
				message: "@ts-expect-error requires a test-invalid justification",
			});
		}
		for (const pattern of forbidden) {
			if (pattern.test(line)) {
				violations.push({
					line: index + 1,
					message: `forbidden unchecked escape ${pattern}`,
				});
			}
		}
		const hasJustification =
			hasSameLineJustification || standaloneCommentHasJustification(lines[index - 1] ?? "");
		if (!hasJustification) {
			for (const pattern of justified) {
				if (pattern.test(line)) {
					violations.push({
						line: index + 1,
						message: `unchecked test escape ${pattern} requires a test-invalid justification`,
					});
				}
			}
		}
	}

	return violations;
}

async function main(): Promise<void> {
	const files = [
		...(await Array.fromAsync(glob("src/**/*.test.ts"))),
		...(await Array.fromAsync(glob("src/**/*.spec.ts"))),
		...(await Array.fromAsync(glob("src/*.test.ts"))),
	];
	const uniqueFiles = [...new Set(files)];
	const violations: string[] = [];

	for (const file of uniqueFiles) {
		const lines = (await Bun.file(file).text()).split("\n");
		for (const violation of scanTestTypesafety(lines)) {
			violations.push(`${file}:${violation.line}: ${violation.message}`);
		}
	}

	if (violations.length > 0) {
		console.error("test-typesafety: unchecked test escape(s) found");
		for (const violation of violations) console.error(violation);
		process.exit(1);
	}

	console.log(
		`test-typesafety: checked ${uniqueFiles.length} test files; no unchecked escapes found`,
	);
}

if (import.meta.main) await main();
