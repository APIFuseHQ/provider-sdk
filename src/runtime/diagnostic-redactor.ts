import { AsyncLocalStorage } from "node:async_hooks";

import {
	allSensitiveValueVariants,
	normalizePercentEscapes,
	REDACTED_QUERY_VALUE,
	type SensitiveValueVariant,
} from "./request-options.js";

export type DiagnosticRedactor = (text: string) => string;
export const REDACTION_FAILED = "[REDACTION_FAILED]";
// No supported credential source needs 1–3 character secrets. Registering these
// common tokens damages unrelated IDs and diagnostics even with token boundaries.
// Apply the same floor to static, fallback and request inventories (as self-test does).
const MINIMUM_REGISTERED_VALUE_LENGTH = 4;

/** Observer failures must never return the original diagnostic, including via ?? fallbacks. */
export function redactDiagnosticText(text: string, redact?: DiagnosticRedactor): string {
	try {
		const result = redact ? redact(text) : text;
		return typeof result === "string" ? result : REDACTION_FAILED;
	} catch {
		return REDACTION_FAILED;
	}
}

export interface DiagnosticSensitiveRegistry {
	redact: DiagnosticRedactor;
	readonly redactCritical: DiagnosticRedactor;
	readonly redactStructured: DiagnosticRedactor;
	readonly suppressed: boolean;
	has(value: string): boolean;
	add(values: readonly string[]): void;
	suppress(): void;
}

type Node = { next: Map<string, Node>; boundary?: boolean };
type Matcher = {
	exact: Node;
	folded: Node;
	hasFolded: boolean;
	canMatchPercentEncoded: boolean;
	size: number;
	minimumLength: number;
	cache: Map<string, string>;
	needles?: SensitiveValueVariant[];
	encoded?: Matcher;
};
function node(): Node {
	return { next: new Map() };
}

function compile(variants: readonly SensitiveValueVariant[]): Matcher {
	const matcher: Matcher = {
		exact: node(),
		folded: node(),
		hasFolded: false,
		// Only long values participate in encoded matching. Unreserved ASCII is
		// percent-encodable too (%6f for o); encodeURIComponent(value) === value
		// does NOT prove that residual escapes cannot conceal that credential.
		canMatchPercentEncoded: variants.some((variant) => variant.caseInsensitive),
		size: variants.length,
		minimumLength: variants.reduce(
			(minimum, variant) => Math.min(minimum, variant.value.length),
			Infinity,
		),
		cache: new Map(),
	};
	if (variants.some((variant) => !variant.caseInsensitive))
		matcher.encoded = compile(variants.filter((variant) => variant.caseInsensitive));
	// A few request credentials are cheaper as native literal searches; large
	// process-static inventories use tries to avoid per-needle scans.
	if (variants.length <= 16) {
		matcher.needles = variants.map((variant) => ({
			...variant,
			value: variant.caseInsensitive ? variant.value.toLowerCase() : variant.value,
		}));
		matcher.hasFolded = variants.some((variant) => variant.caseInsensitive);
		return matcher;
	}
	for (const variant of variants) {
		let current = variant.caseInsensitive ? matcher.folded : matcher.exact;
		if (variant.caseInsensitive) matcher.hasFolded = true;
		const value = variant.caseInsensitive ? variant.value.toLowerCase() : variant.value;
		for (let index = 0; index < value.length; index++) {
			const character = value[index];
			let child = current.next.get(character);
			if (!child) {
				child = node();
				current.next.set(character, child);
			}
			current = child;
		}
		current.boundary =
			current.boundary === undefined
				? variant.requiresTokenBoundary
				: current.boundary && variant.requiresTokenBoundary;
	}
	return matcher;
}

/** Opaque handle: callers cannot modify either of the two independently compiled matchers. */
export interface CompiledDiagnosticSensitiveValues {
	readonly kind: "compiled-diagnostic-sensitive-values";
}
const compiledValues = new WeakMap<
	CompiledDiagnosticSensitiveValues,
	{
		primary: Matcher;
		check: Matcher;
		criticalPrimary: Matcher;
		criticalCheck: Matcher;
		values: ReadonlySet<string>;
	}
>();

