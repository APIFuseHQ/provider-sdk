import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { Hono } from "hono";
import { z } from "zod";
import { AuthAbortError, createAuthFlowHelpers } from "../auth.js";
import { validateFailClosedDeclaration } from "../declaration-validation.js";
import {
	SDK_OWNED_PROVIDER_ERROR_CODES,
	SDK_RUNTIME_OWNED_ERROR_CODES,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
} from "../error-resolution.js";
import {
	AuthError,
	isProviderError,
	isSessionExpiredError,
	isTransportError,
	isValidationError,
	ProviderError,
} from "../errors.js";
import {
	loadProviderLocaleCatalogs,
	localizeAuthTurn,
	type ProviderLocaleCatalogMap,
} from "../i18n/catalog.js";
import type { ProviderLocale } from "../i18n/keys.js";
import {
	categoryForStatus,
	type ProviderErrorSource,
	sourceForCategory,
	isRetryableCategory,
	PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
	type ProviderErrorCategory,
} from "../observability.js";
import { createScratchpad } from "../runtime/auth-flow.js";
import type * as BrowserRuntimeModule from "../runtime/browser.js";
import { createProviderCache } from "../runtime/cache.js";
import {
	createProviderChoiceContext,
	PROVIDER_RUNTIME_CHOICE_TOKEN_MASTER_SECRET_ENV,
} from "../runtime/choice.js";
import { createCredentialContext } from "../runtime/credential.js";
import { createEnvContext } from "../runtime/env.js";
import { executeOperation } from "../runtime/executor.js";
import { createHttpClient } from "../runtime/http.js";
import { wrapWithInstrumentation } from "../runtime/instrumentation.js";
import type * as NativeNetworkRuntimeModule from "../runtime/native-network.js";
import { getProviderBaseUrl } from "../runtime/provider.js";
import { createOcrClientFromEnv } from "../runtime/ocr.js";
import {
	PROXY_AUTH_IP_DENIED_CODE,
	PROXY_EDGE_AUTH_REJECTED_CODE,
	PROXY_POOL_EXHAUSTED_CODE,
} from "../runtime/proxy-errors.js";
import {
	PROVIDER_TELEMETRY_HEADER,
	ProxyTelemetryCollector,
	type ProxyTelemetryLogPayload,
} from "../runtime/proxy-telemetry.js";
import type * as ResolverRuntimeModule from "../runtime/resolver.js";
import { createUnsupportedResolverClient } from "../runtime/resolver-shared.js";
import {
	assertRequiredSecretsPresent,
	listMissingRequiredSecrets,
	MISSING_SECRET_CODE,
} from "../runtime/secrets.js";
import {
	createProviderRuntimeStateFromEnv,
	createUnsupportedProviderRuntimeState,
} from "../runtime/state.js";
import { StealthCookieJar } from "../runtime/stealth-cookies.js";
import type * as StealthRuntimeModule from "../runtime/stealth.js";
import { createSttClientFromEnv } from "../runtime/stt.js";
import { createTraceContext } from "../runtime/trace.js";
import { resolveTraceConfigFromEnv } from "../runtime/trace-config.js";
import { parseSchema } from "../schema.js";
import {
	STATEFUL_NONCE_HEADER as STATEFUL_FORWARDING_NONCE_HEADER,
	STATEFUL_SIGNATURE_HEADER as STATEFUL_FORWARDING_SIGNATURE_HEADER,
	STATEFUL_TIMESTAMP_HEADER as STATEFUL_FORWARDING_TIMESTAMP_HEADER,
	verifyStatefulRequestSignature,
} from "../stateful-signing.js";
import { StatefulRoutingDeadlineError } from "../stateful/errors.js";
import { getStealthProfile } from "../stealth/profiles.js";
import {
	APIFUSE_STREAM_DONE_EVENT,
	APIFUSE_STREAM_ERROR_EVENT,
	encodeSseEvent,
	error as streamError,
} from "../stream.js";
import type {
	AuthContext,
	AuthTurn,
	BrowserClient,
	FlowContext,
	FlowContextStore,
	HttpRetrySummary,
	OperationDefinition,
	OperationErrorCode,
	OperationHttpStreamTransport,
	OperationSseTransport,
	OcrContext,
	ProviderErrorStatus,
	ProviderContext,
	ProviderDefinition,
	ProviderProxyPolicy,
	ProviderRuntimeState,
	ProviderStreamEvent,
	ResolverContext,
	StealthClient,
	StealthSession,
	StealthSessionCookies,
	SttContext,
} from "../types.js";
import { VALID_OPERATION_ERROR_STATUSES } from "../types.js";
import type { SelfTestCancellationLogEvent } from "./self-test.js";
import { resolveSelfTestMasterSecrets } from "./self-test-token.js";
import { resolveServerTraceContextOptions } from "./trace-output.js";
import {
	type AuthFlowRequest,
	AuthFlowRequestSchema,
	type AuthFlowResponse,
	type AuthFlowSuccessResponse,
	OperationConnectionSchema,
	type OperationErrorResponse,
	type OperationRequest,
	OperationRequestSchema,
	type OperationResponse,
	type OperationSuccessResponse,
} from "./types.js";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;
/** Compact SDK-owned error classification emitted separately from the public response body. */
export const ERROR_OBSERVABILITY_HEADER = "X-ApiFuse-Error-Observability";
export type ErrorObservabilityDetails = {
	category: ProviderErrorCategory;
	taxonomyVersion: string;
	retryable: boolean;
	upstreamStatus?: number;
};
const AUTH_FLOW_LOCALES = ["en", "ko", "ja"] as const;
const retryResponseMeta = new WeakMap<ProviderContext, HttpRetrySummary>();
const STATEFUL_INTERNAL_OPERATIONS_ROUTE = "/__apifuse/stateful/operations";
const STATEFUL_FORWARDING_SOURCE_POD_HEADER = "x-apifuse-stateful-source-pod";
const DEFAULT_STATEFUL_FORWARDING_MAX_SKEW_MS = 5 * 60_000;
const DEFAULT_STATEFUL_FORWARDING_REPLAY_CACHE_MAX_ENTRIES = 10_000;
const STATEFUL_FORWARDING_REPLAY_BUCKET_MS = 10_000;
const STATEFUL_FORWARDING_REPLAY_RETRY_AFTER_SECONDS = Math.ceil(
	STATEFUL_FORWARDING_REPLAY_BUCKET_MS / 1_000,
);

export const ProviderServerStatefulForwardEnvelopeSchema = z
	.object({
		requestId: z.string().min(1),
		providerId: z.string().min(1),
		operationId: z.string().min(1),
		sessionKey: z.string().min(1),
		connectionId: z.string().min(1),
		serviceAccountId: z.string().min(1),
		ownerPodId: z.string().min(1),
		generation: z.number().int().positive(),
		sourcePodId: z.string().min(1),
		forwardedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
		deadlineAt: z
			.string()
			.refine((value) => Number.isFinite(Date.parse(value)))
			.optional(),
		idempotencyKey: z.string().min(1).optional(),
		operationRequest: OperationRequestSchema.extend({
			connection: OperationConnectionSchema.strict().optional(),
		}).strict(),
	})
	.strict();

export type ProviderServerStatefulForwardEnvelope = Readonly<
	z.infer<typeof ProviderServerStatefulForwardEnvelopeSchema>
>;

export type ProviderServerStatefulOwnerFence = Readonly<
	Pick<
		ProviderServerStatefulForwardEnvelope,
		| "providerId"
		| "sessionKey"
		| "ownerPodId"
		| "generation"
		| "sourcePodId"
		| "forwardedAt"
		| "requestId"
		| "idempotencyKey"
	>
>;

export type ProviderServerStatefulOwnerFenceValidator = (
	fence: ProviderServerStatefulOwnerFence,
	signal: AbortSignal,
) => boolean | Promise<boolean>;

export type ProviderServerOperationExecutorInput = {
	readonly provider: ProviderDefinition;
	readonly operationId: string;
	readonly ctx: ProviderContext;
	readonly request: OperationRequest & { readonly deadlineAt?: string };
	readonly signal?: AbortSignal;
	readonly internalStatefulForward?: ProviderServerStatefulForwardEnvelope;
};

export type ProviderServerOperationExecutor = (
	input: ProviderServerOperationExecutorInput,
) => Promise<unknown>;

type RequestCleanup = () => void | Promise<void>;

type ProviderCapabilityModules = {
	readonly browser?: typeof BrowserRuntimeModule;
	readonly nativeNetwork?: typeof NativeNetworkRuntimeModule;
	readonly resolver?: typeof ResolverRuntimeModule;
	readonly stealth?: typeof StealthRuntimeModule;
};

type ProviderServerRuntimeOptions = ProviderServerOptions & {
	readonly capabilityModules: ProviderCapabilityModules;
};

const require = createRequire(import.meta.url);

type CapabilityLoadFailure = {
	readonly capability: string;
	readonly error: unknown;
};

function normalizedCapabilityCause(error: unknown): Error {
	if (error instanceof Error) return error;
	return new Error(String(error));
}

function capabilityLoadError(
	provider: ProviderDefinition,
	failures: readonly CapabilityLoadFailure[],
): ProviderError {
	const normalizedFailures = failures.map(({ capability, error }) => ({
		capability,
		cause: normalizedCapabilityCause(error),
	}));
	const summary = normalizedFailures
		.map(({ capability, cause }) => `${capability} (${cause.message})`)
		.join(", ");
	return new ProviderError(
		`Failed to load declared capabilities for provider "${provider.id}": ${summary}`,
		{
			code: "PROVIDER_CAPABILITY_LOAD_FAILED",
			details: {
				providerId: provider.id,
				failures: normalizedFailures.map(({ capability, cause }) => ({
					capability,
					reason: cause.message,
				})),
			},
			cause: new AggregateError(
				normalizedFailures.map(({ cause }) => cause),
				`Provider capability loading failed for ${provider.id}`,
			),
		},
	);
}

function requireCapabilityModule<T>(
	provider: ProviderDefinition,
	capability: string,
	specifier: string,
): T {
	try {
		return require(specifier) as T;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_REQUIRE_ESM") {
			throw new ProviderError(
				`Synchronous capability loading is unavailable for provider "${provider.id}" on this runtime. Use createServerAppAsync() instead of createServerApp().`,
				{
					code: "PROVIDER_CAPABILITY_SYNC_LOAD_UNSUPPORTED",
					details: { providerId: provider.id, capability },
					cause: normalizedCapabilityCause(error),
				},
			);
		}
		throw capabilityLoadError(provider, [{ capability, error }]);
	}
}

function createAuthStub(): AuthContext {
	return {
		async requestField(name) {
			throw new ProviderError(`Auth prompt is unavailable for ${name}`, {
				code: "AUTH_PROMPT_UNAVAILABLE",
			});
		},
	};
}

function createBrowserStub(): BrowserClient {
	return {
		engine: "playwright-stealth",
		async close() {},
		async newPage() {
			throw new ProviderError("Browser runtime is not available", {
				code: "BROWSER_RUNTIME_UNSUPPORTED",
			});
		},
		async rawPage() {
			throw new ProviderError("Browser runtime is not available", {
				code: "BROWSER_RUNTIME_UNSUPPORTED",
			});
		},
		async withIsolatedContext() {
			throw new ProviderError("Browser runtime is not available", {
				code: "BROWSER_RUNTIME_UNSUPPORTED",
			});
		},
		async solveChallenge() {
			throw new ProviderError("Browser runtime is not available", {
				code: "BROWSER_RUNTIME_UNSUPPORTED",
			});
		},
	};
}

function createStealthStub(): StealthClient {
	return {
		async fetch() {
			throw new ProviderError("Stealth runtime is not available", {
				code: "STEALTH_RUNTIME_UNSUPPORTED",
			});
		},
		createSession() {
			throw new ProviderError("Stealth runtime is not available", {
				code: "STEALTH_RUNTIME_UNSUPPORTED",
			});
		},
		close() {
			// no-op
		},
	};
}

let stealthRuntimeModulePromise: Promise<typeof StealthRuntimeModule> | undefined;

function importStealthRuntime(): Promise<typeof StealthRuntimeModule> {
	stealthRuntimeModulePromise ??= import("../runtime/stealth.js");
	return stealthRuntimeModulePromise;
}

