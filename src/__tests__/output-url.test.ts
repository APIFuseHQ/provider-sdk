import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { extractProviderContract } from "../contract.js";
import {
	DECLARATION_INVALID_CODE,
	DECLARATION_RULE_IDS,
	type DeclarationViolation,
	validateFailClosedDeclaration,
} from "../declaration-validation.js";
import { isProviderError } from "../errors.js";
import {
	APIFUSE_IMAGE_ROLE_META_KEY,
	APIFUSE_URL_KIND_META_KEY,
	type ImageUrl,
	type ItemPageUrl,
	image,
	imageList,
	inspectOutputUrlKinds,
	itemPage,
	itemPageFrom,
	type LinkUrl,
	link,
	noMedia,
	type OutputUrlDrop,
	toImageUrl,
	toImageUrls,
	toItemPageUrl,
	toLinkUrl,
} from "../output-url.js";
import { observeOutputUrlDrops } from "../runtime/output-url-observer.js";
import { OutputUrlTelemetryCollector } from "../runtime/output-url-telemetry.js";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/request-telemetry.js";
import { createServerApp, type ProviderServerLogEvent } from "../server/serve.js";
import type { OperationRiskClass, ProviderDefinition } from "../types.js";
import { defineTestProvider as defineProvider } from "./test-utils.js";

const READ: OperationRiskClass = "read";

function drops<T>(fn: () => T): { result: T; drops: OutputUrlDrop[] } {
	const recorded: OutputUrlDrop[] = [];
	const result = observeOutputUrlDrops({ recordDrop: (drop) => recorded.push(drop) }, fn);
	return { result, drops: recorded };
}

type JsonNode = Record<string, unknown>;

function properties(schema: z.ZodType): Record<string, JsonNode> {
	const json = z.toJSONSchema(schema) as { properties: Record<string, JsonNode> };
	return json.properties;
}

describe("output URL schema primitives", () => {
	it("emit format uri and the url kind on the JSON Schema string node", () => {
		const props = properties(
			z.object({
				image_url: image(),
				thumbnail_url: image({ thumbnail: true }).optional(),
				image_urls: imageList(),
				url: itemPage().nullable(),
				source_url: link().optional().describeKey("schemaDescriptions.index.d0001"),
			}),
		);
		expect(props.image_url).toStrictEqual({
			type: "string",
			format: "uri",
			[APIFUSE_URL_KIND_META_KEY]: "image",
		});
		expect(props.thumbnail_url).toStrictEqual({
			type: "string",
			format: "uri",
			[APIFUSE_URL_KIND_META_KEY]: "image",
			[APIFUSE_IMAGE_ROLE_META_KEY]: "thumbnail",
		});
		expect(props.image_urls).toStrictEqual({
			type: "array",
			items: { type: "string", format: "uri", [APIFUSE_URL_KIND_META_KEY]: "image" },
		});
		expect(props.url).toStrictEqual({
			anyOf: [
				{ type: "string", format: "uri", [APIFUSE_URL_KIND_META_KEY]: "item_page" },
				{ type: "null" },
			],
		});
		expect(props.source_url).toMatchObject({
			type: "string",
			format: "uri",
			[APIFUSE_URL_KIND_META_KEY]: "link",
			"x-apifuse-description-key": "schemaDescriptions.index.d0001",
		});
	});

	it("leave plain string fields unannotated", () => {
		const props = properties(z.object({ image_url: z.string(), url: z.string().url() }));
		expect(props.image_url).toStrictEqual({ type: "string" });
		expect(props.url).not.toHaveProperty(APIFUSE_URL_KIND_META_KEY);
	});

	it("accept only values a constructor would publish", () => {
		const picture = image();
		expect(picture.safeParse("https://cdn.example.com/a.jpg?sig=Ab%2B1").success).toBe(true);
		for (const value of [
			"http://cdn.example.com/a.jpg",
			"/files/a.jpg",
			"//cdn.example.com/a.jpg",
			"https://127.0.0.1/a.jpg",
			"https://localhost/a.jpg",
			"https://intranet/a.jpg",
			"https://cdn.internal/a.jpg",
			"https://user:pw@cdn.example.com/a.jpg",
			"data:image/png;base64,AAAA",
			"",
		]) {
			expect(picture.safeParse(value).success, value).toBe(false);
		}
		// z.url() trims, so the published value never carries the padding.
		expect(picture.parse(" https://cdn.example.com/a.jpg ")).toBe("https://cdn.example.com/a.jpg");
		expect(itemPage().safeParse("http://www.example.go.kr/item/1").success).toBe(true);
		expect(link().safeParse("https://www.example.com/download.pdf").success).toBe(true);
		expect(link().safeParse("mailto:help@example.com").success).toBe(false);
	});
});

