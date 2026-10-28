import { describe, expect, it, spyOn } from "bun:test";

import { lintProvider } from "../lint.js";
import { lintRuntimeBoundarySources, RUNTIME_BOUNDARY_RULES } from "../runtime-boundary-lint.js";

// Assembled at runtime so the SDK's own env-reference scanner does not take
// the fixture's reads for the SDK's; the expectations below read `process.env`.
const PROCESS_ENV = ["process", "env"].join(".");

describe("lintRuntimeBoundarySources (deprecated shim)", () => {
	it("maps bundleProvider findings to the old field, rule and message shape", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = lintRuntimeBoundarySources(
				{
					"index.ts": `import { token } from "./upstream/x";\nimport { boot } from "./upstream/boot";\nexport default { token, boot };\n`,
					"upstream/x.ts": [
						`export const token = ${PROCESS_ENV}.FOO;`,
						`export const other = ${PROCESS_ENV}.BAR;`,
						'export const page = fetch("https://example.com");',
						'export const ws = new WebSocket("wss://example.com");',
					].join("\n"),
					"upstream/boot.ts": `import { readFile } from "node:fs/promises";\nexport const boot = Bun.spawn(["ls"]);\nexport { readFile };\n`,
					"start.ts": `const port = ${PROCESS_ENV}.NOT_BOOTSTRAP;\nexport {};\n`,
					"scripts/record.ts": `import { writeFile } from "node:fs/promises";\nexport { writeFile };\n`,
					"__tests__/a.test.ts": `export const raw = ${PROCESS_ENV}.FIXTURE_TOKEN;\n`,
				},
				{ typescript: undefined },
			);

			expect(result.information).toEqual([]);
			expect(
				result.diagnostics.map((diagnostic) => [
					diagnostic.field,
					diagnostic.rule,
					diagnostic.level,
					diagnostic.message.split(": ")[0],
				]),
			).toEqual([
				["sourceFiles.upstream/boot.ts", "node-runtime-module-import", "error", "node:fs/promises (line 1), Bun.spawn (line 2)"],
				["sourceFiles.upstream/x.ts", "process-env-direct-read", "error", `${PROCESS_ENV}.FOO (line 1), ${PROCESS_ENV}.BAR (line 2)`],
				["sourceFiles.upstream/x.ts", "direct-fetch-call", "error", "fetch (line 3), WebSocket (line 4)"],
			]);
			expect(
				result.diagnostics.every((diagnostic) => RUNTIME_BOUNDARY_RULES.some((rule) => rule === diagnostic.rule)),
			).toBe(true);
			expect(result.diagnostics[1]?.message).toContain("ctx.env.get(name)");
		} finally {
			warn.mockRestore();
		}
	});

	it("roots the graph at every supplied in-scope file, so a file nothing imports is still judged", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = lintRuntimeBoundarySources({
				"upstream/x.ts": `export const token = ${PROCESS_ENV}.FOO;`,
				"upstream/fs.ts": `import { readFile } from "node:fs/promises";`,
				"upstream/serving.ts": `export function forwarding(options: { env?: Record<string, string | undefined> }) {\n  return options.env ?? ${PROCESS_ENV};\n}`,
				"start.ts": `export const port = ${PROCESS_ENV}.NOT_BOOTSTRAP;`,
				"scripts/record.ts": `import { writeFile } from "node:fs/promises";\nexport { writeFile };`,
				"bin/x.ts": 'await fetch("https://example.com");',
				"__tests__/a.test.ts": `export const raw = ${PROCESS_ENV}.FIXTURE_TOKEN;`,
				"types.d.ts": `declare const token: typeof ${PROCESS_ENV}.TOKEN;`,
			});

			expect(result.diagnostics.map((diagnostic) => [diagnostic.field, diagnostic.rule, diagnostic.message.split(": ")[0]])).toEqual([
				["sourceFiles.upstream/fs.ts", "node-runtime-module-import", "node:fs/promises (line 1)"],
				["sourceFiles.upstream/serving.ts", "process-env-direct-read", `${PROCESS_ENV} (line 2)`],
				["sourceFiles.upstream/x.ts", "process-env-direct-read", `${PROCESS_ENV}.FOO (line 1)`],
			]);
		} finally {
			warn.mockRestore();
		}
	});

	it("loads a relative import the file set lacks as an empty module instead of failing the build", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = lintRuntimeBoundarySources({
				"index.ts": [
					'import fixture from "./__fixtures__/generated/fare.json";',
					'import { fare } from "./data.json";',
					'import pkg from "./package.json";',
					'import blob from "./assets/x.asset";',
					'import { helper } from "./not-supplied";',
					`export const all = [fixture, fare, pkg.version, blob, helper, ${PROCESS_ENV}.FOO];`,
				].join("\n"),
			});

			expect(result.diagnostics.map((diagnostic) => [diagnostic.field, diagnostic.rule, diagnostic.message.split(": ")[0]])).toEqual([
				["sourceFiles.index.ts", "process-env-direct-read", `${PROCESS_ENV}.FOO (line 6)`],
			]);
		} finally {
			warn.mockRestore();
		}
	});

	it("moves an acknowledged finding to information, as the retired rules did", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = lintRuntimeBoundarySources({
				"upstream/x.ts": [
					"// @apifuse-allow process-env-direct-read: bootstrap mirror, removed in #1",
					`export const token = ${PROCESS_ENV}.FOO;`,
					`export const other = ${PROCESS_ENV}.BAR; // @apifuse-allow direct-fetch-call: wrong rule`,
				].join("\n"),
			});

			expect(result.information).toEqual([
				{
					rule: "process-env-direct-read",
					field: "sourceFiles.upstream/x.ts",
					message: `Acknowledged ${PROCESS_ENV}.FOO at line 2. Reason: bootstrap mirror, removed in #1`,
				},
			]);
			expect(result.diagnostics.map((diagnostic) => diagnostic.message.split(": ")[0])).toEqual([`${PROCESS_ENV}.BAR (line 3)`]);
		} finally {
			warn.mockRestore();
		}
	});

	it("judges nothing without an in-scope file and refuses paths outside the provider root", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(lintRuntimeBoundarySources({ "scripts/record.ts": `export const token = ${PROCESS_ENV}.FOO;` })).toEqual({
				diagnostics: [],
				information: [],
			});
			expect(lintRuntimeBoundarySources({})).toEqual({ diagnostics: [], information: [] });
			expect(() => lintRuntimeBoundarySources({ "index.ts": "export {};", "../escape.ts": "export {};" })).toThrow(
				"not a provider-root-relative file path",
			);
			expect(() => lintRuntimeBoundarySources({ "index.ts": "export {};", "/etc/escape.ts": "export {};" })).toThrow(
				"not a provider-root-relative file path",
			);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("lintProvider options (deprecated)", () => {
	it("accepts and ignores the options argument with one warning", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const provider = { id: "demo", allowedHosts: ["api.example.com"], reviewed: "2026-01-01" };
			const withOptions = lintProvider(provider, { mode: "standalone" });
			const withOptionsAgain = lintProvider(provider, { mode: "official" });
			expect(withOptions).toEqual(lintProvider(provider));
			expect(withOptionsAgain).toEqual(withOptions);
			const deprecationWarnings = warn.mock.calls.filter((call) => String(call[0]).includes("lintProvider(provider, options) is deprecated"));
			expect(deprecationWarnings).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
});
