import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { APIFUSE_DESCRIPTION_KEY_META_KEY, describeKey } from "../schema.js";

import {
	assertProviderLocaleKey,
	isProviderLocaleKey,
	providerLocaleKey,
	qualifyProviderLocaleKey,
} from "./keys.js";

describe("provider locale keys", () => {
	it("accepts provider-local dot path keys", () => {
		const key = providerLocaleKey("operations.reserve.whenToUse.afterAvailability");

		expect(isProviderLocaleKey(key)).toBe(true);
		expect(qualifyProviderLocaleKey("catchtable", key)).toBe(
			"providers.catchtable.operations.reserve.whenToUse.afterAvailability",
		);
	});

	it("rejects raw prose and malformed keys", () => {
		expect(() => assertProviderLocaleKey("Search restaurants by keyword")).toThrow(
			"Provider locale key",
		);
		expect(() => assertProviderLocaleKey("operations.reserve.")).toThrow("Provider locale key");
		expect(() => assertProviderLocaleKey("Operations.reserve.description")).toThrow(
			"Provider locale key",
		);
	});

	it("attaches schema description keys without embedding prose", () => {
		const schema = describeKey(
			z.string(),
			providerLocaleKey("operations.search.fields.query.description"),
		);

		expect(schema.description).toBeUndefined();
		expect(schema.meta()?.[APIFUSE_DESCRIPTION_KEY_META_KEY]).toBe(
			"operations.search.fields.query.description",
		);
	});

	it("rejects invalid schema description key paths", () => {
		expect(() => describeKey(z.string(), "Search query text")).toThrow("Provider locale key");
	});
});
