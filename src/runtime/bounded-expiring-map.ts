export type BoundedExpiringMapOptions<V> = {
	maxEntries: number;
	expiresAt: (value: V) => number;
	onCapacityEviction?: (value: V) => void;
};

export class BoundedExpiringMap<K, V> {
	private readonly entries = new Map<K, V>();
	private readonly maxEntries: number;
	private readonly expiresAt: (value: V) => number;
	private readonly onCapacityEviction: ((value: V) => void) | undefined;

	constructor(options: BoundedExpiringMapOptions<V>) {
		if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
			throw new RangeError("maxEntries must be a positive integer");
		}
		this.maxEntries = options.maxEntries;
		this.expiresAt = options.expiresAt;
		this.onCapacityEviction = options.onCapacityEviction;
	}

	get(key: K, now = Date.now()): V | undefined {
		if (!this.entries.has(key)) return undefined;
		const value = this.entries.get(key) as V;
		if (this.expiresAt(value) <= now) {
			this.entries.delete(key);
			return undefined;
		}

		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	set(key: K, value: V, now = Date.now()): void {
		this.sweepExpired(now);
		this.entries.delete(key);
		if (this.expiresAt(value) <= now) return;

		this.entries.set(key, value);
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			const evicted = this.entries.get(oldest.value) as V;
			this.entries.delete(oldest.value);
			this.onCapacityEviction?.(evicted);
		}
	}

	delete(key: K): boolean {
		return this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}

	private sweepExpired(now: number): void {
		for (const [key, value] of this.entries) {
			if (this.expiresAt(value) <= now) {
				this.entries.delete(key);
			}
		}
	}
}
