export type StatefulProviderSessionKey = string;
export type SessionOwnerStatus = "acquiring" | "connected" | "draining" | "expired";

export interface SessionOwnerRecord {
	readonly sessionKey: string;
	readonly ownerPodId: string;
	readonly ownerEndpoint: string;
	readonly generation: number;
	readonly leaseExpiresAt: string;
	readonly status: SessionOwnerStatus;
	readonly lastUsedAt: string;
}

export interface AcquireSessionOwnerInput {
	readonly sessionKey: string;
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
	readonly sessionKey: string;
	readonly ownerPodId: string;
	readonly generation: number;
	readonly leaseDurationMs: number;
	readonly status?: Exclude<SessionOwnerStatus, "expired">;
	readonly now?: Date;
}

export interface ReleaseSessionOwnerInput {
	readonly sessionKey: string;
	readonly ownerPodId: string;
	readonly generation: number;
}

export interface SessionOwnerRegistry {
	resolve(sessionKey: StatefulProviderSessionKey, now?: Date): Promise<SessionOwnerRecord | null>;
	acquire(input: AcquireSessionOwnerInput): Promise<AcquireSessionOwnerResult>;
	renew(input: RenewSessionOwnerInput): Promise<SessionOwnerRecord | null>;
	release(input: ReleaseSessionOwnerInput): Promise<boolean>;
}

export interface SessionPoolPolicy {
	readonly maxSessions: number;
	readonly idleTimeoutMs: number;
	readonly absoluteMaxLifetimeMs: number;
}

export interface ManagedSession<T> {
	readonly sessionKey: string;
	readonly generation: number;
	readonly value: T;
	readonly createdAt: string;
	readonly lastUsedAt: string;
}

type SessionFactory<T> = () => T | Promise<T>;
type SessionCloseHook<T> = (session: ManagedSession<T>, reason: string) => void | Promise<void>;
export class InMemorySessionOwnerRegistry implements SessionOwnerRegistry {
	readonly #owners = new Map<string, SessionOwnerRecord>();

	async resolve(
		sessionKey: StatefulProviderSessionKey,
		now: Date = new Date(),
	): Promise<SessionOwnerRecord | null> {
		const current = this.#owners.get(sessionKey);
		if (!current || isLeaseExpired(current, now)) return null;
		return current;
	}

	async acquire(input: AcquireSessionOwnerInput): Promise<AcquireSessionOwnerResult> {
		validateLeaseDuration(input.leaseDurationMs);
		const now = input.now ?? new Date();
		const current = this.#owners.get(input.sessionKey);
		if (current && !isLeaseExpired(current, now)) {
			if (current.ownerPodId !== input.ownerPodId) {
				return { record: current, acquired: false };
			}
			const record = makeOwnerRecord(input, current.generation, now);
			this.#owners.set(input.sessionKey, record);
			return { record, acquired: true };
		}

		const generation = current ? current.generation + 1 : 1;
		const record = makeOwnerRecord(input, generation, now);
		this.#owners.set(input.sessionKey, record);
		return { record, acquired: true };
	}

	async renew(input: RenewSessionOwnerInput): Promise<SessionOwnerRecord | null> {
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

	async release(input: ReleaseSessionOwnerInput): Promise<boolean> {
		const current = this.#owners.get(input.sessionKey);
		if (
			!current ||
			current.ownerPodId !== input.ownerPodId ||
			current.generation !== input.generation
		) {
			return false;
		}
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
		sessionKey: StatefulProviderSessionKey,
		generation: number,
		factory: SessionFactory<T>,
		now: Date = new Date(),
	): Promise<ManagedSession<T>> {
		const existingCreate = this.#creates.get(sessionKey);
		if (existingCreate) {
			try {
				await existingCreate;
			} catch {}
		}
		const create = this.getOrCreateUnlocked(sessionKey, generation, factory, now);
		this.#creates.set(sessionKey, create);
		try {
			return await create;
		} finally {
			if (this.#creates.get(sessionKey) === create) this.#creates.delete(sessionKey);
		}
	}

	private async getOrCreateUnlocked(
		sessionKey: StatefulProviderSessionKey,
		generation: number,
		factory: SessionFactory<T>,
		now: Date,
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
		};
		this.#sessions.set(sessionKey, session);
		await this.evictOverCapacity();
		return session;
	}

	async closeAll(reason: string): Promise<void> {
		for (const sessionKey of [...this.#sessions.keys()]) {
			await this.closeOne(sessionKey, reason);
		}
	}

	async invalidate(sessionKey: StatefulProviderSessionKey, reason: string): Promise<void> {
		await this.closeOne(sessionKey, reason);
	}

	async runExclusive<R>(
		sessionKey: StatefulProviderSessionKey,
		task: () => R | Promise<R>,
	): Promise<R> {
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
		nowMs - Date.parse(session.lastUsedAt) >= policy.idleTimeoutMs ||
		nowMs - Date.parse(session.createdAt) >= policy.absoluteMaxLifetimeMs
	);
}

function validateLeaseDuration(leaseDurationMs: number): void {
	if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
		throw new Error("Session owner leaseDurationMs must be a positive finite number.");
	}
}

function validatePoolPolicy(policy: SessionPoolPolicy): void {
	if (!Number.isInteger(policy.maxSessions) || policy.maxSessions <= 0) {
		throw new Error("Session pool maxSessions must be a positive integer.");
	}
	if (!Number.isFinite(policy.idleTimeoutMs) || policy.idleTimeoutMs <= 0) {
		throw new Error("Session pool idleTimeoutMs must be a positive finite number.");
	}
	if (!Number.isFinite(policy.absoluteMaxLifetimeMs) || policy.absoluteMaxLifetimeMs <= 0) {
		throw new Error("Session pool absoluteMaxLifetimeMs must be a positive finite number.");
	}
}

function addMs(date: Date, ms: number): Date {
	return new Date(date.getTime() + ms);
}
