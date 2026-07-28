import {
	NOOP_STATEFUL_PROVIDER_METRIC_EMITTER,
	type StatefulProviderMetricEmitter,
} from "./stateful-provider-observability.js";
import type {
	SessionOwnerRecord,
	SessionOwnerRegistry,
	SessionOwnerStatus,
} from "./stateful-provider-session-runtime.js";

export {
	forwardingContextFromStatefulRuntimeContext,
	isStatefulOperationRuntimeContext,
	providerContextFromStatefulRuntimeContext,
	type StatefulForwardingRuntimeContext,
	type StatefulLocalRuntimeContext,
	type StatefulOperationRuntimeContext,
	statefulForwardingContextFromProviderRequest,
	withStatefulLocalProviderContext,
} from "./stateful-provider-runtime-context.js";

export interface StatefulOperationRequest<TInput = unknown> {
	readonly requestId: string;
	readonly sessionKey: string;
	readonly providerId: string;
	readonly operationId: string;
	readonly connectionId: string;
	readonly serviceAccountId: string;
	readonly input: TInput;
	readonly idempotencyKey?: string;
	readonly deadlineAt?: string;
	readonly runtimeContext?: unknown;
}

export interface StatefulOperationResult<TOutput = unknown> {
	readonly output: TOutput;
}

export interface StatefulOwnerPod {
	readonly podId: string;
	readonly endpoint: string;
}

export interface StatefulOperationExecutor<_TSession = unknown> {
	executeLocal(
		request: StatefulOperationRequest,
		owner: SessionOwnerRecord,
		signal: AbortSignal,
	): Promise<StatefulOperationResult>;
}

export interface StatefulOwnerForwarder {
	forward(
		owner: SessionOwnerRecord,
		request: StatefulOperationRequest,
		signal: AbortSignal,
	): Promise<StatefulOperationResult>;
}

export interface StatefulSessionRouterOptions {
	readonly currentPod: StatefulOwnerPod;
	readonly registry: SessionOwnerRegistry;
	readonly forwarder: StatefulOwnerForwarder;
	readonly executor: StatefulOperationExecutor;
	readonly leaseDurationMs: number;
	readonly ownerStatus?: Exclude<SessionOwnerStatus, "expired">;
	readonly clock?: () => Date;
	readonly metricEmitter?: StatefulProviderMetricEmitter;
}

type DeadlineSignal = {
	readonly signal: AbortSignal;
	readonly cleanup: () => void;
};

export class StatefulRoutingDeadlineError extends Error {
	readonly requestId: string;
	readonly deadlineAt: string;

	constructor(requestId: string, deadlineAt: string) {
		super(`Stateful operation request ${requestId} deadline has expired.`);
		this.name = "StatefulRoutingDeadlineError";
		this.requestId = requestId;
		this.deadlineAt = deadlineAt;
	}
}

export class StatefulRoutingOwnershipError extends Error {
	readonly requestId: string;
	readonly sessionKey: string;

	constructor(requestId: string, sessionKey: string, message: string) {
		super(message);
		this.name = "StatefulRoutingOwnershipError";
		this.requestId = requestId;
		this.sessionKey = sessionKey;
	}
}

export class StatefulSessionRouter {
	readonly #currentPod: StatefulOwnerPod;
	readonly #registry: SessionOwnerRegistry;
	readonly #forwarder: StatefulOwnerForwarder;
	readonly #executor: StatefulOperationExecutor;
	readonly #leaseDurationMs: number;
	readonly #ownerStatus: Exclude<SessionOwnerStatus, "expired">;
	readonly #clock: () => Date;
	readonly #metricEmitter: StatefulProviderMetricEmitter;

	constructor(options: StatefulSessionRouterOptions) {
		validateRouterLeaseDuration(options.leaseDurationMs);
		this.#currentPod = options.currentPod;
		this.#registry = options.registry;
		this.#forwarder = options.forwarder;
		this.#executor = options.executor;
		this.#leaseDurationMs = options.leaseDurationMs;
		this.#ownerStatus = options.ownerStatus ?? "connected";
		this.#clock = options.clock ?? (() => new Date());
		this.#metricEmitter = options.metricEmitter ?? NOOP_STATEFUL_PROVIDER_METRIC_EMITTER;
	}

