import { describe, expect, it } from "bun:test";

import { scanTestTypesafety } from "../../scripts/check-test-typesafety.js";

const joined = (...parts: string[]): string => parts.join("");

const hardForbiddenFixtures = [
	joined("value as", " unknown as", " Widget"),
	joined("value as", " any"),
	joined("value as", " Error"),
	joined("value as", " T;"),
	joined("<", "any>value"),
	joined("<", "Error>value"),
	joined("<Widget><", "unknown>value"),
	joined("<", "unknown>value as", " Widget"),
];

const justifiedFixtures = [
	joined("Reflect", ".apply(fn, undefined, [])"),
	joined("value as", " never"),
	joined("<", "never>value"),
	joined("Func", "tion('return 1')()"),
];

const genericTypeArgumentFixtures = [
	joined("Set<", "any>"),
	joined("Promise<", "Error>"),
	joined("Record<string, ", "never>"),
	joined("Array<", "unknown>"),
	joined("Map<string, ", "any>"),
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

	it("rejects block-comment-split casts", () => {
		expect(scanTestTypesafety([joined("value as", " /* intentional */ never")])).toHaveLength(1);
		expect(scanTestTypesafety([joined("value as", " /* intentional */ any")])).toHaveLength(1);
	});

	it.each(genericTypeArgumentFixtures)("accepts generic type argument %#", (source) => {
		expect(scanTestTypesafety([source])).toEqual([]);
	});

	it("does not accept a same-line justification marker inside a string", () => {
		expect(
			scanTestTypesafety([
				joined('const value = "test-', 'invalid:"; const cast = 1 as', " never;"),
			]),
		).toHaveLength(1);
	});

	it("does not accept a preceding-line justification marker inside a string", () => {
		expect(
			scanTestTypesafety([
				joined('const marker = "test-', 'invalid: not a comment";'),
				joined("const cast = 1 as", " never;"),
			]),
		).toHaveLength(1);
	});

	it("does not apply a trailing-comment justification to the next line", () => {
		expect(
			scanTestTypesafety([
				joined("const value = 1; // test-", "invalid: applies only to this line"),
				joined("const cast = 1 as", " never;"),
			]),
		).toHaveLength(1);
	});

	it("accepts a standalone block-comment justification on the preceding line", () => {
		expect(
			scanTestTypesafety([
				joined("/* test-", "invalid: runtime guard input */"),
				joined("const cast = 1 as", " never;"),
			]),
		).toEqual([]);
	});

	it("rejects the angle assertion and comment-split cast controller reproduction", () => {
		expect(
			scanTestTypesafety([
				joined("const a = <", 'any>JSON.parse("1");'),
				joined("const b = a as", " /* intentional */ never;"),
			]),
		).toHaveLength(2);
	});

	it("rejects the string-marker controller reproduction", () => {
		expect(
			scanTestTypesafety([
				joined('const s = "test-', 'invalid: not a comment";'),
				joined("const t = 1 as", " never;   // passed unannotated"),
			]),
		).toHaveLength(1);
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
