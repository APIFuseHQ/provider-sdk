import { AsyncResource } from "node:async_hooks";

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

export type OTLPResourceResolution = {
	attributes: Record<string, string>;
	/** Environment variables whose whole value was discarded because it could not be parsed. */
	discarded: string[];
};

const OTLP_HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const INVALID_ENDPOINT_URL = "is not an absolute http(s) URL";
const INVALID_ENDPOINT_CREDENTIALS = `embeds credentials in the URL; send them through ${OTEL_EXPORTER_OTLP_HEADERS} instead`;
const INVALID_HEADERS = "contains an HTTP header name or value that cannot be sent";
const EXPLICIT_ENDPOINT_SOURCE = "the configured OTLP endpoint";
const EXPLICIT_HEADERS_SOURCE = "the configured OTLP headers";

/** Only an unset or empty variable is absent (OTel env rules); whitespace is a value and is validated as one. */
function presentValue(value: string | undefined): string | undefined {
	return value === undefined || value === "" ? undefined : value;
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

/** Appends the traces signal path to a base URL, keeping every configured path byte and adding only the separator. */
function appendTracesPath(base: URL): string {
	const endpoint = new URL(base.toString());
	const separator = endpoint.pathname.endsWith("/") ? "" : "/";
	endpoint.pathname = `${endpoint.pathname}${separator}v1/traces`;
	return endpoint.toString();
}

/** HTTP header names are case-insensitive: a later source replaces an earlier one whatever its casing. */
function mergeHeaders(
	...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
	const merged = new Map<string, [string, string]>();
	for (const source of sources) {
		for (const [key, value] of Object.entries(source ?? {})) {
			merged.set(key.toLowerCase(), [key, value]);
		}
	}
	return Object.fromEntries(merged.values());
}

function decodeHeaderMember(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		// A literal "%" that is not a valid escape is passed through rather than dropping the header.
		return value;
	}
}

/** Baggage-style header list: malformed members are skipped and an invalid percent-escape keeps the raw text. */
function parseHeaderList(value: string | undefined): Record<string, string> {
	const entries: Array<[string, string]> = [];
	for (const member of value?.split(",") ?? []) {
		const separator = member.indexOf("=");
		if (separator <= 0) continue;
		const key = decodeHeaderMember(member.slice(0, separator).trim());
		if (!key) continue;
		entries.push([key, decodeHeaderMember(member.slice(separator + 1).trim())]);
	}
	return mergeHeaders(Object.fromEntries(entries));
}

/**
 * OTel resource list: a member without `key=value` or with an invalid
 * percent-escape discards the whole value, as the Resource SDK spec requires,
 * so a partially malformed variable can never export a wrong identity.
 */
