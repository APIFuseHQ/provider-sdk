import { glob } from "node:fs/promises";

const forbidden = [
	/\bas unknown as\b/u,
	/\bas any\b/u,
	/\bas Error\b/u,
	/\bas T;/u,
];
const files = [...(await Array.fromAsync(glob("src/**/*.test.ts"))), ...(await Array.fromAsync(glob("src/**/*.spec.ts"))), ...(await Array.fromAsync(glob("src/*.test.ts")))];
const violations: string[] = [];

for (const file of [...new Set(files)]) {
	const lines = (await Bun.file(file).text()).split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.includes("@ts-expect-error") && !line.includes("test-invalid:")) {
			violations.push(`${file}:${index + 1}: @ts-expect-error requires a test-invalid justification`);
		}
		for (const pattern of forbidden) {
			if (pattern.test(line)) violations.push(`${file}:${index + 1}: forbidden unchecked escape ${pattern}`);
		}
	}
}

if (violations.length > 0) {
	console.error("test-typesafety: unchecked test escape(s) found");
	for (const violation of violations) console.error(violation);
	process.exit(1);
}

console.log(`test-typesafety: checked ${new Set(files).size} test files; no unchecked escapes found`);
