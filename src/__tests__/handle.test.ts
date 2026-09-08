import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ProviderError } from "../errors.js";
import {
	type CursorKind,
	type DataOf,
	type DraftKind,
	defineCursor,
	defineDraft,
	HandleError,
	type HandleKind,
	type HandleKindDeclaration,
	type HandleTelemetryEvent,
	pick,
	type ResultOf,
} from "../handle.js";
import { APIFUSE_HANDLE_META_KEY, isHandleFieldMeta } from "../handle-meta.js";
import {
	createHandleContext,
	createTestHandleContext,
	normalizeHandle,
} from "../runtime/handle.js";
import {
	findHandleWordWithinDistance,
	HANDLE_WORDLIST_SIZE,
	ISSUABLE_HANDLE_WORDS,
	isHandleWord,
} from "../runtime/handle-wordlist.js";
import {
	createMemoryProviderRuntimeState,
	createUnsupportedProviderRuntimeState,
} from "../runtime/state.js";

const PageSchema = z.object({ query: z.string(), page: z.number().int() });
const WaitingSchema = z.object({
	shop: z.string(),
	tables: z.array(z.object({ table: z.string(), label: z.string() })),
	selections: z.record(z.string(), z.string()),
});
const WaitingResultSchema = z.object({ waitingId: z.string() });

const BoundPage = defineCursor({
	name: "page",
	fieldName: "cursor",
	schema: PageSchema,
	ttl: "10m",
	issuedBy: "search",
});
const PublicPage = defineCursor({
	name: "pub",
	fieldName: "page_token",
	schema: PageSchema,
	ttl: "10m",
	access: "public",
	maxEntries: 1_000,
	issuedBy: "search",
});
const WaitingDraft = defineDraft({
	name: "waiting",
	fieldName: "waiting_token",
	schema: WaitingSchema,
	result: WaitingResultSchema,
	ttl: { idle: "30m", max: "2h" },
	resultTtl: "24h",
	issuedBy: "waiting-prepare",
});

const T0 = Date.UTC(2026, 8, 8, 12, 0, 0);
const MINUTE = 60_000;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

