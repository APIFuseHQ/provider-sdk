import { createHash } from "node:crypto";

import type {
	ProxyAttemptTelemetryEvent,
	ProxyCacheStatus,
	ProxyProtocol,
	ProxyResolutionTelemetryEvent,
	ProxyTelemetrySink,
	ProxyUserAgentSource,
	ProxyVendorFailoverTelemetryEvent,
	ProxyVendorName,
} from "../config/loader.js";
import type {
	ProxyVendorSelectionObservation,
	ProxyVendorSelectionReason,
	ProxyVendorSelectionSink,
	ProxyVendorState,
} from "./proxy-vendor-selector-adaptive.js";
import {
	closedEnum,
	RequestTelemetry,
	type ClosedEnum,
	type TelemetryContributor,
} from "./request-telemetry.js";
import { createTraceContext } from "./trace.js";

export { PROVIDER_TELEMETRY_HEADER } from "./request-telemetry.js";

/**
 * `proxyHash` of one attempt: a bounded, non-reversible identifier of its
 * egress. It covers the proxy scheme and host and, when the URL carries one,
 * the vendor session id: a gateway vendor serves every session from one host
 * (smartproxy on a fixed port), so the session is what tells two attempts
 * apart. Credentials never enter the hash.
 */
export function proxyAttemptHash(
	proxyUrl: string | undefined,
	sessionId?: string,
): string | undefined {
	if (!proxyUrl) return undefined;
	let endpoint: string;
	try {
		const parsed = new URL(proxyUrl);
		endpoint = `${parsed.protocol}//${parsed.host}`;
	} catch {
		return createHash("sha256").update(proxyUrl).digest("hex").slice(0, 12);
	}
	return createHash("sha256")
		.update(sessionId ? `${endpoint}#${sessionId}` : endpoint)
		.digest("hex")
		.slice(0, 12);
}

declare const PROXY_HASH: unique symbol;
/** Bounded hexadecimal host hash used in proxy attempt samples. */
export type ProxyHash = ClosedEnum<string> & { readonly [PROXY_HASH]: true };

/** One transport attempt; `v` is the vendor that carried it. */
export type ProxyTelemetryAttemptSample = {
	n: number;
	a: number;
	v?: ProxyVendorName;
	h?: string;
	o: ProxyAttemptTelemetryEvent["outcome"];
	c?: string;
	s?: number;
	d?: number;
};

export type ProxyTelemetrySelection = {
	kind: ProxyVendorSelectionObservation["kind"];
	reason: ProxyVendorSelectionReason;
};

/** `s`: breaker state, `e`: consecutive ejections. */
export type ProxyTelemetryVendorState = {
	v: ProxyVendorName;
	s: ProxyVendorState;
	e: number;
};

export type ProxyTelemetryResolvedPayload = {
	kind: "resolved";
	provider: ProxyVendorName;
	userAgentSource?: ProxyUserAgentSource;
	protocol?: ProxyProtocol;
	cacheStatus: ProxyCacheStatus;
	cacheHit: boolean;
	resolutionMs: number;
	attempts: number;
	attemptSamples?: ProxyTelemetryAttemptSample[];
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
	/** Why the adaptive selector routed the request's last attempt where it did. */
	selection?: ProxyTelemetrySelection;
	/** Adaptive selector state of every vendor in the chain at that selection. */
	vendorStates?: ProxyTelemetryVendorState[];
};

export type ProxyTelemetryUnresolvedPayload = {
	kind: "unresolved";
	/** Distinct vendors that failed resolution or recorded a failover, in order seen. */
	vendors: ProxyVendorName[];
	cacheStatus?: ProxyCacheStatus;
	cacheHit?: boolean;
	resolutionMs?: number;
	attempts?: number;
	failovers?: {
		v: ProxyVendorName;
		nx?: ProxyVendorName;
		p: ProxyVendorFailoverTelemetryEvent["phase"];
		r: ProxyVendorFailoverTelemetryEvent["reason"];
		a?: number;
	}[];
	attemptSamples?: ProxyTelemetryAttemptSample[];
	selection?: ProxyTelemetrySelection;
	vendorStates?: ProxyTelemetryVendorState[];
};

