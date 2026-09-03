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

/** Brands a value from an SDK-declared closed string union without changing it. */
export function closedEnum<T extends string>(value: T): ClosedEnum<T> {
	return value as ClosedEnum<T>;
}

declare const TENANT_OPAQUE_KEYS: unique symbol;

/** Explicit exemption for the existing implementation-shaped cache key list. */
export type TenantOpaqueKeys = string[] & { readonly [TENANT_OPAQUE_KEYS]: true };

/** Names the deliberate tenant cache-key exemption without changing its wire value. */
export function tenantOpaqueKeys(value: string[]): TenantOpaqueKeys {
	return value as TenantOpaqueKeys;
}

/**
 * Compile-time projection for the gateway ingestion contract. Plain strings,
 * URLs, hostnames, free text, unknown values, and escape-hatch properties reduce to `never`.
 */
export type GatewayIngestible<T> = 0 extends 1 & T
	? never
	: T extends object
		? keyof T extends never
			? never
			: {
					[K in keyof T]: 0 extends 1 & T[K]
						? never
						: unknown extends T[K]
							? never
							: NonNullable<T[K]> extends number | boolean | ClosedEnum<string>
							? T[K]
							: NonNullable<T[K]> extends readonly (infer U)[]
								? 0 extends 1 & U
									? never
									: unknown extends U
										? never
										: U extends number | boolean | ClosedEnum<string>
										? T[K]
										: U extends object
											? [U] extends [GatewayIngestible<U>]
											? T[K]
											: never
										: never
							: NonNullable<T[K]> extends object
								? NonNullable<T[K]> extends GatewayIngestible<NonNullable<T[K]>>
									? T[K]
									: never
								: never;
			}
		: never;

/** Compile-time projection for tenant-visible, identity-neutral metadata. */
export type TenantNeutral<T> = 0 extends 1 & T
	? never
	: T extends object
		? {
				[K in keyof T]: K extends
					| `vendor${string}`
					| "provider"
					| "engine"
					| "model"
					| `${string}Host`
					? never
					: 0 extends 1 & T[K]
						? never
						: unknown extends T[K]
							? never
							: NonNullable<T[K]> extends TenantOpaqueKeys
							? T[K]
							: NonNullable<T[K]> extends number | boolean | ClosedEnum<string>
								? T[K]
								: NonNullable<T[K]> extends object
									? NonNullable<T[K]> extends TenantNeutral<NonNullable<T[K]>>
										? T[K]
										: never
									: never;
			}
		: never;

export interface SpanIndex {
	readonly spans: readonly Span[];
	readonly byName: ReadonlyMap<string, readonly Span[]>;
	count(name: string): number;
	durationMs(name: string): number;
}

export interface TelemetryContributor<Log extends object, Header extends object> {
	readonly key: TelemetryKey;
	toLogPayload(spans: SpanIndex): Log | undefined;
	toHeaderPayload(
		log: Log,
	): 0 extends 1 & Header
		? never
		: [Header] extends [GatewayIngestible<Header>]
			? Header | undefined
			: never;
}

export type RequestTelemetryLogPayload = {
	proxy?: ProxyTelemetryLogPayload;
} & Partial<Record<Exclude<TelemetryKey, "proxy">, object>>;

type RegisteredTelemetryContributor = {
	readonly key: TelemetryKey;
	toLogPayload(spans: SpanIndex): object | undefined;
	toHeaderPayload(log: object): object | undefined;
};

type ProviderTelemetryEnvelope = {
	v: 1;
	taxonomy: typeof PROVIDER_OBSERVABILITY_TAXONOMY_VERSION;
	truncated?: true;
} & Partial<Record<Exclude<TelemetryKey, "events">, object>>;

const MAX_HEADER_BYTES = 4_096;
const MAX_INGESTIBLE_ARRAY_LENGTH = 64;
const MAX_INGESTIBLE_OBJECT_KEYS = 32;
const MAX_INGESTIBLE_DEPTH = 4;
const INGESTIBLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
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
const warnedInvalidKeys = new Set<TelemetryKey>();

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Bounded structural defence in depth against casts and accidental free text.
 * Closed-enum brands are erased at runtime; the type-level guard is the contract,
 * while this check only enforces safe token shapes and collection bounds.
 */
