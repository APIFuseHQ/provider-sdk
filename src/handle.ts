/**
 * LLM-friendly handles (ADR-0012): authoring API.
 *
 * A handle is a short string an LLM copies from one tool output into a later
 * tool input. It is a lookup key to server state, never a carrier of encrypted
 * payload. This module defines handle *kinds* (`defineCursor`, `defineDraft`),
 * the schema helper `kind.field()`, the plain-value chooser `pick()`, and
 * `HandleError`. The runtime (`ctx.handle`) lives in `runtime/handle.ts`.
 */
import { type ZodString, type ZodType, z } from "zod";
import {
	brandHandleError,
	hasHandleErrorBrand,
	ProviderError,
	type ProviderErrorOptions,
} from "./errors.js";
import {
	APIFUSE_HANDLE_META_KEY,
	handleFieldDescription,
	HANDLE_KIND_NAME_PATTERN,
	type HandleAccess,
	type HandleFieldMeta,
	type HandleKindDeclaration,
	type HandleKindType,
} from "./handle-meta.js";
import type { ProviderErrorCategory } from "./observability.js";
import {
	BOUND_HANDLE_WORD_COUNT,
	HIGH_PUBLIC_HANDLE_WORD_COUNT,
	PUBLIC_HANDLE_WORD_COUNT,
} from "./runtime/handle-wordlist.js";
import type { ProviderStateDurationString } from "./types.js";

export type { HandleAccess, HandleFieldMeta, HandleKindDeclaration, HandleKindType };

/** Public cursors whose ttl exceeds this are issued with five words (auto-high). */
const AUTO_HIGH_TTL_MS = 3_600_000;
const DEFAULT_BOUND_MAX_ENTRIES = 200;
const DEFAULT_CURSOR_MAX_VALUE_BYTES = 16_000;
const DEFAULT_DRAFT_MAX_VALUE_BYTES = 64_000;
const DEFAULT_RESULT_TTL: ProviderStateDurationString = "24h";

export type HandleStrength = "standard" | "high";

/** Words issued per handle: 2 for bound kinds, 4 for public, 5 for high-strength public. */
export type HandleWordCount = 2 | 4 | 5;

export interface HandleKindBase<TSchema extends ZodType = ZodType> extends HandleKindDeclaration {
	/**
	 * Zod schema validated on `create`/`update`. Writes accept its *input* type
	 * (`InputOf`); stored records and callbacks carry its *output* type (`DataOf`).
	 */
	readonly schema: TSchema;
	/** Live-entry quota of the kind's namespace (per connection for bound kinds). */
	readonly maxEntries: number;
	/** Maximum JSON-encoded record size in bytes. */
	readonly maxValueBytes: number;
	/** Number of words the runtime issues for this kind. */
	readonly wordCount: HandleWordCount;
	/**
	 * Schema for the handle field, usable in output and input positions. Carries
	 * the `x-apifuse-handle` meta and an SDK-owned English description.
	 */
	field(): ZodString;
}

export interface CursorKind<TSchema extends ZodType = ZodType> extends HandleKindBase<TSchema> {
	readonly type: "cursor";
	readonly ttl: ProviderStateDurationString;
	readonly ttlMs: number;
	readonly strength: HandleStrength;
}

export interface DraftKind<
	TSchema extends ZodType = ZodType,
	TResultSchema extends ZodType | undefined = ZodType | undefined,
> extends HandleKindBase<TSchema> {
	readonly type: "draft";
	readonly access: "bound";
	readonly ttl: {
		readonly idle: ProviderStateDurationString;
		readonly max: ProviderStateDurationString;
	};
	readonly idleTtlMs: number;
	readonly maxTtlMs: number;
	readonly resultTtl: ProviderStateDurationString;
	readonly resultTtlMs: number;
	/** Optional schema describing the commit result; type-level only at runtime. */
	readonly result: TResultSchema | undefined;
	readonly wordCount: 2;
}

// `any` here is variance-only: a concrete `CursorKind<{ page: number }>` must be
// assignable to the union without callers spelling out the data type.
export type HandleKind = CursorKind<any> | DraftKind<any, any>;

