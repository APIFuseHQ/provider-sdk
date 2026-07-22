import type {
	ProxyAttemptTelemetryEvent,
	ProxyCacheStatus,
	ProxyProtocol,
	ProxyResolutionTelemetryEvent,
	ProxyTelemetrySink,
	ProxyVendorFailoverTelemetryEvent,
	ProxyVendorName,
	SmartproxyAllocatorBodyClass,
} from "../config/loader.js";

export const PROVIDER_TELEMETRY_HEADER = "X-ApiFuse-Provider-Telemetry";

type ProviderTelemetryHeader = {
	v: 1;
	proxy?: {
		provider: ProxyVendorName;
		protocol?: ProxyProtocol;
		cacheStatus: ProxyCacheStatus;
		cacheHit: boolean;
		resolutionMs: number;
		allocatorMs?: number;
		allocatorStatus?: number;
		allocatorBodyClass?: SmartproxyAllocatorBodyClass;
		allocatorAttempts?: number;
		lockWaitMs?: number;
		redisReadMs?: number;
		redisWriteMs?: number;
		poolAgeMs?: number;
		poolExpiresInMs?: number;
		attempts: number;
		refreshes?: number;
		attemptSamples?: CompactProxyAttemptSample[];
		/** Distinct vendors attempted across the resolution chain, in order seen. */
		vendors?: ProxyVendorName[];
		/** Cross-vendor failover events (bounded). */
		failovers?: CompactVendorFailoverSample[];
	};
};

type CompactProxyAttemptSample = {
	n: number;
	a: number;
	i?: number;
	h?: string;
	o: "ok" | "error";
	c?: string;
	s?: number;
	d?: number;
};

type CompactVendorFailoverSample = {
	v: ProxyVendorName;
	nx?: ProxyVendorName;
	p: "resolution" | "transport";
	r: ProxyVendorFailoverTelemetryEvent["reason"];
	a?: number;
};

const MAX_HEADER_BYTES = 4_096;
const MAX_PROXY_ATTEMPT_SAMPLES = 24;
const MAX_PROXY_FAILOVER_SAMPLES = 12;

const CACHE_STATUS_SEVERITY: Record<ProxyCacheStatus, number> = {
	disabled: 0,
	memory_hit: 1,
	redis_hit: 2,
	soft_stale_refresh: 3,
	redis_corrupt: 4,
	redis_error: 5,
	lock_wait: 6,
	allocator: 7,
};

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
	const total = (left ?? 0) + (right ?? 0);
	return total > 0 ? total : undefined;
}

function maxOptional(left: number | undefined, right: number | undefined): number | undefined {
	const values = [left, right].filter((value): value is number => typeof value === "number");
	return values.length > 0 ? Math.max(...values) : undefined;
}

function worseStatus(left: ProxyCacheStatus, right: ProxyCacheStatus): ProxyCacheStatus {
	return CACHE_STATUS_SEVERITY[right] > CACHE_STATUS_SEVERITY[left] ? right : left;
}

function encodeBase64Url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

export class ProxyTelemetryCollector implements ProxyTelemetrySink {
	#events: ProxyResolutionTelemetryEvent[] = [];
	#attempts: ProxyAttemptTelemetryEvent[] = [];
	#failovers: ProxyVendorFailoverTelemetryEvent[] = [];

