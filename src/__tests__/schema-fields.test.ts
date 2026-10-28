import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";

import { defineCursor } from "../handle.js";
import { APIFUSE_HANDLE_META_KEY, handleFieldDescription } from "../handle-meta.js";
import { describeKey, fields, type PublicSchema, publicField, sensitive } from "../schema.js";
import { collectUndeclaredFields, warnUndeclaredFields } from "../schema-fields.js";

function keyed<TSchema extends z.ZodType>(schema: TSchema, key: string): TSchema {
	return describeKey(schema, key);
}

function prose<TSchema extends z.ZodType>(schema: TSchema, text: string): TSchema {
	return schema.meta({ ...(schema.meta() ?? {}), description: text });
}

const Page = defineCursor({ name: "page", schema: z.object({ offset: z.number() }), ttl: "10m" });

describe("collectUndeclaredFields", () => {
	it("is empty for a fully keyed schema", () => {
		const schema = keyed(
			z.object({
				query: keyed(z.string(), "fields.query"),
				page: keyed(z.number().int().optional(), "fields.page"),
				items: keyed(
					z.array(keyed(z.object({ id: keyed(z.string(), "fields.id") }), "fields.item")),
					"fields.items",
				),
			}),
			"input.root",
		);

		expect(collectUndeclaredFields(schema, "input")).toEqual([]);
	});

	it("names the root, each property, union branches and tuple items that lack a key", () => {
		const schema = z.object({
			query: z.string(),
			mode: z.union([z.object({ ok: z.string() }), keyed(z.object({}), "fields.empty")]),
			pair: z.tuple([z.string(), keyed(z.number(), "fields.second")]),
		});

		expect(collectUndeclaredFields(schema, "output")).toEqual([
			{ path: "output", reason: "missing-key" },
			{ path: "output.query", reason: "missing-key" },
			{ path: "output.mode", reason: "missing-key" },
			{ path: "output.mode[0]", reason: "missing-key" },
			{ path: "output.mode[0].ok", reason: "missing-key" },
			{ path: "output.pair", reason: "missing-key" },
			{ path: "output.pair[0]", reason: "missing-key" },
		]);
	});

	it("does not require a key on wrapper internals, array elements or record values", () => {
		const schema = keyed(
			z.object({
				keyword: keyed(z.string().default(""), "fields.keyword"),
				code: keyed(
					z.preprocess((value) => value, z.enum(["A", "B"])),
					"fields.code",
				),
				tags: keyed(z.array(z.string()), "fields.tags"),
				metadata: keyed(z.record(z.string(), z.string()), "fields.metadata"),
				lazy: keyed(
					z.lazy(() => z.string()),
					"fields.lazy",
				),
			}),
			"input.root",
		);

		expect(collectUndeclaredFields(schema, "input")).toEqual([]);
	});

	it("reports raw prose wherever it sits, including on elements and wrappers", () => {
		const schema = keyed(
			z.object({
				query: prose(z.string(), "Search keyword"),
				items: keyed(z.array(prose(z.string(), "Row")), "fields.items"),
				opt: keyed(prose(z.string(), "inner").optional(), "fields.opt"),
			}),
			"input.root",
		);

		expect(collectUndeclaredFields(schema, "input")).toEqual([
			{ path: "input.query", reason: "raw-prose" },
			{ path: "input.items[]", reason: "raw-prose" },
			{ path: "input.opt", reason: "raw-prose" },
		]);
	});

	it("does not treat a property whose name starts with element as an array position", () => {
		const schema = keyed(z.object({ elementId: z.string() }), "output.root");

		expect(collectUndeclaredFields(schema, "output")).toEqual([
			{ path: "output.elementId", reason: "missing-key" },
		]);
	});

	it("accepts a describeKey() on top of raw prose", () => {
		const schema = keyed(
			z.object({ query: keyed(prose(z.string(), "Search keyword"), "fields.query") }),
			"input.root",
		);

		expect(collectUndeclaredFields(schema, "input")).toEqual([]);
	});

	it("accepts the SDK-owned wording of fields.*() presets and handle fields, through wrappers", () => {
		const schema = keyed(
			z.object({
				token: fields.token(),
				otp: fields.otp().optional(),
				cursor: Page.field(),
				next: Page.field().nullable(),
			}),
			"input.root",
		);

		expect(collectUndeclaredFields(schema, "input")).toEqual([]);
	});

	it("treats provider prose over a preset or a handle field as raw prose again", () => {
		const schema = keyed(
			z.object({
				token: fields.token({ description: "Access token returned upstream" }),
				cursor: prose(Page.field(), "Your page"),
				wrapped: prose(Page.field().optional(), "Your page"),
			}),
			"output.root",
		);

		expect(collectUndeclaredFields(schema, "output")).toEqual([
			{ path: "output.token", reason: "raw-prose" },
			{ path: "output.cursor", reason: "raw-prose" },
			{ path: "output.wrapped", reason: "raw-prose" },
		]);
	});

	it("reports provider prose on the other stage of a pipe or intersection next to a preset", () => {
		const schema = keyed(
			z.object({
				token: fields.token().pipe(z.string().describe("Provider-specific prose")),
				reversed: z.string().describe("Provider-specific prose").pipe(fields.token()),
				both: z.intersection(fields.otp(), z.string().describe("Provider-specific prose")),
				plainPipe: fields.token().pipe(z.string()),
				plainBoth: z.intersection(fields.otp(), z.string().min(1)),
			}),
			"input.root",
		);

		expect(collectUndeclaredFields(schema, "input")).toEqual([
			{ path: "input.token", reason: "raw-prose" },
			{ path: "input.reversed", reason: "raw-prose" },
			{ path: "input.both", reason: "raw-prose" },
		]);
	});

	it("still requires a key on sensitive() and publicField() leaves, which declare privacy only", () => {
		const schema = keyed(
			z.object({
				phone: publicField(z.string()),
				secret: sensitive(z.string(), "secret"),
			}),
			"output.root",
		);

		expect(collectUndeclaredFields(schema, "output")).toEqual([
			{ path: "output.phone", reason: "missing-key" },
			{ path: "output.secret", reason: "missing-key" },
		]);
	});

	it("ignores a non-schema and a schema reused under two keys is reported once", () => {
		const shared = z.string();
		const schema = keyed(z.object({ a: shared, b: shared }), "output.root");

		expect(collectUndeclaredFields(undefined, "input")).toEqual([]);
		expect(collectUndeclaredFields(schema, "output")).toEqual([
			{ path: "output.a", reason: "missing-key" },
		]);
	});

	it("keeps the handle meta and the SDK description readable from the same registry entry", () => {
		const field = Page.field();

		expect(field.meta()?.[APIFUSE_HANDLE_META_KEY]).toBeDefined();
		expect(field.description).toBe(handleFieldDescription({ issuedBy: undefined }));
	});
});

