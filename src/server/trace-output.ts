import { isSensitiveFixtureKey, REDACTED_FIXTURE_VALUE } from "../fixture-sanitization.js";
import {
	type DiagnosticRedactor,
	redactedKeyAllocator,
	isRedactedKey,
	REDACTION_FAILED,
	redactDiagnosticText,
} from "../runtime/diagnostic-redactor.js";
import {
	OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
	type OTLPExportOptions,
	type OTLPExportResolution,
	type OTLPResourceResolution,
	resolveOTLPExportOptions,
	resolveOTLPResourceAttributes,
} from "../runtime/otlp.js";
import {
	type CreateTraceContextOptions,
	resolveTraceContextOptions,
	type Span,
} from "../runtime/trace.js";
import {
	sanitizeSpanForOutput,
	sanitizeSpanNameForOutput,
	sanitizeTraceAttributes,
} from "../trace-sanitization.js";
import type { TraceConfig } from "../types.js";

type EnvLike = Record<string, string | undefined>;

const TRACE_RESOURCE_ATTRIBUTE_SANITIZER = Symbol.for(
	"@apifuse/provider-sdk/runtime/trace-resource-attribute-sanitizer",
);

type ResourceAttributesWithSanitizer = Record<string, string> & {
	[TRACE_RESOURCE_ATTRIBUTE_SANITIZER]?: (
		attributes: Record<string, string>,
	) => Record<string, string>;
};

// Warn once per environment object: process.env in production, each injected env in tests.
const warnedEnvironments = new WeakSet<EnvLike>();
const warnedResourceEnvironments = new WeakSet<EnvLike>();

function warnDiscardedResourceAttributes(env: EnvLike, resolution: OTLPResourceResolution): void {
	if (resolution.discarded.length === 0 || warnedResourceEnvironments.has(env)) return;
	warnedResourceEnvironments.add(env);
	console.warn(
		`[apifuse] ${resolution.discarded.join(", ")} could not be parsed as an OTel key=value list and was ignored.`,
	);
}

function warnExportDisabled(
	env: EnvLike,
	resolution: Exclude<OTLPExportResolution, { status: "resolved" }>,
): void {
	if (warnedEnvironments.has(env)) return;
	warnedEnvironments.add(env);
	console.warn(
		resolution.status === "unconfigured"
			? `[apifuse] OTLP trace export is enabled but no endpoint is configured; set ${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT} or ${OTEL_EXPORTER_OTLP_ENDPOINT}. Trace export is disabled.`
			: `[apifuse] OTLP trace export is enabled but ${resolution.source} ${resolution.reason}. Trace export is disabled.`,
	);
}

function resolveServerOTLPExportOptions(
	config: TraceConfig,
	env: EnvLike,
): OTLPExportOptions | undefined {
	const resolution = resolveOTLPExportOptions(
		{
			endpoint: config.otlp?.endpoint ?? config.endpoint,
			headers: config.otlp?.headers,
			timeout: config.otlp?.timeout,
		},
		env,
	);
	if (resolution.status === "resolved") return resolution.options;
	warnExportDisabled(env, resolution);
	return undefined;
}

/**
 * Per-request attributes carry client-supplied values (request_id) and get the full attribute
 * sanitizer, exactly as on the console path. Operator-configured attributes from the process
 * environment are identifiers rather than request data: their values are kept, with control
 * characters neutralized, length bounded, and secret-named keys redacted.
 */
function resolveExportResourceAttributes(
	requestAttributes: Record<string, string>,
	env: EnvLike,
	redact?: DiagnosticRedactor,
): {
	attributes: Record<string, string>;
	sanitize: (attributes: Record<string, string>) => Record<string, string>;
} {
	const resolution = resolveOTLPResourceAttributes({}, env);
	warnDiscardedResourceAttributes(env, resolution);
	const operatorAttributes = resolution.attributes;
	const requestKeys = new Set(Object.keys(requestAttributes));
	return {
		// Keep the raw snapshot private until export. A credential registered after
		// trace creation must be matched before any key or value is bounded.
		attributes: { ...operatorAttributes, ...requestAttributes },
		sanitize(attributes) {
			const nextKey = redactedKeyAllocator(Object.keys(attributes));
			const sanitizedOperatorAttributes: Record<string, string> = {};
			const rawRequestAttributes: Record<string, string> = {};
			for (const [key, value] of Object.entries(attributes)) {
				const unchangedOperatorValue = !requestKeys.has(key) && operatorAttributes[key] === value;
				if (unchangedOperatorValue) {
					const redactedKey = isRedactedKey(key) ? key : redactDiagnosticText(key, redact);
					const keyChanged = redactedKey !== key;
					const sanitizedKey = keyChanged ? nextKey() : sanitizeSpanNameForOutput(key);
					sanitizedOperatorAttributes[sanitizedKey] = keyChanged
						? redactedKey === REDACTION_FAILED
							? REDACTION_FAILED
							: REDACTED_FIXTURE_VALUE
						: isSensitiveFixtureKey(key)
							? REDACTED_FIXTURE_VALUE
							: sanitizeSpanNameForOutput(value, redact);
				} else {
					rawRequestAttributes[key] = value;
				}
			}
			const sanitizedRequestAttributes = Object.fromEntries(
				Object.entries(
					sanitizeTraceAttributes(
						rawRequestAttributes,
						redact,
						Object.keys(sanitizedOperatorAttributes),
					),
				).map(([key, value]) => [key, String(value)]),
			);
			return { ...sanitizedOperatorAttributes, ...sanitizedRequestAttributes };
		},
	};
}

/** Server-only trace output policy. Shared programmatic trace callers stay in-memory. */
export function resolveServerTraceContextOptions(
	config: TraceConfig,
	resourceAttributes: Record<string, string>,
	env: EnvLike = process.env,
	redact?: DiagnosticRedactor,
): CreateTraceContextOptions {
	const resolved = resolveTraceContextOptions(config);
	const outputEnabled = config.enabled !== false && config.exporter !== "none";
	const consoleHook =
		outputEnabled && (config.exporter === "console" || config.exporter === "json")
			? (span: Span) =>
					console.log(JSON.stringify(sanitizeSpanForOutput(span, resourceAttributes, redact)))
			: undefined;
	const onSpan =
		consoleHook && resolved.onSpan
			? (span: Span) => {
					consoleHook(span);
					resolved.onSpan?.(span);
				}
			: (consoleHook ?? resolved.onSpan);
	const exportOptions =
		outputEnabled && config.exporter === "otlp"
			? resolveServerOTLPExportOptions(config, env)
			: undefined;
	const exportResources = exportOptions
		? resolveExportResourceAttributes(resourceAttributes, env, redact)
		: undefined;
	if (exportResources) {
		Object.defineProperty(
			exportResources.attributes as ResourceAttributesWithSanitizer,
			TRACE_RESOURCE_ATTRIBUTE_SANITIZER,
			{ value: exportResources.sanitize },
		);
	}

	return {
		maxSpans: resolved.maxSpans,
		onSpan,
		...(redact ? { redact } : {}),
		...(exportOptions
			? {
					exportOptions,
					resourceAttributes: exportResources?.attributes,
					sanitizeSpanForExport: (span: Span) => sanitizeSpanForOutput(span, undefined, redact),
				}
			: {}),
	};
}
