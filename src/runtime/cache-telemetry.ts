import { Buffer } from "node:buffer";
import type { ProviderCacheLookupMeta } from "../types.js";
import {
	closedEnum,
	type ClosedEnum,
	type SpanIndex,
	type TelemetryContributor,
} from "./request-telemetry.js";
import { createTelemetryObserver } from "./http-telemetry-guard.js";

export type CacheTelemetrySource = "memory" | "redis" | "loader";

export type CacheTelemetrySample = {
	key: string;
	hit: boolean;
	stale: boolean;
	ageMs?: number;
	source: CacheTelemetrySource;
};

export type CacheTelemetryLogPayload = {
	telemetryFailed?: true;
	lookups: number;
	hits: number;
	stale: number;
	misses: number;
	writes: number;
	loaderErrors: number;
	writeErrors: number;
	source: { memory: number; redis: number; loader: number };
	redisFallbacks: number;
	redisMode: ClosedEnum<"not_configured" | "configured" | "degraded">;
	/** Successful Redis commands, including reads, writes, and deletes; memory-only work counts zero. */
	redisRoundTrips: number;
	ageMs?: { p50: number; max: number };
	samples: CacheTelemetrySample[];
	dropped: number;
};

export type CacheTelemetryHeaderPayload = Omit<
	CacheTelemetryLogPayload,
	"samples" | "ageMs" | "telemetryFailed"
> & {
	ageP50?: number;
	ageMax?: number;
};

export interface CacheTelemetrySink {
	markTelemetryFailed?(): void;
	setRedisConfigured?(configured: boolean): void;
	recordLookup(meta: ProviderCacheLookupMeta): void;
	recordWrite(): void;
	recordLoaderError?(): void;
	recordWriteError?(): void;
	recordRedisFallback(): void;
	recordRedisRoundTrip?(): void;
}

const cacheTelemetryBindings = new WeakMap<object, CacheTelemetrySink>();

/** Internal construction binding; keeps sink plumbing off ProviderCacheOptions. */
export function bindCacheTelemetry<T extends object>(
	options: T,
	sink: CacheTelemetrySink | undefined,
): T {
	if (sink) cacheTelemetryBindings.set(options, sink);
	return options;
}

/** Internal lookup used only by the cache factory. */
export function cacheTelemetryFor(options: object): CacheTelemetrySink | undefined {
	return cacheTelemetryBindings.get(options);
}

export function guardCacheTelemetry(sink: CacheTelemetrySink | undefined): CacheTelemetrySink {
	const observe = createTelemetryObserver(sink);
	return {
		setRedisConfigured: (configured) => observe(() => sink?.setRedisConfigured?.(configured)),
		recordLookup: (meta) => observe(() => sink?.recordLookup(meta)),
		recordWrite: () => observe(() => sink?.recordWrite()),
		recordLoaderError: () => observe(() => sink?.recordLoaderError?.()),
		recordWriteError: () => observe(() => sink?.recordWriteError?.()),
		recordRedisFallback: () => observe(() => sink?.recordRedisFallback()),
		recordRedisRoundTrip: () => observe(() => sink?.recordRedisRoundTrip?.()),
	};
}

const MAX_SAMPLES = 24;
const MAX_TEXT = 300;

function integer(value: number): number {
	return Number.isFinite(value)
		? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
		: Number.MAX_SAFE_INTEGER;
}

function add(a: number, b: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, integer(a) + integer(b));
}

function boundedText(value: string, redact?: (text: string) => string): string {
	let result: string;
	try {
		result = redact?.(value) ?? value;
	} catch {
		result = "[REDACTION_FAILED]";
	}
	const length = Math.min(result.length, MAX_TEXT);
	const units = Buffer.alloc(length * 2);
	for (let index = 0; index < length; index += 1)
		units.writeUInt16LE(result.charCodeAt(index), index * 2);
	return units.toString("utf16le");
}

