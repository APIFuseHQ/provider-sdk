import { describe, expect, it } from "bun:test";
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
import { collectHandleFields } from "../handle/contract.js";
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
		case "literal":
			return (def.values as unknown[])[0];
		case "enum":
			return Object.values(def.entries as Record<string, unknown>)[0];
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

function opWith<TInput extends z.ZodType, TOutput extends z.ZodType>(
	inputSchema: TInput,
	outputSchema: TOutput,
) {
	return {
		descriptionKey: "operations.op.description",
		riskClass: "read" as const,
		input: inputSchema,
		output: outputSchema,
		handler: async () => ({}) as z.output<TOutput>,
		fixtures: { request: sample(inputSchema), response: sample(outputSchema) },
		healthCheckUnsupported: { reason: "test" },
	};
}

function op<TInput extends z.ZodRawShape, TOutput extends z.ZodRawShape>(
	input: TInput,
	output: TOutput,
) {
	return opWith(
		describeKey(z.object(input), "operations.op.input"),
		describeKey(z.object(output), "operations.op.output"),
	);
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

	it("refuses a kind listed in handle: [...] that no operation issues or accepts, naming the fix", () => {
		const Internal = defineCursor({ name: "internal", schema: z.object({}), ttl: "10m" });
		const build = defineProvider({
			...DECLARATION,
			id: "unused-demo",
			state: {},
			handle: [Internal],
		});

		const unplaced = () =>
			build({ operations: { probe: op({ shop_id: shopId }, { ok: z.boolean() }) } });
		expect(unplaced).toThrow(ValidationError);
		expect(unplaced).toThrow(
			'Provider "unused-demo" handle kind "internal" is listed in handle: [...] but never issued: no operation output places internal.field().',
		);
		try {
			unplaced();
		} catch (error) {
			expect((error as ValidationError).fix).toBe(
				"Add internal.field() to the output of the issuing operation, or remove internal from handle: [...].",
			);
		}

		const issuedOnly = () =>
			build({
				operations: { probe: op({ shop_id: shopId }, { internal_ref: Internal.field() }) },
			});
		expect(issuedOnly).toThrow(
			'handle kind "internal" is listed in handle: [...] but never accepted: no operation input places internal.field().',
		);
	});

	it("binds kinds outside handle: [...] too", () => {
		const Listed = defineCursor({ name: "listed", schema: z.object({}), ttl: "10m" });
		const Unlisted = defineCursor({ name: "extra", schema: z.object({}), ttl: "10m" });

		defineProvider({ ...DECLARATION, id: "unlisted-demo", state: {}, handle: [Listed] })({
			operations: {
				list: op({ shop_id: shopId }, { listed_ref: Listed.field(), extra_ref: Unlisted.field() }),
				take: op({ listed_ref: Listed.field(), extra_ref: Unlisted.field() }, { ok: z.boolean() }),
			},
		});

		expect(Unlisted.fieldName).toBe("extra_ref");
		expect(Unlisted.issuedBy).toBe("list");
	});

	it("treats an operation that requires the handle on input and returns it as a continuation, not an issuer", () => {
		const Attempt = defineDraft({
			name: "attempt",
			schema: z.object({}),
			ttl: { idle: "30m", max: "2h" },
		});
		const echo = z.object({ attempt_token: Attempt.field() });

		defineProvider({ ...DECLARATION, id: "continuation-demo", state: {}, handle: [Attempt] })({
			operations: {
				// Issues: nothing required on input.
				start: op({ shop_id: shopId }, { attempt_token: Attempt.field() }),
				// Round of the same attempt: requires the handle, echoes it.
				answer: op(
					{ attempt_token: Attempt.field(), answer: z.string() },
					{ attempt_token: Attempt.field() },
				),
				// Commit: requires the handle, may echo it inside one output branch.
				commit: opWith(
					z.object({ attempt_token: Attempt.field() }),
					z.union([z.object({ done: z.boolean() }), echo]),
				),
				// Required in every input branch: still a continuation.
				branches: opWith(
					z.union([echo, z.object({ attempt_token: Attempt.field(), b: z.string() })]),
					echo,
				),
				// Optional, nullable, inside a list, or in only one branch: callable without a handle, so it issues.
				resume: op(
					{ attempt_token: Attempt.field().optional() },
					{ attempt_token: Attempt.field() },
				),
				reopen: op(
					{ attempt_token: Attempt.field().nullable() },
					{ attempt_token: Attempt.field() },
				),
				batch: op({ attempts: z.array(echo) }, { attempt_token: Attempt.field() }),
				either: opWith(z.union([echo, z.object({ shop_id: shopId })]), echo),
			},
		});

		expect(Attempt.issuedBy).toEqual(["start", "resume", "reopen", "batch", "either"]);
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
});

/**
 * Handle placements copied from the three fleet providers that use handles
 * (catchtable, modu-parking, careem checkouts, 2026-10-28): every `kind.field()`
 * position with its wrappers (optional, union branch, nested object, array,
 * `sensitive()` / `describeKey()` clones). Fields that carry no handle are
 * reduced to plain strings. Each kind is defined without the deprecated
 * options (the post-codemod shape) and must derive the `issuedBy` the provider
 * used to declare.
 */
describe("fleet shapes derive the issuedBy the providers declared", () => {
	it("catchtable: reserve-answer, reserve-confirm and reservation-payment-ready echo attempt_token without issuing it", () => {
		const WaitingDraft = defineDraft({
			name: "waiting",
			schema: z.object({ shop_ref: z.string() }),
			ttl: { idle: "30m", max: "2h" },
		});
		const ReserveDraft = defineDraft({
			name: "reserve",
			schema: z.object({ shop_ref: z.string() }),
			ttl: { idle: "30m", max: "2h" },
		});
		const CancellationDraft = defineDraft({
			name: "cancellation",
			schema: z.object({ reservation_ref: z.string() }),
			ttl: { idle: "30m", max: "30m" },
		});
		const ReserveNeedsInputOutputSchema = z
			.object({
				status: z.literal("needs_input"),
				attempt_token: ReserveDraft.field(),
				required_selections: z.array(z.object({ selection_key: z.string() })),
			})
			.strict();
		const ReserveReadyOutputSchema = z
			.object({
				status: z.literal("ready"),
				attempt_token: ReserveDraft.field(),
				summary: z.string(),
			})
			.strict();
		const ReserveOutputSchema = z.union([ReserveNeedsInputOutputSchema, ReserveReadyOutputSchema]);
		const ReserveConfirmOutputSchema = z.union([
			z.object({ reservation_ref: z.string(), status: z.enum(["CONFIRMED", "PENDING"]) }),
			ReserveNeedsInputOutputSchema,
			z.object({ status: z.literal("unknown"), verify_via: z.literal("my-status") }),
		]);
		const ReservationPaymentReadyOutputSchema = z.union([
			z
				.object({
					status: z.literal("needs_input"),
					attempt_token: ReserveDraft.field().describeKey("schemaDescriptions.index.d0382"),
					required_selections: z.array(z.object({ selection_key: z.string() })),
				})
				.strict(),
			z
				.object({
					status: z.literal("no_payment_required"),
					attempt_token: ReserveDraft.field().describeKey("schemaDescriptions.index.d0382"),
				})
				.strict(),
			z
				.object({
					status: z.literal("ready"),
					attempt_token: ReserveDraft.field().describeKey("schemaDescriptions.index.d0382"),
					payment_ready_token: z.string().min(1),
				})
				.strict(),
		]);
		const ReservationCreatePaymentSchema = z.object({ pay_method: z.string() });

		defineProvider({
			...DECLARATION,
			id: "catchtable",
			state: {},
			handle: [WaitingDraft, ReserveDraft, CancellationDraft],
		})({
			operations: {
				"waiting-prepare": opWith(
					z.object({ shop_ref: z.string() }),
					z.object({ shop_ref: z.string() }).extend({
						waiting_token: WaitingDraft.field().optional(),
						tables: z.array(z.object({ table: z.string().min(1) })),
					}),
				),
				"register-waiting": opWith(
					z.object({ waiting_token: WaitingDraft.field(), table: z.string().min(1) }).strict(),
					z.object({ waiting_ref: z.string() }),
				),
				reserve: opWith(
					z.object({
						shop_ref: z.string(),
						date: z.string(),
						time: z.string(),
						person: z.number(),
					}),
					ReserveOutputSchema,
				),
				"reserve-answer": opWith(
					z
						.object({
							attempt_token: ReserveDraft.field(),
							answers: z.array(z.object({ selection_key: z.string() })),
							use_point: z.number().optional(),
						})
						.strict(),
					ReserveOutputSchema,
				),
				"reservation-payment-ready": opWith(
					z
						.object({
							attempt_token: ReserveDraft.field().describeKey("schemaDescriptions.index.d0374"),
							pg_type: z.enum(["TOSSPAY", "NICEPAY"]).optional(),
							pay_method: z.enum(["CARD", "KAKAO_PAY"]).default("CARD"),
							use_point: z.number().int().min(0).default(0),
						})
						.strict(),
					ReservationPaymentReadyOutputSchema,
				),
				"reserve-confirm": opWith(
					z
						.object({
							attempt_token: ReserveDraft.field(),
							payment: z.lazy(() => ReservationCreatePaymentSchema).optional(),
							payment_method: z.enum(["points"]).optional(),
						})
						.strict(),
					ReserveConfirmOutputSchema,
				),
				"reservation-detail": opWith(
					z.object({ reservation_ref: z.string() }),
					z.object({
						cancellation: z
							.object({
								cancellation_token: CancellationDraft.field(),
								deposit_amount_krw: z.number().int().nonnegative(),
							})
							.strict()
							.optional(),
						reservation_ref: z.string(),
					}),
				),
				"cancel-reservation": opWith(
					z
						.object({
							cancellation_token: CancellationDraft.field(),
							reason: z.string().optional(),
						})
						.strict(),
					z.object({ reservation_ref: z.string(), status: z.literal("CANCELLED") }),
				),
			},
		});

		// handles.ts declared: waiting "waiting-prepare", reserve "reserve", cancellation "reservation-detail".
		expect(WaitingDraft.fieldName).toBe("waiting_token");
		expect(WaitingDraft.issuedBy).toBe("waiting-prepare");
		expect(ReserveDraft.fieldName).toBe("attempt_token");
		expect(ReserveDraft.issuedBy).toBe("reserve");
		expect(CancellationDraft.fieldName).toBe("cancellation_token");
		expect(CancellationDraft.issuedBy).toBe("reservation-detail");
		expect(handleRecoverySentence(ReserveDraft)).toBe(
			"Call `reserve` again and pass the new `attempt_token` exactly as returned.",
		);
		expect(ReserveNeedsInputOutputSchema.shape.attempt_token.description).toBe(
			"Opaque handle issued by `reserve`. Copy it exactly as returned; do not edit or shorten it.",
		);
	});

	it("modu-parking: a pagination cursor with an optional input issues its own first page; two detail operations issue one offer kind", () => {
		const SearchPage = defineCursor({
			name: "page",
			schema: z.object({ offset: z.number() }),
			ttl: "10m",
			access: "public",
			maxEntries: 100_000,
		});
		const PurchaseOffer = defineCursor({
			name: "purchase",
			schema: z.object({ kind: z.string() }),
			ttl: "30m",
			access: "public",
			maxEntries: 20_000,
		});
		const PaymentAuth = defineCursor({
			name: "payauth",
			schema: z.object({ phone: z.string() }),
			ttl: "10m",
			access: "public",
			strength: "high",
			maxEntries: 20_000,
		});

		defineProvider({
			...DECLARATION,
			id: "modu-parking",
			state: {},
			handle: [SearchPage, PurchaseOffer, PaymentAuth],
		})({
			operations: {
				"search-parking": opWith(
					z
						.object({ query: z.string().optional(), page_token: SearchPage.field().optional() })
						.superRefine(() => {}),
					z
						.object({
							parking_lots: z.array(z.object({ parking_lot_id: z.string() })),
							page_token: SearchPage.field().optional(),
							summary: z.string(),
						})
						.superRefine(() => {}),
				),
				"parking-detail": opWith(
					z.object({ parking_lot_id: z.string() }),
					z.object({
						available_days: z.array(z.object({ date: z.string() })),
						purchase_token: PurchaseOffer.field().optional(),
						purchase_expires_at: z.string().optional(),
					}),
				),
				"check-availability": opWith(
					z.object({ parking_lot_id: z.string() }),
					z.object({
						slots: z.array(z.object({ using_time_minutes: z.number() })),
						purchase_token: PurchaseOffer.field().optional(),
					}),
				),
				"send-payment-sms": opWith(
					z.object({ phone: z.string() }),
					z.object({ payment_auth_token: PaymentAuth.field(), message: z.string() }),
				),
				"start-payment": opWith(
					z.object({
						purchase_token: PurchaseOffer.field(),
						date: z.string().min(1).optional(),
						using_time_minutes: z.number().int().positive().optional(),
						payment_auth_token: PaymentAuth.field(),
						auth_code: z.string(),
					}),
					z.object({ payment_id: z.string() }),
				),
			},
		});

		// handles.ts declared: page "search-parking", purchase none (comment names both), payauth "send-payment-sms".
		expect(SearchPage.fieldName).toBe("page_token");
		expect(SearchPage.issuedBy).toBe("search-parking");
		expect(PurchaseOffer.fieldName).toBe("purchase_token");
		expect(PurchaseOffer.issuedBy).toEqual(["parking-detail", "check-availability"]);
		expect(PaymentAuth.fieldName).toBe("payment_auth_token");
		expect(PaymentAuth.issuedBy).toBe("send-payment-sms");
	});

	it("careem: sensitive() and describeKey() clones inside arrays and strict objects", () => {
		const paymentSelection = defineCursor({
			name: "payment",
			schema: z.object({ account_id: z.string() }).strict(),
			ttl: "20m",
			maxEntries: 100,
		});
		const rideQuote = defineDraft({
			name: "quote",
			schema: z.object({ account_id: z.string() }).strict(),
			ttl: { idle: "5m", max: "5m" },
			maxEntries: 100,
		});
		const cancellationAttempt = defineDraft({
			name: "cancel",
			schema: z.object({ account_id: z.string() }).strict(),
			ttl: { idle: "1m", max: "1m" },
			maxEntries: 100,
		});
		const CancellationDecisionSchema = z.object({ cancellation_reason: z.string() });

		defineProvider({
			...DECLARATION,
			id: "careem",
			state: {},
			handle: [paymentSelection, rideQuote, cancellationAttempt],
		})({
			operations: {
				"list-ride-payment-options": opWith(
					z.object({ service_area_id: z.string() }).strict(),
					z
						.object({
							currency: z.string(),
							payment_options: z.array(
								z
									.object({
										payment_option_token: sensitive(
											paymentSelection.field().describeKey("taxi.fields.paymentOptionToken"),
											"token",
										),
										display_name: z.string().min(1),
										usable: z.boolean(),
									})
									.strict(),
							),
						})
						.strict(),
				),
				"estimate-fare": opWith(
					z
						.object({
							vehicle_type_id: z.string(),
							pickup_time: z.string().optional(),
							payment_option_token: sensitive(
								paymentSelection.field().describeKey("taxi.fields.paymentOptionToken"),
								"token",
							),
						})
						.strict(),
					z
						.object({
							quote_token: sensitive(
								rideQuote.field().describeKey("taxi.fields.quoteToken"),
								"token",
							),
							minimum_fare: z.number(),
							maximum_fare: z.number(),
						})
						.strict()
						.refine((value) => value.minimum_fare <= value.maximum_fare),
				),
				"request-ride": opWith(
					z
						.object({
							quote_token: sensitive(
								rideQuote.field().describeKey("taxi.lifecycle.requestRide.input.quoteToken"),
								"token",
							),
							confirm: z.literal(true),
						})
						.strict(),
					z.object({ ride_id: z.string() }).strict(),
				),
				"get-cancellation-policy": opWith(
					z
						.object({ ride_id: z.string(), origin: z.object({ latitude: z.number() }).optional() })
						.strict(),
					CancellationDecisionSchema.extend({
						cancellation_token: sensitive(
							cancellationAttempt
								.field()
								.describeKey("taxi.lifecycle.cancellation.output.cancellationToken"),
							"token",
						),
					}).strict(),
				),
				"cancel-ride": opWith(
					z
						.object({
							cancellation_token: sensitive(
								cancellationAttempt
									.field()
									.describeKey("taxi.lifecycle.cancel.input.cancellationToken"),
								"token",
							),
							confirm: z.literal(true),
						})
						.strict(),
					z.object({ status: z.literal("cancelled") }).strict(),
				),
			},
		});

		// taxi-handles.ts declared: payment "list-ride-payment-options", quote "estimate-fare", cancel "get-cancellation-policy".
		expect(paymentSelection.fieldName).toBe("payment_option_token");
		expect(paymentSelection.issuedBy).toBe("list-ride-payment-options");
		expect(rideQuote.fieldName).toBe("quote_token");
		expect(rideQuote.issuedBy).toBe("estimate-fare");
		expect(cancellationAttempt.fieldName).toBe("cancellation_token");
		expect(cancellationAttempt.issuedBy).toBe("get-cancellation-policy");
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
