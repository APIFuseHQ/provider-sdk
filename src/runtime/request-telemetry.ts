import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";
import type { ProxyTelemetrySink } from "../config/loader.js";
import type { ProxyTelemetryLogPayload } from "./proxy-telemetry.js";
import type { Span, TraceContext } from "./trace.js";

export const PROVIDER_TELEMETRY_HEADER = "X-ApiFuse-Provider-Telemetry";

export type TelemetryKey =
	| "proxy"
	| "resolver"
	| "http"
	| "stealth"
	| "native"
	| "browser"
	| "ocr"
	| "stt"
	| "cache"
	| "state"
	| "events";

declare const CLOSED_ENUM: unique symbol;

/** A string from an SDK-declared, closed observability taxonomy. */
export type ClosedEnum<T extends string> = T & { readonly [CLOSED_ENUM]: true };

const closedEnumValues = new Set<string>();

/** Brands and runtime-registers a value from an SDK-declared closed string union. */
export function closedEnum<T extends string>(value: T): ClosedEnum<T> {
	closedEnumValues.add(value);
	return value as ClosedEnum<T>;
}

/**
 * Compile-time projection for the gateway ingestion contract. Plain strings,
 * URLs, hostnames, and free text reduce to `never`.
 */
export type GatewayIngestible<T> = T extends object
	? {
			[K in keyof T]: NonNullable<T[K]> extends number | boolean | ClosedEnum<string>
				? T[K]
				: NonNullable<T[K]> extends readonly (infer U)[]
					? U extends
							| number
							| boolean
							| ClosedEnum<string>
							| GatewayIngestible<U>
						? T[K]
						: never
					: NonNullable<T[K]> extends object
						? GatewayIngestible<NonNullable<T[K]>>
						: never;
		}
	: never;

/** Compile-time projection for tenant-visible, identity-neutral metadata. */
export type TenantNeutral<T> = {
	[K in keyof T]: NonNullable<T[K]> extends number | boolean | ClosedEnum<string>
		? T[K]
		: never;
} & {
	[K in keyof T as K extends
		| `vendor${string}`
		| "provider"
		| "engine"
		| "model"
		| `${string}Host`
		? K
		: never]?: never;
};

export interface SpanIndex {
	readonly spans: readonly Span[];
	readonly byName: ReadonlyMap<string, readonly Span[]>;
	count(name: string): number;
	durationMs(name: string): number;
}

export interface TelemetryContributor<Log extends object, Header extends object> {
	readonly key: TelemetryKey;
	toLogPayload(spans: SpanIndex): Log | undefined;
	toHeaderPayload(log: Log): Header extends GatewayIngestible<Header> ? Header | undefined : never;
}

export type RequestTelemetryLogPayload = {
	proxy?: ProxyTelemetryLogPayload;
} & Partial<Record<Exclude<TelemetryKey, "proxy">, object>>;

type RegisteredTelemetryContributor = {
	readonly key: TelemetryKey;
	toLogPayload(spans: SpanIndex): object | undefined;
	toHeaderPayload(log: never): object | undefined;
};

type ProviderTelemetryEnvelope = {
	v: 1;
	taxonomy: typeof PROVIDER_OBSERVABILITY_TAXONOMY_VERSION;
	truncated?: true;
} & Partial<Record<Exclude<TelemetryKey, "events">, object>>;

const MAX_HEADER_BYTES = 4_096;
const HEADER_PRIORITY = [
	"proxy",
	"resolver",
	"native",
	"http",
	"stealth",
	"browser",
	"ocr",
	"stt",
	"cache",
	"state",
] as const satisfies readonly Exclude<TelemetryKey, "events">[];
const warnedInvalidHeaderKeys = new Set<TelemetryKey>();