export function compileDiagnosticSensitiveValues(
	values: readonly string[],
): CompiledDiagnosticSensitiveValues {
	const handle: CompiledDiagnosticSensitiveValues = Object.freeze({
		kind: "compiled-diagnostic-sensitive-values",
	});
	const registered = values.filter((value) => value.length >= MINIMUM_REGISTERED_VALUE_LENGTH);
	const variants = allSensitiveValueVariants(registered);
	const primary = compile(variants),
		check = compile(variants);
	compiledValues.set(handle, {
		primary,
		check,
		criticalPrimary: primary.encoded ?? primary,
		criticalCheck: check.encoded ?? check,
		values: new Set(registered),
	});
	return handle;
}

// Outside-context reads are process lifetime data, bounded like request harvesting.
const PROCESS_VALUE_LIMIT = 1024;
const PROCESS_BYTE_LIMIT = 64 * 1024;
function createDiagnosticFallback() {
	return {
		values: new Set<string>(),
		bytes: 0,
		suppressed: false,
		version: 0,
		compiledVersion: -1,
		compiled: undefined as CompiledDiagnosticSensitiveValues | undefined,
	};
}
type DiagnosticFallback = ReturnType<typeof createDiagnosticFallback>;
const processFallback = createDiagnosticFallback();
const fallbackScopes = new AsyncLocalStorage<DiagnosticFallback>();
const processCompositions = new WeakMap<CompiledDiagnosticSensitiveValues, DiagnosticFallback>();

/**
 * Give an independent runtime/configuration evaluation its own fallback lifetime.
 * Apps created inside the scope retain that inventory, including across awaits and
 * after the callback returns. Ordinary startup/CLI reads keep the process lifetime.
 * This also lets test harnesses isolate synthetic env reads without clearing live
 * apps' credentials or weakening registration, matching, or exhaustion policies.
 */
export function withDiagnosticFallbackScope<T>(fn: () => T): T {
	return fallbackScopes.run(createDiagnosticFallback(), fn);
}

/** Re-enter the app's existing lifetime, including for detached request callbacks. */
export function withAppDiagnosticFallback<T>(
	staticValues: CompiledDiagnosticSensitiveValues,
	fn: () => T,
): T {
	return fallbackScopes.run(
		processCompositions.get(staticValues) ?? currentDiagnosticFallback(),
		fn,
	);
}

function currentDiagnosticFallback(): DiagnosticFallback {
	return fallbackScopes.getStore() ?? processFallback;
}

export function suppressProcessDiagnosticValues(): void {
	const fallback = currentDiagnosticFallback();
	if (fallback.suppressed) return;
	fallback.suppressed = true;
	console.warn(
		"[apifuse] diagnostic redaction failed closed; reason=static_registry_limit; limit=1024_entries/65536_bytes",
	);
}

export function registerProcessDiagnosticValues(values: readonly string[]): void {
	const fallback = currentDiagnosticFallback();
	if (fallback.suppressed) return;
	for (const value of values) {
		if (value.length < MINIMUM_REGISTERED_VALUE_LENGTH || fallback.values.has(value)) continue;
		const bytes = Buffer.byteLength(value);
		if (
			fallback.values.size >= PROCESS_VALUE_LIMIT ||
			fallback.bytes + bytes > PROCESS_BYTE_LIMIT
		) {
			suppressProcessDiagnosticValues();
			return;
		}
		fallback.values.add(value);
		fallback.bytes += bytes;
		fallback.version++;
	}
}

/** The app's static inventory and the shared outside-context fallback form one static part. */
export function compileProcessDiagnosticSensitiveValues(
	values: readonly string[],
): CompiledDiagnosticSensitiveValues {
	const handle = compileDiagnosticSensitiveValues(values);
	processCompositions.set(handle, currentDiagnosticFallback());
	return handle;
}

