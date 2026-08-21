import { glob } from "node:fs/promises";

const forbidden = [
	/\bas\s+unknown\s+as\b/u,
	/\bas\s+any\b/u,
	/\bas\s+Error\b/u,
	/\bas\s+T\s*;/u,
];

const justified = [
	/\bReflect\.apply\s*\(/u,
	/\bas\s+never\b/u,
	/\b(?:new\s+)?Function\s*\(/u,
];

const angleAssertion = /<\s*(any|Error|never|unknown)\s*>/gu;
const assertionOperandStart = /(?:[\p{ID_Start}$_0-9'"`({!~+/-]|\[)/u;
const assertionContextBlocker = /[\p{ID_Continue}$)\].]/u;
const justificationMarker = "test-invalid:";

type MaskerState =
	| "code"
	| "line-comment"
	| "block-comment"
	| "single"
	| "double"
	| "template";

interface MaskedLine {
	code: string;
	commentText: string;
	commentOnly: boolean;
}

function maskSource(source: string): MaskedLine[] {
	const input = source.replaceAll("\r", "");
	const masked: string[] = [];
	const commentText: string[][] = [[]];
	let state: MaskerState = "code";
	let line = 0;
	const interpolationDepths: number[] = [];

	const appendMasked = (character: string): void => {
		masked.push(character === "\n" ? "\n" : " ");
	};
	const advanceLine = (): void => {
		line += 1;
		commentText.push([]);
	};

	for (let index = 0; index < input.length; index += 1) {
		const character = input[index] ?? "";
		const nextCharacter = input[index + 1];

		if (state === "line-comment") {
			if (character === "\n") {
				masked.push("\n");
				advanceLine();
				state = "code";
			} else {
				appendMasked(character);
				commentText[line]?.push(character);
			}
			continue;
		}

		if (state === "block-comment") {
			if (character === "*" && nextCharacter === "/") {
				masked.push(" ", " ");
				index += 1;
				state = "code";
			} else if (character === "\n") {
				masked.push("\n");
				advanceLine();
			} else {
				appendMasked(character);
				commentText[line]?.push(character);
			}
			continue;
		}

		if (state === "single" || state === "double") {
			const delimiter = state === "single" ? "'" : '"';
			if (character === "\\") {
				appendMasked(character);
				if (nextCharacter !== undefined) {
					index += 1;
					if (nextCharacter === "\n") {
						masked.push("\n");
						advanceLine();
					} else {
						appendMasked(nextCharacter);
					}
				}
			} else if (character === delimiter) {
				masked.push(character);
				state = "code";
			} else if (character === "\n") {
				masked.push("\n");
				advanceLine();
			} else {
				appendMasked(character);
			}
			continue;
		}

		if (state === "template") {
			if (character === "\\") {
				appendMasked(character);
				if (nextCharacter !== undefined) {
					index += 1;
					if (nextCharacter === "\n") {
						masked.push("\n");
						advanceLine();
					} else {
						appendMasked(nextCharacter);
					}
				}
			} else if (character === "`") {
				masked.push(character);
				state = "code";
			} else if (character === "$" && nextCharacter === "{") {
				masked.push("$", "{");
				index += 1;
				interpolationDepths.push(1);
				state = "code";
			} else if (character === "\n") {
				masked.push("\n");
				advanceLine();
			} else {
				appendMasked(character);
			}
			continue;
		}

		if (character === "/" && nextCharacter === "/") {
			masked.push(" ", " ");
			index += 1;
			state = "line-comment";
			continue;
		}
		if (character === "/" && nextCharacter === "*") {
			masked.push(" ", " ");
			index += 1;
			state = "block-comment";
			continue;
		}
		if (character === "'") {
			masked.push(character);
			state = "single";
			continue;
		}
		if (character === '"') {
			masked.push(character);
			state = "double";
			continue;
		}
		if (character === "`") {
			masked.push(character);
			state = "template";
			continue;
		}

		if (interpolationDepths.length > 0) {
			const depthIndex = interpolationDepths.length - 1;
			if (character === "{") {
				interpolationDepths[depthIndex] =
					(interpolationDepths[depthIndex] ?? 0) + 1;
			} else if (character === "}") {
				const depth = (interpolationDepths[depthIndex] ?? 0) - 1;
				if (depth === 0) {
					interpolationDepths.pop();
					state = "template";
				} else {
					interpolationDepths[depthIndex] = depth;
				}
			}
		}

		masked.push(character);
		if (character === "\n") advanceLine();
	}

	const maskedLines = masked.join("").split("\n");
	return maskedLines.map((code, index) => ({
		code,
		commentText: commentText[index]?.join("") ?? "",
		commentOnly: code.trim() === "",
	}));
}

function hasAngleAssertionLookbehind(line: string, start: number): boolean {
	let before = start - 1;
	while (before >= 0 && /\s/u.test(line[before] ?? "")) before -= 1;
	return before < 0 || !assertionContextBlocker.test(line[before] ?? "");
}

function isAngleAssertionContext(line: string, start: number, end: number): boolean {
	if (!hasAngleAssertionLookbehind(line, start)) return false;

	let after = end;
	while (after < line.length && /\s/u.test(line[after] ?? "")) after += 1;
	return assertionOperandStart.test(line[after] ?? "");
}

function hasTopLevelAs(line: string, start: number): boolean {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;

	for (let index = start; index < line.length; index += 1) {
		const character = line[index] ?? "";
		if (character === "(") parentheses += 1;
		else if (character === ")") parentheses = Math.max(0, parentheses - 1);
		else if (character === "[") brackets += 1;
		else if (character === "]") brackets = Math.max(0, brackets - 1);
		else if (character === "{") braces += 1;
		else if (character === "}") braces = Math.max(0, braces - 1);

		if (parentheses !== 0 || brackets !== 0 || braces !== 0) continue;
		if (character === ";" || character === ",") return false;
		if (
			character === "a" &&
			line[index + 1] === "s" &&
			/\s/u.test(line[index - 1] ?? "") &&
			/\s/u.test(line[index + 2] ?? "")
		) {
			return true;
		}
	}

	return false;
}

function precedingAngleAssertionStart(line: string, start: number): number | undefined {
	let index = start - 1;
	while (index >= 0 && /\s/u.test(line[index] ?? "")) index -= 1;
	if (line[index] !== ">") return undefined;

	let depth = 0;
	for (; index >= 0; index -= 1) {
		const character = line[index];
		if (character === ">") depth += 1;
		else if (character === "<") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}

	return undefined;
}

function angleViolations(line: string): Array<"hard" | "justified"> {
	const violations: Array<"hard" | "justified"> = [];
	for (const match of line.matchAll(angleAssertion)) {
		const start = match.index;
		const end = start + match[0].length;
		if (!isAngleAssertionContext(line, start, end)) continue;

		const type = match[1];
		if (type === "any" || type === "Error") violations.push("hard");
		else if (type === "never") violations.push("justified");
		else {
			const prefixStart = precedingAngleAssertionStart(line, start);
			if (
				hasTopLevelAs(line, end) ||
				(prefixStart !== undefined && hasAngleAssertionLookbehind(line, prefixStart))
			) {
				violations.push("hard");
			}
		}
	}
	return violations;
}

export interface TestTypesafetyViolation {
	line: number;
	message: string;
}

function hasPrecedingCommentJustification(lines: readonly MaskedLine[], index: number): boolean {
	// Walk back through the annotation block: consecutive comment-only lines
	// immediately above the escape. A multi-line block comment carrying the
	// marker on any of its lines blesses the line that follows it.
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const previous = lines[cursor];
		if (!previous?.commentOnly) return false;
		if (previous.commentText.includes(justificationMarker)) return true;
	}
	return false;
}

export function scanTestTypesafety(source: string | readonly string[]): TestTypesafetyViolation[] {
	const lines = maskSource(typeof source === "string" ? source : source.join("\n"));
	const violations: TestTypesafetyViolation[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? { code: "", commentText: "", commentOnly: true };
		const hasSameLineJustification = line.commentText.includes(justificationMarker);
		if (line.commentText.includes("@ts-expect-error") && !hasSameLineJustification) {
			violations.push({
				line: index + 1,
				message: "@ts-expect-error requires a test-invalid justification",
			});
		}
		for (const pattern of forbidden) {
			if (pattern.test(line.code)) {
				violations.push({
					line: index + 1,
					message: `forbidden unchecked escape ${pattern}`,
				});
			}
		}

		const hasJustification = hasSameLineJustification || hasPrecedingCommentJustification(lines, index);
		for (const violation of angleViolations(line.code)) {
			if (violation === "hard" || !hasJustification) {
				violations.push({
					line: index + 1,
					message:
						violation === "hard"
							? "forbidden unchecked angle assertion"
							: "unchecked angle assertion requires a test-invalid justification",
				});
			}
		}
		if (!hasJustification) {
			for (const pattern of justified) {
				if (pattern.test(line.code)) {
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
		for (const violation of scanTestTypesafety(await Bun.file(file).text())) {
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
