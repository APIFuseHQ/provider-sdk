import { describe, expect, test } from "bun:test";
import { createUnsupportedProviderRuntimeState } from "../runtime/state.js";

describe("provider runtime state SDK surface", () => {
	test("unsupported runtime fails loudly", async () => {
		const state = createUnsupportedProviderRuntimeState();
		const namespace = state.namespace("example.v1", {
			defaultTtl: "1h",
			maxTtl: "1d",
			maxEntries: 10,
			maxValueBytes: 1024,
		});
		await expect(namespace.get("key")).rejects.toThrow("Provider runtime state is not available");
	});
});
