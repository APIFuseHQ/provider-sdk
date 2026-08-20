import { describe, expect, it } from "bun:test";

import { ProviderChoiceTokenError } from "../choice-token.js";
import { createTestProviderChoiceContext } from "../runtime/choice.js";
import type { CredentialContext, ProviderRuntimeState } from "../types.js";
import { MemoryProviderRuntimeState } from "./memory-state.js";
import { assertIsError } from "./test-utils.js";

const STORAGE_OPTIONS = {
	mode: "server",
	namespace: "choice.stale.test.v1",
	ttl: "10m",
	maxEntries: 20,
	maxValueBytes: 10_000,
} as const;

const PREFIX = "provider_choice_v2";
const ISSUED_AT_MS = 1_000;
const TTL_MS = 60_000;
const FRESH_NOW_MS = 2_000;
const EXPIRED_NOW_MS = ISSUED_AT_MS + TTL_MS + 1;

type StoredWordChoiceRecord = Record<string, unknown> & {
	readonly payload: Record<string, unknown>;
	readonly replay_key: string;
};

function createChoiceFixture(options?: {
	readonly providerId?: string;
	readonly connectionId?: string;
	readonly credentialValues?: Record<string, string>;
	readonly state?: ProviderRuntimeState;
}) {
	const credentialValues = options?.credentialValues ?? { userId: "u1" };
	const credential = {
		mode: "credentials",
		get: (key: string) => credentialValues[key],
		getAll: () => credentialValues,
		getAccessToken: () => undefined,
		getScopes: () => [],
	} satisfies CredentialContext;
	return createTestProviderChoiceContext({
		providerId: options?.providerId ?? "provider-a",
		request: { connectionId: options?.connectionId ?? "af_con_test", headers: {} },
		credential,
		state: options?.state,
	});
}

async function expectStale(run: () => unknown | Promise<unknown>): Promise<ProviderChoiceTokenError> {
	try {
		await run();
	} catch (error) {
		expect(error).toBeInstanceOf(ProviderChoiceTokenError);
		assertIsError(error);
		expect(error.name).toBe("ProviderChoiceTokenError");
		expect(error.message).toBe("Provider choice token is stale.");
		const tokenError = error as ProviderChoiceTokenError;
		expect(tokenError.reason).toBe("stale");
		return tokenError;
	}
	throw new Error("Expected choice parsing to reject as stale.");
}

async function expectCollapsedNotFound(run: () => unknown | Promise<unknown>): Promise<void> {
	try {
		await run();
	} catch (error) {
		expect(error).toBeInstanceOf(ProviderChoiceTokenError);
		assertIsError(error);
		expect(error.name).toBe("ProviderChoiceTokenError");
		expect(error.message).toBe("Provider choice token was not found.");
		expect((error as ProviderChoiceTokenError).reason).toBe("invalid_payload");
		return;
	}
	throw new Error("Expected choice parsing to reject as not found.");
}

