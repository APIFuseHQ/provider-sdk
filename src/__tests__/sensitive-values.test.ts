import { expect, it } from "bun:test";
import { z } from "zod";
import { createProviderEnvironment } from "../engine.js";
import { createDiagnosticRedactor } from "../runtime/diagnostic-redactor.js";
import type { TraceContext } from "../runtime/trace.js";
import { collectStaticDiagnosticSensitiveValues } from "../server/sensitive-values.js";
import { createServerApp, type ProviderServerLogEvent } from "../server/serve.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

it("registers separately echoed CDP, Redis and decoded OTLP credential components", () => {
	const values = collectStaticDiagnosticSensitiveValues(createProviderDefinitionDouble(), {
		env: {
			APIFUSE__CDP_POOL__URL:
				" ws://orchardmeadow:meadowwillow@cdp.test/willowforest?auth=forestgarden&gardenpetals ",
			APIFUSE__PROVIDER__CACHE_REDIS_URL: "redis://gardenflower:flowerbasket@redis.test",
			APIFUSE__PROVIDER__STATE_REDIS_URL: "redis://basketgroves:grovesbranch@redis.test",
			APIFUSE__REDIS__URL: "redis://branchleaves:leavespetals@redis.test",
			OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20petalsgarden",
			OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-api-key=meadow%20garden",
		},
	});
	const registry = createDiagnosticRedactor(values);
	for (const secret of [
		"orchardmeadow",
		"meadowwillow",
		"orchardmeadow:meadowwillow",
		"willowforest",
		"forestgarden",
		"gardenflower",
		"flowerbasket",
		"basketgroves",
		"grovesbranch",
		"branchleaves",
		"leavespetals",
		"petalsgarden",
		"Bearer petalsgarden",
		"gardenpetals",
		"meadow garden",
	])
		expect(registry.redact(`echo ${secret}`)).toBe("echo [REDACTED]");
});

it("registers raw and trimmed OCR, STT, signing and cache credentials", () => {
	const env = {
		APIFUSE__OCR__CLOUDFLARE_API_TOKEN: " orchardmeadow ",
		APIFUSE__OCR__API_KEY: " meadowwillow ",
		APIFUSE__STT__CLOUDFLARE_API_TOKEN: " willowforest ",
		APIFUSE__CACHE__KEY_PEPPER: " forestgarden ",
		APIFUSE__ENGINE__CEREMONY_LEASE_KEY: " orchard-garden-ceremony-key-sentinel ",
	};
	const values = collectStaticDiagnosticSensitiveValues(createProviderDefinitionDouble(), {
		env,
		statefulForwardingSecret: " gardenflower ",
	});
	for (const value of [...Object.values(env), " gardenflower "]) {
		expect(values).toContain(value);
		expect(values).toContain(value.trim());
	}
});

