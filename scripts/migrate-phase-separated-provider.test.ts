import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrate } from "./migrate-phase-separated-provider.js";

const temporaryDirectories: string[] = [];

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "provider-codemod-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("phase-separated provider codemod", () => {
	it("converts an entry point and context-binds a separate operation", () => {
		const root = workspace();
		writeFileSync(
			join(root, "index.ts"),
			`import { defineProvider } from "@apifuse/provider-sdk/provider";
import { ping } from "./ping";
export default defineProvider({
  id: "fixture", version: "1.0.0", runtime: "standard",
  meta: { displayName: "Fixture", descriptionKey: "fixture", category: "test" },
  operations: { ping },
});
`,
		);
		writeFileSync(
			join(root, "ping.ts"),
			`import { defineOperation, z } from "@apifuse/provider-sdk/provider";
export const ping = defineOperation({
  input: z.object({}), output: z.object({ ok: z.boolean() }),
  async handler(ctx) { void ctx.trace; return { ok: true }; },
  healthCheckUnsupported: { reason: "fixture" },
});
`,
		);

		const results = migrate(root, true);

		expect(results.filter((result) => result.changed)).toHaveLength(2);
		expect(results.filter((result) => result.reason)).toHaveLength(0);
		expect(readFileSync(join(root, "index.ts"), "utf8")).toContain(
			"export type ProviderContext = ProviderContextOf<typeof buildProvider>",
		);
		const operation = readFileSync(join(root, "ping.ts"), "utf8");
		expect(operation).toContain('import type { ProviderContext } from "./index";');
		expect(operation).toContain("defineOperation<ProviderContext>()({");
	});

	it("leaves an entire operation file untouched when one call is unsupported", () => {
		const root = workspace();
		writeFileSync(
			join(root, "index.ts"),
			`import { defineProvider } from "@apifuse/provider-sdk/provider";
import { operations } from "./operations";
export default defineProvider({
  id: "fixture", version: "1.0.0", runtime: "standard",
  meta: { displayName: "Fixture", descriptionKey: "fixture", category: "test" },
  operations,
});
`,
		);
		const operationPath = join(root, "operations.ts");
		const original = `import { defineOperation } from "@apifuse/provider-sdk/provider";
const good = defineOperation({});
const unknown = defineOperation(makeOperation());
export const operations = { good, unknown };
`;
		writeFileSync(operationPath, original);

		const results = migrate(root, true);

		expect(results.find((result) => result.file === operationPath)?.reason).toContain(
			"unsupported call shape",
		);
		expect(readFileSync(operationPath, "utf8")).toBe(original);
	});
});
