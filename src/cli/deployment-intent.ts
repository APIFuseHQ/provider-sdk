import { z } from "zod";

import type { ProviderDeploymentOverrides } from "../types.js";

/**
 * Deployment-intent helpers shared by `apifuse check` and
 * `apifuse migrate-deployment`.
 *
 * Deployment intent has exactly one authored home: the optional `deployment`
 * key on `defineProvider()`. The APIFuse registry builder is the only reader;
 * it resolves omitted fields from a runtime profile and rejects anything it
 * cannot resolve. This module mirrors that profile table so the CLI can
 * (a) subtract profile defaults when hoisting a legacy `deploy.ts` into the
 * key and (b) warn when a declared key restates a default. The registry
 * stays canonical — keep the constants below identical to
 * `resolveProviderDeploymentConfig` in `@apifuse/provider-registry`.
 */

export type DeploymentRuntime = "shared" | "dedicated" | "browser";
export type DeploymentLanguage = "typescript" | "python";

export interface DeploymentResources {
	cpu: string;
	memory: string;
}

export interface DeploymentHpa {
	enabled: boolean;
	minReplicas?: number;
	maxReplicas?: number;
	targetCPUUtilizationPercentage?: number;
}

/** Fully resolved deployment view: what the platform materializes for a provider. */
export interface ResolvedDeploymentIntent {
	runtime: DeploymentRuntime;
	language: DeploymentLanguage;
	replicas: number;
	hpa: DeploymentHpa;
	resources: DeploymentResources;
	cache?: { redis?: { enabled: boolean; url?: string } };
	network?: { additionalTcpPorts: number[] };
	buildContext: string;
}

/**
 * Runtime-profile defaults. `dedicated` carries no resource profile and
 * therefore always needs explicit `resources`.
 */
export const DEPLOYMENT_PROFILE_DEFAULTS = Object.freeze({
	runtime: "shared" as DeploymentRuntime,
	language: "typescript" as DeploymentLanguage,
	replicas: 1,
	hpa: Object.freeze({
		enabled: true,
		minReplicas: 1,
		maxReplicas: 1,
		targetCPUUtilizationPercentage: 70,
	}) as Readonly<DeploymentHpa>,
	buildContext: ".",
	resources: Object.freeze({
		shared: Object.freeze({ cpu: "25m", memory: "128Mi" }),
		browser: Object.freeze({ cpu: "200m", memory: "256Mi" }),
		dedicated: undefined,
	}) as Readonly<Record<DeploymentRuntime, Readonly<DeploymentResources> | undefined>>,
});

const BUILD_CONTEXT_CONSTRAINT =
	'only "." is accepted; external provider images always build from the materialized checkout root';

const hpaSchema = z
	.object({
		enabled: z.boolean(),
		minReplicas: z.number().int().positive().optional(),
		maxReplicas: z.number().int().positive().optional(),
		targetCPUUtilizationPercentage: z.number().int().positive().optional(),
	})
	.strict();

const resourcesSchema = z.object({ cpu: z.string().min(1), memory: z.string().min(1) }).strict();

const cacheSchema = z
	.object({
		redis: z
			.object({ enabled: z.boolean(), url: z.string().min(1).optional() })
			.strict()
			.optional(),
	})
	.strict();

const networkSchema = z
	.object({
		additionalTcpPorts: z.array(z.number().int().min(1).max(65535)).default([]),
	})
	.strict();

const buildContextSchema = z
	.string()
	.min(1)
	.refine((value) => value === ".", { message: BUILD_CONTEXT_CONSTRAINT });

/**
 * The standalone `deploy.ts` contract (legacy). Mirrors the registry's
 * `ProviderDeploymentConfigSchema`, including its own defaults — note that a
 * legacy file without `hpa` resolved to `{ enabled: false }`, not the
 * profile HPA, so the two default tables are deliberately different.
 */
export const legacyDeploymentConfigSchema = z
	.object({
		runtime: z.enum(["shared", "dedicated", "browser"]),
		language: z.enum(["typescript", "python"]),
		replicas: z.number().int().positive().default(1),
		hpa: hpaSchema.default({ enabled: false }),
		resources: resourcesSchema,
		cache: cacheSchema.optional(),
		network: networkSchema.optional(),
		buildContext: buildContextSchema.optional(),
	})
	.strict();

/** The authored `deployment` key: every field optional (registry `ProviderDeploymentOverridesSchema`). */
export const deploymentOverridesSchema = z
	.object({
		runtime: z.enum(["shared", "dedicated", "browser"]).optional(),
		language: z.enum(["typescript", "python"]).optional(),
		replicas: z.number().int().positive().optional(),
		hpa: hpaSchema.optional(),
		resources: resourcesSchema.optional(),
		cache: cacheSchema.optional(),
		network: networkSchema.optional(),
		buildContext: buildContextSchema.optional(),
	})
	.strict();

