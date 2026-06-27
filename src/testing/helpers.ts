import { describe, expect, it } from "bun:test";

type ShapeMatcher =
	| "array"
	| "boolean"
	| "null"
	| "number"
	| "object"
	| "string"
	| "undefined";

interface ShapeObject {
	[key: string]: ShapeValue;
}

interface ShapeArray extends Array<ShapeValue> {}

type ShapeValue = ShapeMatcher | ShapeObject | ShapeArray | unknown;

const SHAPE_MATCHERS = new Set<ShapeMatcher>([
	"array",
	"boolean",
	"null",
	"number",
	"object",
	"string",
	"undefined",
]);

/**
 * Describe a transform function with before/after snapshot testing.
 * Usage: describeTransform("normalizeUser", rawInput, expectedOutput, transformFn)
 */
export function describeTransform<TRaw, TOutput>(
	name: string,
	raw: TRaw,
	expected: TOutput,
	transformFn: (raw: TRaw) => TOutput,
): void {
	describe(`transform: ${name}`, () => {
		it("produces expected output", () => {
			const result = transformFn(raw);
			expect(result).toEqual(expected);
		});

		it("is pure (same input → same output)", () => {
			const result1 = transformFn(raw);
			const result2 = transformFn(raw);
			expect(result1).toEqual(result2);
		});
	});
}

function assertShape(received: unknown, shape: ShapeValue, path: string): void {
	if (typeof shape === "string" && SHAPE_MATCHERS.has(shape as ShapeMatcher)) {
		switch (shape) {
			case "array":
				expect(Array.isArray(received), `${path} should be an array`).toBe(
					true,
				);
				return;
			case "null":
				expect(received, `${path} should be null`).toBeNull();
				return;
			case "object":
				expect(received, `${path} should be an object`).not.toBeNull();
				expect(typeof received, `${path} should be an object`).toBe("object");
				expect(Array.isArray(received), `${path} should not be an array`).toBe(
					false,
				);
				return;
			case "undefined":
				expect(received, `${path} should be undefined`).toBeUndefined();
				return;
			default: {
				const receivedType = typeof received as ShapeMatcher;
				expect(receivedType, `${path} should be ${shape}`).toBe(
					shape as ShapeMatcher,
				);
				return;
			}
		}
	}

	if (Array.isArray(shape)) {
		expect(Array.isArray(received), `${path} should be an array`).toBe(true);

		if (shape.length > 0) {
			const [itemShape] = shape;
			for (const [index, item] of (received as Array<unknown>).entries()) {
				assertShape(item, itemShape, `${path}[${index}]`);
			}
		}

		return;
	}

	if (shape && typeof shape === "object") {
		const receivedRecord = received as Record<string, unknown>;

		expect(received, `${path} should be an object`).toBeDefined();
		expect(received, `${path} should be an object`).not.toBeNull();
		expect(typeof received, `${path} should be an object`).toBe("object");

		for (const [key, value] of Object.entries(shape)) {
			assertShape(receivedRecord[key], value, `${path}.${key}`);
		}

		return;
	}

	expect(received).toEqual(shape);
}

/**
 * Assert that an object matches a shape (partial deep match).
 * Checks that all expected keys exist with expected types/values.
 */
export function toMatchShape<T extends Record<string, unknown>>(
	received: unknown,
	shape: Partial<Record<keyof T, ShapeValue>>,
): void {
	expect(received).toBeDefined();
	expect(received).not.toBeNull();
	expect(typeof received).toBe("object");
	assertShape(received, shape, "received");
}

/**
 * Create a snapshot test for a transform function.
 * Records the output of transform(raw) and compares on future runs.
 */
export function snapshotTransform<TRaw, TOutput>(
	name: string,
	raw: TRaw,
	transformFn: (raw: TRaw) => TOutput,
): void {
	describe(`snapshot: ${name}`, () => {
		it("matches snapshot", () => {
			const result = transformFn(raw);
			expect(result).toMatchSnapshot();
		});
	});
}
