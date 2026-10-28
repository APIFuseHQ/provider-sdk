import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { isSchemaNode, objectShape, schemaChildren, schemaMeta } from "../schema-walk.js";

function kinds(schema: z.ZodType): string[] {
	return Array.from(schemaChildren(schema)).map((edge) =>
		edge.key !== undefined
			? `${edge.kind}:${edge.key}`
			: edge.index !== undefined
				? `${edge.kind}:${edge.index}`
				: edge.kind,
	);
}

describe("schemaChildren", () => {
	it("yields object properties first, then the catchall as an entry", () => {
		expect(kinds(z.object({ a: z.string(), b: z.number() }).catchall(z.boolean()))).toEqual([
			"property:a",
			"property:b",
			"entry",
		]);
	});

	it("yields one wrapper edge for optional, nullable, default, catch, readonly, prefault and lazy", () => {
		const inner = z.string();
		for (const wrapped of [
			inner.optional(),
			inner.nullable(),
			inner.default("x"),
			inner.catch("x"),
			inner.readonly(),
			inner.prefault("x"),
			z.lazy(() => inner),
		]) {
			expect(kinds(wrapped)).toEqual(["wrapper"]);
		}
	});

	it("yields pipe stages and intersection branches as wrappers, in order", () => {
		expect(kinds(z.string().pipe(z.string().min(1)))).toEqual(["wrapper", "wrapper"]);
		expect(kinds(z.object({ a: z.string() }).and(z.object({ b: z.string() })))).toEqual([
			"wrapper",
			"wrapper",
		]);
	});

	it("yields array elements, record value and key types, and tuple items with rest", () => {
		expect(kinds(z.array(z.string()))).toEqual(["element"]);
		expect(kinds(z.record(z.string(), z.number()))).toEqual(["entry", "entry"]);
		expect(kinds(z.tuple([z.string(), z.number()]).rest(z.boolean()))).toEqual([
			"entry",
			"item:0",
			"item:1",
		]);
	});

	it("yields union and discriminated-union branches as indexed options", () => {
		expect(kinds(z.union([z.string(), z.number()]))).toEqual(["option:0", "option:1"]);
		expect(
			kinds(
				z.discriminatedUnion("kind", [
					z.object({ kind: z.literal("a") }),
					z.object({ kind: z.literal("b") }),
				]),
			),
		).toEqual(["option:0", "option:1"]);
	});

	it("yields nothing for leaves", () => {
		expect(kinds(z.string())).toEqual([]);
		expect(kinds(z.enum(["a", "b"]))).toEqual([]);
	});
});

describe("schema node helpers", () => {
	it("recognises zod schemas and reads shape and meta", () => {
		const schema = z.object({ a: z.string() }).meta({ description: "x" });

		expect(isSchemaNode(schema)).toBe(true);
		expect(isSchemaNode({ shape: {} })).toBe(false);
		expect(Object.keys(objectShape(schema))).toEqual(["a"]);
		expect(schemaMeta(schema)).toEqual({ description: "x" });
		expect(schemaMeta(z.string())).toEqual({});
	});
});
