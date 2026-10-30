import {
	SDK_ERROR_REGISTRY,
	SDK_RUNTIME_OWNED_ERROR_CODES,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
	type SdkErrorCode,
} from "./error-resolution.js";
import { ProviderError, type ProviderErrorObservability, ValidationError } from "./errors.js";
import type { ProviderErrorMessageParams } from "./i18n/error-messages.js";
import {
	getProviderLocaleSegments,
	isProviderLocaleKey,
	type ProviderLocaleCatalog,
} from "./i18n/keys.js";
import {
	isRetryableCategory,
	PROVIDER_ERROR_CATEGORIES,
	type ProviderErrorCategory,
} from "./observability.js";
import {
	type ProviderErrorStatus,
	type ProviderLocaleKeyInput,
	VALID_OPERATION_ERROR_STATUSES,
} from "./types.js";

// Cross-realm brand (see errors.ts): a factory-made error carries its
// declaration as an own, immutable, non-enumerable property keyed by this
// symbol, so the server recognizes it even when the provider's bundled SDK copy
// is not the one serving it.
const ERROR_DECLARATION_BRAND = Symbol.for("@apifuse/provider-sdk/error-declaration@1");

/**
 * A provider-owned error code, declared once. Everything the SDK serves for
 * the code (status, category, retryability) and publishes for it (the
 * contract description, the locale keys) lives here.
 */
export type ProviderErrorDeclarationInput = {
	readonly status: ProviderErrorStatus;
	/** Who failed. Drives the public `source` and the health monitor's attribution. */
	readonly category: ProviderErrorCategory;
	/**
	 * Whether a retry can help. Defaults to the category's answer
	 * (timeout, network, upstream_rate_limited, upstream_http and proxy_pool
	 * retry; every other category does not).
	 */
	readonly retryable?: boolean;
	/** Developer-facing English prose for docs and MCP tool text. Never localized. */
	readonly description: string;
	/** Locale catalog key for the client-facing `message`; the derived `errors.<code>.message` applies when omitted. */
	readonly messageKey?: ProviderLocaleKeyInput;
	/** Locale catalog key for the client-facing `fix`; the derived `errors.<code>.fix` applies when omitted. */
	readonly fixKey?: ProviderLocaleKeyInput;
};

/**
 * The resolved declaration a factory carries and the server reads. `TStatus`
 * and `TCategory` are the literals the map declared (or the registry's, for
 * an `sdkErrors` reference), so a health scenario's `errorRefs(errors)` can
 * refuse a non-absence code at compile time.
 */
export type ProviderErrorDeclaration<
	TCode extends string = string,
	TStatus extends ProviderErrorStatus = ProviderErrorStatus,
	TCategory extends ProviderErrorCategory = ProviderErrorCategory,
> = {
	readonly code: TCode;
	readonly status: TStatus;
	readonly category: TCategory;
	readonly retryable: boolean;
	readonly description: string;
	readonly messageKey?: ProviderLocaleKeyInput;
	readonly fixKey?: ProviderLocaleKeyInput;
};

/**
 * An SDK-registered code referenced by value (`sdkErrors.UPSTREAM_ERROR`).
 * Its status, category, retryability and description are the registry's
 * literal values, so restating or overriding any of them is a type error.
 */
export type SdkErrorRef<TCode extends SdkErrorCode = SdkErrorCode> = {
	readonly sdk: true;
	readonly code: TCode;
} & (typeof SDK_ERROR_REGISTRY)[TCode];

function sdkErrorRef<TCode extends SdkErrorCode>(code: TCode): SdkErrorRef<TCode> {
	return { sdk: true, code, ...SDK_ERROR_REGISTRY[code] };
}

/**
 * Every SDK-registered provider error code, by value. Put one in a
 * `defineErrors` map under its own name:
 * `defineErrors({ UPSTREAM_ERROR: sdkErrors.UPSTREAM_ERROR })`.
 */
export const sdkErrors: { readonly [K in SdkErrorCode]: SdkErrorRef<K> } = Object.freeze(
	Object.fromEntries(
		(Object.keys(SDK_ERROR_REGISTRY) as SdkErrorCode[]).map((code) => [code, sdkErrorRef(code)]),
	) as { [K in SdkErrorCode]: SdkErrorRef<K> },
);

/**
 * What one throw adds to a declared error. The status served, the category
 * reported and the retryability published come from the declaration alone;
 * a throw can only add text (an English literal, a locale key, params), a
 * cause, details and observability.
 */
