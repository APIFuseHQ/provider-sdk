import type {
	ProxyAttemptTelemetryEvent,
	ProxyCacheStatus,
	ProxyProtocol,
	ProxyResolutionTelemetryEvent,
	ProxyTelemetrySink,
	ProxyUserAgentSource,
	ProxyVendorFailoverTelemetryEvent,
	ProxyVendorName,
	SmartproxyAllocatorBodyClass,
} from "../config/loader.js";
import {
	closedEnum,
	RequestTelemetry,
	type TelemetryContributor,
} from "./request-telemetry.js";
import { createTraceContext } from "./trace.js";

export { PROVIDER_TELEMETRY_HEADER } from "./request-telemetry.js";

declare const PROXY_HASH: unique symbol;
/** 12-hex host hash used in bounded proxy attempt samples. */
export type ProxyHash = string & { readonly [PROXY_HASH]: true };

export type ProxyTelemetryResolvedPayload = {
	kind: "resolved";
	provider: ProxyVendorName;
	userAgentSource?: ProxyUserAgentSource;
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
	attemptSamples?: {
		n: number;
		a: number;
		i?: number;
		h?: string;
		o: ProxyAttemptTelemetryEvent["outcome"];
		c?: string;
		s?: number;
		d?: number;
	}[];
	/** Distinct vendors attempted across the resolution chain, in order seen. */
	vendors?: ProxyVendorName[];
	/** Cross-vendor failover events (bounded). */
	failovers?: {
		v: ProxyVendorName;
		nx?: ProxyVendorName;
		p: ProxyVendorFailoverTelemetryEvent["phase"];
		r: ProxyVendorFailoverTelemetryEvent["reason"];
		a?: number;
	}[];
};

export type ProxyTelemetryUnresolvedPayload = {
	kind: "unresolved";
	/** Distinct vendors that failed resolution or recorded a failover, in order seen. */
	vendors: ProxyVendorName[];
	cacheStatus?: ProxyCacheStatus;
	cacheHit?: boolean;
	resolutionMs?: number;
	allocatorMs?: number;
	allocatorStatus?: number;
	allocatorBodyClass?: SmartproxyAllocatorBodyClass;
	allocatorAttempts?: number;
	lockWaitMs?: number;
	redisReadMs?: number;
	redisWriteMs?: number;
	poolAgeMs?: number;
	poolExpiresInMs?: number;
	attempts?: number;
	refreshes?: number;
	failovers?: {
		v: ProxyVendorName;
		nx?: ProxyVendorName;
		p: ProxyVendorFailoverTelemetryEvent["phase"];
		r: ProxyVendorFailoverTelemetryEvent["reason"];
		a?: number;
	}[];
	attemptSamples?: {
		n: number;
		a: number;
		i?: number;
		h?: string;
		o: ProxyAttemptTelemetryEvent["outcome"];
		c?: string;
		s?: number;
		d?: number;
	}[];
};

export type ProxyTelemetryLogPayload =
	| ProxyTelemetryResolvedPayload
	| ProxyTelemetryUnresolvedPayload;

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

