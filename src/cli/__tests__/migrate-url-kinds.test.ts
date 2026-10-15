import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { zodSchemaToJson } from "../../contract-serialization.js";
import { migrateUrlKindsRepository } from "../migrate-url-kinds.js";

const SDK_ROOT = dirname(dirname(dirname(import.meta.dir)));
// Each run builds a TypeScript program over the fixture and the SDK's types.
setDefaultTimeout(120_000);
const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

const SCHEMAS = `import { z } from "@apifuse/provider-sdk/provider";

export const SellerSchema = z.object({
  name: z.string(),
  url: z.string().nullable(),
  detail_url: z.string(),
});

const BaseItemSchema = z.object({
  name: z.string(),
  image_url: z.string().nullable(),
  url: z.string().url().nullish().describe("Item page"),
  thumbnail_url: z.string().optional(),
  source_path: z.string(),
});

export const ItemSchema = z.intersection(
  BaseItemSchema,
  z.object({ image_urls: z.array(z.string().url()), seller: SellerSchema }),
);

export const OutputSchema = z.object({
  items: z.array(ItemSchema),
  facets: z.array(z.object({ label: z.string(), image_url: z.string() })),
  banner: z.object({ image_url: z.string() }),
  photos: z.array(z.object({ url: z.string() })),
  badge: z.object({ image_url: z.string().regex(/^https:/) }),
});

export type Item = z.infer<typeof BaseItemSchema>;
`;

const MAPPER = `import { ItemSchema, type Item } from "./schemas";

export type Row = {
  title: string;
  img?: string | null;
  link?: string;
  thumb?: string;
  detail: string;
  source: string;
  gallery: string[];
  seller: { name: string; home?: string | null };
};

function mapItem(row: Row) {
  const image_url = row.img ?? null;
  return {
    name: row.title,
    image_url,
    url: row.link,
    ...(row.thumb ? { thumbnail_url: row.thumb } : {}),
    source_path: row.source,
    image_urls: row.gallery,
    seller: { name: row.seller.name, url: row.seller.home ?? null, detail_url: row.detail },
  };
}

export function mapOutput(rows: Row[]) {
  const photos: { url: string }[] = [];
  for (const row of rows) photos.push({ url: row.detail });
  return {
    items: rows.map(mapItem),
    facets: [],
    banner: { image_url: "http://img.example.com/banner.jpg" },
    photos,
    badge: { image_url: "https://img.example.com/badge.png" },
  };
}

// Reached only through the schema it validates against.
export function strictItem(row: Row) {
  return ItemSchema.parse({ ...mapItem(row), image_url: row.img });
}

// Neither reached from the handler nor validated: the type check reports it.
export function typedItem(row: Row): Item {
  const item = { name: row.title, image_url: row.img ?? null, url: null, source_path: "" };
  return item;
}
`;

const INDEX = `import { OutputSchema } from "./schemas";
import { mapOutput, type Row } from "./mapper";

const recorded = {
  name: "Kettle",
  image_url: "https://cdn.example.com/kettle.jpg",
  url: "https://shop.example.com/p/1",
  thumbnail_url: "https://cdn.example.com/kettle-s.jpg",
  source_path: "/catalog/1",
  image_urls: ["https://cdn.example.com/kettle-1.jpg"],
  seller: {
    name: "Shop",
    url: "https://shop.example.com/s/9",
    detail_url: "https://shop.example.com/s/9/about",
  },
};

export const searchOperation = {
  upstream: { baseUrl: "https://api.example.com/v1" },
  output: OutputSchema,
  handler: async (_ctx: unknown, input: { rows: Row[] }) => mapOutput(input.rows),
  fixtures: {
    request: { rows: [] },
    response: {
      items: [recorded, { ...recorded, image_url: null }],
      facets: [],
      banner: { image_url: "http://img.example.com/banner.jpg" },
      photos: [{ url: "https://cdn.example.com/photo.jpg" }],
      badge: { image_url: "https://img.example.com/badge.png" },
    },
  },
};
`;

const DEFAULT_FILES: Readonly<Record<string, string>> = {
	"schemas.ts": SCHEMAS,
	"mapper.ts": MAPPER,
	"index.ts": INDEX,
};

/**
 * `sdk`: `link` installs this SDK checkout, `none` installs nothing, an
 * object installs a fake older SDK whose entry points declare only `z`.
 */
function writeFixtureRepository(
	files: Readonly<Record<string, string>> = DEFAULT_FILES,
	sdk: "link" | "none" | { readonly version: string } = "link",
): string {
	const dir = mkdtempSync(join(tmpdir(), "apifuse-migrate-url-kinds-"));
	tempDirs.push(dir);
	const sdkDir = join(dir, "node_modules", "@apifuse", "provider-sdk");
	if (sdk === "link") {
		mkdirSync(join(dir, "node_modules", "@apifuse"), { recursive: true });
		symlinkSync(SDK_ROOT, sdkDir, "dir");
	} else if (sdk !== "none") {
		mkdirSync(sdkDir, { recursive: true });
		writeFileSync(
			join(sdkDir, "package.json"),
			JSON.stringify({
				name: "@apifuse/provider-sdk",
				version: sdk.version,
				type: "module",
				exports: {
					".": { types: "./index.d.ts" },
					"./provider": { types: "./provider.d.ts" },
				},
			}),
		);
		writeFileSync(join(sdkDir, "index.d.ts"), "export declare const z: any;\n");
		writeFileSync(join(sdkDir, "provider.d.ts"), "export declare const z: any;\n");
	}
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "Bundler",
				strict: true,
				skipLibCheck: true,
				noEmit: true,
			},
			include: ["**/*.ts"],
		}),
	);
	for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
	return dir;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The URL-kind-neutral form: annotations removed, and the annotated node's `format` unless kept. */
