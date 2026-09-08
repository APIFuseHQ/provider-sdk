import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	APIFUSE_HANDLE_META_KEY,
	type HandleFieldMeta,
	type HandleKindDeclaration,
	handleFieldDescription,
} from "../handle-meta.js";
import { type LintDiagnostic, lintProvider } from "../lint.js";
import { describeKey } from "../schema.js";

const OPERATION_DESCRIPTION = "operations.waiting.description";

const WAITING_KIND: HandleKindDeclaration = {
	name: "waiting",
	type: "draft",
	fieldName: "waiting_token",
	access: "bound",
	issuedBy: "waiting-prepare",
};

const WAITING_META: HandleFieldMeta = {
	kind: WAITING_KIND.name,
	type: WAITING_KIND.type,
	fieldName: WAITING_KIND.fieldName,
	issuedBy: WAITING_KIND.issuedBy,
};

/** Mirrors what `kind.field()` produces without importing the runtime module. */
function handleField(meta: HandleFieldMeta = WAITING_META) {
	return z
		.string()
		.min(1)
		.describe(handleFieldDescription(meta))
		.meta({ [APIFUSE_HANDLE_META_KEY]: meta });
}

function described<TSchema extends z.ZodType>(schema: TSchema, key: string): TSchema {
	return describeKey(schema, key);
}

type OperationFixture = {
	descriptionKey: string;
	input: z.ZodType;
	output: z.ZodType;
	fixtures: { request: unknown; response: unknown };
	handler?: unknown;
	source?: string;
};

function operation(input: z.ZodRawShape, output: z.ZodRawShape): OperationFixture {
	return {
		descriptionKey: OPERATION_DESCRIPTION,
		input: described(z.object(input), "operations.waiting.input.description"),
		output: described(z.object(output), "operations.waiting.output.description"),
		fixtures: { request: {}, response: {} },
	};
}

type ProviderFixture = {
	id: string;
	allowedHosts: readonly string[];
	reviewed: "first-party";
	state?: true;
	handle?: readonly HandleKindDeclaration[];
	operations: Record<string, OperationFixture>;
	providerSourceFiles?: Record<string, string>;
};

/** Baseline provider that satisfies every handle rule. */
function validProvider(): ProviderFixture {
	return {
		id: "waiting-demo",
		allowedHosts: ["example.com"],
		reviewed: "first-party",
		state: true,
		handle: [WAITING_KIND],
		operations: {
			"waiting-prepare": operation(
				{ shop_id: described(z.string(), "fields.shopId") },
				{ waiting_token: handleField() },
			),
			"waiting-confirm": operation(
				{ waiting_token: handleField() },
				{ confirmed: described(z.boolean(), "fields.confirmed") },
			),
		},
	};
}

function rulesOf(diagnostics: readonly LintDiagnostic[], prefix: string): LintDiagnostic[] {
	return diagnostics.filter((diagnostic) => diagnostic.rule.startsWith(prefix));
}

function byRule(diagnostics: readonly LintDiagnostic[], rule: string): LintDiagnostic[] {
	return diagnostics.filter((diagnostic) => diagnostic.rule === rule);
}

