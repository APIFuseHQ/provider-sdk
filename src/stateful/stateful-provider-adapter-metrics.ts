import type { StatefulProviderMetricEmitter } from "./stateful-provider-observability.js";
import type { StatefulOperationRequest } from "./stateful-provider-session-routing.js";
import type { SessionOwnerRecord } from "./stateful-provider-session-runtime.js";

export function observeStatefulSessionOperationDuration(input: {
	readonly metricEmitter: StatefulProviderMetricEmitter;
	readonly request: StatefulOperationRequest;
	readonly owner: SessionOwnerRecord;
	readonly durationMs: number;
}): void {
	input.metricEmitter.observe(
		"apifuse_stateful_provider_session_operation_duration_ms",
		statefulSessionMetricLabels(input.request, input.owner),
		Math.max(0, input.durationMs),
	);
}

export function emitStatefulSessionInvalidatedMetric(input: {
	readonly metricEmitter: StatefulProviderMetricEmitter;
	readonly request: StatefulOperationRequest;
	readonly owner: SessionOwnerRecord;
	readonly reason: string;
}): void {
	input.metricEmitter.increment(
		"apifuse_stateful_provider_session_invalidations_total",
		statefulSessionMetricLabels(input.request, input.owner, {
			redactedErrorCode: input.reason,
		}),
	);
}

function statefulSessionMetricLabels(
	request: StatefulOperationRequest,
	owner: SessionOwnerRecord,
	extra: { readonly redactedErrorCode?: string } = {},
) {
	return {
		requestId: request.requestId,
		providerId: request.providerId,
		connectionId: request.connectionId,
		serviceAccountId: request.serviceAccountId,
		operationId: request.operationId,
		sessionKey: request.sessionKey,
		ownerPodId: owner.ownerPodId,
		generation: owner.generation,
		...extra,
	};
}
