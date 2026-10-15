import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { extractProviderContract } from "../contract.js";
import { describeSchema, zodSchemaToJson } from "../contract-serialization.js";
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
import { executeOperation } from "../runtime/executor.js";
import { observeOutputUrlDrops } from "../runtime/output-url-observer.js";
import { OutputUrlTelemetryCollector } from "../runtime/output-url-telemetry.js";
import { RequestTelemetry } from "../runtime/request-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";
import { createServerApp, type ProviderServerLogEvent } from "../server/serve.js";
import { event } from "../stream.js";
import type { OperationRiskClass, ProviderDefinition } from "../types.js";
import { isPublicUrlHost } from "../url-host.js";
import { createProviderContextDouble, defineTestProvider as defineProvider } from "./test-utils.js";

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
	it("admit null and carry format uri and the url kind on the string branch", () => {
		const schema = z.object({
			image_url: image(),
			thumbnail_url: image({ thumbnail: true }).optional(),
			image_urls: imageList(),
			url: itemPage(),
			source_url: link().optional().describeKey("schemaDescriptions.index.d0001"),
		});
		const props = properties(schema);
		const nullable = (branch: JsonNode) => ({ anyOf: [branch, { type: "null" }] });
		expect(props.image_url).toStrictEqual(
			nullable({ type: "string", format: "uri", [APIFUSE_URL_KIND_META_KEY]: "image" }),
		);
		expect(props.thumbnail_url).toStrictEqual(
			nullable({
				type: "string",
				format: "uri",
				[APIFUSE_URL_KIND_META_KEY]: "image",
				[APIFUSE_IMAGE_ROLE_META_KEY]: "thumbnail",
			}),
		);
		// List items are never null: toImageUrls() skips what it leaves out.
		expect(props.image_urls).toStrictEqual({
			type: "array",
			items: { type: "string", format: "uri", [APIFUSE_URL_KIND_META_KEY]: "image" },
		});
		expect(props.url).toStrictEqual(
			nullable({ type: "string", format: "uri", [APIFUSE_URL_KIND_META_KEY]: "item_page" }),
		);
		expect(props.source_url).toMatchObject({
			...nullable({ type: "string", format: "uri", [APIFUSE_URL_KIND_META_KEY]: "link" }),
			"x-apifuse-description-key": "schemaDescriptions.index.d0001",
		});
		expect(z.toJSONSchema(schema)).toMatchObject({
			required: ["image_url", "image_urls", "url"],
		});
		expect(inspectOutputUrlKinds(z.toJSONSchema(schema)).entries).toStrictEqual([
			{ path: "image_url", kind: "image", thumbnail: false },
			{ path: "image_urls[]", kind: "image", thumbnail: false },
			{ path: "source_url", kind: "link", thumbnail: false },
			{ path: "thumbnail_url", kind: "image", thumbnail: true },
			{ path: "url", kind: "item_page", thumbnail: false },
		]);
	});

	it("emit the contract schema of the helper alone for a redundant nullable", () => {
		const hash = (schema: z.ZodType) =>
			(describeSchema(schema) as { jsonSchemaHash?: string }).jsonSchemaHash;
		const spellings: Array<[z.ZodType, z.ZodType]> = [
			[z.object({ image_url: image() }), z.object({ image_url: image().nullable() })],
			[z.object({ url: itemPage() }), z.object({ url: itemPage().nullable().nullable() })],
			[z.object({ source_url: link().optional() }), z.object({ source_url: link().nullish() })],
			[
				z.object({ source_url: link().describeKey("schemaDescriptions.index.d0001") }),
				z.object({
					source_url: link().describeKey("schemaDescriptions.index.d0001").nullable(),
				}),
			],
		];
		for (const [helper, redundant] of spellings) {
			expect(zodSchemaToJson(redundant)).toEqual(zodSchemaToJson(helper));
			expect(hash(redundant)).toBe(hash(helper));
		}
		// The same contract as the plain nullable string it replaces, but for the annotation.
		expect(zodSchemaToJson(z.object({ image_url: image().nullable() }))).toMatchObject({
			properties: {
				image_url: {
					anyOf: [{ type: "string", [APIFUSE_URL_KIND_META_KEY]: "image" }, { type: "null" }],
				},
			},
		});
		// Contracts written without the helpers are emitted exactly as before.
		const plain = z.object({ name: z.string().nullable().nullable() });
		expect(JSON.stringify(zodSchemaToJson(plain))).toBe(JSON.stringify(z.toJSONSchema(plain)));
	});

	it("still find the kind under a redundant nullable", () => {
		const json = z.toJSONSchema(z.object({ image_url: image().nullable() }));
		expect(inspectOutputUrlKinds(json).entries).toStrictEqual([
			{ path: "image_url", kind: "image", thumbnail: false },
		]);
	});

	it("leave plain string fields unannotated", () => {
		const props = properties(z.object({ image_url: z.string(), url: z.string().url() }));
		expect(props.image_url).toStrictEqual({ type: "string" });
		expect(props.url).not.toHaveProperty(APIFUSE_URL_KIND_META_KEY);
	});

	it("accept null and the values a constructor would publish", () => {
		const picture = image();
		expect(picture.safeParse("https://cdn.example.com/a.jpg?sig=Ab%2B1").success).toBe(true);
		expect(picture.safeParse(null).success).toBe(true);
		expect(picture.safeParse(undefined).success).toBe(false);
		expect(imageList().safeParse([null]).success).toBe(false);
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
		expect(link().safeParse("https://www.law.go.kr").success).toBe(true);
	});

	it("refuse a value whose host other URL parsers read differently", () => {
		for (const value of [
			"https://exam\tple.com/a.jpg",
			"https://cdn.example.com/a\n.jpg",
			"https://cdn.example.com/a\u0000.jpg",
			"https:///cdn.example.com/a.jpg",
			"https://cdn.example.com\\@evil.com/a.jpg",
			"https://cdn.ex%61mple.com/a.jpg",
			"https://cdn.example.com/a b.jpg",
		]) {
			expect(image().safeParse(value).success, JSON.stringify(value)).toBe(false);
		}
		expect(image().safeParse("HTTPS://CDN.Example.com/a.jpg").success).toBe(true);
	});
});

