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
};

export interface TraceRecorder {
	runSpan<T>(name: string, fn: () => Promise<T> | T, options?: SpanHookOptions<T>): Promise<T>;
}

export const TRACE_RECORDER = Symbol.for("@apifuse/provider-sdk/runtime/trace-recorder");

type InternalTraceContext = TraceContext & {
	[TRACE_RECORDER]: TraceRecorder;
	_exportOptions?: OTLPExportOptions;
	_resourceAttributes?: Record<string, string>;
};

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

export function getTraceRecorder(trace: BaseTraceContext): TraceRecorder | null {
	return (trace as Partial<InternalTraceContext>)[TRACE_RECORDER] ?? null;
}

export function createTraceContext(options: CreateTraceContextOptions = {}): TraceContext {
	const maxSpans = options.maxSpans ?? 1000;
	const completed: CompletedSpanEntry[] = [];
	const activeSpanStorage = new AsyncLocalStorage<PendingSpan | undefined>();
	let sequence = 0;
	let traceContext!: InternalTraceContext;

	const scheduleExport = () => {
		if (!traceContext._exportOptions) {
			return;
		}

		const spans = completed.map((entry) => ({ ...entry.span }));
		setImmediate(() => {
			void exportSpansOTLP(
				spans,
				traceContext._exportOptions as OTLPExportOptions,
				traceContext._resourceAttributes,
			);
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

				insertCompletedSpan(completed, { sequence: pendingSpan.sequence, span }, maxSpans);
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

	traceContext = {
		span(name, fn) {
			return recorder.runSpan(name, fn);
		},
		getSpans() {
			return completed.map((entry) => ({ ...entry.span }));
		},
		...(options.exportOptions ? { _exportOptions: options.exportOptions } : {}),
		...(options.resourceAttributes
			? { _resourceAttributes: { ...options.resourceAttributes } }
			: {}),
		[TRACE_RECORDER]: recorder,
	};

	return traceContext;
}
