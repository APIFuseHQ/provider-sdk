import type { SessionKey } from "./session-key.js";
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
		validateOwnership?: StatefulOwnershipValidator,
	): Promise<StatefulOperationResult>;
}

export type StatefulOwnershipValidator = (
	owner: SessionOwnerRecord,
	signal: AbortSignal,
) => Promise<SessionOwnerRecord>;

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
	readonly leaseRenewalFraction?: number;
	/** @deprecated Acquired sessions always begin in the acquiring state. */
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
	readonly sessionKey: SessionKey;

	constructor(requestId: string, sessionKey: SessionKey, message: string) {
		super(message);
		this.name = "StatefulRoutingOwnershipError";
		this.requestId = requestId;
		this.sessionKey = sessionKey;
	}
}

type ManagedLease = {
	readonly sessionKey: SessionKey;
	record: SessionOwnerRecord;
	timer?: ReturnType<typeof setTimeout>;
};

const STATEFUL_SESSION_ESTABLISHMENT_FAILURE = Symbol.for(
	"@apifuse/provider-sdk/stateful/session-establishment-failure@1",
);

function isStatefulSessionEstablishmentFailure(error: unknown): boolean {
	if ((typeof error !== "object" || error === null) && typeof error !== "function") return false;
	return (
		Object.getOwnPropertyDescriptor(error, STATEFUL_SESSION_ESTABLISHMENT_FAILURE)?.value === true
	);
}

export class StatefulSessionRouter {
	readonly #currentPod: StatefulOwnerPod;
	readonly #registry: SessionOwnerRegistry;
	readonly #forwarder: StatefulOwnerForwarder;
	readonly #executor: StatefulOperationExecutor;
	readonly #leaseDurationMs: number;
	readonly #leaseRenewIntervalMs: number;
	readonly #clock: () => Date;
	readonly #metricEmitter: StatefulProviderMetricEmitter;
	readonly #managedLeases = new Map<SessionKey, ManagedLease>();

