import {
	encodeDiagnosticControls,
	isSensitiveFixtureKey,
	REDACTED_FIXTURE_VALUE,
	sanitizeDiagnosticText,
} from "./fixture-sanitization.js";
import type { TraceSpan } from "./types.js";

const MAX_TRACE_TEXT_LENGTH = 300;

function sanitizeTraceText(value: string): string {
	const encoded = sanitizeDiagnosticText(value);
	return encoded.length > MAX_TRACE_TEXT_LENGTH
		? `${encoded.slice(0, MAX_TRACE_TEXT_LENGTH)}… [truncated]`
		: encoded;
}

/** Span names are SDK-authored identifiers; retain them while preventing log injection. */
export function sanitizeSpanNameForOutput(value: string): string {
	const encoded = encodeDiagnosticControls(value);
	return encoded.length > MAX_TRACE_TEXT_LENGTH
		? `${encoded.slice(0, MAX_TRACE_TEXT_LENGTH)}… [truncated]`
		: encoded;
}

export function sanitizeTraceAttributes(
	attributes: Record<string, unknown>,
): Record<string, string | number | boolean> {
	return Object.fromEntries(
		Object.entries(attributes).map(([key, value]) => [
			sanitizeTraceText(key),
			isSensitiveFixtureKey(key)
				? REDACTED_FIXTURE_VALUE
				: typeof value === "string"
					? sanitizeTraceText(value)
					: typeof value === "number" || typeof value === "boolean"
						? value
						: sanitizeTraceText(String(value)),
		]),
	);
}

export function sanitizeSpanForOutput(
	span: TraceSpan,
	additionalAttributes?: Record<string, string>,
): TraceSpan {
	// Keep this schema explicit so future fields are not silently added to a
	// process output path before their trust boundary has been reviewed.
	return {
		id: span.id,
		name: sanitizeSpanNameForOutput(span.name),
		startedAt: span.startedAt,
		endedAt: span.endedAt,
		duration_ms: span.duration_ms,
		status: span.status,
		attributes: sanitizeTraceAttributes({
			...span.attributes,
			...(additionalAttributes ?? {}),
		}),
		...(span.error !== undefined ? { error: sanitizeTraceText(span.error) } : {}),
		...(span.parentId !== undefined ? { parentId: span.parentId } : {}),
	};
}
