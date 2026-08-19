import { describe, expect, it } from "bun:test";
import { ProviderChoiceTokenError } from "../choice-token.js";
import { ProviderError } from "../errors.js";
import {
	createProviderChoiceContext,
	createTestProviderChoiceContext,
	type ProviderChoiceTelemetryEvent,
} from "../runtime/choice.js";
import { createUnsupportedProviderRuntimeState } from "../runtime/state.js";
import type { CredentialContext, ProviderRuntimeState } from "../types.js";
import { MemoryProviderRuntimeState } from "./memory-state.js";

const STORAGE_OPTIONS = {
	mode: "server",
	namespace: "choice.test.v1",
	ttl: "10m",
	maxEntries: 20,
	maxValueBytes: 10_000,
} as const;

const WORD_PREFIX = "modu_page_";
const LEGACY_SERVER_TOKEN =
	"provider_choice_v2.v1.aA_KfqXRMfW1vAMH.rGa_m8X_WGzM31XYi3hMlS1FV4ERTusU8P-qWH5orEEzq68xs0mAyCe2YS2a614PdSllsaM0Jwd9ArQpSC83SQRgHFMLZNZ0VkaA7ldfYnmB2daa9dYl0J41PBKqft6EHjuShG-szFVYpnvKluDnQOCDIjB3fwI2asuZq6nThhUWW_6TULEzPwuAuJ6bNFUbdn1lYJh5Mx8yHlXyc6CCODivRauGfW1YV9sv1QaHH_6Y3tU3ELJ__4BcwVNnQo8bYDXRG8d7ztBji8-HptLYjq8AMNHzT_JOCU1CELEdg8A7trLwolANlrX1pWlpk3luYpcp1j_b9OTM6gM.UrRsI38KfHhEOzWnYKnL3A.NGgP1GKQX77AXxd6T0S3K1jPexBfhiLHNDwyZ7cGRPc";
const LEGACY_SERVER_STATE_KEY = "choice_ZAcETxGY58SoG6QxsbCbgw";

function tokenWordCount(token: string, prefix: string): number {
	const body = token.slice(prefix.length);
	const internalHyphens = body.match(/yo-yo/g)?.length ?? 0;
	return body.split("-").length - internalHyphens;
}

async function expectWordChoiceNotFound(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
		throw new Error("Expected word choice parsing to reject.");
	} catch (error) {
		expect(error).toBeInstanceOf(ProviderChoiceTokenError);
		expect((error as ProviderChoiceTokenError).reason).toBe("invalid_payload");
		expect((error as Error).message).toBe("Provider choice token was not found.");
	}
}

function createManagedChoiceFixture(options?: {
	readonly connectionId?: string;
	readonly credentialValues?: Record<string, string>;
	readonly state?: ProviderRuntimeState;
	readonly onTelemetry?: (event: ProviderChoiceTelemetryEvent) => void;
}) {
	const credentialValues = options?.credentialValues ?? { userId: "u1" };
	const credential = {
		mode: "credentials",
		get: (key: string) => credentialValues[key],
		getAll: () => credentialValues,
		getAccessToken: () => undefined,
		getScopes: () => [],
	} satisfies CredentialContext;
	const request = {
		connectionId: options?.connectionId ?? "af_con_test",
		headers: {},
	};
	return createTestProviderChoiceContext({
		providerId: "provider-a",
		request,
		credential,
		state: options?.state,
		onTelemetry: options?.onTelemetry,
	});
}

