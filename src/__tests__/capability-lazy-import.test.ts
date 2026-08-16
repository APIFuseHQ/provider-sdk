import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { serve } from "../server/serve.js";
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
	it("boots a standard provider with unchanged stubs and no heavy runtime imports", async () => {
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

	it("loads a declared resolver during startup and serves it through synchronous contexts", async () => {
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
		const handle = await serve(provider, {
			port: 0,
			resolver,
			logger: () => {},
			shutdown: { signals: false },
		});
		try {
			const response = await fetch(`http://127.0.0.1:${handle.port}/v1/solve`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "req-resolver-loaded", input: {} }),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ data: { token: "loaded-at-startup" } });
		} finally {
			await handle.close();
		}
	});
});