/** Stored record data type (schema output); what `read`, `update`, and `commit` callbacks receive. */
export type DataOf<K extends HandleKind> = z.output<K["schema"]>;
/** What `create` and `update` accept (schema input); differs from `DataOf` when the schema transforms or defaults. */
export type InputOf<K extends HandleKind> = z.input<K["schema"]>;
export type ResultOf<K extends HandleKind> =
	K extends DraftKind<any, infer R> ? (R extends ZodType ? z.output<R> : unknown) : never;

export type HandleStatus = "active" | "committing" | "committed";

export interface HandleRecord<K extends HandleKind> {
	/** Canonical handle string (`<kind>_<word>-<word>...`). */
	readonly handle: string;
	readonly kind: string;
	readonly status: HandleStatus;
	readonly data: DataOf<K>;
	readonly result?: ResultOf<K>;
	readonly createdAt: string;
	readonly expiresAt: string;
}

export interface HandleCommitResult<K extends HandleKind> {
	readonly status: "committed" | "replayed";
	readonly handle: string;
	readonly result: ResultOf<K>;
}

export interface HandleContext {
	/** Validates `data` with `kind.schema`, stores it, and returns the canonical handle. */
	create<K extends HandleKind>(kind: K, data: InputOf<K>): Promise<string>;
	/** Tolerantly parses `handle`, loads the record; drafts get their idle TTL touched. */
	read<K extends HandleKind>(kind: K, handle: string): Promise<HandleRecord<K>>;
	/** CAS update of an active draft (3 retries) with sliding TTL. */
	update<K extends DraftKind>(
		kind: K,
		handle: string,
		updater: (data: DataOf<K>) => InputOf<K> | Promise<InputOf<K>>,
	): Promise<HandleRecord<K>>;
	/** One-shot commit with result replay; see runtime docs for the state machine. */
	commit<K extends DraftKind>(
		kind: K,
		handle: string,
		work: (data: DataOf<K>) => Promise<ResultOf<K>>,
	): Promise<HandleCommitResult<K>>;
	/** Deletes the record; idempotent. */
	discard<K extends HandleKind>(kind: K, handle: string): Promise<void>;
}

export type HandleOperation = "create" | "read" | "update" | "commit" | "discard";

export type HandleTelemetryOutcome =
	| "success"
	| "not_found"
	| "expired"
	| "invalid"
	| "kind_mismatch"
	| "busy"
	| "replayed"
	| "error";

/** Allowlisted metadata only; handle values, data, and results are never included. */
export interface HandleTelemetryEvent {
	readonly providerId: string;
	readonly kind: string;
	readonly type: HandleKindType;
	readonly operation: HandleOperation;
	readonly outcome: HandleTelemetryOutcome;
	/** `"none"` or the sorted normalization classes joined by `+`. */
	readonly normalization: string;
	readonly words: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type HandleErrorCode =
	| "HANDLE_INVALID"
	| "HANDLE_NOT_FOUND"
	| "HANDLE_EXPIRED"
	| "HANDLE_KIND_MISMATCH"
	| "HANDLE_BUSY"
	| "HANDLE_COMMITTED"
	| "HANDLE_CONNECTION_REQUIRED"
	| "HANDLE_STORAGE_UNAVAILABLE"
	| "HANDLE_TOO_LARGE"
	| "HANDLE_INVALID_DATA"
	| "PICK_NOT_OFFERED";

const HANDLE_ERROR_DEFAULTS: Record<
	HandleErrorCode,
	{ readonly category: ProviderErrorCategory; readonly retryable: boolean }
> = {
	HANDLE_INVALID: { category: "input_validation", retryable: false },
	HANDLE_NOT_FOUND: { category: "input_validation", retryable: false },
	HANDLE_EXPIRED: { category: "input_validation", retryable: false },
	HANDLE_KIND_MISMATCH: { category: "input_validation", retryable: false },
	HANDLE_BUSY: { category: "internal_error", retryable: true },
	HANDLE_COMMITTED: { category: "input_validation", retryable: false },
	HANDLE_CONNECTION_REQUIRED: { category: "internal_error", retryable: false },
	HANDLE_STORAGE_UNAVAILABLE: { category: "internal_error", retryable: false },
	HANDLE_TOO_LARGE: { category: "internal_error", retryable: false },
	HANDLE_INVALID_DATA: { category: "internal_error", retryable: false },
	PICK_NOT_OFFERED: { category: "input_validation", retryable: false },
};

export type HandleErrorOptions = Omit<ProviderErrorOptions, "code"> & {
	/** Kind name the error relates to, when known. */
	readonly kind?: string;
};

export class HandleError extends ProviderError {
	readonly handleCode: HandleErrorCode;
	readonly kind?: string;

