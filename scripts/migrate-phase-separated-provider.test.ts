import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
			`import { defineProvider, } from "@apifuse/provider-sdk/provider";
import { ping } from "./ping";
const provider = defineProvider({
  id: "fixture", version: "1.0.0", runtime: "standard",
  meta: { displayName: "Fixture", descriptionKey: "fixture", category: "test" },
  operations: { ping },
});
export default provider;
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
		const entry = readFileSync(join(root, "index.ts"), "utf8");
		expect(entry).toContain(
			"export type ProviderContext = ProviderContextOf<typeof buildProvider>",
		);
		expect(entry).not.toContain(",,");
		const operation = readFileSync(join(root, "ping.ts"), "utf8");
		expect(operation).toContain('import type { ProviderContext } from "./index";');
		expect(operation).toContain("defineOperation<ProviderContext>()({");
	});

	it("uses the root package export when the shipped entry is not index.ts", () => {
		const root = workspace();
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "__tests__"));
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ exports: { ".": "./src/provider.ts" }, main: "./index.ts" }),
		);
		writeFileSync(
			join(root, "src", "provider.ts"),
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
			join(root, "src", "ping.ts"),
			`import { defineOperation } from "@apifuse/provider-sdk/provider";
export const ping = defineOperation({});
`,
		);
		const legacyIndex = `import { defineProvider } from "@apifuse/provider-sdk/provider";
export default defineProvider({ operations: {} });
`;
		writeFileSync(join(root, "index.ts"), legacyIndex);
		const testSource = `import { defineProvider } from "@apifuse/provider-sdk/provider";
defineProvider(makeFixture());
`;
		writeFileSync(join(root, "__tests__", "auth.test.ts"), testSource);

		const results = migrate(root, true);

		expect(results.filter((result) => result.reason)).toHaveLength(0);
		expect(readFileSync(join(root, "src", "provider.ts"), "utf8")).toContain(
			"export type ProviderContext = ProviderContextOf<typeof buildProvider>",
		);
		expect(readFileSync(join(root, "src", "ping.ts"), "utf8")).toContain(
			'import type { ProviderContext } from "./provider";',
		);
		expect(readFileSync(join(root, "index.ts"), "utf8")).toBe(legacyIndex);
		expect(readFileSync(join(root, "__tests__", "auth.test.ts"), "utf8")).toBe(testSource);
	});

	it("ignores nested plural worktree directories", () => {
		const root = workspace();
		mkdirSync(join(root, ".worktrees", "backfill"), { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ main: "./index.ts" }));
		const provider = `import { defineProvider } from "@apifuse/provider-sdk/provider";
export default defineProvider({ operations: {} });
`;
		writeFileSync(join(root, "index.ts"), provider);
		writeFileSync(join(root, ".worktrees", "backfill", "index.ts"), provider);

		const results = migrate(root, true);

		expect(results.filter((result) => result.changed)).toHaveLength(1);
		expect(results.filter((result) => result.reason)).toHaveLength(0);
		expect(readFileSync(join(root, ".worktrees", "backfill", "index.ts"), "utf8")).toBe(provider);
	});

	it("replaces SDK context imports while preserving sibling types", () => {
		const root = workspace();
		writeFileSync(join(root, "package.json"), JSON.stringify({ main: "./index.ts" }));
		writeFileSync(
			join(root, "index.ts"),
			`import type { HealthCheckSuite, ProviderContext } from "@apifuse/provider-sdk";
import {
  defineProvider,
  type z,
} from "@apifuse/provider-sdk/provider";
function headers(ctx: ProviderContext) { return ctx.request?.headers; }
void headers;
export default defineProvider({ operations: {} });
`,
		);
		writeFileSync(
			join(root, "operation.ts"),
			`import {
  defineOperation,
  type ProviderContext,
  type ProviderStateNamespace,
} from "@apifuse/provider-sdk/provider";
function namespace(ctx: ProviderContext): ProviderStateNamespace { return ctx.state.namespace("x", {}); }
export const operation = defineOperation({ handler: namespace });
`,
		);

		const results = migrate(root, true);

		expect(results.filter((result) => result.reason)).toHaveLength(0);
		const entry = readFileSync(join(root, "index.ts"), "utf8");
		expect(entry).toContain('import type { HealthCheckSuite } from "@apifuse/provider-sdk";');
		expect(entry).not.toContain("HealthCheckSuite, ProviderContext");
		expect(entry).toContain("  type ProviderContextOf,\n}");
		expect(entry).not.toContain(",,");
		const operation = readFileSync(join(root, "operation.ts"), "utf8");
		expect(operation).toContain("type ProviderStateNamespace,");
		expect(operation).not.toContain("type ProviderContext,");
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
		const original = `import type { ProviderContext } from "@apifuse/provider-sdk";
import { defineOperation } from "@apifuse/provider-sdk/provider";
const good = defineOperation({});
const unknown = defineOperation(makeOperation());
declare const context: ProviderContext;
void context;
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
