import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	createInProcessProviderEngine,
	PROVIDER_ENGINE_MODE_ENV,
	type ProviderEngine,
} from "../engine.js";
import { SDK_OWNED_PROVIDER_ERROR_CODES } from "../error-resolution.js";
import { ValidationError } from "../errors.js";
import {
	assertProcessEngineModeSupported,
	createEngineForMode,
	isUnavailableProviderEngine,
	resolveProviderEngineMode,
} from "../runtime/engine-mode.js";
import { createServerApp, type ProviderServerLogEvent, serve } from "../server/serve.js";
import type { ProviderDefinition, ProviderSecretDeclaration } from "../types.js";
import { createProviderDefinitionDouble, defineTestProvider } from "./test-utils.js";

function provider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
	return createProviderDefinitionDouble({
		id: "engine-mode-provider",
		operations: {
			ping: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => ({ ok: true }),
			},
		},
		...overrides,
	});
}

/** Opaque host engine: attaches like the in-process one but declares no `kind`. */
const customEngine: ProviderEngine = { attach: createInProcessProviderEngine().attach };

function engineModeEvents(events: ProviderServerLogEvent[]) {
	return events.filter((event) => event.event === "provider_engine_mode");
}

async function withEnv<T>(
	values: Record<string, string | undefined>,
	run: () => Promise<T> | T,
): Promise<T> {
	const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		return await run();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

async function callPing(app: ReturnType<typeof createServerApp>, requestId: string) {
	return app.request("/v1/ping", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId, input: {}, headers: {} }),
	});
}

describe("resolveProviderEngineMode", () => {
	it("defaults to the in-process engine and marks it deprecated", () => {
		expect(resolveProviderEngineMode({ environment: {} })).toEqual({
			mode: "in-process",
			source: "default",
			deprecated: true,
			warnings: [],
		});
	});

	it("treats blank, whitespace and mixed-case values the way a rendered manifest produces them", () => {
		expect(resolveProviderEngineMode({ environment: { [PROVIDER_ENGINE_MODE_ENV]: "" } })).toEqual({
			mode: "in-process",
			source: "default",
			deprecated: true,
			warnings: [],
		});
		expect(
			resolveProviderEngineMode({ environment: { [PROVIDER_ENGINE_MODE_ENV]: "  " } }).source,
		).toBe("default");
		expect(
			resolveProviderEngineMode({ environment: { [PROVIDER_ENGINE_MODE_ENV]: " Remote\n" } }),
		).toEqual({ mode: "remote", source: "env", deprecated: false, warnings: [] });
	});

	it("warns and keeps the default for an unrecognized env value instead of failing boot", () => {
		expect(
			resolveProviderEngineMode({ environment: { [PROVIDER_ENGINE_MODE_ENV]: "hybrid" } }),
		).toEqual({
			mode: "in-process",
			source: "default",
			deprecated: true,
			warnings: ["invalid_env_value"],
		});
	});

	it("throws only for a code-authored option value, which no manifest can reach", () => {
		for (const option of ["hybrid", "", "  ", 3]) {
			expect(() =>
				resolveProviderEngineMode({
					// test-invalid: runtime validation must reject a malformed engine mode option.
					option: option as never,
					environment: {},
				}),
			).toThrow(ValidationError);
		}
		expect(resolveProviderEngineMode({ option: " In-Process ", environment: {} }).mode).toBe(
			"in-process",
		);
	});

	it("lets the manifest outrank the option and reports the override", () => {
		expect(
			resolveProviderEngineMode({
				option: "in-process",
				environment: { [PROVIDER_ENGINE_MODE_ENV]: "remote" },
			}),
		).toEqual({
			mode: "remote",
			source: "env",
			deprecated: false,
			warnings: ["env_overrode_option"],
		});
		expect(resolveProviderEngineMode({ option: "remote", environment: {} })).toEqual({
			mode: "remote",
			source: "option",
			deprecated: false,
			warnings: [],
		});
	});

	it("reports an explicit engine object by its kind and flags a mode it cannot honour", () => {
		expect(
			resolveProviderEngineMode({ engine: createInProcessProviderEngine(), environment: {} }),
		).toEqual({ mode: "in-process", source: "engine", deprecated: true, warnings: [] });
		// An opaque host engine still attaches inside the pod process, so the
		// ADR-0011 audit must count it as not yet migrated.
		expect(resolveProviderEngineMode({ engine: customEngine, environment: {} })).toEqual({
			mode: "custom",
			source: "engine",
			deprecated: true,
			warnings: [],
		});
		// Normalized like the env and the option, so the audit cannot be fooled by
		// a host engine that spells its kind differently.
		expect(
			resolveProviderEngineMode({ engine: { kind: " In-Process " }, environment: {} }),
		).toEqual({ mode: "in-process", source: "engine", deprecated: true, warnings: [] });
		expect(
			resolveProviderEngineMode({ engine: { kind: "REMOTE" }, environment: {} }),
		).toEqual({ mode: "remote", source: "engine", deprecated: false, warnings: [] });
		expect(
			resolveProviderEngineMode({
				engine: createInProcessProviderEngine(),
				environment: { [PROVIDER_ENGINE_MODE_ENV]: "remote" },
			}),
		).toEqual({
			mode: "in-process",
			source: "engine",
			deprecated: true,
			warnings: ["engine_object_overrode_requested_mode"],
		});
	});

	it("never lets projected engine credentials select a mode, but says they are unused", () => {
		expect(
			resolveProviderEngineMode({
				environment: {
					APIFUSE__ENGINE__URL: "http://engine.apifuse.svc.cluster.local:8080",
					APIFUSE__ENGINE__API_KEY: "unused-in-in-process-mode",
				},
			}),
		).toEqual({
			mode: "in-process",
			source: "default",
			deprecated: true,
			warnings: ["engine_env_ignored"],
		});
		expect(
			resolveProviderEngineMode({
				environment: {
					[PROVIDER_ENGINE_MODE_ENV]: "remote",
					APIFUSE__ENGINE__URL: "http://engine.apifuse.svc.cluster.local:8080",
				},
			}).warnings,
		).toEqual([]);
		// A host engine may be a remote client that reads the env itself; calling
		// the env unused there would be a false report.
		expect(
			resolveProviderEngineMode({
				engine: customEngine,
				environment: { APIFUSE__ENGINE__API_KEY: "consumed-by-the-host-engine" },
			}).warnings,
		).toEqual([]);
	});
});

