import { glob } from "node:fs/promises";

const forbidden = [/\bas unknown as\b/u, /\bas any\b/u, /\bas Error\b/u, /\bas T;/u];

const justified = [/\bReflect\.apply\s*\(/u, /\bas\s+never\b/u, /\b(?:new\s+)?Function\s*\(/u];

export interface TestTypesafetyViolation {
	line: number;
	message: string;
}

export function scanTestTypesafety(lines: readonly string[]): TestTypesafetyViolation[] {
	const violations: TestTypesafetyViolation[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.includes("@ts-expect-error") && !line.includes("test-invalid:")) {
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
			line.includes("test-invalid:") || (lines[index - 1] ?? "").includes("test-invalid:");
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
