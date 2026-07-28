import type {
	ProviderEventOwnerFence,
	ProviderEventPublishOptions,
} from "./provider-event-pipeline.js";
import type { SessionKey } from "./session-key.js";
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

export interface StatefulProviderEventPublisher<TEvent = unknown> {
	publish(event: TEvent, options: ProviderEventPublishOptions): unknown;
}

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
	readonly eventPublisher?: StatefulProviderEventPublisher<TEvent>;
	readonly clock?: () => Date;
	readonly metricEmitter?: StatefulProviderMetricEmitter;
};

type ParallelLimiter = {
	active: number;
	readonly waiting: Array<() => void>;
};

const STATEFUL_SESSION_ESTABLISHMENT_FAILURE = Symbol.for(
	"@apifuse/provider-sdk/stateful/session-establishment-failure@1",
);

function markStatefulSessionEstablishmentFailure(error: unknown): unknown {
	if ((typeof error === "object" && error !== null) || typeof error === "function") {
		try {
			Object.defineProperty(error, STATEFUL_SESSION_ESTABLISHMENT_FAILURE, {
				value: true,
				enumerable: false,
			});
			return error;
		} catch {}
	}
	const wrapped = new Error("Stateful session establishment failed.", { cause: error });
	Object.defineProperty(wrapped, STATEFUL_SESSION_ESTABLISHMENT_FAILURE, { value: true });
	return wrapped;
}

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
	readonly #eventPublisher?: StatefulProviderEventPublisher<TEvent>;
	readonly #clock: () => Date;
	readonly #metricEmitter: StatefulProviderMetricEmitter;
	readonly #eventDisposers = new Map<string, StatefulProviderEventDisposer>();
	readonly #eventOwnerFences = new Map<string, ProviderEventOwnerFence>();
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
			const managedSession = await this.getOrCreate(owner, request, signal, validateOwnership);
			const validatedOwner = await this.validatePooledOwnership(
				owner,
				request.sessionKey,
				signal,
				validateOwnership,
			);
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
				const reconnected = await this.getOrCreate(owner, request, signal, validateOwnership);
				const revalidatedOwner = await this.validatePooledOwnership(
					owner,
					request.sessionKey,
					signal,
					validateOwnership,
				);
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

		return this.schedule(owner.sessionKey, run);
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
		validateOwnership?: StatefulOwnershipValidator,
	): Promise<StatefulSessionHealth> {
		if (!this.#adapter.health) {
			throw new Error(
				`Stateful provider adapter "${this.#adapter.providerId}" has no health hook.`,
			);
		}
		return this.schedule(owner.sessionKey, async () => {
			const session = await this.getOrCreate(owner, request, signal, validateOwnership);
			const validatedOwner = await this.validatePooledOwnership(
				owner,
				request.sessionKey,
				signal,
				validateOwnership,
			);
			return this.#adapter.health?.(
				makeStatefulProviderSessionContext(
					this.#adapter.providerId,
					validatedOwner,
					request,
					signal,
				),
				session.value,
			) as Promise<StatefulSessionHealth>;
		});
	}

	async reconcileWrite(
		owner: SessionOwnerRecord,
		request: StatefulOperationRequest,
		ledgerEntry: unknown,
		signal: AbortSignal,
		validateOwnership?: StatefulOwnershipValidator,
	): Promise<StatefulWriteReconciliationResult<TSharedState>> {
		if (!this.#adapter.reconcileWrite) {
			throw new Error(
				`Stateful provider adapter "${this.#adapter.providerId}" does not support write reconciliation.`,
			);
		}
		return this.schedule(owner.sessionKey, async () => {
			const restoreCtx = makeStatefulProviderSessionContext(
				this.#adapter.providerId,
				owner,
				request,
				signal,
			);
			const sharedState = this.#adapter.restore
				? await this.#adapter.restore(restoreCtx)
				: undefined;
			const validatedOwner = validateOwnership ? await validateOwnership(owner, signal) : owner;
			const ctx = makeStatefulProviderSessionContext(
				this.#adapter.providerId,
				validatedOwner,
				request,
				signal,
			);
			return this.#adapter.reconcileWrite?.(ctx, ledgerEntry, sharedState) as Promise<
				StatefulWriteReconciliationResult<TSharedState>
			>;
		});
	}

	closeAll(reason: string): Promise<void> {
		return this.#pool.closeAll(reason);
	}

	private async getOrCreate(
		owner: SessionOwnerRecord,
		request: StatefulOperationRequest,
		signal: AbortSignal,
		validateOwnership?: StatefulOwnershipValidator,
	): Promise<ManagedSession<TSession>> {
		return this.#pool.getOrCreate(
			owner.sessionKey,
			owner.generation,
			() => this.connect(owner, request, signal, validateOwnership),
			this.#clock(),
			managedSessionIdentity(owner, request),
		);
	}

	private async connect(
		owner: SessionOwnerRecord,
		request: StatefulOperationRequest,
		signal: AbortSignal,
		validateOwnership?: StatefulOwnershipValidator,
	): Promise<TSession> {
		const ctx = makeStatefulProviderSessionContext(
			this.#adapter.providerId,
			owner,
			request,
			signal,
		);
		let session: TSession | undefined;
		let connected = false;
		try {
			const sharedState = this.#adapter.restore ? await this.#adapter.restore(ctx) : undefined;
			session = await this.#adapter.connect(ctx, sharedState);
			connected = true;
			const validatedOwner = validateOwnership ? await validateOwnership(owner, signal) : owner;
			const validatedCtx = makeStatefulProviderSessionContext(
				this.#adapter.providerId,
				validatedOwner,
				request,
				signal,
			);
			this.refreshEventOwnerFence(validatedOwner, request.sessionKey);
			if (!this.#adapter.subscribe || !this.#eventPublisher) return session;
			const identityKey = sessionIdentityKey(owner.sessionKey, owner.generation);
			const disposer = await this.#adapter.subscribe(validatedCtx, session, (event) => {
				const ownerFence = this.#eventOwnerFences.get(identityKey);
				if (!ownerFence) return;
				this.#eventPublisher?.publish(event, { ownerFence });
			});
			if (typeof disposer !== "function") {
				throw new Error(
					`Stateful provider adapter "${this.#adapter.providerId}" subscribe hook must return a disposer.`,
				);
			}
			this.#eventDisposers.set(identityKey, disposer);
			return session;
		} catch (error) {
			this.#eventOwnerFences.delete(sessionIdentityKey(owner.sessionKey, owner.generation));
			let establishmentError = error;
			if (connected) {
				try {
					await this.#adapter.close(ctx, session as TSession, "session-establishment-failed");
				} catch (closeError) {
					establishmentError = new AggregateError(
						[error, closeError],
						"Stateful session establishment and cleanup both failed.",
					);
				}
			}
			throw markStatefulSessionEstablishmentFailure(establishmentError);
		}
	}

	private async validatePooledOwnership(
		owner: SessionOwnerRecord,
		sessionKey: SessionKey,
		signal: AbortSignal,
		validateOwnership?: StatefulOwnershipValidator,
	): Promise<SessionOwnerRecord> {
		try {
			const validatedOwner = validateOwnership ? await validateOwnership(owner, signal) : owner;
			this.refreshEventOwnerFence(validatedOwner, sessionKey);
			return validatedOwner;
		} catch (error) {
			await this.#pool
				.invalidate(owner.sessionKey, "ownership-validation-failed")
				.catch(() => undefined);
			throw markStatefulSessionEstablishmentFailure(error);
		}
	}

	private refreshEventOwnerFence(owner: SessionOwnerRecord, sessionKey: SessionKey): void {
		this.#eventOwnerFences.set(sessionIdentityKey(owner.sessionKey, owner.generation), {
			sessionKey,
			generation: owner.generation,
			ownerPodId: owner.ownerPodId,
			ownerEndpoint: owner.ownerEndpoint,
		});
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
		this.#eventOwnerFences.delete(disposerKey);
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

	private schedule<R>(sessionKey: string, run: () => Promise<R>): Promise<R> {
		const concurrency = this.#adapter.policy.concurrency;
		if (concurrency.mode === "serialize") return this.#pool.runExclusive(sessionKey, run);
		if (concurrency.maxInFlight === undefined) return run();
		return this.runLimited(sessionKey, concurrency.maxInFlight, run);
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
