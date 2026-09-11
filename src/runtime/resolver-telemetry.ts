import { Buffer } from "node:buffer";
import type { ProviderChallengeKind, ProviderResolverVendor } from "../types.js";
import { closedEnum, type ClosedEnum, type TelemetryContributor } from "./request-telemetry.js";
import type { ResolverVendorUnavailableReason } from "./resolver-vendors/types.js";

/**
 * Result of the resolver call. `solved` means the adapter returned a solution;
 * for SBSD this means payload acceptance, even when `verified` is false.
 * It does not assert that a later protected request succeeded. Stealth reports
 * that verification separately through the refetch status and challenge outcome.
 */
export type ResolverTelemetryOutcome = "solved" | "cached" | "exhausted" | "aborted" | "error";
export type ResolverTelemetryCacheStatus = "hit" | "miss" | "disabled" | "not_cacheable";
export type ResolverTelemetryIdentitySource = "declared" | "defaulted" | "none";
export type ResolverTelemetryPhase =
	| "create_task"
	| "poll_result"
	| "cleanup"
	| "measure_ip"
	| "fetch_script"
	| "generate_payload"
	| "post_payload";
export type ResolverTelemetryAttemptOutcome = "ok" | "error";
export type ResolverTelemetryErrorClass =
	| ResolverVendorUnavailableReason
	| "aborted"
	| "unexpected";
export type ResolverTelemetryCacheWriteReason = "no_expires" | "not_cacheable" | "error";

export type ResolverIdentityTelemetryEvent = {
	readonly source: ResolverTelemetryIdentitySource;
	readonly failure?: ResolverVendorUnavailableReason;
};

export type ResolverCacheReadTelemetryEvent = {
	readonly status: ResolverTelemetryCacheStatus;
	readonly challengeKind: ProviderChallengeKind;
};

export type ResolverCacheWriteTelemetryEvent = {
	readonly written: boolean;
	readonly reason?: ResolverTelemetryCacheWriteReason;
};

export type ResolverVendorAttemptTelemetryEvent = {
	readonly vendor: ProviderResolverVendor;
	readonly phase: ResolverTelemetryPhase;
	readonly outcome: ResolverTelemetryAttemptOutcome;
	readonly ms: number;
	readonly pollCount?: number;
	readonly errorClass?: ResolverTelemetryErrorClass;
	readonly vendorErrorCode?: string;
	readonly vendorErrorDescription?: string;
	/** Operator-only diagnostics; free text is redacted, detached and bounded by the collector. */
	readonly diagnostics?: {
		readonly cause?: { readonly name: string; readonly message: string };
		readonly upstreamHost?: string;
		readonly missingFields?: readonly string[];
		readonly round?: number;
		/** One-based position in the supporting vendor chain. */
		readonly attemptIndex?: number;
		/** Actual adapter phase, including phases outside the header's closed enum. */
		readonly phase?: string;
	};
};

export type ResolverFailoverTelemetryEvent = {
	readonly from: ProviderResolverVendor;
	readonly to: ProviderResolverVendor;
	readonly reason: ResolverVendorUnavailableReason;
};

export type ResolverOutcomeTelemetryEvent = {
	readonly outcome: ResolverTelemetryOutcome;
	readonly solveMs: number;
	readonly challengeKind: ProviderChallengeKind;
};

export interface ResolverTelemetrySink {
	recordIdentity(event: ResolverIdentityTelemetryEvent): void;
	recordCacheRead(event: ResolverCacheReadTelemetryEvent): void;
	recordCacheWrite(event: ResolverCacheWriteTelemetryEvent): void;
	recordVendorAttempt(event: ResolverVendorAttemptTelemetryEvent): void;
	recordFailover(event: ResolverFailoverTelemetryEvent): void;
	recordOutcome(event: ResolverOutcomeTelemetryEvent): void;
}

export type ResolverAttemptSample = {
	v: ProviderResolverVendor;
	p: ResolverTelemetryPhase;
	o: ResolverTelemetryAttemptOutcome;
	ms: number;
	c?: string;
	e?: ResolverTelemetryErrorClass;
	diagnostics?: ResolverVendorAttemptTelemetryEvent["diagnostics"];
};

export type ResolverTelemetryLogPayload = {
	/** Adapter result; `solved` includes unverified payload acceptance. Read the protected refetch status/challenge outcome for verification. */
	outcome?: ResolverTelemetryOutcome;
	challengeKind?: ProviderChallengeKind;
	cacheStatus?: ResolverTelemetryCacheStatus;
	cacheWrite?: {
		written: boolean;
		reason?: ResolverTelemetryCacheWriteReason;
	};
	identitySource?: ResolverTelemetryIdentitySource;
	identityFailure?: ResolverVendorUnavailableReason;
	solveMs?: number;
	attempts: number;
	failovers: number;
	vendorChain: ProviderResolverVendor[];
	vendorUsed?: ProviderResolverVendor;
	pollCount: number;
	attemptSamples?: ResolverAttemptSample[];
	attemptSamplesDropped?: number;
	lastVendorErrorDescription?: string;
};