describe("toImageUrl", () => {
	it("keeps an absolute https URL on a public host byte for byte", () => {
		const signed = "https://cdn.example.com/p/a.jpg?X-Amz-Signature=AbC%2Fd&x=1#frag";
		const { result, drops: recorded } = drops(() => toImageUrl(`  ${signed} `));
		expect(result).toBe(signed);
		expect(recorded).toStrictEqual([]);
	});

	it("drops http and reports it, unless the host is declared in upgradeHttp", () => {
		const { result, drops: recorded } = drops(() =>
			toImageUrl("http://img.example.com/a.jpg?token=secret", { field: "items[].image_url" }),
		);
		expect(result).toBeUndefined();
		expect(recorded).toStrictEqual([
			{
				kind: "image",
				reason: "insecure",
				field: "items[].image_url",
				value: "http://img.example.com/a.jpg?token=secret",
			},
		]);
		expect(toImageUrl("HTTP://IMG.example.com/a.jpg", { upgradeHttp: ["img.example.com"] })).toBe(
			"https://IMG.example.com/a.jpg",
		);
	});

	it("drops relative values without a base and resolves them with one", () => {
		const { result, drops: recorded } = drops(() => toImageUrl("/files/a.jpg"));
		expect(result).toBeUndefined();
		expect(recorded).toMatchObject([{ kind: "image", reason: "relative", value: "/files/a.jpg" }]);
		const base = "https://cdn.daisomall.co.kr";
		expect(toImageUrl("/files/a.jpg", { base })).toBe("https://cdn.daisomall.co.kr/files/a.jpg");
		expect(toImageUrl("files/a.jpg", { base: `${base}/` })).toBe(
			"https://cdn.daisomall.co.kr/files/a.jpg",
		);
		expect(toImageUrl("//img.example.com/a.jpg", { base })).toBe("https://img.example.com/a.jpg");
	});

	it("drops unsafe schemes, hosts and credentials with a reason", () => {
		const cases: Array<[unknown, OutputUrlDrop["reason"]]> = [
			["javascript:alert(1)", "scheme"],
			["data:image/png;base64,AAAA", "scheme"],
			["ftp://files.example.com/a.jpg", "scheme"],
			["https:cdn.example.com/a.jpg", "not_url"],
			["https://", "not_url"],
			["https://10.0.0.1/a.jpg", "host"],
			["https://[::1]/a.jpg", "host"],
			["https://localhost/a.jpg", "host"],
			["https://metadata.internal./a.jpg", "host"],
			["https://router/a.jpg", "host"],
			["https://user:secret@cdn.example.com/a.jpg", "credentials"],
			[42, "not_url"],
		];
		for (const [raw, reason] of cases) {
			const { result, drops: recorded } = drops(() => toImageUrl(raw));
			expect(result, String(raw)).toBeUndefined();
			expect(
				recorded.map((drop) => drop.reason),
				String(raw),
			).toStrictEqual([reason]);
		}
		const { drops: credential } = drops(() =>
			toImageUrl("https://user:secret@cdn.example.com/a.jpg"),
		);
		expect(credential[0]).not.toHaveProperty("value");
	});

	it("treats a missing value as absent, not as a drop", () => {
		for (const raw of [undefined, null, "", "   "]) {
			const { result, drops: recorded } = drops(() => toImageUrl(raw));
			expect(result).toBeUndefined();
			expect(recorded).toStrictEqual([]);
		}
	});

	it("throws on a base that is not an absolute http(s) URL", () => {
		expect(() => toImageUrl("/a.jpg", { base: "cdn.example.com" })).toThrow(TypeError);
		expect(() => toImageUrl("/a.jpg", { base: "ftp://cdn.example.com" })).toThrow(TypeError);
	});

	it("never fails the caller when observation throws", () => {
		const result = observeOutputUrlDrops(
			{
				recordDrop: () => {
					throw new Error("sink down");
				},
			},
			() => toImageUrl("http://img.example.com/a.jpg"),
		);
		expect(result).toBeUndefined();
	});
});

