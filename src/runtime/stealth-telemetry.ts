import { Buffer } from "node:buffer";

import type {
	StealthBrowser,
	StealthChallengeClassification,
	StealthOS,
	StealthProfileDescriptor,
} from "../types.js";
import { type ClosedEnum, closedEnum, type TelemetryContributor } from "./request-telemetry.js";

export type StealthTelemetryErrorCode =
	| "transport_network_error"
	| "transport_timeout"
	| "transport_cancelled"
	| "upstream_http_error"
	| "response_too_large"
	| "proxy_connect_failed"
	| "PROXY_POOL_STALE"
	| "PROXY_EDGE_AUTH_REJECTED"
	| "PROXY_AUTH_IP_DENIED"
	| "PROXY_EDGE_TLS_REJECTED"
	| "PROXY_REQUIRED"
	| "other";

export type StealthTelemetryRequestClass = "navigation" | "script_navigation" | "xhr" | "post";

export type StealthTelemetryAttemptKind = "request" | "resolver" | "proxy_diagnostic";

export type StealthTelemetrySbsdOutcome =
	| StealthChallengeClassification["outcome"]
	| "detected"
	| "refetch_clear";

export type StealthTelemetryDiagnostics = {
	readonly name?: string;
	readonly message?: string;
	readonly code?: string;
};

export type StealthTelemetryAttemptEvent = {
	readonly ms: number;
	readonly status?: number;
	readonly errorCode?: StealthTelemetryErrorCode;
	readonly diagnostics?: StealthTelemetryDiagnostics;
	readonly profileId: StealthProfileDescriptor;
	readonly proxyUsed: boolean;
	readonly requestClass: StealthTelemetryRequestClass;
	readonly kind?: StealthTelemetryAttemptKind;
};

export type StealthTelemetrySbsdEvent = {
	readonly detected: boolean;
	readonly outcome?: StealthTelemetrySbsdOutcome;
};

export interface StealthTelemetrySink {
	recordAttempt(event: StealthTelemetryAttemptEvent): void;
	recordPoolRefresh(): void;
	recordRedirectHop(): void;
	recordSbsd(event?: StealthTelemetrySbsdEvent | StealthTelemetrySbsdOutcome): void;
	recordSafeRefetch(): void;
}

export type StealthTelemetryAttemptSample = {
	n: number;
	ms: number;
	status?: number;
	e?: StealthTelemetryErrorCode;
	kind?: StealthTelemetryAttemptKind;
	diagnostics?: StealthTelemetryDiagnostics;
};

export type StealthTelemetryLogPayload = {
	attempts: number;
	poolRefreshes: number;
	redirectHops: number;
	profileId?: StealthProfileDescriptor;
	proxyUsed: boolean;
	requestClass?: StealthTelemetryRequestClass;
	sbsdDetected?: boolean;
	sbsdOutcome?: StealthTelemetrySbsdOutcome;
	safeRefetch: number;
	lastStatus?: number;
	ms: number;
	attemptSamples?: StealthTelemetryAttemptSample[];
	attemptSamplesDropped?: number;
};

export type StealthTelemetryHeaderPayload = {
	attempts: number;
	poolRefreshes: number;
	redirectHops: number;
	profileId?: {
		browser: ClosedEnum<StealthBrowser>;
		os: ClosedEnum<StealthOS>;
	};
	proxyUsed: boolean;
	requestClass?: ClosedEnum<StealthTelemetryRequestClass>;
	sbsdDetected?: boolean;
	sbsdOutcome?: ClosedEnum<StealthTelemetrySbsdOutcome>;
	safeRefetch: number;
	lastStatus?: number;
	ms: number;
	attemptSamples?: {
		n: number;
		ms: number;
		status?: number;
		e?: ClosedEnum<StealthTelemetryErrorCode>;
		kind?: ClosedEnum<StealthTelemetryAttemptKind>;
	}[];
};

