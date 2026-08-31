import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	migrateOperationDeclaration,
	migrateOperationDeclarationRepository,
	type OperationDeclarationRefusalReason,
	verifyOperationDeclarationRewrite,
} from "../migrate-operation-declaration.js";

const FIXTURES = join(import.meta.dir, "fixtures", "migrate-operation-declaration");

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, `${name}.ts.txt`), "utf8");
}

function migrate(name: string, operationId?: string) {
	const binding = name === "stream" ? "downloadOperation" : `${operationId ?? name}Operation`;
	return migrateOperationDeclaration(fixture(name), `${name}.ts`, {
		operationIds: operationId === undefined ? undefined : new Map([[binding, operationId]]),
		localeFiles: ["locales/en.json"],
	});
}

function expectMigrated(name: string, operationId?: string): string {
	const result = migrate(name, operationId);
	if (result.status !== "migrated") {
		throw new Error(
			`expected ${name} to migrate, got ${result.status}: ${
				result.status === "refused" ? JSON.stringify(result.refusals) : "unchanged"
			}`,
		);
	}
	return result.code;
}

function expectRefusal(name: string, reason: OperationDeclarationRefusalReason): void {
	const input = fixture(name);
	const result = migrateOperationDeclaration(input, `${name}.ts`, {
		localeFiles: ["locales/en.json"],
	});
	expect(result.status).toBe("refused");
	if (result.status !== "refused") return;
	expect(result.refusals[0]?.reason).toBe(reason);
	expect(result.refusals[0]?.file).toBe(`${name}.ts`);
	expect(result.refusals[0]?.operationKey).toBeTruthy();
	// A refusal never returns or writes a partial source.
	expect(input).toBe(fixture(name));
}

describe("migrateOperationDeclaration transforms", () => {
	it("hoists every legacy container class and deletes dead fields including cast tails", () => {
		const code = expectMigrated("hoist-all", "search");
		expect(code).toContain('riskClass: "read"');
		expect(code).toContain("timeoutMs: 30_000");
		expect(code).toContain('connectionMode: "none"');
		expect(code).toContain('connectionExternalRefParam: "accountId"');
		expect(code).toContain('titleKey: "operations.search.title"');
		expect(code).toContain("normalizationNotesKeys:");
		expect(code).toContain("errorCodes:");
		expect(code).not.toMatch(
			/annotations|toolRouter|docs:|requestExample|responseExample|derivations|retryOnAuthRefresh|Raw title|Raw description/,
		);
	});

	it("resolves a module-level const referenced by shorthand", () => {
		const code = expectMigrated("hoisted-const", "detail");
		expect(code).toContain('riskClass: "read"');
		expect(code).toContain("timeoutMs: 15_000");
		expect(code).not.toContain("\tannotations,");
	});

	it("resolves module-level const spreads inside toolRouter", () => {
		const code = expectMigrated("tool-router-spread", "update");
		expect(code).toContain('riskClass: "destructive"');
		expect(code).toContain('connectionMode: "required"');
		expect(code).toContain('connectionExternalRefParam: "profileId"');
		// destructive defaults to always, so this restatement is deleted.
		expect(code).not.toContain("approval:");
	});

	it("resolves the inline object spread used by ekitan toolRouter declarations", () => {
		const code = expectMigrated("inline-spread-ekitan", "getStationInfo");
		expect(code).toContain('riskClass: "read"');
		expect(code).toContain('connectionMode: "none" as const');
		expect(code).not.toContain("requiresConnection");
		expect(code).not.toContain("approval:");
	});

	it("unwraps chained casts on inline spreads and their members", () => {
		const code = expectMigrated("inline-spread-cast-tail", "castTail");
		expect(code).toContain('riskClass: "write" as const');
		expect(code).toContain('approval: "always" as ApprovalMode');
		expect(code).toContain('connectionMode: "none" as ConnectionMode');
		expect(code).toContain("timeoutMs: 15_000 as Milliseconds");
		expect(code).toContain('titleKey: "operations.castTail.title" as const');
		expect(code).toContain('descriptionKey: "operations.castTail.description" as LocaleKey');
	});

	it("lets a member after an inline spread override the spread member", () => {
		const code = expectMigrated("inline-spread-override", "override");
		expect(code).toContain('connectionMode: "none" as const');
		expect(code).toContain('approval: "always" as const');
		expect(code).not.toContain('connectionMode: "required"');
		expect(code).not.toContain('approval: "never"');
	});

	it("lets connectionMode win over requiresConnection", () => {
		const code = expectMigrated("connection-precedence", "connect");
		expect(code).toContain('connectionMode: "optional"');
		expect(code).not.toContain('connectionMode: "required"');
		expect(code).not.toContain("requiresConnection");
	});

	it("drops a redundant approval restatement", () => {
		const code = expectMigrated("redundant-approval", "search");
		expect(code).toContain('riskClass: "read"');
		expect(code).not.toContain("approval:");
	});

	it("keeps a non-default approval override", () => {
		const code = expectMigrated("approval-override", "reserve");
		expect(code).toContain('riskClass: "write"');
		expect(code).toContain('approval: "always"');
	});

	it("migrates a raw object in an inline operations map", () => {
		const code = expectMigrated("inline-map");
		expect(code).toContain('riskClass: "read"');
		expect(code).toContain('descriptionKey: "operations.ping.description"');
		expect(code).not.toContain("annotations:");
		expect(code).not.toContain("docs:");
	});

	it("migrates defineStreamOperation declarations", () => {
		const code = expectMigrated("stream", "download");
		expect(code).toContain('riskClass: "read"');
		expect(code).toContain('connectionMode: "optional"');
	});

	it("preserves a multi-line Japanese template literal byte-for-byte", () => {
		const input = fixture("verbatim-template");
		const template = input.slice(
			input.indexOf("`最初"),
			input.indexOf("`;", input.indexOf("`最初")) + 1,
		);
		const code = expectMigrated("verbatim-template", "explain");
		expect(code).toContain(template);
	});

	it("is idempotent on its own output", () => {
		const code = expectMigrated("hoist-all", "search");
		const result = migrateOperationDeclaration(code, "hoist-all.ts", {
			operationIds: new Map([["searchOperation", "search"]]),
			localeFiles: ["locales/en.json"],
		});
		expect(result.status).toBe("unchanged");
		if (result.status === "unchanged") expect(result.code).toBe(code);
	});
});

