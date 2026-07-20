import { describe, expect, it } from "bun:test";

import { loadKeyRing } from "../runtime/keyring.js";

const KEY_V1 = Buffer.alloc(32, 1).toString("base64");
const KEY_V2 = Buffer.alloc(32, 2).toString("base64");
const KEY_V3 = Buffer.alloc(32, 3).toString("base64");

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
	const base: NodeJS.ProcessEnv = {};
	return { ...base, ...overrides };
}

describe("loadKeyRing", () => {
	it("loads a single-version ring", () => {
		const ring = loadKeyRing({
			env: env({
				APIFUSE__KEYRING__MASTER_KEY_V1: KEY_V1,
				APIFUSE__KEYRING__MASTER_KEY_ACCEPT_LIST: "1",
				APIFUSE__KEYRING__MASTER_KEY_WRITER_VERSION: "1",
			}),
		});
		expect(ring.versions()).toEqual([1]);
		expect(ring.activeWriter().version).toBe(1);
		expect(ring.accept(1).key.length).toBe(32);
	});

	it("loads multi-version accept list", () => {
		const ring = loadKeyRing({
			env: env({
				APIFUSE__KEYRING__MASTER_KEY_V1: KEY_V1,
				APIFUSE__KEYRING__MASTER_KEY_V2: KEY_V2,
				APIFUSE__KEYRING__MASTER_KEY_V3: KEY_V3,
				APIFUSE__KEYRING__MASTER_KEY_ACCEPT_LIST: "1,2,3",
				APIFUSE__KEYRING__MASTER_KEY_WRITER_VERSION: "2",
			}),
		});
		expect(ring.versions()).toEqual([1, 2, 3]);
		expect(ring.activeWriter().version).toBe(2);
		expect(ring.accept(3).key.length).toBe(32);
	});

	it("rejects an empty accept list", () => {
		expect(() =>
			loadKeyRing({
				env: env({
					APIFUSE__KEYRING__MASTER_KEY_V1: KEY_V1,
					APIFUSE__KEYRING__MASTER_KEY_ACCEPT_LIST: "",
					APIFUSE__KEYRING__MASTER_KEY_WRITER_VERSION: "1",
				}),
			}),
		).toThrow();
	});

	it("rejects non-integer entries in accept list", () => {
		expect(() =>
			loadKeyRing({
				env: env({
					APIFUSE__KEYRING__MASTER_KEY_V1: KEY_V1,
					APIFUSE__KEYRING__MASTER_KEY_ACCEPT_LIST: "1,abc",
					APIFUSE__KEYRING__MASTER_KEY_WRITER_VERSION: "1",
				}),
			}),
		).toThrow();
	});

	it("rejects a writer version outside the accept list", () => {
		expect(() =>
			loadKeyRing({
				env: env({
					APIFUSE__KEYRING__MASTER_KEY_V1: KEY_V1,
					APIFUSE__KEYRING__MASTER_KEY_ACCEPT_LIST: "1",
					APIFUSE__KEYRING__MASTER_KEY_WRITER_VERSION: "2",
				}),
			}),
		).toThrow(/not in the accept-list/);
	});

	it("rejects accept list when a listed version's key env is missing", () => {
		expect(() =>
			loadKeyRing({
				env: env({
					APIFUSE__KEYRING__MASTER_KEY_V1: KEY_V1,
					APIFUSE__KEYRING__MASTER_KEY_ACCEPT_LIST: "1,2",
					APIFUSE__KEYRING__MASTER_KEY_WRITER_VERSION: "1",
				}),
			}),
		).toThrow(/APIFUSE__KEYRING__MASTER_KEY_V2 is missing/);
	});

	it("accept(v) throws for a version not in the accept list", () => {
		const ring = loadKeyRing({
			env: env({
				APIFUSE__KEYRING__MASTER_KEY_V1: KEY_V1,
				APIFUSE__KEYRING__MASTER_KEY_ACCEPT_LIST: "1",
				APIFUSE__KEYRING__MASTER_KEY_WRITER_VERSION: "1",
			}),
		});
		expect(() => ring.accept(2)).toThrow();
	});

	it("purgeVersion refuses when isActiveInStore returns true", async () => {
		const ring = loadKeyRing({
			env: env({
				APIFUSE__KEYRING__MASTER_KEY_V1: KEY_V1,
				APIFUSE__KEYRING__MASTER_KEY_V2: KEY_V2,
				APIFUSE__KEYRING__MASTER_KEY_ACCEPT_LIST: "1,2",
				APIFUSE__KEYRING__MASTER_KEY_WRITER_VERSION: "2",
			}),
		});
		await expect(ring.purgeVersion(1, async () => true)).rejects.toThrow(/cannot purge/);
		expect(() => ring.accept(1)).not.toThrow();
	});

	it("purgeVersion drops entry when isActiveInStore returns false", async () => {
		const ring = loadKeyRing({
			env: env({
				APIFUSE__KEYRING__MASTER_KEY_V1: KEY_V1,
				APIFUSE__KEYRING__MASTER_KEY_V2: KEY_V2,
				APIFUSE__KEYRING__MASTER_KEY_ACCEPT_LIST: "1,2",
				APIFUSE__KEYRING__MASTER_KEY_WRITER_VERSION: "2",
			}),
		});
		await ring.purgeVersion(1, async () => false);
		expect(() => ring.accept(1)).toThrow();
	});
});
