import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { lintProvider } from "../lint.js";
import { describeKey } from "../schema.js";
import type { OperationErrorCode, OperationRiskClass } from "../types.js";

const READ_RISK_CLASS: OperationRiskClass = "read";

function withDescriptionKey<TSchema extends z.ZodType>(schema: TSchema, key: string): TSchema {
	return describeKey(schema, key);
}

function providerUnderLint(options: {
	providerSourceFiles: Record<string, string>;
	errorCodes?: readonly OperationErrorCode[];
	localeCatalogEn?: Record<string, unknown>;
}) {
	return {
		id: "demo-provider",
		allowedHosts: ["api.example.com"],
		reviewed: "first-party" as const,
		providerSourceFiles: options.providerSourceFiles,
		...(options.localeCatalogEn === undefined ? {} : { localeCatalogEn: options.localeCatalogEn }),
		operations: {
			lookup: {
				riskClass: READ_RISK_CLASS,
				descriptionKey: "operations.lookup.description",
				input: withDescriptionKey(
					z.object({
						symbol: withDescriptionKey(z.string(), "operations.lookup.fields.symbol.description"),
					}),
					"operations.lookup.input.description",
				),
				output: withDescriptionKey(
					z.object({
						price: withDescriptionKey(z.number(), "operations.lookup.fields.price.description"),
					}),
					"operations.lookup.output.description",
				),
				fixtures: { request: { symbol: "BTC" }, response: { price: 100 } },
				errorCodes: [...(options.errorCodes ?? [])],
			},
		},
	};
}

const SOLD_OUT: OperationErrorCode = {
	code: "ITEM_SOLD_OUT",
	status: 409,
	description: "Upstream refused the purchase.",
	retryable: false,
};

const localizationRules = new Set([
	"thrown-error-message-not-localized",
	"error-locale-key-missing",
	"error-locale-key-malformed",
]);

function localizationDiagnostics(provider: Parameters<typeof lintProvider>[0]) {
	return lintProvider(provider).filter((diagnostic) => localizationRules.has(diagnostic.rule));
}

describe("thrown-error-message-not-localized", () => {
	it("warns when a declared code is thrown without any localized message", () => {
		const diagnostics = localizationDiagnostics(
			providerUnderLint({
				providerSourceFiles: {
					"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT" });`,
				},
				errorCodes: [SOLD_OUT],
				localeCatalogEn: {},
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				rule: "thrown-error-message-not-localized",
				level: "warn",
				field: "sourceFiles.upstream/client.ts",
			}),
		]);
		expect(diagnostics[0]?.message).toContain('"ITEM_SOLD_OUT"');
		expect(diagnostics[0]?.message).toContain("errors.ITEM_SOLD_OUT.message");
	});

	it("covers AuthError throw sites, which the undeclared-code rule does not scan", () => {
		const diagnostics = localizationDiagnostics(
			providerUnderLint({
				providerSourceFiles: {
					"auth.ts": `throw new AuthError("Sign-in failed", { code: "ITEM_SOLD_OUT" });`,
				},
				errorCodes: [SOLD_OUT],
				localeCatalogEn: {},
			}),
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain("AuthError");
	});

	it("stays silent when the throw site carries a messageKey", () => {
		expect(
			localizationDiagnostics(
				providerUnderLint({
					providerSourceFiles: {
						"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT", messageKey: "errors.soldOut.message" });`,
					},
					errorCodes: [SOLD_OUT],
					localeCatalogEn: { errors: { soldOut: { message: "Sold out." } } },
				}),
			),
		).toEqual([]);
	});

	it("stays silent when the errorCodes declaration carries the messageKey", () => {
		expect(
			localizationDiagnostics(
				providerUnderLint({
					providerSourceFiles: {
						"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT" });`,
					},
					errorCodes: [{ ...SOLD_OUT, messageKey: "errors.soldOut.message" }],
					localeCatalogEn: { errors: { soldOut: { message: "Sold out." } } },
				}),
			),
		).toEqual([]);
	});

	it("stays silent when the derived errors.<code>.message exists in en", () => {
		expect(
			localizationDiagnostics(
				providerUnderLint({
					providerSourceFiles: {
						"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT" });`,
					},
					errorCodes: [SOLD_OUT],
					localeCatalogEn: { errors: { ITEM_SOLD_OUT: { message: "Sold out." } } },
				}),
			),
		).toEqual([]);
	});

	it("stays silent for a code no operation declares (owned by thrown-error-code-undeclared)", () => {
		expect(
			localizationDiagnostics(
				providerUnderLint({
					providerSourceFiles: {
						"upstream/client.ts": `throw new ProviderError("Sold out", { code: "MYSTERY_CODE" });`,
					},
					errorCodes: [SOLD_OUT],
					localeCatalogEn: {},
				}),
			),
		).toEqual([]);
	});

	it("stays silent when no locale catalog was supplied to the linter", () => {
		expect(
			localizationDiagnostics(
				providerUnderLint({
					providerSourceFiles: {
						"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT", messageKey: "errors.absent.message" });`,
					},
					errorCodes: [SOLD_OUT],
				}),
			),
		).toEqual([]);
	});

	it("reports each declared code once per source file", () => {
		const diagnostics = localizationDiagnostics(
			providerUnderLint({
				providerSourceFiles: {
					"upstream/client.ts": [
						`throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT" });`,
						`throw new ProviderError("Also sold out", { code: "ITEM_SOLD_OUT" });`,
					].join("\n"),
				},
				errorCodes: [SOLD_OUT],
				localeCatalogEn: {},
			}),
		);

		expect(diagnostics).toHaveLength(1);
	});
});

