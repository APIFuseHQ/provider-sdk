import { describe, expect, it } from "bun:test";

import { BoundedExpiringMap } from "../bounded-expiring-map.js";

type Entry = { value: string; expiresAt: number };

function createMap(maxEntries = 2): BoundedExpiringMap<string, Entry> {
	return new BoundedExpiringMap(maxEntries, (entry) => entry.expiresAt);
}

describe("BoundedExpiringMap", () => {
	it("rejects a non-positive or fractional capacity", () => {
		for (const maxEntries of [0, -1, 1.5]) {
			expect(() => createMap(maxEntries)).toThrow(RangeError);
		}
	});

	it("drops expired entries on read and on insert without counting them as evictions", () => {
		const map = createMap();
		map.set("a", { value: "first", expiresAt: 10 }, 0);
		map.set("b", { value: "second", expiresAt: 20 }, 0);

		expect(map.get("a", 10)).toBeUndefined();
		expect(map.size).toBe(1);

		map.set("c", { value: "third", expiresAt: 30 }, 20);
		expect(map.get("b", 20)).toBeUndefined();
		expect(map.get("c", 20)?.value).toBe("third");
		expect(map.size).toBe(1);

		map.set("d", { value: "already expired", expiresAt: 20 }, 20);
		expect(map.size).toBe(1);
		expect(map.capacityEvictions).toBe(0);
	});

	it("evicts the least recently read entry past capacity and counts it", () => {
		const map = createMap(2);
		map.set("a", { value: "first", expiresAt: 100 }, 0);
		map.set("b", { value: "second", expiresAt: 100 }, 1);
		expect(map.get("a", 2)?.value).toBe("first");

		map.set("c", { value: "third", expiresAt: 100 }, 3);

		expect(map.get("b", 3)).toBeUndefined();
		expect(map.get("a", 3)?.value).toBe("first");
		expect(map.get("c", 3)?.value).toBe("third");
		expect(map.size).toBe(2);
		expect(map.capacityEvictions).toBe(1);
	});

	it("replaces an existing key in place", () => {
		const map = createMap(1);
		map.set("a", { value: "first", expiresAt: 10 }, 0);
		map.set("a", { value: "replacement", expiresAt: 20 }, 1);

		expect(map.size).toBe(1);
		expect(map.get("a", 1)?.value).toBe("replacement");
		expect(map.capacityEvictions).toBe(0);
	});
});
