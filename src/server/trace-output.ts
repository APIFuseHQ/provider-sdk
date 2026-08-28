import {
	isSensitiveFixtureKey,
	REDACTED_FIXTURE_VALUE,
	sanitizeDiagnosticText,
} from "../fixture-sanitization.js";
import {
	resolveTraceContextOptions,
	type CreateTraceContextOptions,
	type Span,
} from "../runtime/trace.js";
import type { TraceConfig } from "../types.js";
import { redactSelfTestText } from "./self-test-redaction.js";

function sanitizeTraceText(value: string): string {
	return redactSelfTestText(sanitizeDiagnosticText(value), []);
}

function sanitizeSpanForOutput(span: Span): Span {
	const attributes = Object.fromEntries(
		Object.entries(span.attributes).map(([key, value]) => [
			sanitizeTraceText(key),
			isSensitiveFixtureKey(key)
				? REDACTED_FIXTURE_VALUE
				: typeof value === "string"
					? sanitizeTraceText(value)
					: value,
		]),
	);

	// Keep this schema explicit so future fields are not silently added to a
	// process output path before their trust boundary has been reviewed.
	return {
		id: span.id,
		name: sanitizeTraceText(span.name),
		startedAt: span.startedAt,
		endedAt: span.endedAt,
		duration_ms: span.duration_ms,
		status: span.status,
		attributes,
		...(span.error !== undefined ? { error: sanitizeTraceText(span.error) } : {}),
		...(span.parentId !== undefined ? { parentId: span.parentId } : {}),
	};
}

/** Server-only trace output policy. Shared programmatic trace callers stay in-memory. */
export function resolveServerTraceContextOptions(
	config: TraceConfig,
	resourceAttributes: Record<string, string>,
): CreateTraceContextOptions {
	const resolved = resolveTraceContextOptions(config);
	const outputEnabled = config.enabled !== false && config.exporter !== "none";
	const consoleHook =
		outputEnabled && (config.exporter === "console" || config.exporter === "json")
			? (span: Span) => console.log(JSON.stringify(sanitizeSpanForOutput(span)))
			: undefined;
	const onSpan =
		consoleHook && resolved.onSpan
			? (span: Span) => {
					consoleHook(span);
					resolved.onSpan?.(span);
				}
			: (consoleHook ?? resolved.onSpan);

	return {
		maxSpans: resolved.maxSpans,
		onSpan,
		exportOptions: outputEnabled && config.exporter === "otlp" ? resolved.exportOptions : undefined,
		resourceAttributes: { ...resourceAttributes },
	};
}