export type ProxyTelemetryLogPayload =
	| ProxyTelemetryResolvedPayload
	| ProxyTelemetryUnresolvedPayload;

/**
 * Concrete gateway-safe projection of the unchanged proxy sibling. The gateway
 * reads every field as optional; the allocator-era fields (allocator timings,
 * lock wait, pool age, pool index `i`) are no longer emitted and persist as
 * NULL, as they already did for NodeMaven.
 */
export type ProxyTelemetryHeaderPayload = {
	kind: ClosedEnum<"resolved" | "unresolved">;
	provider?: ClosedEnum<ProxyVendorName>;
	userAgentSource?: ClosedEnum<ProxyUserAgentSource>;
	protocol?: ClosedEnum<ProxyProtocol>;
	cacheStatus?: ClosedEnum<ProxyCacheStatus>;
	cacheHit?: boolean;
	resolutionMs?: number;
	attempts?: number;
	attemptSamples?: {
		n: number;
		a: number;
		v?: ClosedEnum<ProxyVendorName>;
		h?: ProxyHash;
		o: ClosedEnum<ProxyAttemptTelemetryEvent["outcome"]>;
		c?: ClosedEnum<string>;
		s?: number;
		d?: number;
	}[];
	vendors?: ClosedEnum<ProxyVendorName>[];
	failovers?: {
		v: ClosedEnum<ProxyVendorName>;
		nx?: ClosedEnum<ProxyVendorName>;
		p: ClosedEnum<ProxyVendorFailoverTelemetryEvent["phase"]>;
		r: ClosedEnum<ProxyVendorFailoverTelemetryEvent["reason"]>;
		a?: number;
	}[];
	selection?: {
		kind: ClosedEnum<ProxyTelemetrySelection["kind"]>;
		reason: ClosedEnum<ProxyVendorSelectionReason>;
	};
	vendorStates?: {
		v: ClosedEnum<ProxyVendorName>;
		s: ClosedEnum<ProxyVendorState>;
		e: number;
	}[];
};

const MAX_PROXY_ATTEMPT_SAMPLES = 24;
const MAX_PROXY_FAILOVER_SAMPLES = 12;
const MAX_RETAINED_PROXY_RESOLUTIONS = 64;
/** The registry has two vendors; the bound only guards against a malformed chain. */
const MAX_PROXY_VENDOR_STATES = 8;
const PROXY_HEADER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const PROXY_HEADER_HASH = /^[0-9a-f]{1,16}$/;

function aggregateResolution(
	acc: ProxyResolutionTelemetryEvent,
	event: ProxyResolutionTelemetryEvent,
): ProxyResolutionTelemetryEvent {
	return {
		provider: event.provider,
		userAgentSource: event.userAgentSource ?? acc.userAgentSource,
		cacheStatus: "disabled",
		cacheHit: acc.cacheHit && event.cacheHit,
		resolutionMs: acc.resolutionMs + event.resolutionMs,
		attempts: acc.attempts + event.attempts,
	};
}

