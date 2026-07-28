import type { SessionKey } from "./session-key.js";

/** @deprecated Use SessionKey from session-key.ts. */
export type StatefulProviderSessionKey = SessionKey;
export type SessionOwnerStatus = "acquiring" | "connected" | "draining" | "expired";

export interface SessionOwnerRecord {
	/** Runtime-decoded key; registry inputs use the opaque SessionKey type. */
	readonly sessionKey: string;
	readonly ownerPodId: string;
	readonly ownerEndpoint: string;
	readonly generation: number;
	readonly leaseExpiresAt: string;
	readonly status: SessionOwnerStatus;
	readonly lastUsedAt: string;
}

export interface AcquireSessionOwnerInput {
	readonly sessionKey: SessionKey;
	readonly ownerPodId: string;
	readonly ownerEndpoint: string;
	readonly leaseDurationMs: number;
	readonly status?: Exclude<SessionOwnerStatus, "expired">;
	readonly now?: Date;
}

export interface AcquireSessionOwnerResult {
	readonly record: SessionOwnerRecord;
	readonly acquired: boolean;
}

export interface RenewSessionOwnerInput {
	readonly sessionKey: SessionKey;
	readonly ownerPodId: string;
	readonly generation: number;
	readonly leaseDurationMs: number;
	readonly status?: Exclude<SessionOwnerStatus, "expired">;
	readonly now?: Date;
}

export interface ReleaseSessionOwnerInput {
	readonly sessionKey: SessionKey;
	readonly ownerPodId: string;
	readonly generation: number;
}

/**
 * A session-owner registry is a fencing authority. Generations MUST be positive integers and
 * strictly increase for each successful takeover of a session key, including after expiry or
 * release. Implementations must retain a high-water mark (a tombstone) for at least the registry's
 * lifetime; generation values must never be reused.
 */
export interface SessionOwnerRegistry {
	resolve(
		sessionKey: SessionKey,
		now?: Date,
		signal?: AbortSignal,
	): Promise<SessionOwnerRecord | null>;
	acquire(
		input: AcquireSessionOwnerInput,
		signal?: AbortSignal,
	): Promise<AcquireSessionOwnerResult>;
	renew(input: RenewSessionOwnerInput, signal?: AbortSignal): Promise<SessionOwnerRecord | null>;
	release(input: ReleaseSessionOwnerInput, signal?: AbortSignal): Promise<boolean>;
}

export interface SessionPoolPolicy {
	readonly maxSessions: number;
	/** Disable idle eviction for connection-owned listeners with `"unlimited"`. */
	readonly idleTimeoutMs: number | "unlimited";
	/** Disable age-based recycling for expensive healthy sessions with `"unlimited"`. */
	readonly maxLifetimeMs: number | "unlimited";
}

export interface ManagedSessionIdentity {
	readonly connectionId: string;
	readonly serviceAccountId: string;
	readonly ownerPodId: string;
	readonly ownerEndpoint: string;
	readonly ownerStatus: SessionOwnerStatus;
}

export interface ManagedSession<T> {
	readonly sessionKey: string;
	readonly generation: number;
	readonly value: T;
	readonly createdAt: string;
	readonly lastUsedAt: string;
	readonly identity?: ManagedSessionIdentity;
}

type SessionFactory<T> = () => T | Promise<T>;
type SessionCloseHook<T> = (session: ManagedSession<T>, reason: string) => void | Promise<void>;
export class InMemorySessionOwnerRegistry implements SessionOwnerRegistry {
	readonly #owners = new Map<StatefulProviderSessionKey, SessionOwnerRecord>();
	readonly #generationHighWater = new Map<StatefulProviderSessionKey, number>();

	async resolve(
		sessionKey: SessionKey,
		now: Date = new Date(),
		signal?: AbortSignal,
	): Promise<SessionOwnerRecord | null> {
		signal?.throwIfAborted();
		const current = this.#owners.get(sessionKey);
		if (!current || isLeaseExpired(current, now)) return null;
		validateGeneration(current.generation);
		return current;
	}

