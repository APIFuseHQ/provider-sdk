import { afterEach, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resetProviderCacheForTests } from "../runtime/cache.js";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/request-telemetry.js";
import { createServerApp, type ProviderServerLogEvent } from "../server/serve.js";
import type { ProviderCache } from "../types.js";

const fixtures = new URL("./fixtures/cache-state-preservation/", import.meta.url);
afterEach(resetProviderCacheForTests);

for (const [kind, bytes, suite, filter] of [
	["cache", 4975, "cache.test.ts", undefined],
	["http", 968, "serve-http.test.ts", "adds cache metadata|merges cache and retry metadata"],
] as const) {
	it(`preserves the ${bytes}-byte base ${kind} metadata capture`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "p6c-metadata-"));
		try {
			const captureFile = join(directory, "capture.jsonl");
			const child = Bun.spawn(
				[
					process.execPath,
					"test",
					"--preload",
					new URL("./fixtures/cache-state-capture-preload.ts", import.meta.url).pathname,
					new URL(`./${suite}`, import.meta.url).pathname,
					...(filter ? ["--test-name-pattern", filter] : []),
				],
				{
					env: {
						...process.env,
						APIFUSE_P6C_CAPTURE_KIND: kind,
						APIFUSE_P6C_CAPTURE_FILE: captureFile,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, stdout + stderr).toBe(0);
			const actual = await readFile(captureFile);
			const expected = await readFile(new URL(`${kind}-base.jsonl`, fixtures));
			expect(expected.byteLength).toBe(bytes);
			expect(actual.equals(expected), actual.toString()).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

for (const mode of ["reject", "resolve", "caught"] as const) {
	it(`preserves base tenant bytes for shared loader ${mode}`, async () => {
		const started = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const loader = Promise.withResolvers<string>();
		const failure = new Error("shared failed");
		const errors: unknown[] = [];
		const metas: Array<ReturnType<ProviderCache["responseMeta"]> | null> = [];
		const events: ProviderServerLogEvent[] = [];
		let handlers = 0;
		const app = createServerApp(
			{
				id: "r3-shared",
				version: "1.0.0",
				runtime: "standard",
				meta: { displayName: "R3", descriptionKey: "d", category: "test" },
				cache: true,
				operations: {
					probe: {
						riskClass: "read",
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						handler: async (ctx) => {
							const index = handlers++;
							if (index === 1) entered.resolve();
							try {
								await ctx.cache.getOrSet(
									"r3-key",
									() => {
										started.resolve();
										return loader.promise;
									},
									{ ttlMs: 1000, jitterPct: 0 },
								);
								return { ok: true };
							} catch (error) {
								errors.push(error);
								if (mode === "caught") return { ok: false };
								throw error;
							} finally {
								metas[index] = ctx.cache.responseMeta() ?? null;
							}
						},
					},
				},
			},
			{ logger: (event) => events.push(event) },
		);
		const request = (requestId: string) =>
			app.request("/v1/probe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId, input: {} }),
			});
		const owner = request("owner");
		await started.promise;
		const follower = request("follower");
		await entered.promise;
		// Let the follower's asynchronous cache read reach the shared in-flight load.
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (mode === "resolve") loader.resolve("value");
		else loader.reject(failure);
		const responses = [];
		for (const response of await Promise.all([owner, follower])) {
			const body = await response.json();
			responses.push({ status: response.status, meta: body.meta?.cache ?? null });
			const encoded = response.headers.get(PROVIDER_TELEMETRY_HEADER)!;
			const header = JSON.parse(Buffer.from(encoded, "base64url").toString());
			expect(header.cache.lookups).toBe(1);
			expect(header.cache.loaderErrors).toBe(mode === "resolve" ? 0 : 1);
		}
		const capture = `${JSON.stringify({ mode, responses, metas, identity: errors.map((error) => error === failure) })}\n`;
		expect(capture).toBe(await readFile(new URL(`shared-${mode}-base.jsonl`, fixtures), "utf8"));
		expect(events).toHaveLength(2);
		for (const event of events) {
			// test-invalid: contributor fields are not exposed on the shared log event type.
			const log = event as { cache?: { lookups: number; loaderErrors: number } };
			expect(log.cache?.lookups).toBe(1);
			expect(log.cache?.loaderErrors).toBe(mode === "resolve" ? 0 : 1);
		}
	});
}
