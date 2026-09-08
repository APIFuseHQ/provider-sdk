import { Buffer } from "node:buffer";
import type { HttpRetrySummary } from "../types.js";
import {
	closedEnum,
	type ClosedEnum,
	type TelemetryContributor,
	type TenantNeutral,
} from "./request-telemetry.js";

/** The same closed vocabulary used by tenant-visible meta.retry. */
export type HttpTelemetryErrorCode =
	| "transport_network_error"
	| "transport_timeout"
	| "transport_cancelled"
	| "upstream_http_error"
	| "other";

export function httpTelemetryErrorCode(code: string | undefined): HttpTelemetryErrorCode {
	switch (code) {
		case "transport_network_error":
		case "transport_timeout":
		case "transport_cancelled":
		case "upstream_http_error":
			return code;
		default:
			return "other";
	}
}

export type HttpTelemetryRetryPayload = {
	attempts: number;
	retries: number;
	preset?: ClosedEnum<NonNullable<HttpRetrySummary["preset"]>>;
	transport: ClosedEnum<HttpRetrySummary["transport"]>;
	lastErrorCode?: ClosedEnum<HttpTelemetryErrorCode>;
	/** Last failed attempt's status, preserving the existing meta.retry contract. */
	lastStatus?: number;
};

export type HttpAttemptTelemetryEvent = {
	ms: number;
	proxyUsed: boolean;
	status?: number;
	e?: HttpTelemetryErrorCode;
	/** A returned status-retry outcome, rather than a thrown transport error. */
	statusRetry?: boolean;
	/** Operator-only error text. Never projected into the header or tenant metadata. */
	diagnostics?: { name: string; message: string; cause?: { name: string; message: string } };
};

export interface HttpTelemetryRequestSink {
	recordAttempt(event: HttpAttemptTelemetryEvent): void;
	/** Called once when the logical HTTP call settles; includes backoff time. */
	finish(ms: number): void;
	toTenantRetryPayload(): TenantNeutral<HttpTelemetryRetryPayload> | undefined;
}

export interface HttpTelemetrySink {
	/** Optional, best-effort failure marker; called at most once per logical request. */
	markTelemetryFailed?(): void;
	/** Each call gets independent retry state, including concurrent calls. */
	startRequest(options: { retryPreset?: HttpRetrySummary["preset"] }): HttpTelemetryRequestSink;
}

export type HttpAttemptSample = {
	n: number;
	ms: number;
	status?: number;
	e?: HttpTelemetryErrorCode;
	diagnostics?: HttpAttemptTelemetryEvent["diagnostics"];
};

export type HttpTelemetryLogPayload = {
	/** Observer failure; operator-only and never projected into the header. */
	telemetryFailed?: true;
	attempts: number;
	retries: number;
	timeouts: number;
	proxyUsed: boolean;
	/** Most recently completed attempt's status, including successful statuses. */
	lastStatus?: number;
	retryPreset?: HttpRetrySummary["preset"];
	transport: HttpRetrySummary["transport"];
	lastErrorCode?: HttpTelemetryErrorCode;
	attemptSamples: HttpAttemptSample[];
	dropped: number;
	/** Sum of logical call durations, including retry delays. */
	ms: number;
	/** Most recent successful retried call; also the source of tenant meta.retry. */
	retry?: HttpTelemetryRetryPayload;
};

export type HttpTelemetryHeaderPayload = {
	attempts: number;
	retries: number;
	timeouts: number;
	proxyUsed: boolean;
	lastStatus?: number;
	retryPreset?: ClosedEnum<NonNullable<HttpRetrySummary["preset"]>>;
	transport: ClosedEnum<HttpRetrySummary["transport"]>;
	lastErrorCode?: ClosedEnum<HttpTelemetryErrorCode>;
	attemptSamples: {
		n: number;
		ms: number;
		status?: number;
		e?: ClosedEnum<HttpTelemetryErrorCode>;
	}[];
	dropped: number;
	ms: number;
	retry?: HttpTelemetryRetryPayload;
};

const MAX_ATTEMPT_SAMPLES = 24;
const MAX_DIAGNOSTIC_TEXT = 300;

