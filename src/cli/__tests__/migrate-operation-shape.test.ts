import { describe, expect, it } from "bun:test";

import { migrateOperationShape } from "../migrate-operation-shape.js";

const LEGACY_OPERATION_MODULE = `import { defineOperation } from "@apifuse/provider-sdk/provider";

import { searchHandler } from "../mappers/search";
import { SearchInputSchema, SearchOutputSchema } from "../schemas/search";

export const searchOperation = defineOperation({
	descriptionKey: "operations.search.description",
	input: SearchInputSchema,
	output: SearchOutputSchema,
	handler: searchHandler,
	healthCheck: { interval: "10m", timeoutMs: 20_000, cases: [] },
});
`;

const CURRIED_OPERATION_MODULE = `import { defineOperation } from "@apifuse/provider-sdk/provider";

import type { ProviderContext } from "../index";

export const searchOperation = defineOperation<ProviderContext>()({
	descriptionKey: "operations.search.description",
});
`;

describe("migrateOperationShape", () => {
	it("curries a legacy call and adds the ProviderContext type import", () => {
		const result = migrateOperationShape(
			LEGACY_OPERATION_MODULE,
			"operations/search.ts",
			"../index",
		);

		expect(result.status).toBe("migrated");
		if (result.status !== "migrated") return;
		expect(result.rewrites).toBe(1);
		expect(result.importAdded).toBe(true);
		expect(result.code).toContain("defineOperation<ProviderContext>()({");
		expect(result.code).toContain(
			'import type { ProviderContext } from "../index";',
		);
	});

	it("curries every call site in a multi-operation file", () => {
		const twoOps = `${LEGACY_OPERATION_MODULE}
export const detailOperation = defineOperation({
	descriptionKey: "operations.detail.description",
});
`;
		const result = migrateOperationShape(twoOps, "operations/x.ts", "../index");

		expect(result.status).toBe("migrated");
		if (result.status !== "migrated") return;
		expect(result.rewrites).toBe(2);
		const occurrences =
			result.code.match(/defineOperation<ProviderContext>\(\)\(/g) ?? [];
		expect(occurrences.length).toBe(2);
	});

	it("handles defineStreamOperation the same way", () => {
		const stream = `import { defineStreamOperation } from "@apifuse/provider-sdk/provider";

export const downloadOperation = defineStreamOperation({
	descriptionKey: "operations.download.description",
});
`;
		const result = migrateOperationShape(stream, "operations/dl.ts", "../index");

		expect(result.status).toBe("migrated");
		if (result.status !== "migrated") return;
		expect(result.code).toContain("defineStreamOperation<ProviderContext>()({");
	});

	it("does not add an import when the file declares the ProviderContext alias (index.ts)", () => {
		const indexModule = `import { defineOperation, defineProvider, type ProviderContextOf } from "@apifuse/provider-sdk/provider";

const buildProvider = defineProvider({ id: "x", version: "1.0.0", runtime: "standard" });

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

const searchOperation = defineOperation({
	descriptionKey: "operations.search.description",
});

export default buildProvider({ operations: { search: searchOperation } });
`;
		const result = migrateOperationShape(indexModule, "index.ts", "./index");

		expect(result.status).toBe("migrated");
		if (result.status !== "migrated") return;
		expect(result.importAdded).toBe(false);
		expect(result.code).toContain("defineOperation<ProviderContext>()({");
		expect(result.code).not.toContain('import type { ProviderContext } from');
	});

	it("returns curried input unchanged", () => {
		const result = migrateOperationShape(
			CURRIED_OPERATION_MODULE,
			"operations/search.ts",
			"../index",
		);

		expect(result.status).toBe("unchanged");
		if (result.status === "unchanged") {
			expect(result.code).toBe(CURRIED_OPERATION_MODULE);
		}
	});

	it("is idempotent on its own output", () => {
		const first = migrateOperationShape(
			LEGACY_OPERATION_MODULE,
			"operations/search.ts",
			"../index",
		);
		expect(first.status).toBe("migrated");
		if (first.status !== "migrated") return;

		const second = migrateOperationShape(
			first.code,
			"operations/search.ts",
			"../index",
		);
		expect(second.status).toBe("unchanged");
	});

	it("skips loudly on a file mixing legacy and curried forms", () => {
		const mixed = `${CURRIED_OPERATION_MODULE}
export const otherOperation = defineOperation({
	descriptionKey: "operations.other.description",
});
`;
		const result = migrateOperationShape(mixed, "operations/x.ts", "../index");

		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toContain("mixes");
		}
	});

	it("skips loudly on unparseable source", () => {
		const result = migrateOperationShape(
			`const = defineOperation({;\n`,
			"operations/broken.ts",
			"../index",
		);

		expect(result.status).toBe("skipped");
	});
});
