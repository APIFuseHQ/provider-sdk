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

function localeFixture(locale: "en" | "ko" | "ja"): string {
	return readFileSync(join(FIXTURES, `locale-canonical-${locale}.json`), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectSharedKeyOrder(reference: unknown, value: unknown): void {
	if (Array.isArray(value)) {
		const referenceArray = Array.isArray(reference) ? reference : [];
		for (let index = 0; index < value.length; index += 1) {
			expectSharedKeyOrder(referenceArray[index], value[index]);
		}
		return;
	}
	if (!isRecord(reference) || !isRecord(value)) return;

	const expected = Object.keys(reference).filter((key) => Object.hasOwn(value, key));
	const actual = Object.keys(value).filter((key) => Object.hasOwn(reference, key));
	expect(actual).toEqual(expected);
	for (const key of expected) expectSharedKeyOrder(reference[key], value[key]);
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

	it("preserves a removed raw title as an English locale todo", () => {
		const source = `const companyProfileOperation = defineOperation<ProviderContext>()({
  title: "Get company profile",
  annotations: { readOnly: true },
  input: InputSchema,
  output: OutputSchema,
  handler,
});
`;
		const result = migrateOperationDeclaration(source, "operations/get-company-profile.ts", {
			operationIds: new Map([["companyProfileOperation", "getCompanyProfile"]]),
			localeFiles: ["locales/en.json", "locales/ko.json"],
		});

		expect(result.status).toBe("migrated");
		if (result.status !== "migrated") return;
		expect(result.code).not.toContain('title: "Get company profile"');
		expect(result.localeTodos).toEqual([
			{
				localeFile: "locales/en.json",
				operationKey: "getCompanyProfile",
				key: "operations.getCompanyProfile.title",
				originalProse: "Get company profile",
			},
		]);
	});

	it("uses an explicit titleKey for the preserved English title", () => {
		const result = migrateOperationDeclaration(fixture("hoist-all"), "hoist-all.ts", {
			operationIds: new Map([["searchOperation", "search"]]),
			localeFiles: ["locales/en.json", "locales/ja.json"],
		});

		expect(result.status).toBe("migrated");
		if (result.status !== "migrated") return;
		expect(result.localeTodos).toContainEqual({
			localeFile: "locales/en.json",
			operationKey: "search",
			key: "operations.search.title",
			originalProse: "Raw title",
		});
		expect(result.localeTodos).not.toContainEqual(
			expect.objectContaining({
				localeFile: "locales/ja.json",
				key: "operations.search.title",
			}),
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

	it("resolves a hoisted const array spread inside inputExamples", () => {
		const code = expectMigrated("examples-hoisted-array-spread", "list");
		expect(code).toContain("examples: [...LIST_INPUT_EXAMPLES]");
		expect(code).toContain('scenarioKey: "operations.list.examples.0.scenario"');
		expect(code).toContain('rationaleKey: "operations.list.examples.0.rationale"');
		expect(code).not.toContain("inputExamples:");
	});

	it("resolves mixed literal and hoisted input example elements in runtime order", () => {
		const code = expectMigrated("examples-mixed-array-spread", "mixed");
		expect(code).toContain('scenarioKey: "operations.mixed.examples.0.scenario"');
		expect(code).toContain('scenarioKey: "operations.mixed.examples.1.scenario"');
		expect(code).toContain('scenarioKey: "operations.mixed.examples.2.scenario"');
		expect(code).not.toContain("inputExamples:");
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

	it("still refuses input example array spreads from imported symbols", () => {
		expectRefusal("examples-imported-array-spread", "non_literal");
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
	it("writes a removed raw title to the English catalog without replacing translations", () => {
		const root = mkdtempSync(join(tmpdir(), "apifuse-operation-title-locale-"));
		try {
			writeFileSync(
				join(root, "index.ts"),
				`const companyProfileOperation = defineOperation<ProviderContext>()({
  title: "Get company profile",
  annotations: { readOnly: true },
  input: InputSchema,
  output: OutputSchema,
  handler,
});
export default buildProvider({
  operations: { getCompanyProfile: companyProfileOperation },
});
`,
			);
			mkdirSync(join(root, "locales"));
			writeFileSync(
				join(root, "locales", "en.json"),
				'{"operations":{"getCompanyProfile":{"description":"Company profile"}}}\n',
			);
			writeFileSync(
				join(root, "locales", "ko.json"),
				'{"operations":{"getCompanyProfile":{"description":"기업 개황","title":"기업 개황 조회"}}}\n',
			);

			const result = migrateOperationDeclarationRepository(root);

			expect(result.status).toBe("migrated");
			const english = JSON.parse(readFileSync(join(root, "locales", "en.json"), "utf8")) as {
				operations: { getCompanyProfile: { title: string } };
			};
			const korean = JSON.parse(readFileSync(join(root, "locales", "ko.json"), "utf8")) as {
				operations: { getCompanyProfile: { title: string } };
			};
			expect(english.operations.getCompanyProfile.title).toBe("Get company profile");
			expect(korean.operations.getCompanyProfile.title).toBe("기업 개황 조회");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes canonical locale JSON with non-English shared keys in English order", () => {
		const root = mkdtempSync(join(tmpdir(), "apifuse-operation-locale-canonical-"));
		try {
			writeFileSync(join(root, "search.ts"), fixture("examples-operation"));
			writeFileSync(join(root, "operations.ts"), fixture("examples-map"));
			mkdirSync(join(root, "locales"));
			for (const locale of ["en", "ko", "ja"] as const) {
				writeFileSync(join(root, "locales", `${locale}.json`), localeFixture(locale));
			}

			const result = migrateOperationDeclarationRepository(root);
			expect(result.status).toBe("migrated");

			const catalogs = new Map<string, unknown>();
			for (const locale of ["en", "ko", "ja"] as const) {
				const raw = readFileSync(join(root, "locales", `${locale}.json`), "utf8");
				const parsed: unknown = JSON.parse(raw);
				expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
				catalogs.set(locale, parsed);
			}

			const english = catalogs.get("en");
			const korean = catalogs.get("ko");
			const japanese = catalogs.get("ja");
			expectSharedKeyOrder(english, korean);
			expectSharedKeyOrder(english, japanese);
			if (!isRecord(korean) || !isRecord(japanese)) throw new Error("expected locale objects");
			expect(Object.keys(korean).slice(-2)).toEqual(["koOnlyFirst", "koOnlyLast"]);
			expect(Object.keys(japanese).slice(-2)).toEqual(["jaOnlyFirst", "jaOnlyLast"]);
			const koOperations = korean.operations;
			const jaOperations = japanese.operations;
			if (!isRecord(koOperations) || !isRecord(jaOperations)) {
				throw new Error("expected operations objects");
			}
			expect(Object.keys(koOperations).at(-1)).toBe("koOnlyOperation");
			expect(Object.keys(jaOperations).at(-1)).toBe("jaOnlyOperation");
			const koSearch = koOperations.search;
			const jaSearch = jaOperations.search;
			if (!isRecord(koSearch) || !isRecord(jaSearch)) throw new Error("expected search objects");
			expect(Object.keys(koSearch)).toEqual([
				"description",
				"title",
				"steps",
				"examples",
				"koOnly",
			]);
			expect(Object.keys(jaSearch)).toEqual([
				"description",
				"title",
				"steps",
				"examples",
				"jaOnly",
			]);
			expect(Array.isArray(koSearch.steps)).toBe(true);
			expect(Array.isArray(jaSearch.steps)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function migrateRegistryFixture(name: string, other?: string) {
		const root = mkdtempSync(join(tmpdir(), "apifuse-operation-registry-"));
		if (other === undefined) {
			writeFileSync(join(root, "index.ts"), fixture(name));
		} else {
			writeFileSync(join(root, "index.ts"), fixture(name));
			writeFileSync(join(root, "other.ts"), fixture(other));
		}
		mkdirSync(join(root, "locales"));
		writeFileSync(join(root, "locales", "en.json"), "{}\n");
		const result = migrateOperationDeclarationRepository(root, { check: true });
		rmSync(root, { recursive: true, force: true });
		return result;
	}

	it("indexes typed exported registries with hyphenated string keys", () => {
		const result = migrateRegistryFixture("registry-typed");
		expect(result.status).toBe("would-migrate");
		if (result.status === "would-migrate") expect(result.operationCount).toBe(1);
	});

	it("indexes shorthand registry properties for direct stream helpers", () => {
		const result = migrateRegistryFixture("registry-shorthand");
		expect(result.status).toBe("would-migrate");
		if (result.status === "would-migrate") expect(result.operationCount).toBe(1);
	});

	it("refuses a binding registered under two ids", () => {
		const result = migrateRegistryFixture("registry-binding-ambiguous");
		expect(result.status).toBe("refused");
		if (result.status === "refused") {
			expect(result.refusals[0]?.reason).toBe("operation_id_unresolved");
		}
	});

	it("refuses two bindings registered under one id", () => {
		const result = migrateRegistryFixture("registry-key-ambiguous");
		expect(result.status).toBe("refused");
		if (result.status === "refused") {
			expect(result.refusals).toHaveLength(2);
			expect(result.refusals.every((item) => item.reason === "operation_id_unresolved")).toBe(true);
		}
	});

	it("scans operation members in unrelated const objects only", () => {
		const result = migrateRegistryFixture("registry-unrelated");
		expect(result.status).toBe("would-migrate");
		if (result.status === "would-migrate") expect(result.operationCount).toBe(1);
	});

	it("ignores imported identifiers in same-file objects", () => {
		const result = migrateRegistryFixture("registry-imported", "registry-imported-other");
		expect(result.status).toBe("refused");
		if (result.status === "refused") {
			expect(result.refusals[0]?.reason).toBe("operation_id_unresolved");
		}
	});

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
					'  operations: z.array(z.enum(["a", "b"])).min(1).superRefine(() => {}),',
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
	it("skips nested repositories identified by a .git file", () => {
		const root = mkdtempSync(join(tmpdir(), "apifuse-operation-nested-worktree-"));
		try {
			const main = fixture("inline-map");
			const nested = fixture("safety-conflict");
			writeFileSync(join(root, "index.ts"), main);
			const nestedRoot = join(root, ".worktree", "stale");
			mkdirSync(nestedRoot, { recursive: true });
			writeFileSync(join(nestedRoot, ".git"), "gitdir: /tmp/stale\n");
			writeFileSync(join(nestedRoot, "operation.ts"), nested);

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
			expect(command.exitCode).toBe(0);
			const stdout = command.stdout.toString();
			const payload = JSON.parse(stdout) as {
				status: string;
				changedFiles: string[];
				operationCount: number;
			};
			expect(payload.status).toBe("migrated");
			expect(payload.changedFiles).toEqual(["index.ts"]);
			expect(payload.operationCount).toBe(1);
			expect(stdout).not.toContain(".worktree");
			expect(readFileSync(join(root, "index.ts"), "utf8")).toContain('riskClass: "read"');
			expect(readFileSync(join(nestedRoot, "operation.ts"), "utf8")).toBe(nested);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

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
