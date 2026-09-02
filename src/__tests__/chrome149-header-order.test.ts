import { describe, expect, it } from "bun:test";

import alPlacementCapture from "../../al-placement-capture.json";
import chromeValueTransform from "../../chrome-value-transform.json";
import expansionSweep from "../../expansion-sweep.json";
import holdoutCaptures from "../../holdout-capture.json";
import holdoutPredictions from "../../holdout-predictions.json";
import m1Capture from "../../m1-capture.json";
import placementRuleSweep from "../../placement-rule-sweep.json";
import {
	CHROME149_FIXED_MAP_INSERTION,
	chrome149CaseFoldingHash,
	chrome149HeaderOrder,
	chrome149HeaderOrderForMapInsertion,
	chrome149RapidhashFixture,
} from "../runtime/chrome149-header-order.js";

interface SyntheticCapture {
	readonly caller: readonly string[];
	readonly order: readonly string[];
}

interface AcceptLanguagePlacementCapture {
	readonly variant: string;
	readonly caller: readonly string[];
	readonly order: readonly string[];
	readonly acceptLanguage: string;
}

function isSyntheticCapture(value: unknown): value is SyntheticCapture {
	return (
		typeof value === "object" &&
		value !== null &&
		"caller" in value &&
		Array.isArray(value.caller) &&
		"order" in value &&
		Array.isArray(value.order)
	);
}

/**
 * Fixture interpretation for corpora captured through Playwright
 * `newContext({ locale: "ja-JP" })`. Playwright implements `locale` with CDP
 * Emulation.setUserAgentOverride acceptLanguage, which
 * InspectorEmulationAgent::PrepareRequest (inspector_emulation_agent.cc:626-636)
 * applies as a fifth fixed HTTPHeaderMap key after User-Agent unless the page
 * already set one. Real Chrome never does this (al-placement-capture.json B/C):
 * //net appends Accept-Language after Accept-Encoding instead. This list exists
 * only so the harness corpora keep validating the hash and table mechanics; no
 * production code path uses it.
 */
const PLAYWRIGHT_LOCALE_HARNESS_MAP_INSERTION = [
	...CHROME149_FIXED_MAP_INSERTION,
	"Accept-Language",
] as const;

function harnessHeaderOrder(callerNames: Iterable<string>): string[] {
	return chrome149HeaderOrderForMapInsertion(callerNames, PLAYWRIGHT_LOCALE_HARNESS_MAP_INSERTION);
}

const acceptLanguagePlacementCases: Array<[string, AcceptLanguagePlacementCapture]> =
	Object.entries(alPlacementCapture);

