import { describe, expect, it } from "bun:test";
import { BoundedExpiringMap } from "../runtime/bounded-expiring-map";

type Entry = {
	value: string;
	expiresAt: number;
};

function createCache(maxEntries = 2): BoundedExpiringMap<string, Entry> {
	return new BoundedExpiringMap({
		maxEntries,
		expiresAt: (entry) => entry.expiresAt,
	});
}

describe("BoundedExpiringMap", () => {
	it("rejects invalid maximum entry counts", () => {
		for (const maxEntries of [0, -1, 1.5]) {
			expect(() => createCache(maxEntries)).toThrow(RangeError);
		}
	});

	it("deletes an expired entry when it is read", () => {
		const cache = createCache();
		cache.set("a", { value: "first", expiresAt: 10 }, 0);

		expect(cache.size).toBe(1);
		expect(cache.get("a", 10)).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it("does not retain an already-expired value", () => {
		const cache = createCache();
		cache.set("a", { value: "first", expiresAt: 10 }, 10);

		expect(cache.size).toBe(0);
	});

	it("sweeps expired entries before inserting a value", () => {
		const cache = createCache();
		cache.set("a", { value: "first", expiresAt: 10 }, 0);
		cache.set("b", { value: "second", expiresAt: 20 }, 10);

		expect(cache.size).toBe(1);
		expect(cache.get("a", 10)).toBeUndefined();
		expect(cache.get("b", 10)?.value).toBe("second");
	});

	it("refreshes LRU order on a fresh read", () => {
		const cache = createCache();
		cache.set("a", { value: "first", expiresAt: 100 }, 0);
		cache.set("b", { value: "second", expiresAt: 100 }, 1);

		expect(cache.get("a", 2)?.value).toBe("first");
		cache.set("c", { value: "third", expiresAt: 100 }, 3);

		expect(cache.get("b", 3)).toBeUndefined();
		expect(cache.get("a", 3)?.value).toBe("first");
		expect(cache.get("c", 3)?.value).toBe("third");
		expect(cache.size).toBe(2);
	});

	it("replaces an existing key without growing", () => {
		const cache = createCache();
		cache.set("a", { value: "first", expiresAt: 10 }, 0);
		cache.set("a", { value: "replacement", expiresAt: 20 }, 1);

		expect(cache.size).toBe(1);
		expect(cache.get("a", 1)?.value).toBe("replacement");
	});

	it("evicts the oldest entries until the hard limit is satisfied", () => {
		const cache = createCache(1);
		cache.set("a", { value: "first", expiresAt: 100 }, 0);
		cache.set("b", { value: "second", expiresAt: 100 }, 1);

		expect(cache.get("a", 1)).toBeUndefined();
		expect(cache.get("b", 1)?.value).toBe("second");
		expect(cache.size).toBe(1);
	});

	it("reports capacity eviction without treating expiry cleanup as overflow", () => {
		const evicted: Entry[] = [];
		const cache = new BoundedExpiringMap<string, Entry>({
			maxEntries: 1,
			expiresAt: (entry) => entry.expiresAt,
			onCapacityEviction: (entry) => evicted.push(entry),
		});
		cache.set("expired", { value: "old", expiresAt: 1 }, 0);
		cache.set("fresh", { value: "first", expiresAt: 100 }, 1);
		cache.set("new", { value: "second", expiresAt: 100 }, 2);

		expect(evicted).toEqual([{ value: "first", expiresAt: 100 }]);
	});
});
