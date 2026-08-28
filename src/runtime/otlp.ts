import { sanitizeResourceAttributes, sanitizeSpanForOutput } from "../trace-sanitization.js";
import { sanitizeDiagnosticText } from "../fixture-sanitization.js";
import type { TraceSpan } from "../types.js";

export interface OTLPExportOptions {
	endpoint: string;
	headers?: Record<string, string>;
	timeout?: number;
}

let nextTraceId = 1n;
let replayableTraceId: { signature: string; traceId: string } | null = null;

export interface OTLPExportHooks {
	onFailure?: (error: unknown) => void;
	batchId?: string;
}

function createBatchSignature(
	spans: TraceSpan[],
	resourceAttributes?: Record<string, string>,
): string {
	return JSON.stringify({
		resourceAttributes: resourceAttributes ?? null,
		spans,
	});
}

function createTraceId(signature: string): string {
	if (replayableTraceId?.signature === signature) {
		const traceId = replayableTraceId.traceId;
		replayableTraceId = null;
		return traceId;
	}

	const traceId = nextTraceId.toString(16).padStart(32, "0");
	nextTraceId += 1n;
	replayableTraceId = { signature, traceId };
	return traceId;
}

/** A trace-scoped identity used by a recorder across multiple export batches. */
export function createTraceScopedId(): string {
	const traceId = nextTraceId.toString(16).padStart(32, "0");
	nextTraceId += 1n;
	return traceId;
}

function normalizeHexId(value: string | undefined, length: number): string | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
	return normalized.padStart(length, "0").slice(-length);
}

function toAttributeValue(value: unknown): Record<string, string | number | boolean> {
	if (typeof value === "string") {
		return { stringValue: value };
	}

	if (typeof value === "number") {
		return { doubleValue: value };
	}

	if (typeof value === "boolean") {
		return { boolValue: value };
	}

	return { stringValue: String(value) };
}

export function spansToOTLP(
	spans: TraceSpan[],
	resourceAttributes?: Record<string, string>,
	traceIdOverride?: string,
): {
	resourceSpans: Array<{
		resource: {
			attributes: Array<{
				key: string;
				value: Record<string, string>;
			}>;
		};
		scopeSpans: Array<{
			scope: { name: string; version: string };
			spans: Array<{
				attributes: Array<{
					key: string;
					value: Record<string, string | number | boolean>;
				}>;
				endTimeUnixNano: string;
				kind: number;
				name: string;
				parentSpanId?: string;
				spanId: string;
				startTimeUnixNano: string;
				status: { code: number };
				traceId: string;
				events?: Array<{
					name: string;
					timeUnixNano: string;
					attributes: Array<{
						key: string;
						value: Record<string, string | number | boolean>;
					}>;
				}>;
			}>;
		}>;
	}>;
} {
	const sanitizedResourceAttributes = sanitizeResourceAttributes(resourceAttributes);
	const sanitizedSpans = spans.map((span) => sanitizeSpanForOutput(span));
	const traceId =
		traceIdOverride ??
		createTraceId(createBatchSignature(sanitizedSpans, sanitizedResourceAttributes));

	return {
		resourceSpans: [
			{
				resource: {
					attributes: Object.entries(sanitizedResourceAttributes).map(([key, value]) => ({
						key,
						value: { stringValue: value },
					})),
				},
				scopeSpans: [
					{
						scope: {
							name: "apifuse-provider-sdk",
							version: "0.1.0",
						},
						spans: sanitizedSpans.map((span) => ({
							traceId,
							spanId: normalizeHexId(span.id, 16) ?? "0000000000000001",
							parentSpanId: normalizeHexId(span.parentId, 16),
							name: span.name,
							kind: 2,
							startTimeUnixNano: String(span.startedAt * 1_000_000),
							endTimeUnixNano: String(span.endedAt * 1_000_000),
							status: { code: span.status === "ok" ? 1 : 2 },
							attributes: Object.entries(span.attributes ?? {}).map(([key, value]) => ({
								key,
								value: toAttributeValue(value),
							})),
							...(span.error !== undefined
								? {
										events: [
											{
												name: "exception",
												timeUnixNano: String(span.endedAt * 1_000_000),
												attributes: [
													{
														key: "exception.message",
														value: { stringValue: span.error },
													},
												],
											},
										],
									}
								: {}),
						})),
					},
				],
			},
		],
	};
}

export async function exportSpansOTLP(
	spans: TraceSpan[],
	options: OTLPExportOptions,
	resourceAttributes?: Record<string, string>,
	hooks?: OTLPExportHooks,
): Promise<void> {
	if (spans.length === 0) {
		return;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeout ?? 5_000);

	try {
		const response = await fetch(options.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...options.headers,
			},
			body: JSON.stringify(spansToOTLP(spans, resourceAttributes, hooks?.batchId)),
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
	} catch (error) {
		const message = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
		hooks?.onFailure?.(error);
		const context = Object.entries(sanitizeResourceAttributes(resourceAttributes))
			.filter(([key]) => ["request_id", "provider_id", "operation_id"].includes(key))
			.map(([key, value]) => `${key}=${value}`)
			.join(" ");
		console.warn(
			`[apifuse] OTLP export failed (${context || "request_id=unknown provider_id=unknown operation_id=unknown"} batch=${hooks?.batchId ?? "unknown"}):`,
			message,
		);
	} finally {
		clearTimeout(timer);
	}
}
