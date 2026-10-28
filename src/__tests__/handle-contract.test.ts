import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";
import { defineProvider, type ProviderContextOf, type ProviderDeclaration } from "../define.js";
import { ValidationError } from "../errors.js";
import {
	defineCursor,
	defineDraft,
	type HandleContext,
	type HandleField,
	type HandleKind,
	type HandleKindOfField,
	handleRecoverySentence,
} from "../handle.js";
import { bindHandleContract, collectHandleFields } from "../handle/contract.js";
import { APIFUSE_HANDLE_META_KEY, handleFieldDescription } from "../handle-meta.js";
import { createTestHandleContext } from "../runtime/handle.js";
import { describeKey, sensitive } from "../schema.js";

const META = { displayName: "Handles", descriptionKey: "meta.description", category: "test" };
const DECLARATION = {
	version: "1.0.0",
	runtime: "standard",
	allowedHosts: ["example.com"],
	reviewed: "first-party",
	meta: META,
} satisfies Partial<ProviderDeclaration>;

function sample(schema: z.ZodType): unknown {
	const def = schema.def as Record<string, unknown> & { type: string };
	switch (def.type) {
		case "string":
			return "sample_able-acid";
		case "number":
			return 1;
		case "boolean":
			return true;
		case "object":
			return Object.fromEntries(
				Object.entries(def.shape as Record<string, z.ZodType>).map(([key, value]) => [
					key,
					sample(value),
				]),
			);
		case "array":
			return [];
		case "union":
			return sample((def.options as z.ZodType[])[0]!);
		case "intersection":
			return {
				...(sample(def.left as z.ZodType) as object),
				...(sample(def.right as z.ZodType) as object),
			};
		case "lazy":
			return sample((def.getter as () => z.ZodType)());
		case "pipe":
			return sample(def.in as z.ZodType);
		default:
			return sample(def.innerType as z.ZodType);
	}
}

function op<TInput extends z.ZodRawShape, TOutput extends z.ZodRawShape>(
	input: TInput,
	output: TOutput,
) {
	const inputSchema = describeKey(z.object(input), "operations.op.input");
	const outputSchema = describeKey(z.object(output), "operations.op.output");
	return {
		descriptionKey: "operations.op.description",
		riskClass: "read" as const,
		input: inputSchema,
		output: outputSchema,
		handler: async () => ({}) as z.output<z.ZodObject<TOutput>>,
		fixtures: { request: sample(inputSchema), response: sample(outputSchema) },
		healthCheckUnsupported: { reason: "test" },
	};
}

const shopId = describeKey(z.string(), "fields.shopId");