function isTokenCharacter(value: string | undefined): boolean {
	return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function matchLength(root: Node, comparable: string, original: string, start: number): number {
	let current = root;
	let length = 0;
	for (let index = start; index < comparable.length; index++) {
		const child = current.next.get(comparable[index]);
		if (!child) break;
		current = child;
		if (
			current.boundary !== undefined &&
			(!current.boundary ||
				(!isTokenCharacter(original[start - 1]) && !isTokenCharacter(original[index + 1])))
		) {
			length = index - start + 1;
		}
	}
	return length;
}

function replaceNeedles(text: string, matcher: Matcher, checkOnly: boolean): string {
	const comparable = text.includes("%") ? normalizePercentEscapes(text) : text;
	const folded = matcher.hasFolded ? comparable.toLowerCase() : comparable;
	let cursor = 0;
	let output = "";
	while (cursor < text.length) {
		let first = text.length;
		let length = 0;
		for (const variant of matcher.needles ?? []) {
			const source = variant.caseInsensitive ? folded : text;
			let index = source.indexOf(variant.value, cursor);
			while (index !== -1) {
				const end = index + variant.value.length;
				const markerStart = source.lastIndexOf("[", index);
				const withinMarker =
					markerStart !== -1 && index < markerStart + markerLength(comparable, markerStart);
				if (
					!withinMarker &&
					(!variant.requiresTokenBoundary ||
						(!isTokenCharacter(source[index - 1]) && !isTokenCharacter(source[end])))
				)
					break;
				index = source.indexOf(variant.value, index + 1);
			}
			if (index === -1) continue;
			if (checkOnly || (variant.caseInsensitive && folded.length !== text.length))
				return REDACTED_QUERY_VALUE;
			if (index < first || (index === first && variant.value.length > length)) {
				first = index;
				length = variant.value.length;
			}
		}
		if (!length) break;
		output += text.slice(cursor, first) + REDACTED_QUERY_VALUE;
		cursor = first + length;
	}
	return cursor ? output + text.slice(cursor) : text;
}

/** Literal tries have no secret-built regular expressions and no per-needle no-match scans. */
function replaceMatches(text: string, matchers: readonly Matcher[], checkOnly = false): string {
	if (matchers.length === 1 && matchers[0].needles)
		return replaceNeedles(text, matchers[0], checkOnly);
	const comparable = text.includes("%") ? normalizePercentEscapes(text) : text;
	const folded = matchers.some((matcher) => matcher.hasFolded)
		? comparable.toLowerCase()
		: comparable;
	// Unicode case folding can change offsets. Suppress the field on a folded match.
	if (folded.length !== comparable.length) {
		for (const matcher of matchers) {
			for (let index = 0; index < folded.length; index++) {
				if (matchLength(matcher.folded, folded, folded, index)) return REDACTED_QUERY_VALUE;
			}
		}
	}
	let cursor = 0;
	let output = "";
	for (let index = 0; index < text.length; index++) {
		// Sentinels are emitted constants, not evidence of a residual credential.
		const marker = markerLength(text, index);
		if (marker) {
			index += marker - 1;
			continue;
		}
		let length = 0;
		for (const matcher of matchers) {
			length = Math.max(length, matchLength(matcher.exact, text, text, index));
			if (matcher.hasFolded && folded.length === comparable.length) {
				length = Math.max(length, matchLength(matcher.folded, folded, text, index));
			}
		}
		if (!length) continue;
		if (checkOnly) return REDACTED_QUERY_VALUE;
		output += text.slice(cursor, index) + REDACTED_QUERY_VALUE;
		cursor = index + length;
		index = cursor - 1;
	}
	return cursor === 0 ? text : output + text.slice(cursor);
}

function decodePercent(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		// An unrelated malformed escape must not hide valid encoded credential text.
		return text.replace(/(?:%[\da-f]{2})+/gi, (part) => {
			try {
				return decodeURIComponent(part);
			} catch {
				return part.replace(/%([\da-f]{2})/gi, (encodedByte, hex: string) => {
					const byte = Number.parseInt(hex, 16);
					return byte < 128 ? String.fromCharCode(byte) : encodedByte;
				});
			}
		});
	}
}