it("seeds engine-owned CDP endpoint credentials before creating the request root span", async () => {
	const sentinel = "orchardcdppath";
	const endpoint = `ws://orchardcdpuser:orchardcdppass@cdp.test/${sentinel}?auth=orchardcdpquery`;
	const environment = {
		APIFUSE__CDP_POOL__URL: endpoint,
		APIFUSE__TRACE__ENABLED: "true",
		APIFUSE__TRACE__EXPORTER: "none",
	};
	const previous = new Map(
		Object.keys(environment).map((name) => [name, process.env[name]] as const),
	);
	Object.assign(process.env, environment);
	try {
		expect(createProviderEnvironment(process.env, ["APIFUSE__CDP_POOL__URL"])).toEqual({});
		const events: ProviderServerLogEvent[] = [];
		let trace: TraceContext | undefined;
		const provider = createProviderDefinitionDouble({
			operations: {
				[sentinel]: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async (ctx) => {
						trace = ctx.trace as TraceContext;
						throw new Error(`endpoint ${endpoint}`);
					},
				},
			},
		});
		const response = await createServerApp(provider, {
			logger: (event) => events.push(event),
		}).request(`/v1/${sentinel}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "cdp-source-proof", input: {} }),
		});
		const body = await response.text();
		expect(response.status).toBe(500);
		expect(JSON.parse(body).error.message).toBe("Internal error");
		const failure = events.find((event) => event.event === "provider_request_failed");
		expect(failure?.event).toBe("provider_request_failed");
		if (failure?.event !== "provider_request_failed") throw new Error("Missing request failure");
		expect(failure.message).toBe("endpoint [REDACTED]");
		const root = trace?.getSpans().find((span) => span.name === "request:operation:[REDACTED]");
		expect(root).toBeDefined();
		expect(root?.name).toBe("request:operation:[REDACTED]");
		expect(JSON.stringify({ root, message: failure.message, body })).not.toContain(sentinel);
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

it("registers live values and components from the full env allowlist in only the active request", async () => {
	const { readDiagnosticEnv, withDiagnosticEnv } = await import("../runtime/diagnostic-env.js");
	const { createDiagnosticEnvObserver } = await import("../server/sensitive-values.js");
	const { ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES, ENGINE_OWNED_RESOLVER_CREDENTIAL_ENV_NAMES } =
		await import("../engine.js");
	const names = [
		"P4_ENV_SECRET",
		...ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES,
		...ENGINE_OWNED_RESOLVER_CREDENTIAL_ENV_NAMES,
		"APIFUSE__OCR__API_KEY",
		"APIFUSE__OCR__CLOUDFLARE_API_TOKEN",
		"APIFUSE__STT__CLOUDFLARE_API_TOKEN",
		"APIFUSE__ENGINE__CEREMONY_LEASE_KEY",
		"APIFUSE__CACHE__KEY_PEPPER",
	];
	const provider = createProviderDefinitionDouble({ secrets: [{ name: "P4_ENV_SECRET" }] });
	for (const name of names) {
		const a = createDiagnosticRedactor(),
			b = createDiagnosticRedactor();
		withDiagnosticEnv(createDiagnosticEnvObserver(provider, a.add), () => {
			expect(readDiagnosticEnv(name, { [name]: " orchardgrove " })).toBe(" orchardgrove ");
			expect(a.redact("orchardgrove")).toBe("[REDACTED]");
			expect(a.redact("b3JjaGFyZGdyb3Zl")).toBe("[REDACTED]");
		});
		expect(b.redact("orchardgrove")).toBe("orchardgrove");
	}
	for (const name of [
		"APIFUSE__CDP_POOL__URL",
		"APIFUSE__REDIS__URL",
		"APIFUSE__PROVIDER__CACHE_REDIS_URL",
		"APIFUSE__PROVIDER__STATE_REDIS_URL",
		"OTEL_EXPORTER_OTLP_ENDPOINT",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	]) {
		const registry = createDiagnosticRedactor();
		withDiagnosticEnv(createDiagnosticEnvObserver(provider, registry.add), () =>
			readDiagnosticEnv(name, { [name]: "https://orchardgrove:meadowwillow@collector.test/path" }),
		);
		expect(registry.redact("orchardgrove meadowwillow")).toBe("[REDACTED] [REDACTED]");
	}
	for (const name of ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"]) {
		const registry = createDiagnosticRedactor();
		withDiagnosticEnv(createDiagnosticEnvObserver(provider, registry.add), () =>
			readDiagnosticEnv(name, { [name]: "authorization=Bearer%20orchardgrove" }),
		);
		expect(registry.redact("orchardgrove")).toBe("[REDACTED]");
	}
});

it("registers standalone browser and NodeMaven fallback env reads in the active scope", async () => {
	const { createBrowserClient } = await import("../runtime/browser.js");
	const { hasNodemavenCredentials } = await import("../runtime/proxy-nodemaven.js");
	const { withDiagnosticEnv } = await import("../runtime/diagnostic-env.js");
	const { createDiagnosticEnvObserver } = await import("../server/sensitive-values.js");
	const environment = {
		APIFUSE__CDP_POOL__URL: "ws://collector.test/orchardgrove",
		APIFUSE__PROXY__NODEMAVEN_USERNAME: "meadowwillow",
		APIFUSE__PROXY__NODEMAVEN_PASSWORD: "willowforest",
	};
	const previous = new Map(Object.keys(environment).map((name) => [name, process.env[name]]));
	Object.assign(process.env, environment);
	try {
		const registry = createDiagnosticRedactor();
		await withDiagnosticEnv(
			createDiagnosticEnvObserver(createProviderDefinitionDouble(), registry.add),
			async () => {
				const client = createBrowserClient();
				expect(hasNodemavenCredentials()).toBe(true);
				expect(registry.redact("orchardgrove meadowwillow willowforest")).toBe(
					"[REDACTED] [REDACTED] [REDACTED]",
				);
				await client.close();
			},
		);
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
