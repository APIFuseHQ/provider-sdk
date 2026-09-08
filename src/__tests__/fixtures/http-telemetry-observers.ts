import { TransportError } from "../../errors.js";
import type {
	HttpTelemetryCollector,
	HttpTelemetryRequestSink,
	HttpTelemetrySink,
} from "../../runtime/http-telemetry.js";

export const observerHooks = [
	"startRequest",
	"recordAttempt",
	"finish",
	"toTenantRetryPayload",
	"onRetrySummary",
	"markTelemetryFailed",
] as const;
export type ObserverFault = { hook: (typeof observerHooks)[number]; garbage: boolean };
export const observerFaults = observerHooks.flatMap((hook) => [
	{ hook, garbage: false },
	{ hook, garbage: true },
]);

export function observerFailure(fault: ObserverFault): unknown {
	if (fault.garbage) return { attempts: Infinity, retries: -1, transport: "SENTINEL" };
	throw new TransportError("observer failed", { code: "transport_network_error", status: 0 });
}

export function faultingHttpSink(
	collector: HttpTelemetryCollector,
	fault: ObserverFault,
): HttpTelemetrySink {
	return {
		markTelemetryFailed() {
			collector.markTelemetryFailed();
			if (fault.hook === "markTelemetryFailed") observerFailure(fault);
		},
		startRequest(options) {
			if (fault.hook === "startRequest") {
				// test-invalid: exercise an untyped host observer returning a malformed request sink.
				return observerFailure(fault) as HttpTelemetryRequestSink;
			}
			const request = collector.startRequest(options);
			return {
				recordAttempt(event) {
					if (fault.hook === "markTelemetryFailed") throw new Error("trigger marker");
					if (fault.hook === "recordAttempt") return observerFailure(fault);
					request.recordAttempt(event);
				},
				finish(ms) {
					if (fault.hook === "finish") return observerFailure(fault);
					request.finish(ms);
				},
				toTenantRetryPayload() {
					if (fault.hook === "toTenantRetryPayload") {
						// test-invalid: exercise malformed values at the public observer boundary.
						return observerFailure(fault) as ReturnType<
							HttpTelemetryRequestSink["toTenantRetryPayload"]
						>;
					}
					return request.toTenantRetryPayload();
				},
			};
		},
	};
}