	async route<TInput = unknown>(
		request: StatefulOperationRequest<TInput>,
	): Promise<StatefulOperationResult> {
		const now = this.#clock();
		if (isExpiredDeadline(request, now)) {
			this.#metricEmitter.increment("apifuse_stateful_provider_routing_deadline_expired_total", {
				requestId: request.requestId,
				providerId: request.providerId,
				connectionId: request.connectionId,
				serviceAccountId: request.serviceAccountId,
				operationId: request.operationId,
				sessionKey: request.sessionKey,
				redactedErrorCode: "deadline_expired",
			});
			throw new StatefulRoutingDeadlineError(request.requestId, request.deadlineAt);
		}
		const deadlineSignal = makeDeadlineSignal(request, now);

		try {
			const resolved = await this.#registry.resolve(request.sessionKey, now);
			if (resolved) return this.routeToOwner(request, resolved, deadlineSignal);

			const acquired = await this.#registry.acquire({
				sessionKey: request.sessionKey,
				ownerPodId: this.#currentPod.podId,
				ownerEndpoint: this.#currentPod.endpoint,
				leaseDurationMs: this.#leaseDurationMs,
				status: this.#ownerStatus,
				now,
			});
			this.#metricEmitter.increment(
				"apifuse_stateful_provider_routing_reacquire_total",
				metricLabels(request, acquired.record),
			);
			return this.routeToOwner(request, acquired.record, deadlineSignal);
		} finally {
			deadlineSignal.cleanup();
		}
	}

	private routeToOwner<TInput = unknown>(
		request: StatefulOperationRequest<TInput>,
		owner: SessionOwnerRecord,
		deadlineSignal: DeadlineSignal,
	): Promise<StatefulOperationResult> {
		if (owner.sessionKey !== request.sessionKey) {
			throw new StatefulRoutingOwnershipError(
				request.requestId,
				request.sessionKey,
				"Resolved stateful session owner does not match request session key.",
			);
		}
		if (owner.ownerPodId === this.#currentPod.podId) {
			this.#metricEmitter.increment(
				"apifuse_stateful_provider_routing_local_total",
				metricLabels(request, owner),
			);
			return this.#executor.executeLocal(request, owner, deadlineSignal.signal);
		}
		this.#metricEmitter.increment(
			"apifuse_stateful_provider_routing_forward_total",
			metricLabels(request, owner),
		);
		return this.#forwarder.forward(owner, request, deadlineSignal.signal);
	}
}

function metricLabels(
	request: StatefulOperationRequest,
	owner: SessionOwnerRecord,
): {
	readonly requestId: string;
	readonly providerId: string;
	readonly connectionId: string;
	readonly serviceAccountId: string;
	readonly operationId: string;
	readonly sessionKey: string;
	readonly ownerPodId: string;
	readonly generation: number;
} {
	return {
		requestId: request.requestId,
		providerId: request.providerId,
		connectionId: request.connectionId,
		serviceAccountId: request.serviceAccountId,
		operationId: request.operationId,
		sessionKey: request.sessionKey,
		ownerPodId: owner.ownerPodId,
		generation: owner.generation,
	};
}

function validateRouterLeaseDuration(leaseDurationMs: number): void {
	if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
		throw new Error("Stateful session router leaseDurationMs must be a positive finite number.");
	}
}

function isExpiredDeadline<TInput>(
	request: StatefulOperationRequest<TInput>,
	now: Date,
): request is StatefulOperationRequest<TInput> & {
	readonly deadlineAt: string;
} {
	if (!request.deadlineAt) return false;
	const deadlineMs = Date.parse(request.deadlineAt);
	return !Number.isFinite(deadlineMs) || deadlineMs <= now.getTime();
}

function makeDeadlineSignal<TInput>(
	request: StatefulOperationRequest<TInput>,
	now: Date,
): DeadlineSignal {
	const controller = new AbortController();
	if (!request.deadlineAt) {
		return { signal: controller.signal, cleanup: () => {} };
	}

	const delayMs = Date.parse(request.deadlineAt) - now.getTime();
	const timer = setTimeout(() => controller.abort(), delayMs);
	return {
		signal: controller.signal,
		cleanup: () => clearTimeout(timer),
	};
}
