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

	const placeholderKey = providerLocaleKey("meta.description");

	function placeholderIssues(text: string): string[] {
		const result = validateProviderLocaleCatalogs({
			catalogs: { en: { meta: { description: text } } },
			requiredLocales: ["en"],
			requiredKeys: [placeholderKey],
		});
		return result.issues.map((issue) => issue.message);
	}

	const placeholderMessage =
		"Provider locale key meta.description in en is empty or placeholder text";

	it.each([
		["TODO", "TODO"],
		["TODO with prose", "TODO: describe this provider"],
		["FIXME", "FIXME"],
		["FIXME inside prose", "Lists events (FIXME wording)"],
		["TRANSLATE", "TRANSLATE"],
		["TRANSLATE with prose", "TRANSLATE: 문화 행사 목록"],
		["TBD", "TBD"],
		["TBD inside prose", "Description TBD"],
		["[ko] tag", "[ko] Search cultural events"],
		["[ja] tag", "[ja] Search cultural events"],
		["[en] tag", "[en] 문화 행사 검색"],
		["upper-case [KO] tag", "[KO] Search cultural events"],
		["번역 필요", "번역 필요"],
		["번역 필요 inside prose", "문화 행사 검색 (번역 필요)"],
		["번역필요 without space", "번역필요"],
		["翻訳が必要", "翻訳が必要"],
		["翻訳が必要 inside prose", "文化イベント検索（翻訳が必要）"],
		["whitespace only", "   "],
	])("flags placeholder marker: %s", (_label, text) => {
		expect(placeholderIssues(text)).toEqual([placeholderMessage]);
	});

	it.each([
		["lower-case todo in prose", "Manage your todo list"],
		["lower-case fixme in prose", "fixme is not a marker in prose"],
		["lower-case tbd in prose", "tbd"],
		["TBD glued to a suffix", "TBDx"],
		["TBD glued to a prefix", "xTBD"],
		["TODO inside an identifier", "TODO_LIST"],
		["TODO as part of a longer word", "TODOS"],
		["TRANSLATE as part of a longer word", "TRANSLATED subtitles"],
		["Translate in ordinary prose", "Translate menus into Korean"],
		["locale code without brackets", "Available in ko, ja and en"],
		["bracketed non-locale token", "[beta] Search cultural events"],
		["Korean prose mentioning translation", "번역 서비스가 필요한 문서"],
		["Japanese prose mentioning translation", "翻訳サービスを検索"],
		["ordinary Korean prose", "문화 행사 검색"],
		["ordinary English prose", "Search cultural events by region"],
	])("does not flag ordinary prose: %s", (_label, text) => {
		expect(placeholderIssues(text)).toEqual([]);
	});

	it("flags placeholder markers inside string-array values", () => {
		const result = validateProviderLocaleCatalogs({
			catalogs: {
				en: { meta: { tags: ["Search cultural events", "[ko] 태그"] } },
			},
			requiredLocales: ["en"],
			requiredKeys: [providerLocaleKey("meta.tags")],
		});

		expect(result.ok).toBe(false);
		expect(result.issues.map((issue) => issue.message)).toEqual([
			"Provider locale key meta.tags in en is empty or placeholder text",
		]);
	});
});
