import { Buffer } from "node:buffer";
import type { ProviderProxyProvider } from "../types.js";
import type { NativeNetworkErrorCode } from "./native-network-errors.js";
import { closedEnum, type ClosedEnum, type TelemetryContributor } from "./request-telemetry.js";

export type NativeTelemetryErrorCode =
	| NativeNetworkErrorCode
	| "PROXY_REQUIRED"
	| "PROXY_ALLOCATION_FAILED"
	| "other";
export type NativeTelemetryKind = "tcp" | "tls";
export type NativeTelemetryOutcome = "ok" | "error";
export type NativeTelemetryVendorSkipReason =
	| "credentials_absent"
	| "protocol_unsupported"
	| "allocation_failed"
	| "credential_lookup_failed"
	| "adapter_unavailable";
export type NativeTelemetryLifecycleKind =
	| "drain"
	| "drain_acknowledged"
	| "drain_error"
	| "drain_missing_handler"
	| "idle"
	| "expiry";

/** Operator-only text is redacted before it is detached and bounded to 300 code units. */
export type NativeTelemetryDiagnostics = {
	host?: string;
	serverName?: string;
	protocol?: string;
	sessionId?: string;
	expiresAt?: string;
	errorName?: string;
	errorMessage?: string;
	causeName?: string;
	causeMessage?: string;
	systemCode?: string;
	missingFields?: readonly string[];
	port?: number;
	timeoutMs?: number;
	idleTimeoutMs?: number;
	status?: number;
	socksReplyCode?: number;
	sticky?: boolean;
};

export type NativeConnectTelemetryEvent = {
	kind: NativeTelemetryKind;
	outcome: NativeTelemetryOutcome;
	/** Entire establishment, including lease resolution, tunnel and TLS handshake. */
	ms: number;
	/** Tunnel establishment only; included in ms, never added to it. */
	tunnelMs: number;
	proxyUsed: boolean;
	/** Selected vendor for this connection; operator log only. */
	vendor?: ProviderProxyProvider;
	errorCode?: NativeTelemetryErrorCode;
	diagnostics?: NativeTelemetryDiagnostics;
};
export type NativeVendorSkipTelemetryEvent = {
	vendor: ProviderProxyProvider;
	reason: NativeTelemetryVendorSkipReason;
	diagnostics?: NativeTelemetryDiagnostics;
};
export type NativeLifecycleTelemetryEvent = {
	kind: NativeTelemetryLifecycleKind;
	errorCode?: NativeTelemetryErrorCode;
	diagnostics?: NativeTelemetryDiagnostics;
};

export interface NativeTelemetrySink {
	recordConnect(event: NativeConnectTelemetryEvent): void;
	recordVendorSkip(event: NativeVendorSkipTelemetryEvent): void;
	recordLifecycle(event: NativeLifecycleTelemetryEvent): void;
	/** Application bytes returned by read or accepted by a successful write. Excludes tunnel/TLS framing. */
	recordBytes(event: { direction: "in" | "out"; bytes: number }): void;
	recordError(event: {
		errorCode: NativeTelemetryErrorCode;
		diagnostics?: NativeTelemetryDiagnostics;
	}): void;
}

export type NativeAttemptSample = NativeConnectTelemetryEvent & { n: number };
export type NativeTelemetryLogPayload = {
	attempts: number;
	connectMs: number;
	tunnelMs: number;
	vendorSkips: number;
	vendorSkipReasons: { reason: NativeTelemetryVendorSkipReason; count: number }[];
	drain: number;
	drainAcknowledged: number;
	drainErrors: number;
	drainMissingHandler: number;
	idle: number;
	expiry: number;
	bytesIn: number;
	bytesOut: number;
	lastErrorCode?: NativeTelemetryErrorCode;
	lastErrorDiagnostics?: NativeTelemetryDiagnostics;
	attemptSamples?: NativeAttemptSample[];
	attemptSamplesDropped?: number;
	vendorSkipSamples?: NativeVendorSkipTelemetryEvent[];
	vendorSkipSamplesDropped?: number;
};

export type NativeTelemetryHeaderPayload = {
	attempts: number;
	connectMs: number;
	tunnelMs: number;
	vendorSkips: number;
	vendorSkipReasons: { reason: ClosedEnum<NativeTelemetryVendorSkipReason>; count: number }[];
	drain: number;
	drainAcknowledged: number;
	drainErrors: number;
	drainMissingHandler: number;
	idle: number;
	expiry: number;
	bytesIn: number;
	bytesOut: number;
	lastErrorCode?: ClosedEnum<NativeTelemetryErrorCode>;
	attemptSamples?: {
		n: number;
		kind: ClosedEnum<NativeTelemetryKind>;
		outcome: ClosedEnum<NativeTelemetryOutcome>;
		ms: number;
		tunnelMs: number;
		proxyUsed: boolean;
		errorCode?: ClosedEnum<NativeTelemetryErrorCode>;
	}[];
	attemptSamplesDropped?: number;
	vendorSkipSamplesDropped?: number;
};

