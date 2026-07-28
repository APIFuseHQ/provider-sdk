import {
	makeStatefulProviderCloseContext,
	makeStatefulProviderSessionContext,
} from "./stateful-provider-adapter-context.js";
import {
	emitStatefulSessionInvalidatedMetric,
	observeStatefulSessionOperationDuration,
} from "./stateful-provider-adapter-metrics.js";
import {
	NOOP_STATEFUL_PROVIDER_METRIC_EMITTER,
	type StatefulProviderMetricEmitter,
} from "./stateful-provider-observability.js";
import type {
	StatefulOperationExecutor,
	StatefulOperationRequest,
	StatefulOperationResult,
	StatefulOwnershipValidator,
} from "./stateful-provider-session-routing.js";
import type {
	ManagedSession,
	ManagedSessionIdentity,
	SessionOwnerRecord,
	SessionPoolPolicy,
} from "./stateful-provider-session-runtime.js";
import { PodLocalSessionPool } from "./stateful-provider-session-runtime.js";

export type StatefulProviderConcurrencyPolicy =
	| { readonly mode: "serialize" }
	| { readonly mode: "parallel"; readonly maxInFlight?: number };

export type StatefulProviderReconnectPolicy = "resume" | "recreate" | "unsupported";

export type StatefulProviderAdapterPolicy = {
	readonly concurrency: StatefulProviderConcurrencyPolicy;
	readonly reconnect: StatefulProviderReconnectPolicy;
};

export type StatefulSessionHealth = {
	readonly status: "ready" | "connecting" | "reconnecting" | "degraded" | "closed";
	readonly reason?: string;
	readonly lastError?: string;
};

export class StatefulSessionInvalidatedError extends Error {
	readonly name = "StatefulSessionInvalidatedError";
	readonly reason: string;
	readonly retryable: boolean;

	constructor(message: string, options: { readonly reason: string; readonly retryable?: boolean }) {
		super(message);
		this.reason = options.reason;
		this.retryable = options.retryable ?? false;
	}
}

export interface StatefulProviderSessionContext {
	readonly sessionKey: string;
	readonly providerId: string;
	/** Present for operation-created sessions; optional for direct pool users. */
	readonly connectionId?: string;
	/** Present for operation-created sessions; optional for direct pool users. */
	readonly serviceAccountId?: string;
	readonly ownerPodId?: string;
	readonly ownerEndpoint?: string;
	readonly ownerStatus?: string;
	readonly generation: number;
	readonly signal: AbortSignal;
	readonly requestId?: string;
	readonly operationId?: string;
	readonly idempotencyKey?: string;
	readonly deadlineAt?: string;
	readonly runtimeContext?: unknown;
}

export type StatefulProviderEventPublish<TEvent = unknown> = (
	event: TEvent,
) => void | Promise<void>;
export type StatefulProviderEventDisposer = () => void | Promise<void>;

export type StatefulWriteReconciliationResult<TSharedState = unknown> = {
	readonly result: StatefulOperationResult;
	readonly sharedState?: TSharedState;
};

export interface StatefulProviderAdapter<TSession, TSharedState = unknown, TEvent = unknown> {
	readonly providerId: string;
	readonly policy: StatefulProviderAdapterPolicy;
	/** Optional until durable cursor/checkpoint state exists for a provider. */
	restore?(ctx: StatefulProviderSessionContext): Promise<TSharedState | undefined>;
	connect(
		ctx: StatefulProviderSessionContext,
		sharedState: TSharedState | undefined,
	): Promise<TSession>;
	invoke(
		ctx: StatefulProviderSessionContext,
		session: TSession,
		request: StatefulOperationRequest,
	): Promise<StatefulOperationResult>;
	/** Requires a matching session-manager checkpointStore. */
	snapshot?(
		ctx: StatefulProviderSessionContext,
		session: TSession,
	): Promise<TSharedState | undefined>;
	/** Caller-driven through StatefulProviderSessionManager.health(). */
	health?(ctx: StatefulProviderSessionContext, session: TSession): Promise<StatefulSessionHealth>;
	close(ctx: StatefulProviderSessionContext, session: TSession, reason: string): Promise<void>;
	/** Caller-driven through StatefulProviderSessionManager.reconcileWrite(). */
	reconcileWrite?(
		ctx: StatefulProviderSessionContext,
		ledgerEntry: unknown,
		sharedState: TSharedState | undefined,
	): Promise<StatefulWriteReconciliationResult<TSharedState>>;
	/** Registers a connection-owned event source. Its disposer runs before checkpoint and close. */
	subscribe?(
		ctx: StatefulProviderSessionContext,
		session: TSession,
		publish: StatefulProviderEventPublish<TEvent>,
	): StatefulProviderEventDisposer | Promise<StatefulProviderEventDisposer>;
}