function createForwardingStealthCookies(
	initialTarget: StealthSessionCookies,
): StealthSessionCookies & { setTarget(target: StealthSessionCookies): void } {
	let target = initialTarget;
	return {
		setTarget(nextTarget) {
			target = nextTarget;
		},
		get: (...args) => target.get(...args),
		getAll: (...args) => target.getAll(...args),
		has: (...args) => target.has(...args),
		setFromCookieStrings: (...args) => target.setFromCookieStrings(...args),
		toString: (url?: string) => target.toString(url),
		toHeader: (...args) => target.toHeader(...args),
		snapshot: () => target.snapshot(),
		restore: (...args) => target.restore(...args),
		serialize: () => target.serialize(),
		deserialize: (...args) => target.deserialize(...args),
		clear: () => target.clear(),
		find: (...args) => target.find?.(...args),
	};
}

function createLazyStealthClient(
	onCleanupError: (error: unknown) => void,
	...createArgs: Parameters<typeof StealthRuntimeModule.createStealthClient>
): StealthClient {
	let client: StealthClient | undefined;
	let clientPromise: Promise<StealthClient> | undefined;

	function getClient(): Promise<StealthClient> {
		clientPromise ??= importStealthRuntime().then((runtime) => {
			client ??= runtime.createStealthClient(...createArgs);
			return client;
		});
		return clientPromise;
	}

	return {
		async fetch(...args) {
			return (await getClient()).fetch(...args);
		},
		createSession(options) {
			const localCookies = new StealthCookieJar([], createArgs[0]);
			const cookies = createForwardingStealthCookies(localCookies);
			let closed = false;
			let session: StealthSession | undefined;
			let sessionPromise: Promise<StealthSession> | undefined;

			function getSession(): Promise<StealthSession> {
				sessionPromise ??= getClient().then((realClient) => {
					session = realClient.createSession(options);
					session.cookies.deserialize(localCookies.serialize());
					cookies.setTarget(session.cookies);
					if (closed) session.close();
					return session;
				});
				return sessionPromise;
			}

			return {
				cookies,
				async fetch(...args) {
					return (await getSession()).fetch(...args);
				},
				redirects: {
					async run(...args) {
						return (await getSession()).redirects.run(...args);
					},
				},
				close() {
					closed = true;
					session?.close();
				},
			};
		},
		close() {
			client?.close?.();
			if (!client && clientPromise) {
				void clientPromise.then(
					(loadedClient) => {
						try {
							loadedClient.close?.();
						} catch (error) {
							try {
								onCleanupError(error);
							} catch {
								// A user logger must not turn handled cleanup into a process-level rejection.
							}
						}
					},
					() => {
						// The request path owns reporting for a failed lazy import.
					},
				);
			}
		},
	};
}

function bindResolverSignalWithoutRuntime(
	resolver: ResolverContext,
	defaultSignal: AbortSignal | undefined,
): ResolverContext {
	if (!defaultSignal) return resolver;
	return {
		solve(challenge, signal = defaultSignal) {
			return resolver.solve(challenge, signal);
		},
	};
}

function getProviderStealthBaseUrl(provider: ProviderDefinition): string | undefined {
	const baseUrl = getProviderBaseUrl(provider);
	if (baseUrl) {
		return baseUrl;
	}
	const firstHost = provider.allowedHosts?.[0];
	return firstHost ? `https://${firstHost}` : undefined;
}

function getProviderStealthProfile(provider: ProviderDefinition) {
	return provider.stealth?.profile ? getStealthProfile(provider.stealth.profile) : undefined;
}

function isProductionProviderBrowserMode(provider: ProviderDefinition, env = process.env): boolean {
	if (provider.runtime !== "browser") {
		return false;
	}

	if (env.APIFUSE__PROVIDER__RUNTIME === "browser") {
		return true;
	}

	return env.NODE_ENV === "production" && env.APIFUSE__PROVIDER__ID === provider.id;
}

function declaresStealthRuntime(provider: ProviderDefinition): boolean {
	return provider.stealth !== undefined;
}

async function loadProviderCapabilityModules(
	provider: ProviderDefinition,
): Promise<ProviderCapabilityModules> {
	const results = await Promise.allSettled([
		provider.runtime === "browser" ? import("../runtime/browser.js") : Promise.resolve(undefined),
		provider.native ? import("../runtime/native-network.js") : Promise.resolve(undefined),
		provider.resolver ? import("../runtime/resolver.js") : Promise.resolve(undefined),
		declaresStealthRuntime(provider) ? import("../runtime/stealth.js") : Promise.resolve(undefined),
	]);
	const capabilityNames = ["browser", "native", "resolver", "stealth"] as const;
	const failures: CapabilityLoadFailure[] = [];
	for (const [index, result] of results.entries()) {
		if (result.status === "rejected") {
			failures.push({ capability: capabilityNames[index]!, error: result.reason });
		}
	}
	if (failures.length > 0) throw capabilityLoadError(provider, failures);
	return {
		browser: results[0].status === "fulfilled" ? results[0].value : undefined,
		nativeNetwork: results[1].status === "fulfilled" ? results[1].value : undefined,
		resolver: results[2].status === "fulfilled" ? results[2].value : undefined,
		stealth: results[3].status === "fulfilled" ? results[3].value : undefined,
	};
}

function loadProviderCapabilityModulesSync(
	provider: ProviderDefinition,
): ProviderCapabilityModules {
	return {
		browser:
			provider.runtime === "browser"
				? requireCapabilityModule<typeof BrowserRuntimeModule>(
						provider,
						"browser",
						"../runtime/browser.js",
					)
				: undefined,
		nativeNetwork: provider.native
			? requireCapabilityModule<typeof NativeNetworkRuntimeModule>(
					provider,
					"native",
					"../runtime/native-network.js",
				)
			: undefined,
		resolver: provider.resolver
			? requireCapabilityModule<typeof ResolverRuntimeModule>(
					provider,
					"resolver",
					"../runtime/resolver.js",
				)
			: undefined,
		stealth: declaresStealthRuntime(provider)
			? requireCapabilityModule<typeof StealthRuntimeModule>(
					provider,
					"stealth",
					"../runtime/stealth.js",
				)
			: undefined,
	};
}

export function resolveProviderProxyAffinityKey(
	provider: ProviderDefinition,
	request: OperationRequest,
	operationId: string,
): string {
	const connectionKey = resolveOperationConnectionId(request) ?? request.connection?.externalRef;
	const affinity =
		typeof provider.proxy === "object" ? provider.proxy.session?.affinity : undefined;
	if (affinity === "operation") {
		return `${provider.id}/${operationId}`;
	}
	return connectionKey ?? provider.id;
}

export function resolveProviderResolverIdentityScope(
	provider: ProviderDefinition,
	affinityKey: string,
	contextId: string,
): string {
	return JSON.stringify({
		proxy: provider.proxy ?? null,
		affinityKey,
		contextId,
	});
}

function resolveOperationConnectionId(
	request: Pick<OperationRequest, "connection" | "connectionId">,
): string | undefined {
	// An empty string is a malformed identifier, not an identity: treat it as
	// absent so it can never override a valid id or key a real scope. Requests
	// without any usable id fall back to the documented missing-connection
	// sentinel scope instead of scoping context/affinity/state under "".
	return (
		normalizeConnectionId(request.connection?.id) ?? normalizeConnectionId(request.connectionId)
	);
}

function normalizeConnectionId(id: string | undefined): string | undefined {
	return id === "" ? undefined : id;
}

function resolveNativeProxyPolicy(provider: ProviderDefinition): ProviderProxyPolicy | undefined {
	if (typeof provider.proxy === "object") return provider.proxy;
	if (provider.proxy === true) return { mode: "optional" };
	if (provider.proxy === false) return { mode: "disabled" };
	return undefined;
}

function createProviderContext(
	provider: ProviderDefinition,
	request: OperationRequest,
	operationId: string,
	options: ProviderServerRuntimeOptions,
	state: ProviderRuntimeState = createUnsupportedProviderRuntimeState(),
	proxyTelemetry?: ProxyTelemetryCollector,
	signal?: AbortSignal,
): ProviderContext {
	const traceConfig = resolveTraceConfigFromEnv();
	const baseUrl = getProviderBaseUrl(provider);
	const stealthBaseUrl = getProviderStealthBaseUrl(provider);
	const stealthProfile = getProviderStealthProfile(provider);
	const proxyPolicy = resolveNativeProxyPolicy(provider);
	const proxyClientOptions = {
		upstream: { proxy: provider.proxy },
		affinityKey: resolveProviderProxyAffinityKey(provider, request, operationId),
		telemetry: proxyTelemetry,
	};
	const resolverIdentityScope = resolveProviderResolverIdentityScope(
		provider,
		proxyClientOptions.affinityKey,
		request.requestId,
	);
	let wrappedContext: ProviderContext | undefined;
	const stealthClientOptions = {
		upstream: proxyClientOptions.upstream,
		affinityKey: proxyClientOptions.affinityKey,
		telemetry: proxyTelemetry,
	};
	const { capabilityModules } = options;
	const logStealthCleanupError = (error: unknown) =>
		logProviderCleanupError(
			options.logger,
			provider,
			"operation",
			operationId,
			request.requestId,
			"stealth",
			error,
		);

	const env = createEnvContext([
		...(provider.secrets?.map((secret) => secret.name) ?? []),
		PROVIDER_RUNTIME_CHOICE_TOKEN_MASTER_SECRET_ENV,
	]);
	const credential = createCredentialContext({
		allowedKeys: provider.credential?.keys,
		mode: request.connection?.mode,
		scopes: request.connection?.scopes,
		values: request.connection?.secrets,
	});
	const requestContext = {
		connectionId: resolveOperationConnectionId(request),
		headers: request.headers ?? {},
	};
	const requestState = state.forConnection(requestContext.connectionId);
	const cache = createProviderCache({ providerId: provider.id });
	const context = wrapWithInstrumentation({
		env,
		credential,
		request: requestContext,
		http: createHttpClient(baseUrl, {
			...proxyClientOptions,
			...(signal ? { signal } : {}),
			onRetrySummary: (summary) => {
				if (summary.attempts <= 1 || !wrappedContext) return;
				retryResponseMeta.set(wrappedContext, summary);
			},
		}),
		cache,
		state: requestState,
		stealth: stealthBaseUrl
			? capabilityModules.stealth
				? stealthProfile
					? capabilityModules.stealth.createStealthClient(
							stealthBaseUrl,
							stealthProfile.name,
							stealthClientOptions,
						)
					: capabilityModules.stealth.createStealthClient(stealthBaseUrl, stealthClientOptions)
				: stealthProfile
					? createLazyStealthClient(
							logStealthCleanupError,
							stealthBaseUrl,
							stealthProfile.name,
							stealthClientOptions,
						)
					: createLazyStealthClient(logStealthCleanupError, stealthBaseUrl, stealthClientOptions)
			: createStealthStub(),
		browser:
			provider.runtime === "browser"
				? capabilityModules.browser!.createBrowserClient({
						allowedHosts: provider.allowedHosts,
						cdpUrl: process.env.APIFUSE__CDP_POOL__URL,
						headless: true,
						requireCdpPool: isProductionProviderBrowserMode(provider),
						stealth: true,
						engine: provider.browser?.engine,
					})
				: createBrowserStub(),
		...(provider.native
			? {
					native: {
						network: capabilityModules.nativeNetwork!.createNativeNetworkClient({
							egress: provider.native.network,
							proxyPolicy: resolveNativeProxyPolicy(provider),
							affinityKey: proxyClientOptions.affinityKey,
							credentials: capabilityModules.nativeNetwork!.createEnvVendorCredentialResolver(env),
						}),
					},
				}
			: {}),
		trace: traceConfig
			? createTraceContext(
					resolveServerTraceContextOptions(traceConfig, {
						request_id: request.requestId,
						provider_id: provider.id,
						operation_id: operationId,
					}),
				)
			: createTraceContext(),
		auth: createAuthStub(),
		ocr: options.ocr ?? createOcrClientFromEnv(provider.ocr),
		stt: options.stt ?? createSttClientFromEnv(provider.stt),
		resolver: capabilityModules.resolver
			? capabilityModules.resolver.bindResolverSignal(
					options.resolver ??
						capabilityModules.resolver.createResolverClientFromEnv(provider.resolver, undefined, {
							allowedHosts: provider.allowedHosts,
							cache,
							identityScope: resolverIdentityScope,
							...(proxyPolicy
								? {
										proxyIntent: {
											mode: proxyPolicy.mode,
											...proxyClientOptions,
											...(stealthProfile ? { userAgent: stealthProfile.userAgent } : {}),
										},
									}
								: {}),
						}),
					signal,
				)
			: bindResolverSignalWithoutRuntime(
					options.resolver ??
						createUnsupportedResolverClient("Provider does not declare resolver capability"),
					signal,
				),
		choice: createProviderChoiceContext({
			providerId: provider.id,
			env,
			request: requestContext,
			credential,
			state: requestState,
			onTelemetry: (event) =>
				(options.logger ?? defaultProviderServerLogger)({
					level: "info",
					event: "provider_choice_token",
					...event,
				}),
		}),
	} as ProviderContext);
	wrappedContext = context;
	return context;
}

