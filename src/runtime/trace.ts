import { AsyncLocalStorage } from "node:async_hooks";

import type {
	TraceContext as BaseTraceContext,
	TraceAttributeValue,
	TraceConfig,
	TraceSpan,
} from "../types.js";
import { exportSpansOTLP, type OTLPExportOptions } from "./otlp.js";

export type SpanAttributeValue = TraceAttributeValue;

export type Span = TraceSpan;

export interface TraceContext extends BaseTraceContext {
	getSpans(): Span[];
}

export interface CreateTraceContextOptions {
	maxSpans?: number;
	onSpan?: (span: Span) => void;
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
	attributes: Record<string, SpanAttributeValue>;
};

type CompletedSpanEntry = {
	sequence: number;
	span: Span;
	/** Set once the span has been handed to the exporter so no batch re-sends it. */
	exported: boolean;
};

export interface TraceRecorder {
	runSpan<T>(name: string, fn: () => Promise<T> | T, options?: SpanHookOptions<T>): Promise<T>;
}

export const TRACE_RECORDER = Symbol.for("@apifuse/provider-sdk/runtime/trace-recorder");
const TRACE_EXPORT_METADATA = Symbol.for(
	"@apifuse/provider-sdk/runtime/trace-export-metadata",
);

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

function normalizeAttributeValue(value: unknown): SpanAttributeValue | undefined {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}

	if (value === null || value === undefined) {
		return undefined;
	}

	return String(value);
}

function normalizeAttributes(
	attributes?: Record<string, unknown>,
): Record<string, SpanAttributeValue> {
	if (!attributes) {
		return {};
	}

	const normalizedEntries = Object.entries(attributes)
		.map(([key, value]) => [key, normalizeAttributeValue(value)] as const)
		.filter((entry): entry is readonly [string, SpanAttributeValue] => entry[1] !== undefined);

	return Object.fromEntries(normalizedEntries);
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
	const copy: Span = { ...span, attributes: { ...span.attributes } };
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

export function createTraceContext(options: CreateTraceContextOptions = {}): TraceContext {
	if (options.traceId !== undefined) assertValidTraceId(options.traceId);
	const maxSpans = options.maxSpans ?? 1000;
	const completed: CompletedSpanEntry[] = [];
	const activeSpanStorage = new AsyncLocalStorage<PendingSpan | undefined>();
	let sequence = 0;
	// Export configuration (which can carry collector credentials) stays in this closure;
	// the context object handed to provider code never exposes it.
	const exportOptions = options.exportOptions;
	const exportResourceAttributes = options.resourceAttributes
		? { ...options.resourceAttributes }
		: undefined;
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
			try {
				spans = pending.map((entry) =>
					prepareSpanForExport(entry.span, options.sanitizeSpanForExport),
				);
			} catch {
				console.warn("[apifuse] OTLP export skipped; span sanitization failed.");
				return;
			}
			void exportSpansOTLP(spans, exportOptions, exportResourceAttributes, exportTraceId);
		});
	};

	const recorder: TraceRecorder = {
		async runSpan(name, fn, spanOptions = {}) {
			const pendingSpan: PendingSpan = {
				id: crypto.randomUUID(),
				name,
				startedAt: Date.now(),
				parentId: activeSpanStorage.getStore()?.id,
				sequence: sequence++,
				attributes: normalizeAttributes(spanOptions.attributes),
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
					...normalizeAttributes(extraAttributes),
				};

				if (attributes.duration_ms === undefined) {
					attributes.duration_ms = duration;
				}

				const span: Span = {
					id: pendingSpan.id,
					name: pendingSpan.name,
					startedAt: pendingSpan.startedAt,
					endedAt,
					duration_ms: duration,
					status,
					attributes,
					...(error ? { error } : {}),
					...(pendingSpan.parentId ? { parentId: pendingSpan.parentId } : {}),
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