const MAX_SAMPLES = 24;
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
		result = redact ? redact(value) : value;
		if (typeof result !== "string") return "[REDACTION_FAILED]";
	} catch {
		return "[REDACTION_FAILED]";
	}
	// Do not slice caller text: a substring may retain the entire vendor response.
	const length = Math.min(result.length, 300);
	const units = Buffer.alloc(length * 2);
	for (let index = 0; index < length; index++)
		units.writeUInt16LE(result.charCodeAt(index), index * 2);
	return units.toString("utf16le");
}
function diagnostics(
	value: NativeTelemetryDiagnostics,
	redact?: (text: string) => string,
): NativeTelemetryDiagnostics {
	const result: NativeTelemetryDiagnostics = {};
	for (const key of [
		"host",
		"serverName",
		"protocol",
		"sessionId",
		"expiresAt",
		"errorName",
		"errorMessage",
		"causeName",
		"causeMessage",
		"systemCode",
	] as const) {
		if (value[key] !== undefined) result[key] = boundedText(value[key], redact);
	}
	for (const key of ["port", "timeoutMs", "idleTimeoutMs", "status", "socksReplyCode"] as const) {
		if (value[key] !== undefined) result[key] = integer(value[key]);
	}
	if (value.sticky !== undefined) result.sticky = value.sticky;
	if (value.missingFields)
		result.missingFields = value.missingFields
			.slice(0, MAX_SAMPLES)
			.map((field) => boundedText(field, redact));
	return result;
}
function copyDiagnostics(value: NativeTelemetryDiagnostics): NativeTelemetryDiagnostics {
	return { ...value, ...(value.missingFields ? { missingFields: [...value.missingFields] } : {}) };
}