describe("createEngineForMode", () => {
	it("serves only the in-process lane and denies every other named mode", () => {
		expect(isUnavailableProviderEngine(createEngineForMode("in-process"))).toBe(false);
		// The mode union is open (`runtimeTarget: "engine"` names further lanes):
		// an unserved lane must not fall back to in-process (ADR-0011 Pitfall 2).
		for (const mode of ["remote", "sidecar", "custom"]) {
			const engine = createEngineForMode(mode);
			expect(isUnavailableProviderEngine(engine)).toBe(true);
			expect(engine.kind).toBe(mode);
		}
	});

	it("stops the CLIs for any mode this release does not serve", () => {
		expect(assertProcessEngineModeSupported({}).mode).toBe("in-process");
		expect(() =>
			assertProcessEngineModeSupported({ [PROVIDER_ENGINE_MODE_ENV]: "remote" }),
		).toThrow(/only serves the in-process engine/);
		// An unrecognized value is still not a mode: it resolves to the default,
		// so the CLI starts rather than refusing on a typo.
		expect(assertProcessEngineModeSupported({ [PROVIDER_ENGINE_MODE_ENV]: "sidecar" })).toEqual({
			mode: "in-process",
			source: "default",
			deprecated: true,
			warnings: ["invalid_env_value"],
		});
	});
});