function applyMatcher(text: string, matcher: Matcher): string {
	if (!matcher.size) return text;
	// ASCII cannot grow under NFC/case folding; without escapes, a shorter field
	// cannot contain any needle. Keep decoding and Unicode checks on the full path.
	if (text.length < matcher.minimumLength && !text.includes("%") && !/[\u0080-\uffff]/.test(text))
		return text;
	const cached = matcher.cache.get(text);
	if (cached !== undefined) return cached;
	const matchers = [matcher];
	const direct = replaceMatches(text, matchers);
	let result = direct;
	let normalized = direct;
	for (let round = 0; round < 3 && normalized.includes("%"); round++) {
		const decoded = decodePercent(normalized);
		if (decoded === normalized) break;
		normalized = decoded;
		if (replaceMatches(normalized, [matcher.encoded ?? matcher], true) !== normalized) {
			result = REDACTED_QUERY_VALUE;
		}
	}
	// A residual escape is unresolved after the fixed work budget: emit less,
	// if this nonempty registry can match percent-encoded credentials, even when
	// another representation matched. Both independent roles use this.
	if (matcher.canMatchPercentEncoded && /%[\da-f]{2}/i.test(normalized)) result = REDACTION_FAILED;
	const nfc = normalized.normalize("NFC");
	if (
		result !== REDACTION_FAILED &&
		nfc !== normalized &&
		replaceMatches(nfc, [matcher.encoded ?? matcher], true) !== nfc
	)
		result = REDACTED_QUERY_VALUE;
	// Matchers are immutable; additions compile a new request matcher. Independent
	// request-local caches reuse results across repeated span/resource exports. Bound
	// entry count and input size; process-static lookup data never caches request text.
	if (text.length <= 4096) {
		if (matcher.cache.size >= 256) matcher.cache.clear();
		matcher.cache.set(text, result);
	}
	return result;
}

function applyMatchers(text: string, matchers: readonly Matcher[]): string {
	let result = text;
	for (const matcher of matchers) {
		const candidate = applyMatcher(text, matcher);
		if (candidate === text) continue;
		// Static and request secrets may overlap. Scan original text independently
		// so an earlier replacement cannot hide the rest of a longer credential.
		if (result !== text && result !== candidate) return REDACTED_QUERY_VALUE;
		result = candidate;
	}
	return result;
}