function createFlowContextStore(
	allowedKeys: string[],
	initialContext: Record<string, unknown> = {},
): {
	context: FlowContextStore;
	getPatch: () => Record<string, unknown | null> | undefined;
} {
	const context = createScratchpad(allowedKeys, initialContext);

	return {
		context,
		getPatch() {
			const next = context.toJSON();
			const patch = new Map<string, unknown | null>();

			for (const [key, value] of Object.entries(next)) {
				if (initialContext[key] !== value) {
					patch.set(key, value);
				}
			}

			for (const key of Object.keys(initialContext)) {
				if (!(key in next)) {
					patch.set(key, null);
				}
			}

			if (patch.size === 0) {
				return undefined;
			}

			return Object.fromEntries(patch.entries());
		},
	};
}

export function resolveAuthFlowProxyAffinityKey(
	provider: ProviderDefinition,
	request: Pick<
		AuthFlowRequest,
		"connection" | "connectionId" | "externalRef" | "tenantId" | "providerId"
	>,
): string {
	return (
		resolveOperationConnectionId(request) ??
		request.externalRef ??
		request.tenantId ??
		request.providerId ??
		provider.id
	);
}

function createAuthFlowContext(
	provider: ProviderDefinition,
	request: AuthFlowRequest,
	options: ProviderServerRuntimeOptions,
	state: ProviderRuntimeState,
	proxyTelemetry?: ProxyTelemetryCollector,
	signal?: AbortSignal,
): {
	context: FlowContext;
	getPatch: () => Record<string, unknown | null> | undefined;
} {
	const baseUrl = getProviderBaseUrl(provider);
	const stealthBaseUrl = getProviderStealthBaseUrl(provider);
	const stealthProfile = getProviderStealthProfile(provider);
	const proxyPolicy = resolveNativeProxyPolicy(provider);
	const contextData = request.context ?? {};
	const flowContextStore = createFlowContextStore(
		provider.context?.keys ?? Object.keys(contextData),
		contextData,
	);
	const proxyClientOptions = {
		upstream: { proxy: provider.proxy },
		affinityKey: resolveAuthFlowProxyAffinityKey(provider, request),
		telemetry: proxyTelemetry,
	};
	const resolverIdentityScope = resolveProviderResolverIdentityScope(
		provider,
		proxyClientOptions.affinityKey,
		request.requestId,
	);
	const stealthClientOptions = {
		upstream: proxyClientOptions.upstream,
		affinityKey: proxyClientOptions.affinityKey,
		telemetry: proxyTelemetry,
	};
	const { capabilityModules } = options;
	const logStealthCleanupError = (error: unknown) =>
		logProviderCleanupError(
			options.logger,
			provider,
			"auth",
			"flow",
			request.requestId,
			"stealth",
			error,
		);
	const credential = request.connection
		? createCredentialContext({
				allowedKeys: provider.credential?.keys,
				mode: request.connection.mode,
				scopes: request.connection.scopes,
				values: request.connection.secrets,
			})
		: undefined;
	const cache = createProviderCache({ providerId: provider.id });

	return {
		context: {
			flowId: request.flowId,
			connectionId: resolveOperationConnectionId(request),
			externalRef: request.externalRef,
			tenantId: request.tenantId ?? "",
			providerId: request.providerId ?? provider.id,
			http: createHttpClient(baseUrl, {
				...proxyClientOptions,
				...(signal ? { signal } : {}),
			}),
			state: state.forConnection(resolveOperationConnectionId(request)),
			stealth: stealthBaseUrl
				? capabilityModules.stealth
					? stealthProfile
						? capabilityModules.stealth.createStealthClient(
								stealthBaseUrl,
								stealthProfile.name,
								stealthClientOptions,
							)
						: capabilityModules.stealth.createStealthClient(stealthBaseUrl, stealthClientOptions)
					: stealthProfile
						? createLazyStealthClient(
								logStealthCleanupError,
								stealthBaseUrl,
								stealthProfile.name,
								stealthClientOptions,
							)
						: createLazyStealthClient(logStealthCleanupError, stealthBaseUrl, stealthClientOptions)
				: createStealthStub(),
			...(provider.native
				? {
						native: {
							network: capabilityModules.nativeNetwork!.createNativeNetworkClient({
								egress: provider.native.network,
								proxyPolicy: resolveNativeProxyPolicy(provider),
								affinityKey: proxyClientOptions.affinityKey,
								credentials: capabilityModules.nativeNetwork!.createEnvVendorCredentialResolver(
									createEnvContext(provider.secrets?.map((secret) => secret.name)),
								),
							}),
						},
					}
				: {}),
			env: createEnvContext([
				...(provider.secrets?.map((secret) => secret.name) ?? []),
				...(provider.auth?.mode === "oauth2_proxied" ? ["APIFUSE__AUTH_PROXY__URL"] : []),
			]),
			credential,
			context: flowContextStore.context,
			ocr: options.ocr ?? createOcrClientFromEnv(provider.ocr),
			stt: options.stt ?? createSttClientFromEnv(provider.stt),
			resolver: capabilityModules.resolver
				? capabilityModules.resolver.bindResolverSignal(
						options.resolver ??
							capabilityModules.resolver.createResolverClientFromEnv(provider.resolver, undefined, {
								allowedHosts: provider.allowedHosts,
								cache,
								identityScope: resolverIdentityScope,
								...(proxyPolicy
									? {
											proxyIntent: {
												mode: proxyPolicy.mode,
												...proxyClientOptions,
												...(stealthProfile ? { userAgent: stealthProfile.userAgent } : {}),
											},
										}
									: {}),
							}),
						signal,
					)
				: bindResolverSignalWithoutRuntime(
						options.resolver ??
							createUnsupportedResolverClient("Provider does not declare resolver capability"),
						signal,
					),
			auth: createAuthFlowHelpers({ signal }),
		},
		getPatch: flowContextStore.getPatch,
	};
}

type ProviderRequestCost = {
	durationMs: number;
	cpuUserMicros: number;
	cpuSystemMicros: number;
	cpuTotalMicros: number;
};

type ProviderServerLogEventBase = ProviderRequestCost & {
	providerId: string;
	kind: "operation" | "auth";
	route: string;
	requestId?: string;
	status: number;
	proxy?: ProxyTelemetryLogPayload;
};

export type ProviderServerLogEvent =
	| (ProviderServerLogEventBase & {
			level: "info";
			event: "provider_request_completed";
	  })
	| (ProviderServerLogEventBase & {
			level: "warn" | "error";
			event: "provider_request_failed";
			code: string;
			errorClass: string;
			message: string;
			upstreamStatus?: number;
			errorCategory?: ProviderErrorCategory;
			taxonomyVersion?: string;
			retryable?: boolean;
			signal?: "unregistered_provider_error_code";
			signalFix?: string;
			issues?: Array<{ path: string; code: string; message: string }>;
	  })
	| {
			level: "warn";
			event: "provider_secrets_missing";
			providerId: string;
			missingSecrets: string[];
	  }
	| {
			level: "info";
			event: "provider_choice_token";
			providerId: string;
			purpose: string;
			operation: "parse" | "consume";
			format: "word" | "legacy";
			outcome: "success" | "not-found" | "invalid" | "unsupported" | "error";
			consumeMode: "never" | "on-parse" | "explicit";
			consumed: boolean;
			replay: boolean;
	  }
	| {
			level: "warn";
			event: "provider_cleanup_failed";
			providerId: string;
			kind: "operation" | "auth";
			route: string;
			requestId?: string;
			resource: "browser" | "stealth";
			errorClass: string;
			message: string;
	  }
	| {
			level: "error";
			event: "provider_shutdown_hook_failed";
			providerId: string;
			hookIndex: number;
			errorClass: string;
			message: string;
	  }
	| SelfTestCancellationLogEvent;

export type ProviderServerLogger = (event: ProviderServerLogEvent) => void;

export type ProviderServerOptions = {
	logger?: ProviderServerLogger;
	/** Optional provider-specific operation executor. Stateful providers use this to preserve provider-local runtime semantics. */
	operationExecutor?: ProviderServerOperationExecutor;
	/** Optional signed internal executor for stateful owner forwarding. */
	internalOperationExecutor?: ProviderServerOperationExecutor;
	statefulForwarding?: {
		readonly secret: string;
		readonly maxSkewMs?: number;
		readonly replayCacheMaxEntries?: number;
		/** Required fail-closed check against the SDK/runtime owner registry. */
		readonly validateOwnerFence: ProviderServerStatefulOwnerFenceValidator;
	};
	/** Optional STT override for tests or custom hosts; local/prod normally resolves from env. */
	stt?: SttContext;
	/** Optional OCR override for tests or custom hosts; local/prod normally resolves from env. */
	ocr?: OcrContext;
	/** Optional resolver override for tests or custom hosts; local/prod normally resolves from env. */
	resolver?: ResolverContext;
	/** Optional runtime state override for tests or custom hosts. Production resolves Redis from env and fails closed when unavailable. */
	state?: ProviderRuntimeState;
	/** Allow process-local runtime state only for local development and tests. */
	allowMemoryStateFallback?: boolean;
	/**
	 * Graceful process shutdown. Hooks run in declaration order after listeners stop accepting work.
	 *
	 * @example
	 * ```ts
	 * await serve(provider, {
	 *	 shutdown: {
	 *		 hooks: [
	 *			 async () => { await emitter.flush(); },
	 *			 async () => { await sessionManager.closeAll("server-shutdown"); },
	 *			 async () => { await lease.release(); },
	 *			 async () => { await router.close(); },
	 *		 ],
	 *	 },
	 * });
	 * ```
	 */
	shutdown?: {
		readonly hooks?: Array<() => Promise<void>>;
		readonly signals?: boolean | NodeJS.Signals[];
		readonly timeoutMs?: number;
	};
};

const defaultProviderServerLogger: ProviderServerLogger = (event) => {
	const line = JSON.stringify(event);
	if (event.level === "info") {
		console.log(line);
		return;
	}
	console.error(line);
};

function startRequestCost(): {
	startedAtMs: number;
	cpuStart: NodeJS.CpuUsage;
} {
	return {
		startedAtMs: performance.now(),
		cpuStart: process.cpuUsage(),
	};
}

function finishRequestCost(input: {
	startedAtMs: number;
	cpuStart: NodeJS.CpuUsage;
}): ProviderRequestCost {
	const cpuDelta = process.cpuUsage(input.cpuStart);
	return {
		durationMs: Math.max(0, Math.round(performance.now() - input.startedAtMs)),
		cpuUserMicros: Math.max(0, cpuDelta.user),
		cpuSystemMicros: Math.max(0, cpuDelta.system),
		cpuTotalMicros: Math.max(0, cpuDelta.user + cpuDelta.system),
	};
}

function zodDetails(error: z.ZodError): Array<{
	path: string;
	code: string;
	message: string;
}> {
	return error.issues.map((issue) => ({
		path: issue.path.join("."),
		code: issue.code,
		message: issue.message,
	}));
}

// Category-level projection with code-aware honesty overrides: a missing
// deployment secret is an APIFuse-side defect even though its category
// (credential_unavailable) usually means a caller credential problem, an
// internal stateful-routing deadline is APIFuse-owned despite its timeout
// category, and the built-in upstream failure families keep their upstream
// attribution even when the author left the category at the provider_error
// default.
function publicErrorSource(error: unknown, category: ProviderErrorCategory): ProviderErrorSource {
	if (error instanceof StatefulRoutingDeadlineError) return "apifuse";
	if (isProviderError(error)) {
		if (error.code === MISSING_SECRET_CODE) return "apifuse";
		if (error.code === "UPSTREAM_ERROR" || error.code === "BLOCKED") {
			return "upstream_failure";
		}
	}
	return sourceForCategory(category);
}

