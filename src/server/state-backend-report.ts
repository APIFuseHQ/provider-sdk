import {
	providerCacheRedisResolutionFromEnv,
	type ProviderRedisUrlResolution,
	providerStateRedisResolutionFromEnv,
} from "../config/loader.js";

/**
 * What a provider store resolved to at boot.
 *
 * `endpoint` is deliberately host and port only: the URL can carry a password
 * (`redis://:secret@host:6379`), and the diagnostic inventory already treats
 * those credential components — and only those — as sensitive
 * (`collectDiagnosticSensitiveValues`, `urlCredentialComponents(url, {
 * includePathAndQuery: false })`). A URL that does not parse contributes no
 * endpoint at all rather than a redacted-looking fragment of itself.
 */
export type ProviderStoreBackendReport = {
	/**
	 * `redis` when a URL resolved, `memory` for the in-process fallback,
	 * `unsupported` when state has no backend and every call fails closed,
	 * `injected` when the host handed the server a store object.
	 */
	readonly backend: "redis" | "memory" | "unsupported" | "injected";
	/** Env name that supplied the Redis URL. Present only for `redis`. */
	readonly envName?: string;
	/** `host:port` of the resolved Redis. Never includes credentials, path or query. */
	readonly endpoint?: string;
	/** URL scheme, e.g. `redis` or `rediss`. Present only for `redis`. */
	readonly scheme?: string;
	/** True when the URL came from a shared fallback env rather than the store's own. */
	readonly fallback?: boolean;
};

/**
 * One line per process boot naming the stores the provider resolved. Without
 * it, a provider silently riding the cache Redis for its state is
 * indistinguishable from one on a durable instance, from outside the pod and
 * from the pod's own logs (apifuse#2302, the reason apifuse#2144 could only be
 * verified by inference from the Deployment spec).
 */
export type ProviderStateBackendLogEvent = {
	/** `warn` when a warning was raised, otherwise `info`. */
	readonly level: "info" | "warn";
	readonly event: "provider_state_backend";
	readonly providerId: string;
	readonly state: ProviderStoreBackendReport;
	readonly cache: ProviderStoreBackendReport;
	readonly sdkVersion: string;
	/**
	 * Non-fatal findings, e.g. `state_redis_url_fallback` (the state store is
	 * sharing an instance provisioned for something else) or
	 * `state_redis_url_unparsed`. Absent when the resolution was unambiguous.
	 */
	readonly warnings?: readonly string[];
};

function redisEndpoint(url: string): { endpoint?: string; scheme?: string } {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return {};
	}
	// No authority means this is not the `redis://host:port` shape at all (e.g.
	// a bare `host:port`, which parses as a scheme). Report nothing rather than
	// a fragment of a string whose parts we have not identified.
	if (!parsed.hostname) return {};
	return {
		scheme: parsed.protocol.replace(/:$/, ""),
		endpoint: parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname,
	};
}

function redisReport(resolution: ProviderRedisUrlResolution): {
	report: ProviderStoreBackendReport;
	parsed: boolean;
} {
	const { endpoint, scheme } = redisEndpoint(resolution.url);
	return {
		parsed: endpoint !== undefined,
		report: {
			backend: "redis",
			envName: resolution.envName,
			...(endpoint === undefined ? {} : { endpoint }),
			...(scheme === undefined ? {} : { scheme }),
			...(resolution.fallback ? { fallback: true } : {}),
		},
	};
}

/**
 * Build the boot event from the same env precedence the stores themselves use
 * (`providerStateRedisResolutionFromEnv` / `providerCacheRedisResolutionFromEnv`),
 * so the line can never describe a backend other than the one in use.
 */
export function providerStateBackendLogEvent(input: {
	readonly providerId: string;
	readonly sdkVersion: string;
	/** The host passed an explicit state store, so no env resolution happened. */
	readonly injectedState: boolean;
	/** Mirrors `createProviderRuntimeStateFromEnv({ allowMemoryFallback })`. */
	readonly allowMemoryFallback: boolean;
}): ProviderStateBackendLogEvent {
	const warnings: string[] = [];
	let state: ProviderStoreBackendReport;
	if (input.injectedState) {
		state = { backend: "injected" };
	} else {
		const resolution = providerStateRedisResolutionFromEnv();
		if (resolution) {
			const { report, parsed } = redisReport(resolution);
			state = report;
			if (!parsed) warnings.push("state_redis_url_unparsed");
			if (resolution.fallback) warnings.push("state_redis_url_fallback");
		} else {
			state = { backend: input.allowMemoryFallback ? "memory" : "unsupported" };
		}
	}

	const cacheResolution = providerCacheRedisResolutionFromEnv();
	let cache: ProviderStoreBackendReport;
	if (cacheResolution) {
		const { report, parsed } = redisReport(cacheResolution);
		cache = report;
		if (!parsed) warnings.push("cache_redis_url_unparsed");
	} else {
		cache = { backend: "memory" };
	}

	return {
		level: warnings.length > 0 ? "warn" : "info",
		event: "provider_state_backend",
		providerId: input.providerId,
		state,
		cache,
		sdkVersion: input.sdkVersion,
		...(warnings.length === 0 ? {} : { warnings }),
	};
}