	async acquire(
		input: AcquireSessionOwnerInput,
		signal?: AbortSignal,
	): Promise<AcquireSessionOwnerResult> {
		signal?.throwIfAborted();
		validateLeaseDuration(input.leaseDurationMs);
		const now = input.now ?? new Date();
		const current = this.#owners.get(input.sessionKey);
		if (current && !isLeaseExpired(current, now)) {
			validateGeneration(current.generation);
			if (current.ownerPodId !== input.ownerPodId) {
				return { record: current, acquired: false };
			}
			const record = makeOwnerRecord(input, current.generation, now);
			this.#owners.set(input.sessionKey, record);
			return { record, acquired: true };
		}

		const generation =
			Math.max(current?.generation ?? 0, this.#generationHighWater.get(input.sessionKey) ?? 0) + 1;
		const record = makeOwnerRecord(input, generation, now);
		this.#owners.set(input.sessionKey, record);
		this.#generationHighWater.set(input.sessionKey, generation);
		return { record, acquired: true };
	}

	async renew(
		input: RenewSessionOwnerInput,
		signal?: AbortSignal,
	): Promise<SessionOwnerRecord | null> {
		signal?.throwIfAborted();
		validateGeneration(input.generation);
		validateLeaseDuration(input.leaseDurationMs);
		const now = input.now ?? new Date();
		const current = this.#owners.get(input.sessionKey);
		if (
			!current ||
			current.ownerPodId !== input.ownerPodId ||
			current.generation !== input.generation ||
			isLeaseExpired(current, now)
		) {
			return null;
		}

		const record: SessionOwnerRecord = {
			...current,
			leaseExpiresAt: addMs(now, input.leaseDurationMs).toISOString(),
			status: input.status ?? current.status,
			lastUsedAt: now.toISOString(),
		};
		this.#owners.set(input.sessionKey, record);
		return record;
	}

	async release(input: ReleaseSessionOwnerInput, signal?: AbortSignal): Promise<boolean> {
		signal?.throwIfAborted();
		validateGeneration(input.generation);
		const current = this.#owners.get(input.sessionKey);
		if (
			!current ||
			current.ownerPodId !== input.ownerPodId ||
			current.generation !== input.generation
		) {
			return false;
		}
		this.#generationHighWater.set(
			input.sessionKey,
			Math.max(this.#generationHighWater.get(input.sessionKey) ?? 0, current.generation),
		);
		this.#owners.delete(input.sessionKey);
		return true;
	}
}

export class PodLocalSessionPool<T> {
	readonly #sessions = new Map<string, ManagedSession<T>>();
	readonly #queues = new Map<string, Promise<void>>();
	readonly #creates = new Map<string, Promise<ManagedSession<T>>>();

	constructor(
		private readonly policy: SessionPoolPolicy,
		private readonly closeSession: SessionCloseHook<T>,
	) {
		validatePoolPolicy(policy);
	}

