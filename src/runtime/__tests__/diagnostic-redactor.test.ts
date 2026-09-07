import { describe, expect, it, spyOn } from "bun:test";

import {
	compileDiagnosticSensitiveValues,
	createDiagnosticRedactor,
	REDACTION_FAILED,
	redactDiagnosticText,
} from "../diagnostic-redactor.js";
import * as requestOptions from "../request-options.js";
import { redactSensitiveText } from "../request-options.js";

describe("request diagnostic sensitive registry", () => {
	it("matches URL variants without rewriting unrelated URL bytes", () => {
		const redact = createDiagnosticRedactor(["a/b c", "/é"]).redact;
		expect(redact("a%2fb%20c a%2Fb+c /%2f%c3%a9/ keep%2fbytes")).toBe(
			"a%2fb%20c a%2Fb+c /%2f%c3%a9/ keep%2fbytes",
		);
	});
	it("redacts exact arbitrary secret text without interpreting regular expression syntax", () => {
		const { redact } = createDiagnosticRedactor(["key.*+[value]($)^?\\secret"]);
		expect(redact("before key.*+[value]($)^?\\secret after keyABCvalue")).toBe(
			"before [REDACTED] after keyABCvalue",
		);
	});

	it.each([
		"api",
		"éçü",
		"한글값",
	])("refuses three-character registration %s while retaining legacy request-options matching", (secret) => {
		const { redact } = createDiagnosticRedactor([secret]);
		const text = `${secret} /${secret}/ prefix${secret}suffix é${secret} 中${secret} ${secret}3 _${secret}_`;
		const expected = `[REDACTED] /[REDACTED]/ prefix${secret}suffix é${secret} 中${secret} ${secret}3 _[REDACTED]_`;
		expect(redact(text)).toBe(text);
		expect(redactSensitiveText(text, [secret])).toBe(expected);
	});

	it("bounds short tokens and matches long values inside URL paths", () => {
		const { redact } = createDiagnosticRedactor(["key4", "hrfcokey1234"]);
		expect(redact("prefixkey4suffix https://vendor.test/hrfcokey1234/items key3")).toBe(
			"prefixkey4suffix https://vendor.test/[REDACTED]/items key3",
		);
	});

	it("uses the longest overlapping value and never scans newly inserted placeholders", () => {
		const { redact } = createDiagnosticRedactor(["live", "sk-live-abc", "sk-live", "ACTE"]);
		expect(redact("sk-live-abc sk-live live ACTE")).toBe(
			"[REDACTED] [REDACTED] [REDACTED] [REDACTED]",
		);
	});

	it("adds later transport declarations to the same closure and ignores empty or duplicate values", () => {
		const registry = createDiagnosticRedactor(["first-secret", "", "first-secret"]);
		const redactorAlreadyHandedToTrace = registry.redact;
		registry.add(["second-secret", "second-secret", ""]);
		expect(redactorAlreadyHandedToTrace("first-secret second-secret remaining")).toBe(
			"[REDACTED] [REDACTED] remaining",
		);
		expect(redactorAlreadyHandedToTrace("")).toBe("");
	});

	it("keeps each request's registry isolated", () => {
		const first = createDiagnosticRedactor(["first-secret"]);
		const second = createDiagnosticRedactor(["second-secret"]);
		first.add(["later-secret"]);
		const diagnostic = "first-secret second-secret later-secret";
		expect(first.redact(diagnostic)).toBe("[REDACTED] second-secret [REDACTED]");
		expect(second.redact(diagnostic)).toBe("first-secret [REDACTED] later-secret");
	});

	it("fails closed without echoing either the original text or the redactor failure", () => {
		expect(
			redactDiagnosticText("original-secret", () => {
				throw new Error("failure-secret");
			}),
		).toBe(REDACTION_FAILED);
		expect(redactDiagnosticText("safe text")).toBe("safe text");
	});
});