function neutral(value: JsonValue, keepFormat: boolean): JsonValue {
	if (Array.isArray(value)) return value.map((item) => neutral(item, keepFormat));
	if (value === null || typeof value !== "object") return value;
	const annotated = typeof value["x-apifuse-url-kind"] === "string";
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([key]) =>
					key !== "x-apifuse-url-kind" &&
					key !== "x-apifuse-image-role" &&
					!(annotated && !keepFormat && key === "format"),
			)
			.map(([key, child]) => [key, neutral(child, keepFormat)]),
	);
}

async function outputJson(dir: string, file: string): Promise<Record<string, JsonValue>> {
	const module = (await import(join(dir, file))) as { OutputSchema: unknown };
	return zodSchemaToJson(module.OutputSchema) as Record<string, JsonValue>;
}

function property(schema: JsonValue, ...path: string[]): JsonValue {
	let current: JsonValue = schema;
	for (const key of path) {
		if (Array.isArray(current)) current = current[Number(key)] as JsonValue;
		else if (current !== null && typeof current === "object") current = current[key] as JsonValue;
		else throw new Error(`no ${key}`);
		if (current === undefined) throw new Error(`no ${key}`);
	}
	return current;
}

describe("apifuse migrate-url-kinds", () => {
	it("declares fleet-named fields, wraps the traced mapper sites and marks other URLs", () => {
		const dir = writeFixtureRepository();
		const result = migrateUrlKindsRepository(dir);
		const schemas = readFileSync(join(dir, "schemas.ts"), "utf8");
		const mapper = readFileSync(join(dir, "mapper.ts"), "utf8");

		expect(result.status).toBe("migrated");
		expect(result.operations).toBe(1);
		expect(result.changedFiles).toEqual(["mapper.ts", "schemas.ts"]);

		expect(schemas).toContain(
			'import { z, image, imageList, itemPage } from "@apifuse/provider-sdk/provider";',
		);
		// a seller's page is not the item's: marked, and so is the other URL beside it
		expect(schemas).toContain(
			"  // TODO(url-kind): not proven to be the item's own page (fixture https://shop.example.com/…; it sits under seller, which names other pages than the item; detail_url beside it also holds a page URL); declare itemPage() if it is, otherwise link().\n  url: z.string().nullable(),",
		);
		expect(schemas).toContain("  image_url: image(),");
		// .nullish() becomes .optional(), .url() dropped, .describe() kept
		expect(schemas).toContain('  url: itemPage().optional().describe("Item page"),');
		expect(schemas).toContain("  thumbnail_url: image({ thumbnail: true }).optional(),");
		// list inside the intersection's second branch
		expect(schemas).toContain("z.object({ image_urls: imageList(), seller: SellerSchema })");
		// other name with absolute fixture values: a marker, not a rewrite
		expect(schemas).toContain(
			"  // TODO(url-kind): absolute URL (fixture https://shop.example.com/…); declare itemPage()",
		);
		expect(schemas).toContain("  detail_url: z.string(),\n});");
		// a relative fixture value is no URL evidence
		expect(schemas).toContain("  source_path: z.string(),");

		expect(
			result.rewrites.map((item) => `${item.property}@${item.paths.join("|")} -> ${item.after}`),
		).toEqual([
			"image_url@items[].image_url -> image()",
			'url@items[].url -> itemPage().optional().describe("Item page")',
			"thumbnail_url@items[].thumbnail_url -> image({ thumbnail: true }).optional()",
			"image_urls@items[].image_urls -> imageList()",
		]);
		expect(
			result.todos.map((item) => `${item.property}@${item.paths.join("|")} ${item.reason}`),
		).toEqual([
			"url@items[].seller.url item_page_unproven",
			"detail_url@items[].seller.detail_url other_name",
		]);
		expect(
			result.skipped.map((item) => `${item.property}@${item.paths.join("|")} ${item.reason}`),
		).toEqual([
			"image_url@facets[].image_url no_url_evidence",
			"image_url@banner.image_url insecure_image_fixture",
			"url@photos[].url kind_ambiguous",
			"image_url@badge.image_url unsupported_chain",
		]);

		expect(mapper).toContain(
			'import { ItemSchema, type Item } from "./schemas";\nimport { toImageUrl, toImageUrls, toItemPageUrl } from "@apifuse/provider-sdk";',
		);
		expect(mapper).toContain(
			'    image_url: toImageUrl(image_url, { field: "items[].image_url" }),',
		);
		expect(mapper).toContain('    url: toItemPageUrl(row.link, { field: "items[].url" }),');
		expect(mapper).toContain(
			'...(row.thumb ? { thumbnail_url: toImageUrl(row.thumb, { field: "items[].thumbnail_url" }) } : {}),',
		);
		expect(mapper).toContain(
			'    image_urls: toImageUrls(row.gallery, { field: "items[].image_urls" }),',
		);
		expect(mapper).toContain(
			"seller: { name: row.seller.name, url: row.seller.home ?? null, detail_url: row.detail },",
		);
		// the parse anchor
		expect(mapper).toContain(
			'return ItemSchema.parse({ ...mapItem(row), image_url: toImageUrl(row.img, { field: "items[].image_url" }) });',
		);
		// literals and undeclared fields stay
		expect(mapper).toContain('banner: { image_url: "http://img.example.com/banner.jpg" },');
		expect(mapper).toContain("for (const row of rows) photos.push({ url: row.detail });");
		// the untraced typed mapper is reported, not guessed
		expect(result.residualCheck).toBe("ran");
		expect(result.sdk.status).toBe("ok");
		expect(result.residual).toEqual([
			expect.objectContaining({
				file: "mapper.ts",
				code: 2322,
				message: expect.stringContaining("ImageUrl"),
			}),
		]);
		expect(mapper).toContain("image_url: row.img ?? null, url: null");
	});

	it("is idempotent", () => {
		const dir = writeFixtureRepository();
		migrateUrlKindsRepository(dir, { typecheck: false });
		const first = ["schemas.ts", "mapper.ts", "index.ts"].map((file) =>
			readFileSync(join(dir, file), "utf8"),
		);
		const second = migrateUrlKindsRepository(dir, { typecheck: false });
		expect(second.status).toBe("unchanged");
		expect(second.changedFiles).toEqual([]);
		expect(second.rewrites).toEqual([]);
		expect(second.mapperWraps).toEqual([]);
		expect(second.todos).toEqual([]);
		expect(
			["schemas.ts", "mapper.ts", "index.ts"].map((file) => readFileSync(join(dir, file), "utf8")),
		).toEqual(first);
	});

	it("writes nothing with --check", () => {
		const dir = writeFixtureRepository();
		const result = migrateUrlKindsRepository(dir, { check: true, typecheck: false });
		expect(result.status).toBe("would-migrate");
		expect(result.residualCheck).toBe("skipped");
		expect(readFileSync(join(dir, "schemas.ts"), "utf8")).toBe(SCHEMAS);
		expect(readFileSync(join(dir, "mapper.ts"), "utf8")).toBe(MAPPER);
	});

	it("keeps the URL-kind-neutral schema of a .nullable() and a .url().nullish() field", async () => {
		const dir = writeFixtureRepository();
		copyFileSync(join(dir, "schemas.ts"), join(dir, "schemas.before.ts"));
		migrateUrlKindsRepository(dir, { typecheck: false });
		copyFileSync(join(dir, "schemas.ts"), join(dir, "schemas.after.ts"));
		const before = await outputJson(dir, "schemas.before.ts");
		const after = await outputJson(dir, "schemas.after.ts");
		const item = (schema: JsonValue) => property(schema, "properties", "items", "items", "allOf");
		const base = (schema: JsonValue) => property(item(schema), "0", "properties");
		const extra = (schema: JsonValue) => property(item(schema), "1", "properties");

		// z.string().nullable() -> image(): equal with the annotated node's format removed
		expect(neutral(property(base(after), "image_url"), false)).toEqual(
			property(base(before), "image_url"),
		);
		expect(property(extra(after), "seller")).toEqual(property(extra(before), "seller"));
		// z.string().url().nullish() -> itemPage().optional() and z.array(z.string().url()) -> imageList(): equal with format kept
		expect(neutral(property(base(after), "url"), true)).toEqual(property(base(before), "url"));
		expect(neutral(property(extra(after), "image_urls"), true)).toEqual(
			property(extra(before), "image_urls"),
		);
		// z.string().optional() -> image().optional() widens the field to admit null
		expect(neutral(property(base(after), "thumbnail_url"), false)).not.toEqual(
			property(base(before), "thumbnail_url"),
		);
		expect(
			property(after, "properties", "items", "items", "allOf", "0", "properties", "image_url"),
		).toEqual({
			anyOf: [{ type: "string", format: "uri", "x-apifuse-url-kind": "image" }, { type: "null" }],
		});
	});

	it("rewrites describeKey(...) wrappers and leaves a shared schema constant to the author", () => {
		const dir = writeFixtureRepository();
		writeFileSync(
			join(dir, "schemas.ts"),
			`import { describeKey, z } from "@apifuse/provider-sdk/provider";

const PageUrlSchema = z.string().url();

export const OutputSchema = z.object({
  items: z.array(
    z.object({
      image_url: describeKey(z.string().url().nullable(), "fields.image_url"),
      url: PageUrlSchema,
    }),
  ),
});
`,
		);
		writeFileSync(
			join(dir, "mapper.ts"),
			"export type Row = Record<string, never>;\nexport function mapOutput(_rows: Row[]) { return { items: [] }; }\n",
		);
		writeFileSync(
			join(dir, "index.ts"),
			`import { OutputSchema } from "./schemas";
import { mapOutput, type Row } from "./mapper";

export const op = {
  output: OutputSchema,
  handler: async (_ctx: unknown, input: { rows: Row[] }) => mapOutput(input.rows),
  fixtures: {
    request: {},
    response: OutputSchema.parse({
      items: [{ image_url: "https://cdn.example.com/a.jpg", url: "https://shop.example.com/p/1" }],
    }),
  },
};
`,
		);
		const result = migrateUrlKindsRepository(dir, { typecheck: false });
		const schemas = readFileSync(join(dir, "schemas.ts"), "utf8");
		expect(schemas).toContain('image_url: describeKey(image(), "fields.image_url"),');
		expect(result.skipped).toEqual([
			expect.objectContaining({
				property: "url",
				reason: "shared_schema",
				detail: expect.stringContaining("PageUrlSchema"),
			}),
		]);
	});

	it("refuses a fleet name whose fixture value is not an absolute URL", () => {
		const dir = writeFixtureRepository();
		writeFileSync(
			join(dir, "index.ts"),
			INDEX.replace(
				'image_url: "https://cdn.example.com/kettle.jpg"',
				'image_url: "/files/kettle.jpg"',
			),
		);
		const result = migrateUrlKindsRepository(dir, { check: true, typecheck: false });
		expect(result.skipped).toContainEqual(
			expect.objectContaining({
				property: "image_url",
				paths: ["items[].image_url"],
				reason: "non_url_fixture_value",
				detail: expect.stringContaining('"/files/kettle.jpg"'),
			}),
		);
		expect(result.rewrites.map((item) => item.property)).not.toContain("image_url");
	});

	it("leaves mapper inputs, blank or null-item fixtures, item metadata alone and reads record paths", () => {
		const dir = writeFixtureRepository({
			"schemas.ts": `import { describeKey, z } from "@apifuse/provider-sdk/provider";

export const OutputSchema = z.object({
  item: z.object({ image_url: z.string() }),
  blank: z.object({ image_url: z.string() }),
  nullable_items: z.object({ image_urls: z.array(z.string().nullable()) }),
  described_items: z.object({ image_urls: z.array(describeKey(z.string().url(), "fields.image")) }),
  by_id: z.record(z.string(), z.object({ name: z.string(), url: z.string() })),
  external: z.object({ image_url: z.string() }),
  external_ref: z.object({ image_url: z.string() }),
  gallery: z.array(z.object({ image_url: z.string() })),
});
`,
			"mapper.ts": `declare function externalResolve<T>(value: T): T;

export function resolveImage(input: { image_url: string }) {
  return { image_url: new URL(input.image_url, "https://cdn.example.com").href };
}

export function mapOutput(path: string) {
  const raw = { image_url: path };
  return {
    item: resolveImage({ image_url: path }),
    blank: { image_url: path },
    nullable_items: { image_urls: [path] },
    described_items: { image_urls: [path] },
    by_id: { first: { name: path, url: path } },
    external: externalResolve({ image_url: path }),
    external_ref: externalResolve(raw),
    gallery: Array.from([path], (src) => ({ image_url: src })),
  };
}
`,
			"index.ts": `import { OutputSchema } from "./schemas";
import { mapOutput } from "./mapper";

export const op = {
  upstream: { baseUrl: "https://api.example.com" },
  output: OutputSchema,
  handler: async (_ctx: unknown, input: { path: string }) => mapOutput(input.path),
  fixtures: {
    request: { path: "/a.jpg" },
    response: {
      item: { image_url: "https://cdn.example.com/a.jpg" },
      blank: { image_url: "" },
      nullable_items: { image_urls: ["https://cdn.example.com/a.jpg", null] },
      described_items: { image_urls: ["https://cdn.example.com/a.jpg"] },
      by_id: { first: { name: "First", url: "https://shop.example.com/p/1" } },
      external: { image_url: "https://cdn.example.com/b.jpg" },
      external_ref: { image_url: "https://cdn.example.com/c.jpg" },
      gallery: [{ image_url: "https://cdn.example.com/d.jpg" }],
    },
  },
};
`,
		});
		const result = migrateUrlKindsRepository(dir, { typecheck: false });
		const mapper = readFileSync(join(dir, "mapper.ts"), "utf8");

		expect(result.rewrites.map((item) => `${item.paths.join("|")} -> ${item.after}`)).toEqual([
			"item.image_url -> image()",
			"by_id.*.url -> itemPage()",
			"external.image_url -> image()",
			"external_ref.image_url -> image()",
			"gallery[].image_url -> image()",
		]);
		// the mapper's own return is wrapped, the input it resolves is not
		expect(mapper).toContain(
			'return { image_url: toImageUrl(new URL(input.image_url, "https://cdn.example.com").href, { field: "item.image_url" }) };',
		);
		expect(mapper).toContain("item: resolveImage({ image_url: path }),");
		// an unknown function's arguments are its inputs
		expect(mapper).toContain("external: externalResolve({ image_url: path }),");
		expect(mapper).toContain("const raw = { image_url: path };");
		expect(mapper).toContain(
			'gallery: Array.from([path], (src) => ({ image_url: toImageUrl(src, { field: "gallery[].image_url" }) })),',
		);
		expect(mapper).toContain(
			'by_id: { first: { name: path, url: toItemPageUrl(path, { field: "by_id.*.url" }) } },',
		);
		expect(result.skipped.map((item) => `${item.paths.join("|")} ${item.reason}`)).toEqual([
			"blank.image_url non_url_fixture_value",
			"nullable_items.image_urls unsupported_chain",
			"described_items.image_urls unsupported_chain",
		]);
	});
});

