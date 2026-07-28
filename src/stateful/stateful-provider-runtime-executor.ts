import type { SessionKey } from "./session-key.js";
import type { StatefulProviderMetricEmitter } from "./stateful-provider-observability.js";
import {
	type StatefulOperationExecutor,
	type StatefulOperationRequest,
	type StatefulOperationResult,
	type StatefulOwnerForwarder,
	type StatefulOwnerPod,
	StatefulSessionRouter,
} from "./stateful-provider-session-routing.js";
import type { SessionOwnerRegistry } from "./stateful-provider-session-runtime.js";

export interface StatefulProviderInvocationMetadata<TInput = unknown> {
	readonly requestId: string;
	readonly sessionKey: SessionKey;
	readonly providerId: string;
	readonly operationId: string;
	readonly connectionId: string;
	readonly serviceAccountId: string;
	readonly input: TInput;
	readonly idempotencyKey?: string;
	readonly deadlineAt?: string;
	readonly runtimeContext?: unknown;
}

export interface StatefulProviderRuntimeExecutorOptions {
	readonly currentPod: StatefulOwnerPod;
	readonly registry: SessionOwnerRegistry;
	readonly forwarder: StatefulOwnerForwarder;
	readonly executor: StatefulOperationExecutor;
	readonly leaseDurationMs: number;
	readonly leaseRenewalFraction?: number;
	readonly clock?: () => Date;
	readonly metricEmitter?: StatefulProviderMetricEmitter;
}

export class StatefulProviderRuntimeExecutor {
	readonly #router: StatefulSessionRouter;

	constructor(options: StatefulProviderRuntimeExecutorOptions) {
		this.#router = new StatefulSessionRouter({
			currentPod: options.currentPod,
			registry: options.registry,
			forwarder: options.forwarder,
			executor: options.executor,
			leaseDurationMs: options.leaseDurationMs,
			...(options.leaseRenewalFraction !== undefined
				? { leaseRenewalFraction: options.leaseRenewalFraction }
				: {}),
			...(options.clock ? { clock: options.clock } : {}),
			...(options.metricEmitter ? { metricEmitter: options.metricEmitter } : {}),
		});
	}

	invoke(request: StatefulOperationRequest): Promise<StatefulOperationResult> {
		return this.#router.route(request);
	}

	release(): Promise<void> {
		return this.#router.release();
	}

	releaseSession(sessionKey: SessionKey): Promise<boolean> {
		return this.#router.releaseSession(sessionKey);
	}
}

export function buildStatefulOperationRequest<TInput>(
	metadata: StatefulProviderInvocationMetadata<TInput>,
): StatefulOperationRequest<TInput> {
	requireNonEmpty(metadata.requestId, "requestId");
	requireNonEmpty(metadata.sessionKey, "sessionKey");
	requireNonEmpty(metadata.providerId, "providerId");
	requireNonEmpty(metadata.operationId, "operationId");
	requireNonEmpty(metadata.connectionId, "connectionId");
	requireNonEmpty(metadata.serviceAccountId, "serviceAccountId");

	return {
		requestId: metadata.requestId,
		sessionKey: metadata.sessionKey,
		providerId: metadata.providerId,
		operationId: metadata.operationId,
		connectionId: metadata.connectionId,
		serviceAccountId: metadata.serviceAccountId,
		input: metadata.input,
		...(metadata.idempotencyKey ? { idempotencyKey: metadata.idempotencyKey } : {}),
		...(metadata.deadlineAt ? { deadlineAt: metadata.deadlineAt } : {}),
		...(metadata.runtimeContext !== undefined ? { runtimeContext: metadata.runtimeContext } : {}),
	};
}

function requireNonEmpty(value: string, field: string): void {
	if (value.trim().length === 0) {
		throw new Error(`Stateful provider invocation ${field} is required.`);
	}
}
