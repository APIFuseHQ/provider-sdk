import { AsyncLocalStorage } from "node:async_hooks";
import { sanitizeSpanNameForOutput } from "../trace-sanitization.js";
import type {
	TraceContext as BaseTraceContext,
	TraceAttributeValue,
	TraceConfig,
	TraceSpan,
} from "../types.js";
import {
	type DiagnosticRedactor,
	diagnosticStructuredRedactor,
	redactDiagnosticAttributeKey,
	copyDiagnosticAttributeTypes,
	redactedKeyAllocator,
	isRedactedKey,
	redactCriticalDiagnosticText,
	diagnosticAttributeRedactor,
	REDACTION_FAILED,
	redactDiagnosticText,
} from "./diagnostic-redactor.js";
import { exportSpansOTLP, type OTLPExportOptions } from "./otlp.js";
import { REDACTED_QUERY_VALUE } from "./request-options.js";

export type SpanAttributeValue = TraceAttributeValue;

export type Span = TraceSpan;

export interface TraceContext extends BaseTraceContext {
	getSpans(): Span[];
}

export interface CreateTraceContextOptions {
	maxSpans?: number;
	onSpan?: (span: Span) => void;
	/** Redacts diagnostic attribute values and errors before recording or calling onSpan. */
	redact?: DiagnosticRedactor;
	exportOptions?: OTLPExportOptions;
	resourceAttributes?: Record<string, string>;
	/** W3C-compatible 32-character lowercase hexadecimal trace id used for export. */
	traceId?: string;
	/**
	 * Applied to a detached copy of each span immediately before OTLP export; never touches
	 * getSpans() or onSpan. Returning nothing (or throwing) drops that export batch.
	 */
	sanitizeSpanForExport?: (span: Span) => Span | undefined;
}

type SpanHookOptions<T> = {
	attributes?: Record<string, unknown>;
	onSuccess?: (value: T) => Record<string, unknown> | undefined;
	onError?: (error: unknown) => Record<string, unknown> | undefined;
};

type PendingSpan = {
	id: string;
	name: string;
	startedAt: number;
	parentId?: string;
	sequence: number;
	attributes: Record<string, SpanAttributeValue | bigint>;
};

type CompletedSpanEntry = {
	sequence: number;
	span: Span;
	/** Set once the span has been handed to the exporter so no batch re-sends it. */
	exported: boolean;
};

const TRACE_RESOURCE_ATTRIBUTE_SANITIZER = Symbol.for(
	"@apifuse/provider-sdk/runtime/trace-resource-attribute-sanitizer",
);

type ResourceAttributesWithSanitizer = Record<string, string> & {
	[TRACE_RESOURCE_ATTRIBUTE_SANITIZER]?: (
		attributes: Record<string, string>,
	) => Record<string, string>;
};

export interface TraceRecorder {
	runSpan<T>(name: string, fn: () => Promise<T> | T, options?: SpanHookOptions<T>): Promise<T>;
}

export const TRACE_RECORDER = Symbol.for("@apifuse/provider-sdk/runtime/trace-recorder");
const TRACE_EXPORT_METADATA = Symbol.for("@apifuse/provider-sdk/runtime/trace-export-metadata");

type TraceExportMetadata = {
	update(input: { traceId?: string; resourceAttributes?: Record<string, string> }): void;
};

type InternalTraceContext = TraceContext & {
	[TRACE_RECORDER]: TraceRecorder;
	[TRACE_EXPORT_METADATA]: TraceExportMetadata;
};

function assertValidTraceId(traceId: string): void {
	if (!/^[0-9a-f]{32}$/.test(traceId) || /^0{32}$/.test(traceId)) {
		throw new TypeError("traceId must be 32 lowercase hexadecimal characters and non-zero");
	}
}

/** Updates request metadata before its pending root span completes and exports. */
export function updateTraceContextExportMetadata(
	trace: BaseTraceContext,
	input: { traceId?: string; resourceAttributes?: Record<string, string> },
): void {
	(trace as Partial<InternalTraceContext>)[TRACE_EXPORT_METADATA]?.update(input);
}