const URL_EVIDENCE_SCHEMAS = `import { z } from "@apifuse/provider-sdk/provider";

export const OutputSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string(),
      seller: z.object({ id: z.string(), name: z.string(), url: z.string() }),
    }),
  ),
  booking_links: z.array(z.object({ name: z.string(), url: z.string() })),
  related_links: z.array(z.object({ title: z.string(), url: z.string() })),
  nav_items: z.array(z.object({ title: z.string(), url: z.string() })),
  products: z.array(z.object({ name: z.string(), url: z.string(), product_url: z.string() })),
  tags: z.array(z.object({ url: z.string() })),
  articles: z.array(z.object({ title: z.string(), url: z.string() })),
});
`;

const URL_EVIDENCE_INDEX = `import { OutputSchema } from "./schemas";

const SHOP_HOST = "api.shop.example.co.jp";

export const provider = { allowedHosts: [SHOP_HOST] };

type Row = { id: string; title: string; link: string; seller: { id: string; name: string; url: string } };

export const op = {
  output: OutputSchema,
  handler: async (_ctx: unknown, input: { rows: Row[] }) => ({
    items: input.rows.map((row) => ({ id: row.id, title: row.title, url: row.link, seller: row.seller })),
    booking_links: [],
    related_links: [],
    nav_items: [],
    products: [],
    tags: [],
    articles: [],
  }),
  fixtures: {
    request: { rows: [] },
    response: {
      items: [
        {
          id: "1",
          title: "Kettle",
          url: "https://item.shop.example.co.jp/p/1",
          seller: { id: "s9", name: "Shop", url: "https://item.shop.example.co.jp/s/9" },
        },
      ],
      booking_links: [{ name: "Tickets", url: "https://tickets.example.net/e/1" }],
      related_links: [{ title: "More", url: "https://item.shop.example.co.jp/r/2" }],
      nav_items: [{ title: "Home", url: "https://item.shop.example.co.jp/" }],
      products: [
        {
          name: "Kettle",
          url: "https://item.shop.example.co.jp/p/1",
          product_url: "https://item.shop.example.co.jp/p/1/detail",
        },
      ],
      tags: [{ url: "https://item.shop.example.co.jp/t/x" }],
      articles: [{ title: "News", url: "https://news.example.org/a/1" }],
    },
  },
};
`;

