import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AuthTurn } from "../types";
import {
	getProviderLocalePath,
	isProviderLocaleValue,
	type ProviderLocale,
	type ProviderLocaleCatalog,
	type ProviderLocaleKey,
	type ProviderLocaleValue,
	providerLocaleKey,
} from "./keys";

export type ProviderLocaleCatalogMap = Record<
	ProviderLocale,
	ProviderLocaleCatalog
>;

export interface LoadProviderLocaleCatalogsOptions {
	providerDir: string;
	locales: readonly ProviderLocale[];
}

export interface ProviderLocaleValidationIssue {
	locale: ProviderLocale;
	key: string;
	message: string;
	severity: "error" | "warning";
}

export interface ProviderLocaleValidationResult {
	ok: boolean;
	issues: ProviderLocaleValidationIssue[];
}

export function loadProviderLocaleCatalogs(
	options: LoadProviderLocaleCatalogsOptions,
): ProviderLocaleCatalogMap {
	const catalogs: ProviderLocaleCatalogMap = {};
	for (const locale of options.locales) {
		const filePath = join(options.providerDir, "locales", `${locale}.json`);
		catalogs[locale] = JSON.parse(readFileSync(filePath, "utf8"));
	}
	return catalogs;
}

export function resolveProviderLocaleValue(
	catalogs: ProviderLocaleCatalogMap,
	key: ProviderLocaleKey | string,
	locale: ProviderLocale,
	fallbackLocale: ProviderLocale = "en",
): ProviderLocaleValue | undefined {
	providerLocaleKey(key);
	return (
		getProviderLocalePath(catalogs[locale] ?? {}, key) ??
		getProviderLocalePath(catalogs[fallbackLocale] ?? {}, key)
	);
}

function asStringValue(
	value: ProviderLocaleValue | undefined,
): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

function localizeAuthInputSchema(
	expectedInput: Record<string, unknown> | undefined,
	options: {
		catalogs: ProviderLocaleCatalogMap;
		locale: ProviderLocale;
		fallbackLocale: ProviderLocale;
	},
): Record<string, unknown> | undefined {
	if (!expectedInput) return undefined;
	const schema = isRecord(expectedInput.schema)
		? expectedInput.schema
		: expectedInput;
	const localizedSchema = localizeAuthSchemaObject(schema, options);
	if (localizedSchema === schema) return undefined;
	return isRecord(expectedInput.schema)
		? { ...expectedInput, schema: localizedSchema }
		: localizedSchema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function localizeAuthSchemaObject(
	schema: Record<string, unknown>,
	options: {
		catalogs: ProviderLocaleCatalogMap;
		locale: ProviderLocale;
		fallbackLocale: ProviderLocale;
	},
): Record<string, unknown> {
	const properties = isRecord(schema.properties)
		? schema.properties
		: undefined;
	if (!properties) return schema;

	let changed = false;
	const localizedProperties = Object.fromEntries(
		Object.entries(properties).map(([fieldName, property]) => {
			if (!isRecord(property)) return [fieldName, property];
			const nameKey =
				typeof property.nameKey === "string" ? property.nameKey : undefined;
			const descriptionKey =
				typeof property.descriptionKey === "string"
					? property.descriptionKey
					: undefined;
			const title = nameKey
				? asStringValue(
						resolveProviderLocaleValue(
							options.catalogs,
							nameKey,
							options.locale,
							options.fallbackLocale,
						),
					)
				: undefined;
			const description = descriptionKey
				? asStringValue(
						resolveProviderLocaleValue(
							options.catalogs,
							descriptionKey,
							options.locale,
							options.fallbackLocale,
						),
					)
				: undefined;
			if (!title && !description) return [fieldName, property];
			changed = true;
			return [
				fieldName,
				{
					...property,
					...(title ? { title } : {}),
					...(description ? { description } : {}),
				},
			];
		}),
	);

	return changed ? { ...schema, properties: localizedProperties } : schema;
}

export function localizeAuthTurn(
	turn: AuthTurn,
	options: {
		catalogs: ProviderLocaleCatalogMap;
		locale: ProviderLocale;
		fallbackLocale?: ProviderLocale;
	},
): AuthTurn {
	const fallbackLocale = options.fallbackLocale ?? "en";
	const hint = turn.hintKey
		? asStringValue(
				resolveProviderLocaleValue(
					options.catalogs,
					turn.hintKey,
					options.locale,
					fallbackLocale,
				),
			)
		: undefined;
	const expectedInput = localizeAuthInputSchema(turn.expectedInput, {
		catalogs: options.catalogs,
		locale: options.locale,
		fallbackLocale,
	});
	const fieldErrorKeys = turn.data?.fieldErrorKeys;
	const fieldErrors = isStringRecord(fieldErrorKeys)
		? Object.fromEntries(
				Object.entries(fieldErrorKeys).flatMap(([fieldName, key]) => {
					const message = asStringValue(
						resolveProviderLocaleValue(
							options.catalogs,
							key,
							options.locale,
							fallbackLocale,
						),
					);
					return message ? [[fieldName, message]] : [];
				}),
			)
		: undefined;

	if (!hint && !fieldErrors && !expectedInput) return turn;

	return {
		...turn,
		...(hint ? { hint } : {}),
		...(expectedInput ? { expectedInput } : {}),
		...(fieldErrors
			? {
					data: {
						...(turn.data ?? {}),
						fieldErrors,
					},
				}
			: {}),
	};
}

export function validateProviderLocaleCatalogs(options: {
	catalogs: ProviderLocaleCatalogMap;
	requiredLocales: readonly ProviderLocale[];
	requiredKeys: readonly (ProviderLocaleKey | string)[];
}): ProviderLocaleValidationResult {
	const issues: ProviderLocaleValidationIssue[] = [];
	const uniqueKeys = Array.from(
		new Set(
			options.requiredKeys.map((key) => {
				providerLocaleKey(key);
				return key;
			}),
		),
	);

	for (const locale of options.requiredLocales) {
		const catalog = options.catalogs[locale];
		if (!catalog) {
			issues.push({
				locale,
				key: "*",
				message: `Missing provider locale catalog for ${locale}`,
				severity: "error",
			});
			continue;
		}

		for (const key of uniqueKeys) {
			const value = getProviderLocalePath(catalog, key);
			if (value === undefined) {
				issues.push({
					locale,
					key,
					message: `Missing provider locale key ${key} in ${locale}`,
					severity: "error",
				});
				continue;
			}
			if (!isProviderLocaleValue(value)) {
				issues.push({
					locale,
					key,
					message: `Provider locale key ${key} must resolve to a string or string array`,
					severity: "error",
				});
				continue;
			}
			for (const text of Array.isArray(value) ? value : [value]) {
				if (text.trim().length === 0 || /\bTODO\b/i.test(text)) {
					issues.push({
						locale,
						key,
						message: `Provider locale key ${key} in ${locale} is empty or placeholder text`,
						severity: "error",
					});
				}
			}
		}
	}

	return { ok: issues.every((issue) => issue.severity !== "error"), issues };
}