describe("word choice stale classification (ADR 0006, amended 2026-08-20)", () => {
	it("(a) surfaces stale to a connection-bound caller whose binding verified", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createChoiceFixture({ state });
		const token = await choice.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		});
		const parseOptions = {
			token,
			prefix: PREFIX,
			purpose: "reservation",
			ttlMs: TTL_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		} as const;

		// The reorder keeps bound fresh round-trips intact.
		await expect(choice.parse({ ...parseOptions, nowMs: FRESH_NOW_MS })).resolves.toEqual({
			choice_id: "A",
		});
		await expectStale(() => choice.parse({ ...parseOptions, nowMs: EXPIRED_NOW_MS }));
	});

	it("(a) surfaces stale to a credential-bound caller whose binding verified", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createChoiceFixture({ state, credentialValues: { userId: "member-7" } });
		const token = await choice.issue({
			prefix: PREFIX,
			purpose: "checkout",
			payload: { choice_id: "B" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { credentialKeys: ["userId"] },
			storage: STORAGE_OPTIONS,
		});
		const parseOptions = {
			token,
			prefix: PREFIX,
			purpose: "checkout",
			ttlMs: TTL_MS,
			bind: { credentialKeys: ["userId"] },
			storage: STORAGE_OPTIONS,
		} as const;

		await expect(choice.parse({ ...parseOptions, nowMs: FRESH_NOW_MS })).resolves.toEqual({
			choice_id: "B",
		});
		await expectStale(() => choice.parse({ ...parseOptions, nowMs: EXPIRED_NOW_MS }));
	});

	it("(a) surfaces stale when both connection and credential bindings verified", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createChoiceFixture({ state });
		const token = await choice.issue({
			prefix: PREFIX,
			purpose: "payment",
			payload: { choice_id: "C" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { connection: true, credentialKeys: ["userId"] },
			storage: STORAGE_OPTIONS,
		});

		await expectStale(() =>
			choice.parse({
				token,
				prefix: PREFIX,
				purpose: "payment",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
				bind: { connection: true, credentialKeys: ["userId"] },
				storage: STORAGE_OPTIONS,
			}),
		);
	});

	it("(a) word stale error matches the inline stale error shape exactly", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createChoiceFixture({ state });
		const inlineToken = choice.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "inline" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
		});
		const wordToken = await choice.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "word" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		});

		const inlineError = await expectStale(() =>
			choice.parse({
				token: inlineToken,
				prefix: PREFIX,
				purpose: "reservation",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
			}),
		);
		const wordError = await expectStale(() =>
			choice.parse({
				token: wordToken,
				prefix: PREFIX,
				purpose: "reservation",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
				bind: { connection: true },
				storage: STORAGE_OPTIONS,
			}),
		);

		expect(wordError.constructor).toBe(inlineError.constructor);
		expect(wordError.name).toBe(inlineError.name);
		expect(wordError.message).toBe(inlineError.message);
		expect(wordError.reason).toBe(inlineError.reason);
	});

	it("(a) surfaces stale on an expired bound record in explicit mode as well", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createChoiceFixture({ state });
		const token = await choice.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "explicit" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		});

		await expectStale(() =>
			choice.parse({
				token,
				prefix: PREFIX,
				purpose: "reservation",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
				bind: { connection: true },
				storage: STORAGE_OPTIONS,
				consume: "explicit",
			}),
		);
	});

	it("(b) collapses an expired bound record for a caller on the wrong connection", async () => {
		const state = new MemoryProviderRuntimeState();
		const issuer = createChoiceFixture({ state, connectionId: "af_con_a" });
		const token = await issuer.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		});
		// Guesser simulation: a different connection has learned the live word
		// sequence. Binding verification fails, so expiry must stay invisible.
		const guesser = createChoiceFixture({ state, connectionId: "af_con_b" });

		await expectCollapsedNotFound(() =>
			guesser.parse({
				token,
				prefix: PREFIX,
				purpose: "reservation",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
				bind: { connection: true },
				storage: STORAGE_OPTIONS,
			}),
		);
	});

	it("(b) collapses an expired bound record when the parse requests no binding", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createChoiceFixture({ state });
		const token = await choice.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		});

		await expectCollapsedNotFound(() =>
			choice.parse({
				token,
				prefix: PREFIX,
				purpose: "reservation",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
				storage: STORAGE_OPTIONS,
			}),
		);
	});

	it("(b) collapses an expired credential-bound record for the wrong credential", async () => {
		const state = new MemoryProviderRuntimeState();
		const issuer = createChoiceFixture({ state, credentialValues: { userId: "member-7" } });
		const token = await issuer.issue({
			prefix: PREFIX,
			purpose: "checkout",
			payload: { choice_id: "B" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { credentialKeys: ["userId"] },
			storage: STORAGE_OPTIONS,
		});
		const guesser = createChoiceFixture({ state, credentialValues: { userId: "member-8" } });

		await expectCollapsedNotFound(() =>
			guesser.parse({
				token,
				prefix: PREFIX,
				purpose: "checkout",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
				bind: { credentialKeys: ["userId"] },
				storage: STORAGE_OPTIONS,
			}),
		);
	});

	it("(c) keeps the collapsed error for an expired unbound record", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createChoiceFixture({ state });
		const token = await choice.issue({
			prefix: PREFIX,
			purpose: "search-page",
			payload: { cursor: "expired" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			storage: STORAGE_OPTIONS,
		});

		await expectCollapsedNotFound(() =>
			choice.parse({
				token,
				prefix: PREFIX,
				purpose: "search-page",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
				storage: STORAGE_OPTIONS,
			}),
		);
	});

	it("(d) collapses a tampered payload digest on a bound record, fresh and expired", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createChoiceFixture({ state });
		await choice.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		});
		const namespace = state.firstNamespace();
		const stored = await namespace.list<StoredWordChoiceRecord>({ limit: 1 });
		const row = stored[0];
		if (!row) throw new Error("Expected a stored choice record.");
		await namespace.set(row.key, { ...row.value, payload: { choice_id: "tampered" } });
		const parseOptions = {
			token: `${PREFIX}${row.key}`,
			prefix: PREFIX,
			purpose: "reservation",
			ttlMs: TTL_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		} as const;

		await expectCollapsedNotFound(() => choice.parse({ ...parseOptions, nowMs: FRESH_NOW_MS }));
		// Expired variant: the digest failure must win over stale classification.
		await expectCollapsedNotFound(() => choice.parse({ ...parseOptions, nowMs: EXPIRED_NOW_MS }));
	});

	it("(d) collapses a tampered replay key on an expired bound record", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createChoiceFixture({ state });
		await choice.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		});
		const namespace = state.firstNamespace();
		const stored = await namespace.list<StoredWordChoiceRecord>({ limit: 1 });
		const row = stored[0];
		if (!row) throw new Error("Expected a stored choice record.");
		await namespace.set(row.key, { ...row.value, replay_key: "0".repeat(64) });

		await expectCollapsedNotFound(() =>
			choice.parse({
				token: `${PREFIX}${row.key}`,
				prefix: PREFIX,
				purpose: "reservation",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
				bind: { connection: true },
				storage: STORAGE_OPTIONS,
			}),
		);
	});

	it("(e) collapses a wrong purpose on an expired bound record", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createChoiceFixture({ state });
		const token = await choice.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		});

		await expectCollapsedNotFound(() =>
			choice.parse({
				token,
				prefix: PREFIX,
				purpose: "another-purpose",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
				bind: { connection: true },
				storage: STORAGE_OPTIONS,
			}),
		);
	});

	it("(e) collapses a wrong provider id on an expired bound record", async () => {
		const state = new MemoryProviderRuntimeState();
		const issuer = createChoiceFixture({ state, providerId: "provider-a" });
		const token = await issuer.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		});
		const otherProvider = createChoiceFixture({ state, providerId: "provider-b" });

		await expectCollapsedNotFound(() =>
			otherProvider.parse({
				token,
				prefix: PREFIX,
				purpose: "reservation",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
				bind: { connection: true },
				storage: STORAGE_OPTIONS,
			}),
		);
	});

	it("keeps the collapsed error for a consumed fresh bound record in never mode", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createChoiceFixture({ state });
		const token = await choice.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "single-use" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		});
		const parseOptions = {
			token,
			prefix: PREFIX,
			purpose: "reservation",
			ttlMs: TTL_MS,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		} as const;
		await choice.parse({ ...parseOptions, nowMs: FRESH_NOW_MS, consume: "on-parse" });

		await expectCollapsedNotFound(() => choice.parse({ ...parseOptions, nowMs: FRESH_NOW_MS }));
	});

	it("(f) keeps the inline envelope stale classification unchanged", () => {
		const choice = createChoiceFixture();
		const token = choice.issue({
			prefix: PREFIX,
			purpose: "reservation",
			payload: { choice_id: "inline" },
			ttlMs: TTL_MS,
			nowMs: ISSUED_AT_MS,
		});

		try {
			choice.parse({
				token,
				prefix: PREFIX,
				purpose: "reservation",
				ttlMs: TTL_MS,
				nowMs: EXPIRED_NOW_MS,
			});
			throw new Error("Expected inline choice parsing to reject.");
		} catch (error) {
			expect(error).toBeInstanceOf(ProviderChoiceTokenError);
			assertIsError(error);
			expect(error.name).toBe("ProviderChoiceTokenError");
			expect(error.message).toBe("Provider choice token is stale.");
			expect((error as ProviderChoiceTokenError).reason).toBe("stale");
		}
	});
});
