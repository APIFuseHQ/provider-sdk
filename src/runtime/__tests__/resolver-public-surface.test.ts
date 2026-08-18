import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type ExportTarget = string | { readonly types?: string };

describe("resolver public declaration surface", () => {
	it("does not expose the default user-agent test seam from any package subpath", () => {
		const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
			exports?: Record<string, ExportTarget>;
		};
		const leakedExports: string[] = [];

		for (const [subpath, mapping] of Object.entries(packageJson.exports ?? {})) {
			const typesPath = typeof mapping === "string" ? undefined : mapping.types;
			if (!typesPath) continue;
			const declaration = readFileSync(resolve(typesPath), "utf8");
			if (declaration.includes("swapResolverDefaultUserAgentForTests")) {
				leakedExports.push(`${subpath}: swapResolverDefaultUserAgentForTests`);
			}
		}

		expect(leakedExports).toEqual([]);
	});
});