describe("apifuse migrate-url-kinds: url needs evidence beyond its name", () => {
	it("declares itemPage() only for an identified item on an upstream site and marks the rest", () => {
		const dir = writeFixtureRepository({
			"schemas.ts": URL_EVIDENCE_SCHEMAS,
			"index.ts": URL_EVIDENCE_INDEX,
		});
		const result = migrateUrlKindsRepository(dir, { typecheck: false });
		const schemas = readFileSync(join(dir, "schemas.ts"), "utf8");
		const index = readFileSync(join(dir, "index.ts"), "utf8");

		expect(result.rewrites.map((item) => `${item.paths.join("|")} -> ${item.after}`)).toEqual([
			"items[].url -> itemPage()",
		]);
		expect(index).toContain('url: toItemPageUrl(row.link, { field: "items[].url" })');
		expect(
			result.todos.map((item) => `${item.paths.join("|")} ${item.reason}: ${item.detail ?? ""}`),
		).toEqual([
			"items[].seller.url item_page_unproven: it sits under seller, which names other pages than the item",
			"booking_links[].url item_page_unproven: it sits under booking_links, which names other pages than the item; fixture host tickets.example.net is not on an upstream site (example.co.jp)",
			"related_links[].url item_page_unproven: it sits under related_links, which names other pages than the item",
			"nav_items[].url item_page_unproven: it sits under nav_items, which names other pages than the item",
			"products[].url item_page_unproven: product_url beside it also holds a page URL",
			"products[].product_url other_name: ",
			"tags[].url item_page_unproven: no id/name/title field beside it identifies an item",
			"articles[].url item_page_unproven: fixture host news.example.org is not on an upstream site (example.co.jp)",
		]);
		// the marker carries the doubt into the source
		expect(schemas).toContain(
			"booking_links: z.array(z.object({ name: z.string(), /* TODO(url-kind): not proven to be the item's own page (fixture https://tickets.example.net/…; it sits under booking_links",
		);
		expect(schemas).toContain(
			"seller: z.object({ id: z.string(), name: z.string(), /* TODO(url-kind): not proven to be the item's own page (fixture https://item.shop.example.co.jp/…; it sits under seller, which names other pages than the item); declare itemPage() if it is, otherwise link(). */ url: z.string() }),",
		);

		const second = migrateUrlKindsRepository(dir, { typecheck: false });
		expect(second.status).toBe("unchanged");
		expect(second.todos).toEqual([]);
		expect(readFileSync(join(dir, "schemas.ts"), "utf8")).toBe(schemas);
	});

	it("marks url when the provider declares no upstream host to compare", () => {
		const dir = writeFixtureRepository({
			"schemas.ts": URL_EVIDENCE_SCHEMAS,
			"index.ts": URL_EVIDENCE_INDEX.replace(
				"export const provider = { allowedHosts: [SHOP_HOST] };",
				"export const host = SHOP_HOST;",
			),
		});
		const result = migrateUrlKindsRepository(dir, { check: true, typecheck: false });
		expect(result.rewrites).toEqual([]);
		expect(result.todos.find((item) => item.paths[0] === "items[].url")?.detail).toBe(
			"the provider declares no upstream host (allowedHosts, upstream.baseUrl) to compare",
		);
	});
});