describe("Chrome 149 HTTPHeaderMap order emulator", () => {
	it("ships the real-Chrome map: client hints and User-Agent, no Accept-Language", () => {
		expect(CHROME149_FIXED_MAP_INSERTION).toEqual([
			"sec-ch-ua",
			"sec-ch-ua-mobile",
			"sec-ch-ua-platform",
			"User-Agent",
		]);
		expect(chrome149HeaderOrder([])).toEqual(alPlacementCapture.B_nolocale_none.order);
		expect(chrome149HeaderOrder([])).toEqual(alPlacementCapture.C_acceptlang_none.order);
	});

	it("reproduces the 9 Accept-Language placement captures: 6 real-Chrome, 3 harness", () => {
		expect(acceptLanguagePlacementCases).toHaveLength(9);
		const real = acceptLanguagePlacementCases.filter(
			([, capture]) => capture.variant !== "A_locale",
		);
		const harness = acceptLanguagePlacementCases.filter(
			([, capture]) => capture.variant === "A_locale",
		);
		expect(real.map(([label]) => label)).toEqual([
			"B_nolocale_none",
			"B_nolocale_three",
			"B_nolocale_five",
			"C_acceptlang_none",
			"C_acceptlang_three",
			"C_acceptlang_five",
		]);
		expect(harness.map(([label]) => label)).toEqual([
			"A_locale_none",
			"A_locale_three",
			"A_locale_five",
		]);

		// Shipped default (no DevTools): B = no locale, C = --accept-lang=ja. Same
		// order, different //net value.
		for (const [, capture] of real) {
			expect(chrome149HeaderOrder(capture.caller)).toEqual([...capture.order]);
		}
		for (const [, capture] of real) {
			const acceptLanguage = capture.order.indexOf("accept-language");
			expect(acceptLanguage).toBe(capture.order.indexOf("accept-encoding") + 1);
			expect(capture.order[acceptLanguage + 1]).toBe("priority");
		}
		expect(real.map(([, capture]) => capture.acceptLanguage)).toEqual([
			"en-US,en;q=0.9",
			"en-US,en;q=0.9",
			"en-US,en;q=0.9",
			"ja",
			"ja",
			"ja",
		]);

		// Harness interpretation only.
		for (const [, capture] of harness) {
			expect(harnessHeaderOrder(capture.caller)).toEqual([...capture.order]);
		}
		for (const [, capture] of harness) {
			expect(chrome149HeaderOrder(capture.caller)).not.toEqual([...capture.order]);
		}
		for (const [, capture] of real) {
			expect(harnessHeaderOrder(capture.caller)).not.toEqual([...capture.order]);
		}
	});

	it("keeps a caller-supplied Accept-Language at its map bucket and appends no second one", () => {
		// Captured under the locale harness, but InspectorEmulationAgent::PrepareRequest
		// skips a key the page already set, so the map was untouched: this order is
		// also what real Chrome sends, and //net (SetHeaderIfMissing) adds nothing
		// downstream.
		const capture = chromeValueTransform.accept_language_override;
		const caller = Object.keys(capture.sent);
		const observed = Object.keys(capture.observed);
		expect(chrome149HeaderOrder(caller)).toEqual(observed);
		expect(harnessHeaderOrder(caller)).toEqual(observed);
		expect(observed.filter((name) => name === "accept-language")).toHaveLength(1);
		expect(observed.indexOf("accept-language")).toBeLessThan(observed.indexOf("accept"));

		const withOthers = chrome149HeaderOrder(["X-Requested-With", "accept-language", "Priority"]);
		expect(withOthers.filter((name) => name === "accept-language")).toHaveLength(1);
		expect(withOthers.indexOf("accept-language")).toBeLessThan(withOthers.indexOf("accept"));
	});

	it("differs from the harness beyond the Accept-Language move only at the 8-key expansion", () => {
		// Removing the harness's fifth fixed key changes the other keys' order exactly
		// when that key alone pushed the table from 16 to 32 buckets: three caller
		// keys with no caller Accept-Language (7 real keys, 8 harness keys). When the
		// caller supplied Accept-Language the harness override skipped the existing
		// key, so the harness capture is already the real-Chrome order.
		const callerHasAcceptLanguage = (caller: readonly string[]) =>
			caller.some((name) => name.toLowerCase() === "accept-language");
		const realOrderFromHarness = (caller: readonly string[], order: readonly string[]) => {
			if (callerHasAcceptLanguage(caller)) return [...order];
			const moved = order.filter((name) => name !== "accept-language");
			moved.splice(moved.indexOf("accept-encoding") + 1, 0, "accept-language");
			return moved;
		};
		const corpus = [
			...Object.entries(placementRuleSweep).map(([label, capture]) => ({
				label,
				caller: Object.keys(capture.sent),
				order: capture.order,
			})),
			...Object.entries(expansionSweep).map(([label, capture]) => ({
				label,
				caller: capture.caller,
				order: capture.order,
			})),
			...Object.entries(m1Capture).flatMap(([label, capture]) =>
				label.startsWith("m1_") &&
				isSyntheticCapture(capture) &&
				!capture.caller.includes("If-None-Match")
					? [{ label, caller: capture.caller, order: capture.order }]
					: [],
			),
		];
		expect(corpus).toHaveLength(33 + 17 + 5);
		const withCallerAcceptLanguage = corpus.filter(({ caller }) => callerHasAcceptLanguage(caller));
		expect(withCallerAcceptLanguage).toHaveLength(10);
		for (const { caller, order } of withCallerAcceptLanguage) {
			expect(chrome149HeaderOrder(caller)).toEqual([...order]);
		}
		const reordered = corpus.filter(
			({ caller, order }) =>
				JSON.stringify(chrome149HeaderOrder(caller)) !==
				JSON.stringify(realOrderFromHarness(caller, order)),
		);
		const eightHarnessKeys = corpus.filter(
			({ caller }) => caller.length === 3 && !callerHasAcceptLanguage(caller),
		);
		expect(reordered.map(({ label }) => label)).toEqual(eightHarnessKeys.map(({ label }) => label));
		expect(reordered.map(({ label }) => label)).toEqual([
			"three_accept_prio_uir",
			"n3",
			"alt3",
			"m1_0",
			"m1_2",
			"m1_4",
			"m1_6",
			"m1_7",
		]);
	});

	it("reproduces all 33 derivation captures through the harness interpretation", () => {
		const results = Object.entries(placementRuleSweep).map(([label, capture]) => ({
			label,
			matches: harnessHeaderOrder(Object.keys(capture.sent)).every(
				(name, index) => name === capture.order[index],
			),
			predictedLength: harnessHeaderOrder(Object.keys(capture.sent)).length,
			expectedLength: capture.order.length,
		}));
		const exactMatches = results.filter(
			(result) => result.matches && result.predictedLength === result.expectedLength,
		);
		expect(results).toHaveLength(33);
		expect(exactMatches).toHaveLength(33);
		expect(results.filter((result) => !exactMatches.includes(result))).toEqual([]);
	});

	it("reproduces 9 of 10 frozen holdouts through the harness and reports the If-None-Match limitation", () => {
		const results = Object.entries(holdoutCaptures).map(([label, capture]) => ({
			label,
			actual: capture.order,
			predicted: harnessHeaderOrder(capture.caller_names),
		}));
		const matches = results.filter(
			({ actual, predicted }) => JSON.stringify(actual) === JSON.stringify(predicted),
		);
		const mismatches = results.filter(
			({ actual, predicted }) => JSON.stringify(actual) !== JSON.stringify(predicted),
		);

		expect(results).toHaveLength(10);
		expect(matches).toHaveLength(9);
		expect(mismatches.map(({ label }) => label)).toEqual(["h_ifnone"]);
		expect(mismatches[0]?.predicted).toEqual(holdoutPredictions.h_ifnone);
		expect(mismatches[0]?.actual[0]).toBe("cache-control");
		expect(mismatches[0]?.predicted[0]).toBe("if-none-match");
	});

	it("places a name absent from every fixture by its hash-derived bucket", () => {
		const novelName = "X-Novel-Hashmap-Probe";
		const fixtureText = JSON.stringify([placementRuleSweep, holdoutCaptures, alPlacementCapture]);
		expect(fixtureText.toLowerCase()).not.toContain(novelName.toLowerCase());

		// Frozen from: python3 chrome149_header_order.py --json X-Novel-Hashmap-Probe
		expect(chrome149CaseFoldingHash(novelName)).toBe(0x947f45);
		expect(chrome149HeaderOrder([novelName])).toEqual([
			"sec-ch-ua-platform",
			"x-novel-hashmap-probe",
			"user-agent",
			"sec-ch-ua",
			"sec-ch-ua-mobile",
			"accept",
			"sec-fetch-site",
			"sec-fetch-mode",
			"sec-fetch-dest",
			"referer",
			"accept-encoding",
			"accept-language",
			"priority",
		]);
		// Frozen from: python3 chrome149_header_order.py --harness --json X-Novel-Hashmap-Probe
		expect(harnessHeaderOrder([novelName])).toEqual([
			"sec-ch-ua-platform",
			"x-novel-hashmap-probe",
			"user-agent",
			"sec-ch-ua",
			"accept-language",
			"sec-ch-ua-mobile",
			"accept",
			"sec-fetch-site",
			"sec-fetch-mode",
			"sec-fetch-dest",
			"referer",
			"accept-encoding",
			"priority",
		]);
	});

	it("reproduces all 17 synthetic expansion-ladder captures through the harness interpretation", () => {
		// expansion-sweep.json walks 5..15 map keys through the 8 -> 16 -> 32 bucket
		// expansions using X-* names Chrome treats as inert. The 10- and 11-key cases
		// (n5, alt5, alt6) are where a fixed header wins a home bucket shared with a
		// caller header; the pre-fix insertion sequence reversed that winner.
		const results = Object.entries(expansionSweep).map(([label, capture]) => ({
			label,
			predicted: harnessHeaderOrder(capture.caller),
			actual: capture.order,
		}));
		expect(results).toHaveLength(17);
		expect(
			results
				.filter(({ predicted, actual }) => JSON.stringify(predicted) !== JSON.stringify(actual))
				.map(({ label }) => label),
		).toEqual([]);
	});

	it("reproduces the 5 M1 discriminator captures through the harness and documents the If-None-Match ones", () => {
		const cases = Object.entries(m1Capture).flatMap(([label, capture]) =>
			label.startsWith("m1_") && isSyntheticCapture(capture) ? [{ label, capture }] : [],
		);
		expect(cases).toHaveLength(8);

		const plain = cases.filter(({ capture }) => !capture.caller.includes("If-None-Match"));
		expect(plain.map(({ label }) => label)).toEqual(["m1_0", "m1_2", "m1_4", "m1_6", "m1_7"]);
		expect(
			plain
				.filter(
					({ capture }) =>
						JSON.stringify(harnessHeaderOrder(capture.caller)) !== JSON.stringify(capture.order),
				)
				.map(({ label }) => label),
		).toEqual([]);

		// //net prepends "Cache-Control: max-age=0" for conditional requests
		// (HttpNetworkTransaction::BuildRequestHeaders, LOAD_VALIDATE_CACHE). That is
		// outside the Blink map; the rest of the order is still reproduced exactly.
		const conditional = cases.filter(({ capture }) => capture.caller.includes("If-None-Match"));
		expect(conditional.map(({ label }) => label)).toEqual(["m1_1", "m1_3", "m1_5"]);
		for (const { capture } of conditional) {
			expect(capture.order[0]).toBe("cache-control");
			expect(harnessHeaderOrder(capture.caller)).toEqual(capture.order.slice(1));
		}
	});

	it("reproduces the 3 Range captures with Range as a map key re-added at the tail", () => {
		// A page-set Range is an ordinary Fetch header and occupies a HTTPHeaderMap
		// bucket; HttpCache::Transaction then removes it from the request headers and
		// PartialData re-adds it after everything //net appended (Accept-Encoding,
		// Accept-Language when //net adds it, Cookie), before Priority. Excluding Range
		// from the map is wrong when its bucket displaces another key (range_accept).
		const withRangeAtTail = (order: readonly string[]) => {
			const moved = order.filter((name) => name !== "range");
			let insertAt = moved.indexOf("accept-encoding") + 1;
			if (moved[insertAt] === "accept-language") insertAt += 1;
			moved.splice(insertAt, 0, "range");
			return moved;
		};
		const cases = Object.entries(m1Capture).flatMap(([label, capture]) =>
			label.startsWith("range_") && isSyntheticCapture(capture) ? [{ label, capture }] : [],
		);
		expect(cases.map(({ label }) => label)).toEqual(["range_alone", "range_accept", "range_ctype"]);
		for (const { capture } of cases) {
			expect(capture.caller).toContain("Range");
			expect(withRangeAtTail(harnessHeaderOrder(capture.caller))).toEqual([...capture.order]);
		}
		const withoutRangeKey = m1Capture.range_accept.caller.filter((name) => name !== "Range");
		expect(withRangeAtTail(harnessHeaderOrder(withoutRangeKey))).not.toEqual([
			...m1Capture.range_accept.order,
		]);
		// Real Chrome: same mechanics, Accept-Language at the //net slot before Range.
		expect(withRangeAtTail(chrome149HeaderOrder(["Range", "Accept"]))).toEqual([
			"sec-ch-ua-platform",
			"user-agent",
			"accept",
			"sec-ch-ua",
			"sec-ch-ua-mobile",
			"sec-fetch-site",
			"sec-fetch-mode",
			"sec-fetch-dest",
			"referer",
			"accept-encoding",
			"accept-language",
			"range",
			"priority",
		]);
	});

	it("kills the initial-table-size mutation (M1) with the two 8-bucket-only captures", () => {
		// Both captures depend on a probe wrapping past the end of the 8-bucket
		// initial table. m1_6: Cache-Control and X-C share bucket 5; sorted caller
		// insertion puts Cache-Control at 5, Priority at 6 and X-C wraps to 0, so the
		// upward-scanning 8 -> 16 rehash reinserts X-C first and it keeps bucket 5 in
		// every later table. m1_7: X-Api-Key wraps to 0 the same way and thereafter
		// precedes X-A. With a 16-bucket initial table nothing wraps and the emulator
		// emits cache-control before x-c, and x-a before x-api-key, contradicting Chrome.
		// The table class is shared, so the harness interpretation kills the mutant
		// for the production path too.
		expect(harnessHeaderOrder(["Cache-Control", "Priority", "X-C"])).toEqual(m1Capture.m1_6.order);
		expect(harnessHeaderOrder(["Cache-Control", "X-Api-Key", "X-A"])).toEqual(m1Capture.m1_7.order);
		const realM16 = chrome149HeaderOrder(["Cache-Control", "Priority", "X-C"]);
		expect(realM16.indexOf("x-c")).toBeLessThan(realM16.indexOf("cache-control"));
		const realM17 = chrome149HeaderOrder(["Cache-Control", "X-Api-Key", "X-A"]);
		expect(realM17.indexOf("x-api-key")).toBeLessThan(realM17.indexOf("x-a"));
	});

	it("matches Chromium's numeric rapidhash fixture and case-fold equality", () => {
		expect(chrome149RapidhashFixture()).toEqual({
			full: 0xe9422771e0a5dde6n,
			masked: 0xa5dde6,
		});
		expect(chrome149CaseFoldingHash("Longer string 123")).toBe(
			chrome149CaseFoldingHash("longEr String 123"),
		);
	});
});
