import { expect, it } from "bun:test";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reuse review-round-2 cache.test.ts's private inspection without a production export.
it("keeps raw request text out of process-static caches after scope release", async () => {
	const source = (
		await readFile(new URL("../diagnostic-redactor.ts", import.meta.url), "utf8")
	).replace(
		'"./request-options.js"',
		JSON.stringify(new URL("../request-options.ts", import.meta.url).href),
	);
	const directory = await mkdtemp(join(tmpdir(), "p4-cache-"));
	const path = join(directory, "probe.ts");
	await writeFile(path, `${source}\nexport const reviewCaches = compiledValues;`);
	try {
		const module = await import(path);
		const handle = module.compileDiagnosticSensitiveValues(["staticgroves"]);
		let registry = module.createDiagnosticRedactor(["orchardgrove"], handle);
		expect(registry.redact("vendor orchardgrove")).toBe("vendor [REDACTED]");
		registry = undefined;
		Bun.gc(true);
		const compiled = module.reviewCaches.get(handle);
		for (const matcher of [
			compiled.primary,
			compiled.check,
			compiled.criticalPrimary,
			compiled.criticalCheck,
		]) {
			expect([...matcher.cache]).toEqual([]);
		}
		expect(module.createDiagnosticRedactor([], handle).redact("orchardgrove")).toBe("orchardgrove");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
