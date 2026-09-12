import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	SDK_RUNTIME_OWNED_ERROR_CODES,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
} from "../error-resolution.js";
import { APIFUSE_DESCRIPTION_KEY_META_KEY, describeKey } from "../schema.js";
import {
	derivedProviderErrorCatalogPath,
	PROVIDER_ERROR_CATALOG_NAMESPACE,
} from "./error-messages.js";

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

	it("accepts an error code as the segment under errors", () => {
		// The three codes PR #323 registered and AUTHORING points authors at.
		for (const code of ["UPSTREAM_AUTH_ERROR", "UPSTREAM_SCHEMA_ERROR", "INVALID_REQUEST"]) {
			expect(isProviderLocaleKey(`errors.${code}.message`)).toBe(true);
			expect(isProviderLocaleKey(`errors.${code}.fix`)).toBe(true);
		}

		// Other real shapes from the registered vocabulary.
		expect(isProviderLocaleKey("errors.BLOCKED.message")).toBe(true);
		expect(
			isProviderLocaleKey("errors.LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR.message"),
		).toBe(true);
		expect(isProviderLocaleKey("errors.reauth_required.fix")).toBe(true);
		expect(isProviderLocaleKey("errors.not_found.message")).toBe(true);
		expect(isProviderLocaleKey("errors.HTTP2_ERROR.message")).toBe(true);
		// A code leaf with no field, and a nested errors namespace.
		expect(isProviderLocaleKey("errors.UPSTREAM_ERROR")).toBe(true);
		expect(isProviderLocaleKey("operations.search.errors.UPSTREAM_ERROR.message")).toBe(true);
		// The camelCase spelling AUTHORING also shows keeps working.
		expect(isProviderLocaleKey("errors.upstreamSchema.message")).toBe(true);
	});

	it("keeps every derived error catalog path a legal locale key", () => {
		// Guards the coupling between the grammar and the registered code
		// vocabulary: a future code whose shape the grammar cannot spell would
		// make `apifuse check` report error-locale-key-malformed for text the
		// SDK serves correctly.
		const codes = [
			...SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.keys(),
			...SDK_RUNTIME_OWNED_ERROR_CODES,
		];
		expect(codes.length).toBeGreaterThan(0);
		for (const code of codes) {
			for (const field of ["message", "fix"] as const) {
				const path = derivedProviderErrorCatalogPath(code, field);
				expect({ code, path, valid: isProviderLocaleKey(path) }).toEqual({
					code,
					path,
					valid: true,
				});
			}
		}
	});

	it("anchors the error-code vocabulary to the errors namespace", () => {
		// The namespace the grammar keys off must be the one the SDK derives.
		expect(PROVIDER_ERROR_CATALOG_NAMESPACE).toBe("errors");
		expect(derivedProviderErrorCatalogPath("UPSTREAM_SCHEMA_ERROR", "message")).toBe(
			"errors.UPSTREAM_SCHEMA_ERROR.message",
		);

		// A code shape is only legal directly under `errors`; elsewhere the tree
		// stays camelCase.
		expect(isProviderLocaleKey("meta.UPSTREAM_SCHEMA_ERROR")).toBe(false);
		expect(isProviderLocaleKey("operations.search.errorCodes.UPSTREAM_ERROR")).toBe(false);
		expect(isProviderLocaleKey("errors.UPSTREAM_ERROR.DETAIL_TEXT")).toBe(false);
		// A code may not be the root segment: catalogs are rooted in a namespace.
		expect(isProviderLocaleKey("UPSTREAM_SCHEMA_ERROR.message")).toBe(false);
		expect(isProviderLocaleKey("errors")).toBe(true);
	});

	it("rejects malformed code segments without loosening the grammar", () => {
		const rejected = [
			"", // empty key
			"errors..message", // empty segment
			"errors.UPSTREAM SCHEMA_ERROR.message", // space
			"errors. UPSTREAM_SCHEMA_ERROR.message", // leading space
			"errors.UPSTREAM_SCHEMA_ERROR .message", // trailing space
			"errors.upstream.schema.ERROR.message", // dot inside the code
			"errors._UPSTREAM_ERROR.message", // leading underscore
			"errors.UPSTREAM_ERROR_.message", // trailing underscore
			"errors.UPSTREAM__ERROR.message", // empty underscore word
			"errors.Upstream_Error.message", // mixed case
			"errors.UPSTREAM-ERROR.message", // hyphen
			"errors.UPSTREAM_SCHEMA_ERROR.message.", // trailing dot
			".errors.UPSTREAM_SCHEMA_ERROR.message", // leading dot
			"errors.__proto__.message", // prototype-shaped segment
			"errors.UPSTREAM_SCHEMA_ERROR.mes sage", // space in the field
		];
		for (const key of rejected) {
			expect({ key, valid: isProviderLocaleKey(key) }).toEqual({ key, valid: false });
		}
	});

	it("keeps error codes disjoint from the numeric array-index form", () => {
		// Index segments are unchanged: still legal after the first segment, and
		// still the only all-digit segment shape. No code can be spelled as one,
		// so `key.split(".")` never yields an ambiguous segment.
		expect(isProviderLocaleKey("meta.tags.0")).toBe(true);
		expect(isProviderLocaleKey("errors.UPSTREAM_ERROR.hints.0")).toBe(true);
		expect(isProviderLocaleKey("errors.0.message")).toBe(true);
		expect(isProviderLocaleKey("0.message")).toBe(false);
		expect(isProviderLocaleKey("errors.0_1.message")).toBe(false);
		expect(isProviderLocaleKey("errors.1UPSTREAM_ERROR.message")).toBe(false);
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