describe("migrateOperationDeclaration refusals", () => {
	it("refuses the hand-authored safety conflict class", () => {
		expectRefusal("safety-conflict", "safety_conflict");
	});

	it("refuses the no-safety class instead of inventing write", () => {
		expectRefusal("no-safety", "no_safety");
	});

	it("refuses top-level versus docs locale-key conflicts", () => {
		expectRefusal("docs-conflict", "locale_key_conflict");
	});

	it("refuses non-literal safety values", () => {
		expectRefusal("non-literal", "non_literal");
	});

	it("still refuses spreads of imported identifiers", () => {
		expectRefusal("imported-spread", "non_literal");
	});

	it("refuses factory-composed operation maps", () => {
		expectRefusal("factory-map", "factory_composed_operations");
	});

	it("refuses unparseable source", () => {
		expectRefusal("unparseable", "source_syntax");
	});

	it("classifies an immediate post-rewrite parse failure as codemod_syntax", () => {
		const result = verifyOperationDeclarationRewrite(
			fixture("codemod-syntax"),
			"codemod-syntax.ts",
		);
		expect(result).toEqual(
			expect.objectContaining({
				file: "codemod-syntax.ts",
				operationKey: "<file>",
				reason: "codemod_syntax",
			}),
		);
	});

	it("refuses example migration without locales/en.json", () => {
		const input = fixture("missing-english-locale");
		const result = migrateOperationDeclaration(input, "operations/search.ts", {
			operationIds: new Map([["searchOperation", "search"]]),
			localeFiles: [],
		});
		expect(result.status).toBe("refused");
		if (result.status === "refused") {
			expect(result.refusals[0]?.reason).toBe("missing_english_locale");
			expect(result.refusals[0]?.operationKey).toBe("search");
		}
	});
});