describe("toImageUrls", () => {
	it("keeps order, skips dropped values and removes duplicates", () => {
		const { result, drops: recorded } = drops(() =>
			toImageUrls([
				"https://cdn.example.com/1.jpg",
				"http://cdn.example.com/2.jpg",
				null,
				"https://cdn.example.com/3.jpg",
				"https://cdn.example.com/1.jpg",
			]),
		);
		expect(result).toStrictEqual([
			"https://cdn.example.com/1.jpg",
			"https://cdn.example.com/3.jpg",
		]);
		expect(recorded.map((drop) => drop.reason)).toStrictEqual(["insecure"]);
		expect(toImageUrls(undefined)).toStrictEqual([]);
		expect(toImageUrls(null)).toStrictEqual([]);
	});
});

describe("item page and link constructors", () => {
	it("accept http and https pages and links on public hosts", () => {
		expect(toItemPageUrl("http://www.law.go.kr/lsInfoP.do?lsiSeq=1")).toBe(
			"http://www.law.go.kr/lsInfoP.do?lsiSeq=1",
		);
		expect(toLinkUrl("https://www.example.com/file.pdf")).toBe("https://www.example.com/file.pdf");
		const { result, drops: recorded } = drops(() =>
			toLinkUrl("mailto:help@example.com", { field: "contact_url" }),
		);
		expect(result).toBeUndefined();
		expect(recorded).toMatchObject([{ kind: "link", reason: "scheme", field: "contact_url" }]);
	});

	it("assemble an item page from a template with encoded values", () => {
		expect(
			itemPageFrom("https://www.yeogi.com/domestic-accommodations/{property_id}", {
				property_id: 4521,
			}),
		).toBe("https://www.yeogi.com/domestic-accommodations/4521");
		expect(
			itemPageFrom("https://app.example.co.kr/shop/{alias}?ref={ref}", {
				alias: "강남 a/b",
				ref: "x&y",
			}),
		).toBe("https://app.example.co.kr/shop/%EA%B0%95%EB%82%A8%20a%2Fb?ref=x%26y");
		expect(itemPageFrom("https://www.example.com/items/{id}", { id: null })).toBeUndefined();
		expect(itemPageFrom("https://www.example.com/items/{id}", { id: " " })).toBeUndefined();
		expect(() => itemPageFrom("https://www.example.com/items/{id}", {})).toThrow(TypeError);
		expect(() => itemPageFrom("/items/{id}", { id: "1" })).toThrow(TypeError);
	});

	it("keep the URL kinds apart at compile time", () => {
		const picture: ImageUrl = "https://cdn.example.com/a.jpg";
		const page: ItemPageUrl = "http://www.example.com/items/1";
		const other: LinkUrl = "https://www.example.com/source";
		const raw: string = picture;
		// @ts-expect-error test-invalid: a plain upstream string must go through a constructor.
		const unchecked: ImageUrl = raw;
		// @ts-expect-error test-invalid: an http URL is never an image URL.
		const insecure: ImageUrl = "http://cdn.example.com/a.jpg";
		// @ts-expect-error test-invalid: a picture is not the item's page.
		const swapped: ItemPageUrl = picture;
		// @ts-expect-error test-invalid: a source link is not the item's page.
		const relabeled: ItemPageUrl = other;
		expect([picture, page, other, unchecked, insecure, swapped, relabeled]).toHaveLength(7);
	});
});

