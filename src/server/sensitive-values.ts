import {
	resolvedStringVariants,
	urlCredentialComponents,
	otlpHeaderCredentialValues,
} from "../runtime/diagnostic-env-values.js";
import {
	PROVIDER_CACHE_REDIS_URL_ENV,
	PROVIDER_STATE_REDIS_URL_ENV,
	REDIS_URL_ENV,
} from "../config/loader.js";
import {
	ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES,
	ENGINE_OWNED_RESOLVER_CREDENTIAL_ENV_NAMES,
} from "../engine.js";
import {
	REMOTE_ENGINE_CLIENT_API_KEY_ENV,
	REMOTE_ENGINE_CLIENT_URL_ENV,
} from "../runtime/engine-mode.js";
import { APIFUSE__CACHE__KEY_PEPPER_ENV } from "../runtime/cache.js";
import { APIFUSE__ENGINE__CEREMONY_LEASE_KEY } from "../runtime/egress-lease.js";
import {
	APIFUSE__OCR__API_KEY_ENV,
	APIFUSE__OCR__CLOUDFLARE_API_TOKEN_ENV,
} from "../runtime/ocr.js";
import {
	OTEL_EXPORTER_OTLP_HEADERS,
	OTEL_EXPORTER_OTLP_TRACES_HEADERS,
	OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
} from "../runtime/otlp.js";
import { APIFUSE__CDP_POOL__URL } from "../runtime/resolver-config.js";
import { APIFUSE__STT__CLOUDFLARE_API_TOKEN_ENV } from "../runtime/stt.js";
import type { ProviderDefinition } from "../types.js";
import {
	PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_ENV,
	PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_PREVIOUS_ENV,
} from "./self-test-token.js";

export const SELF_TEST_SENSITIVE_SOURCE_KINDS = [
	"selfTestMasterSecrets",
	"providerSecrets",
	"healthProbeSecrets",
	"requestCredentials",
] as const;

/** Explicit source allowlist: no environment-name or payload-shape secret sweep. */
export const DIAGNOSTIC_SENSITIVE_SOURCE_KINDS = [
	...SELF_TEST_SENSITIVE_SOURCE_KINDS,
	"engineProxyCredentials",
	"engineSolverKeys",
	"engineCeremonyLeaseCredentials",
	"engineClientCredentials",
	"ocrCredentials",
	"sttCredentials",
	"cdpCredentials",
	"statefulForwardingSecret",
	"redisCredentials",
	"otlpHeaders",
	"cacheKeyPepper",
	"sensitiveParams",
] as const;
export type DiagnosticSensitiveSourceKind = (typeof DIAGNOSTIC_SENSITIVE_SOURCE_KINDS)[number];

/**
 * Startup inventory; request-scoped readers additionally register live values on access.
 */
export function collectStaticDiagnosticSensitiveValues(
	provider: ProviderDefinition,
	options: {
		env?: Readonly<Record<string, string | undefined>>;
		statefulForwardingSecret?: string;
	} = {},
): string[] {
	return collectDiagnosticSensitiveValues(provider, {
		...options,
		sourceKinds: DIAGNOSTIC_SENSITIVE_SOURCE_KINDS.filter(
			(kind) => kind !== "requestCredentials" && kind !== "sensitiveParams",
		),
	});
}

