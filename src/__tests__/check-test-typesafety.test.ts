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
	joined("Set<", "unknown>"),
	joined("Record<string, ", "unknown>"),
	joined("Array<Map<string, ", "unknown>>"),
];

const genericCallFixtures = [
	joined("const g = factory()<", "any>(1);"),
	joined("const g = handlers[0]<", "Error>(x);"),
	joined("const g = maybe?.<", "never>(x);"),
];

const doubleAssertionFixtures = [
	joined("const b = <", "unknown>(a) as", " string;"),
	joined("const b = <", "unknown>items[0] as", " Foo;"),
	joined("const b = <Mocked<Foo>><", "unknown>value;"),
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

	it.each(genericCallFixtures)("accepts generic call with gated angle type %#", (source) => {
		expect(scanTestTypesafety([source])).toEqual([]);
	});

	it.each(doubleAssertionFixtures)("rejects unknown double assertion %#", (source) => {
		expect(scanTestTypesafety([source])).toHaveLength(1);
	});

	it("accepts the factory generic-call controller reproduction", () => {
		expect(scanTestTypesafety([joined("const g = factory()<", "any>(1);")])).toEqual([]);
	});

	it("ignores a TypeScript error directive assembled from string contents", () => {
		expect(
			scanTestTypesafety([
				joined('const src = ["// @ts-expect', '-error", " input"].join("");'),
			]),
		).toEqual([]);
	});

	it("ignores a TypeScript error directive and marker inside a string", () => {
		expect(
			scanTestTypesafety([
				joined('const raw = "// @ts-expect', '-error test-invalid: input";'),
			]),
		).toEqual([]);
	});

	it("recognizes a marker in a block comment opened on an earlier line", () => {
		expect(
			scanTestTypesafety([
				"/* runtime guard annotation",
				joined("test-", "invalid: input */"),
				joined("const cast = value as", " never;"),
			]),
		).toEqual([]);
	});

	it("rejects an angle assertion containing comment trivia", () => {
		expect(
			scanTestTypesafety([
				joined("const a = < /* why */ ", 'any>JSON.parse("1");'),
			]),
		).toHaveLength(1);
	});

	it("rejects the parenthesized unknown double-assertion reproduction", () => {
		expect(
			scanTestTypesafety([joined("const b = <", "unknown>(a) as", " string;")]),
		).toHaveLength(1);
	});

	it("checks code inside template holes after masking template content", () => {
		expect(
			scanTestTypesafety([joined("const source = `${value as", " any}`;")]),
		).toHaveLength(1);
	});

	it("does not let comment lookalikes in a template hole fire or justify", () => {
		const template = joined(
			"const source = `value ${\"// @ts-expect",
			'-error test-invalid: input"}`;',
		);
		expect(scanTestTypesafety([template])).toEqual([]);
		expect(scanTestTypesafety([template, joined("const cast = value as", " never;")])).toHaveLength(
			1,
		);
	});

	it("does not let line-comment lookalikes in a nested template fire or justify", () => {
		const template = joined(
			"const source = `outer ${`// @ts-expect",
			"-error test-invalid: input`} end`;",
		);
		expect(scanTestTypesafety([template])).toEqual([]);
		expect(scanTestTypesafety([template, joined("const cast = value as", " never;")])).toHaveLength(
			1,
		);
	});

	it("normalizes CRLF before masking across lines", () => {
		expect(
			scanTestTypesafety(
				joined(
					"/* runtime guard\r\n",
					"test-",
					"invalid: input */\r\n",
					"const cast = value as",
					" never;\r\n",
				),
			),
		).toEqual([]);
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

	it("accepts a multi-line block-comment justification ending on the preceding line", () => {
		expect(
			scanTestTypesafety([
				joined("/* test-", "invalid: multi-line annotation"),
				"   for the escape below */",
				joined("const cast = 1 as", " never;"),
			]),
		).toEqual([]);
	});

	it("does not let a code line inside the annotation walk carry the blessing", () => {
		expect(
			scanTestTypesafety([
				joined("// test-", "invalid: far away"),
				"const code = 1;",
				joined("const cast = 2 as", " never;"),
			]),
		).toHaveLength(1);
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
