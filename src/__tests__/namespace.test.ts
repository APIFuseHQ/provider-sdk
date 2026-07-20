import { beforeEach, describe, expect, it } from "bun:test";

import { invalidateSubkeyCache } from "../runtime/key-derivation.js";
import { deriveContextNamespace } from "../runtime/namespace.js";

const MASTER = Buffer.alloc(32, 7);

describe("deriveContextNamespace", () => {
	beforeEach(() => invalidateSubkeyCache());

	it("produces the provider:{hmac16}:{sessionId} shape", () => {
		const ns = deriveContextNamespace(MASTER, "korea-weather", "flow-abc", 1);
		expect(ns).toMatch(/^provider:[0-9a-f]{16}:flow-abc$/);
	});

	it("is deterministic for the same inputs", () => {
		const a = deriveContextNamespace(MASTER, "korea-weather", "s", 1);
		const b = deriveContextNamespace(MASTER, "korea-weather", "s", 1);
		expect(a).toBe(b);
	});

	it("changes namespace when providerId changes", () => {
		const a = deriveContextNamespace(MASTER, "provider-a", "s", 1);
		const b = deriveContextNamespace(MASTER, "provider-b", "s", 1);
		expect(a).not.toBe(b);
	});

	it("changes the hmac16 segment (not sessionId) when provider changes", () => {
		const a = deriveContextNamespace(MASTER, "provider-a", "s", 1);
		const b = deriveContextNamespace(MASTER, "provider-b", "s", 1);
		const hmacA = a.split(":")[1];
		const hmacB = b.split(":")[1];
		expect(hmacA).not.toBe(hmacB);
		expect(a.split(":")[2]).toBe(b.split(":")[2]);
	});

	it("rejects empty sessionId", () => {
		expect(() => deriveContextNamespace(MASTER, "p", "", 1)).toThrow();
	});
});
