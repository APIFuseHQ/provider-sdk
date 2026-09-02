import type { TraceSpan } from "../types.js";

export interface OTLPExportOptions {
	endpoint: string;
	headers?: Record<string, string>;
	timeout?: number;
}

export const OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
export const OTEL_EXPORTER_OTLP_ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT";
export const OTEL_EXPORTER_OTLP_TRACES_HEADERS = "OTEL_EXPORTER_OTLP_TRACES_HEADERS";
export const OTEL_EXPORTER_OTLP_HEADERS = "OTEL_EXPORTER_OTLP_HEADERS";
export const OTEL_SERVICE_NAME = "OTEL_SERVICE_NAME";
export const OTEL_RESOURCE_ATTRIBUTES = "OTEL_RESOURCE_ATTRIBUTES";

type EnvLike = Record<string, string | undefined>;

/**
 * `invalid` carries a fixed-vocabulary `reason` and the name of the offending
 * source so callers can warn without ever echoing the configured value.
 */
export type OTLPExportResolution =
	| { status: "resolved"; options: OTLPExportOptions }
	| { status: "unconfigured" }
	| { status: "invalid"; source: string; reason: string };

const OTLP_HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const INVALID_ENDPOINT_URL = "is not an absolute http(s) URL";
const INVALID_ENDPOINT_CREDENTIALS = `embeds credentials in the URL; send them through ${OTEL_EXPORTER_OTLP_HEADERS} instead`;
const INVALID_HEADERS = "contains an HTTP header name or value that cannot be sent";
const EXPLICIT_ENDPOINT_SOURCE = "the configured OTLP endpoint";
const EXPLICIT_HEADERS_SOURCE = "the configured OTLP headers";

function nonEmptyValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parseHttpUrl(value: string): { url: URL } | { reason: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { reason: INVALID_ENDPOINT_URL };
	}
	if (!OTLP_HTTP_PROTOCOLS.has(url.protocol)) return { reason: INVALID_ENDPOINT_URL };
	if (url.username || url.password) return { reason: INVALID_ENDPOINT_CREDENTIALS };
	return { url };
}

/** fetch() rejects malformed header names/values per request; catch that once at resolve time instead. */
function headersAreSendable(headers: Record<string, string>): boolean {
	try {
		new Headers(headers);
		return true;
	} catch {
		return false;
	}
}