describe("apifuse migrate-url-kinds: http pictures elsewhere", () => {
	it("notes a picture host that serves http:// in another operation's fixture", () => {
		const dir = writeFixtureRepository({
			"index.ts": `import { z } from "@apifuse/provider-sdk/provider";

export const search = {
  output: z.object({ items: z.array(z.object({ name: z.string(), image_url: z.string() })) }),
  handler: async () => ({ items: [] }),
  fixtures: {
    request: {},
    response: { items: [{ name: "a", image_url: "https://tong.example.com/a.jpg" }] },
  },
};

export const detail = {
  output: z.object({ name: z.string(), cover: z.string() }),
  handler: async () => ({ name: "", cover: "" }),
  fixtures: {
    request: {},
    response: { name: "a", cover: "http://tong.example.com/b.jpg" },
  },
};
`,
		});
		const result = migrateUrlKindsRepository(dir, { check: true, typecheck: false });
		expect(result.rewrites).toEqual([
			expect.objectContaining({
				paths: ["items[].image_url"],
				after: "image()",
				notes: [
					'tong.example.com serves both schemes (http:// in fixture detail:cover); add upgradeHttp: ["tong.example.com"] to the constructor once it is measured to serve the same path over https, or those values become null.',
				],
			}),
		]);
	});
});