/** One small mutable registry per request, composed with precompiled process-static values. */
export function createDiagnosticRedactor(
	values: readonly string[] = [],
	staticValues?: CompiledDiagnosticSensitiveValues,
): DiagnosticSensitiveRegistry {
	const compiled = staticValues ? compiledValues.get(staticValues) : undefined;
	// Share immutable lookup data only. Raw diagnostic cache keys die with this scope.
	const requestMatcher = (matcher: Matcher): Matcher => ({ ...matcher, cache: new Map() });
	const staticPrimary = compiled?.primary.size ? requestMatcher(compiled.primary) : undefined;
	const staticCheck = compiled?.check.size ? requestMatcher(compiled.check) : undefined;
	const staticCriticalPrimary = compiled?.criticalPrimary.size
		? compiled.criticalPrimary === compiled.primary
			? staticPrimary
			: requestMatcher(compiled.criticalPrimary)
		: undefined;
	const staticCriticalCheck = compiled?.criticalCheck.size
		? compiled.criticalCheck === compiled.check
			? staticCheck
			: requestMatcher(compiled.criticalCheck)
		: undefined;
	const known = new Set<string>();
	const fallback = staticValues === undefined ? undefined : processCompositions.get(staticValues);
	const has = (value: string) =>
		known.has(value) ||
		compiled?.values.has(value) === true ||
		fallback?.values.has(value) === true;
	let seenProcessVersion = -1;
	let fallbackPrimary: Matcher[] = [];
	let fallbackCheck: Matcher[] = [];
	let fallbackCriticalPrimary: Matcher[] = [];
	let fallbackCriticalCheck: Matcher[] = [];
	let requestPrimary: Matcher | undefined;
	let requestCheck: Matcher | undefined;
	let suppressed = false;
	let primary: Matcher[] = staticPrimary ? [staticPrimary] : [];
	let check: Matcher[] = staticCheck ? [staticCheck] : [];
	let criticalPrimary: Matcher[] = staticCriticalPrimary ? [staticCriticalPrimary] : [];
	let criticalCheck: Matcher[] = staticCriticalCheck ? [staticCriticalCheck] : [];
	const variants: SensitiveValueVariant[] = [];
	let uncompiled: string[] = [];
	const add = (incoming: readonly string[]) => {
		for (const value of incoming) {
			if (value.length < MINIMUM_REGISTERED_VALUE_LENGTH || has(value)) continue;
			known.add(value);
			uncompiled.push(value);
		}
	};
	const ensureCompiled = () => {
		const processChanged = fallback !== undefined && seenProcessVersion !== fallback.version;
		if (!uncompiled.length && !processChanged) return;
		if (processChanged) {
			if (fallback.compiledVersion !== fallback.version) {
				fallback.compiled = compileDiagnosticSensitiveValues([...fallback.values]);
				fallback.compiledVersion = fallback.version;
			}
			const compiledFallback = fallback.compiled && compiledValues.get(fallback.compiled);
			fallbackPrimary = compiledFallback?.primary.size
				? [requestMatcher(compiledFallback.primary)]
				: [];
			fallbackCheck = compiledFallback?.check.size ? [requestMatcher(compiledFallback.check)] : [];
			fallbackCriticalPrimary = compiledFallback?.criticalPrimary.size
				? [requestMatcher(compiledFallback.criticalPrimary)]
				: [];
			fallbackCriticalCheck = compiledFallback?.criticalCheck.size
				? [requestMatcher(compiledFallback.criticalCheck)]
				: [];
			seenProcessVersion = fallback.version;
		}
		if (uncompiled.length) {
			// Generate each value's variants once, lazily on the first actual match.
			variants.push(...allSensitiveValueVariants(uncompiled));
			uncompiled = [];
			requestPrimary = compile(variants);
			requestCheck = compile(variants);
		}
		primary = [
			...(staticPrimary ? [staticPrimary] : []),
			...fallbackPrimary,
			...(requestPrimary ? [requestPrimary] : []),
		];
		check = [
			...(staticCheck ? [staticCheck] : []),
			...fallbackCheck,
			...(requestCheck ? [requestCheck] : []),
		];
		criticalPrimary = [
			...(staticCriticalPrimary ? [staticCriticalPrimary] : []),
			...fallbackCriticalPrimary,
			...(requestPrimary ? [requestPrimary.encoded ?? requestPrimary] : []),
		];
		criticalCheck = [
			...(staticCriticalCheck ? [staticCriticalCheck] : []),
			...fallbackCriticalCheck,
			...(requestCheck ? [requestCheck.encoded ?? requestCheck] : []),
		];
	};
	add(values);
	const protect =
		(callback: DiagnosticRedactor, critical = false, freeText = !critical): DiagnosticRedactor =>
		(text) => {
			if (text === REDACTED_QUERY_VALUE || text === REDACTION_FAILED) return text;
			if ((suppressed || fallback?.suppressed) && freeText) return REDACTION_FAILED;
			ensureCompiled();
			const result = redactDiagnosticText(text, callback);
			ensureCompiled(); // A replaced callback may register a value during the call.
			if ((suppressed || fallback?.suppressed) && freeText) return REDACTION_FAILED;
			// This private matcher is a separate object from the callback's matcher,
			// survives callback replacement, and sees additions made after trace creation.
			return applyMatchers(result, critical ? criticalCheck : check) === result
				? result
				: REDACTION_FAILED;
		};
	let safeRedact = protect((text) => applyMatchers(text, primary));
	let safeCritical = protect((text) => applyMatchers(text, criticalPrimary), true);
	let safeStructured = protect((text) => applyMatchers(text, primary), false, false);
	const critical = (text: string) => safeCritical(text);
	const structured = (text: string) => safeStructured(text);
	const isSuppressed = () => suppressed || fallback?.suppressed === true;
	bindCriticalDiagnosticRedactor(safeRedact, critical, structured, isSuppressed);
	return {
		add,
		has,
		redactCritical: critical,
		redactStructured: structured,
		get suppressed() {
			return isSuppressed();
		},
		suppress() {
			suppressed = true;
		},
		get redact() {
			return safeRedact;
		},
		set redact(callback: DiagnosticRedactor) {
			safeRedact = protect(callback);
			safeCritical = protect(callback, true);
			safeStructured = protect(callback, false, false);
			bindCriticalDiagnosticRedactor(safeRedact, critical, structured, isSuppressed);
		},
	};
}

const requestRegistries = new WeakMap<object, DiagnosticSensitiveRegistry>();

/** Internal binding; neither the registry nor its values enter provider-facing context types. */
export function bindDiagnosticSensitiveRegistry(
	trace: object,
	registry: DiagnosticSensitiveRegistry,
): void {
	requestRegistries.set(trace, registry);
}

export function registerDiagnosticSensitiveValues(trace: object, values: readonly string[]): void {
	requestRegistries.get(trace)?.add(values);
}