function buildOTLPExportOptions(config?: TraceConfig): OTLPExportOptions | undefined {
	if (config?.exporter !== "otlp") {
		return undefined;
	}

	const endpoint = config.otlp?.endpoint ?? config.endpoint;
	if (!endpoint) {
		return undefined;
	}

	return {
		endpoint,
		headers: config.otlp?.headers,
		timeout: config.otlp?.timeout,
	};
}

export function resolveTraceContextOptions(config?: TraceConfig): CreateTraceContextOptions {
	return {
		maxSpans: config?.maxSpans,
		onSpan: config?.onSpan,
		exportOptions: buildOTLPExportOptions(config),
	};
}

function normalizeAttributeValue(
	value: unknown,
	redact?: DiagnosticRedactor,
	retainBigints = false,
): SpanAttributeValue | bigint | undefined {
	if (typeof value === "number" || typeof value === "boolean") {
		// Typed columns are contracts: unlike string tokens, number/boolean/bigint
		// values only consult the registry at >=8 characters in string form.
		const text = String(value);
		if (text.length < 8) return value;
		const redacted = redactDiagnosticText(text, diagnosticStructuredRedactor(redact));
		return redacted === text ? value : redacted;
	}
	if (typeof value === "bigint") {
		// Bigints are not valid OTLP attribute primitives, so retain their prior
		// string normalization while still checking their diagnostic form.
		const text = String(value);
		if (text.length < 8) return retainBigints ? value : text;
		const redacted = redactDiagnosticText(text, diagnosticStructuredRedactor(redact));
		return retainBigints && redacted === text ? value : redacted;
	}

	if (value === null || value === undefined) {
		return undefined;
	}

	return redactDiagnosticText(String(value), redact);
}

function normalizeAttributes(
	attributes: Record<string, unknown> | undefined,
	redact: DiagnosticRedactor | undefined,
	retainBigints: true,
): Record<string, SpanAttributeValue | bigint>;
function normalizeAttributes(
	attributes?: Record<string, unknown>,
	redact?: DiagnosticRedactor,
): Record<string, SpanAttributeValue>;
function normalizeAttributes(
	attributes?: Record<string, unknown>,
	redact?: DiagnosticRedactor,
	retainBigints = false,
): Record<string, SpanAttributeValue | bigint> {
	if (!attributes) {
		return {};
	}

	const nextKey = redactedKeyAllocator(Object.keys(attributes));
	const normalizedEntries = Object.entries(attributes)
		.map(([key, value]) => {
			const redactedKey = isRedactedKey(key) ? key : redactDiagnosticAttributeKey(key, redact);
			const keyChanged = redactedKey !== key;
			const normalizedKey = keyChanged ? nextKey() : key;
			// Once a key changes, its original sensitivity classification is no
			// longer available to later output sanitizers. Suppress the value here.
			const normalizedValue = keyChanged
				? redactedKey === REDACTION_FAILED
					? REDACTION_FAILED
					: REDACTED_QUERY_VALUE
				: normalizeAttributeValue(value, diagnosticAttributeRedactor(key, redact), retainBigints);
			return [normalizedKey, normalizedValue] as const;
		})
		.filter(
			(entry): entry is readonly [string, SpanAttributeValue | bigint] => entry[1] !== undefined,
		);

	return copyDiagnosticAttributeTypes(attributes, Object.fromEntries(normalizedEntries));
}