function parseResourceAttributeList(value: string): Record<string, string> | undefined {
	const entries: Array<[string, string]> = [];
	for (const member of value.split(",")) {
		// Every member must be `key=value`; an empty member (`a=b,,c=d`, a trailing comma, a
		// whitespace-only value) is a parse error and discards the whole variable.
		const separator = member.indexOf("=");
		if (separator <= 0) return undefined;
		try {
			const key = decodeURIComponent(member.slice(0, separator).trim());
			if (!key) return undefined;
			entries.push([key, decodeURIComponent(member.slice(separator + 1).trim())]);
		} catch {
			return undefined;
		}
	}
	return Object.fromEntries(entries);
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
		.map((entry) => ({ ...entry, value: presentValue(entry.value) }))
		.find((entry): entry is typeof entry & { value: string } => entry.value !== undefined);
	if (!candidate) return { status: "unconfigured" };

	const parsed = parseHttpUrl(candidate.value);
	if ("reason" in parsed) {
		return { status: "invalid", source: candidate.source, reason: parsed.reason };
	}
	const endpoint = candidate.appendPath ? appendTracesPath(parsed.url) : candidate.value;

	const tracesHeaders = presentValue(env[OTEL_EXPORTER_OTLP_TRACES_HEADERS]);
	const headersSource =
		tracesHeaders !== undefined ? OTEL_EXPORTER_OTLP_TRACES_HEADERS : OTEL_EXPORTER_OTLP_HEADERS;
	const envHeaders = parseHeaderList(
		tracesHeaders ?? presentValue(env[OTEL_EXPORTER_OTLP_HEADERS]),
	);
	if (!headersAreSendable(envHeaders)) {
		return { status: "invalid", source: headersSource, reason: INVALID_HEADERS };
	}
	const headers = mergeHeaders(envHeaders, explicit.headers);
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
 * over a `service.name` inside OTEL_RESOURCE_ATTRIBUTES. An unparseable
 * OTEL_RESOURCE_ATTRIBUTES value is discarded as a unit and reported in `discarded`.
 */
export function resolveOTLPResourceAttributes(
	explicit: Record<string, string>,
	env: EnvLike = process.env,
): OTLPResourceResolution {
	const discarded: string[] = [];
	const resourceList = presentValue(env[OTEL_RESOURCE_ATTRIBUTES]);
	const resourceAttributes =
		resourceList === undefined ? {} : parseResourceAttributeList(resourceList);
	if (resourceAttributes === undefined) discarded.push(OTEL_RESOURCE_ATTRIBUTES);
	const serviceName = presentValue(env[OTEL_SERVICE_NAME]);
	return {
		attributes: {
			...resourceAttributes,
			...(serviceName ? { "service.name": serviceName } : {}),
			...explicit,
		},
		discarded,
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

type ExportTransport = typeof fetch;

/**
 * Binds the transport that carries collector credentials.
 *
 * Trust model: in production the provider's own entry file is the process entry, so
 * provider-controlled code (its earlier imports, a `bun --preload`, or a bunfig preload) can run
 * before any SDK module evaluates; capture timing alone therefore cannot establish trust. On Bun
 * the native fetch is also exposed as `Bun.fetch`, and both the `Bun` global and its `fetch`
 * property are read-only and non-configurable, so no JavaScript in the process can replace that
 * reference at any point. The engine binds it here and never consults `globalThis.fetch`.
 *
 * Residual assumptions: on a runtime without `Bun.fetch` the fallback is `globalThis.fetch` as
 * seen when this module first evaluates, which code that runs earlier in the same process can
 * have replaced (or can have forged a `Bun` global). Code with process authority can also patch
 * other builtins on this path (Map, Object.fromEntries, Headers, AbortController, setTimeout),
 * install module loader plugins, or reach the internal test seam below by importing this module
 * by path; an in-process boundary cannot defend against any of that. The CLI flows load provider
 * modules only after the engine has loaded.
 */
function bindEngineTransport(): ExportTransport {
	const bunFetch: unknown = typeof Bun !== "undefined" ? Bun.fetch : undefined;
	return typeof bunFetch === "function" ? (bunFetch as ExportTransport) : globalThis.fetch;
}

const engineTransport: ExportTransport = bindEngineTransport();
let transport: ExportTransport = engineTransport;

// Deliveries run inside this engine-owned async scope, created while the module evaluates, so a
// batch admitted from another batch's completion never inherits that request's async context.
// (The scope snapshots the async context active at module load: empty under the static imports
// the engine uses.)
const exportScope = new AsyncResource("apifuse.otlp.export");

/** Process-wide bounds so a collector outage can never turn into unbounded sockets, memory, or log volume. */
export const OTLP_EXPORT_LIMITS = {
	maxInFlight: 4,
	maxQueued: 64,
	maxAttempts: 3,
	retryBaseDelayMs: 200,
	retryMaxDelayMs: 2_000,
	warningCooldownMs: 10_000,
} as const;

const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);
const TIMEOUT_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);
/** Certificate failures do not clear up on retry; they are reported once and the batch dropped. */
const CERTIFICATE_ERROR_CODES = new Set([
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"ERR_TLS_CERT_ALTNAME_INVALID",
]);
/** Only these system codes are ever echoed; anything else is reported as a plain network error. */
const NETWORK_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ECONNABORTED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"ConnectionRefused",
	"ConnectionClosed",
	"FailedToOpenSocket",
]);

type ExportOutcome = { ok: true } | { ok: false; reason: string; retryable: boolean };

type ExportBatch = {
	body: string;
	options: OTLPExportOptions;
	settle: () => void;
};

const queue: ExportBatch[] = [];
let inFlight = 0;
let lastWarningAt = Number.NEGATIVE_INFINITY;
let suppressedDrops = 0;
let suppressedFlush: ReturnType<typeof setTimeout> | undefined;

function errorCode(error: unknown): string | undefined {
	const own = (error as { code?: unknown } | null)?.code;
	if (typeof own === "string") return own;
	const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
	return typeof cause === "string" ? cause : undefined;
}

/** Maps a transport failure onto a fixed vocabulary; nothing from the error object is interpolated. */
function describeExportFailure(error: unknown): { reason: string; retryable: boolean } {
	if (error instanceof Error && TIMEOUT_ERROR_NAMES.has(error.name)) {
		return { reason: "timeout", retryable: true };
	}
	const code = errorCode(error);
	if (code !== undefined && CERTIFICATE_ERROR_CODES.has(code)) {
		return { reason: `certificate error: ${code}`, retryable: false };
	}
	return {
		reason:
			code !== undefined && NETWORK_ERROR_CODES.has(code)
				? `network error: ${code}`
				: "network error",
		retryable: true,
	};
}

function batchesLabel(count: number): string {
	return `${count} ${count === 1 ? "batch" : "batches"}`;
}

