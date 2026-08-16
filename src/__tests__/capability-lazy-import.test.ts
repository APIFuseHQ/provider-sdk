import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { createServerAppAsync } from "../server/serve.js";
import type { ProviderDefinition, ResolverContext } from "../types.js";

const preload = new URL("./fixtures/capability-import-guard-preload.ts", import.meta.url).pathname;
const runner = new URL("./fixtures/capability-import-guard-runner.ts", import.meta.url).pathname;

async function runImportGuard(mode: string): Promise<{ exitCode: number; stderr: string }> {
	const subprocess = Bun.spawn({
		cmd: [process.execPath, "--preload", preload, runner, mode],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stderr).text(),
	]);
	return { exitCode, stderr };
}

describe("provider capability imports", () => {
	it("boots a fleet-representative standard provider without loading capability modules", async () => {
		const result = await runImportGuard("standard");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	for (const capability of ["browser", "native", "resolver", "stealth"]) {
		it(`fails before listening when the declared ${capability} module cannot load`, async () => {
			const result = await runImportGuard(capability);
			expect(result.stderr).toBe("");
			expect(result.exitCode).toBe(0);
		});
	}

	it("loads tier-2 stealth on first use and delegates to the real client arguments", async () => {
		const result = await runImportGuard("tier2-stealth");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	it("keeps tier-2 stealth sessions and cookies synchronous before lazy transport use", async () => {
		const result = await runImportGuard("tier2-stealth-session");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	it("returns 500 without a cleanup event when a tier-2 stealth import rejects", async () => {
		const result = await runImportGuard("tier2-stealth-rejection");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	it("reports exactly one cleanup event when a tier-2 stealth client close throws", async () => {
		const result = await runImportGuard("tier2-stealth-close-throw");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	it("preloads a declared stealth capability before listening", async () => {
		const result = await runImportGuard("tier1-stealth");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	it("reports every declared capability load failure before listening", async () => {
		const result = await runImportGuard("aggregate");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	it("preserves non-Error capability load failures with provider identity", async () => {
		const result = await runImportGuard("primitive");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	it("directs unsupported synchronous ESM capability loading to the async API", async () => {
		const result = await runImportGuard("sync-esm");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	it("creates an app asynchronously with declared capabilities preloaded", async () => {
		const provider: ProviderDefinition = {
			id: "declared-resolver-startup",
			version: "1.0.0",
			runtime: "standard",
			resolver: { vendors: ["2captcha"], kinds: ["turnstile"] },
			meta: { displayName: "Declared resolver startup", category: "test" },
			operations: {
				solve: {
					input: z.object({}),
					output: z.object({ token: z.string() }),
					async handler(ctx) {
						const solution = await ctx.resolver.solve({
							kind: "turnstile",
							pageUrl: "https://example.test",
						});
						return { token: solution.form === "token" ? solution.token : "unexpected" };
					},
				},
			},
		};
		const resolver: ResolverContext = {
			async solve() {
				return { form: "token", token: "loaded-at-startup" };
			},
		};
		const app = await createServerAppAsync(provider, {
			resolver,
			logger: () => {},
		});
		const response = await app.request("/v1/solve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req-resolver-loaded", input: {} }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { token: "loaded-at-startup" } });
	});
});