function prepareResourceAttributesForExport(
	attributes: Record<string, string> | undefined,
	redact?: DiagnosticRedactor,
	sanitize?: (attributes: Record<string, string>) => Record<string, string>,
): Record<string, string> | undefined {
	if (!attributes) return undefined;
	if (sanitize) {
		const sanitized = sanitize({ ...attributes });
		if (!sanitized || typeof sanitized !== "object") {
			throw new Error("resource attribute sanitizer returned no attributes");
		}
		return sanitized;
	}
	const nextKey = redactedKeyAllocator(Object.keys(attributes));
	return Object.fromEntries(
		Object.entries(attributes).map(([key, value]) => {
			const redactedKey = isRedactedKey(key) ? key : redactDiagnosticAttributeKey(key, redact);
			const keyChanged = redactedKey !== key;
			const sanitizedKey = keyChanged ? nextKey() : sanitizeSpanNameForOutput(key);
			return [
				sanitizedKey,
				keyChanged
					? redactedKey === REDACTION_FAILED
						? REDACTION_FAILED
						: REDACTED_QUERY_VALUE
					: sanitizeSpanNameForOutput(value, diagnosticAttributeRedactor(key, redact)),
			];
		}),
	);
}

function insertCompletedSpan(
	completed: CompletedSpanEntry[],
	entry: CompletedSpanEntry,
	maxSpans: number,
): void {
	const insertAt = completed.findIndex((existingEntry) => existingEntry.sequence > entry.sequence);

	if (insertAt === -1) {
		completed.push(entry);
	} else {
		completed.splice(insertAt, 0, entry);
	}

	if (completed.length > maxSpans) {
		completed.splice(0, completed.length - maxSpans);
	}
}

/** Hands the hook a copy whose attributes are detached from the recorded span; a hook that returns nothing fails closed. */
function prepareSpanForExport(
	span: Span,
	sanitize: CreateTraceContextOptions["sanitizeSpanForExport"],
): Span {
	const copy: Span = {
		...span,
		attributes: copyDiagnosticAttributeTypes(span.attributes, { ...span.attributes }),
	};
	if (!sanitize) return copy;
	const sanitized = sanitize(copy);
	if (!sanitized || typeof sanitized !== "object") {
		throw new Error("sanitizeSpanForExport returned no span");
	}
	return sanitized;
}

export function getTraceRecorder(trace: BaseTraceContext): TraceRecorder | null {
	return (trace as Partial<InternalTraceContext>)[TRACE_RECORDER] ?? null;
}

const droppedOTLPSpans = new Map<string, number>();

/** Internal, read-only process counters; no reset can re-arm a warning. */
export function getDroppedOTLPSpanCount(reason: string): number {
	return droppedOTLPSpans.get(reason) ?? 0;
}

function warnDroppedOTLPSpans(reason: string, count: number): void {
	const previous = getDroppedOTLPSpanCount(reason);
	const total = previous + count;
	droppedOTLPSpans.set(reason, total);
	if (previous !== 0) return;
	try {
		console.warn(`[apifuse] OTLP export skipped; reason=${reason}; dropped_spans=${total}`);
	} catch {
		// Warning sinks are best-effort. The counter/latch survives a failed sink.
	}
}