describe("warnUndeclaredFields", () => {
	let warn: ReturnType<typeof spyOn>;
	beforeEach(() => {
		warn = spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		warn.mockRestore();
	});

	it("warns once per provider with every path and its reason, naming the fix and the codemod", () => {
		const operations = {
			search: {
				input: keyed(z.object({ q: prose(z.string(), "Query") }), "input.root"),
				output: z.object({ ok: keyed(z.boolean(), "fields.ok") }),
			},
		};

		warnUndeclaredFields("warn-demo", operations);
		warnUndeclaredFields("warn-demo", operations);

		expect(warn).toHaveBeenCalledTimes(1);
		const message = String(warn.mock.calls[0]?.[0]);
		expect(message).toContain(
			'Provider "warn-demo" has 2 public schema fields without a locale key',
		);
		expect(message).toContain("operations.search.input.q (raw .describe() prose)");
		expect(message).toContain("operations.search.output (no description)");
		expect(message).toContain('.describeKey("<locale key>")');
		expect(message).toContain("scripts/codemods/schema.yml");
	});

	it("is silent for a provider whose schemas are all declared", () => {
		warnUndeclaredFields("warn-silent", {
			ping: {
				input: keyed(z.object({}), "input.root"),
				output: keyed(z.object({ ok: keyed(z.boolean(), "fields.ok") }), "output.root"),
			},
		});

		expect(warn).not.toHaveBeenCalled();
	});
});

describe("PublicSchema", () => {
	it("is the same zod schema at runtime and stays assignable to its zod type", () => {
		const token: z.ZodString = fields.token();
		const keyed: z.ZodObject<{ id: z.ZodString }> = describeKey(z.object({ id: z.string() }), "k");
		const viaMethod: PublicSchema<z.ZodString> = z.string().describeKey("k");
		const wrapped = z.object({
			token,
			keyed,
			viaMethod,
			opt: publicField(z.number()).optional(),
			sens: sensitive(z.string()).nullable(),
		});
		const parsed: z.infer<typeof wrapped> = wrapped.parse({
			token: "t",
			keyed: { id: "i" },
			viaMethod: "v",
			sens: null,
		});

		expect(parsed).toEqual({ token: "t", keyed: { id: "i" }, viaMethod: "v", sens: null });
		expect(fields.token()).toBeInstanceOf(z.ZodString);
	});
});
