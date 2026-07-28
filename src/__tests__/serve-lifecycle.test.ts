import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { serve, type ProviderServerLogEvent } from "../server/serve.js";
import type { ProviderDefinition } from "../types.js";

function provider(): ProviderDefinition {
	return {
		id: "lifecycle-test-provider",
		version: "1.0.0",
		runtime: "standard",
		meta: { displayName: "Lifecycle Test Provider", category: "test" },
		operations: {
			ping: {
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => ({ ok: true }),
			},
		},
	};
}

describe("serve lifecycle", () => {
	it("stops accepting requests, runs every hook in order, and closes idempotently", async () => {
		const order: string[] = [];
		const logs: ProviderServerLogEvent[] = [];
		let listenerStoppedBeforeHooks = false;
		let port = 0;
		const handle = await serve(provider(), {
			port: 0,
			logger: (event) => logs.push(event),
			shutdown: {
				signals: false,
				timeoutMs: 1_000,
				hooks: [
					async () => {
						order.push("first");
						try {
							await fetch(`http://127.0.0.1:${port}/health`);
						} catch {
							listenerStoppedBeforeHooks = true;
						}
					},
					async () => {
						order.push("second");
						throw new Error("second hook failed");
					},
					async () => {
						order.push("third");
					},
				],
			},
		});
		port = handle.port;
		expect(port).toBeGreaterThan(0);

		const firstClose = handle.close();
		const secondClose = handle.close();
		expect(secondClose).toBe(firstClose);
		await firstClose;
		await handle.close();

		expect(listenerStoppedBeforeHooks).toBe(true);
		expect(order).toEqual(["first", "second", "third"]);
		expect(logs).toContainEqual({
			level: "error",
			event: "provider_shutdown_hook_failed",
			providerId: "lifecycle-test-provider",
			hookIndex: 1,
			errorClass: "Error",
			message: "second hook failed",
		});
	});

	it("registers default SIGTERM/SIGINT handlers once and removes them after close", async () => {
		const sigtermBefore = process.listenerCount("SIGTERM");
		const sigintBefore = process.listenerCount("SIGINT");
		const handle = await serve(provider(), {
			port: 0,
			logger: () => {},
			shutdown: { signals: true },
		});
		try {
			expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
			expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
		} finally {
			await handle.close();
		}
		expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
		expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
	});
});
