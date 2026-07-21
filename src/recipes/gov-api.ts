import { unwrapEnvelope } from "../utils/parse.js";

function getResultCode(raw: unknown): string | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const record = raw as Record<string, unknown>;

	if (typeof record.resultCode === "string") {
		return record.resultCode;
	}

	const response = record.response as Record<string, unknown> | undefined;
	const header = response?.header as Record<string, unknown> | undefined;

	return typeof header?.resultCode === "string" ? header.resultCode : undefined;
}

/**
 * Check Korean government API result code
 * Returns true if resultCode matches successCodes (default: ['00', '000', '0000'])
 */
export function checkResultCode(
	raw: unknown,
	successCodes: string[] = ["00", "000", "0000"],
): boolean {
	const code = getResultCode(raw);
	return code ? successCodes.includes(code) : false;
}

/**
 * Replace placeholder values with null
 * e.g., nullIfPlaceholder('해당없음', ['해당없음', '-', '']) → null
 */
export function nullIfPlaceholder(v: unknown, patterns: string[]): unknown | null {
	if (v === null || v === undefined) {
		return null;
	}

	if (typeof v !== "string") {
		return v;
	}

	const normalized = v.trim();
	return patterns.some((pattern) => normalized === pattern.trim()) ? null : v;
}

/**
 * Unwrap Korean government API envelope
 * Handles: {response: {body: {items: {item: ...}}}} nested structure
 */
export function unwrapGovEnvelope(raw: unknown): unknown {
	const item = unwrapEnvelope(raw, "response.body.items.item");

	if (Array.isArray(item)) {
		return item;
	}

	if (item !== undefined && item !== null) {
		return [item];
	}

	const items = unwrapEnvelope(raw, "response.body.items");
	if (Array.isArray(items)) {
		return items;
	}

	if (items !== undefined && items !== null) {
		return items;
	}

	return raw;
}

/**
 * Check if Korean government API returned empty result
 */
export function isEmptyResult(raw: unknown): boolean {
	if (getResultCode(raw) === "03") {
		return true;
	}

	const items = unwrapGovEnvelope(raw);
	if (Array.isArray(items)) {
		return items.length === 0;
	}

	if (items && typeof items === "object") {
		return Object.keys(items as Record<string, unknown>).length === 0;
	}

	return false;
}