export class ProxyTelemetryCollector
	implements ProxyTelemetrySink, TelemetryContributor<ProxyTelemetryLogPayload, any> {
	readonly key = "proxy" as const;
	#events: ProxyResolutionTelemetryEvent[] = [];
	#attempts: ProxyAttemptTelemetryEvent[] = [];
	#failovers: ProxyVendorFailoverTelemetryEvent[] = [];
	#unresolvedVendors: ProxyVendorName[] = [];

	recordProxyResolution(event: ProxyResolutionTelemetryEvent): void {
		const outcome = event.outcome === "error" ? "error" : "ok";
		this.#events.push({
			provider: event.provider,
			outcome,
			...(event.userAgentSource ? { userAgentSource: event.userAgentSource } : {}),
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
		if (outcome === "error" && !this.#unresolvedVendors.includes(event.provider)) {
			this.#unresolvedVendors.push(event.provider);
		}
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
		if (!this.#unresolvedVendors.includes(event.vendor)) {
			this.#unresolvedVendors.push(event.vendor);
		}
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

	toLogPayload(): ProxyTelemetryLogPayload | undefined {
		const [first, ...rest] = this.#events;
		const okEvents = this.#events.filter((event) => event.outcome !== "error");
		const attemptSamples = this.#attempts.map((attempt, index) => ({
			n: index + 1,
			a: attempt.attempt,
			...(attempt.poolIndex === undefined ? {} : { i: attempt.poolIndex }),
			...(attempt.proxyHash ? { h: closedEnum(attempt.proxyHash) as unknown as ProxyHash } : {}),
			o: closedEnum(attempt.outcome),
			...(attempt.errorCode ? { c: closedEnum(attempt.errorCode) } : {}),
			...(attempt.status === undefined ? {} : { s: attempt.status }),
			...(attempt.durationMs === undefined ? {} : { d: attempt.durationMs }),
		}));
		const failovers = this.#failovers.map((failover) => ({
			v: closedEnum(failover.vendor),
			...(failover.nextVendor ? { nx: closedEnum(failover.nextVendor) } : {}),
			p: closedEnum(failover.phase),
			r: closedEnum(failover.reason),
			...(failover.attempt === undefined ? {} : { a: failover.attempt }),
		}));

		if (okEvents.length === 0) {
			if (!first && failovers.length === 0) return undefined;
			const failureEvents = this.#events.filter((event) => event.outcome === "error");
			const [firstFailure, ...remainingFailures] = failureEvents;
			const aggregate = firstFailure
				? remainingFailures.reduce<ProxyResolutionTelemetryEvent>(
						(acc, event) => ({
							provider: event.provider,
							outcome: "error",
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
						firstFailure,
					)
				: undefined;
			return {
				kind: closedEnum("unresolved"),
				vendors: this.#unresolvedVendors.map((vendor) => closedEnum(vendor)),
				...(aggregate
					? {
							cacheStatus: closedEnum(aggregate.cacheStatus),
							cacheHit: aggregate.cacheHit,
							resolutionMs: aggregate.resolutionMs,
							...(aggregate.allocatorMs !== undefined
								? { allocatorMs: aggregate.allocatorMs }
								: {}),
							...(aggregate.allocatorStatus !== undefined
								? { allocatorStatus: aggregate.allocatorStatus }
								: {}),
							...(aggregate.allocatorBodyClass !== undefined
								? { allocatorBodyClass: closedEnum(aggregate.allocatorBodyClass) }
								: {}),
							...(aggregate.allocatorAttempts !== undefined
								? { allocatorAttempts: aggregate.allocatorAttempts }
								: {}),
							...(aggregate.lockWaitMs !== undefined ? { lockWaitMs: aggregate.lockWaitMs } : {}),
							...(aggregate.redisReadMs !== undefined
								? { redisReadMs: aggregate.redisReadMs }
								: {}),
							...(aggregate.redisWriteMs !== undefined
								? { redisWriteMs: aggregate.redisWriteMs }
								: {}),
							...(aggregate.poolAgeMs !== undefined ? { poolAgeMs: aggregate.poolAgeMs } : {}),
							...(aggregate.poolExpiresInMs !== undefined
								? { poolExpiresInMs: aggregate.poolExpiresInMs }
								: {}),
							attempts: aggregate.attempts,
							...(aggregate.refreshes !== undefined ? { refreshes: aggregate.refreshes } : {}),
						}
					: {}),
				...(failovers.length > 0 ? { failovers } : {}),
				...(attemptSamples.length > 0 ? { attemptSamples } : {}),
			};
		}

		// The serving vendor/protocol is the last successful resolution.
		const serving = okEvents[okEvents.length - 1] ?? first;
		const vendors: ProxyVendorName[] = [];
		for (const event of this.#events) {
			if (!vendors.includes(event.provider)) vendors.push(event.provider);
		}

		const aggregate = rest.reduce<ProxyResolutionTelemetryEvent>(
			(acc, event) => ({
				provider: event.provider,
				userAgentSource: event.userAgentSource ?? acc.userAgentSource,
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
		return {
			kind: closedEnum("resolved"),
			provider: closedEnum(serving.provider),
			...(aggregate.userAgentSource ? { userAgentSource: closedEnum(aggregate.userAgentSource) } : {}),
			...(serving.protocol ? { protocol: closedEnum(serving.protocol) } : {}),
			cacheStatus: closedEnum(aggregate.cacheStatus),
			cacheHit: aggregate.cacheHit,
			resolutionMs: aggregate.resolutionMs,
			...(aggregate.allocatorMs !== undefined ? { allocatorMs: aggregate.allocatorMs } : {}),
			...(aggregate.allocatorStatus !== undefined
				? { allocatorStatus: aggregate.allocatorStatus }
				: {}),
			...(aggregate.allocatorBodyClass !== undefined
				? { allocatorBodyClass: closedEnum(aggregate.allocatorBodyClass) }
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
			...(attemptSamples.length > 0 ? { attemptSamples } : {}),
			...(vendors.length > 1 ? { vendors } : {}),
			...(failovers.length > 0 ? { failovers } : {}),
		};
	}

	toHeaderPayload(log: ProxyTelemetryLogPayload): ProxyTelemetryLogPayload {
		return log;
	}

	toHeaderValue(): string | undefined {
		return new RequestTelemetry(createTraceContext(), [this]).toHeaderValue();
	}
}
