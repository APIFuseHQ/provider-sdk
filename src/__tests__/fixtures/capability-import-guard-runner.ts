import { spyOn } from "bun:test";
import { z } from "zod";

import { serve } from "../../server/serve.js";
import type { ProviderDefinition } from "../../types.js";

const mode = process.argv[2] ?? "standard";

const operations: ProviderDefinition["operations"] = {
	stealth: {
		input: z.object({}),
		output: z.object({}),
		async handler(ctx) {
			await ctx.stealth.fetch("/");
			return {};
		},
	},
	browser: {
		input: z.object({}),
		output: z.object({}),
		async handler(ctx) {
			await ctx.browser.newPage();
			return {};
		},
	},
	resolver: {
		input: z.object({}),
		output: z.object({}),
		async handler(ctx) {
			await ctx.resolver.solve({ kind: "turnstile", pageUrl: "https://example.test" });
			return {};
		},
	},
	native: {
		input: z.object({}),
		output: z.object({ available: z.boolean() }),
		async handler(ctx) {
			return { available: ctx.native !== undefined };
		},
	},
};

const provider: ProviderDefinition = {
	id: `capability-import-${mode}`,
	version: "1.0.0",
	runtime: mode === "browser" ? "browser" : "standard",
	...(mode === "browser" ? { browser: { engine: "playwright-stealth" as const } } : {}),
	...(mode === "native" ? { native: {} } : {}),
	...(mode === "resolver" ? { resolver: { vendors: ["2captcha"], kinds: ["turnstile"] } } : {}),
	meta: { displayName: "Capability import guard", category: "test" },
	operations:
		mode === "stealth"
			? {
					...operations,
					stealth: {
						...operations.stealth!,
						upstream: { baseUrl: "https://example.test" },
					},
				}
			: operations,
};

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

if (mode !== "standard") {
	const listen = spyOn(Bun, "serve");
	try {
		await serve(provider, { port: 0, shutdown: { signals: false } });
		throw new Error(`Expected ${mode} capability startup to fail`);
	} catch (error) {
		assert(error && typeof error === "object", "Expected a structured capability load error");
		assert("code" in error, "Capability load error is missing its code");
		assert(
			error.code === "PROVIDER_CAPABILITY_LOAD_FAILED",
			`Unexpected error code: ${error.code}`,
		);
		assert("details" in error, "Capability load error is missing details");
		assert(
			error.details && typeof error.details === "object" && "capability" in error.details,
			"Capability load error is missing its capability",
		);
		assert(error.details.capability === mode, `Unexpected capability: ${error.details.capability}`);
		assert(listen.mock.calls.length === 0, "Bun.serve was called before capability loading failed");
	} finally {
		listen.mockRestore();
	}
	process.exit(0);
}

const handle = await serve(provider, {
	port: 0,
	logger: () => {},
	shutdown: { signals: false },
});

try {
	const baseUrl = `http://127.0.0.1:${handle.port}`;
	const request = (operation: string, requestId: string) =>
		fetch(`${baseUrl}/v1/${operation}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId, input: {} }),
		});

	const health = await fetch(`${baseUrl}/health`);
	assert(health.status === 200, `Unexpected health status: ${health.status}`);

	const expectedErrors = [
		[
			"stealth",
			"req-stealth",
			{
				error: {
					code: "STEALTH_RUNTIME_UNSUPPORTED",
					message: "Stealth runtime is not available",
					requestId: "req-stealth",
					retryable: false,
					source: "apifuse",
				},
			},
		],
		[
			"browser",
			"req-browser",
			{
				error: {
					code: "BROWSER_RUNTIME_UNSUPPORTED",
					message: "Browser runtime is not available",
					requestId: "req-browser",
					retryable: false,
					source: "apifuse",
				},
			},
		],
		[
			"resolver",
			"req-resolver",
			{
				error: {
					code: "RESOLVER_UNAVAILABLE",
					message: "Provider does not declare resolver capability",
					requestId: "req-resolver",
					retryable: false,
					source: "apifuse",
					fix: "Declare resolver on the provider definition and configure vendor credentials.",
				},
			},
		],
	] as const;

	for (const [operation, requestId, expectedBody] of expectedErrors) {
		const response = await request(operation, requestId);
		assert(response.status === 500, `Unexpected ${operation} status: ${response.status}`);
		const body = await response.json();
		assert(
			JSON.stringify(body) === JSON.stringify(expectedBody),
			`Unexpected ${operation} error: ${JSON.stringify(body)}`,
		);
	}

	const nativeResponse = await request("native", "req-native");
	assert(nativeResponse.status === 200, `Unexpected native status: ${nativeResponse.status}`);
	assert(
		JSON.stringify(await nativeResponse.json()) === JSON.stringify({ data: { available: false } }),
		"Undeclared native capability was unexpectedly present",
	);
} finally {
	await handle.close();
}
