import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { registerDiagnosticValue } from "./diagnostic-env.js";
import { redactDiagnosticText } from "./diagnostic-redactor.js";
import { observeTelemetry } from "./http-telemetry-guard.js";
import { boundedText } from "./resolver-telemetry.js";

/** Internal capture facts, isolated across concurrent calls and never attached to caller results. */
export type CapabilityFacts = { status?: number; finishReason?: string; diagnostics?: string };
export const capabilityFacts = new AsyncLocalStorage<CapabilityFacts>();
const metadata = new WeakMap<object, { backend: string; engine: string; model?: string }>();
export function tagCapability<T extends object>(
	context: T,
	facts: { backend: string; engine: string; model?: string },
): T {
	metadata.set(context, facts);
	return context;
}
export function capabilityMetadata(context: object) {
	return metadata.get(context);
}
export function captureCapability(facts: CapabilityFacts): void {
	const current = capabilityFacts.getStore();
	if (current) Object.assign(current, facts);
}
export function registerCapabilityInput(input: {
	kind: string;
	data?: string;
	url?: string;
}): void {
	// Payloads are measurements, never redaction needles. Only bounded URLs belong
	// in the request inventory; structural stripping covers oversized URL echoes.
	if (input.kind === "url" && input.url && Buffer.byteLength(input.url) <= 2048)
		registerDiagnosticValue(input.url.trim());
}
/**
 * Formats capability diagnostics after credential redaction.
 * When `stripPayload` is enabled, long base64-shaped runs are replaced as a
 * defence in depth; this may replace an unregistered long identifier, while
 * protecting against the more likely case of payload data in an upstream body.
 */
export function capabilityText(
	value: string,
	redact?: (text: string) => string,
	stripPayload = false,
): string {
	const stripped = value
		.replace(
			/(?:authorization|proxy-authorization|cookie|set-cookie)\s*["']?\s*[:=]\s*[^\r\n]+/gi,
			"[REDACTED]",
		)
		.replace(/Bearer\s+[^\r\n]+/gi, "[REDACTED]")
		.replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED]")
		.replace(/data:[^\s"']+/gi, "[BASE64_STRIPPED]");
	return boundedText(
		stripPayload ? stripped.replace(/[A-Za-z0-9+/=]{64,}/g, "[BASE64_STRIPPED]") : stripped,
		(text) => redactDiagnosticText(text, redact),
	);
}
export function capabilityErrorText(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const details = "details" in error ? error.details : undefined;
	const body =
		details && typeof details === "object" && "body" in details ? details.body : undefined;
	return `${error.message}${typeof body === "string" ? ` ${body}` : ""}`;
}
export const integer = (n: number | undefined) =>
	Math.min(
		Number.MAX_SAFE_INTEGER,
		Math.max(0, Math.floor(Number.isFinite(n ?? 0) ? (n ?? 0) : 0)),
	);
export const add = (a: number, b: number) =>
	Math.min(Number.MAX_SAFE_INTEGER, integer(a) + integer(b));
export function inputBytes(input: { kind: string; data?: string }): number | undefined {
	if (input.kind !== "base64" || input.data === undefined) return undefined;
	return Buffer.byteLength(input.data.trim(), "base64");
}
/** All capability hooks use the HTTP observer guard, including failure reporting. */
export function observeCapability(
	sink: { markTelemetryFailed?(): void },
	callback: () => unknown,
): void {
	observeTelemetry(callback, () => {
		observeTelemetry(
			() => sink.markTelemetryFailed?.(),
			() => {},
		);
	});
}

// Only server-enrolled capability spans use the request root; standalone instrumentation
// continues to use its caller's active span. No existing namespace changes parentage.
type RootRunner = <T>(callback: () => Promise<T>) => Promise<T>;
const roots = new WeakMap<object, RootRunner>();
export function bindCapabilityRoot<T extends object>(context: T, run: RootRunner): T {
	roots.set(context, run);
	return context;
}
export function runCapabilitySpan<T>(context: object, callback: () => Promise<T>): Promise<T> {
	return roots.get(context)?.(callback) ?? callback();
}
