import { describe, expect, it } from "bun:test";

import { defineProvider, type ProviderContextOf, type ProviderDeclaration } from "../define.js";
import type { ProviderMeta } from "../types.js";

/**
 * Compile-time fixture: `tsc --noEmit` is the assertion. Every provider below
 * declares `http` and nothing else, so `ctx.files` must be rejected in each
 * row; an unused expect-error directive fails the type check.
 *
 * Rows A to E are the ways a `meta` block reaches the call. The context is
 * narrowed on capability keys only, so none of them changes the result; row A
 * does not even compile (a widened `"normalized"` is `string`), and its
 * context falls back to the minimal shape rather than every capability.
 */
const metaBare = {
	displayName: "probe",
	descriptionKey: "probe.description",
	category: "test",
	contract: { publicSchemaFieldNames: "normalized" },
};
const metaBarePlain = {
	displayName: "probe",
	descriptionKey: "probe.description",
	category: "test",
};
const metaConst = {
	displayName: "probe",
	descriptionKey: "probe.description",
	category: "test",
	contract: { publicSchemaFieldNames: "normalized" },
} as const;
const metaSatisfies = {
	displayName: "probe",
	descriptionKey: "probe.description",
	category: "test",
	contract: { publicSchemaFieldNames: "normalized" },
} satisfies ProviderMeta;
const metaAnnotated: ProviderMeta = {
	displayName: "probe",
	descriptionKey: "probe.description",
	category: "test",
	contract: { publicSchemaFieldNames: "normalized" },
};

const base = {
	id: "declaration-types",
	version: "1.0.0",
	runtime: "standard",
	http: {},
	auth: { mode: "none" },
	allowedHosts: ["example.com"],
	reviewed: "community",
} as const;

const buildBare = defineProvider({
	...base,
	// @ts-expect-error test-invalid: a widened `contract.publicSchemaFieldNames` is `string`, not "normalized".
	meta: metaBare,
});
const buildBarePlain = defineProvider({ ...base, meta: metaBarePlain });
const buildConst = defineProvider({ ...base, meta: metaConst });
const buildSatisfies = defineProvider({ ...base, meta: metaSatisfies });
const buildAnnotated = defineProvider({ ...base, meta: metaAnnotated });

// The whole declaration annotated, intersected, picked or pinned: every
// capability key is optional in those types, so the context is minimal and
// the provider's own `ctx.http` read fails to compile (loud, not silent).
const declAnnotated: ProviderDeclaration = { ...base, meta: metaConst };
const declSatisfies = { ...base, meta: metaConst } satisfies ProviderDeclaration;
const declPick: Pick<
	ProviderDeclaration,
	"id" | "version" | "runtime" | "http" | "auth" | "allowedHosts" | "reviewed" | "meta"
> = { ...base, meta: metaConst };
const declIntersection: ProviderDeclaration & { http: Record<string, never> } = {
	...base,
	meta: metaConst,
};
const buildDeclAnnotated = defineProvider(declAnnotated);
const buildDeclSatisfies = defineProvider(declSatisfies);
const buildDeclPick = defineProvider(declPick);
const buildDeclIntersection = defineProvider(declIntersection);
const buildPinned = defineProvider<ProviderDeclaration>({ ...base, meta: metaConst });

declare const ctxBare: ProviderContextOf<typeof buildBare>;
declare const ctxBarePlain: ProviderContextOf<typeof buildBarePlain>;
declare const ctxConst: ProviderContextOf<typeof buildConst>;
declare const ctxSatisfies: ProviderContextOf<typeof buildSatisfies>;
declare const ctxAnnotated: ProviderContextOf<typeof buildAnnotated>;
declare const ctxDeclAnnotated: ProviderContextOf<typeof buildDeclAnnotated>;
declare const ctxDeclSatisfies: ProviderContextOf<typeof buildDeclSatisfies>;
declare const ctxDeclPick: ProviderContextOf<typeof buildDeclPick>;
declare const ctxDeclIntersection: ProviderContextOf<typeof buildDeclIntersection>;
declare const ctxPinned: ProviderContextOf<typeof buildPinned>;