export type ResolverTelemetryHeaderPayload = {
	/** Same adapter-result semantics as the log outcome; `solved` does not imply protected-refetch success. */
	outcome?: ClosedEnum<ResolverTelemetryOutcome>;
	cacheStatus?: ClosedEnum<ResolverTelemetryCacheStatus>;
	solveMs?: number;
	attempts: number;
	failovers: number;
	vendorUsed?: ClosedEnum<ProviderResolverVendor>;
	vendorChain: ClosedEnum<ProviderResolverVendor>[];
	pollCount: number;
	identitySource?: ClosedEnum<ResolverTelemetryIdentitySource>;
	attemptSamples?: {
		v: ClosedEnum<ProviderResolverVendor>;
		p: ClosedEnum<ResolverTelemetryPhase>;
		o: ClosedEnum<ResolverTelemetryAttemptOutcome>;
		ms: number;
		c?: ClosedEnum<string>;
	}[];
};

const MAX_RESOLVER_ATTEMPT_SAMPLES = 24;
const MAX_RESOLVER_VENDOR_CHAIN = 64;
const MAX_DIAGNOSTIC_TEXT = 300;
const MAX_MISSING_FIELDS = 24;
const HEADER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function boundedInteger(value: number): number {
	return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

export function boundedText(value: string, redact?: (text: string) => string): string {
	let result = value;
	try {
		result = redact?.(value) ?? value;
	} catch {
		return "[REDACTION_FAILED]";
	}
	// Copy code units through an independent UTF-16 buffer. A sliced string can
	// otherwise keep a multi-megabyte vendor response alive in both JSC and V8.
	// Preserve lone surrogates deliberately, including a pair split at the limit.
	const length = Math.min(result.length, MAX_DIAGNOSTIC_TEXT);
	const units = Buffer.alloc(length * 2);
	for (let index = 0; index < length; index += 1) {
		units.writeUInt16LE(result.charCodeAt(index), index * 2);
	}
	return units.toString("utf16le");
}

function boundedDiagnostics(
	diagnostics: NonNullable<ResolverVendorAttemptTelemetryEvent["diagnostics"]>,
	redact?: (text: string) => string,
): NonNullable<ResolverAttemptSample["diagnostics"]> {
	return {
		...(diagnostics.cause
			? {
					cause: {
						name: boundedText(diagnostics.cause.name, redact),
						message: boundedText(diagnostics.cause.message, redact),
					},
				}
			: {}),
		...(diagnostics.upstreamHost
			? { upstreamHost: boundedText(diagnostics.upstreamHost, redact) }
			: {}),
		...(diagnostics.missingFields
			? {
					missingFields: diagnostics.missingFields
						.slice(0, MAX_MISSING_FIELDS)
						.map((field) => boundedText(field, redact)),
				}
			: {}),
		...(diagnostics.round === undefined ? {} : { round: boundedInteger(diagnostics.round) }),
		...(diagnostics.attemptIndex === undefined
			? {}
			: { attemptIndex: boundedInteger(diagnostics.attemptIndex) }),
		...(diagnostics.phase ? { phase: boundedText(diagnostics.phase, redact) } : {}),
	};
}

export class ResolverTelemetryCollector
	implements
		ResolverTelemetrySink,
		TelemetryContributor<ResolverTelemetryLogPayload, ResolverTelemetryHeaderPayload>
{
	readonly key = "resolver" as const;
	readonly #redact: ((text: string) => string) | undefined;
	#identity: ResolverIdentityTelemetryEvent | undefined;
	#cacheRead: ResolverCacheReadTelemetryEvent | undefined;
	#cacheWrite: ResolverCacheWriteTelemetryEvent | undefined;
	#outcome: ResolverOutcomeTelemetryEvent | undefined;
	#attempts = 0;
	#failovers = 0;
	#pollCount = 0;
	#vendorChain: ProviderResolverVendor[] = [];
	#vendorUsed: ProviderResolverVendor | undefined;
	#attemptSamples: ResolverAttemptSample[] = [];
	#attemptSamplesDropped = 0;
	#lastVendorErrorDescription: string | undefined;

	constructor(options: { redact?: (text: string) => string } = {}) {
		this.#redact = options.redact;
	}

	recordIdentity(event: ResolverIdentityTelemetryEvent): void {
		this.#identity = { ...event };
	}

	recordCacheRead(event: ResolverCacheReadTelemetryEvent): void {
		this.#cacheRead = { ...event };
	}

	recordCacheWrite(event: ResolverCacheWriteTelemetryEvent): void {
		this.#cacheWrite = { ...event };
	}

	recordVendorAttempt(event: ResolverVendorAttemptTelemetryEvent): void {
		const ms = boundedInteger(event.ms);
		const pollCount = event.pollCount === undefined ? 0 : boundedInteger(event.pollCount);
		this.#pollCount += pollCount;
		if (event.phase !== "cleanup") {
			this.#attempts += 1;
			if (
				this.#vendorChain.length < MAX_RESOLVER_VENDOR_CHAIN &&
				this.#vendorChain.at(-1) !== event.vendor
			) {
				this.#vendorChain.push(event.vendor);
			}
			if (event.outcome === "ok") this.#vendorUsed = event.vendor;
		}
		if (this.#attemptSamples.length < MAX_RESOLVER_ATTEMPT_SAMPLES) {
			this.#attemptSamples.push({
				v: event.vendor,
				p: event.phase,
				o: event.outcome,
				ms,
				...(event.vendorErrorCode ? { c: boundedText(event.vendorErrorCode, this.#redact) } : {}),
				...(event.errorClass ? { e: event.errorClass } : {}),
				...(event.diagnostics
					? { diagnostics: boundedDiagnostics(event.diagnostics, this.#redact) }
					: {}),
			});
		} else {
			this.#attemptSamplesDropped += 1;
		}
		if (event.vendorErrorDescription) {
			this.#lastVendorErrorDescription = boundedText(event.vendorErrorDescription, this.#redact);
		}
	}

	recordFailover(_event: ResolverFailoverTelemetryEvent): void {
		this.#failovers += 1;
	}

	recordOutcome(event: ResolverOutcomeTelemetryEvent): void {
		this.#outcome = { ...event, solveMs: boundedInteger(event.solveMs) };
	}

	toLogPayload(): ResolverTelemetryLogPayload | undefined {
		if (
			!this.#identity &&
			!this.#cacheRead &&
			!this.#cacheWrite &&
			!this.#outcome &&
			this.#attempts === 0 &&
			this.#attemptSamples.length === 0 &&
			this.#failovers === 0
		) {
			return undefined;
		}
		return {
			...(this.#outcome
				? {
						outcome: this.#outcome.outcome,
						challengeKind: this.#outcome.challengeKind,
						solveMs: this.#outcome.solveMs,
					}
				: this.#cacheRead
					? { challengeKind: this.#cacheRead.challengeKind }
					: {}),
			...(this.#cacheRead ? { cacheStatus: this.#cacheRead.status } : {}),
			...(this.#cacheWrite ? { cacheWrite: { ...this.#cacheWrite } } : {}),
			...(this.#identity
				? {
						identitySource: this.#identity.source,
						...(this.#identity.failure ? { identityFailure: this.#identity.failure } : {}),
					}
				: {}),
			attempts: this.#attempts,
			failovers: this.#failovers,
			vendorChain: [...this.#vendorChain],
			...(this.#vendorUsed ? { vendorUsed: this.#vendorUsed } : {}),
			pollCount: this.#pollCount,
			...(this.#attemptSamples.length > 0
				? {
						attemptSamples: this.#attemptSamples.map((sample) => ({
							...sample,
							...(sample.diagnostics
								? {
										diagnostics: {
											...sample.diagnostics,
											...(sample.diagnostics.cause
												? { cause: { ...sample.diagnostics.cause } }
												: {}),
											...(sample.diagnostics.missingFields
												? { missingFields: [...sample.diagnostics.missingFields] }
												: {}),
										},
									}
								: {}),
						})),
					}
				: {}),
			...(this.#attemptSamplesDropped > 0
				? { attemptSamplesDropped: this.#attemptSamplesDropped }
				: {}),
			...(this.#lastVendorErrorDescription
				? { lastVendorErrorDescription: this.#lastVendorErrorDescription }
				: {}),
		};
	}

	toHeaderPayload(log: ResolverTelemetryLogPayload): ResolverTelemetryHeaderPayload {
		const attemptSamples = log.attemptSamples?.map((sample) => ({
			v: closedEnum(sample.v),
			p: closedEnum(sample.p),
			o: closedEnum(sample.o),
			ms: sample.ms,
			...(sample.c && HEADER_TOKEN.test(sample.c) ? { c: closedEnum(sample.c) } : {}),
		}));
		return {
			...(log.outcome ? { outcome: closedEnum(log.outcome) } : {}),
			...(log.cacheStatus ? { cacheStatus: closedEnum(log.cacheStatus) } : {}),
			...(log.solveMs === undefined ? {} : { solveMs: log.solveMs }),
			attempts: log.attempts,
			failovers: log.failovers,
			...(log.vendorUsed ? { vendorUsed: closedEnum(log.vendorUsed) } : {}),
			vendorChain: log.vendorChain.map((vendor) => closedEnum(vendor)),
			pollCount: log.pollCount,
			...(log.identitySource ? { identitySource: closedEnum(log.identitySource) } : {}),
			...(attemptSamples && attemptSamples.length > 0 ? { attemptSamples } : {}),
		};
	}
}
