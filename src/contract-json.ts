export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(toJsonValue(value) ?? null));
}

export function toJsonValue(value: unknown): JsonValue | undefined {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : undefined;
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => {
			const json = toJsonValue(item);
			return json === undefined ? [] : [json];
		});
	}
	if (!isRecord(value)) return undefined;
	return compactObject(
		Object.fromEntries(
			Object.entries(value).flatMap(([key, item]) => {
				const json = toJsonValue(item);
				return json === undefined ? [] : [[key, json]];
			}),
		),
	);
}

export function compactObject(
	value: Record<string, JsonValue | undefined>,
): JsonValue {
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, JsonValue] => {
			const [, item] = entry;
			return item !== undefined;
		}),
	);
}

export function copyRecordWithout(
	value: unknown,
	ignoredKeys: ReadonlySet<string>,
): Record<string, unknown> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(([key]) => !ignoredKeys.has(key)),
	);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
			.flatMap(([key, item]) => {
				const json = toJsonValue(item);
				return json === undefined ? [] : [[key, canonicalize(json)]];
			}),
	);
}
