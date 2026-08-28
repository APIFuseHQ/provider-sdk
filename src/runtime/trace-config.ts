import type { TraceConfig } from "../types.js";

/** SDK-owned environment variable names for server trace output. */
export const APIFUSE__TRACE__ENABLED = "APIFUSE__TRACE__ENABLED";
export const APIFUSE__TRACE__EXPORTER = "APIFUSE__TRACE__EXPORTER";

type EnvLike = Record<string, string | undefined>;

const TRACE_EXPORTER_LOOKUP: Record<Exclude<NonNullable<TraceConfig["exporter"]>, "otlp">, true> = {
	console: true,
	json: true,
	none: true,
};
const TRACE_EXPORTERS = new Set(Object.keys(TRACE_EXPORTER_LOOKUP));

const emittedWarnings = new Set<string>();

function warnOnce(key: string, message: string): void {
	if (emittedWarnings.has(key)) return;
	emittedWarnings.add(key);
	console.warn(message);
}

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
			warnOnce(
				APIFUSE__TRACE__ENABLED,
				"[apifuse] Invalid APIFUSE__TRACE__ENABLED; falling back to disabled tracing.",
			);
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

	if (enabledRaw === undefined && exporterRaw === undefined) {
		return undefined;
	}

	const enabled = parseEnabled(enabledRaw);
	const normalizedExporter = exporterRaw?.trim().toLowerCase();
	const exporter = TRACE_EXPORTERS.has(normalizedExporter as NonNullable<TraceConfig["exporter"]>)
		? (normalizedExporter as NonNullable<TraceConfig["exporter"]>)
		: exporterRaw === undefined
			? undefined
			: "none";
	if (exporterRaw !== undefined && exporter === "none" && normalizedExporter !== "none") {
		warnOnce(
			APIFUSE__TRACE__EXPORTER,
			`[apifuse] Invalid APIFUSE__TRACE__EXPORTER value "${normalizedExporter ?? exporterRaw}" (OTLP is unsupported for server output); supported exporters are "console", "json", and "none"; falling back to exporter "none".`,
		);
	}

	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(exporter !== undefined ? { exporter } : {}),
	};
}
