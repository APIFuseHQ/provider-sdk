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
	SessionOwnerRecord,
	SessionPoolPolicy,
} from "./stateful-provider-session-runtime.js";
import { PodLocalSessionPool } from "./stateful-provider-session-runtime.js";

export type StatefulProviderCapability = {
	readonly supportsConcurrentCommands?: boolean;
	readonly supportsPushEvents?: boolean;
	readonly supportsReconnect?: boolean;
	readonly supportsWriteReconciliation?: boolean;
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
	readonly connectionId: string;
	readonly serviceAccountId: string;
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

export type StatefulProviderPushEmit<TEvent = unknown> = (event: TEvent) => void | Promise<void>;

export type StatefulWriteReconciliationResult<TSharedState = unknown> = {
	readonly result: StatefulOperationResult;
	readonly sharedState?: TSharedState;
};

export interface StatefulProviderAdapter<TSession, TSharedState = unknown> {
	readonly providerId: string;
	readonly capabilities: StatefulProviderCapability;
	restore(ctx: StatefulProviderSessionContext): Promise<TSharedState>;
	connect(ctx: StatefulProviderSessionContext, sharedState: TSharedState): Promise<TSession>;
	invoke(
		ctx: StatefulProviderSessionContext,
		session: TSession,
		request: StatefulOperationRequest,
	): Promise<StatefulOperationResult>;
	snapshot(
		ctx: StatefulProviderSessionContext,
		session: TSession,
	): Promise<TSharedState | undefined>;
	health(ctx: StatefulProviderSessionContext, session: TSession): Promise<StatefulSessionHealth>;
	close(ctx: StatefulProviderSessionContext, session: TSession, reason: string): Promise<void>;
	reconcileWrite?(
		ctx: StatefulProviderSessionContext,
		ledgerEntry: unknown,
		sharedState: TSharedState,
	): Promise<StatefulWriteReconciliationResult<TSharedState>>;
	handlePush?(
		ctx: StatefulProviderSessionContext,
		session: TSession,
		rawEvent: unknown,
		emit: StatefulProviderPushEmit,
	): Promise<void>;
}

export type StatefulProviderSessionManagerOptions<TSession, TSharedState> = {
	readonly adapter: StatefulProviderAdapter<TSession, TSharedState>;
	readonly poolPolicy: SessionPoolPolicy;
	readonly clock?: () => Date;
	readonly metricEmitter?: StatefulProviderMetricEmitter;
};

export class StatefulProviderSessionManager<TSession, TSharedState = unknown>
	implements StatefulOperationExecutor<TSession>
{
	readonly #adapter: StatefulProviderAdapter<TSession, TSharedState>;
	readonly #pool: PodLocalSessionPool<TSession>;
	readonly #clock: () => Date;
	readonly #metricEmitter: StatefulProviderMetricEmitter;

	constructor(options: StatefulProviderSessionManagerOptions<TSession, TSharedState>) {
		this.#adapter = options.adapter;
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
			const managedSession = await this.#pool.getOrCreate(
				owner.sessionKey,
				owner.generation,
				() => this.connect(owner, request, signal),
				this.#clock(),
			);
			const validatedOwner = validateOwnership ? await validateOwnership(owner, signal) : owner;
			const ctx = makeStatefulProviderSessionContext(
				this.#adapter.providerId,
				validatedOwner,
				request,
				signal,
			);
			try {
				const result = await this.#adapter.invoke(ctx, managedSession.value, request);
				observeStatefulSessionOperationDuration({
					metricEmitter: this.#metricEmitter,
					request,
					owner,
					durationMs: this.#clock().getTime() - startedAt,
				});
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
				if (!error.retryable) throw error;
				const reconnected = await this.#pool.getOrCreate(
					owner.sessionKey,
					owner.generation,
					() => this.connect(owner, request, signal),
					this.#clock(),
				);
				const revalidatedOwner = validateOwnership ? await validateOwnership(owner, signal) : owner;
				const reconnectedCtx = makeStatefulProviderSessionContext(
					this.#adapter.providerId,
					revalidatedOwner,
					request,
					signal,
				);
				const result = await this.#adapter.invoke(reconnectedCtx, reconnected.value, request);
				observeStatefulSessionOperationDuration({
					metricEmitter: this.#metricEmitter,
					request,
					owner,
					durationMs: this.#clock().getTime() - startedAt,
				});
				return result;
			}
		};

		if (this.#adapter.capabilities.supportsConcurrentCommands) return run();
		return this.#pool.runExclusive(owner.sessionKey, run);
	}

	executeLocal(
		request: StatefulOperationRequest,
		owner: SessionOwnerRecord,
		signal: AbortSignal,
		validateOwnership?: StatefulOwnershipValidator,
	): Promise<StatefulOperationResult> {
		return this.invoke(owner, request, signal, validateOwnership);
	}

	closeAll(reason: string): Promise<void> {
		return this.#pool.closeAll(reason);
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
		const sharedState = await this.#adapter.restore(ctx);
		return this.#adapter.connect(ctx, sharedState);
	}

	private async closeManagedSession(
		session: ManagedSession<TSession>,
		reason: string,
	): Promise<void> {
		const ctx = makeStatefulProviderCloseContext(this.#adapter.providerId, session);
		await this.#adapter.snapshot(ctx, session.value);
		await this.#adapter.close(ctx, session.value, reason);
	}
}