describe("apifuse migrate-url-kinds: SDK precondition", () => {
	it("refuses to write against an SDK without the helpers and does not report its module errors as untraced values", () => {
		const dir = writeFixtureRepository(DEFAULT_FILES, { version: "2.2.0-beta.60" });
		const written = migrateUrlKindsRepository(dir);
		expect(written.status).toBe("refused");
		expect(written.sdk).toEqual(
			expect.objectContaining({ status: "outdated", version: "2.2.0-beta.60" }),
		);
		expect(written.reason).toContain(
			"@apifuse/provider-sdk 2.2.0-beta.60 does not export toImageUrl (@apifuse/provider-sdk), toImageUrls (@apifuse/provider-sdk), toItemPageUrl (@apifuse/provider-sdk), image (@apifuse/provider-sdk/provider)",
		);
		expect(written.reason).toContain("Nothing was written");
		expect(written.residualCheck).toBe("unresolved");
		expect(written.residual).toEqual([]);
		// the plan is still shown
		expect(written.rewrites.length).toBeGreaterThan(0);
		expect(readFileSync(join(dir, "schemas.ts"), "utf8")).toBe(SCHEMAS);
		expect(readFileSync(join(dir, "mapper.ts"), "utf8")).toBe(MAPPER);

		const preview = migrateUrlKindsRepository(dir, { check: true });
		expect(preview.status).toBe("would-migrate");
		expect(preview.residualCheck).toBe("unresolved");
		expect(preview.residual).toEqual([]);
	});

	it("says the SDK is not installed instead of type-checking against nothing", () => {
		const dir = writeFixtureRepository(DEFAULT_FILES, "none");
		const result = migrateUrlKindsRepository(dir, { check: true });
		expect(result.sdk.status).toBe("missing");
		expect(result.sdk.detail).toContain("does not resolve");
		expect(result.sdk.detail).toContain("bun install");
		expect(result.residualCheck).toBe("unresolved");
		expect(migrateUrlKindsRepository(dir).status).toBe("refused");
		expect(readFileSync(join(dir, "schemas.ts"), "utf8")).toBe(SCHEMAS);
	});
});

describe("apifuse migrate-url-kinds: refusals", () => {
	it("refuses a path that is not a provider repository", () => {
		const empty = mkdtempSync(join(tmpdir(), "apifuse-migrate-url-kinds-empty-"));
		tempDirs.push(empty);
		expect(migrateUrlKindsRepository(empty)).toEqual(
			expect.objectContaining({ status: "refused", reason: expect.stringContaining("index.ts") }),
		);
		expect(migrateUrlKindsRepository(join(empty, "missing")).status).toBe("refused");

		const noOperations = writeFixtureRepository({ "index.ts": "export const x = 1;\n" });
		expect(migrateUrlKindsRepository(noOperations)).toEqual(
			expect.objectContaining({
				status: "refused",
				reason: expect.stringContaining("declares no operation"),
			}),
		);

		const brokenConfig = writeFixtureRepository();
		writeFileSync(join(brokenConfig, "tsconfig.json"), '{ "compilerOptions": { "strict": true ');
		expect(migrateUrlKindsRepository(brokenConfig)).toEqual(
			expect.objectContaining({
				status: "refused",
				reason: expect.stringContaining("tsconfig.json"),
			}),
		);
		expect(readFileSync(join(brokenConfig, "schemas.ts"), "utf8")).toBe(SCHEMAS);
	});
});

describe("apifuse migrate-url-kinds: value walk and skip reasons", () => {
	it("traces Array.of/Array.from projections, element picks, flatMap, a method handler and a projected local", () => {
		const dir = writeFixtureRepository({
			"schemas.ts": `import { z } from "@apifuse/provider-sdk/provider";
import { CollidingSchema } from "./colliding";

const picture = () => z.object({ image_url: z.string() });

export const OutputSchema = z.object({
  of_entry: z.object({ image_url: z.string() }),
  from_entry: z.object({ image_url: z.string() }),
  first: z.object({ image_url: z.string() }),
  last: z.object({ image_url: z.string() }),
  found: z.object({ image_url: z.string() }),
  flat: z.array(z.object({ image_url: z.string() })),
  picked: picture(),
  wrong_list: z.object({ image_urls: z.string() }),
  local: z.object({ image_url: z.string() }),
  colliding: CollidingSchema,
});
`,
			"colliding.ts": `import { z } from "@apifuse/provider-sdk/provider";

const image = "local";

export const CollidingSchema = z.object({ image_url: z.string(), label: z.literal(image) });
`,
			"index.ts": `import { OutputSchema } from "./schemas";

const PIC = "https://cdn.example.com/a.jpg";

export const op = {
  output: OutputSchema,
  async handler(_ctx: unknown, input: { rows: string[]; nested: string[][] }) {
    const result = { item: { image_url: input.rows[0] ?? "" } };
    return {
      of_entry: Array.of({ entry: { image_url: input.rows[0] } })[0].entry,
      from_entry: Array.from(input.rows, (src) => ({ entry: { image_url: src } }))[0].entry,
      first: input.rows.map((src) => ({ image_url: src }))[0],
      last: input.rows.map((src) => ({ image_url: src })).at(-1),
      found: input.rows.map((src) => ({ image_url: src })).find(Boolean),
      flat: input.nested.flatMap((group) => group.map((src) => ({ image_url: src }))),
      picked: result.item,
      wrong_list: { image_urls: input.rows[0] },
      local: { image_url: input.rows[0] },
      colliding: { image_url: input.rows[0], label: "local" },
    };
  },
  fixtures: {
    request: { rows: [], nested: [] },
    response: {
      of_entry: { image_url: PIC },
      from_entry: { image_url: PIC },
      first: { image_url: PIC },
      last: { image_url: PIC },
      found: { image_url: PIC },
      flat: [{ image_url: PIC }],
      picked: { image_url: PIC },
      wrong_list: { image_urls: PIC },
      local: { image_url: "https://intranet.local/a.jpg" },
      colliding: { image_url: PIC, label: "local" },
    },
  },
};
`,
		});
		const result = migrateUrlKindsRepository(dir, { typecheck: false });
		const index = readFileSync(join(dir, "index.ts"), "utf8");
		const wrap = (label: string, value: string) =>
			`image_url: toImageUrl(${value}, { field: "${label}" })`;

		expect(index).toContain(
			`of_entry: Array.of({ entry: { ${wrap("of_entry.image_url", "input.rows[0]")} } })[0].entry,`,
		);
		expect(index).toContain(
			`from_entry: Array.from(input.rows, (src) => ({ entry: { ${wrap("from_entry.image_url", "src")} } }))[0].entry,`,
		);
		expect(index).toContain(
			`first: input.rows.map((src) => ({ ${wrap("first.image_url", "src")} }))[0],`,
		);
		expect(index).toContain(
			`last: input.rows.map((src) => ({ ${wrap("last.image_url", "src")} })).at(-1),`,
		);
		expect(index).toContain(
			`found: input.rows.map((src) => ({ ${wrap("found.image_url", "src")} })).find(Boolean),`,
		);
		expect(index).toContain(
			`flat: input.nested.flatMap((group) => group.map((src) => ({ ${wrap("flat[].image_url", "src")} }))),`,
		);
		expect(index).toContain(
			`const result = { item: { ${wrap("picked.image_url", 'input.rows[0] ?? ""')} } };`,
		);
		// left alone: not declared with a helper
		expect(index).toContain("wrong_list: { image_urls: input.rows[0] },");
		expect(index).toContain("local: { image_url: input.rows[0] },");
		expect(index).toContain('colliding: { image_url: input.rows[0], label: "local" },');

		expect(
			result.skipped.map((item) => `${item.file} ${item.paths.join("|")} ${item.reason}`),
		).toEqual([
			"colliding.ts colliding.image_url name_collision",
			"schemas.ts wrong_list.image_urls shape_mismatch",
			"schemas.ts local.image_url unpublishable_fixture_value",
		]);
	});
});