describe("error-locale-key-missing", () => {
	it("errors on a throw-site messageKey absent from en", () => {
		const diagnostics = localizationDiagnostics(
			providerUnderLint({
				providerSourceFiles: {
					"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT", messageKey: "errors.soldOut.message" });`,
				},
				errorCodes: [SOLD_OUT],
				localeCatalogEn: { errors: {} },
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				rule: "error-locale-key-missing",
				level: "error",
				field: "sourceFiles.upstream/client.ts",
			}),
		]);
		expect(diagnostics[0]?.message).toContain("errors.soldOut.message");
		expect(diagnostics[0]?.message).toContain("locales/en.json");
	});

	it("errors on a throw-site fixKey absent from en", () => {
		const diagnostics = localizationDiagnostics(
			providerUnderLint({
				providerSourceFiles: {
					"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT", messageKey: "errors.soldOut.message", fixKey: "errors.soldOut.fix" });`,
				},
				errorCodes: [SOLD_OUT],
				localeCatalogEn: { errors: { soldOut: { message: "Sold out." } } },
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({ rule: "error-locale-key-missing", level: "error" }),
		]);
		expect(diagnostics[0]?.message).toContain("errors.soldOut.fix");
	});

	it("errors on an errorCodes declaration key absent from en", () => {
		const diagnostics = localizationDiagnostics(
			providerUnderLint({
				providerSourceFiles: { "upstream/client.ts": "export const noop = 1;" },
				errorCodes: [{ ...SOLD_OUT, messageKey: "errors.soldOut.message" }],
				localeCatalogEn: {},
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				rule: "error-locale-key-missing",
				level: "error",
				field: "operations.lookup.errorCodes",
			}),
		]);
		expect(diagnostics[0]?.message).toContain('errorCodes entry "ITEM_SOLD_OUT"');
	});

	it("errors when the key resolves to a non-string or empty catalog value", () => {
		const diagnostics = localizationDiagnostics(
			providerUnderLint({
				providerSourceFiles: {
					"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT", messageKey: "errors.soldOut.message" });`,
				},
				errorCodes: [SOLD_OUT],
				localeCatalogEn: { errors: { soldOut: { message: "   " } } },
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({ rule: "error-locale-key-missing", level: "error" }),
		]);
	});

	it("errors on a malformed key instead of claiming it is missing", () => {
		const diagnostics = localizationDiagnostics(
			providerUnderLint({
				providerSourceFiles: {
					"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT", messageKey: "errors..soldOut" });`,
				},
				errorCodes: [SOLD_OUT],
				localeCatalogEn: {},
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({ rule: "error-locale-key-malformed", level: "error" }),
		]);
	});

	it("accepts a key that resolves in en", () => {
		expect(
			localizationDiagnostics(
				providerUnderLint({
					providerSourceFiles: {
						"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT", messageKey: "errors.soldOut.message" });`,
					},
					errorCodes: [SOLD_OUT],
					localeCatalogEn: { errors: { soldOut: { message: "Sold out." } } },
				}),
			),
		).toEqual([]);
	});

	it("ignores computed messageKey expressions rather than guessing", () => {
		expect(
			localizationDiagnostics(
				providerUnderLint({
					providerSourceFiles: {
						"upstream/client.ts": [
							'const key = "errors." + kind + ".message";',
							`throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT", messageKey: key, fixKey: buildKey() });`,
						].join("\n"),
					},
					errorCodes: [{ ...SOLD_OUT, messageKey: "errors.soldOut.message" }],
					localeCatalogEn: { errors: { soldOut: { message: "Sold out." } } },
				}),
			),
		).toEqual([]);
	});

	it("does not confuse a longer option name with messageKey", () => {
		expect(
			localizationDiagnostics(
				providerUnderLint({
					providerSourceFiles: {
						"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT", messageKeyFallback: "errors.absent.message", messageKey: "errors.soldOut.message" });`,
					},
					errorCodes: [SOLD_OUT],
					localeCatalogEn: { errors: { soldOut: { message: "Sold out." } } },
				}),
			),
		).toEqual([]);
	});

	it("treats a prototype-chain segment as a missing key", () => {
		const diagnostics = localizationDiagnostics(
			providerUnderLint({
				providerSourceFiles: {
					"upstream/client.ts": `throw new ProviderError("Sold out", { code: "ITEM_SOLD_OUT", messageKey: "errors.constructor.name" });`,
				},
				errorCodes: [SOLD_OUT],
				localeCatalogEn: { errors: {} },
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({ rule: "error-locale-key-missing", level: "error" }),
		]);
	});
});