function fakeClock(start = T0): { nowMs: () => number; advance: (ms: number) => void } {
	let now = start;
	return {
		nowMs: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function waitingData(): DataOf<typeof WaitingDraft> {
	return {
		shop: "shop-1",
		tables: [
			{ table: "hall", label: "Hall" },
			{ table: "terrace", label: "Terrace" },
		],
		selections: {},
	};
}

async function expectHandleError(
	promise: Promise<unknown>,
	code: HandleError["code"],
): Promise<HandleError> {
	try {
		await promise;
	} catch (error) {
		if (!(error instanceof HandleError)) {
			throw new Error(`Expected HandleError, received ${String(error)}`);
		}
		expect(error.code).toBe(code);
		return error;
	}
	throw new Error(`Expected ${code} to be thrown.`);
}

function wordsOf(handle: string, kind: HandleKind): string[] {
	expect(handle.startsWith(`${kind.name}_`)).toBe(true);
	return handle.slice(kind.name.length + 1).split("-");
}

function singleEditVariants(word: string): string[] {
	const variants = new Set<string>();
	for (let position = 0; position < word.length; position += 1) {
		variants.add(word.slice(0, position) + word.slice(position + 1));
		for (const letter of ALPHABET) {
			variants.add(word.slice(0, position) + letter + word.slice(position + 1));
		}
	}
	for (let position = 0; position <= word.length; position += 1) {
		for (const letter of ALPHABET) {
			variants.add(word.slice(0, position) + letter + word.slice(position));
		}
	}
	variants.delete(word);
	return Array.from(variants);
}

/** The 2026-08-21 incident classes applied to one canonical handle. */
function incidentVariants(kind: HandleKind, canonical: string): Record<string, string> {
	const words = wordsOf(canonical, kind);
	const body = words.join("-");
	const capitalizedWords = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("-");
	return {
		"trailing space": `${canonical} `,
		"leading and trailing whitespace": `  ${canonical}\n`,
		"inner space": `${kind.name}_${words.join(" ")}`,
		"space around separator": `${kind.name}_${words.join(" - ")}`,
		capitalized: `${kind.name}_${capitalizedWords}`,
		"kind uppercase": `${kind.name.toUpperCase()}_${body}`,
		"all caps": canonical.toUpperCase(),
		"trailing quote": `${canonical}"`,
		"trailing period": `${canonical}.`,
		"wrapped in backticks": `\`${canonical}\``,
		"wrapped in brackets": `[${canonical}]`,
		"wrapped in quotes": `"${canonical}"`,
		"wrapped in angle brackets": `<${canonical}>`,
		"underscore separators": `${kind.name}_${words.join("_")}`,
		"hyphen kind separator": `${kind.name}-${body}`,
		"colon kind separator": `${kind.name}: ${body}`,
		"space kind separator": `${kind.name} ${body}`,
		"double hyphen": `${kind.name}_${words.join("--")}`,
	};
}

function randomIssuableWord(seed: number): string {
	return ISSUABLE_HANDLE_WORDS[seed % ISSUABLE_HANDLE_WORDS.length]!;
}

describe("handle kinds", () => {
	it("defineCursor/defineDraft satisfy HandleKindDeclaration and apply defaults", () => {
		const declarations: HandleKindDeclaration[] = [BoundPage, PublicPage, WaitingDraft];
		expect(declarations.map((kind) => kind.name)).toEqual(["page", "pub", "waiting"]);
		expect(BoundPage.access).toBe("bound");
		expect(BoundPage.wordCount).toBe(2);
		expect(BoundPage.maxEntries).toBe(200);
		expect(BoundPage.maxValueBytes).toBe(16_000);
		expect(PublicPage.wordCount).toBe(4);
		expect(WaitingDraft.access).toBe("bound");
		expect(WaitingDraft.wordCount).toBe(2);
		expect(WaitingDraft.maxValueBytes).toBe(64_000);
		expect(WaitingDraft.resultTtlMs).toBe(24 * 60 * MINUTE);
		const defaulted = defineDraft({
			name: "cart",
			schema: z.object({}),
			ttl: { idle: "5m", max: "1h" },
		});
		expect(defaulted.fieldName).toBe("cart_token");
		expect(defaulted.resultTtl).toBe("24h");
	});

	it("uses 5 words for public cursors with strength high or ttl > 1h", () => {
		const high = defineCursor({
			name: "high",
			schema: PageSchema,
			ttl: "10m",
			access: "public",
			maxEntries: 10,
			strength: "high",
		});
		const long = defineCursor({
			name: "long",
			schema: PageSchema,
			ttl: "61m",
			access: "public",
			maxEntries: 10,
		});
		const exactlyOneHour = defineCursor({
			name: "hour",
			schema: PageSchema,
			ttl: "1h",
			access: "public",
			maxEntries: 10,
		});
		expect(high.wordCount).toBe(5);
		expect(long.wordCount).toBe(5);
		expect(exactlyOneHour.wordCount).toBe(4);
	});

	it("rejects invalid kind names, public cursors without maxEntries, and bad ttls", () => {
		expect(() => defineCursor({ name: "Page", schema: PageSchema, ttl: "10m" })).toThrow(
			/kind name must match/,
		);
		expect(() => defineCursor({ name: "p", schema: PageSchema, ttl: "10m" })).toThrow(
			/kind name must match/,
		);
		expect(() => defineCursor({ name: "page_v1", schema: PageSchema, ttl: "10m" })).toThrow(
			/kind name must match/,
		);
		expect(() =>
			defineCursor({ name: "page", schema: PageSchema, ttl: "10m", access: "public" }),
		).toThrow(/must declare maxEntries/);
		expect(() =>
			defineDraft({ name: "wait", schema: WaitingSchema, ttl: { idle: "3h", max: "2h" } }),
		).toThrow(/ttl.idle .* must not exceed ttl.max/);
		expect(() => defineCursor({ name: "page", schema: PageSchema, ttl: "PTx" })).toThrow(
			/positive duration/,
		);
		expect(defineCursor({ name: "iso", schema: PageSchema, ttl: "PT30M" }).ttlMs).toBe(30 * MINUTE);
	});

	it("kind.field() carries the x-apifuse-handle meta and SDK-owned description", () => {
		const field = WaitingDraft.field();
		const meta = field.meta();
		expect(meta?.description).toBe(
			"Opaque handle issued by `waiting-prepare`. Copy it exactly as returned; do not edit or shorten it.",
		);
		const handleMeta = meta?.[APIFUSE_HANDLE_META_KEY];
		expect(isHandleFieldMeta(handleMeta)).toBe(true);
		expect(handleMeta).toEqual({
			kind: "waiting",
			type: "draft",
			fieldName: "waiting_token",
			issuedBy: "waiting-prepare",
		});
		expect(field.safeParse("").success).toBe(false);
		expect(field.safeParse("waiting_visor-anagram").success).toBe(true);
		const anonymous = defineCursor({ name: "anon", schema: PageSchema, ttl: "1m" }).field();
		expect(anonymous.meta()?.description).toBe(
			"Opaque handle. Copy it exactly as returned; do not edit or shorten it.",
		);
		expect(anonymous.meta()?.[APIFUSE_HANDLE_META_KEY]).toEqual({
			kind: "anon",
			type: "cursor",
			fieldName: "anon_token",
		});
	});
});

describe("ctx.handle create/read", () => {
	it("round-trips a bound cursor, a public cursor, and a draft", async () => {
		const ctx = createTestHandleContext();
		const data = { query: "sushi", page: 2 };

		const bound = await ctx.create(BoundPage, data);
		expect(wordsOf(bound, BoundPage)).toHaveLength(2);
		const boundRecord = await ctx.read(BoundPage, bound);
		expect(boundRecord.handle).toBe(bound);
		expect(boundRecord.kind).toBe("page");
		expect(boundRecord.status).toBe("active");
		expect(boundRecord.data).toEqual(data);
		expect(boundRecord.result).toBeUndefined();

		const pub = await ctx.create(PublicPage, data);
		expect(wordsOf(pub, PublicPage)).toHaveLength(4);
		expect((await ctx.read(PublicPage, pub)).data).toEqual(data);

		const draft = await ctx.create(WaitingDraft, waitingData());
		expect(wordsOf(draft, WaitingDraft)).toHaveLength(2);
		const draftRecord = await ctx.read(WaitingDraft, draft);
		expect(draftRecord.status).toBe("active");
		expect(draftRecord.data.tables.map((table) => table.table)).toEqual(["hall", "terrace"]);
	});

	it("issues only wordlist words, never the hyphenated entry, with 5 words for high kinds", async () => {
		const High = defineCursor({
			name: "high",
			schema: PageSchema,
			ttl: "10m",
			access: "public",
			maxEntries: 1_000,
			strength: "high",
		});
		const ctx = createTestHandleContext();
		for (let index = 0; index < 50; index += 1) {
			const handle = await ctx.create(High, { query: "q", page: index });
			const words = wordsOf(handle, High);
			expect(words).toHaveLength(5);
			expect(words.every((word) => isHandleWord(word) && !word.includes("-"))).toBe(true);
			expect(handle).toBe(normalizeHandle(High, handle).canonical);
		}
	});

	it("validates data with the kind schema on create (provider bug → internal_error)", async () => {
		const ctx = createTestHandleContext();
		const invalidData: unknown = { query: 1, page: "x" };
		const error = await expectHandleError(
			ctx.create(BoundPage, invalidData as DataOf<typeof BoundPage>),
			"HANDLE_INVALID_DATA",
		);
		expect(error.options?.category).toBe("internal_error");
		expect(error.options?.retryable).toBe(false);
		expect(error.message).toContain("provider bug");
	});

	it("stores schema output rather than raw input", async () => {
		const Trimmed = defineCursor({
			name: "trim",
			schema: z.object({ q: z.string().trim().toLowerCase() }),
			ttl: "1m",
		});
		const ctx = createTestHandleContext();
		const handle = await ctx.create(Trimmed, { q: "  Sushi " });
		expect((await ctx.read(Trimmed, handle)).data).toEqual({ q: "sushi" });
	});

	it("isolates bound handles per connection while public handles are shared", async () => {
		const state = createMemoryProviderRuntimeState();
		const alice = createTestHandleContext({
			state,
			request: { headers: {}, connectionId: "alice" },
		});
		const bob = createTestHandleContext({ state, request: { headers: {}, connectionId: "bob" } });

		const boundHandle = await alice.create(BoundPage, { query: "q", page: 1 });
		const draftHandle = await alice.create(WaitingDraft, waitingData());
		await expect(alice.read(BoundPage, boundHandle)).resolves.toBeDefined();
		const notFound = await expectHandleError(bob.read(BoundPage, boundHandle), "HANDLE_NOT_FOUND");
		expect(notFound.options?.category).toBe("input_validation");
		expect(notFound.message).toBe(
			"`cursor` was not found; it may have expired or belong to another session. Call `search` again and pass the new `cursor` exactly as returned.",
		);
		await expectHandleError(bob.read(WaitingDraft, draftHandle), "HANDLE_NOT_FOUND");
		await expectHandleError(
			bob.update(WaitingDraft, draftHandle, (data) => data),
			"HANDLE_NOT_FOUND",
		);
		await expectHandleError(
			bob.commit(WaitingDraft, draftHandle, async () => ({ waitingId: "x" })),
			"HANDLE_NOT_FOUND",
		);
		// Bob discarding Alice's handle is a no-op in his own scope.
		await bob.discard(BoundPage, boundHandle);
		await expect(alice.read(BoundPage, boundHandle)).resolves.toBeDefined();

		const publicHandle = await alice.create(PublicPage, { query: "q", page: 3 });
		expect((await bob.read(PublicPage, publicHandle)).data).toEqual({ query: "q", page: 3 });
	});

	it("requires a connectionId for bound kinds and not for public kinds", async () => {
		const ctx = createTestHandleContext({ request: { headers: {} } });
		const error = await expectHandleError(
			ctx.create(BoundPage, { query: "q", page: 1 }),
			"HANDLE_CONNECTION_REQUIRED",
		);
		expect(error.options?.category).toBe("internal_error");
		expect(error.message).toContain("request.connectionId is missing");
		await expectHandleError(ctx.create(WaitingDraft, waitingData()), "HANDLE_CONNECTION_REQUIRED");
		await expectHandleError(
			ctx.read(BoundPage, "page_visor-anagram"),
			"HANDLE_CONNECTION_REQUIRED",
		);
		const publicHandle = await ctx.create(PublicPage, { query: "q", page: 1 });
		expect((await ctx.read(PublicPage, publicHandle)).data.page).toBe(1);
	});

	it("reports HANDLE_STORAGE_UNAVAILABLE without state, with unsupported state, and past quota", async () => {
		const noState = createHandleContext({
			providerId: "p",
			request: { headers: {}, connectionId: "c" },
		});
		const noStateError = await expectHandleError(
			noState.create(BoundPage, { query: "q", page: 1 }),
			"HANDLE_STORAGE_UNAVAILABLE",
		);
		expect(noStateError.options?.category).toBe("internal_error");

		const unsupported = createTestHandleContext({ state: createUnsupportedProviderRuntimeState() });
		await expectHandleError(
			unsupported.create(BoundPage, { query: "q", page: 1 }),
			"HANDLE_STORAGE_UNAVAILABLE",
		);
		await expectHandleError(
			unsupported.read(BoundPage, "page_visor-anagram"),
			"HANDLE_STORAGE_UNAVAILABLE",
		);

		const Tiny = defineCursor({ name: "tiny", schema: PageSchema, ttl: "1m", maxEntries: 2 });
		const ctx = createTestHandleContext();
		await ctx.create(Tiny, { query: "q", page: 1 });
		await ctx.create(Tiny, { query: "q", page: 2 });
		const quota = await expectHandleError(
			ctx.create(Tiny, { query: "q", page: 3 }),
			"HANDLE_STORAGE_UNAVAILABLE",
		);
		expect(quota.message).toContain("quota");
	});

	it("rejects records above maxValueBytes with HANDLE_TOO_LARGE before writing", async () => {
		const Small = defineCursor({
			name: "small",
			schema: z.object({ blob: z.string() }),
			ttl: "1m",
			maxValueBytes: 200,
		});
		const ctx = createTestHandleContext();
		const error = await expectHandleError(
			ctx.create(Small, { blob: "x".repeat(300) }),
			"HANDLE_TOO_LARGE",
		);
		expect(error.options?.category).toBe("internal_error");
		expect(error.options?.details).toMatchObject({ maxValueBytes: 200 });
		const SmallDraft = defineDraft({
			name: "sdraft",
			schema: z.object({ blob: z.string() }),
			ttl: { idle: "1m", max: "2m" },
			maxValueBytes: 300,
		});
		const handle = await ctx.create(SmallDraft, { blob: "ok" });
		await expectHandleError(
			ctx.update(SmallDraft, handle, () => ({ blob: "y".repeat(400) })),
			"HANDLE_TOO_LARGE",
		);
		expect((await ctx.read(SmallDraft, handle)).data.blob).toBe("ok");
	});
});

describe("ctx.handle expiry classification", () => {
	it("bound: absent → NOT_FOUND, present past max → EXPIRED; public collapses to INVALID", async () => {
		const clock = fakeClock();
		const ctx = createTestHandleContext({ nowMs: clock.nowMs });
		const bound = await ctx.create(BoundPage, { query: "q", page: 1 });
		const pub = await ctx.create(PublicPage, { query: "q", page: 1 });
		const draft = await ctx.create(WaitingDraft, waitingData());

		clock.advance(11 * MINUTE);
		const expired = await expectHandleError(ctx.read(BoundPage, bound), "HANDLE_EXPIRED");
		expect(expired.message).toBe(
			"`cursor` expired after 10 minutes. Call `search` again and pass the new `cursor` exactly as returned.",
		);
		const collapsed = await expectHandleError(ctx.read(PublicPage, pub), "HANDLE_INVALID");
		expect(collapsed.message).toBe(
			"`page_token` is not valid or has expired. Call `search` again to get a new one.",
		);
		// Draft max is 2h: still alive at 11 minutes, expired after.
		expect((await ctx.read(WaitingDraft, draft)).status).toBe("active");
		clock.advance(110 * MINUTE);
		const draftExpired = await expectHandleError(ctx.read(WaitingDraft, draft), "HANDLE_EXPIRED");
		expect(draftExpired.message).toContain("expired after 120 minutes");
		expect(draftExpired.message).toContain("Call `waiting-prepare` again");

		const missing = await expectHandleError(
			ctx.read(BoundPage, "page_visor-anagram"),
			"HANDLE_NOT_FOUND",
		);
		expect(missing.options?.retryable).toBe(false);
		await expectHandleError(
			ctx.read(PublicPage, "pub_visor-anagram-atlas-cobweb"),
			"HANDLE_INVALID",
		);
	});
});

describe("normalization", () => {
	it("returns the canonical form with no classes for canonical input", () => {
		const result = normalizeHandle(BoundPage, "page_visor-anagram");
		expect(result).toEqual({
			canonical: "page_visor-anagram",
			words: ["visor", "anagram"],
			normalization: [],
		});
	});

	it("resolves every 2026-08-21 incident class to the canonical handle with the right classes", () => {
		const canonical = "page_visor-anagram";
		const expectedClasses: Record<string, string[]> = {
			"trailing space": ["whitespace"],
			"leading and trailing whitespace": ["whitespace"],
			"inner space": ["separator", "whitespace"],
			"space around separator": ["whitespace"],
			capitalized: ["case"],
			"kind uppercase": ["case"],
			"all caps": ["case"],
			"trailing quote": ["punctuation"],
			"trailing period": ["punctuation"],
			"wrapped in backticks": ["punctuation"],
			"wrapped in brackets": ["punctuation"],
			"wrapped in quotes": ["punctuation"],
			"wrapped in angle brackets": ["punctuation"],
			"underscore separators": ["separator"],
			"hyphen kind separator": ["separator"],
			"colon kind separator": ["separator", "whitespace"],
			"space kind separator": ["separator", "whitespace"],
			"double hyphen": ["separator"],
		};
		for (const [label, raw] of Object.entries(incidentVariants(BoundPage, canonical))) {
			const result = normalizeHandle(BoundPage, raw);
			expect(result.canonical, label).toBe(canonical);
			expect(result.normalization, label).toEqual(expectedClasses[label]!);
		}
		const typo = normalizeHandle(BoundPage, "Page_vizor-anagram ");
		expect(typo.canonical).toBe(canonical);
		expect(typo.normalization).toEqual(["case", "typo", "whitespace"]);
	});

	it("resolves every single-character edit of every issuable word back to the canonical handle", () => {
		const partner = "anagram";
		let checked = 0;
		for (const word of ISSUABLE_HANDLE_WORDS) {
			if (word === partner) continue;
			const canonical = `page_${word}-${partner}`;
			for (const variant of singleEditVariants(word)) {
				const result = normalizeHandle(BoundPage, `page_${variant}-${partner}`);
				if (result.canonical !== canonical) {
					throw new Error(
						`page_${variant}-${partner} → ${result.canonical}, expected ${canonical}`,
					);
				}
				checked += 1;
			}
		}
		expect(checked).toBeGreaterThan(HANDLE_WORDLIST_SIZE * 100);
	}, 60_000);

	it("keeps normalization many-to-one: 200 sampled handles never share a normalized input", () => {
		const sample = new Set<string>();
		let seed = 7;
		while (sample.size < 200) {
			seed = (seed * 48_271) % 2_147_483_647;
			const first = randomIssuableWord(seed);
			seed = (seed * 48_271) % 2_147_483_647;
			const second = randomIssuableWord(seed);
			sample.add(`page_${first}-${second}`);
		}
		const inputToCanonical = new Map<string, string>();
		for (const canonical of sample) {
			const words = wordsOf(canonical, BoundPage);
			const inputs = [
				canonical,
				...Object.values(incidentVariants(BoundPage, canonical)),
				// One typo per word (substitution in the middle) and a swapped separator.
				`page_${words[0]!.slice(0, 1)}q${words[0]!.slice(2)}-${words[1]}`,
				`page_${words[0]}-${words[1]!.slice(0, 1)}q${words[1]!.slice(2)}`,
				`Page ${words[0]}_${words[1]}.`,
			];
			for (const input of inputs) {
				expect(normalizeHandle(BoundPage, input).canonical, input).toBe(canonical);
				const owner = inputToCanonical.get(input);
				if (owner !== undefined && owner !== canonical) {
					throw new Error(`Input "${input}" is shared by ${owner} and ${canonical}`);
				}
				inputToCanonical.set(input, canonical);
			}
		}
		expect(inputToCanonical.size).toBeGreaterThan(200 * 20);
	});

	it("accepts 4 or 5 words for public kinds but exactly 2 for bound kinds", () => {
		expect(normalizeHandle(PublicPage, "pub_visor-anagram-atlas-cobweb").words).toHaveLength(4);
		expect(normalizeHandle(PublicPage, "pub_visor-anagram-atlas-cobweb-onion").words).toHaveLength(
			5,
		);
		expect(() => normalizeHandle(PublicPage, "pub_visor-anagram")).toThrow(HandleError);
		expect(() => normalizeHandle(BoundPage, "page_visor-anagram-atlas")).toThrow(HandleError);
	});

	it("throws HANDLE_KIND_MISMATCH when the string does not start with the kind name", async () => {
		const ctx = createTestHandleContext();
		const draft = await ctx.create(WaitingDraft, waitingData());
		const error = await expectHandleError(ctx.read(BoundPage, draft), "HANDLE_KIND_MISMATCH");
		expect(error.options?.category).toBe("input_validation");
		expect(error.message).toBe(
			"`cursor` must be a `page_...` handle as returned by `search`. Call `search` again and pass the new `cursor` exactly as returned.",
		);
		expect(() => normalizeHandle(BoundPage, "pages_visor-anagram")).toThrow(/must be a `page_...`/);
		expect(() => normalizeHandle(BoundPage, "")).toThrow(HandleError);
		// Public kinds also disclose kind mismatch (shape check, not existence).
		const publicMismatch = await expectHandleError(
			ctx.read(PublicPage, "page_visor-anagram"),
			"HANDLE_KIND_MISMATCH",
		);
		expect(publicMismatch.message).toContain("`pub_...`");
	});

	it("reports invalid shapes: bound discloses the reason, public collapses", async () => {
		const ctx = createTestHandleContext();
		const bound = await expectHandleError(
			ctx.read(BoundPage, "page_notaword-anagram"),
			"HANDLE_INVALID",
		);
		expect(bound.message).toContain("unknown word");
		expect(bound.message).toContain("Call `search` again");
		const shortBound = await expectHandleError(ctx.read(BoundPage, "page_visor"), "HANDLE_INVALID");
		expect(shortBound.message).toContain("expected 2 words");
		const pub = await expectHandleError(
			ctx.read(PublicPage, "pub_visor-anagram"),
			"HANDLE_INVALID",
		);
		expect(pub.message).toBe(
			"`page_token` is not valid or has expired. Call `search` again to get a new one.",
		);
		await expectHandleError(ctx.read(BoundPage, "page_"), "HANDLE_INVALID");
		await expectHandleError(ctx.read(BoundPage, "page_visor-"), "HANDLE_INVALID");
	});

	it("only repairs one edit per word: two edits stay invalid instead of guessing", () => {
		expect(findHandleWordWithinDistance("vizor", 1)).toBe("visor");
		expect(findHandleWordWithinDistance("vizzr", 1)).toBeNull();
		expect(() => normalizeHandle(BoundPage, "page_vizzr-anagram")).toThrow(HandleError);
	});
});

describe("drafts: update, commit, discard", () => {
	it("updates with CAS and slides the idle ttl bounded by max (fake clock)", async () => {
		const clock = fakeClock();
		const ctx = createTestHandleContext({ nowMs: clock.nowMs });
		const handle = await ctx.create(WaitingDraft, waitingData());

		const initial = await ctx.read(WaitingDraft, handle);
		expect(initial.createdAt).toBe(new Date(T0).toISOString());
		expect(initial.expiresAt).toBe(new Date(T0 + 30 * MINUTE).toISOString());

		clock.advance(20 * MINUTE);
		const touched = await ctx.read(WaitingDraft, handle);
		expect(touched.expiresAt).toBe(new Date(T0 + 50 * MINUTE).toISOString());

		clock.advance(20 * MINUTE);
		const updated = await ctx.update(WaitingDraft, handle, (data) => ({
			...data,
			selections: { ...data.selections, table: "hall" },
		}));
		expect(updated.data.selections).toEqual({ table: "hall" });
		expect(updated.status).toBe("active");
		expect(updated.expiresAt).toBe(new Date(T0 + 70 * MINUTE).toISOString());
		expect((await ctx.read(WaitingDraft, handle)).data.selections).toEqual({ table: "hall" });

		// Keep touching inside the idle window; near max the sliding ttl is
		// clamped to the remaining lifetime.
		clock.advance(25 * MINUTE); // T0 + 65m
		expect((await ctx.read(WaitingDraft, handle)).expiresAt).toBe(
			new Date(T0 + 95 * MINUTE).toISOString(),
		);
		clock.advance(25 * MINUTE); // T0 + 90m
		const clamped = await ctx.read(WaitingDraft, handle);
		expect(clamped.expiresAt).toBe(new Date(T0 + 120 * MINUTE).toISOString());

		clock.advance(31 * MINUTE); // T0 + 121m
		await expectHandleError(ctx.read(WaitingDraft, handle), "HANDLE_EXPIRED");
		await expectHandleError(
			ctx.update(WaitingDraft, handle, (data) => data),
			"HANDLE_EXPIRED",
		);
	});

	it("expires an untouched draft after the idle ttl even though max is far away", async () => {
		const clock = fakeClock();
		const ctx = createTestHandleContext({ nowMs: clock.nowMs });
		const handle = await ctx.create(WaitingDraft, waitingData());
		clock.advance(31 * MINUTE);
		await expectHandleError(ctx.read(WaitingDraft, handle), "HANDLE_EXPIRED");
		// Still distinguishable from an unknown handle for the whole grace window.
		clock.advance(60 * MINUTE + 29 * MINUTE);
		await expectHandleError(ctx.read(WaitingDraft, handle), "HANDLE_EXPIRED");
		// Drafts are kept until max + grace (2h + 1h); after that they are gone.
		clock.advance(61 * MINUTE);
		await expectHandleError(ctx.read(WaitingDraft, handle), "HANDLE_NOT_FOUND");
	});

	it("update supports async updaters and validates the result", async () => {
		const ctx = createTestHandleContext();
		const handle = await ctx.create(WaitingDraft, waitingData());
		const updated = await ctx.update(WaitingDraft, handle, async (data) => ({
			...data,
			shop: "shop-2",
		}));
		expect(updated.data.shop).toBe("shop-2");
		const invalid: unknown = { shop: 42 };
		const error = await expectHandleError(
			ctx.update(WaitingDraft, handle, () => invalid as DataOf<typeof WaitingDraft>),
			"HANDLE_INVALID_DATA",
		);
		expect(error.options?.category).toBe("internal_error");
		expect((await ctx.read(WaitingDraft, handle)).data.shop).toBe("shop-2");
	});

	it("update retries CAS against a concurrent writer and applies on top of the latest data", async () => {
		const state = createMemoryProviderRuntimeState();
		const ctx = createTestHandleContext({ state });
		const handle = await ctx.create(WaitingDraft, waitingData());
		let interfered = false;
		const updated = await ctx.update(WaitingDraft, handle, async (data) => {
			if (!interfered) {
				interfered = true;
				// A concurrent request writes first; our first CAS must lose and retry.
				await ctx.update(WaitingDraft, handle, (current) => ({
					...current,
					selections: { ...current.selections, party: "4" },
				}));
			}
			return { ...data, selections: { ...data.selections, table: "hall" } };
		});
		expect(updated.data.selections).toEqual({ party: "4", table: "hall" });
	});

	it("commit runs work once, then replays the stored result", async () => {
		const clock = fakeClock();
		const ctx = createTestHandleContext({ nowMs: clock.nowMs });
		const handle = await ctx.create(WaitingDraft, waitingData());
		let runs = 0;
		const first = await ctx.commit(WaitingDraft, handle, async (data) => {
			runs += 1;
			expect(data.shop).toBe("shop-1");
			return { waitingId: "W-1" };
		});
		expect(first).toEqual({ status: "committed", handle, result: { waitingId: "W-1" } });

		const record = await ctx.read(WaitingDraft, handle);
		expect(record.status).toBe("committed");
		expect(record.result).toEqual({ waitingId: "W-1" });
		// Committed records keep the result for resultTtl (24h), not the draft max (2h).
		expect(record.expiresAt).toBe(new Date(T0 + 24 * 60 * MINUTE).toISOString());

		clock.advance(3 * 60 * MINUTE);
		const replay = await ctx.commit(WaitingDraft, handle, async () => {
			runs += 1;
			return { waitingId: "W-2" };
		});
		expect(replay).toEqual({ status: "replayed", handle, result: { waitingId: "W-1" } });
		expect(runs).toBe(1);

		// Past resultTtl (24h) but inside the expiry grace window: still EXPIRED,
		// not NOT_FOUND, so the model learns the flow finished long ago.
		clock.advance(21 * 60 * MINUTE + 30 * MINUTE);
		await expectHandleError(
			ctx.commit(WaitingDraft, handle, async () => ({ waitingId: "W-3" })),
			"HANDLE_EXPIRED",
		);
		// After the grace window the record is gone.
		clock.advance(60 * MINUTE);
		await expectHandleError(
			ctx.commit(WaitingDraft, handle, async () => ({ waitingId: "W-4" })),
			"HANDLE_NOT_FOUND",
		);
	});

	it("commit failure restores the draft to active so it can be retried", async () => {
		const ctx = createTestHandleContext();
		const handle = await ctx.create(WaitingDraft, waitingData());
		await expect(
			ctx.commit(WaitingDraft, handle, async () => {
				throw new ProviderError("upstream down", { code: "UPSTREAM", retryable: true });
			}),
		).rejects.toMatchObject({ code: "UPSTREAM" });
		const record = await ctx.read(WaitingDraft, handle);
		expect(record.status).toBe("active");
		expect(record.result).toBeUndefined();
		const retried = await ctx.commit(WaitingDraft, handle, async () => ({ waitingId: "W-9" }));
		expect(retried.status).toBe("committed");
	});

	it("concurrent commit while another is in flight → HANDLE_BUSY (retryable)", async () => {
		const ctx = createTestHandleContext();
		const handle = await ctx.create(WaitingDraft, waitingData());
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const inFlight = ctx.commit(WaitingDraft, handle, async () => {
			await gate;
			return { waitingId: "W-1" };
		});
		// Let the first commit claim the record.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const busy = await expectHandleError(
			ctx.commit(WaitingDraft, handle, async () => ({ waitingId: "W-2" })),
			"HANDLE_BUSY",
		);
		expect(busy.options?.retryable).toBe(true);
		expect(busy.options?.category).toBe("internal_error");
		await expectHandleError(
			ctx.update(WaitingDraft, handle, (data) => data),
			"HANDLE_BUSY",
		);
		expect((await ctx.read(WaitingDraft, handle)).status).toBe("committing");
		release!();
		expect((await inFlight).status).toBe("committed");
		const replay = await ctx.commit(WaitingDraft, handle, async () => ({ waitingId: "W-2" }));
		expect(replay).toEqual({ status: "replayed", handle, result: { waitingId: "W-1" } });
	});

	it("update after commit → HANDLE_COMMITTED", async () => {
		const ctx = createTestHandleContext();
		const handle = await ctx.create(WaitingDraft, waitingData());
		await ctx.commit(WaitingDraft, handle, async () => ({ waitingId: "W-1" }));
		const error = await expectHandleError(
			ctx.update(WaitingDraft, handle, (data) => data),
			"HANDLE_COMMITTED",
		);
		expect(error.options?.category).toBe("input_validation");
		expect(error.message).toContain("already been committed");
		expect(error.message).toContain("Call `waiting-prepare` again");
	});

	it("discard removes the record and is idempotent", async () => {
		const ctx = createTestHandleContext();
		const handle = await ctx.create(WaitingDraft, waitingData());
		await ctx.discard(WaitingDraft, ` ${handle.toUpperCase()} `);
		await expectHandleError(ctx.read(WaitingDraft, handle), "HANDLE_NOT_FOUND");
		await ctx.discard(WaitingDraft, handle);
		const cursor = await ctx.create(PublicPage, { query: "q", page: 1 });
		await ctx.discard(PublicPage, cursor);
		await expectHandleError(ctx.read(PublicPage, cursor), "HANDLE_INVALID");
		await expectHandleError(ctx.discard(PublicPage, "page_visor-anagram"), "HANDLE_KIND_MISMATCH");
	});

	it("draft without a result schema types the commit result as unknown", async () => {
		const Plain = defineDraft({
			name: "plain",
			schema: z.object({ n: z.number() }),
			ttl: { idle: "1m", max: "5m" },
		});
		const ctx = createTestHandleContext();
		const handle = await ctx.create(Plain, { n: 1 });
		const committed = await ctx.commit(Plain, handle, async (data) => ({ doubled: data.n * 2 }));
		const result: ResultOf<typeof Plain> = committed.result;
		expect(result).toEqual({ doubled: 2 });
	});
});

describe("pick", () => {
	const tables = [
		{ table: "hall", label: "Hall" },
		{ table: "Terrace", label: "Terrace" },
		{ table: "bar", label: "Bar" },
	];

	it("matches exactly, then uniquely case-insensitively with trimming", () => {
		expect(pick(tables, "hall", { field: "table" })).toBe(tables[0]!);
		expect(pick(tables, "terrace", { field: "table" })).toBe(tables[1]!);
		expect(pick(tables, "  BAR ", { field: "table" })).toBe(tables[2]!);
		expect(pick(tables, "Bar", { field: "table_choice", by: "label" })).toBe(tables[2]!);
	});

	it("throws PICK_NOT_OFFERED with the allowed values and the issuing operation", () => {
		let caught: unknown;
		try {
			pick(tables, "patio", { field: "table", issuedBy: "waiting-prepare" });
		} catch (error) {
			caught = error;
		}
		if (!(caught instanceof HandleError)) throw new Error("Expected HandleError");
		expect(caught.code).toBe("PICK_NOT_OFFERED");
		expect(caught.options?.category).toBe("input_validation");
		expect(caught.options?.retryable).toBe(false);
		expect(caught.details).toEqual({ field: "table", allowed: ["hall", "Terrace", "bar"] });
		expect(caught.message).toBe(
			"`table` must be one of: hall, Terrace, bar. Use the values exactly as listed by `waiting-prepare`.",
		);
		expect(() => pick(tables, "patio", { field: "table" })).toThrow(
			"`table` must be one of: hall, Terrace, bar. Use the values exactly as listed.",
		);
	});

	it("does not resolve ambiguous case-insensitive matches", () => {
		const ambiguous = [{ id: "A" }, { id: "a" }];
		expect(pick(ambiguous, "a", { field: "id" })).toBe(ambiguous[1]!);
		expect(() => pick(ambiguous, "A ", { field: "id" })).toThrow(HandleError);
	});
});

describe("HandleError", () => {
	it("extends ProviderError with code, category, retryable, and kind", () => {
		const error = new HandleError("HANDLE_BUSY", "busy", { kind: "waiting" });
		expect(error).toBeInstanceOf(ProviderError);
		expect(error.name).toBe("HandleError");
		expect(error.code).toBe("HANDLE_BUSY");
		expect(error.kind).toBe("waiting");
		expect(error.options?.category).toBe("internal_error");
		expect(error.options?.retryable).toBe(true);
		const overridden = new HandleError("HANDLE_INVALID", "x", { retryable: true });
		expect(overridden.options?.retryable).toBe(true);
		expect(overridden.options?.category).toBe("input_validation");
	});
});

describe("telemetry", () => {
	function collect(): {
		events: HandleTelemetryEvent[];
		onTelemetry: (e: HandleTelemetryEvent) => void;
	} {
		const events: HandleTelemetryEvent[] = [];
		return { events, onTelemetry: (event) => events.push(event) };
	}

	it("emits one allowlisted event per operation with no handle, data, or result values", async () => {
		const { events, onTelemetry } = collect();
		const ctx = createTestHandleContext({ providerId: "catchtable", onTelemetry });
		const secretShop = "SECRET-SHOP-VALUE";
		const secretResult = "SECRET-RESULT-VALUE";
		const handle = await ctx.create(WaitingDraft, { ...waitingData(), shop: secretShop });
		await ctx.read(WaitingDraft, ` ${handle.toUpperCase()}"`);
		await ctx.update(WaitingDraft, handle, (data) => data);
		await ctx.commit(WaitingDraft, handle, async () => ({ waitingId: secretResult }));
		await ctx.commit(WaitingDraft, handle, async () => ({ waitingId: "other" }));
		await ctx.discard(WaitingDraft, handle);
		await expectHandleError(ctx.read(WaitingDraft, handle), "HANDLE_NOT_FOUND");
		await expectHandleError(ctx.read(BoundPage, handle), "HANDLE_KIND_MISMATCH");
		await expectHandleError(ctx.read(WaitingDraft, "waiting_zzz-anagram"), "HANDLE_INVALID");

		const allowlist = [
			"providerId",
			"kind",
			"type",
			"operation",
			"outcome",
			"normalization",
			"words",
		];
		for (const event of events) {
			expect(Object.keys(event).sort()).toEqual([...allowlist].sort());
		}
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain(secretShop);
		expect(serialized).not.toContain(secretResult);
		for (const word of wordsOf(handle, WaitingDraft)) expect(serialized).not.toContain(word);

		expect(events.map((event) => [event.operation, event.outcome, event.normalization])).toEqual([
			["create", "success", "none"],
			["read", "success", "case+punctuation+whitespace"],
			["update", "success", "none"],
			["commit", "success", "none"],
			["commit", "replayed", "none"],
			["discard", "success", "none"],
			["read", "not_found", "none"],
			["read", "kind_mismatch", "none"],
			["read", "invalid", "none"],
		]);
		expect(events.every((event) => event.providerId === "catchtable")).toBe(true);
		expect(events.every((event) => event.kind === "waiting" || event.kind === "page")).toBe(true);
		expect(events[0]?.words).toBe(2);
		expect(events[1]?.words).toBe(2);
		expect(events[8]?.words).toBe(0);
	});

	it("reports expired and busy outcomes and survives a throwing sink", async () => {
		const { events, onTelemetry } = collect();
		const clock = fakeClock();
		const ctx = createTestHandleContext({
			nowMs: clock.nowMs,
			onTelemetry: (event) => {
				onTelemetry(event);
				throw new Error("sink exploded");
			},
		});
		const cursor = await ctx.create(BoundPage, { query: "q", page: 1 });
		clock.advance(11 * MINUTE);
		await expectHandleError(ctx.read(BoundPage, cursor), "HANDLE_EXPIRED");
		const pub = await ctx.create(PublicPage, { query: "q", page: 1 });
		clock.advance(11 * MINUTE);
		await expectHandleError(ctx.read(PublicPage, pub), "HANDLE_INVALID");
		expect(
			events.map((event) => [event.type, event.operation, event.outcome, event.words]),
		).toEqual([
			["cursor", "create", "success", 2],
			["cursor", "read", "expired", 2],
			["cursor", "create", "success", 4],
			["cursor", "read", "invalid", 4],
		]);
	});
});

describe("type-level contracts", () => {
	it("DataOf/ResultOf derive from the kind schemas", async () => {
		const ctx = createTestHandleContext();
		const cursor: CursorKind<typeof PageSchema> = BoundPage;
		const draft: DraftKind<typeof WaitingSchema, typeof WaitingResultSchema> = WaitingDraft;
		const handle = await ctx.create(cursor, { query: "q", page: 1 });
		const record = await ctx.read(cursor, handle);
		const page: number = record.data.page;
		expect(page).toBe(1);
		const draftHandle = await ctx.create(draft, waitingData());
		const committed = await ctx.commit(draft, draftHandle, async () => ({ waitingId: "W" }));
		const waitingId: string = committed.result.waitingId;
		expect(waitingId).toBe("W");
	});

	it("accepts the schema input type on writes and yields the output type on reads", async () => {
		const ctx = createTestHandleContext();
		const Defaulted = defineCursor({
			name: "defaulted",
			schema: z.object({ q: z.string(), size: z.number().int().default(10) }),
			ttl: "10m",
		});
		// `size` is optional on input (default) and required on output.
		const handle = await ctx.create(Defaulted, { q: "sushi" });
		const record = await ctx.read(Defaulted, handle);
		const size: number = record.data.size;
		expect(size).toBe(10);
	});
});

describe("codex review regressions (2026-09-08)", () => {
	it("rejects absurdly long segments without generating deletion variants", () => {
		const longSegment = "a".repeat(20_000);
		const started = performance.now();
		expect(findHandleWordWithinDistance(longSegment, 1)).toBeNull();
		expect(() => normalizeHandle(BoundPage, `page_${longSegment}-visor`)).toThrow(HandleError);
		expect(() => normalizeHandle(BoundPage, `page_${"x".repeat(300)}`)).toThrow(HandleError);
		// Bounded: no quadratic variant generation for garbage input.
		expect(performance.now() - started).toBeLessThan(200);
	});

	it("keeps a commit claim alive past the draft idle ttl so the result can be persisted and replayed", async () => {
		const ShortDraft = defineDraft({
			name: "shortdraft",
			schema: z.object({ v: z.string() }),
			result: z.object({ ok: z.boolean() }),
			ttl: { idle: "50ms", max: "10m" },
		});
		const ctx = createTestHandleContext();
		const handle = await ctx.create(ShortDraft, { v: "x" });
		let ran = 0;
		const committed = await ctx.commit(ShortDraft, handle, async () => {
			ran += 1;
			await new Promise((resolve) => setTimeout(resolve, 150));
			return { ok: true };
		});
		expect(committed.status).toBe("committed");
		const replayed = await ctx.commit(ShortDraft, handle, async () => {
			ran += 1;
			return { ok: false };
		});
		expect(replayed).toMatchObject({ status: "replayed", result: { ok: true } });
		expect(ran).toBe(1);
	});

	it("hands callbacks detached copies so a mutating, throwing callback cannot corrupt the stored draft", async () => {
		const Counter = defineDraft({
			name: "counter",
			schema: z.object({ n: z.number().int().min(0) }),
			ttl: { idle: "10m", max: "1h" },
		});
		const ctx = createTestHandleContext();
		const handle = await ctx.create(Counter, { n: 1 });
		await expect(
			ctx.commit(Counter, handle, async (data) => {
				(data as { n: number }).n = -1;
				throw new Error("upstream down");
			}),
		).rejects.toThrow("upstream down");
		const afterCommit = await ctx.read(Counter, handle);
		expect(afterCommit.status).toBe("active");
		expect(afterCommit.data).toEqual({ n: 1 });
		await expect(
			ctx.update(Counter, handle, (data) => {
				data.n = -5;
				throw new Error("changed my mind");
			}),
		).rejects.toThrow("changed my mind");
		const read = await ctx.read(Counter, handle);
		expect(read.data).toEqual({ n: 1 });
		// Mutating what read() returned does not touch storage either.
		read.data.n = 99;
		expect((await ctx.read(Counter, handle)).data).toEqual({ n: 1 });
	});

	it("rejects data JSON cannot persist faithfully (Date, Map, class instances) at write time", async () => {
		const Dated = defineCursor({
			name: "dated",
			schema: z.object({ when: z.date(), tags: z.set(z.string()).optional() }),
			ttl: "10m",
		});
		const ctx = createTestHandleContext();
		const error = await expectHandleError(
			ctx.create(Dated, { when: new Date(T0) }),
			"HANDLE_INVALID_DATA",
		);
		expect(error.message).toContain("data.when is not JSON-safe");
		const Loose = defineCursor({ name: "loose", schema: z.object({ v: z.unknown() }), ttl: "10m" });
		await expectHandleError(ctx.create(Loose, { v: new Map([["a", 1]]) }), "HANDLE_INVALID_DATA");
		await expectHandleError(ctx.create(Loose, { v: Number.NaN }), "HANDLE_INVALID_DATA");
		await expectHandleError(ctx.create(Loose, { v: [1, undefined] }), "HANDLE_INVALID_DATA");
		// Plain JSON values are fine, including nested arrays/objects and null.
		const ok = await ctx.create(Loose, { v: { a: [1, "two", null, { b: false }] } });
		expect((await ctx.read(Loose, ok)).data).toEqual({ v: { a: [1, "two", null, { b: false }] } });
	});

	it("rejects non-JSON-safe commit results and leaves the record committing (busy) rather than re-running work", async () => {
		const DatedResult = defineDraft({
			name: "datedres",
			schema: z.object({ v: z.string() }),
			result: z.object({ at: z.date() }),
			ttl: { idle: "10m", max: "1h" },
		});
		const ctx = createTestHandleContext();
		const handle = await ctx.create(DatedResult, { v: "x" });
		let runs = 0;
		const error = await expectHandleError(
			ctx.commit(DatedResult, handle, async () => {
				runs += 1;
				return { at: new Date(T0) };
			}),
			"HANDLE_INVALID_DATA",
		);
		expect(error.message).toContain("result.at is not JSON-safe");
		// The upstream work already ran once; it must not run again.
		await expectHandleError(
			ctx.commit(DatedResult, handle, async () => {
				runs += 1;
				return { at: new Date(T0) };
			}),
			"HANDLE_BUSY",
		);
		expect(runs).toBe(1);
	});

	it("stores detached snapshots so mutating inputs or returned results never rewrites the record", async () => {
		const Loose = defineDraft({
			name: "loosedraft",
			schema: z.object({ v: z.unknown() }),
			result: z.object({ id: z.string(), extra: z.unknown() }),
			ttl: { idle: "10m", max: "1h" },
		});
		const ctx = createTestHandleContext();
		const input = { v: { nested: ["a"] } };
		const handle = await ctx.create(Loose, input);
		(input.v.nested as string[]).push("b");
		expect((await ctx.read(Loose, handle)).data).toEqual({ v: { nested: ["a"] } });

		const first = await ctx.commit(Loose, handle, async () => ({ id: "r-1", extra: { n: 1 } }));
		(first.result as { id: string }).id = "tampered";
		(first.result.extra as { n: number }).n = 99;
		const replay = await ctx.commit(Loose, handle, async () => ({ id: "r-2", extra: {} }));
		expect(replay.result).toEqual({ id: "r-1", extra: { n: 1 } });
	});

	it("rejects undefined as the whole record payload", async () => {
		const Anything = defineCursor({ name: "anything", schema: z.unknown(), ttl: "10m" });
		const ctx = createTestHandleContext();
		await expectHandleError(ctx.create(Anything, undefined), "HANDLE_INVALID_DATA");
		const handle = await ctx.create(Anything, { ok: true });
		expect((await ctx.read(Anything, handle)).data).toEqual({ ok: true });
	});

	it("keeps a draft retryable when the commit callback fails after the idle deadline", async () => {
		const Quick = defineDraft({
			name: "quick",
			schema: z.object({ v: z.string() }),
			result: z.object({ ok: z.boolean() }),
			ttl: { idle: "1m", max: "1h" },
		});
		const clock = fakeClock();
		const ctx = createTestHandleContext({ nowMs: clock.nowMs });
		const handle = await ctx.create(Quick, { v: "x" });
		clock.advance(59_000);
		await expect(
			ctx.commit(Quick, handle, async () => {
				clock.advance(2_000); // upstream took 2s; idle deadline passed meanwhile
				throw new Error("upstream 502");
			}),
		).rejects.toThrow("upstream 502");
		const retried = await ctx.commit(Quick, handle, async () => ({ ok: true }));
		expect(retried.status).toBe("committed");
	});

	it("refuses to discard a draft that another caller is committing, so the result can still be persisted", async () => {
		const Slow = defineDraft({
			name: "slowdraft",
			schema: z.object({ v: z.string() }),
			result: z.object({ ok: z.boolean() }),
			ttl: { idle: "10m", max: "1h" },
		});
		const ctx = createTestHandleContext();
		const handle = await ctx.create(Slow, { v: "x" });
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const committing = ctx.commit(Slow, handle, async () => {
			await gate;
			return { ok: true };
		});
		// Let the commit claim the record before discarding.
		await new Promise((resolve) => setTimeout(resolve, 10));
		await expectHandleError(ctx.discard(Slow, handle), "HANDLE_BUSY");
		release?.();
		expect((await committing).status).toBe("committed");
		const replay = await ctx.commit(Slow, handle, async () => ({ ok: false }));
		expect(replay).toMatchObject({ status: "replayed", result: { ok: true } });
		// Discarding a committed record is allowed and idempotent.
		await ctx.discard(Slow, handle);
		await ctx.discard(Slow, handle);
		await expectHandleError(ctx.read(Slow, handle), "HANDLE_NOT_FOUND");
	});

	it("retries discard when a concurrent refresh wins the version race", async () => {
		const Cursorish = defineDraft({
			name: "racy",
			schema: z.object({ v: z.string() }),
			ttl: { idle: "10m", max: "1h" },
		});
		const inner = createMemoryProviderRuntimeState();
		let armed = false;
		// Wrap the state so the discard's compare-and-set loses once: a competing
		// touch bumps the version right before it.
		const racing: typeof inner = {
			forConnection: (id) => wrap(inner.forConnection(id)),
			namespace: (name, opts) => wrap(inner).namespace(name, opts),
		};
		function wrap(state: typeof inner): typeof inner {
			return {
				forConnection: (id) => wrap(state.forConnection(id)),
				namespace: (name, opts) => {
					const ns = state.namespace(name, opts);
					return {
						...ns,
						list: ns.list.bind(ns),
						get: ns.get.bind(ns),
						set: ns.set.bind(ns),
						patch: ns.patch.bind(ns),
						delete: ns.delete.bind(ns),
						increment: ns.increment.bind(ns),
						compareAndSet: async (key, expected, value, options) => {
							if (armed) {
								armed = false;
								const current = await ns.get(key);
								if (current) await ns.set(key, current.value, options); // bumps version
							}
							return ns.compareAndSet(key, expected, value, options);
						},
					};
				},
			};
		}
		const ctx = createHandleContext({
			providerId: "racy-provider",
			state: racing,
			request: { headers: {}, connectionId: "c" },
		});
		const handle = await ctx.create(Cursorish, { v: "x" });
		armed = true;
		await ctx.discard(Cursorish, handle);
		await expectHandleError(ctx.read(Cursorish, handle), "HANDLE_NOT_FOUND");
	});

	it("can discard a cursor whose ttl is shorter than the tombstone default", async () => {
		const Blink = defineCursor({
			name: "blink",
			schema: z.object({ v: z.string() }),
			ttl: "100ms",
		});
		const ctx = createTestHandleContext();
		const handle = await ctx.create(Blink, { v: "x" });
		await ctx.discard(Blink, handle);
		await expectHandleError(ctx.read(Blink, handle), "HANDLE_NOT_FOUND");
	});

	it("renews the commit claim while slow upstream work runs, then persists and replays the result", async () => {
		const Slow = defineDraft({
			name: "slowlease",
			schema: z.object({ v: z.string() }),
			result: z.object({ ok: z.boolean() }),
			ttl: { idle: "200ms", max: "1s" },
		});
		const ctx = createHandleContext({
			providerId: "lease-provider",
			state: createMemoryProviderRuntimeState(),
			request: { headers: {}, connectionId: "c" },
			commitLeaseMs: 120,
		});
		const handle = await ctx.create(Slow, { v: "x" });
		const committed = await ctx.commit(Slow, handle, async () => {
			await new Promise((resolve) => setTimeout(resolve, 400));
			return { ok: true };
		});
		expect(committed.status).toBe("committed");
		const replay = await ctx.commit(Slow, handle, async () => ({ ok: false }));
		expect(replay).toMatchObject({ status: "replayed", result: { ok: true } });
	});

	it("retries a transient storage failure while persisting the commit result", async () => {
		const Flaky = defineDraft({
			name: "flaky",
			schema: z.object({ v: z.string() }),
			result: z.object({ ok: z.boolean() }),
			ttl: { idle: "10m", max: "1h" },
		});
		const inner = createMemoryProviderRuntimeState();
		let failNext = false;
		function wrap(state: typeof inner): typeof inner {
			return {
				forConnection: (id) => wrap(state.forConnection(id)),
				namespace: (name, opts) => {
					const ns = state.namespace(name, opts);
					return {
						...ns,
						list: ns.list.bind(ns),
						get: ns.get.bind(ns),
						set: ns.set.bind(ns),
						patch: ns.patch.bind(ns),
						delete: ns.delete.bind(ns),
						increment: ns.increment.bind(ns),
						compareAndSet: async (key, expected, value, options) => {
							if (failNext) {
								failNext = false;
								throw new ProviderError("Provider runtime state Redis timed out", {
									code: "PROVIDER_STATE_UNSUPPORTED",
								});
							}
							return ns.compareAndSet(key, expected, value, options);
						},
					};
				},
			};
		}
		const ctx = createHandleContext({
			providerId: "flaky-provider",
			state: wrap(inner),
			request: { headers: {}, connectionId: "c" },
		});
		const handle = await ctx.create(Flaky, { v: "x" });
		let runs = 0;
		const committed = await ctx.commit(Flaky, handle, async () => {
			runs += 1;
			failNext = true; // the finalize CAS right after work fails once
			return { ok: true };
		});
		expect(committed.status).toBe("committed");
		expect(runs).toBe(1);
		const replay = await ctx.commit(Flaky, handle, async () => ({ ok: false }));
		expect(replay).toMatchObject({ status: "replayed", result: { ok: true } });
	});

	it("keeps renewing the commit claim after an ambiguous renewal write", async () => {
		const Slow = defineDraft({
			name: "ambig",
			schema: z.object({ v: z.string() }),
			result: z.object({ ok: z.boolean() }),
			ttl: { idle: "200ms", max: "1s" },
		});
		const inner = createMemoryProviderRuntimeState();
		let ambiguousOnce = false;
		function wrap(state: typeof inner): typeof inner {
			return {
				forConnection: (id) => wrap(state.forConnection(id)),
				namespace: (name, opts) => {
					const ns = state.namespace(name, opts);
					return {
						...ns,
						list: ns.list.bind(ns),
						get: ns.get.bind(ns),
						set: ns.set.bind(ns),
						patch: ns.patch.bind(ns),
						delete: ns.delete.bind(ns),
						increment: ns.increment.bind(ns),
						compareAndSet: async (key, expected, value, options) => {
							const out = await ns.compareAndSet(key, expected, value, options);
							if (ambiguousOnce && out.ok) {
								ambiguousOnce = false;
								// The write landed but the response is lost.
								throw new ProviderError("Provider runtime state Redis timed out", {
									code: "PROVIDER_STATE_UNSUPPORTED",
								});
							}
							return out;
						},
					};
				},
			};
		}
		const ctx = createHandleContext({
			providerId: "ambiguous-provider",
			state: wrap(inner),
			request: { headers: {}, connectionId: "c" },
			commitLeaseMs: 100,
		});
		const handle = await ctx.create(Slow, { v: "x" });
		const committed = await ctx.commit(Slow, handle, async () => {
			ambiguousOnce = true; // the first renewal write will be ambiguous
			await new Promise((resolve) => setTimeout(resolve, 450));
			return { ok: true };
		});
		expect(committed.status).toBe("committed");
		const replay = await ctx.commit(Slow, handle, async () => ({ ok: false }));
		expect(replay).toMatchObject({ status: "replayed", result: { ok: true } });
	});

	it("discarded tombstones expire and free the quota slot", async () => {
		const Tiny = defineDraft({
			name: "tinyquota",
			schema: z.object({ v: z.number() }),
			ttl: { idle: "10m", max: "1h" },
			maxEntries: 2,
		});
		const clock = fakeClock();
		const ctx = createTestHandleContext({ nowMs: clock.nowMs });
		for (let i = 0; i < 6; i += 1) {
			const handle = await ctx.create(Tiny, { v: i });
			await ctx.discard(Tiny, handle);
			clock.advance(2); // the 1ms tombstone expires; storage reclaims the slot
		}
		const a = await ctx.create(Tiny, { v: 100 });
		const b = await ctx.create(Tiny, { v: 101 });
		expect((await ctx.read(Tiny, a)).data).toEqual({ v: 100 });
		expect((await ctx.read(Tiny, b)).data).toEqual({ v: 101 });
	});

	it("recognises its own claim after an ambiguous claim write and runs the work exactly once", async () => {
		const Draft = defineDraft({
			name: "ambigclaim",
			schema: z.object({ v: z.string() }),
			result: z.object({ ok: z.boolean() }),
			ttl: { idle: "10m", max: "1h" },
		});
		const inner = createMemoryProviderRuntimeState();
		let ambiguousNext = false;
		function wrap(state: typeof inner): typeof inner {
			return {
				forConnection: (id) => wrap(state.forConnection(id)),
				namespace: (name, opts) => {
					const ns = state.namespace(name, opts);
					return {
						...ns,
						list: ns.list.bind(ns),
						get: ns.get.bind(ns),
						set: ns.set.bind(ns),
						patch: ns.patch.bind(ns),
						delete: ns.delete.bind(ns),
						increment: ns.increment.bind(ns),
						compareAndSet: async (key, expected, value, options) => {
							const out = await ns.compareAndSet(key, expected, value, options);
							if (ambiguousNext) {
								ambiguousNext = false;
								throw new ProviderError("Provider runtime state Redis timed out", {
									code: "PROVIDER_STATE_UNSUPPORTED",
								});
							}
							return out;
						},
					};
				},
			};
		}
		const ctx = createHandleContext({
			providerId: "ambiguous-claim-provider",
			state: wrap(inner),
			request: { headers: {}, connectionId: "c" },
		});
		const handle = await ctx.create(Draft, { v: "x" });
		let runs = 0;
		ambiguousNext = true; // the claim CAS lands but its response is lost
		const committed = await ctx.commit(Draft, handle, async () => {
			runs += 1;
			return { ok: true };
		});
		expect(committed.status).toBe("committed");
		expect(runs).toBe(1);
		const replay = await ctx.commit(Draft, handle, async () => ({ ok: false }));
		expect(replay).toMatchObject({ status: "replayed", result: { ok: true } });
	});

	it("names the deadline that actually expired", async () => {
		const clock = fakeClock();
		const ctx = createTestHandleContext({ nowMs: clock.nowMs });
		const idle = await ctx.create(WaitingDraft, waitingData());
		clock.advance(31 * MINUTE);
		const idleError = await expectHandleError(ctx.read(WaitingDraft, idle), "HANDLE_EXPIRED");
		expect(idleError.message).toContain("expired after 30 minutes of inactivity");
		expect(idleError.options?.details).toMatchObject({ deadline: "idle" });

		const done = await ctx.create(WaitingDraft, waitingData());
		await ctx.commit(WaitingDraft, done, async () => ({ waitingId: "W" }));
		clock.advance(24 * 60 * MINUTE + 5 * MINUTE);
		const resultError = await expectHandleError(
			ctx.commit(WaitingDraft, done, async () => ({ waitingId: "X" })),
			"HANDLE_EXPIRED",
		);
		expect(resultError.message).toContain("result is no longer available");
		expect(resultError.options?.details).toMatchObject({ deadline: "result" });
	});
});
