import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

type ExportTarget = string | ExportConditions;

interface ExportConditions {
	readonly [condition: string]: ExportTarget;
}

// ./testing is the designated test-only entry point. Keep this allowance exact so no
// other test/internal seam can escape through it or any other package subpath.
const ALLOWED_TEST_ONLY_EXPORTS = new Set(["./testing: resetProviderCacheForTests"]);

function resolveExportCondition(
	target: ExportTarget,
	condition: "types" | "import",
): string | undefined {
	if (typeof target === "string") return target;
	const conditionalTarget = target[condition] ?? target.default;
	return conditionalTarget ? resolveExportCondition(conditionalTarget, condition) : undefined;
}

describe("package public surface", () => {
	it("exposes test or internal seams only through exact designated allowances", async () => {
		const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
			exports?: Record<string, ExportTarget>;
		};
		const exportMappings = Object.entries(packageJson.exports ?? {});
		const declarationEntries = exportMappings.flatMap(([subpath, mapping]) => {
			const target = resolveExportCondition(mapping, "types");
			return target?.endsWith(".d.ts") ? [{ subpath, path: resolve(target) }] : [];
		});
		const program = ts.createProgram(
			declarationEntries.map(({ path }) => path),
			{
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				skipLibCheck: true,
				target: ts.ScriptTarget.ESNext,
			},
		);
		const checker = program.getTypeChecker();
		const inspectedSubpaths = new Set<string>();
		const leakedExports = new Set<string>();
		const seamName = /ForTests|Internal/;

		for (const { subpath, path } of declarationEntries) {
			inspectedSubpaths.add(subpath);
			const sourceFile = program.getSourceFile(path);
			const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
			if (!moduleSymbol) continue;
			for (const exportedSymbol of checker.getExportsOfModule(moduleSymbol)) {
				const exportedSeam = `${subpath}: ${exportedSymbol.name}`;
				if (seamName.test(exportedSymbol.name) && !ALLOWED_TEST_ONLY_EXPORTS.has(exportedSeam)) {
					leakedExports.add(exportedSeam);
				}
			}
		}

		for (const [subpath, mapping] of exportMappings) {
			const target = resolveExportCondition(mapping, "import");
			if (!target) continue;
			inspectedSubpaths.add(subpath);
			const targetUrl = pathToFileURL(resolve(target)).href;
			const module = target.endsWith(".json")
				? await import(targetUrl, { with: { type: "json" } })
				: await import(targetUrl);
			for (const exportName of Object.keys(module)) {
				const exportedSeam = `${subpath}: ${exportName}`;
				if (seamName.test(exportName) && !ALLOWED_TEST_ONLY_EXPORTS.has(exportedSeam)) {
					leakedExports.add(exportedSeam);
				}
			}
		}

		expect([...inspectedSubpaths].sort()).toEqual(
			exportMappings.map(([subpath]) => subpath).sort(),
		);
		expect([...leakedExports].sort()).toEqual([]);
	}, 15_000);

	it("exports the provider-cache reset from the built testing entry point", async () => {
		const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
			exports?: Record<string, ExportTarget>;
		};
		const testingMapping = packageJson.exports?.["./testing"];
		const target = testingMapping && resolveExportCondition(testingMapping, "import");
		expect(target).toBeDefined();
		if (!target) throw new Error("Missing ./testing import target");

		const testing = await import(pathToFileURL(resolve(target)).href);
		expect(testing.resetProviderCacheForTests).toBeFunction();
		expect(() => testing.resetProviderCacheForTests()).not.toThrow();
	});
});