describe("handle contract bound from the operation schemas", () => {
	it("reads the property key and the issuing operations from where kind.field() is placed", () => {
		const Waiting = defineDraft({
			name: "waiting",
			schema: z.object({ shop: z.string() }),
			ttl: { idle: "30m", max: "2h" },
		});
		expect(Waiting.fieldName).toBe("waiting_token");
		expect(Waiting.issuedBy).toBeUndefined();
		const before = Waiting.field();

		defineProvider({ ...DECLARATION, id: "waiting-demo", state: {}, handle: [Waiting] })({
			operations: {
				"waiting-prepare": op({ shop_id: shopId }, { waiting_token: before }),
				"waiting-restart": op({ shop_id: shopId }, { waiting_token: Waiting.field() }),
				"waiting-confirm": op({ waiting_token: Waiting.field().optional() }, { ok: z.boolean() }),
			},
		});

		expect(Waiting.fieldName).toBe("waiting_token");
		expect(Waiting.outputFieldName).toBeUndefined();
		expect(Waiting.issuedBy).toEqual(["waiting-prepare", "waiting-restart"]);
		expect(handleRecoverySentence(Waiting)).toBe(
			"Call `waiting-prepare` or `waiting-restart` again and pass the new `waiting_token` exactly as returned.",
		);
		const meta = before.meta()?.[APIFUSE_HANDLE_META_KEY];
		expect(meta).toEqual({
			kind: "waiting",
			type: "draft",
			fieldName: "waiting_token",
			issuedBy: ["waiting-prepare", "waiting-restart"],
		});
		expect(Object.hasOwn(meta as object, "outputFieldName")).toBe(false);
		expect(before.description).toBe(
			"Opaque handle issued by `waiting-prepare` or `waiting-restart`. Copy it exactly as returned; do not edit or shorten it.",
		);
		expect(Waiting.field().description).toBe(before.description);
		expect(JSON.parse(JSON.stringify(z.toJSONSchema(before)))).toMatchObject({
			description: before.description,
			[APIFUSE_HANDLE_META_KEY]: { issuedBy: ["waiting-prepare", "waiting-restart"] },
		});
	});

	it("binds one key per direction: `cursor` in, `next_cursor` out", () => {
		const Page = defineCursor({ name: "page", schema: z.object({ page: z.number() }), ttl: "10m" });

		defineProvider({ ...DECLARATION, id: "paging-demo", state: {}, handle: [Page] })({
			operations: {
				search: op({ cursor: Page.field().optional() }, { next_cursor: Page.field().nullable() }),
			},
		});

		expect(Page.fieldName).toBe("cursor");
		expect(Page.outputFieldName).toBe("next_cursor");
		expect(Page.issuedBy).toBe("search");
		expect(handleRecoverySentence(Page)).toBe(
			"Call `search` again and pass the new `next_cursor` back as `cursor`, exactly as returned.",
		);
	});

	it("refreshes the SDK description on describeKey() and sensitive() clones, never a provider's own text", () => {
		const Quote = defineDraft({
			name: "quote",
			schema: z.object({ fare: z.number() }),
			ttl: { idle: "5m", max: "30m" },
		});
		const sensitiveField = sensitive(Quote.field(), "token");
		const keyedField = Quote.field().describeKey("fields.quoteToken");
		const ownText = Quote.field().describe("Your quote.");

		defineProvider({ ...DECLARATION, id: "quote-demo", state: {}, handle: [Quote] })({
			operations: {
				estimate: op({ shop_id: shopId }, { quote_token: sensitiveField }),
				book: op({ quote_token: keyedField }, { ok: z.boolean() }),
				cancel: op({ quote_token: ownText }, { ok: z.boolean() }),
			},
		});

		const expected = handleFieldDescription({ issuedBy: "estimate" });
		expect(expected).toContain("issued by `estimate`");
		expect(sensitiveField.description).toBe(expected);
		expect(sensitiveField.meta()?.["x-apifuse-sensitive"]).toBe(true);
		expect(keyedField.description).toBe(expected);
		expect(keyedField.meta()?.["x-apifuse-description-key"]).toBeDefined();
		expect(ownText.description).toBe("Your quote.");
	});

	it("finds fields inside arrays, unions, intersections, lazy and pipe wrappers, keeping the enclosing key", () => {
		const Item = defineCursor({ name: "item", schema: z.object({}), ttl: "10m" });
		const Lazy = z.lazy(() => z.object({ item_ref: Item.field() }));
		const output = z.object({
			offers: z.array(z.object({ item_ref: Item.field().optional() })),
			either: z.union([z.object({ item_ref: Item.field() }), z.object({ other: z.string() })]),
			both: z.object({ a: z.string() }).and(z.object({ item_ref: Item.field() })),
			nested: Lazy,
			piped: z.object({ item_ref: Item.field().pipe(z.string()) }),
		});

		const found = collectHandleFields(output, "output");

		expect(found.map((occurrence) => occurrence.path).sort()).toEqual([
			"output.both.item_ref",
			"output.either.item_ref",
			"output.nested.item_ref",
			"output.offers[].item_ref",
			"output.piped.item_ref",
		]);
		expect(new Set(found.map((occurrence) => occurrence.key))).toEqual(new Set(["item_ref"]));
	});

	it("refuses one kind under two different keys on the same side, naming both positions", () => {
		const Page = defineCursor({ name: "page", schema: z.object({}), ttl: "10m" });
		const build = defineProvider({ ...DECLARATION, id: "two-keys", state: {}, handle: [Page] });

		expect(() =>
			build({
				operations: {
					search: op({ cursor: Page.field() }, { next_cursor: Page.field() }),
					browse: op({ page_token: Page.field() }, { next_cursor: Page.field() }),
				},
			}),
		).toThrow(ValidationError);
		expect(() =>
			build({
				operations: {
					search: op({ cursor: Page.field() }, { next_cursor: Page.field() }),
					browse: op({ page_token: Page.field() }, { next_cursor: Page.field() }),
				},
			}),
		).toThrow(
			'handle kind "page" is placed under 2 different input keys: "cursor" at operations.search.input.cursor, "page_token" at operations.browse.input.page_token',
		);
	});

	it("keeps the ${name}_token default for a kind no schema places, and binds kinds outside handle: [...] too", () => {
		const Internal = defineCursor({ name: "internal", schema: z.object({}), ttl: "10m" });
		const Unlisted = defineCursor({ name: "extra", schema: z.object({}), ttl: "10m" });

		defineProvider({ ...DECLARATION, id: "unused-demo", state: {}, handle: [Internal] })({
			operations: {
				probe: op({ extra_ref: Unlisted.field() }, { extra_ref: Unlisted.field() }),
			},
		});

		expect(Internal.fieldName).toBe("internal_token");
		expect(Internal.issuedBy).toBeUndefined();
		expect(handleRecoverySentence(Internal)).toBe(
			"Request a new `internal_token` and pass it exactly as returned.",
		);
		expect(Unlisted.fieldName).toBe("extra_ref");
		expect(Unlisted.issuedBy).toBe("probe");
	});

	it("runtime errors read the bound names so an unmigrated-looking message is impossible", async () => {
		const Offer = defineCursor({ name: "offer", schema: z.object({ n: z.number() }), ttl: "10m" });
		defineProvider({ ...DECLARATION, id: "offer-demo", state: {}, handle: [Offer] })({
			operations: {
				list: op({ shop_id: shopId }, { offer_ref: Offer.field() }),
				take: op({ offer_ref: Offer.field() }, { ok: z.boolean() }),
			},
		});
		const ctx = createTestHandleContext({
			providerId: "offer-demo",
			request: { connectionId: "c1", headers: {} },
		});

		await expect(ctx.read(Offer, "offer_zzzz-zzzz")).rejects.toThrow(
			"Call `list` again and pass the new `offer_ref` exactly as returned.",
		);
	});

	describe("deprecated fieldName / issuedBy options", () => {
		let warn: ReturnType<typeof spyOn>;
		beforeEach(() => {
			warn = spyOn(console, "warn").mockImplementation(() => {});
		});
		afterEach(() => {
			warn.mockRestore();
		});

		it("still win over the bound contract, byte for byte, and warn once per kind", () => {
			const Legacy = defineCursor({
				name: "legacy",
				fieldName: { input: "cursor", output: "next_cursor" },
				schema: z.object({}),
				ttl: "10m",
				issuedBy: "declared-op",
			});
			defineCursor({
				name: "legacy",
				fieldName: "cursor",
				schema: z.object({}),
				ttl: "10m",
				issuedBy: "declared-op",
			});
			const field = Legacy.field();

			defineProvider({ ...DECLARATION, id: "legacy-demo", state: {}, handle: [Legacy] })({
				operations: {
					search: op({ token: field }, { token: Legacy.field() }),
				},
			});

			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain(
				'defineCursor "legacy": fieldName and issuedBy are deprecated',
			);
			expect(Legacy.fieldName).toBe("cursor");
			expect(Legacy.outputFieldName).toBe("next_cursor");
			expect(Legacy.issuedBy).toBe("declared-op");
			expect(field.meta()?.[APIFUSE_HANDLE_META_KEY]).toEqual({
				kind: "legacy",
				type: "cursor",
				fieldName: "cursor",
				outputFieldName: "next_cursor",
				issuedBy: "declared-op",
			});
			expect(field.description).toBe(handleFieldDescription({ issuedBy: "declared-op" }));
		});

		it("a declared fieldName alone keeps its single-name meta even when the schemas use two keys", () => {
			const Legacy = defineDraft({
				name: "legacy",
				fieldName: "token",
				schema: z.object({}),
				ttl: { idle: "1m", max: "2m" },
			});

			defineProvider({ ...DECLARATION, id: "legacy-one", state: {}, handle: [Legacy] })({
				operations: {
					search: op({ token: Legacy.field() }, { next_token: Legacy.field() }),
				},
			});

			expect(Legacy.outputFieldName).toBeUndefined();
			expect(Legacy.issuedBy).toBe("search");
		});
	});

	describe("bindHandleContract", () => {
		it("is a no-op for values that are not SDK kinds", () => {
			expect(() => bindHandleContract({ name: "x" }, { fieldName: "y" })).not.toThrow();
			expect(() => bindHandleContract(undefined, { fieldName: "y" })).not.toThrow();
		});
	});
});

