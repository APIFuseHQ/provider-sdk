import { describe, expect, test } from "bun:test";
import {
	createMemoryProviderRuntimeState,
	createUnsupportedProviderRuntimeState,
} from "../runtime/state.js";
import type { ProviderRuntimeState, StateNamespaceOptions } from "../types.js";

const namespaceOptions = {
	defaultTtl: "1h",
	maxTtl: "1d",
	maxEntries: 10,
	maxValueBytes: 1024,
} satisfies StateNamespaceOptions;

function namespaceFor(state: ProviderRuntimeState, connectionId: string, maxEntries = 10) {
	return state.forConnection(connectionId).namespace("example.v1", {
		...namespaceOptions,
		maxEntries,
	});
}

describe("provider runtime state SDK surface", () => {
	test("unsupported runtime fails loudly", async () => {
		const state = createUnsupportedProviderRuntimeState();
		const namespace = namespaceFor(state, "connection-a");
		await expect(namespace.get("key")).rejects.toThrow("Provider runtime state is not available");
	});

	test("unsupported connection views stay isolated by failing closed", async () => {
		const state = createUnsupportedProviderRuntimeState();
		const connectionA = namespaceFor(state, "connection-a");
		const connectionB = namespaceFor(state, "connection-b");
		await expect(connectionA.set("active", "a")).rejects.toThrow(
			"Provider runtime state is not available",
		);
		await expect(connectionB.get("active")).rejects.toThrow(
			"Provider runtime state is not available",
		);
	});
});

describe("memory provider runtime state scoping", () => {
	test("isolates ordinary namespaces between connections", async () => {
		const state = createMemoryProviderRuntimeState();
		const connectionA = namespaceFor(state, "connection-a");
		const connectionB = namespaceFor(state, "connection-b");

		await connectionA.set("active", "a");
		expect(await connectionB.get("active")).toBeNull();
		await connectionB.set("active", "b");
		expect((await connectionA.get<string>("active"))?.value).toBe("a");
		expect((await connectionB.get<string>("active"))?.value).toBe("b");
	});

	test("shares namespaces that explicitly opt into provider scope", async () => {
		const state = createMemoryProviderRuntimeState();
		const options = { ...namespaceOptions, scope: "provider" } satisfies StateNamespaceOptions;
		const connectionA = state.forConnection("connection-a").namespace("health.v1", options);
		const connectionB = state.forConnection("connection-b").namespace("health.v1", options);

		await connectionA.set("monitor", { healthy: true });
		expect((await connectionB.get<{ healthy: boolean }>("monitor"))?.value).toEqual({
			healthy: true,
		});
	});

	test("counts namespace quota per connection", async () => {
		const state = createMemoryProviderRuntimeState();
		const connectionA = namespaceFor(state, "connection-a", 1);
		const connectionB = namespaceFor(state, "connection-b", 1);

		await connectionA.set("first", 1);
		await connectionB.set("first", 2);
		await expect(connectionA.set("second", 3)).rejects.toThrow("namespace quota exceeded");
		expect((await connectionB.get<number>("first"))?.value).toBe(2);
	});

	test("keeps CAS contention local to a connection scope", async () => {
		const state = createMemoryProviderRuntimeState();
		const connectionA = namespaceFor(state, "connection-a");
		const connectionB = namespaceFor(state, "connection-b");
		await connectionA.set("guard", "initial-a");
		await connectionB.set("guard", "initial-b");

		const sameScope = await Promise.all([
			connectionA.compareAndSet("guard", 1, "winner-1"),
			connectionA.compareAndSet("guard", 1, "winner-2"),
		]);
		expect(sameScope.filter((result) => result.ok)).toHaveLength(1);
		expect((await connectionB.compareAndSet("guard", 1, "winner-b")).ok).toBe(true);
	});

	test("uses a reserved missing-connection sentinel without joining provider scope", async () => {
		const state = createMemoryProviderRuntimeState();
		const missing = state.forConnection(undefined).namespace("example.v1", namespaceOptions);
		const provider = state.forConnection("connection-a").namespace("example.v1", {
			...namespaceOptions,
			scope: "provider",
		});
		await missing.set("active", "missing");
		expect(await provider.get("active")).toBeNull();
	});
});
