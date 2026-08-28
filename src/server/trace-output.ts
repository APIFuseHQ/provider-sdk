import {
	resolveTraceContextOptions,
	type CreateTraceContextOptions,
	type Span,
} from "../runtime/trace.js";
import { sanitizeSpanForOutput } from "../trace-sanitization.js";
import type { TraceConfig } from "../types.js";

/** Server-only trace output policy. Shared programmatic trace callers stay in-memory. */
export function resolveServerTraceContextOptions(
	config: TraceConfig,
	resourceAttributes: Record<string, string>,
): CreateTraceContextOptions {
	const resolved = resolveTraceContextOptions(config);
	const outputEnabled = config.enabled !== false && config.exporter !== "none";
	const consoleHook =
		outputEnabled && (config.exporter === "console" || config.exporter === "json")
			? (span: Span) => console.log(JSON.stringify(sanitizeSpanForOutput(span, resourceAttributes)))
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
	};
}
