import { statefulProviderMetricRegistry } from "../stateful/stateful-provider-metric-registry.js";

/**
 * The provider's metrics listener: a SEPARATE socket next to the primary
 * listener, serving only `GET /metrics` in the Prometheus text exposition
 * format from the process-wide stateful metric registry. Always on; the
 * port comes from `ServeOptions.metricsPort`, else
 * `APIFUSE__PROVIDER_RUNTIME__METRICS_PORT`, else 9090, the metrics port of
 * the other APIFuse services. Keeping it off the primary port leaves that
 * port's network boundary as it is: the generated provider NetworkPolicy
 * admits only the gateway there, and admits Prometheus on this port alone.
 */
export const PROVIDER_METRICS_ROUTE = "/metrics";
export const PROVIDER_METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
export const DEFAULT_PROVIDER_METRICS_PORT = 9090;
export const PROVIDER_RUNTIME_METRICS_PORT_ENV = "APIFUSE__PROVIDER_RUNTIME__METRICS_PORT";

export function resolveProviderMetricsPort(
	env: Readonly<Record<string, string | undefined>> = process.env,
): number {
	const raw = env[PROVIDER_RUNTIME_METRICS_PORT_ENV];
	const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
	return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
		? parsed
		: DEFAULT_PROVIDER_METRICS_PORT;
}

/** The metrics listener's fetch handler: `GET /metrics`, everything else 404. */
export function providerMetricsFetch(request: Request): Response {
	if (request.method === "GET" && new URL(request.url).pathname === PROVIDER_METRICS_ROUTE) {
		return new Response(statefulProviderMetricRegistry.render(), {
			headers: { "content-type": PROVIDER_METRICS_CONTENT_TYPE, "cache-control": "no-store" },
		});
	}
	return new Response("Not Found", { status: 404 });
}