function integer(value: number): number {
	return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function saturatingAdd(a: number, b: number): number {
	if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.MAX_SAFE_INTEGER;
	return Math.min(Number.MAX_SAFE_INTEGER, integer(a) + integer(b));
}

function boundedText(value: string, redact?: (text: string) => string): string {
	let result: string;
	try {
		result = redact?.(value) ?? value;
	} catch {
		return "[REDACTION_FAILED]";
	}
	// Detach caller text through independent UTF-16 storage, preserving lone surrogates.
	const length = Math.min(result.length, MAX_DIAGNOSTIC_TEXT);
	const units = Buffer.alloc(length * 2);
	for (let index = 0; index < length; index++)
		units.writeUInt16LE(result.charCodeAt(index), index * 2);
	return units.toString("utf16le");
}

export class HttpTelemetryCollector
	implements
		HttpTelemetrySink,
		TelemetryContributor<HttpTelemetryLogPayload, HttpTelemetryHeaderPayload>
{
	readonly key = "http" as const;
	readonly #redact: ((text: string) => string) | undefined;
	#telemetryFailed = false;
	#attempts = 0;
	#retries = 0;
	#timeouts = 0;
	#proxyUsed = false;
	#lastStatus: number | undefined;
	#retryPreset: HttpRetrySummary["preset"];
	#lastErrorCode: HttpTelemetryErrorCode | undefined;
	#samples: HttpAttemptSample[] = [];
	#dropped = 0;
	#ms = 0;
	#retry: HttpTelemetryRetryPayload | undefined;

	constructor(options: { redact?: (text: string) => string } = {}) {
		this.#redact = options.redact;
	}

	markTelemetryFailed(): void {
		this.#telemetryFailed = true;
	}

	startRequest(options: { retryPreset?: HttpRetrySummary["preset"] }): HttpTelemetryRequestSink {
		const preset = options.retryPreset;
		let attempts = 0;
		let retries = 0;
		let lastErrorCode: HttpTelemetryErrorCode | undefined;
		let lastStatus: number | undefined;
		let retry: HttpTelemetryRetryPayload | undefined;
		let finished = false;
		return {
			recordAttempt: (event) => {
				if (attempts > 0) {
					retries = saturatingAdd(retries, 1);
					this.#retries = saturatingAdd(this.#retries, 1);
				}
				attempts = saturatingAdd(attempts, 1);
				this.#attempts = saturatingAdd(this.#attempts, 1);
				if (event.e === "transport_timeout") this.#timeouts = saturatingAdd(this.#timeouts, 1);
				this.#proxyUsed ||= event.proxyUsed;
				this.#retryPreset = preset;
				if (event.status !== undefined) this.#lastStatus = integer(event.status);
				if (event.e) this.#lastErrorCode = event.e;
				if (this.#samples.length < MAX_ATTEMPT_SAMPLES) {
					const text = (value: string) => boundedText(value, this.#redact);
					this.#samples.push({
						n: attempts,
						ms: saturatingAdd(0, event.ms),
						...(event.status === undefined ? {} : { status: integer(event.status) }),
						...(event.e ? { e: event.e } : {}),
						...(event.diagnostics
							? {
									diagnostics: {
										name: text(event.diagnostics.name),
										message: text(event.diagnostics.message),
										...(event.diagnostics.cause
											? {
													cause: {
														name: text(event.diagnostics.cause.name),
														message: text(event.diagnostics.cause.message),
													},
												}
											: {}),
									},
								}
							: {}),
					});
				} else this.#dropped = saturatingAdd(this.#dropped, 1);
				if (event.e) {
					lastStatus = event.status;
					// Historically status-retry outcomes set lastStatus only. Preserve those pins.
					if (!event.statusRetry) lastErrorCode = event.e;
				} else if (attempts > 1) {
					retry = {
						attempts,
						retries,
						...(preset ? { preset: closedEnum(preset) } : {}),
						transport: closedEnum("native"),
						...(lastErrorCode ? { lastErrorCode: closedEnum(lastErrorCode) } : {}),
						...(lastStatus ? { lastStatus: integer(lastStatus) } : {}),
					};
					this.#retry = retry;
				}
			},
			finish: (ms) => {
				if (!finished && attempts > 0) this.#ms = saturatingAdd(this.#ms, ms);
				finished = true;
			},
			toTenantRetryPayload: () => (!this.#telemetryFailed && retry ? { ...retry } : undefined),
		};
	}

	toTenantRetryPayload(): TenantNeutral<HttpTelemetryRetryPayload> | undefined {
		return !this.#telemetryFailed && this.#retry ? { ...this.#retry } : undefined;
	}

	toLogPayload(): HttpTelemetryLogPayload | undefined {
		if (this.#attempts === 0 && !this.#telemetryFailed) return undefined;
		return {
			...(this.#telemetryFailed ? { telemetryFailed: true as const } : {}),
			attempts: this.#attempts,
			retries: this.#retries,
			timeouts: this.#timeouts,
			proxyUsed: this.#proxyUsed,
			...(this.#lastStatus === undefined ? {} : { lastStatus: this.#lastStatus }),
			...(this.#retryPreset ? { retryPreset: this.#retryPreset } : {}),
			transport: "native",
			...(this.#lastErrorCode ? { lastErrorCode: this.#lastErrorCode } : {}),
			attemptSamples: this.#samples.map((sample) => ({
				...sample,
				...(sample.diagnostics
					? {
							diagnostics: {
								...sample.diagnostics,
								...(sample.diagnostics.cause ? { cause: { ...sample.diagnostics.cause } } : {}),
							},
						}
					: {}),
			})),
			dropped: this.#dropped,
			ms: this.#ms,
			...(this.#retry ? { retry: { ...this.#retry } } : {}),
		};
	}

	toHeaderPayload(log: HttpTelemetryLogPayload): HttpTelemetryHeaderPayload {
		return {
			attempts: log.attempts,
			retries: log.retries,
			timeouts: log.timeouts,
			proxyUsed: log.proxyUsed,
			...(log.lastStatus === undefined ? {} : { lastStatus: log.lastStatus }),
			...(log.retryPreset ? { retryPreset: closedEnum(log.retryPreset) } : {}),
			transport: closedEnum(log.transport),
			...(log.lastErrorCode ? { lastErrorCode: closedEnum(log.lastErrorCode) } : {}),
			attemptSamples: log.attemptSamples.map(({ n, ms, status, e }) => ({
				n,
				ms,
				...(status === undefined ? {} : { status }),
				...(e ? { e: closedEnum(e) } : {}),
			})),
			dropped: log.dropped,
			ms: log.ms,
			...(log.retry ? { retry: { ...log.retry } } : {}),
		};
	}
}
