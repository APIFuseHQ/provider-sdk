/**
 * Unwrap nested envelope by dot-path
 * e.g., unwrapEnvelope({response: {body: {items: [...]}}}, 'response.body.items')
 */
export function unwrapEnvelope(data: unknown, path?: string): unknown {
	if (!path || path.trim() === "") {
		return data;
	}

	const segments = path.split(".").filter(Boolean);
	let current: unknown = data;

	for (const segment of segments) {
		if (!current || typeof current !== "object") {
			return undefined;
		}

		current = (current as Record<string, unknown>)[segment];
	}

	return current;
}

/**
 * Pivot array by field — generalized version of pivotByCategory
 * e.g., pivotByField([{type:'A', val:1},{type:'B', val:2}], 'type', 'val')
 * → { A: 1, B: 2 }
 */
export function pivotByField(
	items: unknown[],
	keyField: string,
	valueField: string,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const item of items) {
		if (!item || typeof item !== "object") {
			continue;
		}

		const record = item as Record<string, unknown>;
		const key = record[keyField];
		const value = record[valueField];

		if (key === undefined || key === null || value === undefined) {
			continue;
		}

		result[String(key)] = value;
	}

	return result;
}

/**
 * Parse XML items from string — returns array
 * Uses simple regex (no DOM), suitable for structured XML
 */
export function parseXmlItems(xml: string, tag: string): string[] {
	const matches = [
		...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi")),
	];
	return matches
		.map((match) => match[1].replace(/<[^>]+>/g, "").trim())
		.filter((item) => item.length > 0);
}