export type DeploymentParse<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

function formatZodIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.map(String).join(".");
			return path ? `${path}: ${issue.message}` : issue.message;
		})
		.join("; ");
}

/** Parse a legacy `deploy.ts` default export into the resolved view. */
export function normalizeLegacyDeployment(
	value: unknown,
): DeploymentParse<ResolvedDeploymentIntent> {
	const parsed = legacyDeploymentConfigSchema.safeParse(value);
	if (!parsed.success) {
		return {
			ok: false,
			reason: `deploy.ts is not a valid deployment config: ${formatZodIssues(parsed.error)}`,
		};
	}
	const legacy = parsed.data;
	return {
		ok: true,
		value: {
			runtime: legacy.runtime,
			language: legacy.language,
			replicas: legacy.replicas,
			hpa: legacy.hpa,
			resources: legacy.resources,
			...(legacy.cache ? { cache: legacy.cache } : {}),
			...(legacy.network ? { network: legacy.network } : {}),
			buildContext: legacy.buildContext ?? DEPLOYMENT_PROFILE_DEFAULTS.buildContext,
		},
	};
}

/** Parse an authored `deployment` key against the strict overrides contract. */
export function parseDeploymentIntent(
	value: unknown,
): DeploymentParse<ProviderDeploymentOverrides> {
	const parsed = deploymentOverridesSchema.safeParse(value);
	if (!parsed.success) {
		return { ok: false, reason: `deployment key is invalid: ${formatZodIssues(parsed.error)}` };
	}
	return { ok: true, value: parsed.data };
}

/**
 * Resolve an authored key against the runtime profiles, per field;
 * `resources` and `hpa` resolve as whole objects (never deep-merged).
 * Throws when the intent cannot resolve (dedicated runtime without
 * resources, non-default buildContext) — the registry rejects the same.
 */
export function resolveDeploymentIntent(
	intent: ProviderDeploymentOverrides = {},
): ResolvedDeploymentIntent {
	const runtime = intent.runtime ?? DEPLOYMENT_PROFILE_DEFAULTS.runtime;
	const resources = intent.resources ?? DEPLOYMENT_PROFILE_DEFAULTS.resources[runtime];
	if (!resources) {
		throw new Error(
			`resources: runtime "${runtime}" has no profile default; declare explicit resources { cpu, memory }`,
		);
	}
	if (
		intent.buildContext !== undefined &&
		intent.buildContext !== DEPLOYMENT_PROFILE_DEFAULTS.buildContext
	) {
		throw new Error(`buildContext: ${BUILD_CONTEXT_CONSTRAINT}`);
	}
	return {
		runtime,
		language: intent.language ?? DEPLOYMENT_PROFILE_DEFAULTS.language,
		replicas: intent.replicas ?? DEPLOYMENT_PROFILE_DEFAULTS.replicas,
		hpa: intent.hpa ? { ...intent.hpa } : { ...DEPLOYMENT_PROFILE_DEFAULTS.hpa },
		resources: { ...resources },
		...(intent.cache ? { cache: cloneJson(intent.cache) } : {}),
		...(intent.network
			? { network: { additionalTcpPorts: [...(intent.network.additionalTcpPorts ?? [])] } }
			: {}),
		buildContext: intent.buildContext ?? DEPLOYMENT_PROFILE_DEFAULTS.buildContext,
	};
}

/**
 * Two resolved views describe the same deployment when they are deep-equal
 * after dropping empty shells (`network: { additionalTcpPorts: [] }`,
 * `cache: {}`) that carry no intent — the manifests they render are
 * byte-identical.
 */
export function deploymentIntentsEquivalent(
	left: ResolvedDeploymentIntent,
	right: ResolvedDeploymentIntent,
): boolean {
	return deepEqual(canonicalResolvedDeployment(left), canonicalResolvedDeployment(right));
}

export function canonicalResolvedDeployment(
	resolved: ResolvedDeploymentIntent,
): ResolvedDeploymentIntent {
	const { cache, network, ...rest } = resolved;
	const canonical: ResolvedDeploymentIntent = { ...rest };
	if (cache?.redis !== undefined) canonical.cache = { redis: { ...cache.redis } };
	if (network !== undefined && network.additionalTcpPorts.length > 0) {
		canonical.network = { additionalTcpPorts: [...network.additionalTcpPorts] };
	}
	return canonical;
}

/**
 * The smallest `deployment` key that resolves to `resolved`: profile
 * defaults are omitted, `hpa`/`resources` are kept whole when they differ
 * (the resolver never deep-merges them), and empty shells are dropped.
 * Callers prove the result with
 * `deploymentIntentsEquivalent(resolveDeploymentIntent(key), resolved)`.
 */
