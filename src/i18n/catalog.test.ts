import { describe, expect, it } from "bun:test";

import {
	localizeAuthTurn,
	type ProviderLocaleCatalogMap,
	resolveProviderLocaleValue,
	validateProviderLocaleCatalogs,
} from "./catalog.js";
import { providerLocaleKey } from "./keys.js";

describe("provider locale catalogs", () => {
	const catalogs: ProviderLocaleCatalogMap = {
		en: {
			meta: { description: "Restaurant reservations" },
			operations: {
				reserve: {
					description: "Create a dining reservation",
					whenToUse: {
						afterAvailability: "Use after resolving availability",
					},
				},
			},
		},
		ko: {
			meta: { description: "식당 예약" },
			operations: {
				reserve: {
					description: "식당 예약을 생성합니다",
					whenToUse: {
						afterAvailability: "예약 가능 여부를 확인한 뒤 사용합니다",
					},
				},
			},
		},
	};

	it("resolves requested locale with English fallback", () => {
		expect(resolveProviderLocaleValue(catalogs, providerLocaleKey("meta.description"), "ko")).toBe(
			"식당 예약",
		);
		expect(resolveProviderLocaleValue(catalogs, providerLocaleKey("meta.description"), "ja")).toBe(
			"Restaurant reservations",
		);
	});

	it("validates required key parity", () => {
		const result = validateProviderLocaleCatalogs({
			catalogs,
			requiredLocales: ["en", "ko"],
			requiredKeys: [
				providerLocaleKey("meta.description"),
				providerLocaleKey("operations.reserve.description"),
				providerLocaleKey("operations.reserve.whenToUse.afterAvailability"),
			],
		});

		expect(result.ok).toBe(true);
		expect(result.issues).toHaveLength(0);
	});

	it("materializes auth turn keys from catalogs for one requested locale", () => {
		const turn = localizeAuthTurn(
			{
				kind: "retry",
				turnId: "turn-1",
				hint: "Enter password",
				hintKey: "auth.password.prompt",
				expectedInput: {
					type: "object",
					properties: {
						password: { type: "string", nameKey: "auth.password.fieldLabel" },
					},
				},
				data: {
					fieldErrors: { password: "Required" },
					fieldErrorKeys: { password: "auth.password.fieldRequired" },
				},
			},
			{
				catalogs: {
					en: {
						auth: {
							password: {
								prompt: "Enter password",
								fieldRequired: "Required",
							},
						},
					},
					ko: {
						auth: {
							password: {
								prompt: "비밀번호를 입력하세요",
								fieldRequired: "필수 입력 항목입니다.",
							},
						},
					},
				},
				locale: "ko",
			},
		);

		expect(turn.hint).toBe("비밀번호를 입력하세요");
		expect(turn.data?.fieldErrors).toEqual({
			password: "필수 입력 항목입니다.",
		});
		expect(turn).not.toHaveProperty("localized");
	});

	it("rejects missing required locale keys and placeholder text", () => {
		const result = validateProviderLocaleCatalogs({
			catalogs: {
				en: { meta: { description: "TODO" } },
				ko: { meta: {} },
			},
			requiredLocales: ["en", "ko"],
			requiredKeys: [providerLocaleKey("meta.description")],
		});

		expect(result.ok).toBe(false);
		expect(result.issues.map((issue) => issue.message)).toContain(
			"Provider locale key meta.description in en is empty or placeholder text",
		);
		expect(result.issues.map((issue) => issue.message)).toContain(
			"Missing provider locale key meta.description in ko",
		);
	});
});