describe("migrateOperationDeclarationRepository", () => {
	it("resolves an imported operation id and emits the examples locale sidecar", () => {
		const root = mkdtempSync(join(tmpdir(), "apifuse-operation-declaration-"));
		try {
			writeFileSync(join(root, "search.ts"), fixture("examples-operation"));
			writeFileSync(join(root, "operations.ts"), fixture("examples-map"));
			mkdirSync(join(root, "locales"));
			writeFileSync(join(root, "locales", "en.json"), "{}\n");
			writeFileSync(join(root, "locales", "ja.json"), "{}\n");

			const result = migrateOperationDeclarationRepository(root);
			expect(result.status).toBe("migrated");
			if (result.status === "refused") return;
			expect(result.sidecar).toBe("migrate-operation-declaration.locales-todo.json");
			const migrated = readFileSync(join(root, "search.ts"), "utf8");
			expect(migrated).toContain('scenarioKey: "operations.search.examples.0.scenario"');
			expect(migrated).toContain('rationaleKey: "operations.search.examples.0.rationale"');
			expect(migrated).toContain("query: `京都\n  ホテル`");
			const sidecar = JSON.parse(readFileSync(join(root, result.sidecar ?? ""), "utf8")) as {
				localeFiles: Record<string, Record<string, string>>;
			};
			expect(
				sidecar.localeFiles["locales/en.json"]?.["operations.search.examples.0.scenario"],
			).toBe("Search by a precise phrase");
			expect(
				sidecar.localeFiles["locales/ja.json"]?.["operations.search.examples.0.rationale"],
			).toBe("Shows whitespace preservation");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("check mode reports changes without writing source or sidecar", () => {
		const root = mkdtempSync(join(tmpdir(), "apifuse-operation-check-"));
		try {
			const input = fixture("inline-map");
			writeFileSync(join(root, "index.ts"), input);
			const result = migrateOperationDeclarationRepository(root, { check: true });
			expect(result.status).toBe("would-migrate");
			expect(readFileSync(join(root, "index.ts"), "utf8")).toBe(input);
			expect(existsSync(join(root, "migrate-operation-declaration.locales-todo.json"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps every file untouched when any file refuses", () => {
		const root = mkdtempSync(join(tmpdir(), "apifuse-operation-atomic-"));
		try {
			const migratable = fixture("inline-map");
			const refused = fixture("no-safety");
			writeFileSync(join(root, "index.ts"), migratable);
			writeFileSync(join(root, "unknown.ts"), refused);
			const result = migrateOperationDeclarationRepository(root);
			expect(result.status).toBe("refused");
			expect(readFileSync(join(root, "index.ts"), "utf8")).toBe(migratable);
			expect(readFileSync(join(root, "unknown.ts"), "utf8")).toBe(refused);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores a bare `operations:` key outside a provider declaration", () => {
		// Regression: ekitan's scripts/fixture-integrity.ts declares a zod
		// schema field named `operations` whose initializer is a call chain
		// (z.array(...).superRefine(...)). The map collector used to treat any
		// `operations:` property as a provider declaration site and refused it
		// as factory_composed_operations.
		const root = mkdtempSync(join(tmpdir(), "apifuse-operation-schema-key-"));
		try {
			const migratable = fixture("inline-map");
			writeFileSync(join(root, "index.ts"), migratable);
			mkdirSync(join(root, "scripts"), { recursive: true });
			writeFileSync(
				join(root, "scripts", "fixture-schema.ts"),
				[
					'import { z } from "@apifuse/provider-sdk/provider";',
					"",
					"export const manifestSchema = z.object({",
					"  operations: z.array(z.enum([\"a\", \"b\"])).min(1).superRefine(() => {}),",
					"  captured_operations: z.array(z.string().min(1)).min(1),",
					"});",
					"",
				].join("\n"),
			);
			const result = migrateOperationDeclarationRepository(root, {
				check: true,
			});
			expect(result.status).toBe("would-migrate");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("apifuse migrate-operation-declaration CLI", () => {
	it("emits machine-readable refusals and exits 2", () => {
		const root = mkdtempSync(join(tmpdir(), "apifuse-operation-cli-"));
		try {
			writeFileSync(join(root, "unknown.ts"), fixture("no-safety"));
			const command = Bun.spawnSync({
				cmd: [
					process.execPath,
					join(import.meta.dir, "../../../bin/apifuse.ts"),
					"migrate-operation-declaration",
					root,
					"--json",
				],
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(command.exitCode).toBe(2);
			const payload = JSON.parse(command.stdout.toString()) as {
				status: string;
				refusals: Array<{ file: string; operationKey: string; reason: string }>;
			};
			expect(payload.status).toBe("refused");
			expect(payload.refusals).toEqual([
				expect.objectContaining({
					file: "unknown.ts",
					operationKey: "unknownOperation",
					reason: "no_safety",
				}),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
