import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

type ExportTarget = string | Readonly<Record<string, ExportTarget>>;

function resolveExportCondition(
	target: ExportTarget,
	condition: "types" | "import",
): string | undefined {
	if (typeof target === "string") return target;
	const conditionalTarget = target[condition] ?? target.default;
	return conditionalTarget
		? resolveExportCondition(conditionalTarget, condition)
		: undefined;
}

describe("package public surface", () => {
	it("does not expose test or internal seams from any package subpath", async () => {
		const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
			exports?: Record<string, ExportTarget>;
		};
		const exportMappings = Object.entries(packageJson.exports ?? {});
		const declarationEntries = exportMappings.flatMap(([subpath, mapping]) => {
			const target = resolveExportCondition(mapping, "types");
			return target?.endsWith(".d.ts")
				? [{ subpath, path: resolve(target) }]
				: [];
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
				if (seamName.test(exportedSymbol.name)) {
					leakedExports.add(`${subpath}: ${exportedSymbol.name}`);
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
				if (seamName.test(exportName)) {
					leakedExports.add(`${subpath}: ${exportName}`);
				}
			}
		}

		expect([...inspectedSubpaths].sort()).toEqual(
			exportMappings.map(([subpath]) => subpath).sort(),
		);
		expect([...leakedExports].sort()).toEqual([]);
	});
});