export type ProviderErrorInput = {
	/** English literal for logs, cause frames and the unlocalized envelope. Defaults to the declaration's description. */
	readonly message?: string;
	/** English literal `fix`; the declaration's `fixKey` (or this throw's `fixKey`) localizes it when present. */
	readonly fix?: string;
	/**
	 * Locale catalog key for this throw's client-facing `message`, for a site
	 * that says something more specific than the code's one sentence. Wins
	 * over the declaration's `messageKey`, which wins over the derived
	 * `errors.<code>.message`; the same order the legacy
	 * `new ProviderError(msg, { code, messageKey })` path resolves.
	 */
	readonly messageKey?: ProviderLocaleKeyInput;
	/** Locale catalog key for this throw's client-facing `fix`. Same resolution as `messageKey`. */
	readonly fixKey?: ProviderLocaleKeyInput;
	readonly details?: unknown;
	readonly cause?: Error;
	/** Values for `{name}` placeholders in the localized text. */
	readonly params?: ProviderErrorMessageParams;
	readonly observability?: ProviderErrorObservability;
};

/** `errors.CODE` from `defineErrors`: throws the declared error, and carries the declaration for the contract. */
export type ProviderErrorFactory<
	TCode extends string = string,
	TStatus extends ProviderErrorStatus = ProviderErrorStatus,
	TCategory extends ProviderErrorCategory = ProviderErrorCategory,
> = {
	(input?: ProviderErrorInput): ProviderError<TCode>;
	readonly code: TCode;
	readonly declaration: ProviderErrorDeclaration<TCode, TStatus, TCategory>;
};

/**
 * A `defineErrors` map value: a provider declaration, an SDK code by value,
 * or a factory from another `defineErrors` map (so one map can spread
 * another: `defineErrors({ ...commonErrors, ITEM_GONE: { ... } })`).
 */
export type DefineErrorsInput = {
	readonly [code: string]: ProviderErrorDeclarationInput | SdkErrorRef | ProviderErrorFactory;
};

// A key that names an SDK-registered code must hold that code's `sdkErrors`
// ref (or a factory made from it): a provider declaration there would restate
// (or contradict) the registry, and a different ref would mislabel it.
type CheckedDefineErrorsInput<T extends DefineErrorsInput> = {
	readonly [K in keyof T]: K extends SdkErrorCode
		? SdkErrorRef<K> | ProviderErrorFactory<K>
		: K extends string
			? ProviderErrorDeclarationInput | ProviderErrorFactory<K>
			: never;
};

/** The literal status one `defineErrors` entry declares; the full status union when it is not a literal. */
type DeclaredErrorStatus<TEntry> =
	TEntry extends ProviderErrorFactory<string, infer TStatus>
		? TStatus
		: TEntry extends { readonly status: infer TStatus extends ProviderErrorStatus }
			? TStatus
			: ProviderErrorStatus;

/** The literal category one `defineErrors` entry declares; the full category union when it is not a literal. */
type DeclaredErrorCategory<TEntry> =
	TEntry extends ProviderErrorFactory<string, ProviderErrorStatus, infer TCategory>
		? TCategory
		: TEntry extends { readonly category: infer TCategory extends ProviderErrorCategory }
			? TCategory
			: ProviderErrorCategory;