describe("createServerApp engine mode", () => {
	afterEach(() => {
		delete process.env[PROVIDER_ENGINE_MODE_ENV];
	});

	it("keeps the default path silent and attaches the in-process engine", async () => {
		await withEnv({ [PROVIDER_ENGINE_MODE_ENV]: undefined }, async () => {
			const events: ProviderServerLogEvent[] = [];
			const app = createServerApp(provider(), { logger: (event) => events.push(event) });
			expect(events).toEqual([]);
			expect((await callPing(app, "req_engine_mode_default")).status).toBe(200);
			const readyz = await app.request("/readyz");
			expect(readyz.status).toBe(200);
			expect(await readyz.json()).toMatchObject({
				status: "ok",
				engine: { mode: "in-process", attached: true },
			});
		});
	});

	it("keeps /health static and engine-blind when the engine cannot attach", async () => {
		await withEnv({ [PROVIDER_ENGINE_MODE_ENV]: "remote" }, async () => {
			const app = createServerApp(provider());
			const health = await app.request("/health");
			expect(health.status).toBe(200);
			expect(await health.json()).toEqual({
				status: "ok",
				provider: "engine-mode-provider",
				version: "1.0.0",
			});
		});
	});

	it("serves a structured error per request and 503 readiness when remote is requested", async () => {
		await withEnv({ [PROVIDER_ENGINE_MODE_ENV]: "remote" }, async () => {
			// The whole point: no throw at boot, no CrashLoopBackOff for the fleet.
			const app = createServerApp(provider());
			const readyz = await app.request("/readyz");
			expect(readyz.status).toBe(503);
			expect(await readyz.json()).toMatchObject({
				status: "unavailable",
				engine: { mode: "remote", attached: false },
			});
			const response = await callPing(app, "req_engine_mode_remote");
			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({
				error: { code: "PROVIDER_ENGINE_MODE_UNSUPPORTED", retryable: false },
			});
		});
	});

	it("does not raise the unregistered-error-code signal for engine codes", async () => {
		const events: ProviderServerLogEvent[] = [];
		await withEnv({ [PROVIDER_ENGINE_MODE_ENV]: "remote" }, async () => {
			const app = createServerApp(provider(), { logger: (event) => events.push(event) });
			await callPing(app, "req_engine_mode_signal");
		});
		const failures = events.filter((event) => event.event === "provider_request_failed");
		expect(failures.length).toBe(1);
		expect(failures[0]).toMatchObject({ code: "PROVIDER_ENGINE_MODE_UNSUPPORTED" });
		expect(failures[0]).not.toMatchObject({ signal: "unregistered_provider_error_code" });
		for (const code of [
			"PROVIDER_ENGINE_MODE_UNSUPPORTED",
			"PROVIDER_ENGINE_UNAVAILABLE",
			"PROVIDER_ENGINE_AUTHENTICATION_FAILED",
			"PROVIDER_ENGINE_PROTOCOL_VERSION_MISMATCH",
			"PROVIDER_EGRESS_DENIED",
		]) {
			expect(SDK_OWNED_PROVIDER_ERROR_CODES.has(code)).toBe(true);
		}
	});

	it("uses an explicit engine object as given, even against a requested mode", async () => {
		await withEnv({ [PROVIDER_ENGINE_MODE_ENV]: "remote" }, async () => {
			let attached = false;
			const attach = createInProcessProviderEngine().attach;
			const engine: ProviderEngine = {
				kind: "in-process",
				attach: (input) => {
					attached = true;
					return attach(input);
				},
			};
			const app = createServerApp(provider(), { engine });
			expect((await callPing(app, "req_engine_object")).status).toBe(200);
			expect(attached).toBe(true);
		});
	});
});