// Adapted from /tmp/p4-review-scratch/main/{review,nonstring}.test.ts.
describe("review regression: fail closed and matching bypasses", () => {
	const secret = "orchardgrove";
	it("uses a twelve-character dictionary sentinel", () => {
		expect(secret.length).toBe(12);
	});
	it.each([
		["undefined", () => undefined],
		["null", () => null],
		["boxed", (text: string) => new String(text)],
		["object", (text: string) => ({ raw: text, toString: () => text })],
		["number", () => 1234],
		["boolean", () => true],
	] as const)("rejects %s callback results before any consumer sees them", (_mode, callback) => {
		const invalid = { redact: (text: string) => text };
		Object.defineProperty(invalid, "redact", { value: callback });
		expect(redactDiagnosticText(secret, invalid.redact)).toBe(REDACTION_FAILED);
		const registry = createDiagnosticRedactor([secret]);
		registry.redact = invalid.redact;
		expect(registry.redact(secret)).toBe(REDACTION_FAILED);
		expect(registry.redact("benign")).toBe(REDACTION_FAILED);
	});

	it("post-checks identity and corrupted callback output independently", () => {
		const registry = createDiagnosticRedactor([secret]);
		registry.redact = (text) => text;
		expect(registry.redact(`vendor ${secret}`)).toBe(REDACTION_FAILED);
		expect(registry.redact("vendor unavailable")).toBe("vendor unavailable");
		registry.redact = () => `invented ${secret}`;
		expect(registry.redact("vendor unavailable")).toBe(REDACTION_FAILED);
		registry.redact = () => Buffer.from(secret).toString("base64url");
		expect(registry.redact("vendor unavailable")).toBe(REDACTION_FAILED);
	});

	it("keeps second-call failure and late replacements fail closed", () => {
		const registry = createDiagnosticRedactor([secret]);
		const good = registry.redact;
		let calls = 0;
		registry.redact = (text) => {
			if (++calls === 2) throw new Error(secret);
			return good(text);
		};
		expect(registry.redact(secret)).toBe("[REDACTED]");
		expect(registry.redact(secret)).toBe(REDACTION_FAILED);
		expect(registry.redact(secret)).toBe("[REDACTED]");
		const live = (text: string) => redactDiagnosticText(text, registry.redact);
		registry.redact = () => {
			throw new Error(secret);
		};
		expect(live(secret)).toBe(REDACTION_FAILED);
		registry.redact = (text) => text;
		registry.add(["honeysuckles"]);
		expect(live("honeysuckles")).toBe(REDACTION_FAILED);
		expect(live("readable")).toBe("readable");
	});

	it.each([
		["literal", secret, secret, "[REDACTED]"],
		["partial percent", secret, "%6frchardgrove", "[REDACTED]"],
		["unreserved percent", "Apple", "%41pple", "%41pple"],
		["component percent", "a b/c", "a%20b%2fc", "a%20b%2fc"],
		["double percent", "a b/c", "a%2520b%252fc", "a%2520b%252fc"],
		["triple percent", "a b/c", "a%252520b%25252fc", "a%252520b%25252fc"],
		["malformed unrelated percent", secret, "%ZZ %6frchardgrove", "[REDACTED]"],
		["base64 padded", "orchard", Buffer.from("orchard").toString("base64"), "b3JjaGFyZA=="],
		[
			"base64 unpadded",
			"orchard",
			Buffer.from("orchard").toString("base64").replace(/=+$/, ""),
			"b3JjaGFyZA",
		],
		[
			"base64url padded",
			"orchard?>",
			Buffer.from("orchard?>").toString("base64").replaceAll("+", "-").replaceAll("/", "_"),
			"[REDACTED]",
		],
		[
			"base64url unpadded",
			"orchard?>",
			Buffer.from("orchard?>").toString("base64url"),
			"[REDACTED]",
		],
		["long token", secret, `pre${secret}post`, "pre[REDACTED]post"],
		["JSON escaped", 'orch"ard', JSON.stringify({ x: 'orch"ard' }), '{"x":"[REDACTED]"}'],
		["NFC needle NFD haystack", "caféine", "caféine".normalize("NFD"), "caféine"],
		["NFD needle NFC haystack", "caféine".normalize("NFD"), "caféine", "[REDACTED]"],
		["long case fold", "Orchardgrove", secret, "[REDACTED]"],
		["eight-character case fold", "Orchards", "orchards", "[REDACTED]"],
		["seven-character trade-off", "Orchard", "orchard", "orchard"],
		["short token", "apis", "rapid apis capillary", "rapid [REDACTED] capillary"],
	] as const)("matches %s", (_vector, value, input, expected) => {
		for (const registry of [
			createDiagnosticRedactor([value]),
			createDiagnosticRedactor(
				[],
				compileDiagnosticSensitiveValues([
					value,
					...Array.from({ length: 20 }, (_, index) => `unrelatedcredential${index}`),
				]),
			),
		]) {
			expect(registry.redact(input)).toBe(expected);
			registry.redact = (text) => text;
			expect(registry.redact(input)).toBe(input === expected ? input : REDACTION_FAILED);
		}
	});

	it("does not claim to detect a secret split across separate attributes", () => {
		const registry = createDiagnosticRedactor([secret]);
		expect(registry.redact("orchard")).toBe("orchard");
		expect(registry.redact("secret")).toBe("secret");
	});
});

it("shares process-static compilation while keeping request additions and checks private", () => {
	const compiled = compileDiagnosticSensitiveValues(["orchardgrove"]);
	const first = createDiagnosticRedactor([], compiled);
	const second = createDiagnosticRedactor([], compiled);
	first.add(["honeysuckles"]);
	expect(first.redact("orchardgrove honeysuckles")).toBe("[REDACTED]");
	expect(second.redact("orchardgrove honeysuckles")).toBe("[REDACTED] honeysuckles");
	first.redact = (text) => text;
	expect(first.redact("ORCHARDGROVE")).toBe(REDACTION_FAILED);
	expect(first.redact("honeysuckles")).toBe(REDACTION_FAILED);
	expect(Object.isFrozen(compiled)).toBe(true);
});