describe("handle lint rules", () => {
	it("is silent for a provider that declares, issues, and accepts its handle kind", () => {
		const diagnostics = lintProvider(validProvider());

		expect(rulesOf(diagnostics, "handle-")).toEqual([]);
		expect(byRule(diagnostics, "legacy-choice-usage")).toEqual([]);
	});

	describe("handle-kind-undeclared", () => {
		it("reports a handle field whose kind is not in provider.handle", () => {
			const provider = validProvider();
			provider.operations["waiting-prepare"] = operation(
				{ shop_id: described(z.string(), "fields.shopId") },
				{
					waiting_token: handleField(),
					page_cursor: handleField({
						kind: "page",
						type: "cursor",
						fieldName: "page_cursor",
						issuedBy: "waiting-prepare",
					}),
				},
			);

			const found = byRule(lintProvider(provider), "handle-kind-undeclared");

			expect(found).toEqual([
				expect.objectContaining({
					level: "error",
					field: "operations.waiting-prepare.output.page_cursor",
					message: expect.stringContaining('kind "page"'),
				}),
			]);
		});

		it("reports every handle field when provider.handle is absent", () => {
			const provider = validProvider();
			delete provider.handle;

			const found = byRule(lintProvider(provider), "handle-kind-undeclared");

			expect(found.map((diagnostic) => diagnostic.field).sort()).toEqual([
				"operations.waiting-confirm.input.waiting_token",
				"operations.waiting-prepare.output.waiting_token",
			]);
		});
	});

	describe("handle-field-name", () => {
		it("reports a handle field declared under a key other than its fieldName", () => {
			const provider = validProvider();
			provider.operations["waiting-confirm"] = operation(
				{ token: handleField() },
				{ confirmed: described(z.boolean(), "fields.confirmed") },
			);

			const diagnostics = lintProvider(provider);

			expect(byRule(diagnostics, "handle-field-name")).toEqual([
				expect.objectContaining({
					level: "error",
					field: "operations.waiting-confirm.input.token",
					message: expect.stringContaining('fieldName is "waiting_token"'),
				}),
			]);
			// The mis-keyed field still counts toward parity; it is a naming error only.
			expect(byRule(diagnostics, "handle-field-parity")).toEqual([]);
		});
	});

	describe("handle-field-parity", () => {
		it("reports a kind that is issued but never accepted by any input", () => {
			const provider = validProvider();
			provider.operations["waiting-confirm"] = operation(
				{ shop_id: described(z.string(), "fields.shopId") },
				{ confirmed: described(z.boolean(), "fields.confirmed") },
			);

			const found = byRule(lintProvider(provider), "handle-field-parity");

			expect(found).toEqual([
				expect.objectContaining({
					level: "error",
					field: "handle.waiting",
					message: expect.stringContaining("never accepted"),
				}),
			]);
			expect(found[0]?.message).toContain("no operation input");
		});

		it("reports a kind that is accepted but never issued by any output", () => {
			const provider = validProvider();
			provider.operations["waiting-prepare"] = operation(
				{ shop_id: described(z.string(), "fields.shopId") },
				{ ok: described(z.boolean(), "fields.ok") },
			);

			const diagnostics = lintProvider(provider);
			const parity = byRule(diagnostics, "handle-field-parity");

			expect(parity).toEqual([
				expect.objectContaining({
					field: "handle.waiting",
					message: expect.stringContaining("never issued"),
				}),
			]);
			expect(parity[0]?.message).toContain("no operation output");
			// issuedBy points at an operation that no longer emits the field.
			expect(byRule(diagnostics, "handle-issued-by")).toHaveLength(1);
		});

		it("reports both sides for a declared kind with no fields anywhere", () => {
			const provider = validProvider();
			provider.handle = [
				WAITING_KIND,
				{ name: "page", type: "cursor", fieldName: "page_cursor", access: "public" },
			];

			const found = byRule(lintProvider(provider), "handle-field-parity");

			expect(found.map((diagnostic) => diagnostic.field)).toEqual(["handle.page", "handle.page"]);
			expect(
				found.map((diagnostic) => /never (issued|accepted)/.exec(diagnostic.message)?.[1]),
			).toEqual(["issued", "accepted"]);
		});
	});

	describe("handle-issued-by", () => {
		it("reports issuedBy that names a missing operation", () => {
			const provider = validProvider();
			provider.handle = [{ ...WAITING_KIND, issuedBy: "waiting-start" }];

			const found = byRule(lintProvider(provider), "handle-issued-by");

			expect(found).toEqual([
				expect.objectContaining({
					level: "error",
					field: "handle.waiting",
					message: expect.stringContaining('"waiting-start", which is not an operation key'),
				}),
			]);
		});

		it("reports issuedBy whose operation output lacks the handle field", () => {
			const provider = validProvider();
			provider.handle = [{ ...WAITING_KIND, issuedBy: "waiting-confirm" }];

			const found = byRule(lintProvider(provider), "handle-issued-by");

			expect(found).toEqual([
				expect.objectContaining({
					field: "handle.waiting",
					message: expect.stringContaining('output has no "waiting_token" handle field'),
				}),
			]);
		});

		it("is silent when issuedBy is omitted", () => {
			const provider = validProvider();
			const { issuedBy: _issuedBy, ...kindWithoutIssuer } = WAITING_KIND;
			provider.handle = [kindWithoutIssuer];

			expect(byRule(lintProvider(provider), "handle-issued-by")).toEqual([]);
		});
	});

	describe("handle-requires-state", () => {
		it("warns when handle kinds are declared without the state capability", () => {
			const provider = validProvider();
			delete provider.state;

			const found = byRule(lintProvider(provider), "handle-requires-state");

			expect(found).toEqual([
				expect.objectContaining({
					level: "warn",
					field: "handle",
					message: expect.stringContaining("state: true"),
				}),
			]);
		});

		it("is silent when no handle kinds are declared even without state", () => {
			const provider: ProviderFixture = {
				id: "plain",
				allowedHosts: ["example.com"],
				reviewed: "first-party",
				handle: [],
				operations: {
					search: operation(
						{ query: described(z.string(), "fields.query") },
						{ items: described(z.array(z.string()), "fields.items") },
					),
				},
			};

			expect(rulesOf(lintProvider(provider), "handle-")).toEqual([]);
		});
	});

	describe("legacy-choice-usage", () => {
		const LEGACY_IDENTIFIERS = [
			"ctx.choice",
			"createProviderChoiceToken",
			"parseProviderChoiceToken",
			"ProviderChoiceTokenError",
			"createTestProviderChoiceContext",
		];

		it.each(LEGACY_IDENTIFIERS)("reports %s in provider source files", (identifier) => {
			const provider = validProvider();
			provider.providerSourceFiles = {
				"src/waiting.ts": `export async function run(ctx) {\n\treturn ${identifier}(ctx);\n}\n`,
			};

			const found = byRule(lintProvider(provider), "legacy-choice-usage");

			expect(found).toEqual([
				{
					rule: "legacy-choice-usage",
					level: "error",
					field: "sourceFiles.src/waiting.ts",
					message: `Legacy choice API "${identifier}" is no longer supported. Choice tokens were replaced by handles (ADR-0012). See docs/migrations/handle.md.`,
				},
			]);
		});

		it("reports ctx.choice in an operation handler source", () => {
			const provider = validProvider();
			provider.operations["waiting-confirm"] = {
				...provider.operations["waiting-confirm"]!,
				source:
					"async (input, ctx) => { const token = await ctx.choice.issue(input); return token; }",
			};

			const found = byRule(lintProvider(provider), "legacy-choice-usage");

			expect(found.map((diagnostic) => diagnostic.field)).toEqual([
				"operations.waiting-confirm.handler",
			]);
		});

		it("does not match identifiers that merely contain the legacy names", () => {
			const provider = validProvider();
			provider.providerSourceFiles = {
				"src/ok.ts":
					"const choices = ctx.choices; const handle = ctx.handle.create('waiting', {}); myParseProviderChoiceTokenShim();",
			};

			expect(byRule(lintProvider(provider), "legacy-choice-usage")).toEqual([]);
		});
	});

	describe("intersection schemas", () => {
		it("finds handle fields inside .and() / z.intersection() branches", () => {
			const provider = validProvider();
			provider.operations["waiting-confirm"] = {
				...operation(
					{ shop_id: described(z.string(), "fields.shopId") },
					{ confirmed: described(z.boolean(), "fields.confirmed") },
				),
				input: described(
					z
						.object({ shop_id: described(z.string(), "fields.shopId") })
						.and(z.object({ waiting_token: handleField() })),
					"operations.waiting.input.description",
				),
			};

			const diagnostics = lintProvider(provider);
			expect(byRule(diagnostics, "handle-field-parity")).toEqual([]);
			expect(byRule(diagnostics, "handle-issued-by")).toEqual([]);
		});
	});

	describe("intersection branches keep the enclosing property key", () => {
		it("accepts `field().and(refinement)` under the right key and flags it under a wrong key", () => {
			const provider = validProvider();
			provider.operations["waiting-confirm"] = operation(
				{ waiting_token: handleField().and(z.string().max(80)) },
				{ confirmed: described(z.boolean(), "fields.confirmed") },
			);
			expect(byRule(lintProvider(provider), "handle-field-name")).toEqual([]);

			provider.operations["waiting-confirm"] = operation(
				{ token: handleField().and(z.string().max(80)) },
				{ confirmed: described(z.boolean(), "fields.confirmed") },
			);
			expect(byRule(lintProvider(provider), "handle-field-name")).toEqual([
				expect.objectContaining({ field: "operations.waiting-confirm.input.token" }),
			]);
		});
	});

	describe("legacy-choice-usage ignores comments and string literals", () => {
		it("scans code after template interpolations and ignores prose inside them", () => {
			const provider = validProvider();
			provider.providerSourceFiles = {
				"a.ts": "const t = `hello ${name}`; ctx.choice.issue({});",
			};
			expect(byRule(lintProvider(provider), "legacy-choice-usage")).toHaveLength(1);

			provider.providerSourceFiles = {
				"b.ts": "const t = `hello ${name} — moved off ctx.choice`; export const ok = 1;",
			};
			expect(byRule(lintProvider(provider), "legacy-choice-usage")).toEqual([]);

			provider.providerSourceFiles = {
				"c.ts": "const t = `x ${ctx.choice.issue({})} y`;",
			};
			expect(byRule(lintProvider(provider), "legacy-choice-usage")).toHaveLength(1);
		});

		it("does not flag migration notes in comments or strings", () => {
			const provider = validProvider();
			provider.providerSourceFiles = {
				"index.ts": [
					"// Migrated from ctx.choice to ctx.handle (ADR-0012)",
					"/* createProviderChoiceToken was removed */",
					'const note = "ctx.choice is gone";',
					"const tpl = `ProviderChoiceTokenError no longer exists`;",
					"export const ok = 1;",
				].join("\n"),
			};

			expect(byRule(lintProvider(provider), "legacy-choice-usage")).toEqual([]);
		});

		it("still flags real usage next to a comment", () => {
			const provider = validProvider();
			provider.providerSourceFiles = {
				"index.ts": "// fine\nconst token = await ctx.choice.issue({});",
			};

			expect(byRule(lintProvider(provider), "legacy-choice-usage")).toHaveLength(1);
		});
	});

	describe("description-key exemption", () => {
		it("does not require describeKey on handle fields or flag their SDK-owned prose", () => {
			const diagnostics = lintProvider(validProvider());

			const descriptionRules = diagnostics.filter(
				(diagnostic) =>
					diagnostic.rule === "schema-description-key-required" ||
					diagnostic.rule === "schema-description-raw-prose",
			);

			expect(descriptionRules).toEqual([]);
		});

		it("looks through optional/nullable wrappers around a handle field", () => {
			const provider = validProvider();
			provider.operations["waiting-confirm"] = operation(
				{ waiting_token: handleField().optional() },
				{ confirmed: described(z.boolean(), "fields.confirmed") },
			);

			const diagnostics = lintProvider(provider);

			expect(
				diagnostics.filter(
					(diagnostic) =>
						diagnostic.field === "operations.waiting-confirm.input.waiting_token" &&
						diagnostic.rule.startsWith("schema-description"),
				),
			).toEqual([]);
			expect(rulesOf(diagnostics, "handle-")).toEqual([]);
		});

		it("still requires describeKey on ordinary sibling fields", () => {
			const provider = validProvider();
			provider.operations["waiting-confirm"] = operation(
				{ waiting_token: handleField(), note: z.string() },
				{ confirmed: described(z.boolean(), "fields.confirmed") },
			);

			const found = byRule(lintProvider(provider), "schema-description-key-required");

			expect(found.map((diagnostic) => diagnostic.field)).toEqual([
				"operations.waiting-confirm.input.note",
			]);
		});
	});

	describe("nested detection", () => {
		it("finds handle fields inside arrays of objects and reports their path", () => {
			const provider = validProvider();
			provider.operations["waiting-prepare"] = operation(
				{ shop_id: described(z.string(), "fields.shopId") },
				{
					offers: described(
						z.array(
							described(
								z.object({
									label: described(z.string(), "fields.label"),
									waiting_token: handleField(),
									page_cursor: handleField({
										kind: "page",
										type: "cursor",
										fieldName: "page_cursor",
									}),
								}),
								"fields.offer",
							),
						),
						"fields.offers",
					),
				},
			);

			const diagnostics = lintProvider(provider);

			// The nested waiting_token satisfies issuance + issuedBy for "waiting".
			expect(byRule(diagnostics, "handle-field-parity")).toEqual([]);
			expect(byRule(diagnostics, "handle-issued-by")).toEqual([]);
			// The nested undeclared kind is reported with the array path.
			expect(byRule(diagnostics, "handle-kind-undeclared")).toEqual([
				expect.objectContaining({
					field: "operations.waiting-prepare.output.offers[].page_cursor",
				}),
			]);
			expect(byRule(diagnostics, "schema-description-key-required")).toEqual([]);
		});

		it("checks the property key of a nested handle field", () => {
			const provider = validProvider();
			provider.operations["waiting-prepare"] = operation(
				{ shop_id: described(z.string(), "fields.shopId") },
				{
					offers: described(
						z.array(described(z.object({ token: handleField() }), "fields.offer")),
						"fields.offers",
					),
				},
			);

			expect(byRule(lintProvider(provider), "handle-field-name")).toEqual([
				expect.objectContaining({
					field: "operations.waiting-prepare.output.offers[].token",
				}),
			]);
		});
	});

	describe("shape keys that collide with structural edge names", () => {
		it("still detects handle fields named like zod internals (item, type, schema)", () => {
			const ITEM_KIND: HandleKindDeclaration = {
				name: "item",
				type: "cursor",
				fieldName: "item",
				access: "bound",
				issuedBy: "waiting-prepare",
			};
			const itemMeta: HandleFieldMeta = {
				kind: "item",
				type: "cursor",
				fieldName: "item",
				issuedBy: "waiting-prepare",
			};
			const provider = validProvider();
			provider.handle = [WAITING_KIND, ITEM_KIND];
			provider.operations["waiting-prepare"] = operation(
				{ shop_id: described(z.string(), "fields.shopId") },
				{ waiting_token: handleField(), item: handleField(itemMeta) },
			);
			provider.operations["waiting-confirm"] = operation(
				{ waiting_token: handleField(), item: handleField(itemMeta) },
				{ confirmed: described(z.boolean(), "fields.confirmed") },
			);

			const diagnostics = lintProvider(provider);

			expect(rulesOf(diagnostics, "handle-")).toEqual([]);
			expect(byRule(diagnostics, "schema-description-key-required")).toEqual([]);
		});

		it("does not treat an object property named `schema` as a wrapper when reading handle meta", () => {
			const provider = validProvider();
			provider.operations["waiting-prepare"] = operation(
				{ shop_id: described(z.string(), "fields.shopId") },
				{
					waiting_token: handleField(),
					schema: described(z.object({ token: handleField() }), "fields.schema"),
				},
			);

			expect(byRule(lintProvider(provider), "handle-field-name")).toEqual([
				expect.objectContaining({ field: "operations.waiting-prepare.output.schema.token" }),
			]);
		});
	});

	describe("reused wrapped schema instances", () => {
		it("checks a reused `field().optional()` instance at every property key", () => {
			const provider = validProvider();
			const shared = handleField().optional();
			provider.operations["waiting-confirm"] = operation(
				{ waiting_token: shared, wrong_name: shared },
				{ confirmed: described(z.boolean(), "fields.confirmed") },
			);

			expect(byRule(lintProvider(provider), "handle-field-name")).toEqual([
				expect.objectContaining({ field: "operations.waiting-confirm.input.wrong_name" }),
			]);
		});
	});
});