	constructor(code: HandleErrorCode, message: string, options: HandleErrorOptions = {}) {
		const { kind, ...rest } = options;
		const defaults = HANDLE_ERROR_DEFAULTS[code];
		super(message, {
			category: defaults.category,
			retryable: defaults.retryable,
			...rest,
			code,
		});
		this.name = "HandleError";
		this.handleCode = code;
		this.kind = kind;
		brandHandleError(this);
	}

	override get code(): HandleErrorCode {
		return this.handleCode;
	}
}

/**
 * Recognizes handle errors across duplicate SDK module copies (packaged CLI
 * `src/*` runtime vs provider `dist/*` import), where `instanceof` splits.
 */
export function isHandleError(value: unknown): value is HandleError {
	return value instanceof HandleError || hasHandleErrorBrand(value);
}

/**
 * Standard recovery sentence appended to every handle error message so the LLM
 * knows the next action without provider-specific wording.
 */
export function handleRecoverySentence(kind: {
	readonly fieldName: string;
	readonly issuedBy?: string;
}): string {
	if (kind.issuedBy) {
		return `Call \`${kind.issuedBy}\` again and pass the new \`${kind.fieldName}\` exactly as returned.`;
	}
	return `Request a new \`${kind.fieldName}\` and pass it exactly as returned.`;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

const SHORT_DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;
const ISO_DURATION_PATTERN = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/;

/** Parses a `ProviderStateDurationString` to milliseconds; throws on invalid or non-positive input. */
export function parseHandleDurationMs(value: ProviderStateDurationString, label: string): number {
	const short = SHORT_DURATION_PATTERN.exec(value);
	let ms: number | undefined;
	if (short) {
		const amount = Number(short[1]);
		const unit = short[2];
		const multiplier =
			unit === "ms"
				? 1
				: unit === "s"
					? 1_000
					: unit === "m"
						? 60_000
						: unit === "h"
							? 3_600_000
							: 86_400_000;
		ms = amount * multiplier;
	} else {
		const iso = ISO_DURATION_PATTERN.exec(value);
		if (iso && (iso[1] !== undefined || iso[2] !== undefined || iso[3] !== undefined)) {
			ms =
				Number(iso[1] ?? 0) * 3_600_000 +
				Number(iso[2] ?? 0) * 60_000 +
				Number(iso[3] ?? 0) * 1_000;
		}
	}
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
		throw new Error(
			`Handle kind ${label} must be a positive duration such as "10m", "2h", or "PT30M" (received ${JSON.stringify(value)}).`,
		);
	}
	return Math.floor(ms);
}

// ---------------------------------------------------------------------------
// Kind definitions
// ---------------------------------------------------------------------------

export interface DefineCursorOptions<TSchema extends ZodType> {
	/** Kind name, `/^[a-z]{2,12}$/`; becomes the handle prefix. */
	readonly name: string;
	/** Schema property key carrying the handle. Default `${name}_token`. */
	readonly fieldName?: string;
	readonly schema: TSchema;
	readonly ttl: ProviderStateDurationString;
	/** `"bound"` (default): connection-scoped, 2 words. `"public"`: provider-scoped, 4-5 words. */
	readonly access?: HandleAccess;
	/** Required when public. Bound default 200 per connection. */
	readonly maxEntries?: number;
	/** Default 16,000. */
	readonly maxValueBytes?: number;
	/** Public only; `"high"` forces 5 words. Auto-high when ttl > 1h. */
	readonly strength?: HandleStrength;
	/** Operation key that issues this handle; used in error text and lint. */
	readonly issuedBy?: string;
}

export interface DefineDraftOptions<
	TSchema extends ZodType,
	TResultSchema extends ZodType | undefined,
> {
	readonly name: string;
	readonly fieldName?: string;
	readonly schema: TSchema;
	/** Optional schema of the commit result (type-level). */
	readonly result?: TResultSchema;
	readonly ttl: {
		readonly idle: ProviderStateDurationString;
		readonly max: ProviderStateDurationString;
	};
	/** How long a committed record stays for replay. Default "24h". */
	readonly resultTtl?: ProviderStateDurationString;
	/** Default 200 per connection. */
	readonly maxEntries?: number;
	/** Default 64,000. */
	readonly maxValueBytes?: number;
	readonly issuedBy?: string;
}

function assertKindName(name: unknown, define: string): asserts name is string {
	if (typeof name !== "string" || !HANDLE_KIND_NAME_PATTERN.test(name)) {
		throw new Error(
			`${define}: kind name must match ${HANDLE_KIND_NAME_PATTERN} (2-12 lowercase letters, no digits or separators) so it never fuses with the word body; received ${JSON.stringify(name)}.`,
		);
	}
}

function assertFieldName(fieldName: string, define: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName)) {
		throw new Error(
			`${define}: fieldName must be a plain identifier usable as a schema property key; received ${JSON.stringify(fieldName)}.`,
		);
	}
}

