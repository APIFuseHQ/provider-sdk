import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
	compileDiagnosticSensitiveValues,
	createDiagnosticRedactor,
} from "../runtime/diagnostic-redactor.js";

const PRE_LEVER_COMMIT = "19d3f674eb912318d9bc0462f867077e5c721892";
const fixtureRoot = join(import.meta.dir, "fixtures/redaction-pre-lever");
const repositoryRoot = resolve(import.meta.dir, "../..");
const sources = [
	["src/runtime/diagnostic-redactor.ts", "556d7bc3117e8f854b435407def2c54172fad076"],
	["src/runtime/request-options.ts", "e66b8f8d187be26341a495b5086b0c5f4a12a4ee"],
	["src/errors.ts", "c388efb7630eaa0e7d773355159726f18568f2a6"],
] as const;

const vectorSchema = z.object({
	initial: z.array(z.string().min(8)),
	staticValues: z.array(z.string().min(8)),
	additions: z.array(z.string().min(8)),
	text: z.string(),
	expected: z.string(),
});

// Compare the unchanged policy domain: long credentials, at most two encoding
// rounds, and no literal %HH inside credentials. Later short-value/decode-bound
// fixes intentionally differ from 19d3f67 and have their own exact policy pins.
// The fixture uses the performance probe's seed/alphabet and 2000 fixed values;
// see its README for the deterministic domain mapping and source provenance.
it("matches the pre-lever redactor exactly over 2000 fixed vectors", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "apifuse-redactor-pre-lever-"));
	try {
		const hasHistory =
			spawnSync("git", ["cat-file", "-e", PRE_LEVER_COMMIT], {
				cwd: repositoryRoot,
				stdio: "ignore",
			}).status === 0;
		for (const [path, blob] of sources) {
			const fixture = readFileSync(join(fixtureRoot, `${path.split("/").at(-1)}.txt`));
			expect(
				createHash("sha1").update(`blob ${fixture.length}\0`).update(fixture).digest("hex"),
			).toBe(blob);
			let source = fixture;
			if (hasHistory) {
				const historical = spawnSync("git", ["show", `${PRE_LEVER_COMMIT}:${path}`], {
					cwd: repositoryRoot,
				});
				expect(historical.status).toBe(0);
				expect(historical.stdout.equals(fixture)).toBe(true);
				source = historical.stdout;
			}
			// The byte-identical, Git-blob-pinned snapshot also works after squashing
			// or in a shallow/offline checkout where the historical object is absent.
			const destination = join(scratch, path);
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, source);
		}
		const before: {
			compileDiagnosticSensitiveValues: typeof compileDiagnosticSensitiveValues;
			createDiagnosticRedactor: (
				values: readonly string[],
				staticValues: ReturnType<typeof compileDiagnosticSensitiveValues>,
			) => Pick<ReturnType<typeof createDiagnosticRedactor>, "redact" | "add">;
		} = await import(pathToFileURL(join(scratch, "src/runtime/diagnostic-redactor.ts")).href);
		const vectorSource = readFileSync(join(fixtureRoot, "vectors.jsonl"), "utf8");
		expect(createHash("sha256").update(vectorSource).digest("hex")).toBe(
			"0a03e35735e2f3a156571c9de24190eea37156d9a196b36c41471b70f625f19b",
		);
		const vectors = vectorSource.trimEnd().split("\n");
		expect(vectors).toHaveLength(2000);
		for (const [index, line] of vectors.entries()) {
			const vector = vectorSchema.parse(JSON.parse(line));
			const historical = before.createDiagnosticRedactor(
				vector.initial,
				before.compileDiagnosticSensitiveValues(vector.staticValues),
			);
			const current = createDiagnosticRedactor(
				vector.initial,
				compileDiagnosticSensitiveValues(vector.staticValues),
			);
			// Prime caches before additions, then require lazy compilation and cache
			// invalidation to preserve both cold and repeated diagnostic outputs.
			expect(current.redact(vector.text), `vector ${index}: before add`).toBe(
				historical.redact(vector.text),
			);
			historical.add(vector.additions);
			current.add(vector.additions);
			for (let repeat = 0; repeat < 2; repeat++) {
				expect(historical.redact(vector.text), `vector ${index}: historical`).toBe(vector.expected);
				expect(current.redact(vector.text), `vector ${index}: current`).toBe(vector.expected);
			}
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