/** Emits the count of drops suppressed during a cooldown once it ends, so a burst is never under-reported. */
function flushSuppressedDrops(): void {
	suppressedFlush = undefined;
	if (suppressedDrops === 0) return;
	const dropped = suppressedDrops;
	suppressedDrops = 0;
	lastWarningAt = Date.now();
	console.warn(
		`[apifuse] OTLP export: ${batchesLabel(dropped)} more dropped since the last warning.`,
	);
}

function noteDroppedBatch(reason: string): void {
	const now = Date.now();
	const sinceLastWarning = now - lastWarningAt;
	if (sinceLastWarning < OTLP_EXPORT_LIMITS.warningCooldownMs) {
		suppressedDrops += 1;
		if (suppressedFlush === undefined) {
			suppressedFlush = setTimeout(
				flushSuppressedDrops,
				OTLP_EXPORT_LIMITS.warningCooldownMs - sinceLastWarning,
			);
			suppressedFlush.unref?.();
		}
		return;
	}
	lastWarningAt = now;
	console.warn(`[apifuse] OTLP export failed (${reason}); ${batchesLabel(1)} dropped.`);
}

async function sendBatch(batch: ExportBatch): Promise<ExportOutcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), batch.options.timeout ?? 5_000);
	try {
		const response = await transport(batch.options.endpoint, {
			method: "POST",
			headers: mergeHeaders(batch.options.headers, { "Content-Type": "application/json" }),
			body: batch.body,
			signal: controller.signal,
		});
		// The reply body is not needed; cancel it while the abort timer still bounds the socket.
		try {
			await response.body?.cancel();
		} catch {
			// A body that cannot be cancelled does not change the outcome of the export.
		}
		if (response.ok) return { ok: true };
		return {
			ok: false,
			reason: `HTTP ${response.status}`,
			retryable: RETRYABLE_STATUSES.has(response.status),
		};
	} catch (error) {
		return { ok: false, ...describeExportFailure(error) };
	} finally {
		clearTimeout(timer);
	}
}

/** Exponential backoff between attempts: base * 2^(attempt-1), capped at the maximum delay. */
export function retryDelayMs(attempt: number): number {
	return Math.min(
		OTLP_EXPORT_LIMITS.retryBaseDelayMs * 2 ** (attempt - 1),
		OTLP_EXPORT_LIMITS.retryMaxDelayMs,
	);
}

async function deliverBatch(batch: ExportBatch): Promise<void> {
	for (let attempt = 1; ; attempt += 1) {
		const outcome = await sendBatch(batch);
		if (outcome.ok) return;
		if (!outcome.retryable || attempt >= OTLP_EXPORT_LIMITS.maxAttempts) {
			noteDroppedBatch(
				attempt > 1 ? `${outcome.reason} after ${attempt} attempts` : outcome.reason,
			);
			return;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, retryDelayMs(attempt)).unref?.();
		});
	}
}

function pumpQueue(): void {
	while (inFlight < OTLP_EXPORT_LIMITS.maxInFlight && queue.length > 0) {
		const batch = queue.shift();
		if (!batch) return;
		inFlight += 1;
		void exportScope
			.runInAsyncScope(() => deliverBatch(batch))
			.finally(() => {
				inFlight -= 1;
				batch.settle();
				pumpQueue();
			});
	}
}

/**
 * Queues one export batch behind the process-wide concurrency and queue bounds.
 * Resolves once the batch has been delivered or dropped; it never rejects, so
 * callers can fire and forget.
 */
export function exportSpansOTLP(
	spans: TraceSpan[],
	options: OTLPExportOptions,
	resourceAttributes?: Record<string, string>,
	traceId?: string,
): Promise<void> {
	if (spans.length === 0) {
		return Promise.resolve();
	}
	if (queue.length >= OTLP_EXPORT_LIMITS.maxQueued) {
		noteDroppedBatch("export queue is full");
		return Promise.resolve();
	}
	let body: string;
	try {
		body = JSON.stringify(spansToOTLP(spans, resourceAttributes, traceId));
	} catch {
		noteDroppedBatch("span serialization failed");
		return Promise.resolve();
	}
	return new Promise<void>((settle) => {
		queue.push({ body, options, settle });
		pumpQueue();
	});
}

/** Test seam (not re-exported from any package entry point): substitute the engine transport. */
export function swapOTLPTransportForTests(next?: ExportTransport): void {
	transport = next ?? engineTransport;
}

/** Test seam: drop queued batches, clear the warning throttle, and restore the engine transport. */
export function resetOTLPExportForTests(): void {
	for (const batch of queue.splice(0)) batch.settle();
	if (suppressedFlush !== undefined) clearTimeout(suppressedFlush);
	suppressedFlush = undefined;
	lastWarningAt = Number.NEGATIVE_INFINITY;
	suppressedDrops = 0;
	transport = engineTransport;
}
