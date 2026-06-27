import { describe, expect, it } from "bun:test";
import { RE2 } from "re2-wasm";

describe("re2-wasm smoke test", () => {
	it("executes the deterministic startup pattern", () => {
		const regex = new RE2("^a$", "u");

		expect(regex.test("a")).toBeTrue();
		expect(regex.test("b")).toBeFalse();
	});
});
