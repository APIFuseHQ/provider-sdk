import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../define.js";
import {
	createInProcessProviderEngine,
	createProviderEnvironment,
	readEngineProxyCredentials,
} from "../engine.js";
import { createServerApp } from "../server/serve.js";
import type { HttpClient, ProviderDefinition, TraceContext } from "../types.js";

const trace: TraceContext = {
	span: async (_name, run) => run(),
};

function definition(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
	return {
		id: "engine-fixture",
		version: "1.0.0",
		runtime: "standard",
		runtimeTarget: "vanilla",
		meta: {
			displayName: "Engine fixture",
			descriptionKey: "engine-fixture.description",
			category: "test",
		},
		operations: {},
		...overrides,
	};
}

describe("provider engine attachment", () => {
	it("attaches exactly declared bindings plus ambient tracing", () => {
		const http = {} as HttpClient;
		const ctx = createInProcessProviderEngine().attach<{
			readonly http: Record<string, never>;
		}>({
			provider: definition({ http: {} }),
			bindings: { trace, http },
		});

		expect(ctx.http).toBe(http);
		expect(ctx.trace).toBe(trace);
		expect(Object.keys(ctx).sort()).toEqual(["http", "trace"]);
	});

	it("fails closed and names a dynamically accessed undeclared capability", () => {
		const ctx = createInProcessProviderEngine().attach({
			provider: definition(),
			bindings: { trace, http: {} as HttpClient },
		});

		expect(() => Reflect.get(ctx, "http")).toThrow(
			'Provider "engine-fixture" accessed undeclared capability "http"',
		);
	});

	it("fails attachment before execution when a declared binding is unavailable", () => {
		expect(() =>
			createInProcessProviderEngine().attach({
				provider: definition({ http: {} }),
				bindings: { trace },
			}),
		).toThrow('could not attach declared capability "http"');
	});

	it("rejects native on the vanilla runtime during declaration validation", () => {
		expect(() =>
			defineProvider({
				id: "vanilla-native",
				version: "1.0.0",
				runtime: "standard",
				runtimeTarget: "vanilla",
				native: {},
				meta: {
					displayName: "Vanilla native",
					descriptionKey: "vanilla-native.description",
					category: "test",
				},
			}),
		).toThrow(/capability "native".*runtime target "vanilla".*engine-resident/);
	});

	it("also rejects vanilla native at the local attachment boundary", () => {
		expect(() =>
			createInProcessProviderEngine().attach({
				provider: definition({ native: {} }),
				// @ts-expect-error test-invalid: target validation runs before the native binding is inspected.
				bindings: { trace, native: {} },
			}),
		).toThrow(/capability "native".*runtime target "vanilla".*engine-resident/);
	});

	it("accepts native for an engine-resident declaration", () => {
		expect(() =>
			defineProvider({
				id: "engine-native",
				version: "1.0.0",
				runtime: "standard",
				runtimeTarget: "engine",
				native: {},
				meta: {
					displayName: "Engine native",
					descriptionKey: "engine-native.description",
					category: "test",
				},
			}),
		).not.toThrow();
	});

	it("rejects a malformed runtime target before building operations", () => {
		expect(() =>
			defineProvider({
				id: "invalid-runtime-target",
				version: "1.0.0",
				runtime: "standard",
				// @ts-expect-error test-invalid: runtime validation must reject a non-string target.
				runtimeTarget: 42,
				meta: {
					displayName: "Invalid runtime target",
					descriptionKey: "invalid-runtime-target.description",
					category: "test",
				},
			}),
		).toThrow(/invalid runtimeTarget.*vanilla.*engine/);
	});
});

describe("engine credential containment", () => {
	it("captures proxy credentials for the engine but omits them from provider environments", () => {
		const source = {
			APIFUSE__PROXY__SMARTPROXY_APP_KEY: "engine-key",
			APIFUSE__PROXY__NODEMAVEN_USERNAME: "engine-user",
			APIFUSE__PROXY__NODEMAVEN_PASSWORD: "engine-password",
			PROVIDER_TOKEN: "provider-token",
		};

		expect(readEngineProxyCredentials(source)).toEqual({
			APIFUSE__PROXY__SMARTPROXY_APP_KEY: "engine-key",
			APIFUSE__PROXY__NODEMAVEN_USERNAME: "engine-user",
			APIFUSE__PROXY__NODEMAVEN_PASSWORD: "engine-password",
		});
		expect(createProviderEnvironment(source, Object.keys(source))).toEqual({
			PROVIDER_TOKEN: "provider-token",
		});
	});

	it("keeps proxy credentials out of a provider operation environment", async () => {
		const name = "APIFUSE__PROXY__SMARTPROXY_APP_KEY";
		const previousProxyKey = process.env[name];
		const previousProviderToken = process.env.PROVIDER_TOKEN;
		process.env[name] = "engine-only-key";
		process.env.PROVIDER_TOKEN = "provider-token";
		try {
			const provider = definition({
				env: true,
				secrets: [{ name }, { name: "PROVIDER_TOKEN" }],
				operations: {
					inspectEnvironment: {
						riskClass: "read",
						input: z.object({}),
						output: z.object({
							proxyKey: z.string().optional(),
							providerToken: z.string(),
						}),
						handler: async (ctx) => ({
							proxyKey: ctx.env.get(name),
							providerToken: ctx.env.get("PROVIDER_TOKEN") ?? "",
						}),
					},
				},
			});
			const response = await createServerApp(provider).request("/v1/inspectEnvironment", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "credential-containment", input: {} }),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				data: { providerToken: "provider-token" },
			});
		} finally {
			if (previousProxyKey === undefined) delete process.env[name];
			else process.env[name] = previousProxyKey;
			if (previousProviderToken === undefined) delete process.env.PROVIDER_TOKEN;
			else process.env.PROVIDER_TOKEN = previousProviderToken;
		}
	});
});