describe("managed choice storage", () => {
	it("keeps inline managed provider choices synchronous", () => {
		const choice = createManagedChoiceFixture();

		const token = choice.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: 60_000,
			nowMs: 1_000,
		});
		const parsed = choice.parse({
			token,
			prefix: "provider_choice_v2",
			purpose: "reservation",
			ttlMs: 60_000,
			nowMs: 2_000,
		});

		expect(token).toStartWith("provider_choice_v2.v1.");
		expect(parsed).toEqual({ choice_id: "A" });
	});

	it("parses a legacy encrypted server handle during the compatibility window", async () => {
		const state = new MemoryProviderRuntimeState();
		const namespace = state.namespace(STORAGE_OPTIONS.namespace, {
			defaultTtl: STORAGE_OPTIONS.ttl,
			maxTtl: STORAGE_OPTIONS.ttl,
			maxEntries: STORAGE_OPTIONS.maxEntries,
			maxValueBytes: STORAGE_OPTIONS.maxValueBytes,
		});
		await namespace.set(LEGACY_SERVER_STATE_KEY, { choice_id: "legacy-A" });
		const choice = createManagedChoiceFixture({ state });

		const parsed = await choice.parse({
			token: LEGACY_SERVER_TOKEN,
			prefix: "provider_choice_v2",
			purpose: "reservation",
			ttlMs: 60_000,
			nowMs: 2_000,
			storage: STORAGE_OPTIONS,
		});

		expect(parsed).toEqual({ choice_id: "legacy-A" });
	});

	it("round-trips a four-word server-stored choice", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({ state });
		const payload = {
			choice_id: "A",
			details: "x".repeat(4_000),
		};

		const inlineToken = choice.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload,
			ttlMs: 60_000,
			nowMs: 1_000,
		});
		const serverToken = await choice.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload,
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: STORAGE_OPTIONS,
		});
		const parseOptions = {
			token: serverToken,
			prefix: "provider_choice_v2",
			purpose: "reservation",
			ttlMs: 60_000,
			nowMs: 2_000,
			storage: STORAGE_OPTIONS,
		} as const;
		const parsed = await choice.parse(parseOptions);
		const parsedAgain = await choice.parse(parseOptions);

		expect(serverToken.length).toBeLessThan(inlineToken.length / 2);
		expect(serverToken).toStartWith("provider_choice_v2");
		expect(tokenWordCount(serverToken, "provider_choice_v2")).toBe(4);
		expect(parsed).toEqual(payload);
		expect(parsedAgain).toEqual(payload);
		const stored = await state.firstNamespace().list({ limit: 1 });
		expect(stored[0]?.key).toBe(serverToken.slice("provider_choice_v2".length));
		expect(stored[0]?.value).toMatchObject({
			v: 1,
			storage: "server",
			status: "active",
			provider_id: "provider-a",
			purpose: "reservation",
			issued_at_ms: 1_000,
			ttl_ms: 60_000,
			payload,
			payload_digest: expect.any(String),
			replay_key: expect.any(String),
		});
	});

	it("round-trips a five-word high-strength server-stored choice", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({ state });
		const payload = { page: 7, cursor: "high-strength" };

		const token = await choice.issue({
			prefix: WORD_PREFIX,
			purpose: "search-page",
			payload,
			ttlMs: 60_000,
			nowMs: 1_000,
			strength: "high",
			storage: STORAGE_OPTIONS,
		});
		const parsed = await choice.parse({
			token,
			prefix: WORD_PREFIX,
			purpose: "search-page",
			ttlMs: 60_000,
			nowMs: 2_000,
			storage: STORAGE_OPTIONS,
		});

		expect(tokenWordCount(token, WORD_PREFIX)).toBe(5);
		expect(parsed).toEqual(payload);
	});

	it("uses word format when auto storage resolves server-side", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({ state });
		const autoStorage = {
			...STORAGE_OPTIONS,
			mode: "auto",
			maxInlineBytes: 10,
		} as const;

		const issued = choice.issue({
			prefix: WORD_PREFIX,
			purpose: "search-page",
			payload: { cursor: "stored-server-side" },
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: autoStorage,
		});
		const token = typeof issued === "string" ? issued : await issued;

		expect(token).toStartWith(WORD_PREFIX);
		expect(tokenWordCount(token, WORD_PREFIX)).toBe(4);
	});

	it("does not require the envelope master secret for unbound word choices", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createProviderChoiceContext({ providerId: "provider-a", state });
		const payload = { cursor: "no-envelope-secret" };

		const token = await choice.issue({
			prefix: WORD_PREFIX,
			purpose: "search-page",
			payload,
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: STORAGE_OPTIONS,
		});
		const parsed = await choice.parse({
			token,
			prefix: WORD_PREFIX,
			purpose: "search-page",
			ttlMs: 60_000,
			nowMs: 2_000,
			storage: STORAGE_OPTIONS,
		});

		expect(parsed).toEqual(payload);
	});

	it("regenerates the word sequence after a state-key collision", async () => {
		const state = new MemoryProviderRuntimeState();
		state.namespace(STORAGE_OPTIONS.namespace, {
			defaultTtl: STORAGE_OPTIONS.ttl,
			maxTtl: STORAGE_OPTIONS.ttl,
			maxEntries: STORAGE_OPTIONS.maxEntries,
			maxValueBytes: STORAGE_OPTIONS.maxValueBytes,
		});
		const namespace = state.firstNamespace();
		namespace.forcedCreateCollisions = 1;
		const choice = createManagedChoiceFixture({ state });

		const token = await choice.issue({
			prefix: WORD_PREFIX,
			purpose: "search-page",
			payload: { cursor: "collision-retry" },
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: STORAGE_OPTIONS,
		});

		expect(namespace.compareAndSetKeys).toHaveLength(2);
		expect(namespace.compareAndSetKeys[1]).not.toBe(namespace.compareAndSetKeys[0]);
		expect(token).toBe(`${WORD_PREFIX}${namespace.compareAndSetKeys[1]}`);
	});

	it("fails with choice-state unavailable after five collisions", async () => {
		const state = new MemoryProviderRuntimeState();
		state.namespace(STORAGE_OPTIONS.namespace, {
			defaultTtl: STORAGE_OPTIONS.ttl,
			maxTtl: STORAGE_OPTIONS.ttl,
			maxEntries: STORAGE_OPTIONS.maxEntries,
			maxValueBytes: STORAGE_OPTIONS.maxValueBytes,
		});
		const namespace = state.firstNamespace();
		namespace.forcedCreateCollisions = 5;
		const choice = createManagedChoiceFixture({ state });

		try {
			await choice.issue({
				prefix: WORD_PREFIX,
				purpose: "search-page",
				payload: { cursor: "collision-exhaustion" },
				ttlMs: 60_000,
				nowMs: 1_000,
				storage: STORAGE_OPTIONS,
			});
			throw new Error("Expected choice issuance to reject.");
		} catch (error) {
			expect(error).toBeInstanceOf(ProviderError);
			expect((error as ProviderError).code).toBe("CHOICE_STATE_UNAVAILABLE");
		}
		expect(namespace.compareAndSetKeys).toHaveLength(5);
	});

	it("prints real standard and high-strength examples on request", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({ state });
		const standard = await choice.issue({
			prefix: WORD_PREFIX,
			purpose: "example-standard",
			payload: { page: 1 },
			ttlMs: 60_000,
			storage: STORAGE_OPTIONS,
		});
		const high = await choice.issue({
			prefix: WORD_PREFIX,
			purpose: "example-high",
			payload: { page: 2 },
			ttlMs: 60_000,
			strength: "high",
			storage: STORAGE_OPTIONS,
		});

		if (process.env.PRINT_CHOICE_TOKEN_EXAMPLES === "1") {
			console.log(`word choice token examples: standard=${standard} high=${high}`);
		}
		expect(tokenWordCount(standard, WORD_PREFIX)).toBe(4);
		expect(tokenWordCount(high, WORD_PREFIX)).toBe(5);
	});

	it("rejects managed server choices when stored state is missing", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({ state });
		const token = await choice.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "A", details: "x".repeat(2_000) },
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: STORAGE_OPTIONS,
		});
		const namespace = state.firstNamespace();
		const stored = await namespace.list({ limit: 1 });
		const key = stored[0]?.key;
		if (!key) throw new Error("Expected stored choice payload.");
		await namespace.delete(key);

		await expectWordChoiceNotFound(
			choice.parse({
				token,
				prefix: "provider_choice_v2",
				purpose: "reservation",
				ttlMs: 60_000,
				nowMs: 2_000,
				storage: STORAGE_OPTIONS,
			}),
		);
	});

	it("does not invoke legacy fallback for a valid-word sequence that is not found", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({ state });
		const issued = await choice.issue({
			prefix: WORD_PREFIX,
			purpose: "search-page",
			payload: { cursor: "original" },
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: STORAGE_OPTIONS,
		});
		const namespace = state.firstNamespace();
		let stateReads = 0;
		const originalGet = namespace.get.bind(namespace);
		namespace.get = async <T>(key: string) => {
			stateReads += 1;
			return originalGet<T>(key);
		};
		const candidates = [
			`${WORD_PREFIX}aardvark-abandoned-abbreviate-yo-yo`,
			`${WORD_PREFIX}abdomen-abhorrence-abiding-abnormal`,
		];
		const token = candidates.find((candidate) => candidate !== issued);
		if (!token) throw new Error("Expected a distinct valid-word token.");

		await expectWordChoiceNotFound(
			choice.parse({
				token,
				prefix: WORD_PREFIX,
				purpose: "search-page",
				ttlMs: 60_000,
				nowMs: 2_000,
				storage: STORAGE_OPTIONS,
			}),
		);
		expect(stateReads).toBe(1);
	});

	it("returns the uniform not-found error for an expired word record", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({ state });
		const token = await choice.issue({
			prefix: WORD_PREFIX,
			purpose: "search-page",
			payload: { cursor: "expired" },
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: STORAGE_OPTIONS,
		});

		await expectWordChoiceNotFound(
			choice.parse({
				token,
				prefix: WORD_PREFIX,
				purpose: "search-page",
				ttlMs: 60_000,
				nowMs: 61_001,
				storage: STORAGE_OPTIONS,
			}),
		);
	});

	it("atomically consumes word choices after one successful parse", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({ state });
		const payload = { choice_id: "single-use" };
		const token = await choice.issue({
			prefix: WORD_PREFIX,
			purpose: "reservation",
			payload,
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: STORAGE_OPTIONS,
		});
		const parseOptions = {
			token,
			prefix: WORD_PREFIX,
			purpose: "reservation",
			ttlMs: 60_000,
			nowMs: 2_000,
			storage: STORAGE_OPTIONS,
			consume: "on-parse",
		} as const;

		const results = await Promise.allSettled([
			choice.parse(parseOptions),
			choice.parse(parseOptions),
		]);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(fulfilled[0]).toMatchObject({ value: payload });
		expect(rejected).toHaveLength(1);
		await expectWordChoiceNotFound(Promise.reject(rejected[0]?.reason));
		await expectWordChoiceNotFound(choice.parse(parseOptions));
		const stored = await state.firstNamespace().list<{ status: string }>({ limit: 1 });
		expect(stored[0]?.value.status).toBe("consumed");
	});

	it("keeps an explicit choice active when upstream work fails so parsing can retry", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({ state });
		const token = await choice.issue({
			prefix: WORD_PREFIX,
			purpose: "reservation",
			payload: { choice_id: "retryable" },
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: STORAGE_OPTIONS,
		});
		const parseOptions = {
			token,
			prefix: WORD_PREFIX,
			purpose: "reservation",
			ttlMs: 60_000,
			nowMs: 2_000,
			storage: STORAGE_OPTIONS,
			consume: "explicit",
		} as const;

		const beforeFailure = await choice.parse(parseOptions);
		expect(beforeFailure.status).toBe("active");
		if (beforeFailure.status !== "active") throw new Error("Expected an active choice claim.");
		expect(beforeFailure.payload).toEqual({ choice_id: "retryable" });
		expect(typeof beforeFailure.replayKey).toBe("string");
		const initialReplayKey = beforeFailure.replayKey;
		// The provider does not call consume() when its upstream round fails.
		const retry = await choice.parse(parseOptions);
		expect(retry.status).toBe("active");
		if (retry.status !== "active") throw new Error("Expected an active choice claim.");
		expect(retry.replayKey).toBe(initialReplayKey);

		const results = await Promise.all([beforeFailure.consume(), retry.consume()]);
		expect(results.map((result) => result.status).sort()).toEqual([
			"already-consumed",
			"consumed",
		]);
	});

	it("preserves the replay key after consume so provider results remain reachable", async () => {
		const events: ProviderChoiceTelemetryEvent[] = [];
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({
			state,
			onTelemetry: (event) => events.push(event),
		});
		const token = await choice.issue({
			prefix: WORD_PREFIX,
			purpose: "reservation-confirm",
			payload: { choice_id: "confirmable" },
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: STORAGE_OPTIONS,
		});
		const parseOptions = {
			token,
			prefix: WORD_PREFIX,
			purpose: "reservation-confirm",
			ttlMs: 60_000,
			nowMs: 2_000,
			storage: STORAGE_OPTIONS,
			consume: "explicit",
		} as const;
		const providerResults = new Map<string, { readonly reservationId: string }>();

		const initial = await choice.parse(parseOptions);
		if (initial.status !== "active") throw new Error("Expected an active choice claim.");
		providerResults.set(initial.replayKey, { reservationId: "created-record" });
		expect(await initial.consume()).toEqual({ status: "consumed" });

		const replay = await choice.parse(parseOptions);
		expect(replay.status).toBe("consumed");
		if (replay.status !== "consumed") throw new Error("Expected a consumed choice replay.");
		expect(replay.replayKey).toBe(initial.replayKey);
		expect("payload" in replay).toBe(false);
		expect(providerResults.get(replay.replayKey)).toEqual({
			reservationId: "created-record",
		});
		expect(events.at(-1)).toMatchObject({
			operation: "parse",
			format: "word",
			outcome: "success",
			consumed: true,
			replay: true,
		});
	});

	it("emits allowlisted choice telemetry without token, payload, or credential values", async () => {
		const events: ProviderChoiceTelemetryEvent[] = [];
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({
			state,
			credentialValues: { userId: "credential-value-marker" },
			onTelemetry: (event) => events.push(event),
		});
		const token = await choice.issue({
			prefix: WORD_PREFIX,
			purpose: "telemetry-check",
			payload: { cursor: "payload-value-marker" },
			ttlMs: 60_000,
			storage: STORAGE_OPTIONS,
		});

		await choice.parse({
			token,
			prefix: WORD_PREFIX,
			purpose: "telemetry-check",
			storage: STORAGE_OPTIONS,
		});

		expect(events).toEqual([
			{
				providerId: "provider-a",
				purpose: "telemetry-check",
				operation: "parse",
				format: "word",
				outcome: "success",
				consumeMode: "never",
				consumed: false,
				replay: false,
			},
		]);
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain(token);
		expect(serialized).not.toContain("payload-value-marker");
		expect(serialized).not.toContain("credential-value-marker");
	});

	it("rejects a corrupt/undecodable server choice as a branded token error, not a raw SyntaxError", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({ state });
		const token = await choice.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "A", details: "x".repeat(2_000) },
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: STORAGE_OPTIONS,
		});
		// Simulate the Redis-backed decode failure: the stored envelope bytes are
		// corrupt, so the state read throws a raw JSON.parse SyntaxError. Before the
		// hotfix this escaped the choice error taxonomy and was masked as a retryable
		// internal_error 500 (2026-07-22 catchtable reserve loop, candidate A).
		const namespace = state.firstNamespace();
		namespace.get = async () => {
			throw new SyntaxError("Unexpected token < in JSON at position 0");
		};

		const parsePromise = choice.parse({
			token,
			prefix: "provider_choice_v2",
			purpose: "reservation",
			ttlMs: 60_000,
			nowMs: 2_000,
			storage: STORAGE_OPTIONS,
		});

		await expect(parsePromise).rejects.toThrow(ProviderChoiceTokenError);
		await expect(parsePromise).rejects.not.toBeInstanceOf(SyntaxError);
		try {
			await parsePromise;
			throw new Error("Expected parse to reject.");
		} catch (error) {
			expect(error).toBeInstanceOf(ProviderChoiceTokenError);
			expect((error as ProviderChoiceTokenError).reason).toBe("invalid_payload");
		}
	});

	it("rejects managed server choices when stored state digest changes", async () => {
		const state = new MemoryProviderRuntimeState();
		const choice = createManagedChoiceFixture({ state });
		const token = await choice.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "A", details: "x".repeat(2_000) },
			ttlMs: 60_000,
			nowMs: 1_000,
			storage: STORAGE_OPTIONS,
		});
		const namespace = state.firstNamespace();
		const stored = await namespace.list({ limit: 1 });
		const key = stored[0]?.key;
		if (!key) throw new Error("Expected stored choice payload.");
		await namespace.set(key, { choice_id: "B", details: "x".repeat(2_000) });

		await expect(
			choice.parse({
				token,
				prefix: "provider_choice_v2",
				purpose: "reservation",
				ttlMs: 60_000,
				nowMs: 2_000,
				storage: STORAGE_OPTIONS,
			}),
		).rejects.toThrow(ProviderChoiceTokenError);
	});

	it("rejects managed server choices across connection bindings", async () => {
		const state = new MemoryProviderRuntimeState();
		const issuer = createManagedChoiceFixture({
			connectionId: "af_con_a",
			state,
		});
		const token = await issuer.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "A", details: "x".repeat(2_000) },
			ttlMs: 60_000,
			nowMs: 1_000,
			bind: { connection: true },
			storage: STORAGE_OPTIONS,
		});
		const parser = createManagedChoiceFixture({
			connectionId: "af_con_b",
			state,
		});

		await expectWordChoiceNotFound(
			parser.parse({
				token,
				prefix: "provider_choice_v2",
				purpose: "reservation",
				ttlMs: 60_000,
				nowMs: 2_000,
				bind: { connection: true },
				storage: STORAGE_OPTIONS,
			}),
		);
		const stored = await state.firstNamespace().list({ limit: 1 });
		expect(stored[0]?.value).toMatchObject({
			status: "active",
			binding: { connection_hash: expect.any(String) },
		});
	});

	it("rejects managed server choices when runtime state is unsupported", async () => {
		const choice = createManagedChoiceFixture({
			state: createUnsupportedProviderRuntimeState(),
		});

		await expect(
			choice.issue({
				prefix: "provider_choice_v2",
				purpose: "reservation",
				payload: { choice_id: "A", details: "x".repeat(2_000) },
				ttlMs: 60_000,
				nowMs: 1_000,
				storage: STORAGE_OPTIONS,
			}),
		).rejects.toThrow(ProviderError);
	});
});