	async getOrCreate(
		sessionKey: string,
		generation: number,
		factory: SessionFactory<T>,
		now: Date = new Date(),
		identity?: ManagedSessionIdentity,
	): Promise<ManagedSession<T>> {
		validateGeneration(generation);
		const existingCreate = this.#creates.get(sessionKey);
		if (existingCreate) {
			try {
				await existingCreate;
			} catch {}
		}
		const create = this.getOrCreateUnlocked(sessionKey, generation, factory, now, identity);
		this.#creates.set(sessionKey, create);
		try {
			return await create;
		} finally {
			if (this.#creates.get(sessionKey) === create) this.#creates.delete(sessionKey);
		}
	}

	private async getOrCreateUnlocked(
		sessionKey: string,
		generation: number,
		factory: SessionFactory<T>,
		now: Date,
		identity?: ManagedSessionIdentity,
	): Promise<ManagedSession<T>> {
		await this.evictExpired(now);

		const current = this.#sessions.get(sessionKey);
		if (current && current.generation === generation) {
			const touched = { ...current, lastUsedAt: now.toISOString() };
			this.#sessions.delete(sessionKey);
			this.#sessions.set(sessionKey, touched);
			return touched;
		}
		if (current) await this.closeOne(sessionKey, "generation-changed");

		const session: ManagedSession<T> = {
			sessionKey,
			generation,
			value: await factory(),
			createdAt: now.toISOString(),
			lastUsedAt: now.toISOString(),
			...(identity ? { identity } : {}),
		};
		this.#sessions.set(sessionKey, session);
		await this.evictOverCapacity();
		return session;
	}

	async closeAll(reason: string): Promise<void> {
		const errors: unknown[] = [];
		for (const sessionKey of [...this.#sessions.keys()]) {
			try {
				await this.closeOne(sessionKey, reason);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, `Failed to close ${errors.length} stateful session(s).`);
		}
	}

	async invalidate(sessionKey: string, reason: string): Promise<void> {
		await this.closeOne(sessionKey, reason);
	}

	async runExclusive<R>(sessionKey: string, task: () => R | Promise<R>): Promise<R> {
		const previous = this.#queues.get(sessionKey) ?? Promise.resolve();
		const next = previous.then(task, task);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		this.#queues.set(sessionKey, settled);
		await settled.finally(() => {
			if (this.#queues.get(sessionKey) === settled) {
				this.#queues.delete(sessionKey);
			}
		});
		return next;
	}

	private async evictExpired(now: Date): Promise<void> {
		for (const [sessionKey, session] of this.#sessions) {
			if (isSessionExpired(session, this.policy, now)) {
				await this.closeOne(sessionKey, "expired");
			}
		}
	}

	private async evictOverCapacity(): Promise<void> {
		while (this.#sessions.size > this.policy.maxSessions) {
			const lruKey = this.#sessions.keys().next().value;
			if (lruKey === undefined) return;
			await this.closeOne(lruKey, "capacity");
		}
	}

	private async closeOne(sessionKey: string, reason: string): Promise<void> {
		const session = this.#sessions.get(sessionKey);
		if (!session) return;
		this.#sessions.delete(sessionKey);
		await this.closeSession(session, reason);
	}
}

function makeOwnerRecord(
	input: AcquireSessionOwnerInput,
	generation: number,
	now: Date,
): SessionOwnerRecord {
	validateGeneration(generation);
	return {
		sessionKey: input.sessionKey,
		ownerPodId: input.ownerPodId,
		ownerEndpoint: input.ownerEndpoint,
		generation,
		leaseExpiresAt: addMs(now, input.leaseDurationMs).toISOString(),
		status: input.status ?? "acquiring",
		lastUsedAt: now.toISOString(),
	};
}

function isLeaseExpired(record: SessionOwnerRecord, now: Date): boolean {
	return Date.parse(record.leaseExpiresAt) <= now.getTime();
}

function isSessionExpired<T>(
	session: ManagedSession<T>,
	policy: SessionPoolPolicy,
	now: Date,
): boolean {
	const nowMs = now.getTime();
	return (
		(policy.idleTimeoutMs !== "unlimited" &&
			nowMs - Date.parse(session.lastUsedAt) >= policy.idleTimeoutMs) ||
		(policy.maxLifetimeMs !== "unlimited" &&
			nowMs - Date.parse(session.createdAt) >= policy.maxLifetimeMs)
	);
}

function validateLeaseDuration(leaseDurationMs: number): void {
	if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
		throw new Error("Session owner leaseDurationMs must be a positive finite number.");
	}
}

function validateGeneration(generation: number): void {
	if (!Number.isInteger(generation) || generation <= 0) {
		throw new Error("Session owner generation must be a positive integer.");
	}
}

function validatePoolPolicy(policy: SessionPoolPolicy): void {
	if (!Number.isInteger(policy.maxSessions) || policy.maxSessions <= 0) {
		throw new Error("Session pool maxSessions must be a positive integer.");
	}
	if (
		policy.idleTimeoutMs !== "unlimited" &&
		(!Number.isFinite(policy.idleTimeoutMs) || policy.idleTimeoutMs <= 0)
	) {
		throw new Error('Session pool idleTimeoutMs must be a positive finite number or "unlimited".');
	}
	if (
		policy.maxLifetimeMs !== "unlimited" &&
		(!Number.isFinite(policy.maxLifetimeMs) || policy.maxLifetimeMs <= 0)
	) {
		throw new Error('Session pool maxLifetimeMs must be a positive finite number or "unlimited".');
	}
}

function addMs(date: Date, ms: number): Date {
	return new Date(date.getTime() + ms);
}