export type StatefulProviderSessionManagerOptions<TSession, TSharedState, TEvent = unknown> = {
	readonly adapter: StatefulProviderAdapter<TSession, TSharedState, TEvent>;
	readonly poolPolicy: SessionPoolPolicy;
	readonly checkpointStore?: (
		ctx: StatefulProviderSessionContext,
		state: TSharedState,
	) => Promise<void>;
	readonly eventPublisher?: StatefulProviderEventPublish<TEvent>;
	readonly clock?: () => Date;
	readonly metricEmitter?: StatefulProviderMetricEmitter;
};

type ParallelLimiter = {
	active: number;
	readonly waiting: Array<() => void>;
};

export class StatefulProviderSessionManager<TSession, TSharedState = unknown, TEvent = unknown>
	implements StatefulOperationExecutor<TSession>
{
	readonly #adapter: StatefulProviderAdapter<TSession, TSharedState, TEvent>;
	readonly #pool: PodLocalSessionPool<TSession>;
	readonly #checkpointStore?: StatefulProviderSessionManagerOptions<
		TSession,
		TSharedState,
		TEvent
	>["checkpointStore"];
	readonly #eventPublisher?: StatefulProviderEventPublish<TEvent>;
	readonly #clock: () => Date;
	readonly #metricEmitter: StatefulProviderMetricEmitter;
	readonly #eventDisposers = new Map<string, StatefulProviderEventDisposer>();
	readonly #parallelLimiters = new Map<string, ParallelLimiter>();

	constructor(options: StatefulProviderSessionManagerOptions<TSession, TSharedState, TEvent>) {
		validateAdapterConfiguration(options);
		this.#adapter = options.adapter;
		this.#checkpointStore = options.checkpointStore;
		this.#eventPublisher = options.eventPublisher;
		this.#clock = options.clock ?? (() => new Date());
		this.#metricEmitter = options.metricEmitter ?? NOOP_STATEFUL_PROVIDER_METRIC_EMITTER;
		this.#pool = new PodLocalSessionPool<TSession>(options.poolPolicy, (session, reason) =>
			this.closeManagedSession(session, reason),
		);
	}

	async invoke(
		owner: SessionOwnerRecord,
		request: StatefulOperationRequest,
		signal: AbortSignal,
		validateOwnership?: StatefulOwnershipValidator,
	): Promise<StatefulOperationResult> {
		const startedAt = this.#clock().getTime();
		const run = async () => {
			const managedSession = await this.getOrCreate(owner, request, signal);
			const validatedOwner = validateOwnership ? await validateOwnership(owner, signal) : owner;
			const ctx = makeStatefulProviderSessionContext(
				this.#adapter.providerId,
				validatedOwner,
				request,
				signal,
			);
			try {
				const result = await this.#adapter.invoke(ctx, managedSession.value, request);
				this.observeDuration(request, owner, startedAt);
				return result;
			} catch (error) {
				if (!(error instanceof StatefulSessionInvalidatedError)) throw error;
				emitStatefulSessionInvalidatedMetric({
					metricEmitter: this.#metricEmitter,
					request,
					owner,
					reason: error.reason,
				});
				await this.#pool.invalidate(owner.sessionKey, error.reason);
				if (!error.retryable || this.#adapter.policy.reconnect === "unsupported") throw error;
				const reconnected = await this.getOrCreate(owner, request, signal);
				const revalidatedOwner = validateOwnership ? await validateOwnership(owner, signal) : owner;
				const reconnectedCtx = makeStatefulProviderSessionContext(
					this.#adapter.providerId,
					revalidatedOwner,
					request,
					signal,
				);
				const result = await this.#adapter.invoke(reconnectedCtx, reconnected.value, request);
				this.observeDuration(request, owner, startedAt);
				return result;
			}
		};

		const concurrency = this.#adapter.policy.concurrency;
		if (concurrency.mode === "serialize") return this.#pool.runExclusive(owner.sessionKey, run);
		if (concurrency.maxInFlight === undefined) return run();
		return this.runLimited(owner.sessionKey, concurrency.maxInFlight, run);
	}

	executeLocal(
		request: StatefulOperationRequest,
		owner: SessionOwnerRecord,
		signal: AbortSignal,
		validateOwnership?: StatefulOwnershipValidator,
	): Promise<StatefulOperationResult> {
		return this.invoke(owner, request, signal, validateOwnership);
	}

	async health(
		owner: SessionOwnerRecord,
		request: StatefulOperationRequest,
		signal: AbortSignal,
	): Promise<StatefulSessionHealth> {
		if (!this.#adapter.health) {
			throw new Error(
				`Stateful provider adapter "${this.#adapter.providerId}" has no health hook.`,
			);
		}
		const session = await this.getOrCreate(owner, request, signal);
		return this.#adapter.health(
			makeStatefulProviderSessionContext(this.#adapter.providerId, owner, request, signal),
			session.value,
		);
	}

	async reconcileWrite(
		owner: SessionOwnerRecord,
		request: StatefulOperationRequest,
		ledgerEntry: unknown,
		signal: AbortSignal,
	): Promise<StatefulWriteReconciliationResult<TSharedState>> {
		if (!this.#adapter.reconcileWrite) {
			throw new Error(
				`Stateful provider adapter "${this.#adapter.providerId}" does not support write reconciliation.`,
			);
		}
		const ctx = makeStatefulProviderSessionContext(
			this.#adapter.providerId,
			owner,
			request,
			signal,
		);
		const sharedState = this.#adapter.restore ? await this.#adapter.restore(ctx) : undefined;
		return this.#adapter.reconcileWrite(ctx, ledgerEntry, sharedState);
	}

	closeAll(reason: string): Promise<void> {
		return this.#pool.closeAll(reason);
	}

	private async getOrCreate(
		owner: SessionOwnerRecord,
		request: StatefulOperationRequest,
		signal: AbortSignal,
	): Promise<ManagedSession<TSession>> {
		return this.#pool.getOrCreate(
			owner.sessionKey,
			owner.generation,
			() => this.connect(owner, request, signal),
			this.#clock(),
			managedSessionIdentity(owner, request),
		);
	}

	private async connect(
		owner: SessionOwnerRecord,
		request: StatefulOperationRequest,
		signal: AbortSignal,
	): Promise<TSession> {
		const ctx = makeStatefulProviderSessionContext(
			this.#adapter.providerId,
			owner,
			request,
			signal,
		);
		const sharedState = this.#adapter.restore ? await this.#adapter.restore(ctx) : undefined;
		const session = await this.#adapter.connect(ctx, sharedState);
		if (!this.#adapter.subscribe || !this.#eventPublisher) return session;
		try {
			const disposer = await this.#adapter.subscribe(ctx, session, this.#eventPublisher);
			if (typeof disposer !== "function") {
				throw new Error(
					`Stateful provider adapter "${this.#adapter.providerId}" subscribe hook must return a disposer.`,
				);
			}
			this.#eventDisposers.set(sessionIdentityKey(owner.sessionKey, owner.generation), disposer);
			return session;
		} catch (error) {
			try {
				await this.#adapter.close(ctx, session, "event-subscription-failed");
			} catch (closeError) {
				throw new AggregateError(
					[error, closeError],
					"Stateful event subscription and session cleanup both failed.",
				);
			}
			throw error;
		}
	}

	private async closeManagedSession(
		session: ManagedSession<TSession>,
		reason: string,
	): Promise<void> {
		const ctx = makeStatefulProviderCloseContext(this.#adapter.providerId, session);
		const errors: unknown[] = [];
		const disposerKey = sessionIdentityKey(session.sessionKey, session.generation);
		const disposer = this.#eventDisposers.get(disposerKey);
		this.#eventDisposers.delete(disposerKey);
		if (disposer) {
			try {
				await disposer();
			} catch (error) {
				errors.push(error);
			}
		}
		if (this.#adapter.snapshot && this.#checkpointStore) {
			try {
				const state = await this.#adapter.snapshot(ctx, session.value);
				if (state !== undefined) await this.#checkpointStore(ctx, state);
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			await this.#adapter.close(ctx, session.value, reason);
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) {
			throw new AggregateError(errors, "Stateful session cleanup failed in multiple hooks.");
		}
	}

	private observeDuration(
		request: StatefulOperationRequest,
		owner: SessionOwnerRecord,
		startedAt: number,
	): void {
		observeStatefulSessionOperationDuration({
			metricEmitter: this.#metricEmitter,
			request,
			owner,
			durationMs: this.#clock().getTime() - startedAt,
		});
	}

	private async runLimited<R>(
		sessionKey: string,
		maxInFlight: number,
		run: () => Promise<R>,
	): Promise<R> {
		const limiter = this.#parallelLimiters.get(sessionKey) ?? { active: 0, waiting: [] };
		this.#parallelLimiters.set(sessionKey, limiter);
		if (limiter.active >= maxInFlight) {
			await new Promise<void>((resolve) => limiter.waiting.push(resolve));
		}
		limiter.active += 1;
		try {
			return await run();
		} finally {
			limiter.active -= 1;
			limiter.waiting.shift()?.();
			if (limiter.active === 0 && limiter.waiting.length === 0) {
				this.#parallelLimiters.delete(sessionKey);
			}
		}
	}
}

function validateAdapterConfiguration<TSession, TSharedState, TEvent>(
	options: StatefulProviderSessionManagerOptions<TSession, TSharedState, TEvent>,
): void {
	const adapter = options.adapter;
	if (!adapter.policy?.concurrency || !adapter.policy.reconnect) {
		throw new Error(
			`Stateful provider adapter "${adapter.providerId}" requires concurrency and reconnect policies.`,
		);
	}
	const concurrency = adapter.policy.concurrency;
	if (concurrency.mode !== "serialize" && concurrency.mode !== "parallel") {
		throw new Error('Stateful concurrency policy mode must be "serialize" or "parallel".');
	}
	if (concurrency.mode === "serialize" && "maxInFlight" in concurrency) {
		throw new Error("Stateful serialize concurrency must not declare maxInFlight.");
	}
	if (
		concurrency.mode === "parallel" &&
		concurrency.maxInFlight !== undefined &&
		(!Number.isInteger(concurrency.maxInFlight) || concurrency.maxInFlight <= 0)
	) {
		throw new Error("Stateful parallel concurrency maxInFlight must be a positive integer.");
	}
	if (!(["resume", "recreate", "unsupported"] as const).includes(adapter.policy.reconnect)) {
		throw new Error('Stateful reconnect policy must be "resume", "recreate", or "unsupported".');
	}
	if (Boolean(adapter.snapshot) !== Boolean(options.checkpointStore)) {
		throw new Error(
			`Stateful provider adapter "${adapter.providerId}" snapshot and session-manager checkpointStore must be configured together.`,
		);
	}
	if (Boolean(adapter.subscribe) !== Boolean(options.eventPublisher)) {
		throw new Error(
			`Stateful provider adapter "${adapter.providerId}" subscribe and session-manager eventPublisher must be configured together.`,
		);
	}
}

function managedSessionIdentity(
	owner: SessionOwnerRecord,
	request: StatefulOperationRequest,
): ManagedSessionIdentity {
	return {
		connectionId: request.connectionId,
		serviceAccountId: request.serviceAccountId,
		ownerPodId: owner.ownerPodId,
		ownerEndpoint: owner.ownerEndpoint,
		ownerStatus: owner.status,
	};
}

function sessionIdentityKey(sessionKey: string, generation: number): string {
	return `${sessionKey}\u001f${generation}`;
}
