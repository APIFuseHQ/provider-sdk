/** Parse any value to number (returns 0 if not parseable) */
export function toNumber(v: unknown): number {
	if (typeof v === "number") {
		return Number.isFinite(v) ? v : 0;
	}

	if (typeof v === "boolean") {
		return v ? 1 : 0;
	}

	if (typeof v === "string") {
		const cleaned = v.replaceAll(",", "").trim();

		if (cleaned === "") {
			return 0;
		}

		const parsed = Number(cleaned);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	return 0;
}

/** Parse any value to float */
export function toFloat(v: unknown, decimals?: number): number {
	const parsed = toNumber(v);

	if (!Number.isFinite(parsed)) {
		return 0;
	}

	if (decimals === undefined) {
		return parsed;
	}

	const factor = 10 ** decimals;
	return Math.round(parsed * factor) / factor;
}

/** Parse any value to integer */
export function toInt(v: unknown): number {
	return Math.round(toNumber(v));
}

/** Parse any value to boolean (handles "true", "1", "yes", true, 1) */
export function toBoolean(v: unknown): boolean {
	if (typeof v === "boolean") {
		return v;
	}

	if (typeof v === "number") {
		return v === 1;
	}

	if (typeof v === "string") {
		const normalized = v.trim().toLowerCase();
		return ["true", "1", "yes", "y"].includes(normalized);
	}

	return false;
}