/** OTEL_EXPORTER_OTLP_ENDPOINT is a base URL; traces go to `<base>/v1/traces` without doubling slashes. */
function appendTracesPath(base: URL): string {
	const endpoint = new URL(base.toString());
	endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/v1/traces`;
	return endpoint.toString();
}

function decodeListMember(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		// A literal "%" that is not a valid escape is passed through rather than dropping the entry.
		return value;
	}
}

/** Parses the OTel `key=value,key2=value2` list format shared by headers and resource attributes. */
function parseKeyValueList(value: string | undefined): Record<string, string> {
	const entries: Record<string, string> = {};
	for (const member of value?.split(",") ?? []) {
		const separator = member.indexOf("=");
		if (separator <= 0) continue;
		const key = decodeListMember(member.slice(0, separator).trim());
		if (!key) continue;
		entries[key] = decodeListMember(member.slice(separator + 1).trim());
	}
	return entries;
}

/**
 * Resolves the OTLP/HTTP export target from explicit configuration and the
 * standard OpenTelemetry environment contract. Endpoint precedence is explicit
 * config, then OTEL_EXPORTER_OTLP_TRACES_ENDPOINT verbatim, then
 * OTEL_EXPORTER_OTLP_ENDPOINT with `/v1/traces` appended. The winning candidate
 * must be an absolute http(s) URL; an invalid one fails closed instead of
 * falling through to a lower-precedence destination. Header values are never
 * surfaced in the result beyond the request options themselves.
 */
export function resolveOTLPExportOptions(
	explicit: {
		endpoint?: string;
		headers?: Record<string, string>;
		timeout?: number;
	},
	env: EnvLike = process.env,
): OTLPExportResolution {
	const candidates = [
		{ source: EXPLICIT_ENDPOINT_SOURCE, value: explicit.endpoint, appendPath: false },
		{
			source: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
			value: env[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT],
			appendPath: false,
		},
		{
			source: OTEL_EXPORTER_OTLP_ENDPOINT,
			value: env[OTEL_EXPORTER_OTLP_ENDPOINT],
			appendPath: true,
		},
	];
	const candidate = candidates
		.map((entry) => ({ ...entry, value: nonEmptyValue(entry.value) }))
		.find((entry): entry is typeof entry & { value: string } => entry.value !== undefined);
	if (!candidate) return { status: "unconfigured" };

	const parsed = parseHttpUrl(candidate.value);
	if ("reason" in parsed) {
		return { status: "invalid", source: candidate.source, reason: parsed.reason };
	}
	const endpoint = candidate.appendPath ? appendTracesPath(parsed.url) : candidate.value;

	const tracesHeaders = nonEmptyValue(env[OTEL_EXPORTER_OTLP_TRACES_HEADERS]);
	const headersSource =
		tracesHeaders !== undefined ? OTEL_EXPORTER_OTLP_TRACES_HEADERS : OTEL_EXPORTER_OTLP_HEADERS;
	const envHeaders = parseKeyValueList(
		tracesHeaders ?? nonEmptyValue(env[OTEL_EXPORTER_OTLP_HEADERS]),
	);
	if (!headersAreSendable(envHeaders)) {
		return { status: "invalid", source: headersSource, reason: INVALID_HEADERS };
	}
	const headers = { ...envHeaders, ...explicit.headers };
	if (!headersAreSendable(headers)) {
		return { status: "invalid", source: EXPLICIT_HEADERS_SOURCE, reason: INVALID_HEADERS };
	}

	return {
		status: "resolved",
		options: {
			endpoint,
			...(Object.keys(headers).length > 0 ? { headers } : {}),
			...(explicit.timeout !== undefined ? { timeout: explicit.timeout } : {}),
		},
	};
}

/**
 * Merges OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME under the caller's
 * explicit resource attributes: explicit wins per key, OTEL_SERVICE_NAME wins
 * over a `service.name` inside OTEL_RESOURCE_ATTRIBUTES.
 */
export function resolveOTLPResourceAttributes(
	explicit: Record<string, string>,
	env: EnvLike = process.env,
): Record<string, string> {
	const serviceName = nonEmptyValue(env[OTEL_SERVICE_NAME]);
	return {
		...parseKeyValueList(env[OTEL_RESOURCE_ATTRIBUTES]),
		...(serviceName ? { "service.name": serviceName } : {}),
		...explicit,
	};
}

let nextTraceId = 1n;
let replayableTraceId: { signature: string; traceId: string } | null = null;

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
	traceId?: string,
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
			}>;
		}>;
	}>;
} {
	const batchTraceId = traceId ?? createTraceId(createBatchSignature(spans, resourceAttributes));

	return {
		resourceSpans: [
			{
				resource: {
					attributes: Object.entries(resourceAttributes ?? {}).map(([key, value]) => ({
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
						spans: spans.map((span) => ({
							traceId: batchTraceId,
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
						})),
					},
				],
			},
		],
	};
}

/** Classifies an export failure without echoing endpoint, header, or message text. */
function describeExportFailure(error: unknown): string {
	if (!(error instanceof Error)) return "unknown error";
	if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" && code ? `${error.name}: ${code}` : error.name;
}

export async function exportSpansOTLP(
	spans: TraceSpan[],
	options: OTLPExportOptions,
	resourceAttributes?: Record<string, string>,
	traceId?: string,
): Promise<void> {
	if (spans.length === 0) {
		return;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeout ?? 5_000);
	let failure: string | undefined;

	try {
		const response = await fetch(options.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...options.headers,
			},
			body: JSON.stringify(spansToOTLP(spans, resourceAttributes, traceId)),
			signal: controller.signal,
		});

		if (!response.ok) {
			failure = `HTTP ${response.status}`;
		}
	} catch (error) {
		failure = describeExportFailure(error);
	} finally {
		clearTimeout(timer);
	}

	if (failure !== undefined) {
		console.warn(`[apifuse] OTLP export failed (${failure}); spans were dropped.`);
	}
}