describe("apifuse migrate-url-kinds: pick, omit and redeclared keys", () => {
	it("leaves a declaration alone that .omit()/.pick() removed or .extend()/.merge()/a later key replaced", () => {
		const dir = writeFixtureRepository({
			"schemas.ts": `import { z } from "@apifuse/provider-sdk/provider";

// Another contract's shape too: no output below holds its image_url.
export const Base = z.object({ name: z.string(), image_url: z.string() });

export const OutputSchema = z.object({
  omitted: Base.omit({ image_url: true }).extend({ image_url: z.string().describe("omitted") }),
  picked: Base.pick({ name: true }).extend({ image_url: z.string().describe("picked") }),
  extended: Base.extend({ image_url: z.string().describe("extended") }),
  merged: Base.merge(z.object({ image_url: z.string().describe("merged") })),
  spread: z.object({ ...Base.shape, image_url: z.string().describe("spread") }),
});
`,
			"index.ts": `import { OutputSchema } from "./schemas";

const card = { name: "a", image_url: "https://cdn.example.com/a.jpg" };

export const op = {
  output: OutputSchema,
  handler: async (_ctx: unknown, input: { img: string }) => ({
    omitted: { name: "a", image_url: input.img },
    picked: { name: "a", image_url: input.img },
    extended: { name: "a", image_url: input.img },
    merged: { name: "a", image_url: input.img },
    spread: { name: "a", image_url: input.img },
  }),
  fixtures: {
    request: { img: "" },
    response: { omitted: card, picked: card, extended: card, merged: card, spread: card },
  },
};
`,
		});
		const result = migrateUrlKindsRepository(dir, { typecheck: false });
		const schemas = readFileSync(join(dir, "schemas.ts"), "utf8");
		const index = readFileSync(join(dir, "index.ts"), "utf8");

		expect(schemas).toContain(
			"export const Base = z.object({ name: z.string(), image_url: z.string() });",
		);
		expect(
			result.rewrites.map((item) => `${item.line} ${item.paths.join("|")} -> ${item.after}`),
		).toEqual([
			'7 omitted.image_url -> image().describe("omitted")',
			'8 picked.image_url -> image().describe("picked")',
			'9 extended.image_url -> image().describe("extended")',
			'10 merged.image_url -> image().describe("merged")',
			'11 spread.image_url -> image().describe("spread")',
		]);
		for (const key of ["omitted", "picked", "extended", "merged", "spread"])
			expect(index).toContain(
				`${key}: { name: "a", image_url: toImageUrl(input.img, { field: "${key}.image_url" }) },`,
			);
		expect(result.skipped).toEqual([]);
	});

	it("wraps a mapper assignment only where the output keeps the field", () => {
		const dir = writeFixtureRepository({
			"schemas.ts": `import { z } from "@apifuse/provider-sdk/provider";

const Card = z.object({ name: z.string(), image_url: z.string() });

export const OutputSchema = z.object({
  full: Card,
  named: Card.pick({ name: true }),
  bare: Card.omit({ image_url: true }).partial(),
  kind: Card.keyof(),
});
`,
			"index.ts": `import { OutputSchema } from "./schemas";

export const op = {
  output: OutputSchema,
  handler: async (_ctx: unknown, input: { title: string; img: string; alt: string }) => ({
    full: { name: input.title, image_url: input.img },
    named: { name: input.title, image_url: input.alt },
    bare: { name: input.title, image_url: input.alt },
    kind: "name" as const,
  }),
  fixtures: {
    request: { title: "", img: "", alt: "" },
    response: {
      full: { name: "a", image_url: "https://cdn.example.com/a.jpg" },
      named: { name: "a" },
      bare: { name: "a" },
      kind: "name",
    },
  },
};
`,
		});
		const result = migrateUrlKindsRepository(dir, { typecheck: false });
		const schemas = readFileSync(join(dir, "schemas.ts"), "utf8");
		const index = readFileSync(join(dir, "index.ts"), "utf8");

		expect(schemas).toContain("const Card = z.object({ name: z.string(), image_url: image() });");
		expect(result.rewrites.map((item) => `${item.paths.join("|")} -> ${item.after}`)).toEqual([
			"full.image_url -> image()",
		]);
		expect(index).toContain(
			'full: { name: input.title, image_url: toImageUrl(input.img, { field: "full.image_url" }) },',
		);
		expect(index).toContain("named: { name: input.title, image_url: input.alt },");
		expect(index).toContain("bare: { name: input.title, image_url: input.alt },");
		expect(result.mapperWraps.map((item) => `${item.line} ${item.property}`)).toEqual([
			"6 image_url",
		]);
	});

	it("reads a mask bound through a factory and typed external keys, and reports keys it cannot read instead of keeping every field", () => {
		const dir = writeFixtureRepository({
			"schemas.ts": `import { z } from "@apifuse/provider-sdk/provider";

declare function externalShape(): Record<string, z.ZodString>;
declare function typedShape(): { image_url: z.ZodString };

const Card = z.object({ name: z.string(), image_url: z.string() });
const keys = ["name"] as const;
const only = (mask: { name?: true; image_url?: true }) => Card.pick(mask);

export const OutputSchema = z.object({
  bound: only({ name: true }),
  computed: Card.pick(Object.fromEntries(keys.map((key) => [key, true] as const))),
  external: Card.extend(externalShape()),
  typed: Card.extend(typedShape()),
  tail: z.object({ image_url: z.string(), ...externalShape() }),
});
`,
			"index.ts": `import { OutputSchema } from "./schemas";

const card = { name: "a", image_url: "https://cdn.example.com/a.jpg" };

export const op = {
  output: OutputSchema,
  handler: async () => ({ bound: card, computed: card, external: card, typed: card, tail: card }),
  fixtures: {
    request: {},
    response: { bound: card, computed: card, external: card, typed: card, tail: card },
  },
};
`,
		});
		const result = migrateUrlKindsRepository(dir, { typecheck: false });
		const schemas = readFileSync(join(dir, "schemas.ts"), "utf8");

		expect(schemas).toContain(
			"const Card = z.object({ name: z.string(), image_url: z.string() });",
		);
		expect(result.rewrites).toEqual([]);
		expect(
			result.skipped.map(
				(item) => `${item.line} ${item.paths.join("|")} ${item.reason} ${item.detail}`,
			),
		).toEqual([
			"12 computed unsupported_chain .pick() takes a mask this run cannot read; the fields behind it are left alone, migrate them by hand.",
			"13 external unsupported_chain .extend() adds keys this run cannot read; the fields behind it are left alone, migrate them by hand.",
			"15 tail unsupported_chain a member whose keys this run cannot read may replace the fields declared before it; those are left alone, migrate them by hand.",
		]);
	});
});

