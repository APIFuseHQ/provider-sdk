import type { TraceConfig } from "../types.js";

/** SDK-owned environment variable names for server trace output. */
export const APIFUSE__TRACE__ENABLED = "APIFUSE__TRACE__ENABLED";
export const APIFUSE__TRACE__EXPORTER = "APIFUSE__TRACE__EXPORTER";
export const APIFUSE__TRACE__OTLP__ENDPOINT = "APIFUSE__TRACE__OTLP__ENDPOINT";

type EnvLike = Record<string, string | undefined>;

const TRACE_EXPORTERS = new Set<NonNullable<TraceConfig["exporter"]>>([
	"console",
	"json",
	"otlp",
	"none",
]);

function parseEnabled(raw: string | undefined): boolean | undefined {
	if (raw === undefined) return undefined;
	switch (raw.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return false;
	}
}

/**
 * Resolve server trace output configuration from SDK-owned environment
 * variables. Invalid exporter values fail closed so a provider cannot crash at
 * startup because of an observability setting.
 */
export function resolveTraceConfigFromEnv(env: EnvLike = process.env): TraceConfig | undefined {
	const enabledRaw = env[APIFUSE__TRACE__ENABLED];
	const exporterRaw = env[APIFUSE__TRACE__EXPORTER];
	const endpoint = env[APIFUSE__TRACE__OTLP__ENDPOINT]?.trim() || undefined;

	if (enabledRaw === undefined && exporterRaw === undefined && endpoint === undefined) {
		return undefined;
	}

	const enabled = parseEnabled(enabledRaw);
	const normalizedExporter = exporterRaw?.trim().toLowerCase();
	const exporter = TRACE_EXPORTERS.has(normalizedExporter as NonNullable<TraceConfig["exporter"]>)
		? (normalizedExporter as NonNullable<TraceConfig["exporter"]>)
		: exporterRaw === undefined
			? undefined
			: "none";

	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(exporter !== undefined ? { exporter } : {}),
		...(endpoint ? { otlp: { endpoint } } : {}),
	};
}