describe("serve engine mode telemetry", () => {
	afterEach(() => {
		delete process.env[PROVIDER_ENGINE_MODE_ENV];
	});

	async function bootEvents(
		options: Parameters<typeof serve>[1] = {},
	): Promise<ProviderServerLogEvent[]> {
		const events: ProviderServerLogEvent[] = [];
		const handle = await serve(provider(), {
			...options,
			port: 0,
			shutdown: { signals: false },
			logger: (event) => events.push(event),
		});
		try {
			return engineModeEvents(events);
		} finally {
			await handle.close();
		}
	}

	it("emits one info event per boot naming the default in-process engine as deprecated", async () => {
		await withEnv({ [PROVIDER_ENGINE_MODE_ENV]: undefined }, async () => {
			const events = await bootEvents();
			expect(events).toEqual([
				{
					level: "info",
					event: "provider_engine_mode",
					providerId: "engine-mode-provider",
					mode: "in-process",
					source: "default",
					deprecated: true,
					attached: true,
					sdkVersion: expect.any(String),
				},
			]);
			expect((events[0] as { sdkVersion: string }).sdkVersion).not.toBe("unknown");
		});
	});

	it("reports the option, the env and an explicit engine as the source", async () => {
		await withEnv({ [PROVIDER_ENGINE_MODE_ENV]: undefined }, async () => {
			expect(await bootEvents({ engineMode: "in-process" })).toMatchObject([
				{ mode: "in-process", source: "option", deprecated: true, attached: true },
			]);
			expect(await bootEvents({ engine: customEngine })).toMatchObject([
				{ mode: "custom", source: "engine", deprecated: true, attached: true },
			]);
		});
		await withEnv({ [PROVIDER_ENGINE_MODE_ENV]: "in-process" }, async () => {
			expect(await bootEvents()).toMatchObject([{ mode: "in-process", source: "env" }]);
		});
	});

	it("warns with attached: false when the requested mode has no client", async () => {
		await withEnv({ [PROVIDER_ENGINE_MODE_ENV]: "remote" }, async () => {
			expect(await bootEvents()).toMatchObject([
				{ level: "warn", mode: "remote", source: "env", deprecated: false, attached: false },
			]);
		});
	});

	it("stays info-level while the remote engine env is projected fleet-wide", async () => {
		// The manifest generator projects this env before any mode flips, so it must
		// not turn a healthy in-process boot into a warn line on every pod.
		await withEnv(
			{ [PROVIDER_ENGINE_MODE_ENV]: undefined, APIFUSE__ENGINE__API_KEY: "projected-early" },
			async () => {
				expect(await bootEvents()).toMatchObject([
					{ level: "info", mode: "in-process", attached: true, warnings: ["engine_env_ignored"] },
				]);
			},
		);
	});

	it("carries the declared runtime target and the selection warnings", async () => {
		await withEnv({ [PROVIDER_ENGINE_MODE_ENV]: "sidecar" }, async () => {
			const events: ProviderServerLogEvent[] = [];
			const handle = await serve(provider({ runtimeTarget: "vanilla" }), {
				port: 0,
				shutdown: { signals: false },
				logger: (event) => events.push(event),
			});
			try {
				expect(engineModeEvents(events)).toMatchObject([
					{
						level: "warn",
						runtimeTarget: "vanilla",
						mode: "in-process",
						warnings: ["invalid_env_value"],
					},
				]);
			} finally {
				await handle.close();
			}
		});
	});
});

describe("secret issuer declaration", () => {
	function secretProvider(secret: ProviderSecretDeclaration) {
		return defineTestProvider({
			id: "issuer-provider",
			version: "1.0.0",
			runtime: "standard" as const,
			meta: {
				displayName: "Issuer Provider",
				descriptionKey: "providers.issuer.description",
				category: "test",
			},
			secrets: [secret],
			operations: {
				ping: {
					riskClass: "read" as const,
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async () => ({ ok: true }),
					healthCheckUnsupported: { reason: "test fixture" },
				},
			},
		});
	}

	it("accepts both issuers and an omitted issuer", () => {
		const name = "ISSUER_PROVIDER_API_KEY";
		expect(secretProvider({ name, issuer: "apifuse" }).secrets[0]?.issuer).toBe("apifuse");
		expect(secretProvider({ name, issuer: "contributor" }).secrets[0]?.issuer).toBe("contributor");
		expect(secretProvider({ name }).secrets[0]?.issuer).toBeUndefined();
	});

	it("rejects an unknown issuer", () => {
		expect(() =>
			secretProvider({
				name: "ISSUER_PROVIDER_API_KEY",
				// test-invalid: runtime validation must reject an unknown secret issuer.
				issuer: "vendor" as never,
			}),
		).toThrow(ValidationError);
	});
});
