import { describe, expect, it } from "bun:test";

import { defineProvider, type ProviderContextOf, type ProviderDeclaration } from "../define.js";
import type { ProviderMeta } from "../types.js";

/**
 * Compile-time probe behind `meta-requires-as-const`.
 *
 * The lint rule warns about ONE authoring shape, and it only earns the right to
 * do so if that shape really is the one that breaks. This file is the
 * measurement, executed by `tsc --noEmit` rather than at runtime: every
 * provider below declares `http` and nothing else, so reading `ctx.files` is an
 * error exactly when `ProviderContextOf` is still narrow.
 *
 * Read the expect-error markers below as the assertion:
 *   - marked   -> narrowing survived (the access is rejected)
 *   - unmarked -> the context degenerated to ProviderContext<ProviderDeclaration>
 *
 * Every declaration is written out inline on purpose. Factoring the shared part
 * into a `const CALL = {...} as const` and spreading it does not work: a
 * `readonly ["example.com"]` is not assignable to `allowedHosts: string[]`, so
 * the spread breaks all five rows at once and the probe silently stops
 * measuring what it claims to. That is the same class of mistake the rule
 * itself is about, so it is worth the repetition.
 *
 * If a future SDK change alters any row, `bun run type-check` fails here — an
 * unused expect-error directive is itself an error — and the rule's doc table and
 * warning text must be re-measured before they are re-shipped.
 */

// A: bare object literal containing a field the SDK types as a literal
//    (`contract.publicSchemaFieldNames: "normalized"`). The only broken row.
const metaBare = {
	displayName: "probe",
	descriptionKey: "probe.description",
	category: "test",
	contract: { publicSchemaFieldNames: "normalized" },
};

// B: bare object literal with no literal-typed field. Fine today.
const metaBarePlain = {
	displayName: "probe",
	descriptionKey: "probe.description",
	category: "test",
};

// C: `as const`.
const metaConst = {
	displayName: "probe",
	descriptionKey: "probe.description",
	category: "test",
	contract: { publicSchemaFieldNames: "normalized" },
} as const;

// D: `satisfies` with no `as const`.
const metaSatisfies = {
	displayName: "probe",
	descriptionKey: "probe.description",
	category: "test",
	contract: { publicSchemaFieldNames: "normalized" },
} satisfies ProviderMeta;

// E: explicit annotation.
const metaAnnotated: ProviderMeta = {
	displayName: "probe",
	descriptionKey: "probe.description",
	category: "test",
	contract: { publicSchemaFieldNames: "normalized" },
};

const buildBare = defineProvider({
	id: "meta-narrowing-probe",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	auth: { mode: "none" },
	allowedHosts: ["example.com"],
	// @ts-expect-error test-invalid: a widened `contract.publicSchemaFieldNames` is `string`, not "normalized", so the declaration no longer satisfies ProviderDeclaration.
	meta: metaBare,
});
const buildBarePlain = defineProvider({
	id: "meta-narrowing-probe",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	auth: { mode: "none" },
	allowedHosts: ["example.com"],
	meta: metaBarePlain,
});
const buildConst = defineProvider({
	id: "meta-narrowing-probe",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	auth: { mode: "none" },
	allowedHosts: ["example.com"],
	meta: metaConst,
});
const buildSatisfies = defineProvider({
	id: "meta-narrowing-probe",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	auth: { mode: "none" },
	allowedHosts: ["example.com"],
	meta: metaSatisfies,
});
const buildAnnotated = defineProvider({
	id: "meta-narrowing-probe",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	auth: { mode: "none" },
	allowedHosts: ["example.com"],
	meta: metaAnnotated,
});

// F: the SILENT row — the whole declaration annotated with the declaration
//    type. Perfectly assignable, so the call compiles; but every capability is
//    an optional key of ProviderDeclaration, so `keyof TConfig` is all of them.
const declAnnotated: ProviderDeclaration = {
	id: "meta-narrowing-probe",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	auth: { mode: "none" },
	allowedHosts: ["example.com"],
	meta: metaConst,
};
// G: the same object checked with `satisfies` instead. Key set survives.
const declSatisfies = {
	id: "meta-narrowing-probe",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	auth: { mode: "none" },
	allowedHosts: ["example.com"],
	meta: metaConst,
} satisfies ProviderDeclaration;