const MAX_ATTEMPT_SAMPLES = 24;
const MAX_DIAGNOSTIC_TEXT = 300;

function boundedInteger(value: number): number {
	if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function saturatingAdd(a: number, b: number): number {
	if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.MAX_SAFE_INTEGER;
	return Math.min(Number.MAX_SAFE_INTEGER, boundedInteger(a) + boundedInteger(b));
}

function boundedText(value: string, redact?: (text: string) => string): string {
	let result = value;
	try {
		result = redact?.(value) ?? value;
	} catch {
		result = "[REDACTION_FAILED]";
	}
	const length = Math.min(result.length, MAX_DIAGNOSTIC_TEXT);
	const units = Buffer.alloc(length * 2);
	for (let index = 0; index < length; index += 1) {
		units.writeUInt16LE(result.charCodeAt(index), index * 2);
	}
	return units.toString("utf16le");
}

function cloneDiagnostics(
	diagnostics: StealthTelemetryDiagnostics | undefined,
	redact: ((text: string) => string) | undefined,
): StealthTelemetryDiagnostics | undefined {
	if (!diagnostics) return undefined;
	const result: StealthTelemetryDiagnostics = {
		...(diagnostics.name === undefined ? {} : { name: boundedText(diagnostics.name, redact) }),
		...(diagnostics.message === undefined
			? {}
			: { message: boundedText(diagnostics.message, redact) }),
		...(diagnostics.code === undefined ? {} : { code: boundedText(diagnostics.code, redact) }),
	};
	return Object.keys(result).length > 0 ? result : undefined;
}

function cloneProfile(profile: StealthProfileDescriptor): StealthProfileDescriptor {
	return { browser: profile.browser, os: profile.os } as StealthProfileDescriptor;
}

export class StealthTelemetryCollector
	implements
		StealthTelemetrySink,
		TelemetryContributor<StealthTelemetryLogPayload, StealthTelemetryHeaderPayload>
{
	readonly key = "stealth" as const;
	readonly #redact: ((text: string) => string) | undefined;
	#attempts = 0;
	#poolRefreshes = 0;
	#redirectHops = 0;
	#profileId: StealthProfileDescriptor | undefined;
	#proxyUsed = false;
	#requestClass: StealthTelemetryRequestClass | undefined;
	#sbsdDetected: boolean | undefined;
	#sbsdOutcome: StealthTelemetrySbsdOutcome | undefined;
	#safeRefetch = 0;
	#lastStatus: number | undefined;
	#ms = 0;
	#attemptSamples: StealthTelemetryAttemptSample[] = [];
	#attemptSamplesDropped = 0;

	constructor(options: { redact?: (text: string) => string } = {}) {
		this.#redact = options.redact;
	}

	recordAttempt(event: StealthTelemetryAttemptEvent): void {
		const ms = boundedInteger(event.ms);
		this.#attempts = saturatingAdd(this.#attempts, 1);
		this.#ms = saturatingAdd(this.#ms, ms);
		this.#profileId = cloneProfile(event.profileId);
		this.#proxyUsed ||= event.proxyUsed;
		this.#requestClass = event.requestClass;
		if (event.status !== undefined) this.#lastStatus = boundedInteger(event.status);
		if (this.#attemptSamples.length >= MAX_ATTEMPT_SAMPLES) {
			this.#attemptSamplesDropped = saturatingAdd(this.#attemptSamplesDropped, 1);
			return;
		}
		const sample: StealthTelemetryAttemptSample = {
			n: this.#attempts,
			ms,
			...(event.status === undefined ? {} : { status: boundedInteger(event.status) }),
			...(event.errorCode === undefined ? {} : { e: event.errorCode }),
			...(event.kind === undefined ? {} : { kind: event.kind }),
			...(event.diagnostics
				? { diagnostics: cloneDiagnostics(event.diagnostics, this.#redact) }
				: {}),
		};
		if (sample.diagnostics === undefined) delete sample.diagnostics;
		this.#attemptSamples.push(sample);
	}

	recordPoolRefresh(): void {
		this.#poolRefreshes = saturatingAdd(this.#poolRefreshes, 1);
	}

	recordRedirectHop(): void {
		this.#redirectHops = saturatingAdd(this.#redirectHops, 1);
	}

	recordSbsd(event?: StealthTelemetrySbsdEvent | StealthTelemetrySbsdOutcome): void {
		if (typeof event === "string") {
			this.#sbsdDetected = true;
			this.#sbsdOutcome = event;
			return;
		}
		if (!event) return;
		this.#sbsdDetected = (this.#sbsdDetected ?? false) || event.detected;
		if (event.outcome !== undefined) this.#sbsdOutcome = event.outcome;
	}

	recordSafeRefetch(): void {
		this.#safeRefetch = saturatingAdd(this.#safeRefetch, 1);
	}

	toLogPayload(): StealthTelemetryLogPayload | undefined {
		if (
			this.#attempts === 0 &&
			this.#poolRefreshes === 0 &&
			this.#redirectHops === 0 &&
			this.#safeRefetch === 0 &&
			this.#sbsdDetected === undefined
		) {
			return undefined;
		}
		return {
			attempts: this.#attempts,
			poolRefreshes: this.#poolRefreshes,
			redirectHops: this.#redirectHops,
			...(this.#profileId ? { profileId: cloneProfile(this.#profileId) } : {}),
			proxyUsed: this.#proxyUsed,
			...(this.#requestClass ? { requestClass: this.#requestClass } : {}),
			...(this.#sbsdDetected === undefined ? {} : { sbsdDetected: this.#sbsdDetected }),
			...(this.#sbsdOutcome ? { sbsdOutcome: this.#sbsdOutcome } : {}),
			safeRefetch: this.#safeRefetch,
			...(this.#lastStatus === undefined ? {} : { lastStatus: this.#lastStatus }),
			ms: this.#ms,
			...(this.#attemptSamples.length > 0
				? {
						attemptSamples: this.#attemptSamples.map((sample) => ({
							...sample,
							...(sample.diagnostics
								? {
										diagnostics: { ...sample.diagnostics },
									}
								: {}),
						})),
					}
				: {}),
			...(this.#attemptSamplesDropped > 0
				? { attemptSamplesDropped: this.#attemptSamplesDropped }
				: {}),
		};
	}

	toHeaderPayload(log: StealthTelemetryLogPayload): StealthTelemetryHeaderPayload {
		const attemptSamples = log.attemptSamples?.map((sample) => ({
			n: sample.n,
			ms: sample.ms,
			...(sample.status === undefined ? {} : { status: sample.status }),
			...(sample.e ? { e: closedEnum(sample.e) } : {}),
			...(sample.kind ? { kind: closedEnum(sample.kind) } : {}),
		}));
		return {
			attempts: log.attempts,
			poolRefreshes: log.poolRefreshes,
			redirectHops: log.redirectHops,
			...(log.profileId
				? {
						profileId: {
							browser: closedEnum(log.profileId.browser),
							os: closedEnum(log.profileId.os),
						},
					}
				: {}),
			proxyUsed: log.proxyUsed,
			...(log.requestClass ? { requestClass: closedEnum(log.requestClass) } : {}),
			...(log.sbsdDetected === undefined ? {} : { sbsdDetected: log.sbsdDetected }),
			...(log.sbsdOutcome ? { sbsdOutcome: closedEnum(log.sbsdOutcome) } : {}),
			safeRefetch: log.safeRefetch,
			...(log.lastStatus === undefined ? {} : { lastStatus: log.lastStatus }),
			ms: log.ms,
			...(attemptSamples && attemptSamples.length > 0 ? { attemptSamples } : {}),
		};
	}
}
