import type { ProviderLocaleKey } from "../types";

export type { ProviderLocale, ProviderLocaleKey } from "../types";

const PROVIDER_LOCALE_KEY_RE =
	/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)*|\.[0-9]+)*$/;

export function providerLocaleKey(key: string): ProviderLocaleKey {
	assertProviderLocaleKey(key);
	return key;
}

export function isProviderLocaleKey(
	value: unknown,
): value is ProviderLocaleKey {
	return typeof value === "string" && PROVIDER_LOCALE_KEY_RE.test(value);
}

export function assertProviderLocaleKey(
	value: unknown,
): asserts value is ProviderLocaleKey {
	if (!isProviderLocaleKey(value)) {
		throw new Error(
			`Provider locale key must be a dot path such as "meta.description" or "operations.search.description"; received ${JSON.stringify(value)}`,
		);
	}
}

export function qualifyProviderLocaleKey(
	providerId: string,
	key: ProviderLocaleKey | string,
): string {
	assertProviderLocaleKey(key);
	return `providers.${providerId}.${key}`;
}

export function getProviderLocalePath(
	catalog: ProviderLocaleCatalog,
	key: ProviderLocaleKey | string,
): ProviderLocaleValue | undefined {
	assertProviderLocaleKey(key);
	let cursor: unknown = catalog;
	for (const segment of key.split(".")) {
		if (!isRecord(cursor)) return undefined;
		cursor = cursor[segment];
	}
	return isProviderLocaleValue(cursor) ? cursor : undefined;
}

export type ProviderLocaleValue = string | readonly string[];
export type ProviderLocaleCatalog = Record<string, unknown>;

export function isProviderLocaleValue(
	value: unknown,
): value is ProviderLocaleValue {
	return (
		typeof value === "string" ||
		(Array.isArray(value) && value.every((entry) => typeof entry === "string"))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