function assertPositiveInteger(value: number, label: string, define: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${define}: ${label} must be a positive integer; received ${String(value)}.`);
	}
}

function createHandleField(meta: HandleFieldMeta): ZodString {
	const described = z.string().min(1).describe(handleFieldDescription(meta));
	// zod v4 `.meta()` replaces the registry entry, so carry the description over.
	const existing = described.meta() ?? {};
	return described.meta({ ...existing, [APIFUSE_HANDLE_META_KEY]: meta });
}

/** Defines an immutable cursor kind (pagination, offered option lists). */
export function defineCursor<TSchema extends ZodType>(
	options: DefineCursorOptions<TSchema>,
): CursorKind<TSchema> {
	const define = "defineCursor";
	assertKindName(options.name, define);
	const fieldName = options.fieldName ?? `${options.name}_token`;
	assertFieldName(fieldName, define);
	const access: HandleAccess = options.access ?? "bound";
	if (access !== "bound" && access !== "public") {
		throw new Error(`${define}: access must be "bound" or "public"; received ${String(access)}.`);
	}
	const ttlMs = parseHandleDurationMs(options.ttl, `"${options.name}" ttl`);
	const strength: HandleStrength = options.strength ?? "standard";
	if (strength !== "standard" && strength !== "high") {
		throw new Error(
			`${define}: strength must be "standard" or "high"; received ${String(strength)}.`,
		);
	}
	if (access === "public" && options.maxEntries === undefined) {
		throw new Error(
			`${define}: public cursor "${options.name}" must declare maxEntries (provider-wide live-entry quota).`,
		);
	}
	const maxEntries = options.maxEntries ?? DEFAULT_BOUND_MAX_ENTRIES;
	assertPositiveInteger(maxEntries, "maxEntries", define);
	const maxValueBytes = options.maxValueBytes ?? DEFAULT_CURSOR_MAX_VALUE_BYTES;
	assertPositiveInteger(maxValueBytes, "maxValueBytes", define);
	const wordCount: HandleWordCount =
		access === "bound"
			? BOUND_HANDLE_WORD_COUNT
			: strength === "high" || ttlMs > AUTO_HIGH_TTL_MS
				? HIGH_PUBLIC_HANDLE_WORD_COUNT
				: PUBLIC_HANDLE_WORD_COUNT;
	const meta: HandleFieldMeta = {
		kind: options.name,
		type: "cursor",
		fieldName,
		...(options.issuedBy ? { issuedBy: options.issuedBy } : {}),
	};
	return Object.freeze({
		name: options.name,
		type: "cursor",
		fieldName,
		access,
		issuedBy: options.issuedBy,
		schema: options.schema,
		ttl: options.ttl,
		ttlMs,
		strength,
		maxEntries,
		maxValueBytes,
		wordCount,
		field: () => createHandleField(meta),
	});
}

/** Defines a mutable, always-bound draft kind (multi-turn forms with one-shot commit). */
export function defineDraft<
	TSchema extends ZodType,
	TResultSchema extends ZodType | undefined = undefined,
>(options: DefineDraftOptions<TSchema, TResultSchema>): DraftKind<TSchema, TResultSchema> {
	const define = "defineDraft";
	assertKindName(options.name, define);
	const fieldName = options.fieldName ?? `${options.name}_token`;
	assertFieldName(fieldName, define);
	if (!options.ttl || typeof options.ttl !== "object") {
		throw new Error(`${define}: draft "${options.name}" ttl must be { idle, max }.`);
	}
	const idleTtlMs = parseHandleDurationMs(options.ttl.idle, `"${options.name}" ttl.idle`);
	const maxTtlMs = parseHandleDurationMs(options.ttl.max, `"${options.name}" ttl.max`);
	if (idleTtlMs > maxTtlMs) {
		throw new Error(
			`${define}: draft "${options.name}" ttl.idle (${idleTtlMs}ms) must not exceed ttl.max (${maxTtlMs}ms).`,
		);
	}
	const resultTtl = options.resultTtl ?? DEFAULT_RESULT_TTL;
	const resultTtlMs = parseHandleDurationMs(resultTtl, `"${options.name}" resultTtl`);
	const maxEntries = options.maxEntries ?? DEFAULT_BOUND_MAX_ENTRIES;
	assertPositiveInteger(maxEntries, "maxEntries", define);
	const maxValueBytes = options.maxValueBytes ?? DEFAULT_DRAFT_MAX_VALUE_BYTES;
	assertPositiveInteger(maxValueBytes, "maxValueBytes", define);
	const meta: HandleFieldMeta = {
		kind: options.name,
		type: "draft",
		fieldName,
		...(options.issuedBy ? { issuedBy: options.issuedBy } : {}),
	};
	return Object.freeze({
		name: options.name,
		type: "draft",
		fieldName,
		access: "bound",
		issuedBy: options.issuedBy,
		schema: options.schema,
		result: options.result,
		ttl: options.ttl,
		idleTtlMs,
		maxTtlMs,
		resultTtl,
		resultTtlMs,
		maxEntries,
		maxValueBytes,
		wordCount: BOUND_HANDLE_WORD_COUNT,
		field: () => createHandleField(meta),
	});
}

export function isDraftKind(kind: HandleKind): kind is DraftKind<any, any> {
	return kind.type === "draft";
}

export function isCursorKind(kind: HandleKind): kind is CursorKind<any> {
	return kind.type === "cursor";
}

// ---------------------------------------------------------------------------
// pick
// ---------------------------------------------------------------------------

export interface PickOptions<T> {
	/** Input field name, used in the error message. */
	readonly field: string;
	/** Item property compared against `value`. Default = `field`. */
	readonly by?: keyof T & string;
	/** Operation that listed the items; used in the error message when known. */
	readonly issuedBy?: string;
}

/**
 * Chooses one offered item by a plain value the LLM copied from the offer.
 * Exact match first, then a unique case-insensitive trimmed match; otherwise
 * `PICK_NOT_OFFERED` with the allowed values so the LLM can self-correct. The
 * server holds the offer, so a fabricated value fails here instead of reaching
 * upstream. This is the "one handle per offer + plain picks" half of ADR-0012.
 */
export function pick<T extends Record<string, unknown>>(
	items: readonly T[],
	value: string,
	options: PickOptions<T>,
): T {
	const by = options.by ?? options.field;
	const keyOf = (item: T): string => {
		const raw = item[by];
		return typeof raw === "string" ? raw : String(raw);
	};
	const exact = items.find((item) => keyOf(item) === value);
	if (exact) return exact;
	const folded = value.trim().toLowerCase();
	const loose = items.filter((item) => keyOf(item).trim().toLowerCase() === folded);
	if (loose.length === 1) return loose[0]!;
	const allowed = items.map(keyOf);
	const listed = options.issuedBy
		? ` Use the values exactly as listed by \`${options.issuedBy}\`.`
		: " Use the values exactly as listed.";
	throw new HandleError(
		"PICK_NOT_OFFERED",
		`\`${options.field}\` must be one of: ${allowed.join(", ")}.${listed}`,
		{ details: { field: options.field, allowed } },
	);
}