/** Generalised self-test collector, also used to seed and enrich ordinary request scopes. */
export function collectDiagnosticSensitiveValues(
	provider: ProviderDefinition,
	options: {
		env?: Readonly<Record<string, string | undefined>>;
		credentialInputs?: Readonly<Record<string, unknown>>;
		connectionSecrets?: Readonly<Record<string, string | undefined>>;
		sensitiveParams?: readonly string[];
		statefulForwardingSecret?: string;
		sourceKinds?: readonly DiagnosticSensitiveSourceKind[];
		minimumLength?: number;
		/** Preserve the legacy self-test response collector when false. */
		includeResolvedEnvVariants?: boolean;
	} = {},
): string[] {
	const env = options.env ?? process.env;
	const envValues = (names: readonly string[]) => names.map((name) => env[name]);
	const resolvedEnvValues = (names: readonly string[]) =>
		envValues(names).flatMap((value) =>
			value === undefined
				? []
				: options.includeResolvedEnvVariants === false
					? [value]
					: [value, value.trim()],
		);
	const healthProbe = provider.healthProbe ?? provider.healthMonitor;
	const sources: Record<DiagnosticSensitiveSourceKind, () => readonly unknown[]> = {
		selfTestMasterSecrets: () =>
			resolvedEnvValues([
				PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_ENV,
				PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_PREVIOUS_ENV,
			]),
		providerSecrets: () => resolvedEnvValues((provider.secrets ?? []).map((secret) => secret.name)),
		healthProbeSecrets: () =>
			resolvedEnvValues([
				...(healthProbe?.requiredSecrets ?? []),
				...Object.values(healthProbe?.credentialInputs ?? {}),
			]),
		requestCredentials: () => [
			...Object.values(options.credentialInputs ?? {}),
			...Object.values(options.connectionSecrets ?? {}),
		],
		engineProxyCredentials: () => resolvedEnvValues(ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES),
		// These are the resolver-config API keys after #251's engine credential projection.
		engineSolverKeys: () => resolvedEnvValues(ENGINE_OWNED_RESOLVER_CREDENTIAL_ENV_NAMES),
		engineCeremonyLeaseCredentials: () => resolvedEnvValues([APIFUSE__ENGINE__CEREMONY_LEASE_KEY]),
		// Remote engine client credential (projected before the ADR-0011 flip). The
		// endpoint itself is an internal service URL, so only credentials embedded
		// in it are inventoried, not the whole URL.
		engineClientCredentials: () => [
			...resolvedEnvValues([REMOTE_ENGINE_CLIENT_API_KEY_ENV]),
			...resolvedStringVariants(env[REMOTE_ENGINE_CLIENT_URL_ENV]).flatMap((url) =>
				urlCredentialComponents(url, { includePathAndQuery: false }),
			),
		],
		ocrCredentials: () =>
			resolvedEnvValues([APIFUSE__OCR__CLOUDFLARE_API_TOKEN_ENV, APIFUSE__OCR__API_KEY_ENV]),
		sttCredentials: () => resolvedEnvValues([APIFUSE__STT__CLOUDFLARE_API_TOKEN_ENV]),
		cdpCredentials: () =>
			resolvedStringVariants(env[APIFUSE__CDP_POOL__URL]).flatMap((url) => [
				url,
				...urlCredentialComponents(url, { includePathAndQuery: true }),
			]),
		statefulForwardingSecret: () => resolvedStringVariants(options.statefulForwardingSecret),
		redisCredentials: () =>
			[PROVIDER_CACHE_REDIS_URL_ENV, PROVIDER_STATE_REDIS_URL_ENV, REDIS_URL_ENV]
				.flatMap((name) => resolvedStringVariants(env[name]))
				.flatMap((url) => urlCredentialComponents(url, { includePathAndQuery: false })),
		otlpHeaders: () => [
			...[OTEL_EXPORTER_OTLP_TRACES_HEADERS, OTEL_EXPORTER_OTLP_HEADERS].flatMap((name) =>
				env[name] === undefined ? [] : otlpHeaderCredentialValues(env[name]),
			),
			...[OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT].flatMap((name) =>
				resolvedStringVariants(env[name]).flatMap((url) =>
					urlCredentialComponents(url, { includePathAndQuery: false }),
				),
			),
		],
		cacheKeyPepper: () => resolvedEnvValues([APIFUSE__CACHE__KEY_PEPPER_ENV]),
		sensitiveParams: () => options.sensitiveParams ?? [],
	};
	const values = new Set<string>();
	for (const kind of options.sourceKinds ?? DIAGNOSTIC_SENSITIVE_SOURCE_KINDS) {
		for (const value of sources[kind]()) {
			if (typeof value === "string" && value.length >= (options.minimumLength ?? 1))
				values.add(value);
		}
	}
	return [...values];
}

const diagnosticEnvNames = new WeakMap<ProviderDefinition, Set<string>>();

/** Derive the live-read allowlist from the same collector as the startup inventory. */
export function createDiagnosticEnvObserver(
	provider: ProviderDefinition,
	register: (values: readonly string[]) => void,
	has?: (value: string) => boolean,
): (name: string, value: string) => void {
	let names = diagnosticEnvNames.get(provider);
	if (!names) {
		names = new Set<string>();
		const captured = names;
		collectStaticDiagnosticSensitiveValues(provider, {
			env: new Proxy(
				{},
				{
					get: (_target, key) => {
						if (typeof key === "string") captured.add(key);
						return undefined;
					},
				},
			),
		});
		diagnosticEnvNames.set(provider, names);
	}
	const seen = new Map<string, string>();
	return (name, value) => {
		if (!names.has(name) || seen.get(name) === value) return;
		if (has?.(value) && has(value.trim())) return;
		// Includes URL userinfo/CDP components and OTLP auth values, using the same rules.
		register([
			...resolvedStringVariants(value),
			...collectStaticDiagnosticSensitiveValues(provider, {
				env: { [name]: value },
			}),
		]);
		seen.set(name, value);
	};
}