describe("noMedia", () => {
	it("returns a frozen reason declaration and refuses a blank reason", () => {
		const declaration = noMedia("Upstream rows carry station codes and readings only.");
		expect(declaration).toStrictEqual({
			reason: "Upstream rows carry station codes and readings only.",
		});
		expect(Object.isFrozen(declaration)).toBe(true);
		expect(() => noMedia("  ")).toThrow(TypeError);
	});
});

function operationWith(output: z.ZodType, extra: Record<string, unknown> = {}) {
	return {
		riskClass: READ,
		input: z.object({}),
		output,
		handler: async () => ({}),
		healthCheckUnsupported: { reason: "Unit test operation without an upstream." },
		...extra,
	};
}

function declaration(operations: ProviderDefinition["operations"]): ProviderDefinition {
	return {
		id: "output-url-test",
		version: "1.0.0",
		runtime: "standard",
		meta: { displayName: "Output URL", descriptionKey: "d", category: "test" },
		operations,
	};
}

function violations(provider: ProviderDefinition): DeclarationViolation[] {
	try {
		validateFailClosedDeclaration(provider);
	} catch (error) {
		if (!isProviderError(error) || error.code !== DECLARATION_INVALID_CODE) throw error;
		const details = error.details as { violations?: DeclarationViolation[] };
		return details.violations ?? [];
	}
	return [];
}

describe("output URL declaration rules", () => {
	it("accept one page and one main picture per item, plus thumbnails, lists and links", () => {
		const item = z.object({
			image_url: image().optional(),
			thumbnail_url: image({ thumbnail: true }).optional(),
			image_urls: imageList(),
			url: itemPage().optional(),
			source_url: link().optional(),
			reserve_url: link().optional(),
		});
		const output = z.object({ items: z.array(item), shop: item.nullable() });
		expect(violations(declaration({ search: operationWith(output) }))).toStrictEqual([]);
		expect(inspectOutputUrlKinds(z.toJSONSchema(output)).entries).toContainEqual({
			path: "items[].image_urls[]",
			kind: "image",
			thumbnail: false,
		});
	});

	it("reject two own pages or two main pictures in one object", () => {
		const output = z.object({
			items: z.array(
				z.object({
					url: itemPage(),
					detail_url: itemPage().optional(),
					image_url: image(),
					photo_url: image().nullable(),
				}),
			),
		});
		const found = violations(declaration({ search: operationWith(output) }));
		expect(found.map((violation) => [violation.ruleId, violation.path])).toStrictEqual([
			[DECLARATION_RULE_IDS.outputUrlKindUnique, "operations.search.output items[]"],
			[DECLARATION_RULE_IDS.outputUrlKindUnique, "operations.search.output items[]"],
		]);
		expect(found[0]?.message).toContain("detail_url, url");
		expect(found[1]?.message).toContain("image_url, photo_url");
	});

	it("reject noMedia next to image or item page fields, but not next to links", () => {
		const withPicture = operationWith(
			z.object({ items: z.array(z.object({ image_url: image() })) }),
			{
				noMedia: noMedia("Upstream has no photos."),
			},
		);
		expect(violations(declaration({ search: withPicture }))).toMatchObject([
			{ ruleId: DECLARATION_RULE_IDS.noMediaContradiction, path: "operations.search.noMedia" },
		]);
		const withLink = operationWith(z.object({ source_url: link() }), {
			noMedia: noMedia("Upstream has no photos or item pages; the dataset page is a source link."),
		});
		expect(violations(declaration({ search: withLink }))).toStrictEqual([]);
	});

	it("validate the noMedia shape in defineProvider and publish it in the contract", () => {
		expect(() =>
			defineProvider({
				...declaration({}),
				operations: {
					stations: operationWith(z.object({ ok: z.boolean() }), { noMedia: { reason: " " } }),
				},
			}),
		).toThrow("operations.stations.noMedia.reason must be a non-empty string");
		expect(() =>
			defineProvider({
				...declaration({}),
				operations: {
					stations: operationWith(z.object({ ok: z.boolean() }), {
						noMedia: { reason: "No photos upstream.", why: "x" },
					}),
				},
			}),
		).toThrow('Unknown field "why" on operations.stations.noMedia');
		const provider = defineProvider({
			...declaration({}),
			operations: {
				stations: operationWith(z.object({ ok: z.boolean() }), {
					noMedia: noMedia("Upstream rows carry station codes only."),
				}),
			},
		});
		const contract = extractProviderContract(provider);
		expect(contract.operations[0]?.noMedia).toStrictEqual({
			reason: "Upstream rows carry station codes only.",
		});
	});
});

