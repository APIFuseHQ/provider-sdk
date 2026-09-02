import { describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";

import { DECLARATION_INVALID_CODE, DECLARATION_RULE_IDS } from "../declaration-validation.js";
import { createServerApp, type ProviderServerLogEvent, serve } from "./helpers/server.js";
import type { ProviderDefinition } from "../types.js";

function provider(): ProviderDefinition {
	return {
		id: "lifecycle-test-provider",
		version: "1.0.0",
		runtime: "standard",
		meta: {
			displayName: "Lifecycle Test Provider",
			descriptionKey: "providers.lifecycleTest.description",
			category: "test",
		},
		operations: {
			ping: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => ({ ok: true }),
			},
		},
	};
}

describe("serve lifecycle", () => {
	it("rejects a cast-bypassed invalid declaration before starting a listener", async () => {
		const listen = spyOn(Bun, "serve");
		try {
			await expect(
				serve({ ...provider(), proxy: true }, { port: 0, shutdown: { signals: false } }),
			).rejects.toMatchObject({
				code: DECLARATION_INVALID_CODE,
				details: {
					violations: [
						expect.objectContaining({
							ruleId: DECLARATION_RULE_IDS.proxyExplicitPolicy,
							path: "proxy",
						}),
					],
				},
			});
			expect(listen).not.toHaveBeenCalled();
		} finally {
			listen.mockRestore();
		}
	});

	it("rejects a cast-bypassed invalid declaration at createServerApp directly", () => {
		let caught: unknown;
		try {
			createServerApp({ ...provider(), proxy: true } as ProviderDefinition);
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({
			code: DECLARATION_INVALID_CODE,
			details: {
				violations: [
					expect.objectContaining({
						ruleId: DECLARATION_RULE_IDS.proxyExplicitPolicy,
						path: "proxy",
					}),
				],
			},
		});
	});

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

	it("rolls back the primary listener when the self-test listener fails to bind", async () => {
		const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
		const port = reservation.port;
		await reservation.stop(true);
		const envName = "APIFUSE__PROVIDER_RUNTIME__SELF_TEST_MASTER_SECRET";
		const previousSecret = process.env[envName];
		process.env[envName] = "transactional-startup-secret";
		try {
			await expect(
				serve(provider(), {
					port,
					selfTestPort: port,
					logger: () => {},
					shutdown: { signals: false },
				}),
			).rejects.toBeDefined();
			const primaryStillListening = await fetch(`http://127.0.0.1:${port}/health`, {
				signal: AbortSignal.timeout(100),
			}).then(
				() => true,
				() => false,
			);
			expect(primaryStillListening).toBe(false);
		} finally {
			if (previousSecret === undefined) delete process.env[envName];
			else process.env[envName] = previousSecret;
		}
	});

	it("coordinates multiple signal-enabled servers before re-raising", async () => {
		const sigtermBefore = process.listenerCount("SIGTERM");
		const order: string[] = [];
		const kill = spyOn(process, "kill").mockImplementation((_pid, signal) => {
			order.push(`kill:${String(signal)}`);
			return true;
		});
		const first = await serve(provider(), {
			port: 0,
			logger: () => {},
			shutdown: {
				signals: ["SIGTERM"],
				timeoutMs: 1_000,
					hooks: [async () => {
						order.push("a-hook-end");
					}],
			},
		});
		const second = await serve(provider(), {
			port: 0,
			logger: () => {},
			shutdown: {
				signals: ["SIGTERM"],
				timeoutMs: 1_000,
				hooks: [
					async () => {
						order.push("b-hook-start");
						await Bun.sleep(20);
						order.push("b-hook-end");
					},
				],
			},
		});
		try {
			expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
			const listener = process.listeners("SIGTERM").at(-1);
			expect(listener).toBeDefined();
			listener?.("SIGTERM");
			for (let attempt = 0; attempt < 50 && kill.mock.calls.length === 0; attempt += 1) {
				await Bun.sleep(5);
			}
			expect(order).toContain("b-hook-end");
			expect(order.at(-1)).toBe("kill:SIGTERM");
			await Promise.all([first.close(), second.close()]);
			expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
		} finally {
			await Promise.allSettled([first.close(), second.close()]);
			kill.mockRestore();
		}
	});
});