function createSpanIndex(trace: TraceContext): SpanIndex {
	const spans = trace.getSpans().slice();
	const mutableByName = new Map<string, Span[]>();
	for (const span of spans) {
		const named = mutableByName.get(span.name);
		if (named) named.push(span);
		else mutableByName.set(span.name, [span]);
	}
	const byName = new Map<string, readonly Span[]>(mutableByName);
	return {
		spans,
		byName,
		count(name): number {
			return byName.get(name)?.length ?? 0;
		},
		durationMs(name): number {
			return (byName.get(name) ?? []).reduce((total, span) => total + span.duration_ms, 0);
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Runtime counterpart to `GatewayIngestible`, including closed-enum registration. */
export function isGatewayIngestible(value: unknown): boolean {
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "boolean") return true;
	if (typeof value === "string") return closedEnumValues.has(value);
	if (Array.isArray(value)) return value.every(isGatewayIngestible);
	if (!isRecord(value)) return false;
	return Object.values(value).every(isGatewayIngestible);
}

function encodeEnvelope(envelope: ProviderTelemetryEnvelope): string {
	return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function warnInvalidHeaderSibling(key: TelemetryKey): void {
	if (warnedInvalidHeaderKeys.has(key)) return;
	warnedInvalidHeaderKeys.add(key);
	console.warn(
		`[provider-sdk] Dropped invalid gateway telemetry sibling "${key}"; header values must be finite numbers, booleans, registered closed enums, or arrays/objects of those values.`,
	);
}

function proxySink(
	contributor: RegisteredTelemetryContributor | undefined,
): ProxyTelemetrySink | undefined {
	if (contributor?.key !== "proxy") return undefined;
	const candidate = contributor as RegisteredTelemetryContributor & Partial<ProxyTelemetrySink>;
	return typeof candidate.recordProxyResolution === "function"
		? (candidate as unknown as ProxyTelemetrySink)
		: undefined;
}

/** One finalisation owner for every request-scoped telemetry contributor. */
export class RequestTelemetry {
	readonly trace: TraceContext;
	readonly contributors: Readonly<
		Partial<Record<TelemetryKey, TelemetryContributor<any, any>>>
	>;
	readonly proxy: ProxyTelemetrySink | undefined;

	constructor(trace: TraceContext, contributors: readonly TelemetryContributor<any, any>[]) {
		this.trace = trace;
		const registered: Partial<Record<TelemetryKey, RegisteredTelemetryContributor>> = {};
		for (const contributor of contributors) {
			if (registered[contributor.key]) {
				throw new TypeError(`Telemetry contributor "${contributor.key}" is already registered.`);
			}
			registered[contributor.key] = contributor as RegisteredTelemetryContributor;
		}
		this.contributors = Object.freeze(registered);
		this.proxy = proxySink(registered.proxy);
	}

	toLogPayload(): RequestTelemetryLogPayload | undefined {
		const spans = createSpanIndex(this.trace);
		const payload: Partial<Record<TelemetryKey, object>> = {};
		for (const key of Object.keys(this.contributors) as TelemetryKey[]) {
			const contributor = this.contributors[key] as RegisteredTelemetryContributor | undefined;
			const sibling = contributor?.toLogPayload(spans);
			if (sibling !== undefined) payload[key] = sibling;
		}
		return Object.keys(payload).length > 0 ? (payload as RequestTelemetryLogPayload) : undefined;
	}

	toHeaderValue(): string | undefined {
		const spans = createSpanIndex(this.trace);
		const siblings: Partial<Record<Exclude<TelemetryKey, "events">, object>> = {};
		for (const key of HEADER_PRIORITY) {
			const contributor = this.contributors[key] as RegisteredTelemetryContributor | undefined;
			const log = contributor?.toLogPayload(spans);
			if (log === undefined) continue;
			const projected = contributor?.toHeaderPayload(log as never);
			if (projected === undefined) continue;

			// Validate the JSON-decoded value: symbols and TypeScript brands are erased
			// on the wire, so only values registered through closedEnum() survive.
			const decoded: unknown = JSON.parse(JSON.stringify(projected));
			if (!isGatewayIngestible(decoded)) {
				warnInvalidHeaderSibling(key);
				continue;
			}
			siblings[key] = projected;
		}

		if (Object.keys(siblings).length === 0) return undefined;

		// Gateway uses permissive json.Unmarshal (unknown keys are ignored) but
		// requires v === 1. The observability taxonomy is additive and independent.
		const envelope: ProviderTelemetryEnvelope = {
			v: 1,
			taxonomy: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			...siblings,
		};
		let encoded = encodeEnvelope(envelope);
		if (encoded.length <= MAX_HEADER_BYTES) return encoded;

		for (let index = HEADER_PRIORITY.length - 1; index >= 0; index -= 1) {
			const key = HEADER_PRIORITY[index];
			if (!key || !(key in envelope)) continue;
			delete envelope[key];
			if (!HEADER_PRIORITY.some((candidate) => candidate in envelope)) return undefined;
			envelope.truncated = true;
			encoded = encodeEnvelope(envelope);
			if (encoded.length <= MAX_HEADER_BYTES) return encoded;
		}
		return undefined;
	}
}