// H: `Pick` names an explicit key subset, so the authored keys survive.
const declPick: Pick<
	ProviderDeclaration,
	"id" | "version" | "runtime" | "http" | "auth" | "allowedHosts" | "meta"
> = {
	id: "meta-narrowing-probe",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	auth: { mode: "none" },
	allowedHosts: ["example.com"],
	meta: metaConst,
};
// I: an intersection still carries every optional capability key.
const declIntersection: ProviderDeclaration & { http: Record<string, never> } = {
	id: "meta-narrowing-probe",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	auth: { mode: "none" },
	allowedHosts: ["example.com"],
	meta: metaConst,
};

const buildDeclAnnotated = defineProvider(declAnnotated);
const buildDeclSatisfies = defineProvider(declSatisfies);
const buildDeclPick = defineProvider(declPick);
const buildDeclIntersection = defineProvider(declIntersection);
// J: an explicit type argument pins TConfig, so `const` inference never runs.
const buildPinned = defineProvider<ProviderDeclaration>({
	id: "meta-narrowing-probe",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	auth: { mode: "none" },
	allowedHosts: ["example.com"],
	meta: metaConst,
});

declare const ctxDeclAnnotated: ProviderContextOf<typeof buildDeclAnnotated>;
declare const ctxDeclSatisfies: ProviderContextOf<typeof buildDeclSatisfies>;
declare const ctxDeclPick: ProviderContextOf<typeof buildDeclPick>;
declare const ctxDeclIntersection: ProviderContextOf<typeof buildDeclIntersection>;
declare const ctxPinned: ProviderContextOf<typeof buildPinned>;

declare const ctxBare: ProviderContextOf<typeof buildBare>;
declare const ctxBarePlain: ProviderContextOf<typeof buildBarePlain>;
declare const ctxConst: ProviderContextOf<typeof buildConst>;
declare const ctxSatisfies: ProviderContextOf<typeof buildSatisfies>;
declare const ctxAnnotated: ProviderContextOf<typeof buildAnnotated>;

function probe(): void {
	// A — DEGENERATE. No expect-error marker: `files` was never declared, yet
	// this compiles, because TConfig fell back to ProviderDeclaration.
	void ctxBare.files;

	// @ts-expect-error test-invalid: B — narrowed, so `files` is absent from the context.
	void ctxBarePlain.files;
	// @ts-expect-error test-invalid: C — narrowed, so `files` is absent from the context.
	void ctxConst.files;
	// @ts-expect-error test-invalid: D — narrowed, so `files` is absent from the context.
	void ctxSatisfies.files;
	// @ts-expect-error test-invalid: E — narrowed, so `files` is absent from the context.
	void ctxAnnotated.files;

	// F — DEGENERATE AND SILENT. No expect-error marker on either line: the
	// defineProvider(declAnnotated) call above compiled without complaint, and
	// `files` resolves here even though the declaration never mentions it. This
	// is the row the rule reports at error level.
	void ctxDeclAnnotated.files;
	void ctxDeclAnnotated.browser;

	// @ts-expect-error test-invalid: G — `satisfies` keeps the authored key set, so `files` is absent.
	void ctxDeclSatisfies.files;
	// @ts-expect-error test-invalid: H — `Pick` names an explicit key subset, so `files` is absent.
	void ctxDeclPick.files;

	// I and J — DEGENERATE AND SILENT, like F. An intersection keeps every
	// optional capability key of ProviderDeclaration, and an explicit type
	// argument pins TConfig so `const` inference never runs. Both calls compile.
	void ctxDeclIntersection.files;
	void ctxPinned.files;

	// All of them declare `http`, so this side is uniform.
	void ctxBare.http;
	void ctxBarePlain.http;
	void ctxConst.http;
	void ctxSatisfies.http;
	void ctxAnnotated.http;
	void ctxDeclPick.http;
	void ctxDeclIntersection.http;
	void ctxPinned.http;
}

describe("meta narrowing probe", () => {
	it("is a type-level fixture; tsc is the assertion", () => {
		expect(typeof probe).toBe("function");
	});
});
