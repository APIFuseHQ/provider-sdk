import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "..", "..");
const ALLOWED_DIRECTORIES = ["bin/", "src/cli/"];
const STATIC_TYPESCRIPT_IMPORT = /\bfrom\s+["']typescript["']/;

describe("typescript dependency boundary", () => {
	it("keeps static typescript imports out of production runtime sources", () => {
		const sourceFiles = [
			...collectProductionTypeScriptFiles(join(REPOSITORY_ROOT, "bin")),
			...collectProductionTypeScriptFiles(join(REPOSITORY_ROOT, "src")),
		];
		const violations = sourceFiles
			.map((path) => relative(REPOSITORY_ROOT, path).split("\\").join("/"))
			.filter((path) => !ALLOWED_DIRECTORIES.some((directory) => path.startsWith(directory)))
			.filter((path) =>
				STATIC_TYPESCRIPT_IMPORT.test(readFileSync(join(REPOSITORY_ROOT, path), "utf8")),
			);

		expect(violations).toEqual([]);
	});
});

function collectProductionTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
			continue;
		}
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") continue;
			files.push(...collectProductionTypeScriptFiles(path));
			continue;
		}
		if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts")) {
			files.push(path);
		}
	}
	return files;
}
