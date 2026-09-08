import {
	encodeDiagnosticControls,
	isSensitiveFixtureKey,
	REDACTED_FIXTURE_VALUE,
	sanitizeDiagnosticText,
} from "./fixture-sanitization.js";
import {
	type DiagnosticRedactor,
	diagnosticStructuredRedactor,
	redactDiagnosticAttributeKey,
	copyDiagnosticAttributeTypes,
	isDiagnosticBigintAttribute,
	redactedKeyAllocator,
	isRedactedKey,
	redactCriticalDiagnosticText,
	diagnosticAttributeRedactor,
	REDACTION_FAILED,
	redactDiagnosticText,
} from "./runtime/diagnostic-redactor.js";
import type { TraceSpan } from "./types.js";

const MAX_TRACE_TEXT_LENGTH = 300;

function sanitizeTraceText(value: string, redact?: DiagnosticRedactor): string {
	const encoded = sanitizeDiagnosticText(redactDiagnosticText(value, redact));
	return encoded.length > MAX_TRACE_TEXT_LENGTH
		? `${encoded.slice(0, MAX_TRACE_TEXT_LENGTH)}… [truncated]`
		: encoded;
}

/** Span names are SDK-authored identifiers; retain them while preventing log injection. */
export function sanitizeSpanNameForOutput(value: string, redact?: DiagnosticRedactor): string {
	const encoded = encodeDiagnosticControls(redactDiagnosticText(value, redact));
	return encoded.length > MAX_TRACE_TEXT_LENGTH
		? `${encoded.slice(0, MAX_TRACE_TEXT_LENGTH)}… [truncated]`
		: encoded;
}

export function sanitizeTraceAttributes(
	attributes: Record<string, unknown>,
	redact?: DiagnosticRedactor,
	reservedKeys: Iterable<string> = [],
): Record<string, string | number | boolean> {
	const nextKey = redactedKeyAllocator([...Object.keys(attributes), ...reservedKeys]);
	return copyDiagnosticAttributeTypes(
		attributes,
		Object.fromEntries(
			Object.entries(attributes).map(([key, value]) => {
				const redactedKey = isRedactedKey(key) ? key : redactDiagnosticAttributeKey(key, redact);
				const keyChanged = redactedKey !== key;
				const sanitizedKey = keyChanged ? nextKey() : sanitizeTraceText(key);
				const valueRedactor =
					typeof value === "bigint" || isDiagnosticBigintAttribute(attributes, key)
						? diagnosticStructuredRedactor(redact)
						: diagnosticAttributeRedactor(key, redact);
				const sanitizedValue = keyChanged
					? redactedKey === REDACTION_FAILED
						? REDACTION_FAILED
						: REDACTED_FIXTURE_VALUE
					: isSensitiveFixtureKey(key)
						? REDACTED_FIXTURE_VALUE
						: typeof value === "bigint" || isDiagnosticBigintAttribute(attributes, key)
							? String(value).length < 8
								? String(value)
								: sanitizeTraceText(String(value), valueRedactor)
							: typeof value === "string"
								? sanitizeTraceText(value, valueRedactor)
								: typeof value === "number" || typeof value === "boolean"
									? (() => {
											if (String(value).length < 8) return value;
											const redacted = redactDiagnosticText(
												String(value),
												diagnosticStructuredRedactor(valueRedactor),
											);
											return redacted === String(value) ? value : sanitizeTraceText(redacted);
										})()
									: sanitizeTraceText(String(value), valueRedactor);
				return [sanitizedKey, sanitizedValue];
			}),
		),
	);
}

export function sanitizeSpanForOutput(
	span: TraceSpan,
	additionalAttributes?: Record<string, string>,
	redact?: DiagnosticRedactor,
): TraceSpan {
	// Keep this schema explicit so future fields are not silently added to a
	// process output path before their trust boundary has been reviewed.
	return {
		id: redactCriticalDiagnosticText(span.id, redact),
		name: sanitizeSpanNameForOutput(redactCriticalDiagnosticText(span.name, redact)),
		startedAt: span.startedAt,
		endedAt: span.endedAt,
		duration_ms: span.duration_ms,
		status: span.status,
		attributes: sanitizeTraceAttributes(
			copyDiagnosticAttributeTypes(span.attributes, {
				...span.attributes,
				...(additionalAttributes ?? {}),
			}),
			redact,
		),
		...(span.error !== undefined ? { error: sanitizeTraceText(span.error, redact) } : {}),
		...(span.parentId !== undefined
			? { parentId: redactCriticalDiagnosticText(span.parentId, redact) }
			: {}),
	};
}
