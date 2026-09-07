/**
 * Map whose entries carry an expiry and whose size is capped.
 *
 * Expired entries are dropped when read and swept on every insert, so a
 * process that keeps minting new keys does not retain dead values. When the
 * cap is still exceeded after the sweep, the least recently used entry is
 * evicted and counted in `capacityEvictions` so callers can tell the two
 * kinds of removal apart. Callers pass `now` explicitly so a single timestamp
 * is used across a lookup-then-store sequence.
 */
export class BoundedExpiringMap<K, V> {
	readonly #entries = new Map<K, V>();
	readonly #maxEntries: number;
	readonly #expiresAt: (value: V) => number;
	#capacityEvictions = 0;

	constructor(maxEntries: number, expiresAt: (value: V) => number) {
		if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
			throw new RangeError("maxEntries must be a positive integer");
		}
		this.#maxEntries = maxEntries;
		this.#expiresAt = expiresAt;
	}

	get size(): number {
		return this.#entries.size;
	}

	/** Entries removed to satisfy `maxEntries`; expiry removals are not counted. */
	get capacityEvictions(): number {
		return this.#capacityEvictions;
	}

	get(key: K, now: number): V | undefined {
		if (!this.#entries.has(key)) return undefined;
		const value = this.#entries.get(key) as V;
		this.#entries.delete(key);
		if (this.#expiresAt(value) <= now) return undefined;
		// Re-insert so Map iteration order doubles as the LRU order.
		this.#entries.set(key, value);
		return value;
	}

	set(key: K, value: V, now: number): void {
		for (const [existingKey, existing] of this.#entries) {
			if (this.#expiresAt(existing) <= now) this.#entries.delete(existingKey);
		}
		this.#entries.delete(key);
		if (this.#expiresAt(value) <= now) return;
		this.#entries.set(key, value);
		if (this.#entries.size > this.#maxEntries) {
			const oldest = this.#entries.keys().next();
			if (!oldest.done) {
				this.#entries.delete(oldest.value);
				this.#capacityEvictions += 1;
			}
		}
	}

	delete(key: K): boolean {
		return this.#entries.delete(key);
	}

	clear(): void {
		this.#entries.clear();
	}
}
