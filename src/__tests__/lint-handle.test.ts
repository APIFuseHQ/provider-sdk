import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";

import { defineCursor, defineDraft } from "../handle.js";
import {
	APIFUSE_HANDLE_META_KEY,
	type HandleFieldMeta,
	handleFieldDescription,
} from "../handle-meta.js";
import { type LintDiagnostic, lintProvider } from "../lint.js";
import { describeKey } from "../schema.js";

const OPERATION_DESCRIPTION = "operations.waiting.description";

const WAITING_META: HandleFieldMeta = {
	kind: "waiting",
	type: "draft",
	fieldName: "waiting_token",
	issuedBy: "waiting-prepare",
};

/** Mirrors what `kind.field()` produces without importing the runtime module. */
function handleField(meta: HandleFieldMeta = WAITING_META) {
	return z
		.string()
		.min(1)
		.meta({ description: handleFieldDescription(meta), [APIFUSE_HANDLE_META_KEY]: meta });
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
	handle?: readonly unknown[];
	operations: Record<string, OperationFixture>;
	providerSourceFiles?: Record<string, string>;
};

const WaitingDraft = defineDraft({
	name: "waiting",
	schema: z.object({ shop: z.string() }),
	ttl: { idle: "30m", max: "2h" },
});

/** Baseline provider on the current (declare-once) path. */
function validProvider(): ProviderFixture {
	return {
		id: "waiting-demo",
		allowedHosts: ["example.com"],
		reviewed: "first-party",
		state: true,
		handle: [WaitingDraft],
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
	it("is silent for a provider that declares its kinds and places their fields", () => {
		const diagnostics = lintProvider(validProvider());

		expect(rulesOf(diagnostics, "handle-")).toEqual([]);
		expect(byRule(diagnostics, "legacy-handle-declaration")).toEqual([]);
	});

	describe("legacy-handle-declaration", () => {
		let warn: ReturnType<typeof spyOn>;
		beforeEach(() => {
			warn = spyOn(console, "warn").mockImplementation(() => {});
		});
		afterEach(() => {
			warn.mockRestore();
		});

		it("warns once per kind that still declares fieldName or issuedBy and points at the codemod", () => {
			const provider = validProvider();
			provider.handle = [
				WaitingDraft,
				defineCursor({
					name: "page",
					fieldName: "page_cursor",
					schema: z.object({}),
					ttl: "10m",
					issuedBy: "waiting-prepare",
				}),
				defineCursor({ name: "loc", schema: z.object({}), ttl: "10m", issuedBy: "search" }),
			];

			const found = byRule(lintProvider(provider), "legacy-handle-declaration");

			expect(found).toEqual([
				expect.objectContaining({
					level: "warn",
					field: "handle.page",
					message: expect.stringContaining('kind "page" still declares fieldName and issuedBy'),
				}),
				expect.objectContaining({
					level: "warn",
					field: "handle.loc",
					message: expect.stringContaining('kind "loc" still declares issuedBy'),
				}),
			]);
			expect(found[0]?.message).toContain("scripts/codemods/handles.yml");
		});

		it("is silent for kinds defined without the deprecated options and for a missing or empty list", () => {
			expect(byRule(lintProvider(validProvider()), "legacy-handle-declaration")).toEqual([]);

			const provider = validProvider();
			provider.handle = [];
			expect(byRule(lintProvider(provider), "legacy-handle-declaration")).toEqual([]);

			delete provider.handle;
			expect(byRule(lintProvider(provider), "legacy-handle-declaration")).toEqual([]);
		});

		it("ignores plain declaration objects that carry no SDK internals", () => {
			const provider = validProvider();
			provider.handle = [
				{
					name: "waiting",
					type: "draft",
					fieldName: "waiting_token",
					access: "bound",
					issuedBy: "waiting-prepare",
				},
			];

			expect(byRule(lintProvider(provider), "legacy-handle-declaration")).toEqual([]);
		});
	});
});