describe("type-level contracts", () => {
	it("brands kind.field() with its kind and types ctx.handle to the declared kinds", () => {
		const Waiting = defineDraft({
			name: "waiting",
			schema: z.object({ shop: z.string() }),
			ttl: { idle: "30m", max: "2h" },
		});
		const Page = defineCursor({ name: "page", schema: z.object({}), ttl: "10m" });
		const Other = defineCursor({ name: "other", schema: z.object({}), ttl: "10m" });

		const field = Waiting.field();
		type FieldKind = HandleKindOfField<typeof field>;
		const kindOfField: FieldKind = Waiting;
		expect(kindOfField.name).toBe("waiting");
		const asString: string = field.parse("waiting_able-acid");
		expect(asString).toBe("waiting_able-acid");
		const plain: HandleField = field;
		expect(plain.safeParse("").success).toBe(false);

		const build = defineProvider({
			...DECLARATION,
			id: "typed-ctx",
			state: {},
			handle: [Waiting, Page],
		});
		type Handle = ProviderContextOf<typeof build>["handle"];
		const probe = (handle: Handle): void => {
			void handle.create(Waiting, { shop: "x" });
			void handle.read(Page, "page_able-acid");
			void handle.update(Waiting, "waiting_able-acid", (data) => data);
			// @ts-expect-error test-invalid: a kind outside handle: [...] must be refused by the compiler.
			void handle.read(Other, "other_able-acid");
			// @ts-expect-error test-invalid: update accepts draft kinds only.
			void handle.update(Page, "page_able-acid", (data) => data);
		};
		const runtime: HandleContext = createTestHandleContext({ providerId: "typed-ctx" });
		const narrowed: Handle = runtime;
		const widened: HandleContext = narrowed as HandleContext<typeof Waiting | typeof Page>;
		expect(typeof probe).toBe("function");
		expect(widened).toBe(runtime);

		const everyKind: readonly HandleKind[] = [Waiting, Page];
		const untyped = defineProvider({
			...DECLARATION,
			id: "untyped-ctx",
			state: {},
			handle: everyKind,
		});
		type UntypedHandle = ProviderContextOf<typeof untyped>["handle"];
		const accepting = (handle: UntypedHandle): void => {
			void handle.read(Other, "other_able-acid");
		};
		expect(typeof accepting).toBe("function");
	});

	it("refuses handle: [...] without the state capability at the call", () => {
		const Page = defineCursor({ name: "page", schema: z.object({}), ttl: "10m" });

		// @ts-expect-error test-invalid: handle kinds without the state capability must not compile.
		const refused = defineProvider({ ...DECLARATION, id: "no-state", handle: [Page] });
		expect(typeof refused).toBe("function");
		expect(typeof defineProvider({ ...DECLARATION, id: "empty-ok", handle: [] })).toBe("function");
		expect(
			typeof defineProvider({ ...DECLARATION, id: "with-state", state: {}, handle: [Page] }),
		).toBe("function");
	});
});
