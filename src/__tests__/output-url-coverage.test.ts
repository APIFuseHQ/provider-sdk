import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { image, imageList, itemPage, link, noMedia } from "../output-url.js";
import {
	collectFixtureStrings,
	formatOutputUrlCoverageWarning,
	OUTPUT_URL_COVERAGE_RULES,
	outputPathMatches,
	reportOutputUrlCoverage,
} from "../output-url-coverage.js";

const { unclassifiedUrl, itemCoverage } = OUTPUT_URL_COVERAGE_RULES;

function rules(warnings: ReturnType<typeof reportOutputUrlCoverage>) {
	return warnings.map((warning) => `${warning.rule} ${warning.operationId} ${warning.path}`);
}

describe("output URL coverage report", () => {
	it("warns about an absolute fixture URL that no helper declares, suggesting itemPage() or link()", () => {
		const warnings = reportOutputUrlCoverage({
			search: {
				output: z.object({
					items: z.array(
						z.object({ name: z.string(), detail_url: z.string(), image_url: image() }),
					),
				}),
				fixtures: {
					response: {
						items: [
							{
								name: "a",
								detail_url: "https://shop.example.com/p/1",
								image_url: "https://cdn.example.com/a.jpg",
							},
						],
					},
				},
			},
		});
		expect(rules(warnings)).toEqual([`${unclassifiedUrl} search items[].detail_url`]);
		const line = formatOutputUrlCoverageWarning(warnings[0]!);
		expect(line).toContain("WARN output-url-unclassified search items[].detail_url");
		expect(line).toContain("https://shop.example.com/…");
		expect(line).toContain("itemPage()");
		expect(line).toContain("link()");
		expect(line).toContain("Turn off:");
	});

	it("suggests image() when the undeclared fixture URL is a picture file", () => {
		const [warning] = reportOutputUrlCoverage({
			detail: {
				output: z.object({ cover: z.string().nullable(), url: itemPage() }),
				fixtures: { response: { cover: "https://cdn.example.com/c.webp", url: null } },
			},
		});
		expect(warning?.path).toBe("cover");
		expect(warning?.fix).toContain("image()");
	});

	it("tells an http:// picture to publish https before declaring image(), which would fail on it", () => {
		const [warning] = reportOutputUrlCoverage({
			detail: {
				output: z.object({ cover: z.string().nullable(), url: itemPage() }),
				fixtures: { response: { cover: "http://tong.example.com/c.jpg", url: null } },
			},
		});
		expect(warning?.message).toContain("http://tong.example.com/…");
		expect(warning?.fix).toContain('toImageUrl(raw, { upgradeHttp: ["tong.example.com"] })');
		expect(warning?.fix).toContain("re-record the fixture, then declare image()");
		expect(warning?.fix).toContain("fails the declaration check");
		expect(warning?.fix.startsWith("declare it with image()")).toBe(false);
		// the advice it no longer gives: image() refuses the recorded value
		expect(image().safeParse("http://tong.example.com/c.jpg").success).toBe(false);
	});

	it("keeps the upgrade advice when one path mixes https and http:// pictures", () => {
		const [warning] = reportOutputUrlCoverage({
			search: {
				output: z.object({ items: z.array(z.object({ cover: z.string(), url: itemPage() })) }),
				fixtures: {
					response: {
						items: [
							{ cover: "https://tong.example.com/a.jpg", url: null },
							{ cover: "http://tong.example.com/b.jpg", url: null },
						],
					},
				},
			},
		});
		expect(warning?.message).toContain("http://tong.example.com/…");
		expect(warning?.fix).toContain('upgradeHttp: ["tong.example.com"]');
	});

	it("gives the upgrade advice for an http:// value without a picture extension beside a picture", () => {
		const [warning] = reportOutputUrlCoverage({
			search: {
				output: z.object({ items: z.array(z.object({ cover: z.string(), url: itemPage() })) }),
				fixtures: {
					response: {
						items: [
							{ cover: "https://cdn.example.com/b.jpg", url: null },
							{ cover: "http://cdn.example.com/image?id=1", url: null },
						],
					},
				},
			},
		});
		expect(warning?.message).toContain("http://cdn.example.com/…");
		expect(warning?.fix).toContain('upgradeHttp: ["cdn.example.com"]');
		expect(image().safeParse("http://cdn.example.com/image?id=1").success).toBe(false);
	});

	it("warns about a declared format: uri string without a fixture value", () => {
		const warnings = reportOutputUrlCoverage({
			detail: {
				output: z.object({ homepage: z.string().url().optional(), url: itemPage() }),
			},
		});
		expect(rules(warnings)).toEqual([`${unclassifiedUrl} detail homepage`]);
		expect(warnings[0]?.message).toContain('format: "uri"');
	});

	it("warns about an item array without picture or page, naming every object array", () => {
		const warnings = reportOutputUrlCoverage({
			stations: {
				output: z.object({
					stations: z.array(z.object({ code: z.string(), reading: z.number() })),
					meta: z.object({ failures: z.array(z.object({ endpoint: z.string() })) }),
				}),
			},
		});
		expect(rules(warnings)).toEqual([`${itemCoverage} stations $`]);
		expect(warnings[0]?.message).toContain("meta.failures[], stations[]");
		expect(warnings[0]?.fix).toContain('noMedia("<upstream evidence>")');
		expect(warnings[0]?.fix).toContain("operations.stations");
	});

	it("does not warn about an auxiliary array next to an annotated item array", () => {
		const warnings = reportOutputUrlCoverage({
			search: {
				output: z.object({
					items: z.array(z.object({ name: z.string(), image_url: image(), url: itemPage() })),
					facets: z.array(z.object({ label: z.string(), count: z.number() })),
				}),
				fixtures: {
					response: {
						items: [{ name: "a", image_url: null, url: "https://shop.example.com/p/1" }],
						facets: [{ label: "x", count: 1 }],
					},
				},
			},
		});
		expect(warnings).toEqual([]);
	});

	it("lets noMedia silence the item warning but not an undeclared URL", () => {
		const warnings = reportOutputUrlCoverage({
			stations: {
				output: z.object({
					stations: z.array(z.object({ code: z.string(), source: z.string() })),
				}),
				noMedia: noMedia("Upstream rows carry station codes and readings only."),
				fixtures: {
					response: { stations: [{ code: "1", source: "https://data.example.go.kr/" }] },
				},
			},
		});
		expect(rules(warnings)).toEqual([`${unclassifiedUrl} stations stations[].source`]);
	});

	it("counts a link() alone as no picture or page", () => {
		const warnings = reportOutputUrlCoverage({
			sources: {
				output: z.object({ rows: z.array(z.object({ source_url: link() })) }),
			},
		});
		expect(rules(warnings)).toEqual([`${itemCoverage} sources $`]);
	});

	it("reads nullable, optional, nested, list and intersection fields", () => {
		const base = z.object({ name: z.string(), image_url: image().optional() });
		const warnings = reportOutputUrlCoverage({
			search: {
				output: z.object({
					items: z.array(
						z.intersection(
							base,
							z.object({
								gallery: imageList(),
								seller: z.object({ home: z.string().nullable(), url: itemPage() }),
								tags: z.array(z.string()).optional(),
							}),
						),
					),
				}),
				fixtures: {
					response: {
						items: [
							{
								name: "a",
								image_url: "https://cdn.example.com/a.jpg",
								gallery: ["https://cdn.example.com/b.jpg"],
								seller: {
									home: "https://seller.example.com/",
									url: "https://shop.example.com/s/1",
								},
								tags: ["https://not-a-field.example.com/"],
							},
						],
					},
				},
			},
		});
		expect(rules(warnings)).toEqual([
			`${unclassifiedUrl} search items[].seller.home`,
			`${unclassifiedUrl} search items[].tags[]`,
		]);
	});

	it("does not warn about URLs inside a passthrough payload the schema cannot declare", () => {
		const warnings = reportOutputUrlCoverage({
			detail: {
				output: z.object({ url: itemPage(), raw: z.unknown() }),
				fixtures: {
					response: {
						url: "https://shop.example.com/p/1",
						raw: { img: "https://cdn.example.com/a.jpg" },
					},
				},
			},
		});
		expect(warnings).toEqual([]);
	});

	it("matches record values through the .* path segment", () => {
		const warnings = reportOutputUrlCoverage({
			detail: {
				output: z.object({ url: itemPage(), links: z.record(z.string(), z.string()) }),
				fixtures: {
					response: { url: null, links: { homepage: "https://example.com/" } },
				},
			},
		});
		expect(rules(warnings)).toEqual([`${unclassifiedUrl} detail links.homepage`]);
		expect(outputPathMatches("links.*", "links.homepage")).toBe(true);
		expect(outputPathMatches("links.*", 'links["a b"]')).toBe(true);
		expect(outputPathMatches("items[].url", "items.url")).toBe(false);
	});

	it("ignores relative paths, other schemes and blank values", () => {
		const warnings = reportOutputUrlCoverage({
			detail: {
				output: z.object({
					a: z.string(),
					b: z.string(),
					c: z.string(),
					d: z.string(),
					url: itemPage(),
				}),
				fixtures: {
					response: {
						a: "/files/a.jpg",
						b: "mailto:x@example.com",
						c: " ",
						d: "https:/x",
						url: null,
					},
				},
			},
		});
		expect(warnings).toEqual([]);
	});

	it("collects fixture strings by collapsed path", () => {
		expect([...collectFixtureStrings({ items: [{ a: "x" }, { a: "y" }], "b c": "z" })]).toEqual([
			["items[].a", ["x", "y"]],
			['["b c"]', ["z"]],
		]);
	});

	it("skips an output schema that is not zod", () => {
		expect(reportOutputUrlCoverage({ x: { output: { parse: () => ({}) } } })).toEqual([]);
	});

	it("does not warn about a format: uri branch another branch declares with a helper", () => {
		const warnings = reportOutputUrlCoverage({
			detail: {
				output: z.intersection(
					z.object({ url: z.string().url() }),
					z.object({ url: itemPage(), image_url: image() }),
				),
				fixtures: { response: { url: "https://shop.example.com/p/1", image_url: null } },
			},
		});
		expect(warnings).toEqual([]);
	});
});
