/**
 * LLM-friendly handles (ADR-0012): runtime (`ctx.handle`).
 *
 * Storage layout: one state namespace per kind, `handle.<kind>`, scoped by the
 * kind's access (bound → connection scope via `state.forConnection`, public →
 * provider scope; both cursors and drafts may be either). The state key is the
 * canonical handle string. Records hold
 * the validated data plus status/timestamps; the handle string itself carries
 * no payload and no signature.
 */
import { randomInt, randomUUID } from "node:crypto";
import { isProviderError } from "../errors.js";
import {
	type DataOf,
	type InputOf,
	type DraftKind,
	type HandleCommitResult,
	type HandleContext,
	HandleError,
	type HandleKind,
	type HandleOperation,
	type HandleRecord,
	type HandleStatus,
	type HandleTelemetryEvent,
	type HandleTelemetryOutcome,
	handleRecoverySentence,
	isDraftKind,
	type ResultOf,
} from "../handle.js";
import { formatHandleIssuers } from "../handle-meta.js";
import type {
	ProviderRequestContext,
	ProviderRuntimeState,
	ProviderStateDurationString,
	ProviderStateNamespace,
	StateValue,
	StateCasResult,
} from "../types.js";
import {
	BOUND_HANDLE_WORD_COUNT,
	findHandleWordWithinDistance,
	HIGH_PUBLIC_HANDLE_WORD_COUNT,
	ISSUABLE_HANDLE_WORDS,
	PUBLIC_HANDLE_WORD_COUNT,
} from "./handle-wordlist.js";
import { createMemoryProviderRuntimeState } from "./state.js";

const RECORD_VERSION = 1;
const CREATE_ATTEMPTS = 5;
/** Minimum time a `committing` claim survives while upstream work runs. */
const COMMIT_LEASE_MS = 5 * 60_000;
const UPDATE_ATTEMPTS = 3;
const DISCARD_ATTEMPTS = 3;
/** Upper bound on how long an expired record is kept so it can report HANDLE_EXPIRED. */
const EXPIRY_GRACE_MAX_MS = 60 * 60_000;
const COMMIT_FINALIZE_RETRY_DELAY_MS = 50;
const COMMIT_FINALIZE_ATTEMPTS = 3;
const NAMESPACE_PREFIX = "handle.";

export interface CreateHandleContextOptions {
	readonly providerId: string;
	readonly request?: ProviderRequestContext;
	readonly state?: ProviderRuntimeState;
	/** Clock used for record timestamps and TTL math; defaults to `Date.now`. */
	readonly nowMs?: () => number;
	/** Receives allowlisted metadata only; handle values, data, and results are never included. */
	readonly onTelemetry?: (event: HandleTelemetryEvent) => void;
	/**
	 * Lease held (and renewed) by a `committing` claim while upstream work runs.
	 * Defaults to 5 minutes; exposed so tests can exercise renewal quickly.
	 */
	readonly commitLeaseMs?: number;
}

export interface CreateTestHandleContextOptions {
	readonly providerId?: string;
	readonly state?: ProviderRuntimeState;
	readonly request?: ProviderRequestContext;
	readonly nowMs?: () => number;
	readonly onTelemetry?: (event: HandleTelemetryEvent) => void;
}

/**
 * Persisted record shape (spec §6). `expires_at_ms` is the logical expiry the
 * caller sees (sliding for drafts); `max_expires_at_ms` is the hard lifetime.
 * Records are stored past their logical expiry for a grace window so an expired
 * handle can be told apart from an unknown one (`HANDLE_EXPIRED` vs
 * `HANDLE_NOT_FOUND`); after the grace window they are simply gone.
 */
export type StoredHandleRecord = {
	readonly v: typeof RECORD_VERSION;
	readonly kind: string;
	readonly type: "cursor" | "draft";
	/** `discarded` is an internal tombstone written by `discard`; reads treat it as absent. */
	readonly status: HandleStatus | "discarded";
	readonly data: unknown;
	readonly result?: unknown;
	readonly created_at_ms: number;
	readonly expires_at_ms: number;
	readonly max_expires_at_ms: number;
	readonly committed_at_ms?: number;
	/** Owner token of a `committing` claim; lets the claimant recognise its record after an ambiguous write. */
	readonly claim_id?: string;
};

export type HandleNormalizationClass = "case" | "whitespace" | "separator" | "punctuation" | "typo";

export interface NormalizedHandle {
	readonly canonical: string;
	readonly words: readonly string[];
	readonly normalization: readonly HandleNormalizationClass[];
}

// ---------------------------------------------------------------------------
// Normalization (spec §4)
// ---------------------------------------------------------------------------

/**
 * Security argument: normalization is a deterministic many-to-one map from raw
 * input onto exactly one canonical key. One attempt still tests exactly one
 * key, so the ADR 0006 §2 guessing numbers for public 4/5-word handles are
 * unchanged. Distance-1 word repair cannot widen the target set because the
 * wordlist has pairwise edit distance >= 3: the distance-1 neighbourhoods of
 * two different words never overlap, so a segment resolves to at most one
 * word. Bound 2-word handles need no guessing analysis at all (other
 * connections cannot address them).
 */