	recordProxyResolution(event: ProxyResolutionTelemetryEvent): void {
		this.#events.push({
			provider: event.provider,
			...(event.protocol ? { protocol: event.protocol } : {}),
			cacheStatus: event.cacheStatus,
			cacheHit: event.cacheHit,
			resolutionMs: Math.max(0, Math.floor(event.resolutionMs)),
			allocatorMs:
				event.allocatorMs === undefined ? undefined : Math.max(0, Math.floor(event.allocatorMs)),
			allocatorStatus:
				event.allocatorStatus === undefined
					? undefined
					: Math.max(0, Math.floor(event.allocatorStatus)),
			allocatorBodyClass: event.allocatorBodyClass,
			allocatorAttempts:
				event.allocatorAttempts === undefined
					? undefined
					: Math.max(1, Math.floor(event.allocatorAttempts)),
			lockWaitMs:
				event.lockWaitMs === undefined ? undefined : Math.max(0, Math.floor(event.lockWaitMs)),
			redisReadMs:
				event.redisReadMs === undefined ? undefined : Math.max(0, Math.floor(event.redisReadMs)),
			redisWriteMs:
				event.redisWriteMs === undefined ? undefined : Math.max(0, Math.floor(event.redisWriteMs)),
			poolAgeMs:
				event.poolAgeMs === undefined ? undefined : Math.max(0, Math.floor(event.poolAgeMs)),
			poolExpiresInMs:
				event.poolExpiresInMs === undefined
					? undefined
					: Math.max(0, Math.floor(event.poolExpiresInMs)),
			attempts: Math.max(1, Math.floor(event.attempts || 1)),
			refreshes:
				event.refreshes === undefined ? undefined : Math.max(0, Math.floor(event.refreshes)),
		});
	}

	recordProxyVendorFailover(event: ProxyVendorFailoverTelemetryEvent): void {
		if (this.#failovers.length >= MAX_PROXY_FAILOVER_SAMPLES) return;
		this.#failovers.push({
			vendor: event.vendor,
			...(event.nextVendor ? { nextVendor: event.nextVendor } : {}),
			phase: event.phase,
			reason: event.reason,
			...(event.attempt === undefined ? {} : { attempt: Math.max(0, Math.floor(event.attempt)) }),
		});
	}

	recordProxyAttempt(event: ProxyAttemptTelemetryEvent): void {
		if (this.#attempts.length >= MAX_PROXY_ATTEMPT_SAMPLES) return;
		this.#attempts.push({
			provider: event.provider,
			attempt: Math.max(1, Math.floor(event.attempt || 1)),
			...(event.poolIndex === undefined
				? {}
				: { poolIndex: Math.max(0, Math.floor(event.poolIndex)) }),
			...(event.proxyHash ? { proxyHash: event.proxyHash.slice(0, 16) } : {}),
			outcome: event.outcome === "ok" ? "ok" : "error",
			...(event.errorCode ? { errorCode: event.errorCode.slice(0, 80) } : {}),
			...(event.status === undefined ? {} : { status: Math.max(0, Math.floor(event.status)) }),
			...(event.durationMs === undefined
				? {}
				: { durationMs: Math.max(0, Math.floor(event.durationMs)) }),
		});
	}

	toHeaderValue(): string | undefined {
		const [first, ...rest] = this.#events;
		if (!first) return undefined;

		// The serving vendor/protocol is the last recorded resolution (a failed
		// vendor records first, the vendor that served records last).
		const serving = this.#events[this.#events.length - 1] ?? first;
		const vendors: ProxyVendorName[] = [];
		for (const event of this.#events) {
			if (!vendors.includes(event.provider)) vendors.push(event.provider);
		}

		const aggregate = rest.reduce<ProxyResolutionTelemetryEvent>(
			(acc, event) => ({
				provider: event.provider,
				cacheStatus: worseStatus(acc.cacheStatus, event.cacheStatus),
				cacheHit: acc.cacheHit && event.cacheHit,
				resolutionMs: acc.resolutionMs + event.resolutionMs,
				allocatorMs: sumOptional(acc.allocatorMs, event.allocatorMs),
				allocatorStatus: event.allocatorStatus ?? acc.allocatorStatus,
				allocatorBodyClass: event.allocatorBodyClass ?? acc.allocatorBodyClass,
				allocatorAttempts: sumOptional(acc.allocatorAttempts, event.allocatorAttempts),
				lockWaitMs: sumOptional(acc.lockWaitMs, event.lockWaitMs),
				redisReadMs: sumOptional(acc.redisReadMs, event.redisReadMs),
				redisWriteMs: sumOptional(acc.redisWriteMs, event.redisWriteMs),
				poolAgeMs: maxOptional(acc.poolAgeMs, event.poolAgeMs),
				poolExpiresInMs: maxOptional(acc.poolExpiresInMs, event.poolExpiresInMs),
				attempts: acc.attempts + event.attempts,
				refreshes: sumOptional(acc.refreshes, event.refreshes),
			}),
			first,
		);
		const payload: ProviderTelemetryHeader = {
			v: 1,
			proxy: {
				provider: serving.provider,
				...(serving.protocol ? { protocol: serving.protocol } : {}),
				cacheStatus: aggregate.cacheStatus,
				cacheHit: aggregate.cacheHit,
				resolutionMs: aggregate.resolutionMs,
				...(aggregate.allocatorMs !== undefined ? { allocatorMs: aggregate.allocatorMs } : {}),
				...(aggregate.allocatorStatus !== undefined
					? { allocatorStatus: aggregate.allocatorStatus }
					: {}),
				...(aggregate.allocatorBodyClass !== undefined
					? { allocatorBodyClass: aggregate.allocatorBodyClass }
					: {}),
				...(aggregate.allocatorAttempts !== undefined
					? { allocatorAttempts: aggregate.allocatorAttempts }
					: {}),
				...(aggregate.lockWaitMs !== undefined ? { lockWaitMs: aggregate.lockWaitMs } : {}),
				...(aggregate.redisReadMs !== undefined ? { redisReadMs: aggregate.redisReadMs } : {}),
				...(aggregate.redisWriteMs !== undefined ? { redisWriteMs: aggregate.redisWriteMs } : {}),
				...(aggregate.poolAgeMs !== undefined ? { poolAgeMs: aggregate.poolAgeMs } : {}),
				...(aggregate.poolExpiresInMs !== undefined
					? { poolExpiresInMs: aggregate.poolExpiresInMs }
					: {}),
				attempts: aggregate.attempts,
				...(aggregate.refreshes !== undefined ? { refreshes: aggregate.refreshes } : {}),
				...(this.#attempts.length > 0
					? {
							attemptSamples: this.#attempts.map((attempt, index) => ({
								n: index + 1,
								a: attempt.attempt,
								...(attempt.poolIndex === undefined ? {} : { i: attempt.poolIndex }),
								...(attempt.proxyHash ? { h: attempt.proxyHash } : {}),
								o: attempt.outcome,
								...(attempt.errorCode ? { c: attempt.errorCode } : {}),
								...(attempt.status === undefined ? {} : { s: attempt.status }),
								...(attempt.durationMs === undefined ? {} : { d: attempt.durationMs }),
							})),
						}
					: {}),
				...(vendors.length > 1 ? { vendors } : {}),
				...(this.#failovers.length > 0
					? {
							failovers: this.#failovers.map((failover) => ({
								v: failover.vendor,
								...(failover.nextVendor ? { nx: failover.nextVendor } : {}),
								p: failover.phase,
								r: failover.reason,
								...(failover.attempt === undefined ? {} : { a: failover.attempt }),
							})),
						}
					: {}),
			},
		};

		const encoded = encodeBase64Url(JSON.stringify(payload));
		if (encoded.length > MAX_HEADER_BYTES) return undefined;
		return encoded;
	}
}