function toErrorResponse(
	error: unknown,
	requestId?: string,
	declaredErrorCode?: OperationErrorCode,
): OperationErrorResponse {
	const observability = errorObservabilityDetails(error, declaredErrorCode);
	const source = publicErrorSource(error, observability.category);
	if (error instanceof StatefulRoutingDeadlineError) {
		return {
			error: {
				code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
				message: "Stateful forwarding deadline expired.",
				...(requestId ? { requestId } : {}),
				retryable: observability.retryable,
				source,
			},
		};
	}

	if (isProviderError(error)) {
		const details = error.details;
		return {
			error: {
				code: error.code ?? "provider_error",
				message: publicProviderErrorMessage(error),
				...(requestId ? { requestId } : {}),
				retryable: observability.retryable,
				source,
				...(error.fix ? { fix: error.fix } : {}),
				...(details !== undefined ? { details } : {}),
			},
		};
	}

	if (error instanceof z.ZodError) {
		return {
			error: {
				code: "invalid_request",
				message: "Invalid request body",
				...(requestId ? { requestId } : {}),
				retryable: observability.retryable,
				source,
				details: zodDetails(error),
			},
		};
	}

	// A masked internal error MUST NOT be advertised as retryable: without an
	// explicit retryable:false the hub (bori provider-backed engine) defaults 5xx
	// to retryable:true, which turns a deterministic pre-upstream crash into an
	// infinite START->CONTINUE->restart loop (2026-07-22 catchtable reserve RCA).
	// We still refuse to leak message/stack — only the error class name (or the
	// primitive type for non-Error throwables) is surfaced for ops triage.
	return {
		error: {
			code: "internal_error",
			message: "Internal error",
			...(requestId ? { requestId } : {}),
			retryable: observability.retryable,
			source,
			details: {
				retryable: false,
				category: "internal_error",
				errorClass: error instanceof Error ? error.name : typeof error,
			},
		},
	};
}

// Accepts `unknown` so the branded guards narrow cleanly from the top: the
// subtype error classes are structurally compatible with ProviderError, so
// narrowing from a ProviderError-typed value would collapse the negative branch
// to `never`. Narrowing from unknown avoids that while still recognizing errors
// from a duplicate SDK module instance.
function providerObservabilityDetails(
	error: unknown,
	declaredErrorCode?: OperationErrorCode,
): ErrorObservabilityDetails | undefined {
	const declaredRetryable = sdkOwnsErrorResolution(error)
		? undefined
		: declaredErrorCode?.retryable;
	// Session-expiry surfaces the credential_expired category + the opt-in
	// retryable signal so Gateway/Credential Service can refresh and re-drive the
	// operation (see design.md §4.3 D3). Without this branch the auth error would
	// serialize as a bare 401 with no retryable/category, losing the refresh
	// signal for exactly the retryOnAuthRefresh operations it is meant to enable.
	if (isSessionExpiredError(error)) {
		return {
			category: error.options?.category ?? "credential_expired",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: error.options?.retryable ?? declaredRetryable ?? false,
		};
	}
	// Missing-secret errors carry the canonical credential_unavailable category
	// so Gateway/observability can attribute the failure to provisioning, not
	// the upstream. Matched by code (not constructor) so both the SDK-owned
	// runtime gate and any not-yet-migrated provider-thrown MISSING_SECRET
	// serialize identically, including across duplicate SDK module instances.
	if (isProviderError(error) && error.code === MISSING_SECRET_CODE) {
		return {
			category: error.options?.category ?? "credential_unavailable",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: error.options?.retryable ?? declaredRetryable ?? false,
		};
	}
	if (!isTransportError(error)) {
		return undefined;
	}
	const isProxyPoolCode =
		error.code === PROXY_POOL_EXHAUSTED_CODE ||
		error.code === PROXY_EDGE_AUTH_REJECTED_CODE ||
		error.code === "PROXY_ALLOCATION_FAILED";
	const category =
		error.options?.category ??
		(isProxyPoolCode
			? "proxy_pool"
			: error.code === PROXY_AUTH_IP_DENIED_CODE
				? "anti_bot_blocked"
				: error.code === "transport_timeout"
					? "timeout"
					: error.code === "transport_network_error"
						? "network"
						: error.upstreamStatus
							? categoryForStatus(error.upstreamStatus)
							: "upstream_http");
	return {
		category,
		taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
		retryable:
			error.options?.retryable ??
			(category === "upstream_http" && error.upstreamStatus
				? error.upstreamStatus >= 500
				: isRetryableCategory(category)),
		...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
	};
}

function errorObservabilityDetails(
	error: unknown,
	declaredErrorCode?: OperationErrorCode,
): ErrorObservabilityDetails {
	const effectiveDeclaration = sdkOwnsErrorResolution(error) ? undefined : declaredErrorCode;
	const providerDetails = providerObservabilityDetails(error, effectiveDeclaration);
	if (providerDetails) return providerDetails;

	if (error instanceof z.ZodError || isValidationError(error)) {
		const declaredStatus = effectiveDeclaration?.status;
		return {
			category:
				isProviderError(error) && error.options?.category
					? error.options.category
					: isEmittableErrorStatus(declaredStatus) &&
							categoryForStatus(declaredStatus) === "upstream_rejected"
						? "upstream_rejected"
						: isEmittableErrorStatus(declaredStatus) && declaredStatus >= 500
							? "provider_error"
							: "input_validation",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: isProviderError(error)
				? (error.options?.retryable ?? effectiveDeclaration?.retryable ?? false)
				: false,
		};
	}

	if (error instanceof StatefulRoutingDeadlineError) {
		return {
			category: "timeout",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: false,
		};
	}

	if (isProviderError(error)) {
		// Deterministic upstream refusals default to the rejection category:
		// the UPSTREAM_REJECTED family and any operation-declared rejection
		// status (409/410/422) classify as upstream_rejected unless the
		// author set an explicit category.
		const declaredStatus = effectiveDeclaration?.status;
		const rejectionDefault =
			error.code === "UPSTREAM_REJECTED" ||
			(isEmittableErrorStatus(declaredStatus) &&
				categoryForStatus(declaredStatus) === "upstream_rejected")
				? ("upstream_rejected" as const)
				: ("provider_error" as const);
		return {
			category: error.options?.category ?? rejectionDefault,
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: error.options?.retryable ?? effectiveDeclaration?.retryable ?? false,
		};
	}

	return {
		category: "internal_error",
		taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
		retryable: false,
	};
}

function responseWithErrorObservability(
	response: Response,
	error: unknown,
	declaredErrorCode?: OperationErrorCode,
): Response {
	const headers = new Headers(response.headers);
	headers.set(
		ERROR_OBSERVABILITY_HEADER,
		JSON.stringify(errorObservabilityDetails(error, declaredErrorCode)),
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function publicProviderErrorMessage(error: ProviderError): string {
	if (isTransportError(error)) {
		if (error.code === PROXY_AUTH_IP_DENIED_CODE) {
			return error.message;
		}
		if (error.code === PROXY_EDGE_AUTH_REJECTED_CODE) {
			return error.message;
		}
		if (error.code === PROXY_POOL_EXHAUSTED_CODE) {
			return error.message;
		}
		if (error.code === "transport_timeout") return "Request timed out";
		if (error.code === "transport_network_error") return "Network error";
		if (error.code === "upstream_http_error" && error.status) {
			return `Upstream request failed with status ${error.status}`;
		}
		if (error.status) {
			return `Upstream request failed with status ${error.status}`;
		}
		return "Upstream request failed";
	}
	return error.message;
}

function isEmittableErrorStatus(value: unknown): value is ProviderErrorStatus {
	return (
		typeof value === "number" && VALID_OPERATION_ERROR_STATUSES.some((status) => status === value)
	);
}

function toStatusCode(error: unknown, declaredErrorCode?: OperationErrorCode): ProviderErrorStatus {
	if (error instanceof z.ZodError) {
		return 400;
	}
	if (error instanceof StatefulRoutingDeadlineError) {
		return 504;
	}
	if (isProviderError(error)) {
		if (!sdkOwnsErrorResolution(error) && isEmittableErrorStatus(declaredErrorCode?.status)) {
			return declaredErrorCode.status;
		}
		// Canonical SDK code → status mapping lives in error-resolution.ts so
		// the authoring lint and this runtime path share one source of truth.
		if (typeof error.code === "string") {
			const mappedStatus = SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get(error.code);
			if (mappedStatus !== undefined) {
				return mappedStatus;
			}
		}
		if (isTransportError(error)) {
			return error.code === "transport_timeout" ? 504 : 502;
		}
		if (isValidationError(error)) {
			return error.options?.category === "output_validation" ? 500 : 400;
		}

		return 500;
	}

	return 500;
}

function sdkOwnsErrorResolution(error: unknown): boolean {
	if (isSessionExpiredError(error)) return true;
	if (isTransportError(error)) return true;
	if (error instanceof z.ZodError) return true;
	if (error instanceof StatefulRoutingDeadlineError) return true;
	return (
		isProviderError(error) &&
		typeof error.code === "string" &&
		SDK_RUNTIME_OWNED_ERROR_CODES.has(error.code)
	);
}

type OperationErrorCodeLookup = ReadonlyMap<string, ReadonlyMap<string, OperationErrorCode>>;

function buildOperationErrorCodeLookup(provider: ProviderDefinition): OperationErrorCodeLookup {
	return new Map(
		Object.entries(provider.operations).flatMap(([operationId, operation]) => {
			const errorCodes = operation.docs?.errorCodes;
			return errorCodes?.length
				? [[operationId, new Map(errorCodes.map((entry) => [entry.code, entry]))] as const]
				: [];
		}),
	);
}

function declaredErrorCodeFor(
	error: unknown,
	operationId: string | undefined,
	lookup: OperationErrorCodeLookup,
): OperationErrorCode | undefined {
	if (!operationId || !isProviderError(error) || typeof error.code !== "string") return undefined;
	return lookup.get(operationId)?.get(error.code);
}

function extractRequestId(raw: unknown): string | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const value = Object.getOwnPropertyDescriptor(raw, "requestId")?.value;
	return typeof value === "string" ? value : undefined;
}

type ProviderErrorCauseFrame = {
	errorClass: string;
	code?: string;
	messageLength: number;
	messageFingerprint: string;
};

const MAX_PROVIDER_ERROR_CAUSE_FRAMES = 5;

function providerErrorCauseChain(error: unknown): ProviderErrorCauseFrame[] | undefined {
	if (!(error instanceof Error) && !isProviderError(error)) return undefined;

	const seen = new Set<object>([error]);
	const frames: ProviderErrorCauseFrame[] = [];
	let cause = error.cause;

	while (
		frames.length < MAX_PROVIDER_ERROR_CAUSE_FRAMES &&
		(cause instanceof Error || isProviderError(cause)) &&
		!seen.has(cause)
	) {
		seen.add(cause);
		const message = cause.message;
		frames.push({
			errorClass: cause.name,
			...(isProviderError(cause) && typeof cause.code === "string" ? { code: cause.code } : {}),
			messageLength: message.length,
			messageFingerprint: createHash("sha256").update(message).digest("hex").slice(0, 12),
		});
		cause = cause.cause;
	}

	return frames.length > 0 ? frames : undefined;
}

function logProviderError(
	logger: ProviderServerLogger | unknown,
	provider: ProviderDefinition,
	kind: "operation" | "auth",
	route: string,
	requestId: string | undefined,
	error: unknown,
	status: number,
	cost: ProviderRequestCost,
	declaredErrorCode?: OperationErrorCode,
	proxyTelemetry?: ProxyTelemetryCollector,
): void {
	const code = isProviderError(error)
		? (error.code ?? "provider_error")
		: error instanceof z.ZodError
			? "invalid_request"
			: error instanceof StatefulRoutingDeadlineError
				? "STATEFUL_FORWARDING_DEADLINE_EXPIRED"
				: "internal_error";
	const errorClass = error instanceof Error ? error.name : typeof error;
	const message = error instanceof Error ? error.message : String(error);
	const causeChain = providerErrorCauseChain(error);
	const details = errorObservabilityDetails(error, declaredErrorCode);
	const isUnregisteredProviderErrorCode =
		status === 500 &&
		isProviderError(error) &&
		!isValidationError(error) &&
		typeof error.code === "string" &&
		!SDK_OWNED_PROVIDER_ERROR_CODES.has(error.code) &&
		declaredErrorCode === undefined;
	const proxy = proxyTelemetry?.toLogPayload();
	const emit = typeof logger === "function" ? logger : defaultProviderServerLogger;
	emit({
		level: status >= 500 ? "error" : "warn",
		event: "provider_request_failed",
		providerId: provider.id,
		kind,
		route,
		...(requestId ? { requestId } : {}),
		status,
		...cost,
		...(proxy ? { proxy } : {}),
		code,
		errorClass,
		message,
		...(causeChain ? { causeChain } : {}),
		...(details.upstreamStatus ? { upstreamStatus: details.upstreamStatus } : {}),
		errorCategory: details.category,
		taxonomyVersion: details.taxonomyVersion,
		retryable: details.retryable,
		...(isUnregisteredProviderErrorCode
			? {
					signal: "unregistered_provider_error_code" as const,
					signalFix:
						"Declare this code (with status and retryable) in the operation's docs.errorCodes so it serves its intended status instead of 500.",
				}
			: {}),
		...(error instanceof z.ZodError ? { issues: zodDetails(error) } : {}),
	});
}

function logProviderCleanupError(
	logger: ProviderServerLogger | unknown,
	provider: ProviderDefinition,
	kind: "operation" | "auth",
	operationId: string,
	requestId: string | undefined,
	resource: "browser" | "stealth",
	error: unknown,
): void {
	const emit = typeof logger === "function" ? logger : defaultProviderServerLogger;
	const errorClass = error instanceof Error ? error.name : typeof error;
	const message = error instanceof Error ? error.message : String(error);
	emit({
		level: "warn",
		event: "provider_cleanup_failed",
		providerId: provider.id,
		kind,
		route: operationId,
		...(requestId ? { requestId } : {}),
		resource,
		errorClass,
		message,
	});
}

function logProviderSuccess(
	logger: ProviderServerLogger | unknown,
	provider: ProviderDefinition,
	kind: "operation" | "auth",
	route: string,
	requestId: string | undefined,
	status: number,
	cost: ProviderRequestCost,
	proxyTelemetry?: ProxyTelemetryCollector,
): void {
	const proxy = proxyTelemetry?.toLogPayload();
	const emit = typeof logger === "function" ? logger : defaultProviderServerLogger;
	emit({
		level: "info",
		event: "provider_request_completed",
		providerId: provider.id,
		kind,
		route,
		...(requestId ? { requestId } : {}),
		status,
		...cost,
		...(proxy ? { proxy } : {}),
	});
}

function toJsonSuccessResponse(
	result: unknown,
	ctx?: ProviderContext,
): Response | OperationSuccessResponse {
	if (result instanceof Response) {
		return result;
	}

	if (result instanceof ReadableStream) {
		return new Response(result);
	}

	const cacheMeta = ctx?.cache.responseMeta();
	const retryMeta = ctx ? retryResponseMeta.get(ctx) : undefined;
	const meta =
		cacheMeta || retryMeta
			? {
					...(cacheMeta
						? {
								cached: cacheMeta.hit,
								stale: cacheMeta.stale,
								cache: cacheMeta,
							}
						: {}),
					...(retryMeta ? { retry: retryMeta } : {}),
				}
			: undefined;
	return {
		data: result,
		...(meta ? { meta } : {}),
	};
}

function isAsyncIterable<T = unknown>(value: unknown): value is AsyncIterable<T> {
	if (!value || typeof value !== "object") return false;
	const iterator = Reflect.get(value, Symbol.asyncIterator);
	return typeof iterator === "function";
}

function responseWithCleanup(response: Response, cleanup: RequestCleanup): Response {
	if (!response.body) {
		void cleanup();
		return response;
	}
	const reader = response.body.getReader();
	let cleaned = false;
	const runCleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		await cleanup();
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					await runCleanup();
					return;
				}
				if (value) controller.enqueue(value);
			} catch (error) {
				await runCleanup();
				controller.error(error);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				await runCleanup();
			}
		},
	});
	return new Response(body, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
}