describe("apifuse migrate-url-kinds command line", () => {
	const run = (args: readonly string[], cwd: string) => {
		const outcome = Bun.spawnSync(["bun", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		return {
			code: outcome.exitCode,
			stdout: outcome.stdout.toString(),
			stderr: outcome.stderr.toString(),
		};
	};
	const dispatcher = join(SDK_ROOT, "bin", "apifuse.ts");
	const bin = join(SDK_ROOT, "bin", "apifuse-migrate-url-kinds.ts");

	it("never writes for --help, -h or an unknown option", () => {
		const dir = writeFixtureRepository();
		const help = run([dispatcher, "migrate-url-kinds", "--help"], dir);
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("Usage: apifuse migrate-url-kinds");
		expect(run([bin, "-h"], dir).code).toBe(0);
		const typo = run([dispatcher, "migrate-url-kinds", "--dry-run"], dir);
		expect(typo.code).toBe(1);
		expect(typo.stderr).toContain("unknown option --dry-run");
		const json = run([dispatcher, "migrate-url-kinds", "--chek", "--json"], dir);
		expect(json.code).toBe(1);
		expect(JSON.parse(json.stdout)).toEqual(
			expect.objectContaining({ status: "usage-error", reason: "unknown option --chek" }),
		);
		expect(readFileSync(join(dir, "schemas.ts"), "utf8")).toBe(SCHEMAS);
		expect(readFileSync(join(dir, "mapper.ts"), "utf8")).toBe(MAPPER);
	});

	it("reads the path argument when the bin is run directly and exits 1 on a refused path", () => {
		const dir = writeFixtureRepository();
		const direct = run([bin, dir, "--check", "--json", "--no-typecheck"], SDK_ROOT);
		expect(direct.code).toBe(0);
		const payload = JSON.parse(direct.stdout) as { providerRoot: string; status: string };
		expect(payload.providerRoot).toBe(dir);
		expect(payload.status).toBe("would-migrate");

		const text = run([dispatcher, "migrate-url-kinds", dir, "--check", "--no-typecheck"], SDK_ROOT);
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("migrate-url-kinds: would change 2 file(s)");
		expect(text.stdout).toContain(
			"  todo    schemas.ts:5 url (fixture https://shop.example.com/…)",
		);

		const empty = mkdtempSync(join(tmpdir(), "apifuse-migrate-url-kinds-empty-"));
		tempDirs.push(empty);
		const refused = run([dispatcher, "migrate-url-kinds", empty], SDK_ROOT);
		expect(refused.code).toBe(1);
		expect(refused.stdout).toContain("migrate-url-kinds: refused:");
		expect(readFileSync(join(dir, "schemas.ts"), "utf8")).toBe(SCHEMAS);
	});
});
