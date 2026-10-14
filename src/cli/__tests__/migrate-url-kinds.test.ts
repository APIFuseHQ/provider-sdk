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
});

const BaseItemSchema = z.object({
  name: z.string(),
  image_url: z.string().nullable(),
  url: z.string().url().nullish().describe("Item page"),
  thumbnail_url: z.string().optional(),
  detail_url: z.string(),
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
    detail_url: row.detail,
    source_path: row.source,
    image_urls: row.gallery,
    seller: { name: row.seller.name, url: row.seller.home ?? null },
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
  const item = { name: row.title, image_url: row.img ?? null, url: null, detail_url: "", source_path: "" };
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
  detail_url: "https://shop.example.com/p/1/detail",
  source_path: "/catalog/1",
  image_urls: ["https://cdn.example.com/kettle-1.jpg"],
  seller: { name: "Shop", url: "https://shop.example.com/s/9" },
};

export const searchOperation = {
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

function writeFixtureRepository(
	files: Readonly<Record<string, string>> = {
		"schemas.ts": SCHEMAS,
		"mapper.ts": MAPPER,
		"index.ts": INDEX,
	},
): string {
	const dir = mkdtempSync(join(tmpdir(), "apifuse-migrate-url-kinds-"));
	tempDirs.push(dir);
	mkdirSync(join(dir, "node_modules", "@apifuse"), { recursive: true });
	symlinkSync(SDK_ROOT, join(dir, "node_modules", "@apifuse", "provider-sdk"), "dir");
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
		// nested object, own .nullable() dropped
		expect(schemas).toContain("  url: itemPage(),\n});");
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
		expect(schemas).toContain("  detail_url: z.string(),");
		// a relative fixture value is no URL evidence
		expect(schemas).toContain("  source_path: z.string(),");

		expect(
			result.rewrites.map((item) => `${item.property}@${item.paths.join("|")} -> ${item.after}`),
		).toEqual([
			"url@items[].seller.url -> itemPage()",
			"image_url@items[].image_url -> image()",
			'url@items[].url -> itemPage().optional().describe("Item page")',
			"thumbnail_url@items[].thumbnail_url -> image({ thumbnail: true }).optional()",
			"image_urls@items[].image_urls -> imageList()",
		]);
		expect(result.todos.map((item) => `${item.property} ${item.evidence}`)).toEqual([
			"detail_url fixture https://shop.example.com/…",
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
			'seller: { name: row.seller.name, url: toItemPageUrl(row.seller.home ?? null, { field: "items[].seller.url" }) },',
		);
		// the parse anchor
		expect(mapper).toContain(
			'return ItemSchema.parse({ ...mapItem(row), image_url: toImageUrl(row.img, { field: "items[].image_url" }) });',
		);
		// literals and undeclared fields stay
		expect(mapper).toContain('banner: { image_url: "http://img.example.com/banner.jpg" },');
		expect(mapper).toContain("    detail_url: row.detail,");
		expect(mapper).toContain("for (const row of rows) photos.push({ url: row.detail });");
		// the untraced typed mapper is reported, not guessed
		expect(result.residualCheck).toBe("ran");
		expect(result.residual).toEqual([
			expect.objectContaining({ file: "mapper.ts", message: expect.stringContaining("ImageUrl") }),
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
		expect(neutral(property(extra(after), "seller"), false)).toEqual(
			property(extra(before), "seller"),
		);
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
  by_id: z.record(z.string(), z.object({ url: z.string() })),
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
    by_id: { first: { url: path } },
    external: externalResolve({ image_url: path }),
    external_ref: externalResolve(raw),
    gallery: Array.from([path], (src) => ({ image_url: src })),
  };
}
`,
			"index.ts": `import { OutputSchema } from "./schemas";
import { mapOutput } from "./mapper";

export const op = {
  output: OutputSchema,
  handler: async (_ctx: unknown, input: { path: string }) => mapOutput(input.path),
  fixtures: {
    request: { path: "/a.jpg" },
    response: {
      item: { image_url: "https://cdn.example.com/a.jpg" },
      blank: { image_url: "" },
      nullable_items: { image_urls: ["https://cdn.example.com/a.jpg", null] },
      described_items: { image_urls: ["https://cdn.example.com/a.jpg"] },
      by_id: { first: { url: "https://shop.example.com/p/1" } },
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
			'by_id: { first: { url: toItemPageUrl(path, { field: "by_id.*.url" }) } },',
		);
		expect(result.skipped.map((item) => `${item.paths.join("|")} ${item.reason}`)).toEqual([
			"blank.image_url non_url_fixture_value",
			"nullable_items.image_urls unsupported_chain",
			"described_items.image_urls unsupported_chain",
		]);
	});
});