it("suppresses overlapping static and request credentials without retaining fragments", () => {
	const registry = createDiagnosticRedactor(
		["orchardgrove"],
		compileDiagnosticSensitiveValues(["orchard"]),
	);
	expect(registry.redact("before orchardgrove after")).toBe("before [REDACTED] after");
});

it.each([
	"orchardgrove",
	"orchard yard",
])("fails closed beyond three percent rounds: %s", (secret) => {
	let encoded = secret.includes(" ") ? encodeURIComponent(secret) : `%6f${secret.slice(1)}`;
	for (let round = 1; round <= 7; round++) {
		const registry = createDiagnosticRedactor([secret]);
		expect(registry.redact(encoded)).toBe(round <= 3 ? "[REDACTED]" : REDACTION_FAILED);
		registry.redact = (text) => text;
		expect(registry.redact(encoded)).toBe(REDACTION_FAILED);
		encoded = encoded.replaceAll("%", "%25");
	}
});

it("preserves short coincidences in critical fields and encoded cursors while matching free-text tokens", () => {
	const registry = createDiagnosticRedactor(["true", "1234", "read", "mail", "orchardgrove"]);
	expect(registry.redact("mailbox unread req1234 TRUE dHJ1ZQ== %74rue")).toBe(
		"mailbox unread req1234 TRUE dHJ1ZQ== %74rue",
	);
	expect(registry.redact("Cannot read mailbox; mail true 1234")).toBe(
		"Cannot [REDACTED] mailbox; [REDACTED] [REDACTED] [REDACTED]",
	);
	expect(registry.redactCritical("mail_unavailable req-1234-N read true")).toBe(
		"mail_unavailable req-1234-N read true",
	);
	expect(registry.redactCritical("req-orchardgrove")).toBe("req-[REDACTED]");
	registry.redact = (text) => text;
	expect(registry.redactCritical("req-orchardgrove")).toBe(REDACTION_FAILED);
});

it("generates request variants lazily once per new value and rechecks callback-time additions", () => {
	const hook = spyOn(requestOptions, "allSensitiveValueVariants");
	try {
		const registry = createDiagnosticRedactor();
		registry.add(["orchardgrove"]);
		registry.add(["orchardgrove", "meadowwillow"]);
		expect(hook).toHaveBeenCalledTimes(0);
		expect(registry.redact("orchardgrove meadowwillow")).toBe("[REDACTED] [REDACTED]");
		expect(hook.mock.calls).toEqual([[["orchardgrove", "meadowwillow"]]]);
		registry.add(["willowforest"]);
		expect(registry.redact("willowforest")).toBe("[REDACTED]");
		expect(hook.mock.calls).toEqual([[["orchardgrove", "meadowwillow"]], [["willowforest"]]]);
		registry.redact = (text) => {
			registry.add(["gardenflower"]);
			return text;
		};
		expect(registry.redact("gardenflower")).toBe(REDACTION_FAILED);
	} finally {
		hook.mockRestore();
	}
});

it("preserves checker independence after eviction, late additions and inputs beyond the cache bound", () => {
	const source = ["orchardgrove"];
	const compiled = compileDiagnosticSensitiveValues(source);
	source[0] = "changedvalue";
	const first = createDiagnosticRedactor([], compiled),
		second = createDiagnosticRedactor([], compiled);
	const saved = first.redact;
	first.redact = (text) => text;
	expect(first.redact("orchardgrove")).toBe(REDACTION_FAILED);
	for (let i = 0; i < 600; i++) expect(first.redact(`odd-${i}-☃-%zz`)).toBe(`odd-${i}-☃-%zz`);
	first.add(["meadowwillow"]);
	expect(first.redact("meadowwillow")).toBe(REDACTION_FAILED);
	expect(saved("meadowwillow")).toBe("[REDACTED]");
	expect(second.redact("meadowwillow")).toBe("meadowwillow");
	expect(first.redact("x".repeat(5000) + "orchardgrove")).toBe(REDACTION_FAILED);
	expect(first.redact("x".repeat(5000))).toBe("x".repeat(5000));
});

it("matches short percent-looking credentials literally and case-sensitively", () => {
	for (const values of [
		["a%2fb"],
		["a%2fb", ...Array.from({ length: 30 }, (_, i) => `unrelated-value-${i}`)],
	]) {
		const registry = createDiagnosticRedactor(values);
		expect(registry.redact("a%2fb")).toBe("[REDACTED]");
		expect(registry.redact("a%2Fb")).toBe("a%2Fb");
		expect(registry.redact("a/b")).toBe("a/b");
		expect(redactSensitiveText("a%2fb", values)).toBe("[REDACTED]");
		registry.redact = (text) => text;
		expect(registry.redact("a%2fb")).toBe(REDACTION_FAILED);
	}
});