describe("output URL observation events", () => {
	it("group drops per kind, reason and field and strip query strings", () => {
		const collector = new OutputUrlTelemetryCollector({
			redact: (text) => text.replace("secret", "[R]"),
		});
		observeOutputUrlDrops(collector, () => {
			toImageUrls(["http://img.example.com/secret/1.jpg?sig=abc", "http://img.example.com/2.jpg"], {
				field: "items[].image_urls[]",
			});
			toItemPageUrl("/items/1", { field: "items[].url" });
		});
		const spans = { spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 };
		expect(collector.toLogPayload(spans)).toStrictEqual({
			outputUrlDropped: [
				{
					kind: "image",
					reason: "insecure",
					field: "items[].image_urls[]",
					count: 2,
					example: "http://img.example.com/[R]/1.jpg",
				},
				{
					kind: "item_page",
					reason: "relative",
					field: "items[].url",
					count: 1,
					example: "/items/1",
				},
			],
		});
		expect(new OutputUrlTelemetryCollector().toLogPayload(spans)).toBeUndefined();
	});

	it("reach the request log, never the response or the gateway header", async () => {
		const events: ProviderServerLogEvent[] = [];
		const app = createServerApp(
			declaration({
				search: {
					riskClass: READ,
					input: z.object({}),
					output: z.object({
						items: z.array(z.object({ name: z.string(), image_url: image().optional() })),
					}),
					handler: async () => ({
						items: ["https://cdn.example.com/1.jpg", "http://img.example.com/2.jpg"].map(
							(raw, index) => ({
								name: `item ${index}`,
								image_url: toImageUrl(raw, { field: "items[].image_url" }),
							}),
						),
					}),
				},
			}),
			{ logger: (event) => events.push(event) },
		);
		const response = await app.request("/v1/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req-1", input: {} }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { items: JsonNode[] } };
		expect(body.data.items).toStrictEqual([
			{ name: "item 0", image_url: "https://cdn.example.com/1.jpg" },
			{ name: "item 1" },
		]);
		const header = response.headers.get(PROVIDER_TELEMETRY_HEADER);
		if (header) expect(Buffer.from(header, "base64url").toString()).not.toContain("outputUrl");
		expect(events).toHaveLength(1);
		// test-invalid: contributor fields are not exposed on the shared log event type.
		const log = events[0] as { events?: { outputUrlDropped: unknown[] } };
		expect(log.events?.outputUrlDropped).toStrictEqual([
			{
				kind: "image",
				reason: "insecure",
				field: "items[].image_url",
				count: 1,
				example: "http://img.example.com/2.jpg",
			},
		]);
	});
});
