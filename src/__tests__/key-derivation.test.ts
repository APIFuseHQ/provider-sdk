import { beforeEach, describe, expect, it } from "bun:test";

import {
	ConfigurationError,
	decodeMasterKey,
	deriveSubkey,
	invalidateSubkeyCache,
	type KeyPurpose,
} from "../runtime/key-derivation";

const TEST_KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 11);

describe("decodeMasterKey", () => {
	it("decodes base64 with standard alphabet", () => {
		const raw = decodeMasterKey(TEST_KEY.toString("base64"));
		expect(raw.equals(TEST_KEY)).toBe(true);
	});

	it("decodes base64url (with -, _)", () => {
		const encoded = TEST_KEY.toString("base64url");
		const raw = decodeMasterKey(encoded);
		expect(raw.equals(TEST_KEY)).toBe(true);
	});

	it("rejects empty input", () => {
		expect(() => decodeMasterKey("")).toThrow(ConfigurationError);
	});

	it("rejects invalid base64 characters", () => {
		expect(() => decodeMasterKey("!@#$%^&*")).toThrow(ConfigurationError);
	});

	it("rejects keys shorter than 32 bytes after decode", () => {
		const short = Buffer.alloc(16, 1).toString("base64");
		expect(() => decodeMasterKey(short)).toThrow(/≥ 32 bytes/);
	});
});

describe("deriveSubkey", () => {
	beforeEach(() => invalidateSubkeyCache());

	it("is deterministic for a given (masterKey, providerId, purpose, version)", () => {
		const a = deriveSubkey(TEST_KEY, "provider-x", "credential-encryption", 1);
		invalidateSubkeyCache();
		const b = deriveSubkey(TEST_KEY, "provider-x", "credential-encryption", 1);
		expect(a.equals(b)).toBe(true);
	});

	it("returns a cached buffer on repeated calls (same identity)", () => {
		const a = deriveSubkey(TEST_KEY, "provider-x", "credential-encryption", 1);
		const b = deriveSubkey(TEST_KEY, "provider-x", "credential-encryption", 1);
		expect(a === b).toBe(true);
	});

	it("produces different subkeys for different purposes (cross-purpose independence)", () => {
		const a = deriveSubkey(TEST_KEY, "provider-x", "credential-encryption", 1);
		const b = deriveSubkey(TEST_KEY, "provider-x", "context-namespace", 1);
		const c = deriveSubkey(TEST_KEY, "provider-x", "token-signing", 1);
		expect(a.equals(b)).toBe(false);
		expect(a.equals(c)).toBe(false);
		expect(b.equals(c)).toBe(false);
	});

	it("produces different subkeys for different providers", () => {
		const a = deriveSubkey(TEST_KEY, "provider-x", "credential-encryption", 1);
		const b = deriveSubkey(TEST_KEY, "provider-y", "credential-encryption", 1);
		expect(a.equals(b)).toBe(false);
	});

	it("includes key version in cache identity but not in the derivation itself", () => {
		const v1 = deriveSubkey(TEST_KEY, "provider-x", "credential-encryption", 1);
		const v2 = deriveSubkey(TEST_KEY, "provider-x", "credential-encryption", 2);
		// Same master + same (provider, purpose) → same byte output regardless of version
		// (version disambiguates rotation; rotation is triggered by master key change).
		expect(v1.equals(v2)).toBe(true);
		expect(v1 === v2).toBe(false);
	});

	it("produces different subkeys for different master secrets", () => {
		const a = deriveSubkey(TEST_KEY, "provider-x", "credential-encryption", 1);
		invalidateSubkeyCache();
		const b = deriveSubkey(OTHER_KEY, "provider-x", "credential-encryption", 1);
		expect(a.equals(b)).toBe(false);
	});

	it("rejects short master keys", () => {
		const short = Buffer.alloc(16, 7);
		expect(() =>
			deriveSubkey(short, "provider-x", "credential-encryption", 1),
		).toThrow(ConfigurationError);
	});

	it("rejects empty providerId", () => {
		expect(() =>
			deriveSubkey(TEST_KEY, "", "credential-encryption", 1),
		).toThrow(ConfigurationError);
	});

	it("matches the cross-language HKDF reference test vector", () => {
		// Vector definition (Node + Go must produce identical bytes):
		//   master  = 32 bytes of 0x07
		//   salt    = SHA-256("apifuse:v1:credential-encryption")
		//   info    = "provider=korea-weather"
		//   output  = HKDF-SHA256(master, salt, info, 32)
		// Go (crypto/hkdf) and Node (node:crypto.hkdfSync) must both return this hex.
		const subkey = deriveSubkey(
			TEST_KEY,
			"korea-weather",
			"credential-encryption",
			1,
		);
		expect(subkey.toString("hex")).toBe(
			"8dccd08c8a601613cdec1d005d36207e2670ae4bddb70500865316faa2491f4b",
		);
	});
});

describe("KeyPurpose enum coverage", () => {
	it("covers exactly the three purposes defined in the spec", () => {
		const purposes: KeyPurpose[] = [
			"credential-encryption",
			"context-namespace",
			"token-signing",
		];
		for (const p of purposes) {
			const k = deriveSubkey(TEST_KEY, "p", p, 1);
			expect(k.length).toBe(32);
		}
	});
});