function probeNarrowing(): void {
	// @ts-expect-error test-invalid: A, bare meta with a literal field: minimal context, files absent.
	void ctxBare.files;
	// @ts-expect-error test-invalid: B, bare meta without literal fields: narrowed, files absent.
	void ctxBarePlain.files;
	// @ts-expect-error test-invalid: C, `as const` meta: narrowed, files absent.
	void ctxConst.files;
	// @ts-expect-error test-invalid: D, `satisfies` meta: narrowed, files absent.
	void ctxSatisfies.files;
	// @ts-expect-error test-invalid: E, annotated meta: narrowed, files absent.
	void ctxAnnotated.files;

	void ctxBarePlain.http;
	void ctxConst.http;
	void ctxSatisfies.http;
	void ctxAnnotated.http;
	void ctxDeclSatisfies.http;

	// @ts-expect-error test-invalid: `satisfies` keeps the authored key set; files absent.
	void ctxDeclSatisfies.files;
	// @ts-expect-error test-invalid: an annotated declaration declares no capability with a value.
	void ctxDeclAnnotated.http;
	// @ts-expect-error test-invalid: an annotated declaration declares no capability with a value.
	void ctxDeclAnnotated.files;
	// @ts-expect-error test-invalid: `Pick` keeps `http` optional, so it is not declared.
	void ctxDeclPick.http;
	// @ts-expect-error test-invalid: the intersection keeps `http` optional, so it is not declared.
	void ctxDeclIntersection.files;
	// @ts-expect-error test-invalid: an explicit type argument pins the constraint; nothing is declared.
	void ctxPinned.http;
}

const credentialsFlow = {
	start: async () => ({ kind: "form", turnId: "start" }),
	continue: async () => ({ kind: "complete", turnId: "complete" }),
};
const meta = metaBarePlain;

function probeAuthModes(): void {
	// @ts-expect-error test-invalid: credentials needs auth.flow (start and continue).
	defineProvider({ ...base, meta, auth: { mode: "credentials" }, credential: { keys: ["id"] } });
	// @ts-expect-error test-invalid: credentials needs credential.keys (AuthModeCredentialGuard).
	defineProvider({ ...base, meta, auth: { mode: "credentials", flow: credentialsFlow } });
	// @ts-expect-error test-invalid: credentials needs at least one key (AuthModeCredentialGuard).
	defineProvider({
		...base,
		meta,
		auth: { mode: "credentials", flow: credentialsFlow },
		credential: { keys: [] },
	});
	// @ts-expect-error test-invalid: platform-managed must not list credential keys (AuthModeCredentialGuard).
	defineProvider({
		...base,
		meta,
		auth: { mode: "platform-managed" },
		credential: { keys: ["access_token"] },
	});
	// @ts-expect-error test-invalid: oauth2_proxied needs auth.proxied.
	defineProvider({ ...base, meta, auth: { mode: "oauth2_proxied" } });
	defineProvider({
		...base,
		meta,
		// @ts-expect-error test-invalid: auth.exchange is not part of the auth contract.
		auth: { mode: "none", exchange: async () => ({}) },
	});
	// @ts-expect-error test-invalid: a reusable secret key needs storesReusableSecret and justification (CredentialSecretGuard).
	defineProvider({
		...base,
		meta,
		auth: { mode: "credentials", flow: credentialsFlow },
		credential: { keys: ["session_cookie"] },
	});
	// @ts-expect-error test-invalid: refresh over a passcode key needs storesReusableSecret and justification (CredentialSecretGuard).
	defineProvider({
		...base,
		meta,
		auth: {
			mode: "credentials",
			flow: { ...credentialsFlow, refresh: async () => ({ kind: "complete", turnId: "r" }) },
		},
		credential: { keys: ["username", "passcode"] },
	});
	defineProvider({
		...base,
		meta,
		auth: { mode: "credentials", flow: credentialsFlow },
		credential: { keys: ["username", "passcode"] },
	});
	// @ts-expect-error test-invalid: allowedHosts needs at least one host.
	defineProvider({ ...base, meta, allowedHosts: [] });
	// @ts-expect-error test-invalid: reviewed is required.
	defineProvider({ ...base, meta, reviewed: undefined });

	const ok = defineProvider({
		...base,
		meta,
		auth: { mode: "credentials", flow: credentialsFlow },
		credential: { keys: ["id", "session"], storesReusableSecret: true, justification: "fixture" },
	});
	const ctx = {} as ProviderContextOf<typeof ok>;
	void ctx.credential;
	void ctx.http;
	// @ts-expect-error test-invalid: files was never declared.
	void ctx.files;
}

describe("declaration types", () => {
	it("is a type-level fixture; tsc is the assertion", () => {
		expect(typeof probeNarrowing).toBe("function");
		expect(typeof probeAuthModes).toBe("function");
	});
});
