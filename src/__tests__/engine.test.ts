import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../define.js";
import {
	createProviderEnvironment,
	ENGINE_OWNED_RUNTIME_ENV_NAMES,
	ENGINE_OWNED_TELEMETRY_ENV_NAMES,
	isEngineOwnedEnvName,
	readEngineProxyCredentials,
} from "../engine.js";
import { createInternalTestProviderEngine } from "../internal/in-process-engine.js";
import { createServerApp } from "./helpers/server.js";
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
		const ctx = createInternalTestProviderEngine().attach<{
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
		const ctx = createInternalTestProviderEngine().attach({
			provider: definition(),
			bindings: { trace, http: {} as HttpClient },
		});

		expect(() => Reflect.get(ctx, "http")).toThrow(
			'Provider "engine-fixture" accessed undeclared capability "http"',
		);
	});

	it("fails attachment before execution when a declared binding is unavailable", () => {
		expect(() =>
			createInternalTestProviderEngine().attach({
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
			createInternalTestProviderEngine().attach({
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
	const contributorSecrets = (names: readonly string[]) =>
		names.map((name) => ({ name, issuer: "contributor" as const }));

	it("projects only contributor-issued provider secrets into the local process", () => {
		expect(
			createProviderEnvironment({ CONTRIBUTOR_KEY: "local", APIFUSE_KEY: "platform" }, [
				{ name: "CONTRIBUTOR_KEY", issuer: "contributor" },
				{ name: "APIFUSE_KEY", issuer: "apifuse" },
			]),
		).toEqual({ CONTRIBUTOR_KEY: "local" });
	});

	it("filters every declared runtime vendor class and CDP-pool name", () => {
		const source = Object.fromEntries(
			[...ENGINE_OWNED_RUNTIME_ENV_NAMES, "APIFUSE__CDP_POOL__SMARTPROXY_GATEWAY_CIDRS"].map(
				(name) => [name, `secret:${name}`],
			),
		);
		source.PROVIDER_TOKEN = "provider-token";

		expect(createProviderEnvironment(source, contributorSecrets(Object.keys(source)))).toEqual({
			PROVIDER_TOKEN: "provider-token",
		});
	});
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
		expect(createProviderEnvironment(source, contributorSecrets(Object.keys(source)))).toEqual({
			PROVIDER_TOKEN: "provider-token",
		});
	});

	it("classifies OTLP export configuration as engine-owned and omits it from provider environments", () => {
		const source = {
			OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20engine-token",
			OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Bearer%20engine-traces-token",
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test:4318",
			OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.test:4318/v1/traces",
			OTEL_SERVICE_NAME: "engine-service",
			OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod",
			PROVIDER_TOKEN: "provider-token",
		};

		expect(ENGINE_OWNED_TELEMETRY_ENV_NAMES.every((name) => isEngineOwnedEnvName(name))).toBe(true);
		expect(isEngineOwnedEnvName("PROVIDER_TOKEN")).toBe(false);
		expect(createProviderEnvironment(source, contributorSecrets(Object.keys(source)))).toEqual({
			PROVIDER_TOKEN: "provider-token",
		});
	});

	it("treats mixed-case aliases of engine-owned names as engine-owned", () => {
		for (const alias of [
			"otel_exporter_otlp_headers",
			"Otel_Exporter_Otlp_Traces_Headers",
			"apifuse__proxy__smartproxy_app_key",
		]) {
			expect(isEngineOwnedEnvName(alias)).toBe(true);
		}
		// Simulates a case-insensitive environment where the alias resolves to the credential.
		const source = {
			otel_exporter_otlp_headers: "Authorization=Bearer%20engine-token",
			OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20engine-token",
			PROVIDER_TOKEN: "provider-token",
		};
		expect(
			createProviderEnvironment(
				source,
				contributorSecrets(["otel_exporter_otlp_headers", "PROVIDER_TOKEN"]),
			),
		).toEqual({ PROVIDER_TOKEN: "provider-token" });
	});

	it("keeps a mixed-case OTLP header alias out of a provider operation environment", async () => {
		const alias = "otel_exporter_otlp_headers";
		const previous = new Map<string, string | undefined>(
			[alias, "PROVIDER_TOKEN"].map((name) => [name, process.env[name]]),
		);
		// On a case-insensitive platform this is the engine's variable; set it directly so the
		// lookup resolves here as well.
		process.env[alias] = "Authorization=Bearer%20engine-only-token";
		process.env.PROVIDER_TOKEN = "provider-token";
		try {
			const provider = definition({
				env: true,
				secrets: [
					{ name: alias, issuer: "contributor" },
					{ name: "PROVIDER_TOKEN", issuer: "contributor" },
				],
				operations: {
					inspectEnvironment: {
						riskClass: "read",
						input: z.object({}),
						output: z.object({
							alias: z.string().optional(),
							providerToken: z.string(),
						}),
						handler: async (ctx) => ({
							alias: ctx.env.get(alias),
							providerToken: ctx.env.get("PROVIDER_TOKEN") ?? "",
						}),
					},
				},
			});
			const response = await createServerApp(provider).request("/v1/inspectEnvironment", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "telemetry-alias-containment", input: {} }),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				data: { providerToken: "provider-token" },
			});
		} finally {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("keeps OTLP header credentials out of a provider operation environment even when declared", async () => {
		const names = ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"] as const;
		const previous = new Map<string, string | undefined>(
			[...names, "PROVIDER_TOKEN"].map((name) => [name, process.env[name]]),
		);
		process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer%20engine-only-token";
		process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = "Authorization=Bearer%20engine-only-traces";
		process.env.PROVIDER_TOKEN = "provider-token";
		try {
			const provider = definition({
				env: true,
				secrets: [
					...names.map((name) => ({ name, issuer: "contributor" as const })),
					{ name: "PROVIDER_TOKEN", issuer: "contributor" },
				],
				operations: {
					inspectEnvironment: {
						riskClass: "read",
						input: z.object({}),
						output: z.object({
							headers: z.string().optional(),
							tracesHeaders: z.string().optional(),
							providerToken: z.string(),
						}),
						handler: async (ctx) => ({
							headers: ctx.env.get(names[0]),
							tracesHeaders: ctx.env.get(names[1]),
							providerToken: ctx.env.get("PROVIDER_TOKEN") ?? "",
						}),
					},
				},
			});
			const response = await createServerApp(provider).request("/v1/inspectEnvironment", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "telemetry-containment", input: {} }),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				data: { providerToken: "provider-token" },
			});
		} finally {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
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
				secrets: [
					{ name, issuer: "contributor" },
					{ name: "PROVIDER_TOKEN", issuer: "contributor" },
				],
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