export function createTraceContext(options: CreateTraceContextOptions = {}): TraceContext {
	if (options.traceId !== undefined) assertValidTraceId(options.traceId);
	const maxSpans = options.maxSpans ?? 1000;
	const completed: CompletedSpanEntry[] = [];
	const activeSpanStorage = new AsyncLocalStorage<PendingSpan | undefined>();
	let sequence = 0;
	// Export configuration (which can carry collector credentials) stays in this closure;
	// the context object handed to provider code never exposes it.
	const exportOptions = options.exportOptions;
	const resourceAttributeOptions = options.resourceAttributes as
		| ResourceAttributesWithSanitizer
		| undefined;
	const exportResourceAttributes = resourceAttributeOptions
		? { ...resourceAttributeOptions }
		: undefined;
	const exportResourceAttributeSanitizer =
		resourceAttributeOptions?.[TRACE_RESOURCE_ATTRIBUTE_SANITIZER];
	// One trace id per context so every export batch of this request shares it and
	// two processes can never mint the same id.
	let exportTraceId = options.traceId ?? crypto.randomUUID().replace(/-/g, "");
	let exportScheduled = false;

	// One pending batch per context: roots completing before the flush share it, and a span is
	// handed to the exporter exactly once, so later roots never re-send earlier spans.
	const scheduleExport = () => {
		if (!exportOptions || exportScheduled) {
			return;
		}
		exportScheduled = true;

		setImmediate(() => {
			exportScheduled = false;
			const pending = completed.filter((entry) => !entry.exported);
			for (const entry of pending) entry.exported = true;
			if (pending.length === 0) return;
			// Sanitization runs off the request path; a faulty sanitizer drops the batch, never the request.
			let spans: Span[];
			let resourceAttributes: Record<string, string> | undefined;
			try {
				spans = pending.map((entry) =>
					prepareSpanForExport(entry.span, options.sanitizeSpanForExport),
				);
				resourceAttributes = prepareResourceAttributesForExport(
					exportResourceAttributes,
					options.redact,
					exportResourceAttributeSanitizer,
				);
			} catch {
				try {
					console.warn("[apifuse] OTLP export skipped; span sanitization failed.");
				} catch {
					// A broken diagnostic sink must not escape this detached callback.
				}
				return;
			}
			// A matching trace ID cannot be replaced with non-hex text on the wire. Emit less.
			if (redactCriticalDiagnosticText(exportTraceId, options.redact) !== exportTraceId) {
				warnDroppedOTLPSpans("unverifiable_trace_id", pending.length);
				return;
			}
			void exportSpansOTLP(spans, exportOptions, resourceAttributes, exportTraceId);
		});
	};

	const recorder: TraceRecorder = {
		async runSpan(name, fn, spanOptions = {}) {
			const pendingSpan: PendingSpan = {
				id: crypto.randomUUID(),
				name: redactCriticalDiagnosticText(name, options.redact),
				startedAt: Date.now(),
				parentId: activeSpanStorage.getStore()?.id,
				sequence: sequence++,
				attributes: normalizeAttributes(spanOptions.attributes, options.redact, true),
			};

			const finalize = (
				status: Span["status"],
				extraAttributes?: Record<string, unknown>,
				error?: string,
			) => {
				const endedAt = Date.now();
				const duration = endedAt - pendingSpan.startedAt;
				const attributes = {
					...pendingSpan.attributes,
					...extraAttributes,
				};

				if (attributes.duration_ms === undefined) {
					attributes.duration_ms = duration;
				}

				const span: Span = {
					id: redactCriticalDiagnosticText(pendingSpan.id, options.redact),
					// Recheck at recording: harvest and live env reads may follow span start.
					name: redactCriticalDiagnosticText(pendingSpan.name, options.redact),
					startedAt: pendingSpan.startedAt,
					endedAt,
					duration_ms: duration,
					status,
					attributes: normalizeAttributes(attributes, options.redact),
					...(error ? { error: redactDiagnosticText(error, options.redact) } : {}),
					...(pendingSpan.parentId
						? { parentId: redactCriticalDiagnosticText(pendingSpan.parentId, options.redact) }
						: {}),
				};

				insertCompletedSpan(
					completed,
					{ sequence: pendingSpan.sequence, span, exported: false },
					maxSpans,
				);
				options.onSpan?.(span);

				if (!pendingSpan.parentId) {
					scheduleExport();
				}
			};

			return activeSpanStorage.run(pendingSpan, async () => {
				try {
					const value = await fn();
					const successAttributes = spanOptions.onSuccess?.(value);
					finalize("ok", successAttributes ?? undefined);
					return value;
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					const errorAttributes = spanOptions.onError?.(error);
					finalize("error", errorAttributes ?? undefined, errorMessage);
					throw error;
				}
			});
		},
	};

	const traceContext: InternalTraceContext = {
		span(name, fn) {
			return recorder.runSpan(name, fn);
		},
		getSpans() {
			return completed.map((entry) => ({ ...entry.span }));
		},
		[TRACE_RECORDER]: recorder,
		[TRACE_EXPORT_METADATA]: {
			update(input) {
				if (input.traceId !== undefined) {
					assertValidTraceId(input.traceId);
					exportTraceId = input.traceId;
				}
				if (input.resourceAttributes !== undefined && exportResourceAttributes) {
					Object.assign(exportResourceAttributes, input.resourceAttributes);
				}
			},
		},
	};

	return traceContext;
}