export class ProxyTelemetryCollector
	implements
		ProxyTelemetrySink,
		ProxyVendorSelectionSink,
		TelemetryContributor<ProxyTelemetryLogPayload, ProxyTelemetryHeaderPayload>
{
	readonly key = "proxy" as const;
	#events: ProxyResolutionTelemetryEvent[] = [];
	#resolutionCount = 0;
	#aggregateResolution: ProxyResolutionTelemetryEvent | undefined;
	#lastSuccessfulResolution: ProxyResolutionTelemetryEvent | undefined;
	#vendors: ProxyVendorName[] = [];
	#attempts: ProxyAttemptTelemetryEvent[] = [];
	#failovers: ProxyVendorFailoverTelemetryEvent[] = [];
	#unresolvedVendors: ProxyVendorName[] = [];
	#selection: ProxyTelemetrySelection | undefined;
	#vendorStates: ProxyTelemetryVendorState[] | undefined;

	recordProxyResolution(event: ProxyResolutionTelemetryEvent): void {
		const outcome = event.outcome === "error" ? "error" : "ok";
		const normalized: ProxyResolutionTelemetryEvent = {
			provider: event.provider,
			outcome,
			...(event.userAgentSource ? { userAgentSource: event.userAgentSource } : {}),
			...(event.protocol ? { protocol: event.protocol } : {}),
			cacheStatus: event.cacheStatus,
			cacheHit: event.cacheHit,
			resolutionMs: Math.max(0, Math.floor(event.resolutionMs)),
			attempts: Math.max(1, Math.floor(event.attempts || 1)),
		};
		this.#resolutionCount += 1;
		if (this.#events.length < MAX_RETAINED_PROXY_RESOLUTIONS) this.#events.push(normalized);
		this.#aggregateResolution = this.#aggregateResolution
			? aggregateResolution(this.#aggregateResolution, normalized)
			: normalized;
		if (outcome === "ok") this.#lastSuccessfulResolution = normalized;
		if (!this.#vendors.includes(event.provider)) this.#vendors.push(event.provider);
		if (outcome === "error" && !this.#unresolvedVendors.includes(event.provider)) {
			this.#unresolvedVendors.push(event.provider);
		}
	}

	/** Number of raw resolution events retained for bounded-history verification. */
	get retainedResolutionEventCount(): number {
		return this.#events.length;
	}

	/** Total resolutions included in the incremental aggregate. */
	get resolutionEventCount(): number {
		return this.#resolutionCount;
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
			...(event.proxyHash ? { proxyHash: event.proxyHash.slice(0, 16) } : {}),
			outcome: event.outcome === "ok" ? "ok" : "error",
			...(event.errorCode ? { errorCode: event.errorCode.slice(0, 80) } : {}),
			...(event.status === undefined ? {} : { status: Math.max(0, Math.floor(event.status)) }),
			...(event.durationMs === undefined
				? {}
				: { durationMs: Math.max(0, Math.floor(event.durationMs)) }),
		});
	}

	/** The last selection of the request wins: it routed the attempt that decided the outcome. */
	recordProxyVendorSelection(observation: ProxyVendorSelectionObservation): void {
		this.#selection = { kind: observation.kind, reason: observation.reason };
		this.#vendorStates = observation.vendorStates
			.slice(0, MAX_PROXY_VENDOR_STATES)
			.map((entry) => ({
				v: entry.vendor,
				s: entry.state,
				e: Math.max(0, Math.floor(entry.ejections)),
			}));
	}

	toLogPayload(): ProxyTelemetryLogPayload | undefined {
		const aggregate = this.#aggregateResolution;
		const attemptSamples = this.#attempts.map((attempt, index) => ({
			n: index + 1,
			a: attempt.attempt,
			v: attempt.provider,
			...(attempt.proxyHash ? { h: attempt.proxyHash } : {}),
			o: attempt.outcome,
			...(attempt.errorCode ? { c: attempt.errorCode } : {}),
			...(attempt.status === undefined ? {} : { s: attempt.status }),
			...(attempt.durationMs === undefined ? {} : { d: attempt.durationMs }),
		}));
		const failovers = this.#failovers.map((failover) => ({
			v: failover.vendor,
			...(failover.nextVendor ? { nx: failover.nextVendor } : {}),
			p: failover.phase,
			r: failover.reason,
			...(failover.attempt === undefined ? {} : { a: failover.attempt }),
		}));
		const selection = this.#selection
			? {
					selection: { ...this.#selection },
					...(this.#vendorStates && this.#vendorStates.length > 0
						? { vendorStates: this.#vendorStates.map((entry) => ({ ...entry })) }
						: {}),
				}
			: {};

		if (!this.#lastSuccessfulResolution) {
			if (!aggregate && failovers.length === 0) return undefined;
			return {
				kind: "unresolved",
				vendors: [...this.#unresolvedVendors],
				...(aggregate
					? {
							cacheStatus: aggregate.cacheStatus,
							cacheHit: aggregate.cacheHit,
							resolutionMs: aggregate.resolutionMs,
							attempts: aggregate.attempts,
						}
					: {}),
				...(failovers.length > 0 ? { failovers } : {}),
				...(attemptSamples.length > 0 ? { attemptSamples } : {}),
				...selection,
			};
		}

		// The serving vendor/protocol is the last successful resolution.
		if (!aggregate) return undefined;
		const serving = this.#lastSuccessfulResolution;
		return {
			kind: "resolved",
			provider: serving.provider,
			...(aggregate.userAgentSource ? { userAgentSource: aggregate.userAgentSource } : {}),
			...(serving.protocol ? { protocol: serving.protocol } : {}),
			cacheStatus: aggregate.cacheStatus,
			cacheHit: aggregate.cacheHit,
			resolutionMs: aggregate.resolutionMs,
			attempts: aggregate.attempts,
			...(attemptSamples.length > 0 ? { attemptSamples } : {}),
			...(this.#vendors.length > 1 ? { vendors: [...this.#vendors] } : {}),
			...(failovers.length > 0 ? { failovers } : {}),
			...selection,
		};
	}

	toHeaderPayload(log: ProxyTelemetryLogPayload): ProxyTelemetryHeaderPayload {
		const attemptSamples = log.attemptSamples?.map((sample) => ({
			n: sample.n,
			a: sample.a,
			...(sample.v ? { v: closedEnum(sample.v) } : {}),
			...(sample.h && PROXY_HEADER_HASH.test(sample.h)
				? { h: closedEnum(sample.h) as ProxyHash }
				: {}),
			o: closedEnum(sample.o),
			...(sample.c && PROXY_HEADER_TOKEN.test(sample.c) ? { c: closedEnum(sample.c) } : {}),
			...(sample.s === undefined ? {} : { s: sample.s }),
			...(sample.d === undefined ? {} : { d: sample.d }),
		}));
		const failovers = log.failovers?.map((failover) => ({
			...failover,
			v: closedEnum(failover.v),
			...(failover.nx ? { nx: closedEnum(failover.nx) } : {}),
			p: closedEnum(failover.p),
			r: closedEnum(failover.r),
		}));
		const selection = log.selection
			? {
					selection: {
						kind: closedEnum(log.selection.kind),
						reason: closedEnum(log.selection.reason),
					},
				}
			: {};
		const vendorStates = log.vendorStates
			? {
					vendorStates: log.vendorStates.map((entry) => ({
						v: closedEnum(entry.v),
						s: closedEnum(entry.s),
						e: entry.e,
					})),
				}
			: {};
		if (log.kind === "resolved") {
			return {
				...log,
				kind: closedEnum(log.kind),
				provider: closedEnum(log.provider),
				...(log.userAgentSource ? { userAgentSource: closedEnum(log.userAgentSource) } : {}),
				...(log.protocol ? { protocol: closedEnum(log.protocol) } : {}),
				cacheStatus: closedEnum(log.cacheStatus),
				...(attemptSamples ? { attemptSamples } : {}),
				...(log.vendors ? { vendors: log.vendors.map((vendor) => closedEnum(vendor)) } : {}),
				...(failovers ? { failovers } : {}),
				...selection,
				...vendorStates,
			} as ProxyTelemetryHeaderPayload;
		}
		return {
			...log,
			kind: closedEnum(log.kind),
			vendors: log.vendors.map((vendor) => closedEnum(vendor)),
			...(log.cacheStatus ? { cacheStatus: closedEnum(log.cacheStatus) } : {}),
			...(failovers ? { failovers } : {}),
			...(attemptSamples ? { attemptSamples } : {}),
			...selection,
			...vendorStates,
		} as ProxyTelemetryHeaderPayload;
	}

	toHeaderValue(): string | undefined {
		const telemetry = new RequestTelemetry(createTraceContext());
		telemetry.register(this);
		return telemetry.toHeaderValue();
	}
}
