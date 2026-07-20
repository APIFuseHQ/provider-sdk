import { describe, expect, it } from "bun:test";

import { extractPagination, normalizeErrorResponse } from "../recipes/rest-api.js";

describe("rest-api recipe", () => {
	it("extracts pagination from standard shape", () => {
		expect(extractPagination({ page: 1, per_page: 10, total: 100 })).toEqual({
			page: 1,
			perPage: 10,
			total: 100,
			totalPages: 10,
			hasNext: true,
			hasPrev: false,
		});
	});

	it("returns null for missing pagination shape", () => {
		expect(extractPagination({ foo: "bar" })).toBeNull();
	});

	it("normalizes error response from string error", () => {
		expect(normalizeErrorResponse({ error: "Not found" })).toEqual({
			message: "Not found",
		});
	});

	it("normalizes error response from message field", () => {
		expect(normalizeErrorResponse({ message: "Forbidden" })).toEqual({
			message: "Forbidden",
		});
	});

	it("returns null for empty error object", () => {
		expect(normalizeErrorResponse({})).toBeNull();
	});
});
