import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { lintProvider } from "../lint";

const OPERATION_DESCRIPTION =
	"Use this operation when callers need normalized commerce search results and when the provider must keep upstream parameter and response names behind the APIFuse mapping boundary.";

describe("public provider schema field lint", () => {
	it("reports upstream-shaped public schema fields with provider and operation context", () => {
		const diagnostics = lintProvider({
			id: "example-commerce",
			allowedHosts: ["openapi.naver.com"],
			reviewed: "first-party",
			meta: { contract: { publicSchemaFieldNames: "normalized" } },
			operations: {
				search: {
					description: OPERATION_DESCRIPTION,
					input: z
						.object({
							query: z.string().describe("Search query"),
							display: z.number().describe("Upstream count"),
						})
						.describe("Bad search input"),
					output: z
						.object({
							items: z
								.array(
									z.object({
										mallName: z.string().describe("Upstream mall name"),
										category1: z.string().describe("Upstream category"),
										lprice: z.number().describe("Upstream low price"),
									}),
								)
								.describe("Bad item rows"),
						})
						.describe("Bad search output"),
					fixtures: {
						request: { query: "에어팟", display: 10 },
						response: {
							items: [{ mallName: "네이버", category1: "가전", lprice: 1 }],
						},
					},
				},
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "public-schema-upstream-field",
				level: "error",
				field: "operations.search.input.display",
				message: expect.stringContaining(
					'Provider "example-commerce" operation "search"',
				),
			}),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "public-schema-upstream-field",
				field: "operations.search.output.items[].mallName",
				message: expect.stringContaining("mall_name"),
			}),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "public-schema-upstream-field",
				field: "operations.search.output.items[].category1",
				message: expect.stringContaining("category_path"),
			}),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "public-schema-upstream-field",
				field: "operations.search.output.items[].lprice",
				message: expect.stringContaining("lowest_price"),
			}),
		);
	});

	it("traverses union wrappers before accepting public field names", () => {
		const diagnostics = lintProvider({
			id: "union-commerce",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			meta: { contract: { publicSchemaFieldNames: "normalized" } },
			operations: {
				search: {
					description: OPERATION_DESCRIPTION,
					input: z
						.object({ query: z.string().describe("Search query") })
						.describe("Search input"),
					output: z
						.object({
							item: z
								.union([
									z.object({
										mallName: z.string().describe("Upstream mall name"),
									}),
									z.object({
										name: z.string().describe("Normalized name"),
									}),
								])
								.describe("Union item"),
						})
						.describe("Search output"),
					fixtures: {
						request: { query: "에어팟" },
						response: { item: { name: "에어팟" } },
					},
				},
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "public-schema-upstream-field",
				field: "operations.search.output.item.mallName",
				message: expect.stringContaining("mall_name"),
			}),
		);
	});
	it("accepts normalized APIFuse commerce search fields", () => {
		const diagnostics = lintProvider({
			id: "naver-shopping",
			allowedHosts: ["openapi.naver.com"],
			reviewed: "first-party",
			meta: { contract: { publicSchemaFieldNames: "normalized" } },
			operations: {
				search: {
					description: OPERATION_DESCRIPTION,
					input: z
						.object({
							query: z.string().describe("Search query"),
							limit: z.number().describe("Maximum row count"),
							offset: z.number().describe("Start offset"),
							sort_by: z
								.enum(["relevance", "date", "price_asc", "price_desc"])
								.describe("Sort option"),
						})
						.describe("Normalized search input"),
					output: z
						.object({
							items: z
								.array(
									z.object({
										title: z.string().describe("Product title"),
										url: z.string().describe("Product URL"),
										image_url: z.string().nullable().describe("Image URL"),
										lowest_price: z
											.number()
											.nullable()
											.describe("Lowest price"),
										highest_price: z
											.number()
											.nullable()
											.describe("Highest price"),
										mall_name: z.string().nullable().describe("Mall name"),
										product_id: z
											.string()
											.nullable()
											.describe("Naver product ID"),
										product_type_code: z
											.string()
											.nullable()
											.describe("Naver product type code"),
										category_path: z
											.array(z.string())
											.describe("Category path"),
									}),
								)
								.describe("Normalized item rows"),
							summary: z
								.object({
									total_count: z.number().describe("Total rows"),
									returned_count: z.number().describe("Returned rows"),
									limit: z.number().describe("Maximum row count"),
									offset: z.number().describe("Start offset"),
									sort_by: z
										.enum(["relevance", "date", "price_asc", "price_desc"])
										.describe("Sort option"),
								})
								.describe("Normalized summary"),
						})
						.describe("Normalized search output"),
					fixtures: {
						request: { query: "에어팟", limit: 10, offset: 1 },
						response: {
							items: [
								{
									title: "에어팟",
									url: "https://example.com",
									image_url: null,
									lowest_price: 1,
									highest_price: null,
									mall_name: "네이버",
									product_id: "123",
									product_type_code: "1",
									category_path: ["가전"],
								},
							],
							summary: {
								total_count: 1,
								returned_count: 1,
								limit: 10,
								offset: 1,
								sort_by: "relevance",
							},
						},
					},
				},
			},
		});

		expect(
			diagnostics.filter(
				(diagnostic) => diagnostic.rule === "public-schema-upstream-field",
			),
		).toEqual([]);
	});
});