// Policy metadata is internal: public callbacks remain backward-compatible unary functions.
const criticalRedactors = new WeakMap<DiagnosticRedactor, DiagnosticRedactor>();
const structuredRedactors = new WeakMap<DiagnosticRedactor, DiagnosticRedactor>();
const redactionSuppression = new WeakMap<DiagnosticRedactor, () => boolean>();
export function bindCriticalDiagnosticRedactor(
	redact: DiagnosticRedactor,
	critical: DiagnosticRedactor,
	structured?: DiagnosticRedactor,
	isSuppressed?: () => boolean,
): void {
	criticalRedactors.set(redact, critical);
	if (structured) structuredRedactors.set(redact, structured);
	if (isSuppressed) redactionSuppression.set(redact, isSuppressed);
}
export function isDiagnosticRedactionSuppressed(redact?: DiagnosticRedactor): boolean {
	return redact ? redactionSuppression.get(redact)?.() === true : false;
}
/** Typed values and keys still match known credentials, but never blanket suppression. */
export function diagnosticStructuredRedactor(
	redact?: DiagnosticRedactor,
): DiagnosticRedactor | undefined {
	return redact ? (structuredRedactors.get(redact) ?? redact) : undefined;
}
export function redactDiagnosticAttributeKey(key: string, redact?: DiagnosticRedactor): string {
	return redactDiagnosticText(
		key,
		diagnosticStructuredRedactor(diagnosticAttributeRedactor(key, redact)),
	);
}
export function redactCriticalDiagnosticText(text: string, redact?: DiagnosticRedactor): string {
	return redactDiagnosticText(text, redact ? (criticalRedactors.get(redact) ?? redact) : undefined);
}
export function diagnosticAttributeRedactor(
	key: string,
	redact?: DiagnosticRedactor,
): DiagnosticRedactor | undefined {
	if (CLOSED_ENUM_ATTRIBUTE_KEYS.has(key)) return diagnosticStructuredRedactor(redact);
	return CRITICAL_ATTRIBUTE_KEYS.has(key) && redact
		? (criticalRedactors.get(redact) ?? redact)
		: redact;
}
// Structured debugging contracts use only >=8-character values. Other attributes are free text.
const CRITICAL_ATTRIBUTE_KEYS = new Set([
	"request_id",
	"requestId",
	"trace_id",
	"traceId",
	"span_id",
	"spanId",
	"route",
	"operation_id",
	"operation",
	"http.status_code",
]);

// SDK-owned closed enums are contracts, like typed numbers and booleans. This
// exempts only exhaustion suppression; registered credentials still match.
const CLOSED_ENUM_ATTRIBUTE_KEYS = new Set([
	"outcome",
	"code",
	"errorClass",
	"phase",
	"cacheStatus",
	"identitySource",
	"taxonomy",
	"taxonomyVersion",
]);

// Bigints normalize to strings for OTLP. Carry their type policy through internal
// detached copies without treating arbitrary numeric-looking free text as typed.
const bigintAttributes = new WeakMap<object, ReadonlySet<string>>();
export function isDiagnosticBigintAttribute(attributes: object, key: string): boolean {
	return bigintAttributes.get(attributes)?.has(key) === true;
}
export function copyDiagnosticAttributeTypes<T extends Record<string, unknown>>(
	source: Record<string, unknown>,
	target: T,
): T {
	const keys = Object.keys(source).filter(
		(key) =>
			(typeof source[key] === "bigint" || isDiagnosticBigintAttribute(source, key)) &&
			String(source[key]) === target[key],
	);
	if (keys.length) bigintAttributes.set(target, new Set(keys));
	return target;
}

/** Reserve existing keys so independently redacted names never drop an attribute. */
export function redactedKeyAllocator(keys: Iterable<string>): () => string {
	// Snapshot the inventory now, but allocate its lookup only if a key changes.
	const inventory = [...keys];
	let reserved: Set<string> | undefined;
	let sequence = 0;
	return () => {
		reserved ??= new Set(inventory);
		let key: string;
		do {
			key = `[REDACTED#${++sequence}]`;
		} while (reserved.has(key));
		reserved.add(key);
		return key;
	};
}
export function isRedactedKey(key: string): boolean {
	return /^\[REDACTED#\d+\]$/.test(key);
}

function markerLength(text: string, index: number): number {
	if (text[index] !== "[") return 0;
	if (text.startsWith(REDACTED_QUERY_VALUE, index)) return REDACTED_QUERY_VALUE.length;
	if (text.startsWith(REDACTION_FAILED, index)) return REDACTION_FAILED.length;
	if (text.startsWith("[REDACTED#", index))
		return /^\[REDACTED#\d+\]/.exec(text.slice(index))?.[0].length ?? 0;
	return 0;
}
