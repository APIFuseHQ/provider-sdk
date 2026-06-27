import { describe, expect, it } from "bun:test";
import { ProviderChoiceTokenError } from "../choice-token";
import { ProviderError } from "../errors";
import { createTestProviderChoiceContext } from "../runtime/choice";
import { createUnsupportedProviderRuntimeState } from "../runtime/state";
import type { CredentialContext, ProviderRuntimeState } from "../types";
import { MemoryProviderRuntimeState } from "./memory-state";

const STORAGE_OPTIONS = {
	mode: "server",
	namespace: "choice.test.v1",
	ttl: "10m",
	maxEntries: 20,
	maxValueBytes: 10_000,
} as const;

function createManagedChoiceFixture(options?: {
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
	const request = {
		connectionId: options?.connectionId ?? "af_con_test",
		headers: {},
	};
	return createTestProviderChoiceContext({
		providerId: "provider-a",
		request,
		credential,
		state: options?.state,
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

	it("stores large managed provider choices in server state", async () => {
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
		const parsed = await choice.parse({
			token: serverToken,
			prefix: "provider_choice_v2",
			purpose: "reservation",
			ttlMs: 60_000,
			nowMs: 2_000,
			storage: STORAGE_OPTIONS,
		});

		expect(serverToken.length).toBeLessThan(inlineToken.length / 2);
		expect(parsed).toEqual(payload);
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

		expect(() =>
			parser.parse({
				token,
				prefix: "provider_choice_v2",
				purpose: "reservation",
				ttlMs: 60_000,
				nowMs: 2_000,
				bind: { connection: true },
				storage: STORAGE_OPTIONS,
			}),
		).toThrow(ProviderChoiceTokenError);
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
