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
	/**
	 * `host:port` of the resolved Redis. Never includes credentials, path or
	 * query. Absent when the URL does not parse, or when its query carries an
	 * ioredis option that moves the endpoint (`path`, `port`, `host`, `family`)
	 * so the authority is not where the client connects — see
	 * `state_redis_url_ambiguous_endpoint`.
	 */
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
	 * sharing an instance provisioned for something else),
	 * `state_redis_url_unparsed`, or `state_redis_url_ambiguous_endpoint` (the
	 * URL's query carries an ioredis option that moves the endpoint, so the
	 * authority is not reported as the endpoint). Absent when the resolution
	 * was unambiguous.
	 */
	readonly warnings?: readonly string[];
};

/**
 * Whether ioredis' own URL parsing would move the endpoint away from the
 * authority this function can see. `createProviderRedisClient` hands the raw
 * URL to `new Redis(url, …)`, and `parseURL` ends with
 * `defaults(result, queryOptions)` — lodash `defaults`, so a query key only
 * applies where the authority supplied nothing:
 *
 * - `path` is never derived from the authority of a `redis://` URL (that
 *   pathname is the db index), so `?path=` always applies — and
 *   `StandaloneConnector` connects to `options.path` INSTEAD of host/port.
 *   The client is then on a Unix socket the authority says nothing about.
 * - `port` applies only when the URL carries no explicit port.
 * - `host` never applies here: we return early unless `parsed.hostname` is
 *   set, so `result.host` is always already populated.
 * - `family` selects an address family; it does not move `host:port`.
 *
 * Verified against the pinned ioredis 5.11.1. In those cases the endpoint is
 * WITHHELD and the ambiguity named, rather than reported as the authority — a
 * diagnostic whose whole job is to answer "which Redis is this provider on"
 * must not answer it wrongly. The query is never echoed: it can carry a
 * password, which is why `endpoint` is host-and-port only to begin with.
 */
function queryMovesEndpoint(parsed: URL): boolean {
	if (parsed.searchParams.has("path")) return true;
	return parsed.searchParams.has("port") && parsed.port === "";
}

function redisEndpoint(url: string): {
	endpoint?: string;
	scheme?: string;
	ambiguous?: boolean;
} {
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
	const scheme = parsed.protocol.replace(/:$/, "");
	if (queryMovesEndpoint(parsed)) return { scheme, ambiguous: true };
	return {
		scheme,
		endpoint: parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname,
	};
}

function redisReport(resolution: ProviderRedisUrlResolution): {
	report: ProviderStoreBackendReport;
	parsed: boolean;
	ambiguous: boolean;
} {
	const { endpoint, scheme, ambiguous } = redisEndpoint(resolution.url);
	return {
		parsed: endpoint !== undefined || ambiguous === true,
		ambiguous: ambiguous === true,
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
			const { report, parsed, ambiguous } = redisReport(resolution);
			state = report;
			if (!parsed) warnings.push("state_redis_url_unparsed");
			if (ambiguous) warnings.push("state_redis_url_ambiguous_endpoint");
			if (resolution.fallback) warnings.push("state_redis_url_fallback");
		} else {
			state = { backend: input.allowMemoryFallback ? "memory" : "unsupported" };
		}
	}

	const cacheResolution = providerCacheRedisResolutionFromEnv();
	let cache: ProviderStoreBackendReport;
	if (cacheResolution) {
		const { report, parsed, ambiguous } = redisReport(cacheResolution);
		cache = report;
		if (!parsed) warnings.push("cache_redis_url_unparsed");
		if (ambiguous) warnings.push("cache_redis_url_ambiguous_endpoint");
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
