import { describe, expect, it } from "bun:test";
import { z as plainZ } from "zod";

import { z } from "../provider.js";
import { APIFUSE_DESCRIPTION_KEY_META_KEY, describeKey } from "../schema.js";

function descriptionKey(schema: { meta(): Record<string, unknown> | undefined }) {
	return schema.meta()?.[APIFUSE_DESCRIPTION_KEY_META_KEY];
}

describe("schema description keys", () => {
	it("attaches description-key metadata with chainable string schemas", () => {
		const schema = z.string().describeKey("schemaDescriptions.index.d0001");

		expect(descriptionKey(schema)).toBe("schemaDescriptions.index.d0001");
	});

	it("preserves chaining after Zod refinements", () => {
		const schema = z.number().min(0).describeKey("schemaDescriptions.index.d0002");

		expect(descriptionKey(schema)).toBe("schemaDescriptions.index.d0002");
	});

	it("matches describeKey(schema, key) compatibility metadata", () => {
		const methodSchema = z.string().describeKey("schemaDescriptions.index.d0003");
		const functionSchema = describeKey(z.string(), "schemaDescriptions.index.d0003");

		expect(descriptionKey(methodSchema)).toBe(descriptionKey(functionSchema));
	});

	it("installs describeKey on all SDK-exported Zod schema prototypes", () => {
		const schemas = [z.file(), z.nan(), z.custom(() => true)];

		for (const schema of schemas) {
			expect(typeof schema.describeKey).toBe("function");
			expect(descriptionKey(schema.describeKey("schemaDescriptions.index.d0004"))).toBe(
				"schemaDescriptions.index.d0004",
			);
		}
	});

	it("does not expose describeKey before the provider SDK is loaded", async () => {
		const output =
			await Bun.$`bun -e 'import { z } from "zod"; console.log(typeof z.string().describeKey)'`.text();

		expect(output.trim()).toBe("undefined");
		expect(typeof plainZ.string().describeKey).toBe("function");
	});
});