async function validateSseEvent(
	operation: OperationDefinition,
	event: ProviderStreamEvent,
): Promise<ProviderStreamEvent> {
	const transport = getSseTransport(operation);
	const schema = transport?.events?.[event.event];
	if (!schema) {
		if (event.event === APIFUSE_STREAM_ERROR_EVENT || event.event === APIFUSE_STREAM_DONE_EVENT) {
			return event;
		}
		throw new ProviderError(
			`SSE event "${event.event}" is not declared in operation transport.events.`,
			{
				code: "SSE_EVENT_UNDECLARED",
				category: "output_validation",
				retryable: false,
				fix: `Add "${event.event}" to transport.events or stop emitting that event.`,
			},
		);
	}
	const data = await parseSchema(schema, event.data, `transport.events.${event.event}`);
	return { ...event, data };
}

function byteLength(value: Uint8Array | string): number {
	if (typeof value === "string") {
		return new TextEncoder().encode(value).byteLength;
	}
	return value.byteLength;
}

function assertStreamPayloadWithinLimit(
	actualBytes: number,
	maxBytes: number | undefined,
	kind: "event" | "chunk",
): void {
	if (maxBytes === undefined || actualBytes <= maxBytes) return;
	throw new ProviderError(
		`Stream ${kind} exceeded declared byte limit (${actualBytes} > ${maxBytes}).`,
		{
			code: kind === "event" ? "STREAM_EVENT_TOO_LARGE" : "STREAM_CHUNK_TOO_LARGE",
			retryable: false,
			category: "input_validation",
			fix:
				kind === "event"
					? "Emit smaller SSE events or increase transport.maxEventBytes."
					: "Emit smaller stream chunks or increase transport.maxChunkBytes.",
		},
	);
}

function toSseResponse(
	operation: OperationDefinition,
	result: AsyncIterable<ProviderStreamEvent>,
	cleanup: RequestCleanup,
	requestId?: string,
): Response {
	const encoder = new TextEncoder();
	const iterator = result[Symbol.asyncIterator]();
	const transport = getSseTransport(operation);
	let done = false;
	let cleaned = false;
	const runCleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		await cleanup();
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (done) {
					controller.close();
					await runCleanup();
					return;
				}
				const next = await iterator.next();
				if (next.done) {
					done = true;
					controller.close();
					await runCleanup();
					return;
				}
				const validated = await validateSseEvent(operation, next.value);
				const encodedEvent = encodeSseEvent(validated);
				const encodedBytes = encoder.encode(encodedEvent);
				assertStreamPayloadWithinLimit(encodedBytes.byteLength, transport?.maxEventBytes, "event");
				controller.enqueue(encodedBytes);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Stream failed";
				controller.enqueue(
					encoder.encode(
						encodeSseEvent(
							streamError("stream_error", message, {
								...(requestId ? { requestId } : {}),
							}),
						),
					),
				);
				controller.close();
				done = true;
				await runCleanup();
			}
		},
		async cancel(reason) {
			try {
				await iterator.return?.(reason);
			} finally {
				await runCleanup();
			}
		},
	});
	return new Response(body, {
		headers: {
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"Content-Type": "text/event-stream; charset=utf-8",
		},
	});
}

function enforceStreamChunkLimit(
	body: ReadableStream<Uint8Array>,
	maxChunkBytes: number | undefined,
): ReadableStream<Uint8Array> {
	if (maxChunkBytes === undefined) return body;
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					return;
				}
				if (value) {
					assertStreamPayloadWithinLimit(byteLength(value), maxChunkBytes, "chunk");
					controller.enqueue(value);
				}
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

function toStreamingResponse(
	operation: OperationDefinition,
	result: unknown,
	cleanup: RequestCleanup,
	requestId?: string,
): Response {
	const transport = operation.transport?.kind ?? "json";
	if (transport === "sse" && (result instanceof Response || result instanceof ReadableStream)) {
		void cleanup();
		throw new ProviderError(
			"SSE operations must return an AsyncIterable of typed stream.event(...) values.",
			{
				code: "SSE_RESULT_UNSUPPORTED",
				category: "output_validation",
				retryable: false,
				fix: "Return an async generator that yields stream.event(name, data) so APIFuse can validate event schemas and enforce event byte limits.",
			},
		);
	}
	if (result instanceof Response) {
		const httpTransport = getHttpStreamTransport(operation);
		if (httpTransport && result.body && httpTransport?.maxChunkBytes !== undefined) {
			return responseWithCleanup(
				new Response(enforceStreamChunkLimit(result.body, httpTransport.maxChunkBytes), {
					headers: result.headers,
					status: result.status,
					statusText: result.statusText,
				}),
				cleanup,
			);
		}
		return responseWithCleanup(result, cleanup);
	}
	if (result instanceof ReadableStream) {
		const httpTransport = getHttpStreamTransport(operation);
		const stream =
			httpTransport !== undefined
				? enforceStreamChunkLimit(result, httpTransport.maxChunkBytes)
				: result;
		return responseWithCleanup(
			new Response(stream, {
				headers:
					transport === "sse"
						? { "Content-Type": "text/event-stream; charset=utf-8" }
						: {
								"Content-Type":
									operation.transport?.kind === "http-stream"
										? (operation.transport.contentType ?? "application/octet-stream")
										: "application/octet-stream",
							},
			}),
			cleanup,
		);
	}
	if (transport === "sse" && isAsyncIterable<ProviderStreamEvent>(result)) {
		return toSseResponse(operation, result, cleanup, requestId);
	}
	void cleanup();
	throw new ProviderError(
		`Streaming operation returned unsupported result for transport "${transport}"`,
		{
			code: "STREAM_RESULT_UNSUPPORTED",
			fix: "Return an AsyncIterable of stream.event(...) values, a ReadableStream, or a Response from streaming operations.",
		},
	);
}

function getSseTransport(operation: OperationDefinition): OperationSseTransport | undefined {
	return operation.transport?.kind === "sse" ? operation.transport : undefined;
}

function getHttpStreamTransport(
	operation: OperationDefinition,
): OperationHttpStreamTransport | undefined {
	return operation.transport?.kind === "http-stream" ? operation.transport : undefined;
}

function toAuthFlowResponse(
	result: unknown,
	contextPatch: Record<string, unknown | null> | undefined,
): Response | AuthFlowSuccessResponse {
	if (result instanceof Response) {
		return result;
	}

	if (result instanceof ReadableStream) {
		return new Response(result);
	}

	return {
		data: result,
		...(contextPatch ? { contextPatch } : {}),
	};
}

function authFlowLocaleFromHeaders(headers?: Record<string, string>): ProviderLocale {
	const header = Object.entries(headers ?? {}).find(
		([key]) => key.toLowerCase() === "accept-language",
	)?.[1];
	for (const token of (header ?? "").split(",")) {
		const language = token.trim().split(";")[0]?.split("-")[0]?.toLowerCase();
		if (isAuthFlowLocale(language)) {
			return language;
		}
	}
	return "en";
}

function isAuthFlowLocale(value: string | undefined): value is ProviderLocale {
	return value === "en" || value === "ko" || value === "ja";
}

function isAuthTurn(value: unknown): value is AuthTurn {
	return !!value && typeof value === "object" && "kind" in value && "turnId" in value;
}