describe("isPublicUrlHost", () => {
	it("refuses literal addresses, local and single-label names, and non-ASCII hosts", () => {
		for (const host of ["cdn.example.com", "img_1.example.co.kr", "xn--r8jz45g.jp", "EXAMPLE.com."])
			expect(isPublicUrlHost(host), host).toBe(true);
		for (const host of [
			"",
			"10.0.0.1",
			"[::1]",
			"localhost",
			"localhost.",
			"printer.local",
			"metadata.internal.",
			"app.localhost",
			"router",
			"a.com,https",
			"例え.jp",
		])
			expect(isPublicUrlHost(host), host).toBe(false);
	});
});

describe("toImageUrl", () => {
	it("keeps an absolute https URL on a public host byte for byte", () => {
		const signed = "https://cdn.example.com/p/a.jpg?X-Amz-Signature=AbC%2Fd&x=1#frag";
		const { result, drops: recorded } = drops(() => toImageUrl(`  ${signed} `));
		expect(result).toBe(signed);
		expect(recorded).toStrictEqual([]);
	});

	it("publishes the serialization of the URL it checked", () => {
		const cases: Array<[string, string]> = [
			["https://exam\tple.com/a.jpg", "https://example.com/a.jpg"],
			["https://cdn.example.com\\@evil.com/a.jpg", "https://cdn.example.com/@evil.com/a.jpg"],
			["https:///cdn.example.com/a.jpg", "https://cdn.example.com/a.jpg"],
			["https://cdn.example.com/a\n.jpg", "https://cdn.example.com/a.jpg"],
			["https://cdn.example.com/a\u0000.jpg", "https://cdn.example.com/a%00.jpg"],
			["https://CDN.Example.com/a b.jpg", "https://cdn.example.com/a%20b.jpg"],
		];
		for (const [raw, published] of cases) {
			const url = toImageUrl(raw);
			expect(url, JSON.stringify(raw)).toBe(published as ImageUrl);
			expect(image().safeParse(url).success, published).toBe(true);
		}
	});

	it("takes URL instances like strings", () => {
		expect(toImageUrl(new URL("https://cdn.example.com/a.jpg"))).toBe(
			"https://cdn.example.com/a.jpg",
		);
		const { result, drops: recorded } = drops(() =>
			toImageUrl(new URL("http://img.example.com/a.jpg")),
		);
		expect(result).toBeNull();
		expect(recorded).toStrictEqual([
			{ kind: "image", reason: "insecure", value: "http://img.example.com/a.jpg" },
		]);
	});

	it("drops http and reports it, unless the host is declared in upgradeHttp", () => {
		const { result, drops: recorded } = drops(() =>
			toImageUrl("http://img.example.com/a.jpg?token=secret", { field: "items[].image_url" }),
		);
		expect(result).toBeNull();
		expect(recorded).toStrictEqual([
			{
				kind: "image",
				reason: "insecure",
				field: "items[].image_url",
				value: "http://img.example.com/a.jpg?token=secret",
			},
		]);
		expect(toImageUrl("HTTP://IMG.example.com/a.jpg", { upgradeHttp: ["img.example.com"] })).toBe(
			"https://img.example.com/a.jpg",
		);
	});

	it("upgrades only a declared host without a named port, compared in its ASCII form", () => {
		const upgradeHttp = ["IMG.Example.com.", "例え.jp"];
		expect(toImageUrl("http://img.example.com:80/a.jpg", { upgradeHttp })).toBe(
			"https://img.example.com/a.jpg",
		);
		expect(toImageUrl("http://例え.jp/a.jpg", { upgradeHttp })).toBe(
			"https://xn--r8jz45g.jp/a.jpg",
		);
		const { result, drops: recorded } = drops(() =>
			toImageUrl("http://img.example.com:8080/a.jpg", { upgradeHttp }),
		);
		expect(result).toBeNull();
		expect(recorded.map((drop) => drop.reason)).toStrictEqual(["insecure"]);
	});

	it("throws on an upgradeHttp entry that is not a host name, whatever the value", () => {
		for (const entry of ["http://img.example.com", "img.example.com/a", "img.example.com:8080", ""])
			expect(() => toImageUrl(null, { upgradeHttp: [entry] }), entry).toThrow(TypeError);
	});

	it("drops relative values without a base and resolves them with one", () => {
		const { result, drops: recorded } = drops(() => toImageUrl("/files/a.jpg"));
		expect(result).toBeNull();
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
			expect(result, String(raw)).toBeNull();
			expect(
				recorded.map((drop) => drop.reason),
				String(raw),
			).toStrictEqual([reason]);
		}
		for (const raw of [
			"https://user:secret@cdn.example.com/a.jpg",
			"ftp://user:secret@files.example.com/a.jpg",
			"https://user:secret@",
			"//user:secret@cdn.example.com/a.jpg",
		]) {
			const { drops: recorded } = drops(() => toImageUrl(raw));
			expect(recorded, raw).toHaveLength(1);
			expect(recorded[0], raw).not.toHaveProperty("value");
		}
	});

	it("reports what locates the defect, never a whole non-http payload", () => {
		const cases: Array<[unknown, string]> = [
			["mailto:hong.gildong@gmail.com", "mailto:"],
			["TEL:+82-10-1234-5678", "tel:"],
			["data:image/png;base64,AAAA", "data:"],
			[42, "[number]"],
			[{ src: "https://cdn.example.com/a.jpg" }, "[object]"],
			["/files/a.jpg", "/files/a.jpg"],
		];
		for (const [raw, value] of cases) {
			const { drops: recorded } = drops(() => toLinkUrl(raw));
			expect(
				recorded.map((drop) => drop.value),
				String(raw),
			).toStrictEqual([value]);
		}
	});

	it("returns null for a missing value without reporting a drop", () => {
		for (const raw of [undefined, null, "", "   "]) {
			const { result, drops: recorded } = drops(() => toImageUrl(raw));
			expect(result).toBeNull();
			expect(recorded).toStrictEqual([]);
		}
	});

	it("throws on a base that is not an absolute http(s) URL, whatever the value", () => {
		expect(() => toImageUrl("/a.jpg", { base: "cdn.example.com" })).toThrow(TypeError);
		expect(() => toImageUrl("/a.jpg", { base: "ftp://cdn.example.com" })).toThrow(TypeError);
		expect(() => toImageUrl(null, { base: "cdn.example.com" })).toThrow(TypeError);
		expect(() => toImageUrls([], { base: "cdn.example.com" })).toThrow(TypeError);
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
		expect(result).toBeNull();
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

	it("counts a value that is not an array as one left-out value", () => {
		const cases: Array<[unknown, string]> = [
			["https://cdn.example.com/1.jpg", "https://cdn.example.com/1.jpg"],
			[{ url: "https://cdn.example.com/1.jpg" }, "[object]"],
			[7, "[number]"],
		];
		for (const [raws, value] of cases) {
			const { result, drops: recorded } = drops(() =>
				// test-invalid: untyped upstream data (an XML list of one, an object) reaching a list constructor.
				toImageUrls(raws as readonly unknown[], { field: "items[].image_urls[]" }),
			);
			expect(result, String(value)).toStrictEqual([]);
			expect(recorded, String(value)).toStrictEqual([
				{ kind: "image", reason: "not_url", field: "items[].image_urls[]", value },
			]);
		}
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
		expect(result).toBeNull();
		expect(recorded).toStrictEqual([
			{ kind: "link", reason: "scheme", field: "contact_url", value: "mailto:" },
		]);
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
		expect(itemPageFrom("https://www.example.com/items/{id}", { id: null })).toBeNull();
		expect(itemPageFrom("https://www.example.com/items/{id}", { id: " " })).toBeNull();
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
			[DECLARATION_RULE_IDS.outputUrlKindUnique, "operations.search.output.items[]"],
			[DECLARATION_RULE_IDS.outputUrlKindUnique, "operations.search.output.items[]"],
		]);
		expect(found[0]?.message).toContain("detail_url, url");
		expect(found[1]?.message).toContain("image_url, photo_url");
	});

	it("count the properties of intersected objects together", () => {
		const output = z.object({
			items: z.array(
				z.intersection(
					z.object({ image_url: image(), url: itemPage() }),
					z.object({ photo_url: image(), thumbnail_url: image({ thumbnail: true }) }),
				),
			),
		});
		expect(
			violations(declaration({ search: operationWith(output) })).map((violation) => [
				violation.ruleId,
				violation.path,
				violation.message,
			]),
		).toStrictEqual([
			[
				DECLARATION_RULE_IDS.outputUrlKindUnique,
				"operations.search.output.items[]",
				"image_url, photo_url are all declared image(); an item has one main picture.",
			],
		]);
	});

	it("apply the same rules to SSE event schemas", () => {
		const photos = operationWith(z.object({ ok: z.boolean() }), {
			noMedia: noMedia("Upstream has no photos."),
			transport: {
				kind: "sse",
				events: {
					photo: z.object({ image_url: image(), photo_url: image(), source_url: link() }),
				},
			},
		});
		expect(
			violations(declaration({ photos })).map((violation) => [
				violation.ruleId,
				violation.path,
				violation.message,
			]),
		).toStrictEqual([
			[
				DECLARATION_RULE_IDS.outputUrlKindUnique,
				"operations.photos.transport.events.photo",
				"image_url, photo_url are all declared image(); an item has one main picture.",
			],
			[
				DECLARATION_RULE_IDS.noMediaContradiction,
				"operations.photos.noMedia",
				"noMedia is declared but the output has x-apifuse-url-kind fields transport.events.photo.image_url (image), transport.events.photo.photo_url (image).",
			],
		]);
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

	it("mark the log when recording a drop fails, and never fail the mapper", () => {
		const collector = new OutputUrlTelemetryCollector();
		const failing = {
			recordDrop(): void {
				throw new Error("sink down");
			},
			markTelemetryFailed: () => collector.markTelemetryFailed(),
		};
		const result = observeOutputUrlDrops(failing, () => toImageUrl("http://img.example.com/a.jpg"));
		expect(result).toBeNull();
		const spans = { spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 };
		const log = collector.toLogPayload(spans);
		expect(log).toStrictEqual({ telemetryFailed: true, outputUrlDropped: [] });
		expect(log && collector.toHeaderPayload(log)).toBeUndefined();
	});

	it("stay in the request log and out of the gateway telemetry header", () => {
		const telemetry = new RequestTelemetry(createTraceContext());
		const collector = new OutputUrlTelemetryCollector();
		telemetry.register(collector);
		observeOutputUrlDrops(collector, () => toLinkUrl("/a", { field: "source_url" }));
		expect(telemetry.toLogPayload()).toStrictEqual({
			events: {
				outputUrlDropped: [
					{ kind: "link", reason: "relative", field: "source_url", count: 1, example: "/a" },
				],
			},
		});
		expect(telemetry.toHeaderValue()).toBeUndefined();
	});

	it("observe drops made while a stream is pulled", async () => {
		const events: ProviderServerLogEvent[] = [];
		const app = createServerApp(
			declaration({
				photos: {
					riskClass: READ,
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					transport: {
						kind: "sse",
						events: { photo: z.object({ image_url: image() }) },
					},
					async *handler() {
						for (const raw of ["https://cdn.example.com/1.jpg", "http://img.example.com/2.jpg"]) {
							await Promise.resolve();
							yield event("photo", {
								image_url: toImageUrl(raw, { field: "photo.image_url" }),
							});
						}
					},
				},
			}),
			{ logger: (entry) => events.push(entry) },
		);
		const response = await app.request("/v1/photos", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req-sse", input: {} }),
		});
		const text = await response.text();
		expect(text).toContain('"image_url":"https://cdn.example.com/1.jpg"');
		expect(text).toContain('"image_url":null');
		expect(text).not.toContain("img.example.com");
		await new Promise((resolve) => setTimeout(resolve, 0));
		// test-invalid: contributor fields are not exposed on the shared log event type.
		const log = events.at(-1) as { events?: { outputUrlDropped: unknown[] } };
		expect(log.events?.outputUrlDropped).toStrictEqual([
			{
				kind: "image",
				reason: "insecure",
				field: "photo.image_url",
				count: 1,
				example: "http://img.example.com/2.jpg",
			},
		]);
	});

	it("reach the request log while the response carries null", async () => {
		const events: ProviderServerLogEvent[] = [];
		const app = createServerApp(
			declaration({
				search: {
					riskClass: READ,
					input: z.object({}),
					output: z.object({
						items: z.array(z.object({ name: z.string(), image_url: image() })),
					}),
					handler: async () => ({
						items: [null, "https://cdn.example.com/1.jpg", "http://img.example.com/2.jpg"].map(
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
			{ name: "item 0", image_url: null },
			{ name: "item 1", image_url: "https://cdn.example.com/1.jpg" },
			{ name: "item 2", image_url: null },
		]);
		expect(JSON.stringify(body)).not.toContain("outputUrl");
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

describe("output URL fields under the operation executor", () => {
	it("succeed with null for a missing and a left-out value in every field spelling", async () => {
		const Item = z.object({
			name: z.string(),
			image_url: image(),
			photo_url: image({ thumbnail: true }).nullable(),
			cover_url: image({ thumbnail: true }).optional(),
			url: itemPage(),
			source_url: link(),
		});
		// A fleet-style mapper: an untyped record, no per-row parse, no cast on values.
		const mapRow = (row: { name: string; img?: string | null; page?: string }) => ({
			name: row.name,
			image_url: toImageUrl(row.img, { field: "items[].image_url" }),
			photo_url: toImageUrl(row.img, { field: "items[].photo_url" }),
			cover_url: toImageUrl(row.img, { field: "items[].cover_url" }),
			url: toItemPageUrl(row.page, { field: "items[].url" }),
			source_url: toLinkUrl(row.page, { field: "items[].source_url" }),
		});
		const provider: ProviderDefinition = defineProvider({
			...declaration({}),
			operations: {
				search: {
					riskClass: READ,
					input: z.object({}),
					output: z.object({ items: z.array(Item) }),
					healthCheckUnsupported: { reason: "Unit test operation without an upstream." },
					handler: async () => ({
						items: [
							mapRow({
								name: "complete",
								img: "https://img.example.com/a.jpg",
								page: "https://shop.example.com/a",
							}),
							mapRow({ name: "missing" }),
							mapRow({ name: "left out", img: "http://img.example.com/b.jpg", page: "/b" }),
						],
					}),
				},
			},
		});
		const recorded: OutputUrlDrop[] = [];
		const output = await observeOutputUrlDrops({ recordDrop: (drop) => recorded.push(drop) }, () =>
			executeOperation(provider, "search", createProviderContextDouble(), {}),
		);
		const blank = {
			image_url: null,
			photo_url: null,
			cover_url: null,
			url: null,
			source_url: null,
		};
		expect(output).toStrictEqual({
			items: [
				{
					name: "complete",
					image_url: "https://img.example.com/a.jpg",
					photo_url: "https://img.example.com/a.jpg",
					cover_url: "https://img.example.com/a.jpg",
					url: "https://shop.example.com/a",
					source_url: "https://shop.example.com/a",
				},
				{ name: "missing", ...blank },
				{ name: "left out", ...blank },
			],
		});
		expect(recorded.map((drop) => [drop.field, drop.reason])).toStrictEqual([
			["items[].image_url", "insecure"],
			["items[].photo_url", "insecure"],
			["items[].cover_url", "insecure"],
			["items[].url", "relative"],
			["items[].source_url", "relative"],
		]);
	});

	it("fail output validation for a value forced past the constructor", async () => {
		const provider: ProviderDefinition = defineProvider({
			...declaration({}),
			operations: {
				search: {
					riskClass: READ,
					input: z.object({}),
					output: z.object({ image_url: image() }),
					healthCheckUnsupported: { reason: "Unit test operation without an upstream." },
					// test-invalid: a cast forces a raw http value past the ImageUrl type.
					handler: async () => ({ image_url: "http://img.example.com/a.jpg" as ImageUrl }),
				},
			},
		});
		await expect(
			executeOperation(provider, "search", createProviderContextDouble(), {}),
		).rejects.toMatchObject({ code: "OUTPUT_VALIDATION_FAILED" });
	});
});