export function subtractDeploymentDefaults(
	resolved: ResolvedDeploymentIntent,
): ProviderDeploymentOverrides {
	const intent: ProviderDeploymentOverrides = {};
	if (resolved.runtime !== DEPLOYMENT_PROFILE_DEFAULTS.runtime) intent.runtime = resolved.runtime;
	if (resolved.language !== DEPLOYMENT_PROFILE_DEFAULTS.language)
		intent.language = resolved.language;
	if (resolved.replicas !== DEPLOYMENT_PROFILE_DEFAULTS.replicas)
		intent.replicas = resolved.replicas;
	if (!deepEqual(resolved.hpa, DEPLOYMENT_PROFILE_DEFAULTS.hpa)) intent.hpa = { ...resolved.hpa };
	const profileResources = DEPLOYMENT_PROFILE_DEFAULTS.resources[resolved.runtime];
	if (profileResources === undefined || !deepEqual(resolved.resources, profileResources)) {
		intent.resources = { ...resolved.resources };
	}
	if (resolved.cache?.redis !== undefined) intent.cache = { redis: { ...resolved.cache.redis } };
	if (resolved.network !== undefined && resolved.network.additionalTcpPorts.length > 0) {
		intent.network = { additionalTcpPorts: [...resolved.network.additionalTcpPorts] };
	}
	// buildContext: "." is the only accepted value, so it is never authored.
	return intent;
}

/** Authored order for emitted keys: the registry contract's field order. */
export const DEPLOYMENT_INTENT_FIELD_ORDER: readonly (keyof ProviderDeploymentOverrides)[] = [
	"runtime",
	"language",
	"replicas",
	"hpa",
	"resources",
	"cache",
	"network",
	"buildContext",
];

export interface RedundantDeploymentField {
	/** Dotted path under `deployment`, e.g. `hpa` or `network.additionalTcpPorts`. */
	readonly path: string;
	readonly message: string;
}

/**
 * Fields of an authored `deployment` key that restate what the runtime
 * profile already resolves (ADR-0009 "derived values are not re-stated").
 * Accepts an unvalidated value because `apifuse check` inspects the loaded
 * definition, whose key the SDK passes through verbatim.
 */
export function redundantDeploymentDefaults(intent: unknown): RedundantDeploymentField[] {
	if (!isRecord(intent)) return [];
	const redundant: RedundantDeploymentField[] = [];
	const flag = (path: string, detail: string): void => {
		redundant.push({ path, message: `deployment.${path} ${detail}; omit it` });
	};
	if (intent.runtime === DEPLOYMENT_PROFILE_DEFAULTS.runtime) {
		flag("runtime", `restates the profile default ("${DEPLOYMENT_PROFILE_DEFAULTS.runtime}")`);
	}
	if (intent.language === DEPLOYMENT_PROFILE_DEFAULTS.language) {
		flag("language", `restates the profile default ("${DEPLOYMENT_PROFILE_DEFAULTS.language}")`);
	}
	if (intent.replicas === DEPLOYMENT_PROFILE_DEFAULTS.replicas) {
		flag("replicas", `restates the profile default (${DEPLOYMENT_PROFILE_DEFAULTS.replicas})`);
	}
	if (deepEqual(intent.hpa, DEPLOYMENT_PROFILE_DEFAULTS.hpa)) {
		flag("hpa", "restates the profile default (enabled, 1-1 replicas, 70% CPU target)");
	}
	const runtime =
		typeof intent.runtime === "string" && intent.runtime in DEPLOYMENT_PROFILE_DEFAULTS.resources
			? (intent.runtime as DeploymentRuntime)
			: DEPLOYMENT_PROFILE_DEFAULTS.runtime;
	const profileResources = DEPLOYMENT_PROFILE_DEFAULTS.resources[runtime];
	if (profileResources !== undefined && deepEqual(intent.resources, profileResources)) {
		flag(
			"resources",
			`restates the "${runtime}" profile default (${profileResources.cpu}/${profileResources.memory})`,
		);
	}
	if (intent.buildContext === DEPLOYMENT_PROFILE_DEFAULTS.buildContext) {
		flag("buildContext", 'restates the only accepted value (".")');
	}
	if (isRecord(intent.network)) {
		const ports = intent.network.additionalTcpPorts;
		if (ports === undefined || (Array.isArray(ports) && ports.length === 0)) {
			flag("network", "declares no additional TCP ports (empty shell)");
		}
	}
	if (isRecord(intent.cache) && intent.cache.redis === undefined) {
		flag("cache", "declares no redis intent (empty shell)");
	}
	return redundant;
}

/** Structural equality for JSON-shaped values, key order insensitive. */
export function deepEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((item, index) => deepEqual(item, right[index]));
	}
	if (!isRecord(left) || !isRecord(right)) return false;
	const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
	const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