export function isGatewayIngestible(value: unknown): boolean {
	const ancestors = new Set<object>();
	const visit = (candidate: unknown, depth: number): boolean => {
		if (typeof candidate === "number") return Number.isFinite(candidate);
		if (typeof candidate === "boolean") return true;
		if (typeof candidate === "string") return INGESTIBLE_TOKEN.test(candidate);
		if (candidate === null || typeof candidate !== "object") return false;
		if (depth >= MAX_INGESTIBLE_DEPTH || ancestors.has(candidate)) return false;

		if (Array.isArray(candidate)) {
			if (candidate.length > MAX_INGESTIBLE_ARRAY_LENGTH) return false;
			ancestors.add(candidate);
			const valid = candidate.every(
				(item, index) => Object.hasOwn(candidate, index) && visit(item, depth + 1),
			);
			ancestors.delete(candidate);
			return valid;
		}

		if (!isPlainRecord(candidate)) return false;
		const keys = Object.keys(candidate);
		if (keys.length > MAX_INGESTIBLE_OBJECT_KEYS) return false;
		ancestors.add(candidate);
		const valid = keys.every((key) => visit(candidate[key], depth + 1));
		ancestors.delete(candidate);
		return valid;
	};
	try {
		return visit(value, 0);
	} catch {
		return false;
	}
}

function encodeEnvelope(envelope: ProviderTelemetryEnvelope): string {
	return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function warnInvalidSibling(key: TelemetryKey): void {
	if (warnedInvalidKeys.has(key)) return;
	warnedInvalidKeys.add(key);
	try {
		console.warn(
			`[provider-sdk] Dropped invalid telemetry sibling "${key}"; contributors must return serializable log objects and bounded gateway-safe header values.`,
		);
	} catch {
		// A host-provided console must not let telemetry fail the request path.
	}
}

function isProxySink(value: unknown): value is ProxyTelemetrySink {
	if (value === null || typeof value !== "object") return false;
	try {
		return typeof Reflect.get(value, "recordProxyResolution") === "function";
	} catch {
		return false;
	}
}

/** One finalisation owner for every request-scoped telemetry contributor. */
export class RequestTelemetry {
	readonly trace: TraceContext;
	readonly contributors: Readonly<
		Partial<
			Record<
				TelemetryKey,
				{
					readonly key: TelemetryKey;
					toLogPayload(spans: SpanIndex): object | undefined;
				}
			>
		>
	>;
	readonly #registered: Partial<Record<TelemetryKey, RegisteredTelemetryContributor>> = {};
	readonly #exposed: Partial<
		Record<
			TelemetryKey,
			{
				readonly key: TelemetryKey;
				toLogPayload(spans: SpanIndex): object | undefined;
			}
		>
	> = {};
	#proxy: ProxyTelemetrySink | undefined;

	constructor(trace: TraceContext) {
		this.trace = trace;
		this.contributors = this.#exposed;
	}

	register<Log extends object, Header extends object>(
		contributor: TelemetryContributor<Log, Header> &
			(0 extends 1 & Log
				? never
				: 0 extends 1 & Header
					? never
					: [Header] extends [GatewayIngestible<Header>]
						? unknown
						: never),
	): void {
		if (this.#registered[contributor.key]) {
			throw new TypeError(`Telemetry contributor "${contributor.key}" is already registered.`);
		}
		const registered: RegisteredTelemetryContributor = {
			key: contributor.key,
			toLogPayload: (spans) => contributor.toLogPayload(spans),
			toHeaderPayload: (log) => contributor.toHeaderPayload(log as Log),
		};
		this.#registered[contributor.key] = registered;
		this.#exposed[contributor.key] = contributor;
		if (contributor.key === "proxy" && isProxySink(contributor)) this.#proxy = contributor;
	}

	get proxy(): ProxyTelemetrySink | undefined {
		return this.#proxy;
	}

	toLogPayload(): RequestTelemetryLogPayload | undefined {
		const spans = createSpanIndex(this.trace);
		const payload: Partial<Record<TelemetryKey, object>> = {};
		for (const key of Object.keys(this.#registered) as TelemetryKey[]) {
			const contributor = this.#registered[key];
			if (!contributor) continue;
			try {
				const sibling = contributor.toLogPayload(spans);
				if (sibling === undefined) continue;
				JSON.stringify(sibling);
				payload[key] = sibling;
			} catch {
				warnInvalidSibling(key);
			}
		}
		return Object.keys(payload).length > 0 ? (payload as RequestTelemetryLogPayload) : undefined;
	}

	toHeaderValue(): string | undefined {
		const spans = createSpanIndex(this.trace);
		const siblings: Partial<Record<Exclude<TelemetryKey, "events">, object>> = {};
		for (const key of HEADER_PRIORITY) {
			const contributor = this.#registered[key];
			if (!contributor) continue;
			try {
				const log = contributor.toLogPayload(spans);
				if (log === undefined) continue;
				const projected = contributor.toHeaderPayload(log);
				if (projected === undefined) continue;
				if (!isGatewayIngestible(projected)) {
					warnInvalidSibling(key);
					continue;
				}
				const serialized = JSON.stringify(projected);
				const decoded: unknown = JSON.parse(serialized);
				if (!isGatewayIngestible(decoded) || !isPlainRecord(decoded)) {
					warnInvalidSibling(key);
					continue;
				}
				siblings[key] = decoded;
			} catch {
				warnInvalidSibling(key);
			}
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