export class NativeTelemetryCollector
	implements
		NativeTelemetrySink,
		TelemetryContributor<NativeTelemetryLogPayload, NativeTelemetryHeaderPayload>
{
	readonly key = "native" as const;
	readonly #redact: ((text: string) => string) | undefined;
	#recorded = false;
	#attempts = 0;
	#connectMs = 0;
	#tunnelMs = 0;
	#vendorSkips = 0;
	#vendorSkipReasons = new Map<NativeTelemetryVendorSkipReason, number>();
	#lifecycle = {
		drain: 0,
		drain_acknowledged: 0,
		drain_error: 0,
		drain_missing_handler: 0,
		idle: 0,
		expiry: 0,
	};
	#bytesIn = 0;
	#bytesOut = 0;
	#lastErrorCode: NativeTelemetryErrorCode | undefined;
	#lastErrorDiagnostics: NativeTelemetryDiagnostics | undefined;
	#attemptSamples: NativeAttemptSample[] = [];
	#attemptSamplesDropped = 0;
	#vendorSkipSamples: NativeVendorSkipTelemetryEvent[] = [];
	#vendorSkipSamplesDropped = 0;

	constructor(options: { redact?: (text: string) => string } = {}) {
		this.#redact = options.redact;
	}

	recordConnect(event: NativeConnectTelemetryEvent): void {
		this.#recorded = true;
		const ms = saturatingAdd(0, event.ms);
		const tunnelMs = saturatingAdd(0, event.tunnelMs);
		this.#attempts = saturatingAdd(this.#attempts, 1);
		this.#connectMs = saturatingAdd(this.#connectMs, ms);
		this.#tunnelMs = saturatingAdd(this.#tunnelMs, tunnelMs);
		if (event.errorCode)
			this.recordError({ errorCode: event.errorCode, diagnostics: event.diagnostics });
		if (this.#attemptSamples.length < MAX_SAMPLES) {
			this.#attemptSamples.push({
				n: this.#attempts,
				kind: event.kind,
				outcome: event.outcome,
				ms,
				tunnelMs,
				proxyUsed: event.proxyUsed,
				...(event.vendor ? { vendor: event.vendor } : {}),
				...(event.errorCode ? { errorCode: event.errorCode } : {}),
				...(event.diagnostics ? { diagnostics: diagnostics(event.diagnostics, this.#redact) } : {}),
			});
		} else this.#attemptSamplesDropped = saturatingAdd(this.#attemptSamplesDropped, 1);
	}
	recordVendorSkip(event: NativeVendorSkipTelemetryEvent): void {
		this.#recorded = true;
		this.#vendorSkips = saturatingAdd(this.#vendorSkips, 1);
		this.#vendorSkipReasons.set(
			event.reason,
			saturatingAdd(this.#vendorSkipReasons.get(event.reason) ?? 0, 1),
		);
		if (this.#vendorSkipSamples.length < MAX_SAMPLES) {
			this.#vendorSkipSamples.push({
				vendor: event.vendor,
				reason: event.reason,
				...(event.diagnostics ? { diagnostics: diagnostics(event.diagnostics, this.#redact) } : {}),
			});
		} else this.#vendorSkipSamplesDropped = saturatingAdd(this.#vendorSkipSamplesDropped, 1);
	}
	recordLifecycle(event: NativeLifecycleTelemetryEvent): void {
		this.#recorded = true;
		this.#lifecycle[event.kind] = saturatingAdd(this.#lifecycle[event.kind], 1);
		if (event.errorCode)
			this.recordError({ errorCode: event.errorCode, diagnostics: event.diagnostics });
	}
	recordBytes(event: { direction: "in" | "out"; bytes: number }): void {
		this.#recorded = true;
		if (event.direction === "in") this.#bytesIn = saturatingAdd(this.#bytesIn, event.bytes);
		else this.#bytesOut = saturatingAdd(this.#bytesOut, event.bytes);
	}
	recordError(event: {
		errorCode: NativeTelemetryErrorCode;
		diagnostics?: NativeTelemetryDiagnostics;
	}): void {
		this.#recorded = true;
		this.#lastErrorCode = event.errorCode;
		this.#lastErrorDiagnostics = event.diagnostics
			? diagnostics(event.diagnostics, this.#redact)
			: undefined;
	}
	toLogPayload(): NativeTelemetryLogPayload | undefined {
		if (!this.#recorded) return undefined;
		return {
			attempts: this.#attempts,
			connectMs: this.#connectMs,
			tunnelMs: this.#tunnelMs,
			vendorSkips: this.#vendorSkips,
			vendorSkipReasons: [...this.#vendorSkipReasons].map(([reason, count]) => ({ reason, count })),
			drain: this.#lifecycle.drain,
			drainAcknowledged: this.#lifecycle.drain_acknowledged,
			drainErrors: this.#lifecycle.drain_error,
			drainMissingHandler: this.#lifecycle.drain_missing_handler,
			idle: this.#lifecycle.idle,
			expiry: this.#lifecycle.expiry,
			bytesIn: this.#bytesIn,
			bytesOut: this.#bytesOut,
			...(this.#lastErrorCode ? { lastErrorCode: this.#lastErrorCode } : {}),
			...(this.#lastErrorDiagnostics
				? { lastErrorDiagnostics: copyDiagnostics(this.#lastErrorDiagnostics) }
				: {}),
			...(this.#attemptSamples.length
				? {
						attemptSamples: this.#attemptSamples.map((sample) => ({
							...sample,
							...(sample.diagnostics ? { diagnostics: copyDiagnostics(sample.diagnostics) } : {}),
						})),
					}
				: {}),
			...(this.#attemptSamplesDropped
				? { attemptSamplesDropped: this.#attemptSamplesDropped }
				: {}),
			...(this.#vendorSkipSamples.length
				? {
						vendorSkipSamples: this.#vendorSkipSamples.map((sample) => ({
							...sample,
							...(sample.diagnostics ? { diagnostics: copyDiagnostics(sample.diagnostics) } : {}),
						})),
					}
				: {}),
			...(this.#vendorSkipSamplesDropped
				? { vendorSkipSamplesDropped: this.#vendorSkipSamplesDropped }
				: {}),
		};
	}
	toHeaderPayload(log: NativeTelemetryLogPayload): NativeTelemetryHeaderPayload {
		return {
			attempts: log.attempts,
			connectMs: log.connectMs,
			tunnelMs: log.tunnelMs,
			vendorSkips: log.vendorSkips,
			vendorSkipReasons: log.vendorSkipReasons.map(({ reason, count }) => ({
				reason: closedEnum(reason),
				count,
			})),
			drain: log.drain,
			drainAcknowledged: log.drainAcknowledged,
			drainErrors: log.drainErrors,
			drainMissingHandler: log.drainMissingHandler,
			idle: log.idle,
			expiry: log.expiry,
			bytesIn: log.bytesIn,
			bytesOut: log.bytesOut,
			...(log.lastErrorCode ? { lastErrorCode: closedEnum(log.lastErrorCode) } : {}),
			...(log.attemptSamples
				? {
						attemptSamples: log.attemptSamples.map((sample) => ({
							n: sample.n,
							kind: closedEnum(sample.kind),
							outcome: closedEnum(sample.outcome),
							ms: sample.ms,
							tunnelMs: sample.tunnelMs,
							proxyUsed: sample.proxyUsed,
							...(sample.errorCode ? { errorCode: closedEnum(sample.errorCode) } : {}),
						})),
					}
				: {}),
			...(log.attemptSamplesDropped ? { attemptSamplesDropped: log.attemptSamplesDropped } : {}),
			...(log.vendorSkipSamplesDropped
				? { vendorSkipSamplesDropped: log.vendorSkipSamplesDropped }
				: {}),
		};
	}
}
