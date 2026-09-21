import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	PROVIDER_CACHE_REDIS_URL_ENV,
	PROVIDER_STATE_REDIS_URL_ENV,
	REDIS_URL_ENV,
} from "../config/loader.js";
import { createProviderRuntimeStateFromEnv } from "../runtime/state.js";
import { type ProviderServerLogEvent, serve } from "../server/serve.js";
import { providerStateBackendLogEvent } from "../server/state-backend-report.js";
import type { ProviderDefinition } from "../types.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const NAMESPACE_OPTIONS = {
	defaultTtl: "1h",
	maxTtl: "1h",
	maxEntries: 5,
	maxValueBytes: 1024,
} as const;

const STORE_ENV_NAMES = [
	PROVIDER_STATE_REDIS_URL_ENV,
	PROVIDER_CACHE_REDIS_URL_ENV,
	REDIS_URL_ENV,
] as const;

async function withEnv<T>(
	values: Record<string, string | undefined>,
	run: () => Promise<T> | T,
): Promise<T> {
	const names = new Set([...Object.keys(values), ...STORE_ENV_NAMES]);
	const previous = new Map([...names].map((name) => [name, process.env[name]]));
	for (const name of names) delete process.env[name];
	for (const [name, value] of Object.entries(values)) {
		if (value !== undefined) process.env[name] = value;
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

function bootEvent(options: { injectedState?: boolean; allowMemoryFallback?: boolean } = {}) {
	return providerStateBackendLogEvent({
		providerId: "state-backend-provider",
		sdkVersion: "0.0.0-test",
		injectedState: options.injectedState === true,
		allowMemoryFallback: options.allowMemoryFallback === true,
	});
}

function provider(): ProviderDefinition {
	return createProviderDefinitionDouble({
		id: "state-backend-provider",
		operations: {
			ping: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => ({ ok: true }),
			},
		},
	});
}

describe("providerStateBackendLogEvent", () => {
	it("names the state store's own env and endpoint without the URL credentials", async () => {
		const event = await withEnv(
			{
				[PROVIDER_STATE_REDIS_URL_ENV]:
					"redis://apifuse:hunterbramble@provider-state-redis.fusepie-backend.svc.cluster.local:6379",
				[PROVIDER_CACHE_REDIS_URL_ENV]: "redis://redis.fusepie-backend.svc.cluster.local:6379",
			},
			() => bootEvent(),
		);

		expect(event).toEqual({
			level: "info",
			event: "provider_state_backend",
			providerId: "state-backend-provider",
			state: {
				backend: "redis",
				envName: PROVIDER_STATE_REDIS_URL_ENV,
				endpoint: "provider-state-redis.fusepie-backend.svc.cluster.local:6379",
				scheme: "redis",
			},
			cache: {
				backend: "redis",
				envName: PROVIDER_CACHE_REDIS_URL_ENV,
				endpoint: "redis.fusepie-backend.svc.cluster.local:6379",
				scheme: "redis",
			},
			sdkVersion: "0.0.0-test",
		});
		expect(JSON.stringify(event)).not.toContain("hunterbramble");
		expect(JSON.stringify(event)).not.toContain("apifuse:");
	});

	// The apifuse#2144 shape: state silently riding the cache instance, which
	// runs with persistence off. Before this event the two were indistinguishable
	// from outside the pod and from the pod's own logs.
	it("warns when the state store falls back to the cache Redis", async () => {
		const event = await withEnv(
			{ [PROVIDER_CACHE_REDIS_URL_ENV]: "redis://redis.fusepie-backend.svc.cluster.local:6379" },
			() => bootEvent(),
		);

		expect(event.level).toBe("warn");
		expect(event.warnings).toEqual(["state_redis_url_fallback"]);
		expect(event.state).toEqual({
			backend: "redis",
			envName: PROVIDER_CACHE_REDIS_URL_ENV,
			endpoint: "redis.fusepie-backend.svc.cluster.local:6379",
			scheme: "redis",
			fallback: true,
		});
	});

	it("reports the shared instance env when only APIFUSE__REDIS__URL is bound", async () => {
		const event = await withEnv({ [REDIS_URL_ENV]: "rediss://shared.example:6380" }, () =>
			bootEvent(),
		);

		expect(event.state).toEqual({
			backend: "redis",
			envName: REDIS_URL_ENV,
			endpoint: "shared.example:6380",
			scheme: "rediss",
			fallback: true,
		});
		expect(event.cache).toEqual({
			backend: "redis",
			envName: REDIS_URL_ENV,
			endpoint: "shared.example:6380",
			scheme: "rediss",
			fallback: true,
		});
	});

	// `createProviderRedisClient` hands the raw URL to `new Redis(url, …)` and
	// ioredis lets the query override the authority, so `redis://state:6379
	// ?path=/tmp/cache.sock` connects to a Unix socket while the authority says
	// otherwise. A diagnostic that exists to answer "which Redis is this on"
	// must not answer it wrongly; the query is never echoed.
	it("withholds the endpoint when the URL's query can move it", async () => {
		const event = await withEnv(
			{
				[PROVIDER_STATE_REDIS_URL_ENV]:
					"redis://state.example:6379?path=/tmp/cache.sock",
			},
			() => bootEvent(),
		);

		expect(event.state).toEqual({
			backend: "redis",
			envName: PROVIDER_STATE_REDIS_URL_ENV,
			scheme: "redis",
		});
		expect(event.warnings).toContain("state_redis_url_ambiguous_endpoint");
		expect(event.warnings).not.toContain("state_redis_url_unparsed");
		expect(JSON.stringify(event)).not.toContain("/tmp/cache.sock");
		expect(JSON.stringify(event)).not.toContain("state.example");
	});

	// ioredis 5.11.1 finishes `parseURL` with `defaults(result, queryOptions)`,
	// so a query key only applies where the authority supplied nothing. These
	// URLs all connect to the authority, and withholding their endpoint would
	// erase a correct answer and raise a false warning.
	it.each([
		["redis://state.example:6379?db=3", "state.example:6379"],
		["redis://state.example:6379?port=6380", "state.example:6379"],
		["redis://state.example:6379?host=other.example", "state.example:6379"],
		["redis://state.example:6379?family=6", "state.example:6379"],
	])("keeps the endpoint for %s, which ioredis ignores", async (url, endpoint) => {
		const event = await withEnv({ [PROVIDER_STATE_REDIS_URL_ENV]: url }, () =>
			bootEvent(),
		);

		expect(event.state.endpoint).toBe(endpoint);
		expect(event.warnings).toBeUndefined();
	});

	// …but a query `port` DOES apply when the authority carries none.
	it("withholds the endpoint when the query supplies the port the URL omits", async () => {
		const event = await withEnv(
			{ [PROVIDER_STATE_REDIS_URL_ENV]: "redis://state.example?port=6380" },
			() => bootEvent(),
		);

		expect(event.state.endpoint).toBeUndefined();
		expect(event.warnings).toContain("state_redis_url_ambiguous_endpoint");
	});

	it("contributes no endpoint for a URL it cannot parse, rather than a fragment of it", async () => {
		const event = await withEnv(
			{ [PROVIDER_STATE_REDIS_URL_ENV]: "provider-state-redis:6379" },
			() => bootEvent(),
		);

		expect(event.state.endpoint).toBeUndefined();
		expect(event.warnings).toContain("state_redis_url_unparsed");
		expect(JSON.stringify(event)).not.toContain("provider-state-redis:6379");
	});

	// The report must describe the store the server actually built, so the two
	// decisions are asserted against each other rather than kept in step by hand.
	it("agrees with createProviderRuntimeStateFromEnv when no URL is bound", async () => {
		await withEnv({}, async () => {
			expect(bootEvent().state).toEqual({ backend: "unsupported" });
			await expect(
				createProviderRuntimeStateFromEnv({ providerId: "p" })
					.namespace("boot", NAMESPACE_OPTIONS)
					.get("key"),
			).rejects.toMatchObject({ code: "PROVIDER_STATE_UNSUPPORTED" });

			expect(bootEvent({ allowMemoryFallback: true }).state).toEqual({ backend: "memory" });
			await expect(
				createProviderRuntimeStateFromEnv({ providerId: "p", allowMemoryFallback: true })
					.namespace("boot", NAMESPACE_OPTIONS)
					.get("key"),
			).resolves.toBeNull();
		});
	});

	it("does not claim an env resolution when the host injected a state store", async () => {
		const event = await withEnv(
			{ [PROVIDER_STATE_REDIS_URL_ENV]: "redis://provider-state-redis:6379" },
			() => bootEvent({ injectedState: true }),
		);

		expect(event.state).toEqual({ backend: "injected" });
		expect(event.warnings).toBeUndefined();
	});
});

describe("serve", () => {
	it("emits exactly one provider_state_backend line per boot", async () => {
		await withEnv(
			{ [PROVIDER_STATE_REDIS_URL_ENV]: "redis://provider-state-redis.fusepie-backend:6379" },
			async () => {
				const events: ProviderServerLogEvent[] = [];
				const handle = await serve(provider(), {
					port: 0,
					shutdown: { signals: false },
					logger: (event) => events.push(event),
				});
				try {
					expect(
						events.filter((event) => event.event === "provider_state_backend"),
					).toMatchObject([
						{
							level: "info",
							providerId: "state-backend-provider",
							state: {
								backend: "redis",
								envName: PROVIDER_STATE_REDIS_URL_ENV,
								endpoint: "provider-state-redis.fusepie-backend:6379",
							},
							cache: { backend: "memory" },
						},
					]);
				} finally {
					await handle.close();
				}
			},
		);
	});
});