function loadAuthFlowLocaleCatalogs(
	provider: ProviderDefinition,
): ProviderLocaleCatalogMap | undefined {
	for (const providerDir of [
		process.cwd(),
		join(process.cwd(), "providers", provider.id),
		join(process.cwd(), "providers-staging", provider.id),
	]) {
		if (!existsSync(join(providerDir, "locales", "en.json"))) continue;
		try {
			return loadProviderLocaleCatalogs({
				providerDir,
				locales: AUTH_FLOW_LOCALES,
			});
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function materializeAuthFlowTurn(
	provider: ProviderDefinition,
	request: AuthFlowRequest,
	turn: AuthTurn,
): AuthTurn {
	const catalogs = loadAuthFlowLocaleCatalogs(provider);
	if (!catalogs) return turn;
	return localizeAuthTurn(turn, {
		catalogs,
		locale: authFlowLocaleFromHeaders(request.headers),
	});
}

function withAuthRequestHeaders(request: AuthFlowRequest, headers: Headers): AuthFlowRequest {
	return {
		...request,
		headers: {
			...(request.headers ?? {}),
			...Object.fromEntries(headers.entries()),
		},
	};
}

async function handleOperation(
	provider: ProviderDefinition,
	request: OperationRequest,
	operationId: string,
	options: ProviderServerRuntimeOptions,
	state: ProviderRuntimeState = createUnsupportedProviderRuntimeState(),
	proxyTelemetry?: ProxyTelemetryCollector,
	signal?: AbortSignal,
): Promise<Response | OperationResponse> {
	const ctx = createProviderContext(
		provider,
		request,
		operationId,
		options,
		state,
		proxyTelemetry,
		signal,
	);
	const operation = provider.operations[operationId];
	const streaming = operation?.transport?.kind && operation.transport.kind !== "json";
	let cleanupCalled = false;
	const cleanup = async () => {
		if (cleanupCalled) return;
		cleanupCalled = true;
		try {
			ctx.stealth.close?.();
		} catch (error) {
			logProviderCleanupError(
				options.logger,
				provider,
				"operation",
				operationId,
				request.requestId,
				"stealth",
				error,
			);
		}
		try {
			await ctx.browser.close?.();
		} catch (error) {
			logProviderCleanupError(
				options.logger,
				provider,
				"operation",
				operationId,
				request.requestId,
				"browser",
				error,
			);
		}
	};
	try {
		const result = options.operationExecutor
			? await options.operationExecutor({
					provider,
					operationId,
					ctx,
					request,
					signal,
				})
			: await executeOperation(provider, operationId, ctx, request.input);
		if (streaming && operation) {
			return toStreamingResponse(operation, result, cleanup, request.requestId);
		}
		return toJsonSuccessResponse(result, ctx);
	} catch (error) {
		await cleanup();
		throw error;
	} finally {
		if (!streaming) await cleanup();
	}
}

function responseWithProviderTelemetry(
	response: Response,
	proxyTelemetry?: ProxyTelemetryCollector,
): Response {
	const headerValue = proxyTelemetry?.toHeaderValue();
	const headers = new Headers(response.headers);
	headers.delete(PROVIDER_TELEMETRY_HEADER);
	if (headerValue) headers.set(PROVIDER_TELEMETRY_HEADER, headerValue);
	return new Response(response.body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}

type AuthRoute = "start" | "continue" | "poll" | "abort" | "refresh";

async function handleAuthFlow(
	provider: ProviderDefinition,
	request: AuthFlowRequest,
	route: AuthRoute,
	options: ProviderServerRuntimeOptions,
	state: ProviderRuntimeState,
	proxyTelemetry?: ProxyTelemetryCollector,
	signal?: AbortSignal,
): Promise<Response | AuthFlowResponse> {
	const flow = provider.auth?.flow;
	if (!flow) {
		throw new ProviderError("Auth flow is not configured", {
			code: "AUTH_FLOW_NOT_CONFIGURED",
		});
	}

	// Same SDK-owned gate as executeOperation: OAuth/credentials ceremonies
	// depend on declared secrets (client ids/secrets), so fail structured before
	// any flow code runs instead of at whatever point the ceremony first reads
	// the env. `abort` stays exempt: a user must always be able to cancel a
	// stranded flow even when provisioning is broken.
	const { context, getPatch } = createAuthFlowContext(
		provider,
		request,
		options,
		state,
		proxyTelemetry,
		signal,
	);
	try {
		if (route !== "abort") {
			assertRequiredSecretsPresent(provider, context.env);
		}
		const result =
			route === "start"
				? await flow.start(context)
				: route === "continue"
					? await flow.continue(context, request.input ?? {})
					: route === "poll"
						? flow.poll
							? await flow.poll(context)
							: null
						: route === "abort"
							? flow.abort
								? await flow.abort(context)
								: null
							: flow.refresh
								? await flow.refresh(context, request.input ?? {})
								: null;

		if (route === "refresh" && !flow.refresh) {
			throw new AuthError("Provider auth flow does not support refresh.", {
				code: "refresh_not_supported",
			});
		}

		const materializedResult =
			result &&
			!(result instanceof Response) &&
			!(result instanceof ReadableStream) &&
			isAuthTurn(result)
				? materializeAuthFlowTurn(provider, request, result)
				: result;
		return toAuthFlowResponse(materializedResult, getPatch());
	} catch (error) {
		if (error instanceof AuthAbortError) {
			return toAuthFlowResponse(error.turn, getPatch());
		}
		throw error;
	} finally {
		try {
			context.stealth.close?.();
		} catch (error) {
			logProviderCleanupError(
				options.logger,
				provider,
				"auth",
				route,
				request.requestId,
				"stealth",
				error,
			);
		}
	}
}

class StatefulForwardingReplayCache {
	readonly #nonces = new Map<string, number>();
	readonly #expiryBuckets = new Map<number, Set<string>>();
	#nextExpiryBucket?: number;
	#latestExpiryBucket?: number;

	constructor(private readonly maxEntries: number) {}

	claim(nonce: string, expiresAtMs: number, nowMs: number): "accepted" | "replayed" | "full" {
		this.dropExpiredBuckets(nowMs);
		if (this.#nonces.has(nonce)) return "replayed";
		if (this.#nonces.size >= this.maxEntries) return "full";
		const expiryBucket =
			Math.ceil(expiresAtMs / STATEFUL_FORWARDING_REPLAY_BUCKET_MS) *
			STATEFUL_FORWARDING_REPLAY_BUCKET_MS;
		this.#nonces.set(nonce, expiryBucket);
		const bucket = this.#expiryBuckets.get(expiryBucket) ?? new Set<string>();
		bucket.add(nonce);
		this.#expiryBuckets.set(expiryBucket, bucket);
		this.#nextExpiryBucket = Math.min(this.#nextExpiryBucket ?? expiryBucket, expiryBucket);
		this.#latestExpiryBucket = Math.max(this.#latestExpiryBucket ?? expiryBucket, expiryBucket);
		return "accepted";
	}

	private dropExpiredBuckets(nowMs: number): void {
		if (this.#nextExpiryBucket === undefined || this.#latestExpiryBucket === undefined) return;
		if (nowMs >= this.#latestExpiryBucket) {
			this.#nonces.clear();
			this.#expiryBuckets.clear();
			this.#nextExpiryBucket = undefined;
			this.#latestExpiryBucket = undefined;
			return;
		}
		while (this.#nextExpiryBucket <= nowMs) {
			const bucket = this.#expiryBuckets.get(this.#nextExpiryBucket);
			if (bucket) {
				for (const cachedNonce of bucket) this.#nonces.delete(cachedNonce);
				this.#expiryBuckets.delete(this.#nextExpiryBucket);
			}
			this.#nextExpiryBucket += STATEFUL_FORWARDING_REPLAY_BUCKET_MS;
		}
	}
}

function verifyStatefulForwardingRequest(input: {
	readonly options: ProviderServerOptions;
	readonly rawBody: string;
	readonly headers: Headers;
	readonly method: string;
	readonly path: string;
	readonly replayCache: StatefulForwardingReplayCache;
}): void {
	const config = input.options.statefulForwarding;
	if (!config?.secret) {
		throw new ProviderError("Stateful forwarding is not configured.", {
			code: "STATEFUL_FORWARDING_NOT_CONFIGURED",
		});
	}
	const timestamp = input.headers.get(STATEFUL_FORWARDING_TIMESTAMP_HEADER) ?? "";
	const signature = input.headers.get(STATEFUL_FORWARDING_SIGNATURE_HEADER) ?? "";
	const nonce = input.headers.get(STATEFUL_FORWARDING_NONCE_HEADER) ?? "";
	if (!timestamp || !signature || !nonce) {
		throw new ProviderError("Stateful forwarding signature headers are missing.", {
			code: "STATEFUL_FORWARDING_SIGNATURE_MISSING",
		});
	}
	if (nonce.length > 256) {
		throw new ProviderError("Stateful forwarding nonce is invalid.", {
			code: "STATEFUL_FORWARDING_NONCE_INVALID",
		});
	}
	const timestampMs = Date.parse(timestamp);
	const maxSkewMs = config.maxSkewMs ?? DEFAULT_STATEFUL_FORWARDING_MAX_SKEW_MS;
	if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > maxSkewMs) {
		throw new ProviderError(
			"Stateful forwarding signature timestamp is outside the allowed skew.",
			{ code: "STATEFUL_FORWARDING_TIMESTAMP_INVALID" },
		);
	}
	if (
		!verifyStatefulRequestSignature({
			secret: config.secret,
			timestamp,
			rawBody: input.rawBody,
			method: input.method,
			path: input.path,
			nonce,
			signature,
		})
	) {
		throw new ProviderError("Stateful forwarding signature is invalid.", {
			code: "STATEFUL_FORWARDING_SIGNATURE_INVALID",
		});
	}
	const replayResult = input.replayCache.claim(nonce, timestampMs + maxSkewMs, Date.now());
	if (replayResult === "replayed") {
		throw new ProviderError("Stateful forwarding nonce has already been used.", {
			code: "STATEFUL_FORWARDING_REPLAY_DETECTED",
		});
	}
	if (replayResult === "full") {
		throw new ProviderError("Stateful forwarding replay cache is at capacity.", {
			code: "STATEFUL_FORWARDING_REPLAY_CACHE_FULL",
		});
	}
}

function operationRequestFromForwardingEnvelope(
	envelope: ProviderServerStatefulForwardEnvelope,
): OperationRequest & { readonly deadlineAt?: string } {
	return {
		...envelope.operationRequest,
		...(envelope.deadlineAt !== undefined ? { deadlineAt: envelope.deadlineAt } : {}),
	};
}

function parseStatefulForwardingEnvelope(rawBody: unknown): ProviderServerStatefulForwardEnvelope {
	const parsed = ProviderServerStatefulForwardEnvelopeSchema.safeParse(rawBody);
	if (parsed.success) return parsed.data;
	throw new ProviderError("Stateful forwarding envelope is invalid.", {
		code: "STATEFUL_FORWARDING_ENVELOPE_INVALID",
		details: zodDetails(parsed.error),
	});
}

/**
 * Primary, cross-runtime app factory. Declared capability ESM is preloaded
 * asynchronously, so this path works on Bun and every supported Node release.
 */
export async function createServerAppAsync(
	provider: ProviderDefinition,
	options: ProviderServerOptions = {},
): Promise<Hono> {
	validateFailClosedDeclaration(provider);
	validateStatefulServerConfig(options);
	return createServerAppWithCapabilityModules(
		provider,
		options,
		await loadProviderCapabilityModules(provider),
	);
}

/**
 * Synchronous compatibility factory. Standard providers remain synchronous on
 * every runtime because they load no capability modules. Providers declaring a
 * capability require Bun or Node >=22.12; older Node releases receive an
 * actionable error directing them to createServerAppAsync().
 */
export function createServerApp(
	provider: ProviderDefinition,
	options: ProviderServerOptions = {},
): Hono {
	validateFailClosedDeclaration(provider);
	validateStatefulServerConfig(options);
	return createServerAppWithCapabilityModules(
		provider,
		options,
		loadProviderCapabilityModulesSync(provider),
	);
}

function createServerAppWithCapabilityModules(
	provider: ProviderDefinition,
	serverOptions: ProviderServerOptions,
	capabilityModules: ProviderCapabilityModules,
): Hono {
	const options: ProviderServerRuntimeOptions = { ...serverOptions, capabilityModules };
	const app = new Hono();
	const logger = options.logger ?? defaultProviderServerLogger;
	const operationErrorCodes = buildOperationErrorCodeLookup(provider);
	const statefulForwardingReplayCache = new StatefulForwardingReplayCache(
		options.statefulForwarding?.replayCacheMaxEntries ??
			DEFAULT_STATEFUL_FORWARDING_REPLAY_CACHE_MAX_ENTRIES,
	);
	const state =
		options.state ??
		createProviderRuntimeStateFromEnv({
			providerId: provider.id,
			allowMemoryFallback: options.allowMemoryStateFallback === true,
		});

	// Boot-time visibility for unprovisioned declared secrets: emit a structured
	// warn so deploy tooling/alerting sees the gap the moment the pod boots,
	// instead of discovering it request-by-request. Deliberately log-only — a
	// boot crash would trade a structured MISSING_SECRET signal for
	// CrashLoopBackOff. Requests still fail closed via the executeOperation gate.
	const missingSecretsAtBoot = listMissingRequiredSecrets(
		provider,
		createEnvContext(provider.secrets?.map((secret) => secret.name)),
	);
	if (missingSecretsAtBoot.length > 0) {
		logger({
			level: "warn",
			event: "provider_secrets_missing",
			providerId: provider.id,
			missingSecrets: missingSecretsAtBoot,
		});
	}

	app.notFound((c) => {
		const error = new ProviderError("Not found", { code: "not_found", retryable: false });
		return responseWithErrorObservability(c.json(toErrorResponse(error), 404), error);
	});

	app.get("/health", (c) =>
		c.json({
			status: "ok",
			provider: provider.id,
			version: provider.version,
		}),
	);

	app.post(STATEFUL_INTERNAL_OPERATIONS_ROUTE, async (c) => {
		let rawBodyText = "";
		let rawBody: unknown;
		let operationId: string | undefined;
		const operation = "stateful-internal";
		const requestCost = startRequestCost();
		try {
			if (!options.internalOperationExecutor) {
				throw new ProviderError("Stateful internal operation executor is not configured.", {
					code: "STATEFUL_INTERNAL_EXECUTOR_NOT_CONFIGURED",
				});
			}
			rawBodyText = await c.req.raw.clone().text();
			verifyStatefulForwardingRequest({
				options,
				rawBody: rawBodyText,
				headers: c.req.raw.headers,
				method: c.req.raw.method,
				path: STATEFUL_INTERNAL_OPERATIONS_ROUTE,
				replayCache: statefulForwardingReplayCache,
			});
			try {
				rawBody = JSON.parse(rawBodyText);
			} catch {
				throw new ProviderError("Stateful forwarding envelope is not valid JSON.", {
					code: "STATEFUL_FORWARDING_ENVELOPE_INVALID",
				});
			}
			const envelope = parseStatefulForwardingEnvelope(rawBody);
			if (envelope.providerId !== provider.id) {
				throw new ProviderError(
					"Stateful forwarding envelope providerId does not match the served provider.",
					{ code: "STATEFUL_FORWARDING_PROVIDER_MISMATCH" },
				);
			}
			if (envelope.requestId !== envelope.operationRequest.requestId) {
				throw new ProviderError("Stateful forwarding requestId values do not match.", {
					code: "STATEFUL_FORWARDING_ENVELOPE_INVALID",
				});
			}
			if (
				envelope.sourcePodId !==
				(c.req.raw.headers.get(STATEFUL_FORWARDING_SOURCE_POD_HEADER) ?? "")
			) {
				throw new ProviderError("Stateful forwarding source pod does not match its header.", {
					code: "STATEFUL_FORWARDING_SOURCE_POD_MISMATCH",
				});
			}
			if (
				envelope.forwardedAt !== (c.req.raw.headers.get(STATEFUL_FORWARDING_TIMESTAMP_HEADER) ?? "")
			) {
				throw new ProviderError(
					"Stateful forwarding forwardedAt does not match its signature timestamp.",
					{ code: "STATEFUL_FORWARDING_ENVELOPE_INVALID" },
				);
			}
			const deadlineAtMs = envelope.deadlineAt ? Date.parse(envelope.deadlineAt) : undefined;
			if (deadlineAtMs !== undefined && deadlineAtMs <= Date.now()) {
				throw new StatefulRoutingDeadlineError(envelope.requestId, envelope.deadlineAt as string);
			}
			const remainingDeadlineMs =
				deadlineAtMs === undefined ? undefined : deadlineAtMs - Date.now();
			const deadlineSignal =
				remainingDeadlineMs === undefined ? undefined : AbortSignal.timeout(remainingDeadlineMs);
			const signal = deadlineSignal
				? AbortSignal.any([c.req.raw.signal, deadlineSignal])
				: c.req.raw.signal;
			const ownerFenceValidation = Promise.resolve(
				options.statefulForwarding?.validateOwnerFence(
					{
						providerId: envelope.providerId,
						sessionKey: envelope.sessionKey,
						ownerPodId: envelope.ownerPodId,
						generation: envelope.generation,
						sourcePodId: envelope.sourcePodId,
						forwardedAt: envelope.forwardedAt,
						requestId: envelope.requestId,
						...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
					},
					signal,
				),
			);
			let ownerFenceValid: boolean | undefined;
			try {
				ownerFenceValid = deadlineSignal
					? await Promise.race([
							ownerFenceValidation,
							new Promise<never>((_resolve, reject) => {
								deadlineSignal.addEventListener(
									"abort",
									() =>
										reject(
											new StatefulRoutingDeadlineError(
												envelope.requestId,
												envelope.deadlineAt as string,
											),
										),
									{ once: true },
								);
							}),
						])
					: await ownerFenceValidation;
			} catch (error) {
				if (deadlineSignal?.aborted) {
					throw new StatefulRoutingDeadlineError(envelope.requestId, envelope.deadlineAt as string);
				}
				throw error;
			}
			if (ownerFenceValid !== true) {
				throw new ProviderError("Stateful forwarding owner fence is no longer current.", {
					code: "STATEFUL_FORWARDING_OWNER_FENCE_INVALID",
				});
			}
			const request = operationRequestFromForwardingEnvelope(envelope);
			operationId = envelope.operationId;
			const ctx = createProviderContext(
				provider,
				request,
				operationId,
				options,
				state,
				undefined,
				signal,
			);
			if (deadlineAtMs !== undefined && deadlineAtMs <= Date.now()) {
				throw new StatefulRoutingDeadlineError(envelope.requestId, envelope.deadlineAt as string);
			}
			const output = await options.internalOperationExecutor({
				provider,
				operationId,
				ctx,
				request,
				internalStatefulForward: envelope,
				signal,
			});
			logProviderSuccess(
				logger,
				provider,
				"operation",
				operationId || operation,
				request.requestId,
				200,
				finishRequestCost(requestCost),
			);
			return c.json({ data: output });
		} catch (error) {
			const declaredErrorCode = declaredErrorCodeFor(error, operationId, operationErrorCodes);
			const status = toStatusCode(error, declaredErrorCode);
			if (isProviderError(error) && error.code === "STATEFUL_FORWARDING_REPLAY_CACHE_FULL") {
				c.header("Retry-After", String(STATEFUL_FORWARDING_REPLAY_RETRY_AFTER_SECONDS));
			}
			const requestId = extractRequestId(rawBody);
			logProviderError(
				logger,
				provider,
				"operation",
				operationId || operation,
				requestId,
				error,
				status,
				finishRequestCost(requestCost),
				declaredErrorCode,
			);
			return responseWithErrorObservability(
				c.json(toErrorResponse(error, requestId, declaredErrorCode), status),
				error,
				declaredErrorCode,
			);
		}
	});

	app.post("/v1/:operation", async (c) => {
		let rawBody: unknown;
		const operation = c.req.param("operation");
		const proxyTelemetry = new ProxyTelemetryCollector();
		const requestCost = startRequestCost();
		try {
			rawBody = await c.req.raw
				.clone()
				.json()
				.catch(() => undefined);
			const body = OperationRequestSchema.parse(rawBody);
			const requestHeaders = Object.fromEntries(c.req.raw.headers.entries());
			body.headers = { ...requestHeaders, ...body.headers };
			const response = await handleOperation(
				provider,
				body,
				operation,
				options,
				state,
				proxyTelemetry,
				c.req.raw.signal,
			);
			if (response instanceof Response) {
				logProviderSuccess(
					logger,
					provider,
					"operation",
					operation,
					body.requestId,
					response.status,
					finishRequestCost(requestCost),
					proxyTelemetry,
				);
				return responseWithProviderTelemetry(response, proxyTelemetry);
			}
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			logProviderSuccess(
				logger,
				provider,
				"operation",
				operation,
				body.requestId,
				200,
				finishRequestCost(requestCost),
				proxyTelemetry,
			);
			return c.json(response);
		} catch (error) {
			const declaredErrorCode = declaredErrorCodeFor(error, operation, operationErrorCodes);
			const status = toStatusCode(error, declaredErrorCode);
			const requestId = extractRequestId(rawBody);
			logProviderError(
				logger,
				provider,
				"operation",
				operation,
				requestId,
				error,
				status,
				finishRequestCost(requestCost),
				declaredErrorCode,
				proxyTelemetry,
			);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return responseWithErrorObservability(
				c.json(toErrorResponse(error, requestId, declaredErrorCode), status),
				error,
				declaredErrorCode,
			);
		}
	});

	app.post("/auth/start", async (c) => {
		let rawBody: unknown;
		const proxyTelemetry = new ProxyTelemetryCollector();
		const requestCost = startRequestCost();
		try {
			rawBody = await c.req.raw
				.clone()
				.json()
				.catch(() => undefined);
			const body = withAuthRequestHeaders(AuthFlowRequestSchema.parse(rawBody), c.req.raw.headers);
			const response = await handleAuthFlow(
				provider,
				body,
				"start",
				options,
				state,
				proxyTelemetry,
				c.req.raw.signal,
			);
			logProviderSuccess(
				logger,
				provider,
				"auth",
				"start",
				body.requestId,
				response instanceof Response ? response.status : 200,
				finishRequestCost(requestCost),
				proxyTelemetry,
			);
			if (response instanceof Response)
				return responseWithProviderTelemetry(response, proxyTelemetry);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return c.json(response);
		} catch (error) {
			const status = toStatusCode(error);
			const requestId = extractRequestId(rawBody);
			logProviderError(
				logger,
				provider,
				"auth",
				"start",
				requestId,
				error,
				status,
				finishRequestCost(requestCost),
				undefined,
				proxyTelemetry,
			);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return responseWithErrorObservability(
				c.json(toErrorResponse(error, requestId), status),
				error,
			);
		}
	});

	app.post("/auth/continue", async (c) => {
		let rawBody: unknown;
		const proxyTelemetry = new ProxyTelemetryCollector();
		const requestCost = startRequestCost();
		try {
			rawBody = await c.req.raw
				.clone()
				.json()
				.catch(() => undefined);
			const body = withAuthRequestHeaders(AuthFlowRequestSchema.parse(rawBody), c.req.raw.headers);
			const response = await handleAuthFlow(
				provider,
				body,
				"continue",
				options,
				state,
				proxyTelemetry,
				c.req.raw.signal,
			);
			logProviderSuccess(
				logger,
				provider,
				"auth",
				"continue",
				body.requestId,
				response instanceof Response ? response.status : 200,
				finishRequestCost(requestCost),
				proxyTelemetry,
			);
			if (response instanceof Response)
				return responseWithProviderTelemetry(response, proxyTelemetry);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return c.json(response);
		} catch (error) {
			const status = toStatusCode(error);
			const requestId = extractRequestId(rawBody);
			logProviderError(
				logger,
				provider,
				"auth",
				"continue",
				requestId,
				error,
				status,
				finishRequestCost(requestCost),
				undefined,
				proxyTelemetry,
			);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return responseWithErrorObservability(
				c.json(toErrorResponse(error, requestId), status),
				error,
			);
		}
	});

	app.post("/auth/poll", async (c) => {
		let rawBody: unknown;
		const proxyTelemetry = new ProxyTelemetryCollector();
		const requestCost = startRequestCost();
		try {
			rawBody = await c.req.raw
				.clone()
				.json()
				.catch(() => undefined);
			const body = withAuthRequestHeaders(AuthFlowRequestSchema.parse(rawBody), c.req.raw.headers);
			const response = await handleAuthFlow(
				provider,
				body,
				"poll",
				options,
				state,
				proxyTelemetry,
				c.req.raw.signal,
			);
			logProviderSuccess(
				logger,
				provider,
				"auth",
				"poll",
				body.requestId,
				response instanceof Response ? response.status : 200,
				finishRequestCost(requestCost),
				proxyTelemetry,
			);
			if (response instanceof Response)
				return responseWithProviderTelemetry(response, proxyTelemetry);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return c.json(response);
		} catch (error) {
			const status = toStatusCode(error);
			const requestId = extractRequestId(rawBody);
			logProviderError(
				logger,
				provider,
				"auth",
				"poll",
				requestId,
				error,
				status,
				finishRequestCost(requestCost),
				undefined,
				proxyTelemetry,
			);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return responseWithErrorObservability(
				c.json(toErrorResponse(error, requestId), status),
				error,
			);
		}
	});

	app.post("/auth/refresh", async (c) => {
		let rawBody: unknown;
		const proxyTelemetry = new ProxyTelemetryCollector();
		const requestCost = startRequestCost();
		try {
			rawBody = await c.req.raw
				.clone()
				.json()
				.catch(() => undefined);
			const body = withAuthRequestHeaders(AuthFlowRequestSchema.parse(rawBody), c.req.raw.headers);
			const response = await handleAuthFlow(
				provider,
				body,
				"refresh",
				options,
				state,
				proxyTelemetry,
				c.req.raw.signal,
			);
			logProviderSuccess(
				logger,
				provider,
				"auth",
				"refresh",
				body.requestId,
				response instanceof Response ? response.status : 200,
				finishRequestCost(requestCost),
				proxyTelemetry,
			);
			if (response instanceof Response)
				return responseWithProviderTelemetry(response, proxyTelemetry);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return c.json(response);
		} catch (error) {
			const status = toStatusCode(error);
			const requestId = extractRequestId(rawBody);
			logProviderError(
				logger,
				provider,
				"auth",
				"refresh",
				requestId,
				error,
				status,
				finishRequestCost(requestCost),
				undefined,
				proxyTelemetry,
			);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return responseWithErrorObservability(
				c.json(toErrorResponse(error, requestId), status),
				error,
			);
		}
	});

	app.post("/auth/disconnect", async (c) => {
		let rawBody: unknown;
		const proxyTelemetry = new ProxyTelemetryCollector();
		const requestCost = startRequestCost();
		try {
			rawBody = await c.req.raw
				.clone()
				.json()
				.catch(() => undefined);
			const body = withAuthRequestHeaders(AuthFlowRequestSchema.parse(rawBody), c.req.raw.headers);
			const response = await handleAuthFlow(
				provider,
				body,
				"abort",
				options,
				state,
				proxyTelemetry,
				c.req.raw.signal,
			);
			logProviderSuccess(
				logger,
				provider,
				"auth",
				"disconnect",
				body.requestId,
				response instanceof Response ? response.status : 200,
				finishRequestCost(requestCost),
				proxyTelemetry,
			);
			if (response instanceof Response)
				return responseWithProviderTelemetry(response, proxyTelemetry);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return c.json(response);
		} catch (error) {
			const status = toStatusCode(error);
			const requestId = extractRequestId(rawBody);
			logProviderError(
				logger,
				provider,
				"auth",
				"disconnect",
				requestId,
				error,
				status,
				finishRequestCost(requestCost),
				undefined,
				proxyTelemetry,
			);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return responseWithErrorObservability(
				c.json(toErrorResponse(error, requestId), status),
				error,
			);
		}
	});

	return app;
}

function validateStatefulServerConfig(options: ProviderServerOptions): void {
	if (options.statefulForwarding && !options.internalOperationExecutor) {
		throw new Error(
			"Invalid provider server configuration: statefulForwarding requires internalOperationExecutor; missing option internalOperationExecutor.",
		);
	}
	if (options.internalOperationExecutor && !options.statefulForwarding?.secret) {
		throw new Error(
			"Invalid provider server configuration: internalOperationExecutor requires statefulForwarding.secret; missing option statefulForwarding.secret.",
		);
	}
	if (
		options.statefulForwarding &&
		typeof options.statefulForwarding.validateOwnerFence !== "function"
	) {
		throw new Error(
			"Invalid provider server configuration: statefulForwarding requires validateOwnerFence.",
		);
	}
	if (
		options.statefulForwarding?.maxSkewMs !== undefined &&
		(!Number.isFinite(options.statefulForwarding.maxSkewMs) ||
			options.statefulForwarding.maxSkewMs <= 0)
	) {
		throw new Error("Invalid provider server configuration: maxSkewMs must be positive.");
	}
	if (
		options.statefulForwarding?.replayCacheMaxEntries !== undefined &&
		(!Number.isInteger(options.statefulForwarding.replayCacheMaxEntries) ||
			options.statefulForwarding.replayCacheMaxEntries <= 0)
	) {
		throw new Error(
			"Invalid provider server configuration: replayCacheMaxEntries must be a positive integer.",
		);
	}
}

type BunServeRuntime = {
	serve: (options: {
		port: number;
		hostname: string;
		fetch: (request: Request) => Response | Promise<Response>;
	}) => BunServerHandle;
};

type BunServerHandle = {
	readonly port: number;
	stop(closeActiveConnections?: boolean): Promise<void>;
};

function getBunServeRuntime(): BunServeRuntime | undefined {
	const bunValue = Object.getOwnPropertyDescriptor(globalThis, "Bun")?.value;
	if (!bunValue || typeof bunValue !== "object") {
		return undefined;
	}

	const serve = Object.getOwnPropertyDescriptor(bunValue, "serve")?.value;
	if (typeof serve !== "function") {
		return undefined;
	}

	return {
		serve(options) {
			return serve(options) as BunServerHandle;
		},
	};
}

export type ProviderServerCloseOptions = {
	readonly timeoutMs?: number;
};

export type ProviderServerHandle = {
	readonly port: number;
	close(options?: ProviderServerCloseOptions): Promise<void>;
};

export interface ServeOptions extends ProviderServerOptions {
	host?: string;
	port?: number;
	/**
	 * Port for the internal self-test listener (default 3001 or
	 * APIFUSE__PROVIDER_RUNTIME__SELF_TEST_PORT). The listener only starts
	 * when APIFUSE__PROVIDER_RUNTIME__SELF_TEST_MASTER_SECRET is present.
	 */
	selfTestPort?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

type SignalServerRegistration = {
	readonly signals: ReadonlySet<NodeJS.Signals>;
	readonly close: () => Promise<void>;
};

type ProcessSignalCoordinator = {
	readonly registrations: Set<SignalServerRegistration>;
	readonly listener: () => void;
	handling: boolean;
};

const processSignalCoordinators = new Map<NodeJS.Signals, ProcessSignalCoordinator>();

export async function serve(
	provider: ProviderDefinition,
	options: ServeOptions = {},
): Promise<ProviderServerHandle> {
	const bunRuntime = getBunServeRuntime();

	if (bunRuntime === undefined) {
		throw new ProviderError("Bun runtime is required to start the provider server", {
			code: "RUNTIME_UNSUPPORTED",
		});
	}
	const logger = options.logger ?? defaultProviderServerLogger;
	const configuredTimeoutMs = shutdownTimeout(
		options.shutdown?.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
	);
	const configuredSignals = resolveShutdownSignals(options.shutdown?.signals ?? true);
	const selfTestSecrets = resolveSelfTestMasterSecrets();
	const serverAppOptions: ProviderServerOptions = {
		logger: options.logger,
		ocr: options.ocr,
		stt: options.stt,
		resolver: options.resolver,
		state: options.state,
		allowMemoryStateFallback: options.allowMemoryStateFallback,
		operationExecutor: options.operationExecutor,
		internalOperationExecutor: options.internalOperationExecutor,
		statefulForwarding: options.statefulForwarding,
	};
	const [app, selfTestModule] = await Promise.all([
		createServerAppAsync(provider, serverAppOptions),
		selfTestSecrets ? import("./self-test.js") : undefined,
	]);

	const servers: BunServerHandle[] = [];
	try {
		servers.push(
			bunRuntime.serve({
				port: options.port ?? DEFAULT_PORT,
				hostname: options.host ?? DEFAULT_HOST,
				fetch: app.fetch,
			}),
		);

		// Internal self-test listener (health dependency inversion): a SEPARATE
		// socket the tenant-facing gateway never dials. Off by default — it only
		// starts when the shared self-test master secret env is present.
		if (selfTestSecrets && selfTestModule) {
			const selfTestApp = selfTestModule.createSelfTestApp(provider, {
				secrets: selfTestSecrets,
				invoke: selfTestModule.createSelfTestInvoke(app),
				authFlow: selfTestModule.createSelfTestAuthFlowInvoke(app),
				logger,
			});
			servers.push(
				bunRuntime.serve({
					port: options.selfTestPort ?? selfTestModule.resolveSelfTestPort(),
					hostname: options.host ?? DEFAULT_HOST,
					fetch: selfTestApp.fetch,
				}),
			);
		}
	} catch (error) {
		await Promise.allSettled(servers.map((startedServer) => startedServer.stop(true)));
		throw error;
	}

	const server = servers[0];
	if (!server) throw new Error("Provider server failed to create its primary listener.");
	let closePromise: Promise<void> | undefined;
	let unregisterSignals = () => {};

	const close = (closeOptions: ProviderServerCloseOptions = {}): Promise<void> => {
		if (closePromise) return closePromise;
		const timeoutMs = shutdownTimeout(closeOptions.timeoutMs ?? configuredTimeoutMs);
		closePromise = closeProviderServers({
			servers,
			hooks: options.shutdown?.hooks ?? [],
			timeoutMs,
			logger,
			providerId: provider.id,
		}).finally(() => unregisterSignals());
		return closePromise;
	};

	try {
		unregisterSignals = registerForProcessSignals(configuredSignals, () =>
			close({ timeoutMs: configuredTimeoutMs }),
		);
	} catch (error) {
		unregisterSignals();
		await Promise.allSettled(servers.map((startedServer) => startedServer.stop(true)));
		throw error;
	}

	return { port: server.port, close };
}

function registerForProcessSignals(
	signals: NodeJS.Signals[],
	close: () => Promise<void>,
): () => void {
	if (signals.length === 0) return () => {};
	const registration: SignalServerRegistration = {
		signals: new Set(signals),
		close,
	};
	let registered = true;
	const unregister = () => {
		if (!registered) return;
		registered = false;
		for (const signal of registration.signals) {
			const coordinator = processSignalCoordinators.get(signal);
			if (!coordinator) continue;
			coordinator.registrations.delete(registration);
			if (coordinator.registrations.size === 0 && !coordinator.handling) {
				process.removeListener(signal, coordinator.listener);
				processSignalCoordinators.delete(signal);
			}
		}
	};
	try {
		for (const signal of signals) {
			let coordinator = processSignalCoordinators.get(signal);
			if (!coordinator) {
				const created: ProcessSignalCoordinator = {
					registrations: new Set(),
					handling: false,
					listener: () => handleCoordinatedSignal(signal, created),
				};
				coordinator = created;
				processSignalCoordinators.set(signal, coordinator);
				process.on(signal, coordinator.listener);
			}
			coordinator.registrations.add(registration);
		}
	} catch (error) {
		unregister();
		throw error;
	}
	return unregister;
}

function handleCoordinatedSignal(
	signal: NodeJS.Signals,
	coordinator: ProcessSignalCoordinator,
): void {
	if (coordinator.handling) return;
	coordinator.handling = true;
	const registrations = [...coordinator.registrations];
	void Promise.allSettled(registrations.map((registration) => registration.close())).finally(() => {
		if (processSignalCoordinators.get(signal) === coordinator) {
			process.removeListener(signal, coordinator.listener);
			processSignalCoordinators.delete(signal);
		}
		try {
			process.kill(process.pid, signal);
		} catch {
			process.exitCode = 1;
		}
	});
}

async function closeProviderServers(input: {
	readonly servers: BunServerHandle[];
	readonly hooks: Array<() => Promise<void>>;
	readonly timeoutMs: number;
	readonly logger: ProviderServerLogger;
	readonly providerId: string;
}): Promise<void> {
	const deadline = Date.now() + input.timeoutMs;
	const gracefulStops = input.servers.map((server) => server.stop(false));
	for (const gracefulStop of gracefulStops) gracefulStop.catch(() => undefined);
	for (const [hookIndex, hook] of input.hooks.entries()) {
		try {
			await withinShutdownBudget(Promise.resolve().then(hook), deadline);
		} catch (error) {
			try {
				input.logger({
					level: "error",
					event: "provider_shutdown_hook_failed",
					providerId: input.providerId,
					hookIndex,
					errorClass: error instanceof Error ? error.name : "UnknownError",
					message: error instanceof Error ? error.message : "Shutdown hook failed.",
				});
			} catch {}
		}
	}
	const forcedStops = input.servers.map((server) => server.stop(true));
	await withinShutdownBudget(
		Promise.allSettled([...gracefulStops, ...forcedStops]).then(() => undefined),
		deadline,
	).catch(() => undefined);
}

async function withinShutdownBudget<T>(promise: Promise<T>, deadline: number): Promise<T> {
	promise.catch(() => undefined);
	const remainingMs = Math.max(0, deadline - Date.now());
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("Provider server shutdown timed out.")), remainingMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function resolveShutdownSignals(signals: boolean | NodeJS.Signals[]): NodeJS.Signals[] {
	if (signals === false) return [];
	return [...new Set(signals === true ? DEFAULT_SHUTDOWN_SIGNALS : signals)];
}

function shutdownTimeout(value: number): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error("Provider server shutdown timeoutMs must be a non-negative finite number.");
	}
	return value;
}
