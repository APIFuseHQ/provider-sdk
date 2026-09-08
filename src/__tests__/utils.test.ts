import { describe, expect, it } from "bun:test";
import {
	checkResultCode,
	isEmptyResult,
	nullIfPlaceholder,
	unwrapGovEnvelope,
} from "../recipes/gov-api.js";
import { toISODate } from "../utils/date.js";
import { pivotByField, unwrapEnvelope } from "../utils/parse.js";
import { stripHtml, truncate } from "../utils/text.js";
import { toBoolean, toFloat, toInt, toNumber } from "../utils/transform.js";

describe("transform utils", () => {
	it("parses numbers and booleans", () => {
		expect(toNumber("1.5")).toBe(1.5);
		expect(toFloat("1.25", 1)).toBe(1.3);
		expect(toInt("38.7")).toBe(39);
		expect(toBoolean("true")).toBe(true);
		expect(toBoolean(0)).toBe(false);
	});
});

describe("date utils", () => {
	it("formats dates with timezone", () => {
		expect(toISODate("20230101", "Asia/Seoul")).toBe("2023-01-01T00:00:00+09:00");
	});
});

describe("text utils", () => {
	it("strips html and truncates text", () => {
		expect(stripHtml("<b>hello</b>")).toBe("hello");
		expect(truncate("hello world", 5)).toBe("hello...");
	});
});

describe("parse utils", () => {
	it("unwraps envelopes and pivots arrays", () => {
		expect(unwrapEnvelope({ a: { b: 1 } }, "a.b")).toBe(1);
		expect(pivotByField([{ k: "A", v: 1 }], "k", "v")).toEqual({ A: 1 });
	});
});

describe("gov-api recipe", () => {
	it("checks result code and placeholder values", () => {
		expect(checkResultCode({ resultCode: "00" })).toBe(true);
		expect(nullIfPlaceholder("-", ["-"])).toBeNull();
	});

	it("unwraps gov envelope and detects empty results", () => {
		expect(
			unwrapGovEnvelope({
				response: { body: { items: { item: [{ id: 1 }] } } },
			}),
		).toEqual([{ id: 1 }]);
		expect(isEmptyResult({ response: { header: { resultCode: "03" } } })).toBe(true);
	});
});
