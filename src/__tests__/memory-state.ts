import type {
	ProviderRuntimeState,
	ProviderStateNamespace,
	StateCasResult,
	StateNamespaceOptions,
	StateValue,
	StateWriteOptions,
} from "../types.js";

export class MemoryProviderRuntimeState implements ProviderRuntimeState {
	readonly namespaces = new Map<string, MemoryProviderStateNamespace>();

	forConnection(_connectionId: string | undefined): ProviderRuntimeState {
		return this;
	}

	namespace(name: string, _options: StateNamespaceOptions): ProviderStateNamespace {
		const existing = this.namespaces.get(name);
		if (existing) return existing;
		const created = new MemoryProviderStateNamespace();
		this.namespaces.set(name, created);
		return created;
	}

	firstNamespace(): MemoryProviderStateNamespace {
		const first = Array.from(this.namespaces.values())[0];
		if (!first) throw new Error("Expected choice state namespace.");
		return first;
	}
}

class MemoryProviderStateNamespace implements ProviderStateNamespace {
	readonly values = new Map<string, StateValue>();
	readonly compareAndSetKeys: string[] = [];
	forcedCreateCollisions = 0;

	async list<T = unknown>(options?: { limit?: number; prefix?: string }): Promise<StateValue<T>[]> {
		const rows = Array.from(this.values.values()).filter((value) =>
			options?.prefix ? value.key.startsWith(options.prefix) : true,
		);
		return rows.slice(0, options?.limit).map((value) => value as StateValue<T>);
	}

	async get<T = unknown>(key: string): Promise<StateValue<T> | null> {
		const value = this.values.get(key);
		return value ? (value as StateValue<T>) : null;
	}

	async set<T = unknown>(
		key: string,
		value: T,
		_options?: StateWriteOptions,
	): Promise<StateValue<T>> {
		const now = new Date(0).toISOString();
		const current = this.values.get(key);
		const row = {
			key,
			value,
			version: (current?.version ?? 0) + 1,
			expiresAt: new Date(60_000).toISOString(),
			createdAt: current?.createdAt ?? now,
			updatedAt: now,
		} satisfies StateValue<T>;
		this.values.set(key, row);
		return row;
	}

	async patch<T extends Record<string, unknown>>(): Promise<StateValue<T>> {
		throw new Error("MemoryProviderStateNamespace.patch is not implemented.");
	}

	async compareAndSet<T = unknown>(
		key: string,
		expectedVersion: number,
		value: T,
		_options?: StateWriteOptions,
	): Promise<StateCasResult<T>> {
		this.compareAndSetKeys.push(key);
		if (expectedVersion === 0 && this.forcedCreateCollisions > 0) {
			this.forcedCreateCollisions -= 1;
			return { ok: false, current: null };
		}
		const current = this.values.get(key) as StateValue<T> | undefined;
		if ((current?.version ?? 0) !== expectedVersion) {
			return { ok: false, current: current ?? null };
		}
		const now = new Date(0).toISOString();
		const stored = {
			key,
			value,
			version: expectedVersion + 1,
			expiresAt: new Date(60_000).toISOString(),
			createdAt: current?.createdAt ?? now,
			updatedAt: now,
		} satisfies StateValue<T>;
		this.values.set(key, stored);
		return { ok: true, value: stored };
	}

	async delete(key: string): Promise<void> {
		this.values.delete(key);
	}

	async increment(
		_key: string,
		_field: string,
		_delta = 1,
		_options?: StateWriteOptions,
	): Promise<StateValue<Record<string, unknown>>> {
		throw new Error("MemoryProviderStateNamespace.increment is not implemented.");
	}
}
