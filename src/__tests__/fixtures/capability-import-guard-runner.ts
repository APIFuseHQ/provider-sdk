import { spyOn } from "bun:test";
import { z } from "zod";

import { createServerApp, serve } from "../../index.js";
import type { ProviderDefinition } from "../../index.js";
import type { ProviderServerLogEvent } from "../../server/serve.js";
import type { CapabilityImportGuardState } from "./capability-import-guard-state.js";

const mode = process.argv[2] ?? "standard";
const state = Reflect.get(globalThis, "__capabilityImportGuardState") as CapabilityImportGuardState;

const operations: ProviderDefinition["operations"] = {
	stealth: {
		input: z.object({}),
		output: z.object({}),
		upstream: { baseUrl: "https://api.example.com" },
		async handler(ctx) {
			if (mode === "tier2-stealth-close-throw") {
				void ctx.stealth.fetch("/pending");
				return {};
			}
			await Promise.all([ctx.stealth.fetch("/first"), ctx.stealth.fetch("/second")]);
			return {};
		},
	},
	stealthSession: {
		input: z.object({}),
		output: z.object({ cookie: z.string() }),
		async handler(ctx) {
			const session = ctx.stealth.createSession();
			assert(state.stealthLoads === 0, "createSession loaded stealth synchronously");
			session.cookies.restore({ sid: "sync-cookie" });
			const cookie = session.cookies.get("sid");
			assert(cookie === "sync-cookie", "Lazy session cookies are not synchronous");
			await session.fetch("/session");
			return { cookie };
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
			await ctx.resolver.solve({
				kind: "turnstile",
				siteKey: "capability-import-guard-site-key",
				pageUrl: "https://example.test",
			});
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
	runtime: mode === "browser" || mode === "aggregate" ? "browser" : "standard",
	allowedHosts: ["api.example.com"],
	...(mode === "browser" || mode === "aggregate"
		? { browser: { engine: "playwright-stealth" as const } }
		: {}),
	...(mode === "native" || mode === "aggregate" ? { native: {} } : {}),
	...(mode === "resolver" || mode === "aggregate"
		? { resolver: { vendors: ["2captcha"], kinds: ["turnstile"] } }
		: {}),
	...(["stealth", "tier1-stealth", "primitive", "aggregate", "sync-esm"].includes(mode)
		? { stealth: { profile: "chrome-146", platform: "linux" as const } }
		: {}),
	meta: {
		displayName: "Capability import guard",
		descriptionKey: "capability-import-guard.description",
		category: "test",
	},
	operations,
};

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function isCapabilityFailure(
	value: unknown,
): value is { capability: string; reason: string } {
	return (
		value !== null &&
		typeof value === "object" &&
		"capability" in value &&
		typeof value.capability === "string" &&
		"reason" in value &&
		typeof value.reason === "string"
	);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
	assert(actual === expected, message);
}

if (mode === "sync-esm") {
	try {
		createServerApp(provider);
		throw new Error("Expected synchronous capability loading to fail");
	} catch (error) {
		assert(error && typeof error === "object", "Expected a structured synchronous load error");
		assert("code" in error, "Synchronous load error is missing its code");
		assert(
			error.code === "PROVIDER_CAPABILITY_SYNC_LOAD_UNSUPPORTED",
			`Unexpected synchronous load error code: ${error.code}`,
		);
		assert("message" in error && typeof error.message === "string", "Missing error message");
		assert(error.message.includes("createServerAppAsync"), "Async API guidance is missing");
	}
	process.exit(0);
}

if (["browser", "native", "resolver", "stealth", "aggregate", "primitive"].includes(mode)) {
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
		assert("message" in error && typeof error.message === "string", "Missing error message");
		assert(error.message.includes(provider.id), "Capability load error is missing provider id");
		assert("details" in error, "Capability load error is missing details");
		assert(
			error.details && typeof error.details === "object" && "failures" in error.details,
			"Capability load error is missing its failures",
		);
		assert("providerId" in error.details, "Capability load details are missing provider id");
		assert(error.details.providerId === provider.id, "Unexpected capability load provider id");
		assert(Array.isArray(error.details.failures), "Capability failures are not an array");
		assert(
			error.details.failures.every(isCapabilityFailure),
			"Capability failures contain an invalid entry",
		);
		const failures = error.details.failures;
		const expectedCapabilities =
			mode === "aggregate"
				? ["browser", "native", "resolver", "stealth"]
				: [mode === "primitive" ? "stealth" : mode];
		assert(
			JSON.stringify(failures.map((failure) => failure.capability)) ===
				JSON.stringify(expectedCapabilities),
			`Unexpected capabilities: ${JSON.stringify(failures)}`,
		);
		for (const capability of expectedCapabilities) {
			assert(error.message.includes(capability), `Message is missing ${capability}`);
		}
		if (mode === "primitive") {
			assert(
				failures[0]?.reason === "primitive stealth failure",
				"Primitive failure reason was discarded",
			);
			assert("cause" in error, "Capability error is missing its cause");
			assert(error.cause instanceof AggregateError, "Capability error cause is not aggregate");
			assert(
				error.cause.errors[0] instanceof Error &&
					error.cause.errors[0].message === "primitive stealth failure",
				"Primitive failure was not wrapped as an Error cause",
			);
		}
		assert(listen.mock.calls.length === 0, "Bun.serve was called before capability loading failed");
	} finally {
		listen.mockRestore();
	}
	process.exit(0);
}

const logs: ProviderServerLogEvent[] = [];
const unhandledRejections: unknown[] = [];
if (mode === "tier2-stealth-rejection") {
	process.on("unhandledRejection", (error) => unhandledRejections.push(error));
}

const handle = await serve(provider, {
	port: 0,
	logger: (event) => logs.push(event),
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
	if (mode === "standard") {
		assert(
			state.heavyLoads.length === 0,
			`Root boot loaded heavy modules: ${JSON.stringify(state.heavyLoads)}`,
		);
	}
	if (mode === "tier1-stealth") {
		assert(state.stealthLoads === 1, "Declared stealth was not preloaded before listening");
		assert(state.stealthCreateArgs.length === 0, "Stealth client was created before a context");
		process.exitCode = 0;
	} else if (
		mode === "tier2-stealth" ||
		mode === "tier2-stealth-session" ||
		mode === "tier2-stealth-close-throw"
	) {
		assert(state.stealthLoads === 0, "Tier-2 stealth loaded during boot");
		const operation = mode === "tier2-stealth-session" ? "stealthSession" : "stealth";
		const response = await request(operation, `req-${mode}`);
		assert(response.status === 200, `Unexpected tier-2 stealth status: ${response.status}`);
		assertEqual(state.stealthLoads, 1, "Tier-2 stealth did not load on first use");
		if (mode === "tier2-stealth-close-throw") {
			assert(state.stealthCreateArgs.length === 0, "Stealth client loaded before request cleanup");
			assert(state.releaseStealthLoad !== undefined, "Stealth import was not pending at cleanup");
			state.releaseStealthLoad();
			await Bun.sleep(50);
		}
		assert(state.stealthCreateArgs.length === 1, "Tier-2 stealth client was not single-flight");
		const [stealthBaseUrl, stealthOptions] = state.stealthCreateArgs[0] ?? [];
		assert(stealthBaseUrl === "https://api.example.com", "Unexpected tier-2 stealth base URL");
		assert(
			stealthOptions !== null && typeof stealthOptions === "object",
			"Tier-2 stealth options were not delegated",
		);
		assert(
			"affinityKey" in stealthOptions && stealthOptions.affinityKey === provider.id,
			"Unexpected tier-2 stealth affinity key",
		);
		if (mode === "tier2-stealth-session") {
			assert(
				JSON.stringify(await response.json()) ===
					JSON.stringify({ data: { cookie: "sync-cookie" } }),
				"Tier-2 stealth session did not preserve synchronous cookies",
			);
		}
		if (mode === "tier2-stealth-close-throw") {
			const cleanupLogs = logs.filter((event) => event.event === "provider_cleanup_failed");
			assert(cleanupLogs.length === 1, `Unexpected cleanup logs: ${JSON.stringify(cleanupLogs)}`);
			assert(cleanupLogs[0]?.message === "stealth close failed", "Unexpected cleanup failure");
		}
	} else if (mode === "tier2-stealth-rejection") {
		const response = await request("stealth", "req-tier2-stealth-rejection");
		assert(response.status === 500, `Unexpected rejected stealth status: ${response.status}`);
		await Bun.sleep(50);
		assert(unhandledRejections.length === 0, "Lazy stealth cleanup emitted an unhandled rejection");
		const cleanupLogs = logs.filter((event) => event.event === "provider_cleanup_failed");
		assert(cleanupLogs.length === 0, `Unexpected cleanup logs: ${JSON.stringify(cleanupLogs)}`);
		assert(
			logs.filter((event) => event.event === "provider_request_failed").length === 1,
			"Rejected stealth request was reported more than once as a request failure",
		);
	} else {
		assert(state.stealthLoads === 0, "Standard provider loaded stealth during boot");

		const expectedErrors = [
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
			JSON.stringify(await nativeResponse.json()) ===
				JSON.stringify({ data: { available: false } }),
			"Undeclared native capability was unexpectedly present",
		);
	}
} finally {
	await handle.close();
}