// None of these characters can occur inside a canonical handle, so stripping
// any run of them at either end (balanced or not — the 2026-08-21 "trailing
// quote" shape was unbalanced) cannot change which key is addressed.
const LEADING_WRAPPING = /^["'`<([{\s]+/;
const TRAILING_WRAPPING = /["'`>)\]}\s.,;:!?]+$/;
const KIND_SEPARATOR = /^[_\-:\s]+/;
const WORD_SEPARATOR = /[-_\s]+/;

type NormalizationFailure =
	| { readonly ok: false; readonly reason: "kind_mismatch" }
	| { readonly ok: false; readonly reason: "invalid"; readonly detail: string };

type NormalizationOutcome = ({ readonly ok: true } & NormalizedHandle) | NormalizationFailure;

function stripWrapping(value: string): { text: string; stripped: boolean } {
	const text = value.replace(LEADING_WRAPPING, "").replace(TRAILING_WRAPPING, "");
	return { text, stripped: text !== value };
}

function classifySeparator(
	actual: string,
	expected: string,
	classes: Set<HandleNormalizationClass>,
): void {
	if (actual === expected) return;
	if (/\s/.test(actual)) classes.add("whitespace");
	if (actual.replace(/\s+/g, "") !== expected) classes.add("separator");
}

function acceptedWordCounts(kind: HandleKind): readonly number[] {
	// Public cursors accept both 4 and 5 words so a kind can move between
	// standard and high strength without invalidating handles in flight.
	if (kind.access === "public") return [PUBLIC_HANDLE_WORD_COUNT, HIGH_PUBLIC_HANDLE_WORD_COUNT];
	return [BOUND_HANDLE_WORD_COUNT];
}

/**
 * Longest input the normalizer will look at. A canonical handle is at most
 * 12 (kind) + 1 + 5 × 10 + 4 (words and hyphens) = 67 characters; the budget
 * leaves room for wrapping punctuation and stray whitespace while keeping the
 * synchronous normalization path bounded against arbitrary client input.
 */
const MAX_HANDLE_INPUT_LENGTH = 256;

function normalizeHandleInternal(kind: HandleKind, raw: string): NormalizationOutcome {
	const classes = new Set<HandleNormalizationClass>();
	if (raw.length > MAX_HANDLE_INPUT_LENGTH) {
		return { ok: false, reason: "invalid", detail: "input too long" };
	}
	// 1. trim; strip wrapping quotes/backticks/brackets and trailing punctuation.
	const trimmed = raw.trim();
	if (trimmed !== raw) classes.add("whitespace");
	const { text: unwrapped, stripped } = stripWrapping(trimmed);
	if (stripped) classes.add("punctuation");
	// 2. lowercase.
	const lowered = unwrapped.toLowerCase();
	if (lowered !== unwrapped) classes.add("case");
	// 3. must start with the kind name followed by 1+ separators.
	if (!lowered.startsWith(kind.name)) return { ok: false, reason: "kind_mismatch" };
	const afterKind = lowered.slice(kind.name.length);
	const kindSeparator = KIND_SEPARATOR.exec(afterKind)?.[0];
	if (kindSeparator === undefined) {
		if (afterKind.length === 0) return { ok: false, reason: "invalid", detail: "missing words" };
		// e.g. kind "page" against "pages_..." — a different (longer) kind name.
		return { ok: false, reason: "kind_mismatch" };
	}
	classifySeparator(kindSeparator, "_", classes);
	const body = afterKind.slice(kindSeparator.length);
	if (body.length === 0) return { ok: false, reason: "invalid", detail: "missing words" };
	// 4. split on separators; resolve each segment exactly or at edit distance 1.
	const segments = body.split(WORD_SEPARATOR);
	const separators = body.match(new RegExp(WORD_SEPARATOR.source, "g")) ?? [];
	if (segments.some((segment) => segment.length === 0)) {
		return { ok: false, reason: "invalid", detail: "trailing separator" };
	}
	for (const separator of separators) classifySeparator(separator, "-", classes);
	const words: string[] = [];
	for (const segment of segments) {
		const word = findHandleWordWithinDistance(segment, 1);
		if (word === null) return { ok: false, reason: "invalid", detail: "unknown word" };
		if (word !== segment) classes.add("typo");
		words.push(word);
	}
	// 5. word count must match the kind.
	if (!acceptedWordCounts(kind).includes(words.length)) {
		return { ok: false, reason: "invalid", detail: `expected ${kind.wordCount} words` };
	}
	// 6. canonical form.
	return {
		ok: true,
		canonical: `${kind.name}_${words.join("-")}`,
		words,
		normalization: Array.from(classes).sort(),
	};
}

/**
 * Tolerant parse of a raw handle string into its canonical form. Throws
 * `HANDLE_KIND_MISMATCH` when the string does not start with the kind name and
 * `HANDLE_INVALID` when the body cannot be resolved to the kind's word count.
 */
export function normalizeHandle(
	kind: HandleKind,
	raw: string,
): { canonical: string; words: string[]; normalization: string[] } {
	const outcome = normalizeHandleInternal(kind, raw);
	if (!outcome.ok) throw normalizationError(kind, outcome);
	return {
		canonical: outcome.canonical,
		words: [...outcome.words],
		normalization: [...outcome.normalization],
	};
}

export function formatNormalizationClasses(classes: readonly string[]): string {
	return classes.length === 0 ? "none" : [...classes].sort().join("+");
}

// ---------------------------------------------------------------------------
// Errors (spec §5)
// ---------------------------------------------------------------------------

function publicCollapsedMessage(kind: HandleKind): string {
	const issuers = formatHandleIssuers(kind.issuedBy);
	const again = issuers ? `Call ${issuers} again to get a new one.` : "Request a new one.";
	return `\`${kind.fieldName}\` is not valid or has expired. ${again}`;
}

function normalizationError(kind: HandleKind, failure: NormalizationFailure): HandleError {
	if (failure.reason === "kind_mismatch") {
		return new HandleError(
			"HANDLE_KIND_MISMATCH",
			`\`${kind.fieldName}\` must be a \`${kind.name}_...\` handle as returned by ${
				formatHandleIssuers(kind.issuedBy) ?? "the issuing operation"
			}. ${handleRecoverySentence(kind)}`,
			{ kind: kind.name, details: { field: kind.fieldName } },
		);
	}
	if (kind.access === "public") {
		return new HandleError("HANDLE_INVALID", publicCollapsedMessage(kind), {
			kind: kind.name,
			details: { field: kind.fieldName },
		});
	}
	return new HandleError(
		"HANDLE_INVALID",
		`\`${kind.fieldName}\` is not a well-formed \`${kind.name}\` handle (${failure.detail}). ${handleRecoverySentence(kind)}`,
		{ kind: kind.name, details: { field: kind.fieldName } },
	);
}

function notFoundError(kind: HandleKind): HandleError {
	if (kind.access === "public") {
		return new HandleError("HANDLE_INVALID", publicCollapsedMessage(kind), {
			kind: kind.name,
			details: { field: kind.fieldName },
		});
	}
	return new HandleError(
		"HANDLE_NOT_FOUND",
		`\`${kind.fieldName}\` was not found; it may have expired or belong to another session. ${handleRecoverySentence(kind)}`,
		{ kind: kind.name, details: { field: kind.fieldName } },
	);
}

type ExpiredDeadline = "ttl" | "idle" | "max" | "result";

/** Which deadline a present record missed; drives the wording of HANDLE_EXPIRED. */
function expiredDeadline(
	kind: HandleKind,
	record: StoredHandleRecord,
	now: number,
): ExpiredDeadline {
	if (record.status === "committed") return "result";
	if (!isDraftKind(kind)) return "ttl";
	return now >= record.max_expires_at_ms ? "max" : "idle";
}

function expiredError(kind: HandleKind, deadline: ExpiredDeadline = "ttl"): HandleError {
	if (kind.access === "public") {
		return new HandleError("HANDLE_INVALID", publicCollapsedMessage(kind), {
			kind: kind.name,
			details: { field: kind.fieldName },
		});
	}
	const lifetimeMs = isDraftKind(kind)
		? deadline === "idle"
			? kind.idleTtlMs
			: deadline === "result"
				? kind.resultTtlMs
				: kind.maxTtlMs
		: kind.ttlMs;
	const minutes = Math.max(1, Math.round(lifetimeMs / 60_000));
	const reason =
		deadline === "idle"
			? `expired after ${minutes} minutes of inactivity`
			: deadline === "result"
				? `was completed more than ${minutes} minutes ago and its result is no longer available`
				: `expired after ${minutes} minutes`;
	return new HandleError(
		"HANDLE_EXPIRED",
		`\`${kind.fieldName}\` ${reason}. ${handleRecoverySentence(kind)}`,
		{
			kind: kind.name,
			details: { field: kind.fieldName, deadline, lifetimeMinutes: minutes },
		},
	);
}

function busyError(kind: HandleKind): HandleError {
	return new HandleError(
		"HANDLE_BUSY",
		`\`${kind.fieldName}\` is being committed by another request. Retry shortly with the same \`${kind.fieldName}\`.`,
		{ kind: kind.name, details: { field: kind.fieldName } },
	);
}

function committedError(kind: HandleKind): HandleError {
	return new HandleError(
		"HANDLE_COMMITTED",
		`\`${kind.fieldName}\` has already been committed and can no longer be changed. ${handleRecoverySentence(kind)}`,
		{ kind: kind.name, details: { field: kind.fieldName } },
	);
}

function connectionRequiredError(kind: HandleKind, operation: HandleOperation): HandleError {
	return new HandleError(
		"HANDLE_CONNECTION_REQUIRED",
		`Handle kind "${kind.name}" is bound to a connection, but request.connectionId is missing for ${operation}. Bound handles require a connection-scoped request; use access: "public" for connection-less kinds.`,
		{ kind: kind.name },
	);
}

function storageUnavailableError(kind: HandleKind, reason: string, cause?: Error): HandleError {
	return new HandleError(
		"HANDLE_STORAGE_UNAVAILABLE",
		`Handle storage for kind "${kind.name}" is not available: ${reason}.`,
		{ kind: kind.name, cause, details: { reason } },
	);
}

function tooLargeError(kind: HandleKind, bytes: number): HandleError {
	return new HandleError(
		"HANDLE_TOO_LARGE",
		`Handle record for kind "${kind.name}" is ${bytes} bytes, above maxValueBytes ${kind.maxValueBytes}. Store less in the handle or raise maxValueBytes on the kind.`,
		{ kind: kind.name, details: { bytes, maxValueBytes: kind.maxValueBytes } },
	);
}

function invalidDataError(
	kind: HandleKind,
	operation: HandleOperation,
	cause: unknown,
): HandleError {
	const summary =
		cause !== null && typeof cause === "object" && "message" in cause
			? String((cause as { message: unknown }).message).split("\n")[0]
			: "schema validation failed";
	return new HandleError(
		"HANDLE_INVALID_DATA",
		`Handle kind "${kind.name}" ${operation} received data that does not satisfy its schema (${summary}). This is a provider bug: validate or shape the data before storing it.`,
		{
			kind: kind.name,
			cause: cause instanceof Error ? cause : undefined,
			details: { operation, issues: extractIssues(cause) },
		},
	);
}

function extractIssues(cause: unknown): unknown {
	if (cause !== null && typeof cause === "object" && "issues" in cause) {
		return (cause as { issues: unknown }).issues;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

function msDuration(ms: number): ProviderStateDurationString {
	return `${Math.max(1, Math.floor(ms))}ms`;
}

function generateWords(count: number): string[] {
	return Array.from(
		{ length: count },
		() => ISSUABLE_HANDLE_WORDS[randomInt(ISSUABLE_HANDLE_WORDS.length)]!,
	);
}

function isStoredHandleRecord(value: unknown): value is StoredHandleRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.v === RECORD_VERSION &&
		typeof record.kind === "string" &&
		(record.type === "cursor" || record.type === "draft") &&
		(record.status === "active" ||
			record.status === "committing" ||
			record.status === "committed" ||
			record.status === "discarded") &&
		"data" in record &&
		typeof record.created_at_ms === "number" &&
		typeof record.expires_at_ms === "number" &&
		typeof record.max_expires_at_ms === "number"
	);
}

function recordBytes(record: StoredHandleRecord): number {
	return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function isStateUnsupportedError(error: unknown): error is Error {
	return isProviderError(error) && error.code === "PROVIDER_STATE_UNSUPPORTED";
}

/** Returns the path of the first value JSON cannot represent faithfully, or undefined. */
function findNonJsonSafePath(value: unknown, path: string): string | undefined {
	if (value === null) return undefined;
	switch (typeof value) {
		case "string":
		case "boolean":
			return undefined;
		case "number":
			return Number.isFinite(value) ? undefined : path;
		case "undefined":
			// Dropped by JSON.stringify; the schema decides whether that is acceptable.
			return undefined;
		case "object": {
			if (Array.isArray(value)) {
				for (const [index, entry] of value.entries()) {
					if (entry === undefined) return `${path}[${index}]`;
					const nested = findNonJsonSafePath(entry, `${path}[${index}]`);
					if (nested) return nested;
				}
				return undefined;
			}
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) return path;
			for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
				const nested = findNonJsonSafePath(entry, `${path}.${key}`);
				if (nested) return nested;
			}
			return undefined;
		}
		default:
			return path;
	}
}

export function createHandleContext(options: CreateHandleContextOptions): HandleContext {
	const nowMs = options.nowMs ?? (() => Date.now());
	const commitLeaseMs = Math.max(1, options.commitLeaseMs ?? COMMIT_LEASE_MS);
	const connectionId = options.request?.connectionId;

	function emit(
		kind: HandleKind,
		operation: HandleOperation,
		outcome: HandleTelemetryOutcome,
		normalization: readonly string[],
		words: number,
	): void {
		if (!options.onTelemetry) return;
		try {
			options.onTelemetry({
				providerId: options.providerId,
				kind: kind.name,
				type: kind.type,
				operation,
				outcome,
				normalization: formatNormalizationClasses(normalization),
				words,
			});
		} catch {
			// Telemetry must never affect the operation outcome.
		}
	}

	function outcomeForError(error: unknown): HandleTelemetryOutcome {
		if (!(error instanceof HandleError)) return "error";
		switch (error.code) {
			case "HANDLE_NOT_FOUND":
				return "not_found";
			case "HANDLE_EXPIRED":
				return "expired";
			case "HANDLE_INVALID":
				return "invalid";
			case "HANDLE_KIND_MISMATCH":
				return "kind_mismatch";
			case "HANDLE_BUSY":
				return "busy";
			default:
				return "error";
		}
	}

	/** Runs an operation and emits exactly one telemetry event for it. */
	async function instrumented<T>(
		kind: HandleKind,
		operation: HandleOperation,
		run: (report: (normalization: readonly string[], words: number) => void) => Promise<{
			readonly value: T;
			readonly outcome: HandleTelemetryOutcome;
		}>,
	): Promise<T> {
		let normalization: readonly string[] = [];
		let words = 0;
		const report = (nextNormalization: readonly string[], nextWords: number): void => {
			normalization = nextNormalization;
			words = nextWords;
		};
		try {
			const result = await run(report);
			emit(kind, operation, result.outcome, normalization, words);
			return result.value;
		} catch (error) {
			emit(kind, operation, outcomeForError(error), normalization, words);
			throw error;
		}
	}

	function resolveNamespace(kind: HandleKind, operation: HandleOperation): ProviderStateNamespace {
		if (!options.state) {
			throw storageUnavailableError(kind, "no runtime state was provided to ctx.handle");
		}
		const bound = kind.access === "bound";
		if (bound && connectionId === undefined) {
			throw connectionRequiredError(kind, operation);
		}
		const state = bound ? options.state.forConnection(connectionId) : options.state;
		// Storage ttl = logical remaining lifetime + expiry grace; drafts also need
		// room for the commit lease (see COMMIT_LEASE_MS).
		const maxTtlMs = isDraftKind(kind)
			? Math.max(
					kind.maxTtlMs + graceMs(kind.maxTtlMs),
					kind.resultTtlMs + graceMs(kind.resultTtlMs),
					commitLeaseMs,
				)
			: kind.ttlMs + graceMs(kind.ttlMs);
		const defaultTtlMs = isDraftKind(kind) ? kind.idleTtlMs : kind.ttlMs;
		try {
			return state.namespace(`${NAMESPACE_PREFIX}${kind.name}`, {
				scope: bound ? "connection" : "provider",
				defaultTtl: msDuration(defaultTtlMs),
				maxTtl: msDuration(maxTtlMs),
				maxEntries: kind.maxEntries,
				maxValueBytes: kind.maxValueBytes,
			});
		} catch (error) {
			throw translateStorageError(kind, error);
		}
	}

	function translateStorageError(kind: HandleKind, error: unknown): unknown {
		if (isStateUnsupportedError(error)) {
			const reason = /quota exceeded/i.test(error.message)
				? "live-entry quota exceeded (maxEntries)"
				: error.message;
			return storageUnavailableError(kind, reason, error);
		}
		return error;
	}

	async function storage<T>(kind: HandleKind, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			throw translateStorageError(kind, error);
		}
	}

	function validateData(kind: HandleKind, operation: HandleOperation, data: unknown): unknown {
		const parsed = kind.schema.safeParse(data);
		if (!parsed.success) throw invalidDataError(kind, operation, parsed.error);
		if (parsed.data === undefined) {
			// JSON drops an undefined property, so the record would come back
			// without `data` and fail its shape check on the next read.
			throw invalidDataError(kind, operation, new Error("data must not be undefined"));
		}
		// Records are persisted as JSON (Redis). Values that JSON cannot represent
		// (Date, Map, Set, class instances, NaN, bigint, functions) would silently
		// come back as strings or empty objects and violate the schema's output
		// type on read, so they are rejected at write time instead.
		const unsafePath = findNonJsonSafePath(parsed.data, "data");
		if (unsafePath) {
			throw invalidDataError(
				kind,
				operation,
				new Error(
					`${unsafePath} is not JSON-safe (Date, Map, Set, class instances, NaN, bigint and functions cannot be stored)`,
				),
			);
		}
		// Detach from the caller's object graph so later mutation of the input (or,
		// with memory state, of the stored reference) cannot rewrite the record.
		return detach(parsed.data);
	}

	/** Deep copy handed to callbacks and returned from reads so provider code cannot alias stored state. */
	function detach<T>(value: T): T {
		return value === undefined ? value : (structuredClone(value) as T);
	}

	/** Grace window after logical expiry during which HANDLE_EXPIRED is still reportable. */
	function graceMs(lifetimeMs: number): number {
		return Math.min(lifetimeMs, EXPIRY_GRACE_MAX_MS);
	}

	/** Logical expiry of an active draft after a touch: `min(now + idle, max_expires_at_ms)`. */
	function draftExpiresAtMs(kind: DraftKind, record: StoredHandleRecord, now: number): number {
		return Math.min(now + kind.idleTtlMs, record.max_expires_at_ms);
	}

	/**
	 * Physical storage ttl for a record: the time until it can no longer report
	 * HANDLE_EXPIRED. Drafts live to their hard lifetime (small, per-connection
	 * quota) so idle expiry stays distinguishable until `max` + grace.
	 */
	function storageTtlMs(kind: HandleKind, record: StoredHandleRecord, now: number): number {
		if (record.status === "committed") {
			const lifetimeMs = isDraftKind(kind) ? kind.resultTtlMs : kind.ttlMs;
			return Math.max(1, record.expires_at_ms - now) + graceMs(lifetimeMs);
		}
		if (isDraftKind(kind)) {
			return Math.max(1, record.max_expires_at_ms - now) + graceMs(kind.maxTtlMs);
		}
		return Math.max(1, record.expires_at_ms - now) + graceMs(kind.ttlMs);
	}

	function assertSize(kind: HandleKind, record: StoredHandleRecord): void {
		const bytes = recordBytes(record);
		if (bytes > kind.maxValueBytes) throw tooLargeError(kind, bytes);
	}

	function toHandleRecord<K extends HandleKind>(
		kind: K,
		canonical: string,
		record: StoredHandleRecord,
	): HandleRecord<K> {
		return {
			handle: canonical,
			kind: kind.name,
			status: record.status as HandleStatus,
			data: detach(record.data) as DataOf<K>,
			...(record.status === "committed" ? { result: detach(record.result) as ResultOf<K> } : {}),
			createdAt: new Date(record.created_at_ms).toISOString(),
			expiresAt: new Date(record.expires_at_ms).toISOString(),
		};
	}

	type Loaded = {
		readonly canonical: string;
		readonly normalization: readonly string[];
		readonly words: readonly string[];
		readonly namespace: ProviderStateNamespace;
		readonly stored: StateValue<StoredHandleRecord>;
		readonly record: StoredHandleRecord;
	};

	/**
	 * Normalizes, resolves storage, and loads the record, applying the spec §5
	 * expiry classification: absent → NOT_FOUND, present past `max_expires_at_ms`
	 * → EXPIRED (public kinds collapse both to HANDLE_INVALID).
	 */
	async function load(
		kind: HandleKind,
		operation: HandleOperation,
		raw: string,
		report: (normalization: readonly string[], words: number) => void,
	): Promise<Loaded> {
		const outcome = normalizeHandleInternal(kind, raw);
		if (!outcome.ok) throw normalizationError(kind, outcome);
		report(outcome.normalization, outcome.words.length);
		const namespace = resolveNamespace(kind, operation);
		const stored = await storage(kind, () => namespace.get<unknown>(outcome.canonical));
		if (!stored) throw notFoundError(kind);
		const value = stored.value;
		if (
			!isStoredHandleRecord(value) ||
			value.kind !== kind.name ||
			value.type !== kind.type ||
			value.status === "discarded"
		) {
			// Corrupt or foreign record under our key (or a discard tombstone that has
			// not been reclaimed yet): unusable, never disclose contents.
			if (isStoredHandleRecord(value) && value.status === "discarded") throw notFoundError(kind);
			throw kind.access === "public"
				? notFoundError(kind)
				: normalizationError(kind, {
						ok: false,
						reason: "invalid",
						detail: "record unreadable",
					});
		}
		// A live `committing` claim is still doing work under its lease even if the
		// draft's hard expiry passed meanwhile; callers must see BUSY, not EXPIRED,
		// so they do not start a second flow while the first may still succeed.
		if (value.status !== "committing") {
			const now = nowMs();
			if (now >= value.expires_at_ms || now >= value.max_expires_at_ms) {
				throw expiredError(kind, expiredDeadline(kind, value, now));
			}
		}
		return {
			canonical: outcome.canonical,
			normalization: outcome.normalization,
			words: outcome.words,
			namespace,
			stored: { ...stored, value },
			record: value,
		};
	}

	async function createRecord<K extends HandleKind>(
		kind: K,
		data: InputOf<K>,
	): Promise<HandleRecord<K>> {
		return await instrumented<HandleRecord<K>>(kind, "create", async (report) => {
			const validated = validateData(kind, "create", data);
			const namespace = resolveNamespace(kind, "create");
			const now = nowMs();
			const lifetimeMs = isDraftKind(kind) ? kind.maxTtlMs : kind.ttlMs;
			const record: StoredHandleRecord = {
				v: RECORD_VERSION,
				kind: kind.name,
				type: kind.type,
				status: "active",
				data: validated,
				created_at_ms: now,
				expires_at_ms:
					now + (isDraftKind(kind) ? Math.min(kind.idleTtlMs, kind.maxTtlMs) : lifetimeMs),
				max_expires_at_ms: now + lifetimeMs,
			};
			const writeTtlMs = storageTtlMs(kind, record, now);
			assertSize(kind, record);
			report([], kind.wordCount);
			// CAS-if-absent (expected version 0). A collision with a live handle of
			// the same scope simply retries with fresh words; five misses in a
			// 1.68M (bound) or 2.8T+ (public) key space means storage is unhealthy.
			for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
				const canonical = `${kind.name}_${generateWords(kind.wordCount).join("-")}`;
				const result = await storage(kind, () =>
					namespace.compareAndSet(canonical, 0, record, { ttl: msDuration(writeTtlMs) }),
				);
				if (result.ok) {
					return { value: toHandleRecord(kind, canonical, record), outcome: "success" };
				}
			}
			throw storageUnavailableError(
				kind,
				`could not allocate a unique handle after ${CREATE_ATTEMPTS} attempts`,
			);
		});
	}

	async function create<K extends HandleKind>(kind: K, data: InputOf<K>): Promise<string> {
		return (await createRecord(kind, data)).handle;
	}

	async function read<K extends HandleKind>(kind: K, handle: string): Promise<HandleRecord<K>> {
		return await instrumented<HandleRecord<K>>(kind, "read", async (report) => {
			const loaded = await load(kind, "read", handle, report);
			const now = nowMs();
			if (isDraftKind(kind) && loaded.record.status === "active") {
				// Sliding TTL: rewrite the record with a fresh logical expiry. Losing the
				// CAS means a concurrent update/commit already refreshed it.
				const touched: StoredHandleRecord = {
					...loaded.record,
					expires_at_ms: draftExpiresAtMs(kind, loaded.record, now),
				};
				await storage(kind, () =>
					touchDraft(
						loaded.namespace,
						loaded.canonical,
						loaded.stored,
						touched,
						storageTtlMs(kind, touched, now),
					),
				);
				return { value: toHandleRecord(kind, loaded.canonical, touched), outcome: "success" };
			}
			return { value: toHandleRecord(kind, loaded.canonical, loaded.record), outcome: "success" };
		});
	}

	async function touchDraft(
		namespace: ProviderStateNamespace,
		canonical: string,
		stored: StateValue<StoredHandleRecord>,
		touched: StoredHandleRecord,
		ttlMs: number,
	): Promise<void> {
		await namespace.compareAndSet(canonical, stored.version, touched, {
			ttl: msDuration(ttlMs),
		});
	}

	async function update<K extends DraftKind>(
		kind: K,
		handle: string,
		updater: (data: DataOf<K>) => InputOf<K> | Promise<InputOf<K>>,
	): Promise<HandleRecord<K>> {
		return await instrumented<HandleRecord<K>>(kind, "update", async (report) => {
			for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
				const loaded = await load(kind, "update", handle, report);
				if (loaded.record.status === "committed") throw committedError(kind);
				if (loaded.record.status === "committing") throw busyError(kind);
				const nextData = validateData(
					kind,
					"update",
					await updater(detach(loaded.record.data) as DataOf<K>),
				);
				const now = nowMs();
				const next: StoredHandleRecord = {
					...loaded.record,
					data: nextData,
					expires_at_ms: draftExpiresAtMs(kind, loaded.record, now),
				};
				assertSize(kind, next);
				const ttlMs = storageTtlMs(kind, next, now);
				const result = await storage(kind, () =>
					loaded.namespace.compareAndSet(loaded.canonical, loaded.stored.version, next, {
						ttl: msDuration(ttlMs),
					}),
				);
				if (result.ok) {
					return {
						value: toHandleRecord(kind, loaded.canonical, next),
						outcome: "success",
					};
				}
			}
			throw busyError(kind);
		});
	}

	async function commit<K extends DraftKind>(
		kind: K,
		handle: string,
		work: (data: DataOf<K>) => Promise<ResultOf<K>>,
	): Promise<HandleCommitResult<K>> {
		return await instrumented<HandleCommitResult<K>>(kind, "commit", async (report) => {
			const loaded = await load(kind, "commit", handle, report);
			if (loaded.record.status === "committed") {
				return {
					value: {
						status: "replayed",
						handle: loaded.canonical,
						result: detach(loaded.record.result) as ResultOf<K>,
					},
					outcome: "replayed",
				};
			}
			if (loaded.record.status === "committing") throw busyError(kind);

			// active → committing. The claim holds a lease that is independent of the
			// draft's remaining idle ttl: upstream work started near expiry must still
			// be able to persist its result, otherwise a successful mutation would be
			// lost and the retry would see NOT_FOUND instead of the promised replay.
			// A crashed committer leaves the record BUSY for at most the lease.
			const claimId = randomUUID();
			const committing: StoredHandleRecord = {
				...loaded.record,
				status: "committing",
				claim_id: claimId,
			};
			const remainingMs = storageTtlMs(kind, committing, nowMs());
			let claim: StateCasResult<unknown>;
			try {
				claim = await storage(kind, () =>
					loaded.namespace.compareAndSet(loaded.canonical, loaded.stored.version, committing, {
						ttl: msDuration(Math.max(remainingMs, commitLeaseMs)),
					}),
				);
			} catch (error) {
				// Ambiguous write: the claim may have landed although the response was
				// lost. Re-read and recognise our own claim id; otherwise the draft is
				// untouched (still active) and the storage error stands.
				const current = await storage(kind, () => loaded.namespace.get<unknown>(loaded.canonical));
				if (
					current &&
					isStoredHandleRecord(current.value) &&
					current.value.status === "committing" &&
					current.value.claim_id === claimId
				) {
					claim = { ok: true, value: current };
				} else {
					throw error;
				}
			}
			if (!claim.ok) {
				// Lost the race: another caller moved the record. Classify by what they did.
				const current = claim.current?.value;
				if (isStoredHandleRecord(current) && current.status === "committed") {
					return {
						value: {
							status: "replayed",
							handle: loaded.canonical,
							result: detach(current.result) as ResultOf<K>,
						},
						outcome: "replayed",
					};
				}
				throw busyError(kind);
			}
			let version = claim.value.version;

			// Renew the claim while upstream work is running so its storage lifetime
			// can never end underneath a slow callback (which would lose the result
			// and turn the retry into NOT_FOUND instead of a replay). Best effort:
			// a lost renewal CAS means another actor moved the record, and the
			// finalize step below classifies that.
			let renewing = true;
			let wakeRenewal: (() => void) | undefined;
			const stopRenewal = (): void => {
				renewing = false;
				wakeRenewal?.();
			};
			const renew = async (): Promise<void> => {
				while (renewing) {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, Math.max(1, Math.floor(commitLeaseMs / 2)));
						timer.unref?.();
						wakeRenewal = () => {
							clearTimeout(timer);
							resolve();
						};
					});
					if (!renewing) return;
					try {
						const renewed = await loaded.namespace.compareAndSet(
							loaded.canonical,
							version,
							committing,
							{ ttl: msDuration(commitLeaseMs) },
						);
						if (renewed.ok) {
							version = renewed.value.version;
							continue;
						}
						// Lost the CAS. Only a `committing` record can still be ours (another
						// actor cannot claim a committing draft); adopt its version and keep
						// renewing, otherwise the record moved on and finalize classifies it.
						const current = renewed.current;
						if (
							current &&
							isStoredHandleRecord(current.value) &&
							current.value.status === "committing" &&
							current.value.claim_id === claimId
						) {
							version = current.version;
							continue;
						}
						return;
					} catch {
						// Ambiguous write (e.g. a Redis timeout after the SET landed): the
						// version we hold may be stale. Re-read and adopt the live version so
						// the next renewal does not fail its CAS and let the lease lapse.
						try {
							const current = await loaded.namespace.get<unknown>(loaded.canonical);
							if (
								current &&
								isStoredHandleRecord(current.value) &&
								current.value.status === "committing" &&
								current.value.claim_id === claimId
							) {
								version = current.version;
							}
						} catch {
							// Still unreachable; try again after the next interval.
						}
					}
				}
			};
			const renewal = renew();

			let result: ResultOf<K>;
			try {
				result = await work(detach(loaded.record.data) as DataOf<K>);
			} catch (error) {
				stopRenewal();
				await renewal;
				// Restore committing → active so the caller can retry; best effort.
				try {
					// Refresh the idle deadline (bounded by max) so a confirm that failed
					// after a long upstream call stays retryable instead of reading as
					// expired the moment it is restored.
					const restoreNow = nowMs();
					const restored: StoredHandleRecord = {
						...loaded.record,
						status: "active",
						expires_at_ms: draftExpiresAtMs(kind, loaded.record, restoreNow),
					};
					const ttlMs = storageTtlMs(kind, restored, restoreNow);
					await loaded.namespace.compareAndSet(loaded.canonical, version, restored, {
						ttl: msDuration(ttlMs),
					});
				} catch {
					// The record stays `committing` until its ttl lapses; the work error wins.
				}
				throw error;
			}

			stopRenewal();
			await renewal;
			const now = nowMs();
			// Results are persisted as JSON too: reject Date/Map/Set/class instances so
			// the initial return and every replay carry the same value, and detach so
			// the caller's post-processing cannot rewrite the stored replay.
			const unsafeResultPath = findNonJsonSafePath(result, "result");
			if (unsafeResultPath) {
				throw invalidDataError(
					kind,
					"commit",
					new Error(
						`${unsafeResultPath} is not JSON-safe (Date, Map, Set, class instances, NaN, bigint and functions cannot be stored)`,
					),
				);
			}
			const committed: StoredHandleRecord = {
				...loaded.record,
				status: "committed",
				claim_id: undefined,
				result: detach(result),
				committed_at_ms: now,
				expires_at_ms: now + kind.resultTtlMs,
				max_expires_at_ms: now + kind.resultTtlMs,
			};
			// If the result does not fit we deliberately leave the record `committing`
			// (BUSY until ttl) rather than `active`: the work already ran upstream and
			// re-running it is the worse failure. This is a provider bug (internal_error).
			assertSize(kind, committed);
			// The work already ran upstream: persisting its result is the one step
			// that must not give up on a transient storage error, so storage
			// failures are retried (with a short pause) up to the attempt budget and
			// an already-committed record is reconciled as a replay.
			let lastStorageError: unknown;
			for (let attempt = 0; attempt < COMMIT_FINALIZE_ATTEMPTS; attempt += 1) {
				let finalize: StateCasResult<unknown>;
				try {
					finalize = await storage(kind, () =>
						loaded.namespace.compareAndSet(loaded.canonical, version, committed, {
							ttl: msDuration(storageTtlMs(kind, committed, now)),
						}),
					);
				} catch (error) {
					lastStorageError = error;
					await new Promise((resolve) => {
						const timer = setTimeout(resolve, COMMIT_FINALIZE_RETRY_DELAY_MS * (attempt + 1));
						timer.unref?.();
					});
					continue;
				}
				if (finalize.ok) {
					return {
						value: { status: "committed", handle: loaded.canonical, result: detach(result) },
						outcome: "success",
					};
				}
				const current = finalize.current;
				if (!current || !isStoredHandleRecord(current.value)) break;
				if (current.value.status === "committed") {
					return {
						value: {
							status: "replayed",
							handle: loaded.canonical,
							result: detach(current.value.result) as ResultOf<K>,
						},
						outcome: "replayed",
					};
				}
				if (current.value.status !== "committing" || current.value.claim_id !== claimId) break;
				version = current.version;
			}
			if (lastStorageError !== undefined) throw lastStorageError;
			throw storageUnavailableError(
				kind,
				"could not persist the commit result after the work completed",
			);
		});
	}

	async function discard<K extends HandleKind>(kind: K, handle: string): Promise<void> {
		return await instrumented<void>(kind, "discard", async (report) => {
			const outcome = normalizeHandleInternal(kind, handle);
			if (!outcome.ok) throw normalizationError(kind, outcome);
			report(outcome.normalization, outcome.words.length);
			const namespace = resolveNamespace(kind, "discard");
			// Discard participates in the draft state machine: a record that another
			// caller has claimed for commit must not be deleted underneath it (the
			// upstream work may succeed and needs to persist its replayable result).
			// Deletion is a version-checked tombstone write; a concurrent refresh or
			// update that wins the CAS is retried against the new version, a commit
			// claim reports BUSY. The tombstone ttl is 1ms so it fits every namespace
			// limit; reads treat it as absent and the slot is reclaimed right after.
			for (let attempt = 0; attempt < DISCARD_ATTEMPTS; attempt += 1) {
				const stored = await storage(kind, () => namespace.get<unknown>(outcome.canonical));
				if (!stored) return { value: undefined, outcome: "success" };
				const record = stored.value;
				if (isStoredHandleRecord(record) && record.status === "committing") throw busyError(kind);
				const tombstone = isStoredHandleRecord(record)
					? ({ ...record, status: "discarded" } satisfies StoredHandleRecord)
					: record;
				const result = await storage(kind, () =>
					namespace.compareAndSet(outcome.canonical, stored.version, tombstone, { ttl: "1ms" }),
				);
				if (result.ok) {
					// The 1ms tombstone expires on its own (Redis PXAT / memory prune) and
					// reads treat it as absent. No follow-up delete: the state API has no
					// atomic conditional delete, and any read-then-delete could remove a
					// record re-allocated under the same key after the tombstone expired.
					return { value: undefined, outcome: "success" };
				}
				const current = result.current?.value;
				if (isStoredHandleRecord(current) && current.status === "committing") {
					throw busyError(kind);
				}
				if (!result.current) return { value: undefined, outcome: "success" };
			}
			throw busyError(kind);
		});
	}

	return { create, createRecord, read, update, commit, discard };
}

/**
 * Handle context for unit tests: memory state, a fixed connection, and an
 * optional fake clock. Share one `state` between two contexts with different
 * `request.connectionId`s to exercise bound isolation.
 */
export function createTestHandleContext(
	options: CreateTestHandleContextOptions = {},
): HandleContext {
	return createHandleContext({
		providerId: options.providerId ?? "test-provider",
		state:
			options.state ??
			createMemoryProviderRuntimeState(options.nowMs ? { now: options.nowMs } : undefined),
		request: options.request ?? { headers: {}, connectionId: "test-connection" },
		nowMs: options.nowMs,
		onTelemetry: options.onTelemetry,
	});
}