	constructor(options: StatefulSessionRouterOptions) {
		validateRouterLeaseDuration(options.leaseDurationMs);
		const renewalFraction = options.leaseRenewalFraction ?? 1 / 3;
		validateLeaseRenewalFraction(renewalFraction);
		this.#currentPod = options.currentPod;
		this.#registry = options.registry;
		this.#forwarder = options.forwarder;
		this.#executor = options.executor;
		this.#leaseDurationMs = options.leaseDurationMs;
		this.#leaseRenewIntervalMs = Math.max(1, Math.floor(options.leaseDurationMs * renewalFraction));
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
			const resolved = await this.#registry.resolve(request.sessionKey, now, deadlineSignal.signal);
			if (resolved) {
				validateOwnerGeneration(resolved);
				return await this.routeToOwner(request, resolved, deadlineSignal);
			}

			const acquired = await this.#registry.acquire(
				{
					sessionKey: request.sessionKey,
					ownerPodId: this.#currentPod.podId,
					ownerEndpoint: this.#currentPod.endpoint,
					leaseDurationMs: this.#leaseDurationMs,
					status: "acquiring",
					now,
				},
				deadlineSignal.signal,
			);
			validateOwnerGeneration(acquired.record);
			this.#metricEmitter.increment(
				"apifuse_stateful_provider_routing_reacquire_total",
				metricLabels(request, acquired.record),
			);
			return await this.routeToOwner(request, acquired.record, deadlineSignal);
		} finally {
			deadlineSignal.cleanup();
		}
	}

	async release(): Promise<void> {
		await Promise.all([...this.#managedLeases.keys()].map((key) => this.releaseSession(key)));
	}

	async releaseSession(sessionKey: SessionKey): Promise<boolean> {
		const managed = this.#managedLeases.get(sessionKey);
		if (!managed) return false;
		this.stopManagedLease(managed);
		this.#managedLeases.delete(sessionKey);
		return this.#registry.release({
			sessionKey,
			ownerPodId: managed.record.ownerPodId,
			generation: managed.record.generation,
		});
	}

	private async routeToOwner<TInput = unknown>(
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
			const validatedOwner = await this.validateLocalOwnership(
				request,
				owner,
				deadlineSignal.signal,
				false,
			);
			this.ensureManagedLease(request.sessionKey, validatedOwner);
			this.#metricEmitter.increment(
				"apifuse_stateful_provider_routing_local_total",
				metricLabels(request, validatedOwner),
			);
			try {
				return await this.#executor.executeLocal(
					request,
					validatedOwner,
					deadlineSignal.signal,
					(expected, signal) => this.validateLocalOwnership(request, expected, signal, true),
				);
			} catch (error) {
				if (isStatefulSessionEstablishmentFailure(error)) {
					await this.releaseFailedEstablishment(request.sessionKey, validatedOwner);
				}
				throw error;
			}
		}
		this.forgetManagedLease(request.sessionKey);
		this.#metricEmitter.increment(
			"apifuse_stateful_provider_routing_forward_total",
			metricLabels(request, owner),
		);
		return this.#forwarder.forward(owner, request, deadlineSignal.signal);
	}

	private ensureManagedLease(sessionKey: SessionKey, owner: SessionOwnerRecord): void {
		const current = this.#managedLeases.get(sessionKey);
		if (
			current &&
			current.record.ownerPodId === owner.ownerPodId &&
			current.record.generation === owner.generation
		) {
			current.record = owner;
			return;
		}
		if (current) this.stopManagedLease(current);
		const managed: ManagedLease = { sessionKey, record: owner };
		this.#managedLeases.set(sessionKey, managed);
		this.scheduleRenewal(managed);
	}

	private scheduleRenewal(managed: ManagedLease): void {
		managed.timer = setTimeout(
			() => void this.renewManagedLease(managed),
			this.#leaseRenewIntervalMs,
		);
		managed.timer.unref?.();
	}

	private async renewManagedLease(managed: ManagedLease): Promise<void> {
		if (this.#managedLeases.get(managed.sessionKey) !== managed) return;
		try {
			const renewed = await this.#registry.renew({
				sessionKey: managed.sessionKey,
				ownerPodId: managed.record.ownerPodId,
				generation: managed.record.generation,
				leaseDurationMs: this.#leaseDurationMs,
				now: this.#clock(),
			});
			if (!renewed) {
				this.forgetManagedLease(managed.sessionKey);
				return;
			}
			validateOwnerGeneration(renewed);
			managed.record = renewed;
		} catch {
			// A transient control-plane failure is retried on the next renewal interval.
		} finally {
			if (this.#managedLeases.get(managed.sessionKey) === managed) {
				this.scheduleRenewal(managed);
			}
		}
	}

	private async validateLocalOwnership(
		request: StatefulOperationRequest,
		expected: SessionOwnerRecord,
		signal: AbortSignal,
		markConnected: boolean,
	): Promise<SessionOwnerRecord> {
		const resolved = await this.#registry.resolve(request.sessionKey, this.#clock(), signal);
		if (!sameOwner(resolved, expected)) {
			this.forgetManagedLease(request.sessionKey);
			throw ownershipChanged(request);
		}
		if (!markConnected) return resolved;
		const connected = await this.#registry.renew(
			{
				sessionKey: request.sessionKey,
				ownerPodId: resolved.ownerPodId,
				generation: resolved.generation,
				leaseDurationMs: this.#leaseDurationMs,
				status: "connected",
				now: this.#clock(),
			},
			signal,
		);
		if (!sameOwner(connected, expected)) {
			this.forgetManagedLease(request.sessionKey);
			throw ownershipChanged(request);
		}
		validateOwnerGeneration(connected);
		this.ensureManagedLease(request.sessionKey, connected);
		return connected;
	}

	private forgetManagedLease(sessionKey: SessionKey): void {
		const managed = this.#managedLeases.get(sessionKey);
		if (!managed) return;
		this.stopManagedLease(managed);
		this.#managedLeases.delete(sessionKey);
	}

	private async releaseFailedEstablishment(
		sessionKey: SessionKey,
		owner: SessionOwnerRecord,
	): Promise<void> {
		const managed = this.#managedLeases.get(sessionKey);
		if (
			managed &&
			managed.record.ownerPodId === owner.ownerPodId &&
			managed.record.generation === owner.generation
		) {
			this.stopManagedLease(managed);
			this.#managedLeases.delete(sessionKey);
		}
		try {
			await this.#registry.release({
				sessionKey,
				ownerPodId: owner.ownerPodId,
				generation: owner.generation,
			});
		} catch (error) {
			try {
				console.error(
					JSON.stringify({
						event: "stateful_session_establishment_lease_release_failed",
						sessionKey: owner.sessionKey,
						ownerPodId: owner.ownerPodId,
						generation: owner.generation,
						errorClass: error instanceof Error ? error.name : "UnknownError",
					}),
				);
			} catch {}
		}
	}

	private stopManagedLease(managed: ManagedLease): void {
		if (managed.timer) clearTimeout(managed.timer);
		managed.timer = undefined;
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

function validateLeaseRenewalFraction(fraction: number): void {
	if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
		throw new Error(
			"Stateful session router leaseRenewalFraction must be greater than 0 and less than 1.",
		);
	}
}

function validateOwnerGeneration(owner: SessionOwnerRecord): void {
	if (!Number.isInteger(owner.generation) || owner.generation <= 0) {
		throw new Error("Stateful session owner generation must be a positive integer.");
	}
}

function sameOwner(
	actual: SessionOwnerRecord | null,
	expected: SessionOwnerRecord,
): actual is SessionOwnerRecord {
	return (
		actual !== null &&
		actual.sessionKey === expected.sessionKey &&
		actual.ownerPodId === expected.ownerPodId &&
		actual.generation === expected.generation
	);
}

function ownershipChanged(request: StatefulOperationRequest): StatefulRoutingOwnershipError {
	return new StatefulRoutingOwnershipError(
		request.requestId,
		request.sessionKey,
		"Stateful session ownership changed before the local provider invocation.",
	);
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
