import {
	compileProcessDiagnosticSensitiveValues,
	createDiagnosticRedactor,
} from "../runtime/diagnostic-redactor.js";
import {
	createResolverClientFromEnv,
	createUnsupportedResolverClient,
} from "../runtime/resolver.js";
import { createResolverRuntimeOptions } from "../runtime/resolver-runtime-options.js";
import { ResolverTelemetryCollector } from "../runtime/resolver-telemetry.js";
import { collectStaticDiagnosticSensitiveValues } from "../server/sensitive-values.js";
import { getStealthProfile } from "../stealth/profiles.js";
import type {
	ProviderCache,
	ProviderDefinition,
	ProviderProxyPolicy,
	ResolverContext,
} from "../types.js";

export interface CliResolverRuntime {
	readonly resolver: ResolverContext;
	/** Per-context sink; `toLogPayload()` is the `resolver` sibling of the server request log. */
	readonly resolverTelemetry: ResolverTelemetryCollector;
}

/**
 * Resolver chain for the CLI helper contexts (`apifuse record`, the `apifuse dev` helper), built
 * like a server request scope: engine-owned solver keys, the CDP pool URL, and the resolver
 * timeout come from the process environment, the runtime options come from the shared builder,
 * and every vendor invocation lands in a collector redacted with the provider's static sensitive
 * inventory. A CLI context has no server-owned identity scope and no proxy telemetry.
 */
export function createCliResolverRuntime(
	provider: ProviderDefinition,
	cache: ProviderCache,
): CliResolverRuntime {
	const resolverTelemetry = new ResolverTelemetryCollector({
		redact: createDiagnosticRedactor(
			[],
			compileProcessDiagnosticSensitiveValues(collectStaticDiagnosticSensitiveValues(provider)),
		).redact,
	});
	if (!provider.resolver) {
		return {
			resolver: createUnsupportedResolverClient("Provider does not declare resolver capability"),
			resolverTelemetry,
		};
	}
	const stealthProfile = provider.stealth ? getStealthProfile(provider.stealth) : undefined;
	return {
		resolver: createResolverClientFromEnv(
			provider.resolver,
			process.env,
			createResolverRuntimeOptions(
				provider,
				cache,
				undefined,
				resolveProxyPolicy(provider),
				{ upstream: { proxy: provider.proxy } },
				stealthProfile,
				resolverTelemetry,
			),
		),
		resolverTelemetry,
	};
}

function resolveProxyPolicy(provider: ProviderDefinition): ProviderProxyPolicy | undefined {
	if (typeof provider.proxy === "object") return provider.proxy;
	if (provider.proxy === true) return { mode: "optional" };
	if (provider.proxy === false) return { mode: "disabled" };
	return undefined;
}
