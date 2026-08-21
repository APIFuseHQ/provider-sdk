import { describe, expect, it } from "bun:test";

import { scanTestTypesafety } from "../../scripts/check-test-typesafety.js";

const joined = (...parts: string[]): string => parts.join("");

const hardForbiddenFixtures = [
	joined("value as", " unknown as", " Widget"),
	joined("value as", " any"),
	joined("value as", " Error"),
	joined("value as", " T;"),
];

const justifiedFixtures = [
	joined("Reflect", ".apply(fn, undefined, [])"),
	joined("value as", " never"),
	joined("Func", "tion('return 1')()"),
];

describe("test typesafety gate", () => {
	it.each(hardForbiddenFixtures)("rejects hard-forbidden escape %#", (source) => {
		expect(scanTestTypesafety([source])).toHaveLength(1);
		expect(scanTestTypesafety([`${source} // test-invalid: still forbidden`])).toHaveLength(1);
	});

	it.each(justifiedFixtures)("rejects an unjustified conditional escape %#", (source) => {
		expect(scanTestTypesafety([source])).toHaveLength(1);
	});

	it.each(justifiedFixtures)("accepts a same-line justification %#", (source) => {
		expect(scanTestTypesafety([`${source} // test-invalid: runtime guard input`])).toEqual([]);
	});

	it.each(justifiedFixtures)("accepts a preceding-line justification %#", (source) => {
		expect(scanTestTypesafety(["// test-invalid: runtime guard input", source])).toEqual([]);
	});

	it("recognizes the constructor form and flexible escape whitespace", () => {
		expect(scanTestTypesafety([joined("new Func", "tion('return 1')()")])).toHaveLength(1);
		expect(scanTestTypesafety([joined("Reflect", ".apply (fn, undefined, [])")])).toHaveLength(1);
		expect(scanTestTypesafety([joined("value as", "\tnever")])).toHaveLength(1);
	});

	it("rejects a TypeScript error directive without a justification", () => {
		expect(scanTestTypesafety([joined("// @ts-expect", "-error")])).toHaveLength(1);
	});

	it("accepts a TypeScript error directive with a same-line justification", () => {
		expect(
			scanTestTypesafety([joined("// @ts-expect", "-error test-invalid: runtime guard input")]),
		).toEqual([]);
	});

	it("does not apply the TypeScript error directive justification from the preceding line", () => {
		expect(
			scanTestTypesafety([
				"// test-invalid: runtime guard input",
				joined("// @ts-expect", "-error"),
			]),
		).toHaveLength(1);
	});

	it("accepts clean input and similarly named functions", () => {
		expect(
			scanTestTypesafety(["const value = 1;", "myFunction();", "Function.prototype;"]),
		).toEqual([]);
	});
});