/** The factories `defineErrors` returns, one per declared code, each carrying its declared status and category. */
export type DefinedErrors<T extends DefineErrorsInput> = {
	readonly [K in keyof T & string]: ProviderErrorFactory<
		K,
		DeclaredErrorStatus<T[K]>,
		DeclaredErrorCategory<T[K]>
	>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderErrorCategory(value: unknown): value is ProviderErrorCategory {
	return (
		typeof value === "string" && (PROVIDER_ERROR_CATEGORIES as readonly string[]).includes(value)
	);
}

function isProviderErrorStatus(value: unknown): value is ProviderErrorStatus {
	return (
		typeof value === "number" &&
		(VALID_OPERATION_ERROR_STATUSES as readonly number[]).includes(value)
	);
}

function declarationError(code: string, problem: string, fix: string): ValidationError {
	return new ValidationError(`defineErrors: "${code}" ${problem}`, {
		code: "ERROR_DECLARATION_INVALID",
		fix,
	});
}

function localeKeyOf(
	code: string,
	field: "messageKey" | "fixKey",
	value: unknown,
): string | undefined {
	if (value === undefined) return undefined;
	if (!isProviderLocaleKey(value)) {
		throw declarationError(
			code,
			`has a malformed ${field} ${JSON.stringify(value)}.`,
			`Use a locale dot path such as "errors.${code}.message" (camelCase segments, or the error code directly under "errors").`,
		);
	}
	return value;
}

function resolveDeclaration(code: string, entry: unknown): ProviderErrorDeclaration {
	if (isProviderErrorFactory(entry)) {
		if (entry.code !== code) {
			throw declarationError(
				code,
				`is assigned the factory for "${entry.code}".`,
				`Key the factory by its own code: ${entry.code}: errors.${entry.code}.`,
			);
		}
		return entry.declaration;
	}
	if (!isRecord(entry)) {
		throw declarationError(
			code,
			"must be an object.",
			`Write ${code}: { status, category, description } or ${code}: sdkErrors.${code}.`,
		);
	}
	const sdkRow = Object.hasOwn(SDK_ERROR_REGISTRY, code)
		? SDK_ERROR_REGISTRY[code as SdkErrorCode]
		: undefined;
	if (entry.sdk === true) {
		if (entry.code !== code || sdkRow === undefined) {
			throw declarationError(
				code,
				`is assigned sdkErrors.${String(entry.code)}.`,
				`Key the SDK reference by its own code: ${String(entry.code)}: sdkErrors.${String(entry.code)}.`,
			);
		}
		return { code, ...sdkRow };
	}
	if (sdkRow !== undefined) {
		throw declarationError(
			code,
			"is an SDK-registered code and cannot be redeclared.",
			`Reference it by value: ${code}: sdkErrors.${code}. Its status, category and retryability come from the SDK.`,
		);
	}
	if (SDK_RUNTIME_OWNED_ERROR_CODES.has(code) || SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.has(code)) {
		throw declarationError(
			code,
			"is owned by the SDK runtime and cannot be declared by a provider.",
			"Throw a provider-owned code instead; the SDK serves this one itself.",
		);
	}
	if (!isProviderErrorStatus(entry.status)) {
		throw declarationError(
			code,
			`has invalid status ${String(entry.status)}.`,
			`Set status to one of ${VALID_OPERATION_ERROR_STATUSES.join(", ")}.`,
		);
	}
	if (!isProviderErrorCategory(entry.category)) {
		throw declarationError(
			code,
			`has invalid category ${String(entry.category)}.`,
			`Set category to one of ${PROVIDER_ERROR_CATEGORIES.join(", ")}.`,
		);
	}
	if (entry.retryable !== undefined && typeof entry.retryable !== "boolean") {
		throw declarationError(
			code,
			`has non-boolean retryable ${String(entry.retryable)}.`,
			"Set retryable to true or false, or omit it to take the category's default.",
		);
	}
	if (typeof entry.description !== "string" || entry.description.trim().length === 0) {
		throw declarationError(
			code,
			"has no description.",
			"Add a one-sentence English description; it is published in the operation contract.",
		);
	}
	const messageKey = localeKeyOf(code, "messageKey", entry.messageKey);
	const fixKey = localeKeyOf(code, "fixKey", entry.fixKey);
	return {
		code,
		status: entry.status,
		category: entry.category,
		retryable: entry.retryable ?? isRetryableCategory(entry.category),
		description: entry.description,
		...(messageKey === undefined ? {} : { messageKey }),
		...(fixKey === undefined ? {} : { fixKey }),
	};
}

function createFactory<TCode extends string>(
	declaration: ProviderErrorDeclaration<TCode>,
): ProviderErrorFactory<TCode> {
	const factory = (input: ProviderErrorInput = {}): ProviderError<TCode> => {
		const messageKey = input.messageKey ?? declaration.messageKey;
		const fixKey = input.fixKey ?? declaration.fixKey;
		const error = new ProviderError<TCode>(input.message ?? declaration.description, {
			code: declaration.code,
			...(messageKey === undefined ? {} : { messageKey }),
			...(fixKey === undefined ? {} : { fixKey }),
			...(input.fix === undefined ? {} : { fix: input.fix }),
			...(input.details === undefined ? {} : { details: input.details }),
			...(input.cause === undefined ? {} : { cause: input.cause }),
			...(input.params === undefined ? {} : { params: input.params }),
			...(input.observability === undefined ? {} : { observability: input.observability }),
		});
		Object.defineProperty(error, ERROR_DECLARATION_BRAND, {
			value: declaration,
			enumerable: false,
			writable: false,
			configurable: false,
		});
		return error;
	};
	Object.defineProperty(factory, "code", { value: declaration.code, enumerable: true });
	Object.defineProperty(factory, "declaration", { value: declaration, enumerable: true });
	Object.defineProperty(factory, ERROR_DECLARATION_BRAND, {
		value: declaration,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return factory as ProviderErrorFactory<TCode>;
}

/**
 * Declares a provider's error codes once and returns one factory per code.
 *
 * ```ts
 * export const errors = defineErrors({
 *   UPSTREAM_SCHEMA_ERROR: sdkErrors.UPSTREAM_SCHEMA_ERROR,
 *   ITEM_NOT_FOUND: {
 *     status: 404,
 *     category: "upstream_rejected",
 *     description: "The shop has no item with this id.",
 *     messageKey: "errors.itemNotFound.message",
 *   },
 * });
 *
 * throw errors.ITEM_NOT_FOUND({ details: { itemId } });
 * defineOperation<Ctx>()({ errors: [errors.ITEM_NOT_FOUND], ... });
 * ```
 *
 * A key naming an SDK-registered code must hold that `sdkErrors` reference
 * (status, category and retryability are the SDK's; overriding them is a
 * type error). A provider code states status, category and description;
 * `retryable` defaults to the category's. The status served, the category
 * reported and the retryability published are read from the declaration at
 * serve time, never from the throw site.
 */
export function defineErrors<const T extends DefineErrorsInput>(
	map: T & CheckedDefineErrorsInput<T>,
): DefinedErrors<T> {
	if (!isRecord(map)) {
		throw new ValidationError("defineErrors: expected an object keyed by error code.", {
			code: "ERROR_DECLARATION_INVALID",
			fix: "Call defineErrors({ CODE: { status, category, description } }).",
		});
	}
	const factories: Record<string, ProviderErrorFactory> = {};
	for (const [code, entry] of Object.entries(map)) {
		if (code.trim().length === 0) {
			throw declarationError(code, "is an empty code.", "Use a non-empty error code as the key.");
		}
		factories[code] = createFactory(resolveDeclaration(code, entry));
	}
	return Object.freeze(factories) as DefinedErrors<T>;
}

function ownDeclaration(value: unknown): ProviderErrorDeclaration | undefined {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) {
		return undefined;
	}
	const descriptor = Object.getOwnPropertyDescriptor(value, ERROR_DECLARATION_BRAND);
	return descriptor !== undefined &&
		Object.hasOwn(descriptor, "value") &&
		isRecord(descriptor.value)
		? (descriptor.value as ProviderErrorDeclaration)
		: undefined;
}

/** The declaration a `defineErrors` factory made this error with, or `undefined` for a hand-constructed error. */
export function providerErrorDeclaration(error: unknown): ProviderErrorDeclaration | undefined {
	return ownDeclaration(error);
}

/** True for a value `defineErrors` returned under some code. */
export function isProviderErrorFactory(value: unknown): value is ProviderErrorFactory {
	return typeof value === "function" && ownDeclaration(value) !== undefined;
}

/**
 * Checks every declared `messageKey` / `fixKey` of the operations' `errors`
 * against the provider's `locales/en.json`, the catalog every other locale
 * falls back to. Returns one line per missing key; an empty array means every
 * key resolves to non-empty text. Malformed keys never get here:
 * `defineErrors` rejects them.
 */
export function validateProviderErrorLocaleKeys(input: {
	readonly operations: Readonly<
		Record<string, { readonly errors?: readonly ProviderErrorFactory[] }>
	>;
	readonly catalog: ProviderLocaleCatalog;
}): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const operation of Object.values(input.operations)) {
		for (const factory of operation.errors ?? []) {
			const { code, messageKey, fixKey } = factory.declaration;
			if (seen.has(code)) continue;
			seen.add(code);
			for (const [field, key] of [
				["messageKey", messageKey],
				["fixKey", fixKey],
			] as const) {
				if (key === undefined) continue;
				const value = getProviderLocaleSegments(input.catalog, key.split("."));
				if (typeof value === "string" && value.trim().length > 0) continue;
				problems.push(
					`errors.${code}.${field} ${JSON.stringify(key)} is missing from locales/en.json (or resolves to a non-string or empty value); add it, or drop the key to use the derived "errors.${code}.${field === "messageKey" ? "message" : "fix"}".`,
				);
			}
		}
	}
	return problems;
}
