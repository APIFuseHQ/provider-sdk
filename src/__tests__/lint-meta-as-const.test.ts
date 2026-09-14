import { describe, expect, it } from "bun:test";

import { type LintDiagnostic, lintProvider } from "../lint.js";

const RULE = "meta-requires-as-const";

function findings(providerSourceFiles: Record<string, string>): LintDiagnostic[] {
	return lintProvider({
		id: "demo",
		allowedHosts: ["example.com"],
		reviewed: "first-party",
		providerSourceFiles,
	}).filter((diagnostic) => diagnostic.rule === RULE);
}

const INDEX_WITH_IMPORTED_META = `
import { defineProvider, type ProviderContextOf } from "@apifuse/provider-sdk/provider";
import { providerMeta } from "./meta";
import { operations } from "./operations";

const buildProvider = defineProvider({
  id: "demo",
  http: {},
  auth: { mode: "none" },
  allowedHosts: ["example.com"],
  meta: providerMeta,
});

export type ProviderContext = ProviderContextOf<typeof buildProvider>;
export default buildProvider({ operations });
`;

describe("meta-requires-as-const", () => {
	it("reports a meta module that dropped `as const`", () => {
		const diagnostics = findings({
			"index.ts": INDEX_WITH_IMPORTED_META,
			"meta.ts": `export const providerMeta = {
  displayName: "Demo",
  category: "legal",
};`,
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.level).toBe("warn");
		expect(diagnostics[0]?.field).toBe("meta");
		expect(diagnostics[0]?.message).toContain("providerMeta");
		expect(diagnostics[0]?.message).toContain("bare object literal");
		expect(diagnostics[0]?.message).toContain("TS2322");
	});

	// Measured against this SDK, not assumed: an annotation and a `satisfies`
	// both give the literal a contextual type whose literal-typed members stay
	// literal, and ProviderContextOf stays narrow. Flagging them would be a
	// false positive.
	it("accepts a meta module annotated with the SDK meta type", () => {
		expect(
			findings({
				"index.ts": INDEX_WITH_IMPORTED_META,
				"meta.ts": `import type { ProviderMeta } from "@apifuse/provider-sdk/provider";
export const providerMeta: ProviderMeta = {
  displayName: "Demo",
  category: "legal",
};`,
			}),
		).toEqual([]);
	});

	it("accepts `satisfies` without `as const` — the target's literal types stop the widening", () => {
		expect(
			findings({
				"index.ts": INDEX_WITH_IMPORTED_META,
				"meta.ts": `import type { ProviderMeta } from "@apifuse/provider-sdk/provider";
export const providerMeta = {
  displayName: "Demo",
  contract: { publicSchemaFieldNames: "normalized" },
} satisfies ProviderMeta;`,
			}),
		).toEqual([]);
	});

	it("accepts a meta module that keeps `as const`", () => {
		expect(
			findings({
				"index.ts": INDEX_WITH_IMPORTED_META,
				"meta.ts": `export const providerMeta = {
  displayName: "Demo",
  category: "legal",
} as const;`,
			}),
		).toEqual([]);
	});

	it("accepts `as const satisfies` and `satisfies` wrapping `as const`", () => {
		for (const initializer of [
			`{ displayName: "Demo" } as const satisfies Record<string, unknown>`,
			`({ displayName: "Demo" } as const) satisfies Record<string, unknown>`,
		]) {
			expect(
				findings({
					"index.ts": INDEX_WITH_IMPORTED_META,
					"meta.ts": `export const providerMeta = ${initializer};`,
				}),
			).toEqual([]);
		}
	});

	it("accepts a meta written inline at the call — the const type parameter narrows it", () => {
		expect(
			findings({
				"index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
const buildProvider = defineProvider({
  id: "demo",
  meta: { displayName: "Demo", category: "legal" },
});`,
			}),
		).toEqual([]);
	});

	it("reports a widened binding spread into an inline meta literal", () => {
		const diagnostics = findings({
			"index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { baseMeta } from "./meta";
const buildProvider = defineProvider({
  id: "demo",
  meta: { ...baseMeta, category: "legal" },
});`,
			"meta.ts": `export const baseMeta = { displayName: "Demo" };`,
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain("baseMeta");
	});

	it("reports a whole declaration passed by name", () => {
		const diagnostics = findings({
			"index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { declaration } from "./declaration";
const buildProvider = defineProvider(declaration);`,
			"declaration.ts": `export const declaration = { id: "demo", http: {} };`,
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.field).toBe("declaration");
		expect(diagnostics[0]?.level).toBe("warn");
	});

	// The silent row: assignable, so the call compiles, but `keyof TConfig`
	// becomes every optional capability key of ProviderDeclaration.
	it("ERRORS on a declaration annotated `: ProviderDeclaration`", () => {
		for (const annotation of [
			"ProviderDeclaration",
			'Omit<ProviderDeclaration, "auth">',
			"Partial<ProviderDeclaration>",
		]) {
			const diagnostics = findings({
				"index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { declaration } from "./declaration";
const buildProvider = defineProvider(declaration);`,
				"declaration.ts": `import type { ProviderDeclaration } from "@apifuse/provider-sdk/provider";
export const declaration: ${annotation} = { id: "demo", http: {} };`,
			});

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.level).toBe("error");
			expect(diagnostics[0]?.message).toContain("OPTIONAL key of ProviderDeclaration");
			expect(diagnostics[0]?.message).toContain("satisfies ProviderDeclaration");
		}
	});

	it("ERRORS on a declaration asserted `as ProviderDeclaration`", () => {
		const diagnostics = findings({
			"index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { declaration } from "./declaration";
const buildProvider = defineProvider(declaration);`,
			"declaration.ts": `import type { ProviderDeclaration } from "@apifuse/provider-sdk/provider";
export const declaration = { id: "demo", http: {} } as ProviderDeclaration;`,
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.level).toBe("error");
	});

	it("accepts `satisfies ProviderDeclaration` on the whole declaration", () => {
		expect(
			findings({
				"index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { declaration } from "./declaration";
const buildProvider = defineProvider(declaration);`,
				"declaration.ts": `import type { ProviderDeclaration } from "@apifuse/provider-sdk/provider";
export const declaration = { id: "demo", http: {} } satisfies ProviderDeclaration;`,
			}),
		).toEqual([]);
	});

	it("accepts an indexed access into the declaration type — it names one member", () => {
		expect(
			findings({
				"index.ts": INDEX_WITH_IMPORTED_META,
				"meta.ts": `import type { ProviderDeclaration } from "@apifuse/provider-sdk/provider";
export const providerMeta: ProviderDeclaration["meta"] = { displayName: "Demo" };`,
			}),
		).toEqual([]);
	});

	it("follows a re-export hop to the real declaration", () => {
		const diagnostics = findings({
			"index.ts": INDEX_WITH_IMPORTED_META,
			"meta.ts": `export { providerMeta } from "./meta/provider-meta";`,
			"meta/provider-meta.ts": `export const providerMeta = { displayName: "Demo" };`,
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain("providerMeta");
	});

	it("resolves a renamed import and an extensioned specifier", () => {
		const diagnostics = findings({
			"src/index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { providerMeta as meta } from "./meta.js";
const buildProvider = defineProvider({ id: "demo", meta });`,
			"src/meta.ts": `export const providerMeta = { displayName: "Demo" };`,
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain("meta");
	});

	it("stays silent when the meta cannot be resolved inside the provider tree", () => {
		expect(
			findings({
				"index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { providerMeta } from "@some/shared-package";
const buildProvider = defineProvider({ id: "demo", meta: providerMeta });`,
			}),
		).toEqual([]);

		expect(
			findings({
				"index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { buildMeta } from "./meta";
const buildProvider = defineProvider({ id: "demo", meta: buildMeta() });`,
				"meta.ts": `export function buildMeta() { return { displayName: "Demo" }; }`,
			}),
		).toEqual([]);
	});

	it("does not fire for providers with no source files (in-memory definitions)", () => {
		expect(findings({})).toEqual([]);
	});

	// Regressions from the review of this rule. Each of these is the SAME silent
	// key erasure wearing different syntax; missing any one of them would let the
	// exact defect the rule exists for through.

	it("ERRORS on an assertion written at the call itself", () => {
		for (const call of [
			'defineProvider({ id: "demo", http: {} } as ProviderDeclaration)',
			"defineProvider(declaration as ProviderDeclaration)",
		]) {
			const diagnostics = findings({
				"index.ts": `import { defineProvider, type ProviderDeclaration } from "@apifuse/provider-sdk/provider";
import { declaration } from "./declaration";
const buildProvider = ${call};`,
				"declaration.ts": `export const declaration = { id: "demo", http: {} } as const;`,
			});

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.level).toBe("error");
			expect(diagnostics[0]?.message).toContain("asserted `as ProviderDeclaration` at the call");
		}
	});

	it("ERRORS through a renamed import of the declaration type", () => {
		const diagnostics = findings({
			"index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { declaration } from "./declaration";
const buildProvider = defineProvider(declaration);`,
			"declaration.ts": `import type { ProviderDeclaration as Decl } from "@apifuse/provider-sdk/provider";
export const declaration: Decl = { id: "demo", http: {} };`,
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.level).toBe("error");
	});

	it("ERRORS through a local type alias of the declaration type", () => {
		const diagnostics = findings({
			"index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { declaration } from "./declaration";
const buildProvider = defineProvider(declaration);`,
			"declaration.ts": `import type { ProviderDeclaration } from "@apifuse/provider-sdk/provider";
type Decl = ProviderDeclaration;
export const declaration: Decl = { id: "demo", http: {} };`,
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.level).toBe("error");
	});

	it("follows the SDK's defineProvider when it is imported under another name", () => {
		const diagnostics = findings({
			"index.ts": `import { defineProvider as declareProvider } from "@apifuse/provider-sdk/provider";
import { declaration } from "./declaration";
const buildProvider = declareProvider(declaration);`,
			"declaration.ts": `import type { ProviderDeclaration } from "@apifuse/provider-sdk/provider";
export const declaration: ProviderDeclaration = { id: "demo", http: {} };`,
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.level).toBe("error");
	});

	it("ignores an unrelated local helper that happens to be called defineProvider", () => {
		expect(
			findings({
				"index.ts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { declaration } from "./declaration";
import { defineProvider as localDefineProvider } from "./local";
const unrelated = localDefineProvider(declaration);
const buildProvider = defineProvider({ id: "demo", http: {}, meta: { displayName: "d" } });`,
				"local.ts": `export function defineProvider(value: unknown) { return value; }`,
				"declaration.ts": `import type { ProviderDeclaration } from "@apifuse/provider-sdk/provider";
export const declaration: ProviderDeclaration = { id: "demo", http: {} };`,
			}),
		).toEqual([]);
	});

	it("does not fire on test sources — they build throwaway declarations on purpose", () => {
		const widened = {
			"declaration.ts": `import type { ProviderDeclaration } from "@apifuse/provider-sdk/provider";
export const declaration: ProviderDeclaration = { id: "demo", http: {} };`,
		};
		const call = `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { declaration } from "./declaration";
export const buildProvider = defineProvider(declaration);`;

		for (const testPath of [
			"__tests__/index.test.ts",
			"tests/shape.ts",
			"src/provider.spec.ts",
		]) {
			expect(findings({ ...widened, [testPath]: call })).toEqual([]);
		}
		// …but the same call in runtime source still errors.
		expect(findings({ ...widened, "index.ts": call })).toHaveLength(1);
	});

	it("resolves a `.js` specifier to its `.mts` counterpart", () => {
		const diagnostics = findings({
			"index.mts": `import { defineProvider } from "@apifuse/provider-sdk/provider";
import { providerMeta } from "./meta.js";
const buildProvider = defineProvider({ id: "demo", meta: providerMeta });`,
			"meta.mts": `export const providerMeta = { displayName: "Demo" };`,
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.field).toBe("meta");
	});

	it("skips declaration files and non-TypeScript sources", () => {
		expect(
			findings({
				"index.d.ts": INDEX_WITH_IMPORTED_META,
				"meta.ts": `export const providerMeta = { displayName: "Demo" };`,
			}),
		).toEqual([]);
	});
});