export class CacheTelemetryCollector
	implements
		TelemetryContributor<CacheTelemetryLogPayload, CacheTelemetryHeaderPayload>,
		CacheTelemetrySink
{
	readonly key = "cache" as const;
	readonly #redact?: (text: string) => string;
	#telemetryFailed = false;
	#lookups = 0;
	#hits = 0;
	#stale = 0;
	#misses = 0;
	#writes = 0;
	#loaderErrors = 0;
	#writeErrors = 0;
	#source = { memory: 0, redis: 0, loader: 0 };
	#redisFallbacks = 0;
	#configured: "not_configured" | "configured" | "degraded";
	#redisRoundTrips = 0;
	#ages: number[] = [];
	#maxAge = 0;
	#samples: CacheTelemetrySample[] = [];
	#dropped = 0;

	constructor(options: { redact?: (text: string) => string } = {}) {
		this.#redact = options.redact;
		this.#configured = "not_configured";
	}
	setRedisConfigured(configured: boolean): void {
		if (configured && this.#configured === "not_configured") this.#configured = "configured";
	}
	markTelemetryFailed(): void {
		this.#telemetryFailed = true;
	}

	recordLookup(meta: ProviderCacheLookupMeta): void {
		if (!["memory", "redis", "loader"].includes(meta.source)) {
			this.#telemetryFailed = true;
			return;
		}
		this.#lookups = add(this.#lookups, 1);
		if (meta.hit) this.#hits = add(this.#hits, 1);
		else this.#misses = add(this.#misses, 1);
		if (meta.stale) this.#stale = add(this.#stale, 1);
		this.#source[meta.source] = add(this.#source[meta.source], 1);
		if (meta.source === "redis" && this.#configured === "not_configured")
			this.#configured = "configured";
		if (meta.ageMs !== undefined) {
			const age = integer(meta.ageMs);
			if (this.#ages.length < MAX_SAMPLES) this.#ages.push(age);
			this.#maxAge = Math.max(this.#maxAge, age);
		}
		if (this.#samples.length < MAX_SAMPLES) {
			this.#samples.push({
				key: boundedText(meta.key, this.#redact),
				hit: meta.hit,
				stale: meta.stale,
				...(meta.ageMs === undefined ? {} : { ageMs: integer(meta.ageMs) }),
				source: meta.source,
			});
		} else this.#dropped = add(this.#dropped, 1);
	}

	recordWrite(): void {
		this.#writes = add(this.#writes, 1);
	}
	recordLoaderError(): void {
		this.#loaderErrors = add(this.#loaderErrors, 1);
	}
	recordWriteError(): void {
		this.#writeErrors = add(this.#writeErrors, 1);
	}

	recordRedisFallback(): void {
		this.#redisFallbacks = add(this.#redisFallbacks, 1);
		this.#configured = "degraded";
	}

	recordRedisRoundTrip(): void {
		this.#redisRoundTrips = add(this.#redisRoundTrips, 1);
	}

	toLogPayload(_spans: SpanIndex): CacheTelemetryLogPayload | undefined {
		if (
			this.#lookups === 0 &&
			this.#writes === 0 &&
			this.#redisFallbacks === 0 &&
			!this.#telemetryFailed
		)
			return undefined;
		const sorted = [...this.#ages].sort((a, b) => a - b);
		const p50 = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : undefined;
		return {
			...(this.#telemetryFailed ? { telemetryFailed: true as const } : {}),
			lookups: this.#lookups,
			hits: this.#hits,
			stale: this.#stale,
			misses: this.#misses,
			writes: this.#writes,
			loaderErrors: this.#loaderErrors,
			writeErrors: this.#writeErrors,
			source: { ...this.#source },
			redisFallbacks: this.#redisFallbacks,
			redisMode: closedEnum(this.#configured),
			redisRoundTrips: this.#redisRoundTrips,
			...(p50 === undefined ? {} : { ageMs: { p50, max: this.#maxAge } }),
			samples: this.#samples.map((sample) => ({ ...sample })),
			dropped: this.#dropped,
		};
	}

	toHeaderPayload(log: CacheTelemetryLogPayload): CacheTelemetryHeaderPayload {
		return {
			lookups: log.lookups,
			hits: log.hits,
			stale: log.stale,
			misses: log.misses,
			writes: log.writes,
			loaderErrors: log.loaderErrors,
			writeErrors: log.writeErrors,
			source: {
				memory: log.source.memory,
				redis: log.source.redis,
				loader: log.source.loader,
			},
			redisFallbacks: log.redisFallbacks,
			redisMode: log.redisMode,
			redisRoundTrips: log.redisRoundTrips,
			...(log.ageMs ? { ageP50: log.ageMs.p50, ageMax: log.ageMs.max } : {}),
			dropped: log.dropped,
		};
	}
}
