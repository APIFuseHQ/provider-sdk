import { existsSync } from "node:fs";
import { join } from "node:path";

import { Hono } from "hono";
import { z } from "zod";
import { AuthAbortError, createAuthFlowHelpers } from "../auth";
import {
	AuthError,
	ProviderError,
	SessionExpiredError,
	TransportError,
} from "../errors";
import {
	loadProviderLocaleCatalogs,
	localizeAuthTurn,
	type ProviderLocaleCatalogMap,
} from "../i18n/catalog";
import type { ProviderLocale } from "../i18n/keys";
import {
	categoryForStatus,
	isRetryableCategory,
	PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
	type ProviderErrorCategory,
} from "../observability";
import { createScratchpad } from "../runtime/auth-flow";
import { createBrowserClient } from "../runtime/browser";
import { createProviderCache } from "../runtime/cache";
import {
	createProviderChoiceContext,
	PROVIDER_RUNTIME_CHOICE_TOKEN_MASTER_SECRET_ENV,
} from "../runtime/choice";
import { createCredentialContext } from "../runtime/credential";
import { createEnvContext } from "../runtime/env";
import { executeOperation } from "../runtime/executor";
import { createHttpClient } from "../runtime/http";
import { wrapWithInstrumentation } from "../runtime/instrumentation";
import { getProviderBaseUrl } from "../runtime/provider";
import {
	PROXY_AUTH_IP_DENIED_CODE,
	PROXY_EDGE_AUTH_REJECTED_CODE,
	PROXY_POOL_EXHAUSTED_CODE,
} from "../runtime/proxy-errors";
import {
	PROVIDER_TELEMETRY_HEADER,
	ProxyTelemetryCollector,
} from "../runtime/proxy-telemetry";
import {
	createProviderRuntimeStateFromEnv,
	createUnsupportedProviderRuntimeState,
} from "../runtime/state";
import { createStealthClient } from "../runtime/stealth";
import { createSttClientFromEnv } from "../runtime/stt";
import { createTraceContext } from "../runtime/trace";
import { parseSchema } from "../schema";
import { getStealthProfile } from "../stealth/profiles";
import {
	APIFUSE_STREAM_DONE_EVENT,
	APIFUSE_STREAM_ERROR_EVENT,
	encodeSseEvent,
	error as streamError,
} from "../stream";
import type {
	AuthContext,
	AuthTurn,
	BrowserClient,
	FlowContext,
	FlowContextStore,
	HttpRetrySummary,
	OperationDefinition,
	OperationHttpStreamTransport,
	OperationSseTransport,
	ProviderContext,
	ProviderDefinition,
	ProviderRuntimeState,
	ProviderStreamEvent,
	StealthClient,
	SttContext,
} from "../types";
import {
	createSelfTestApp,
	createSelfTestInvoke,
	resolveSelfTestPort,
} from "./self-test";
import { resolveSelfTestMasterSecrets } from "./self-test-token";
import {
	type AuthFlowRequest,
	AuthFlowRequestSchema,
	type AuthFlowResponse,
	type AuthFlowSuccessResponse,
	type OperationErrorResponse,
	type OperationRequest,
	OperationRequestSchema,
	type OperationResponse,
	type OperationSuccessResponse,
} from "./types";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;
const AUTH_FLOW_LOCALES = ["en", "ko", "ja"] as const;
const retryResponseMeta = new WeakMap<ProviderContext, HttpRetrySummary>();

type RequestCleanup = () => void | Promise<void>;

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

function getProviderStealthBaseUrl(
	provider: ProviderDefinition,
): string | undefined {
	const baseUrl = getProviderBaseUrl(provider);
	if (baseUrl) {
		return baseUrl;
	}
	const firstHost = provider.allowedHosts?.[0];
	return firstHost ? `https://${firstHost}` : undefined;
}

function getProviderStealthProfile(provider: ProviderDefinition) {
	return provider.stealth?.profile
		? getStealthProfile(provider.stealth.profile)
		: undefined;
}

function isProductionProviderBrowserMode(
	provider: ProviderDefinition,
	env = process.env,
): boolean {
	if (provider.runtime !== "browser") {
		return false;
	}

	if (env.APIFUSE__PROVIDER__RUNTIME === "browser") {
		return true;
	}

	return (
		env.NODE_ENV === "production" && env.APIFUSE__PROVIDER__ID === provider.id
	);
}

export function resolveProviderProxyAffinityKey(
	provider: ProviderDefinition,
	request: OperationRequest,
	operationId: string,
): string {
	const connectionKey =
		request.connection?.id ?? request.connection?.externalRef;
	const affinity =
		typeof provider.proxy === "object"
			? provider.proxy.session?.affinity
			: undefined;
	if (affinity === "operation") {
		return `${provider.id}/${operationId}`;
	}
	return connectionKey ?? provider.id;
}

function createProviderContext(
	provider: ProviderDefinition,
	request: OperationRequest,
	operationId: string,
	options: ProviderServerOptions = {},
	state: ProviderRuntimeState = createUnsupportedProviderRuntimeState(),
	proxyTelemetry?: ProxyTelemetryCollector,
): ProviderContext {
	const baseUrl = getProviderBaseUrl(provider);
	const stealthBaseUrl = getProviderStealthBaseUrl(provider);
	const stealthProfile = getProviderStealthProfile(provider);
	const proxyClientOptions = {
		upstream: { proxy: provider.proxy },
		affinityKey: resolveProviderProxyAffinityKey(
			provider,
			request,
			operationId,
		),
		telemetry: proxyTelemetry,
	};
	let wrappedContext: ProviderContext | undefined;
	const stealthClientOptions = {
		upstream: proxyClientOptions.upstream,
		affinityKey: proxyClientOptions.affinityKey,
		telemetry: proxyTelemetry,
	};

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
		connectionId: request.connectionId ?? request.connection?.id,
		headers: request.headers ?? {},
	};
	const context = wrapWithInstrumentation({
		env,
		credential,
		request: requestContext,
		http: createHttpClient(baseUrl, {
			...proxyClientOptions,
			onRetrySummary: (summary) => {
				if (summary.attempts <= 1 || !wrappedContext) return;
				retryResponseMeta.set(wrappedContext, summary);
			},
		}),
		cache: createProviderCache({ providerId: provider.id }),
		state,
		stealth: stealthBaseUrl
			? stealthProfile
				? createStealthClient(
						stealthBaseUrl,
						stealthProfile.name,
						stealthClientOptions,
					)
				: createStealthClient(stealthBaseUrl, stealthClientOptions)
			: createStealthStub(),
		browser:
			provider.runtime === "browser"
				? createBrowserClient({
						allowedHosts: provider.allowedHosts,
						cdpUrl: process.env.APIFUSE__CDP_POOL__URL,
						headless: true,
						requireCdpPool: isProductionProviderBrowserMode(provider),
						stealth: true,
						engine: provider.browser?.engine,
					})
				: createBrowserStub(),
		trace: createTraceContext(),
		auth: createAuthStub(),
		stt: options.stt ?? createSttClientFromEnv(provider.stt),
		choice: createProviderChoiceContext({
			providerId: provider.id,
			env,
			request: requestContext,
			credential,
			state,
		}),
	});
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

function createAuthFlowContext(
	provider: ProviderDefinition,
	request: AuthFlowRequest,
	options: ProviderServerOptions = {},
	signal?: AbortSignal,
): {
	context: FlowContext;
	getPatch: () => Record<string, unknown | null> | undefined;
} {
	const baseUrl = getProviderBaseUrl(provider);
	const stealthBaseUrl = getProviderStealthBaseUrl(provider);
	const stealthProfile = getProviderStealthProfile(provider);
	const contextData = request.context ?? {};
	const flowContextStore = createFlowContextStore(
		provider.context?.keys ?? Object.keys(contextData),
		contextData,
	);
	const proxyClientOptions = {
		upstream: { proxy: provider.proxy },
		affinityKey:
			request.connectionId ??
			request.externalRef ??
			request.tenantId ??
			request.providerId ??
			provider.id,
	};
	const stealthClientOptions = {
		upstream: proxyClientOptions.upstream,
		affinityKey: proxyClientOptions.affinityKey,
	};
	const credential = request.connection
		? createCredentialContext({
				allowedKeys: provider.credential?.keys,
				mode: request.connection.mode,
				scopes: request.connection.scopes,
				values: request.connection.secrets,
			})
		: undefined;

	return {
		context: {
			connectionId: request.connectionId,
			externalRef: request.externalRef,
			tenantId: request.tenantId ?? "",
			providerId: request.providerId ?? provider.id,
			http: createHttpClient(baseUrl, proxyClientOptions),
			stealth: stealthBaseUrl
				? stealthProfile
					? createStealthClient(
							stealthBaseUrl,
							stealthProfile.name,
							stealthClientOptions,
						)
					: createStealthClient(stealthBaseUrl, stealthClientOptions)
				: createStealthStub(),
			env: createEnvContext(provider.secrets?.map((secret) => secret.name)),
			credential,
			context: flowContextStore.context,
			stt: options.stt ?? createSttClientFromEnv(provider.stt),
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
			issues?: Array<{ path: string; code: string; message: string }>;
	  })
	| {
			level: "warn";
			event: "provider_cleanup_failed";
			providerId: string;
			kind: "operation";
			route: string;
			requestId?: string;
			resource: "browser" | "stealth";
			errorClass: string;
			message: string;
	  };

export type ProviderServerLogger = (event: ProviderServerLogEvent) => void;

export type ProviderServerOptions = {
	logger?: ProviderServerLogger;
	/** Optional STT override for tests or custom hosts; local/prod normally resolves from env. */
	stt?: SttContext;
	/** Optional runtime state override for tests or custom hosts. Production resolves Redis from env and fails closed when unavailable. */
	state?: ProviderRuntimeState;
	/** Allow process-local runtime state only for local development and tests. */
	allowMemoryStateFallback?: boolean;
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

function toErrorResponse(
	error: unknown,
	requestId?: string,
): OperationErrorResponse {
	if (error instanceof ProviderError) {
		const details = publicProviderErrorDetails(error);
		return {
			error: {
				code: error.code ?? "provider_error",
				message: publicProviderErrorMessage(error),
				...(requestId ? { requestId } : {}),
				...(error.fix ? { fix: error.fix } : {}),
				...(details ? { details } : {}),
			},
		};
	}

	if (error instanceof z.ZodError) {
		return {
			error: {
				code: "invalid_request",
				message: "Invalid request body",
				...(requestId ? { requestId } : {}),
				details: zodDetails(error),
			},
		};
	}

	return {
		error: {
			code: "internal_error",
			message: "Internal error",
			...(requestId ? { requestId } : {}),
		},
	};
}

function publicProviderErrorDetails(error: ProviderError): unknown {
	const providerDetails = error.details;
	const observabilityDetails = providerObservabilityDetails(error);

	if (providerDetails === undefined) {
		return observabilityDetails;
	}
	if (observabilityDetails === undefined) {
		return providerDetails;
	}
	if (isPlainRecord(providerDetails) && isPlainRecord(observabilityDetails)) {
		return { ...providerDetails, ...observabilityDetails };
	}
	return {
		provider: providerDetails,
		observability: observabilityDetails,
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerObservabilityDetails(error: ProviderError):
	| {
			category: ProviderErrorCategory;
			taxonomyVersion: string;
			retryable: boolean;
			upstreamStatus?: number;
	  }
	| undefined {
	// Session-expiry surfaces the credential_expired category + the opt-in
	// retryable signal so Gateway/Credential Service can refresh and re-drive the
	// operation (see design.md §4.3 D3). Without this branch the auth error would
	// serialize as a bare 401 with no retryable/category, losing the refresh
	// signal for exactly the retryOnAuthRefresh operations it is meant to enable.
	if (error instanceof SessionExpiredError) {
		return {
			category: error.options?.category ?? "credential_expired",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: error.options?.retryable ?? false,
		};
	}
	if (!(error instanceof TransportError)) {
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

function publicProviderErrorMessage(error: ProviderError): string {
	if (error instanceof TransportError) {
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

function toStatusCode(
	error: unknown,
): 400 | 401 | 404 | 429 | 500 | 502 | 503 | 504 {
	if (error instanceof z.ZodError) {
		return 400;
	}

	if (error instanceof TransportError) {
		return error.code === "transport_timeout" ? 504 : 502;
	}

	if (error instanceof ProviderError) {
		switch (error.code) {
			case "AUTH_REQUIRED":
			case "reauth_required":
				return 401;
			case "NOT_FOUND":
			case "not_found":
			case "NO_DATA":
				return 404;
			case "RATE_LIMITED":
			case "UPSTREAM_RATE_LIMIT":
			case "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR":
				return 429;
			case "UPSTREAM_ERROR":
			case "BLOCKED":
				return 502;
			case "STT_UNAVAILABLE":
			case "UNSUPPORTED_STT_BACKEND":
				return 503;
		}

		return 400;
	}

	return 500;
}

function extractRequestId(raw: unknown): string | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const value = Object.getOwnPropertyDescriptor(raw, "requestId")?.value;
	return typeof value === "string" ? value : undefined;
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
): void {
	const code =
		error instanceof ProviderError
			? (error.code ?? "provider_error")
			: error instanceof z.ZodError
				? "invalid_request"
				: "internal_error";
	const errorClass = error instanceof Error ? error.name : typeof error;
	const message = error instanceof Error ? error.message : String(error);
	const details =
		error instanceof ProviderError
			? providerObservabilityDetails(error)
			: undefined;
	const emit =
		typeof logger === "function" ? logger : defaultProviderServerLogger;
	emit({
		level: status >= 500 ? "error" : "warn",
		event: "provider_request_failed",
		providerId: provider.id,
		kind,
		route,
		...(requestId ? { requestId } : {}),
		status,
		...cost,
		code,
		errorClass,
		message,
		...(error instanceof TransportError && error.upstreamStatus
			? { upstreamStatus: error.upstreamStatus }
			: {}),
		...(details
			? {
					errorCategory: details.category,
					taxonomyVersion: details.taxonomyVersion,
					retryable: details.retryable,
				}
			: {}),
		...(error instanceof z.ZodError ? { issues: zodDetails(error) } : {}),
	});
}

function logProviderCleanupError(
	logger: ProviderServerLogger | unknown,
	provider: ProviderDefinition,
	operationId: string,
	requestId: string | undefined,
	resource: "browser" | "stealth",
	error: unknown,
): void {
	const emit =
		typeof logger === "function" ? logger : defaultProviderServerLogger;
	const errorClass = error instanceof Error ? error.name : typeof error;
	const message = error instanceof Error ? error.message : String(error);
	emit({
		level: "warn",
		event: "provider_cleanup_failed",
		providerId: provider.id,
		kind: "operation",
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
): void {
	const emit =
		typeof logger === "function" ? logger : defaultProviderServerLogger;
	emit({
		level: "info",
		event: "provider_request_completed",
		providerId: provider.id,
		kind,
		route,
		...(requestId ? { requestId } : {}),
		status,
		...cost,
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

function isAsyncIterable<T = unknown>(
	value: unknown,
): value is AsyncIterable<T> {
	if (!value || typeof value !== "object") return false;
	const iterator = Reflect.get(value, Symbol.asyncIterator);
	return typeof iterator === "function";
}

function responseWithCleanup(
	response: Response,
	cleanup: RequestCleanup,
): Response {
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
		if (
			event.event === APIFUSE_STREAM_ERROR_EVENT ||
			event.event === APIFUSE_STREAM_DONE_EVENT
		) {
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
	const data = await parseSchema(
		schema,
		event.data,
		`transport.events.${event.event}`,
	);
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
			code:
				kind === "event" ? "STREAM_EVENT_TOO_LARGE" : "STREAM_CHUNK_TOO_LARGE",
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
				assertStreamPayloadWithinLimit(
					encodedBytes.byteLength,
					transport?.maxEventBytes,
					"event",
				);
				controller.enqueue(encodedBytes);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Stream failed";
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
					assertStreamPayloadWithinLimit(
						byteLength(value),
						maxChunkBytes,
						"chunk",
					);
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
	if (
		transport === "sse" &&
		(result instanceof Response || result instanceof ReadableStream)
	) {
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
		if (
			httpTransport &&
			result.body &&
			httpTransport?.maxChunkBytes !== undefined
		) {
			return responseWithCleanup(
				new Response(
					enforceStreamChunkLimit(result.body, httpTransport.maxChunkBytes),
					{
						headers: result.headers,
						status: result.status,
						statusText: result.statusText,
					},
				),
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
										? (operation.transport.contentType ??
											"application/octet-stream")
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

function getSseTransport(
	operation: OperationDefinition,
): OperationSseTransport | undefined {
	return operation.transport?.kind === "sse" ? operation.transport : undefined;
}

function getHttpStreamTransport(
	operation: OperationDefinition,
): OperationHttpStreamTransport | undefined {
	return operation.transport?.kind === "http-stream"
		? operation.transport
		: undefined;
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

function authFlowLocaleFromHeaders(
	headers?: Record<string, string>,
): ProviderLocale {
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
	return (
		!!value && typeof value === "object" && "kind" in value && "turnId" in value
	);
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

function withAuthRequestHeaders(
	request: AuthFlowRequest,
	headers: Headers,
): AuthFlowRequest {
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
	options: ProviderServerOptions = {},
	state: ProviderRuntimeState = createUnsupportedProviderRuntimeState(),
	proxyTelemetry?: ProxyTelemetryCollector,
): Promise<Response | OperationResponse> {
	const ctx = createProviderContext(
		provider,
		request,
		operationId,
		options,
		state,
		proxyTelemetry,
	);
	const operation = provider.operations[operationId];
	const streaming =
		operation?.transport?.kind && operation.transport.kind !== "json";
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
				operationId,
				request.requestId,
				"browser",
				error,
			);
		}
	};
	try {
		const result = await executeOperation(
			provider,
			operationId,
			ctx,
			request.input,
		);
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
	options: ProviderServerOptions = {},
	signal?: AbortSignal,
): Promise<Response | AuthFlowResponse> {
	const flow = provider.auth?.flow;
	if (!flow) {
		throw new ProviderError("Auth flow is not configured", {
			code: "AUTH_FLOW_NOT_CONFIGURED",
		});
	}

	const { context, getPatch } = createAuthFlowContext(
		provider,
		request,
		options,
		signal,
	);
	try {
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
		context.stealth.close?.();
	}
}

export function createServerApp(
	provider: ProviderDefinition,
	options: ProviderServerOptions = {},
): Hono {
	const app = new Hono();
	const logger = options.logger ?? defaultProviderServerLogger;
	const state =
		options.state ??
		createProviderRuntimeStateFromEnv({
			providerId: provider.id,
			allowMemoryFallback: options.allowMemoryStateFallback === true,
		});

	app.notFound((c) =>
		c.json(
			{
				error: {
					code: "not_found",
					message: "Not found",
				},
			},
			404,
		),
	);

	app.get("/health", (c) =>
		c.json({
			status: "ok",
			provider: provider.id,
			version: provider.version,
		}),
	);

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
			);
			return c.json(response);
		} catch (error) {
			const status = toStatusCode(error);
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
			);
			const telemetryHeader = proxyTelemetry.toHeaderValue();
			if (telemetryHeader) c.header(PROVIDER_TELEMETRY_HEADER, telemetryHeader);
			return c.json(toErrorResponse(error, requestId), status);
		}
	});

	app.post("/auth/start", async (c) => {
		let rawBody: unknown;
		const requestCost = startRequestCost();
		try {
			rawBody = await c.req.raw
				.clone()
				.json()
				.catch(() => undefined);
			const body = withAuthRequestHeaders(
				AuthFlowRequestSchema.parse(rawBody),
				c.req.raw.headers,
			);
			const response = await handleAuthFlow(
				provider,
				body,
				"start",
				options,
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
			);
			return response instanceof Response ? response : c.json(response);
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
			);
			return c.json(toErrorResponse(error, requestId), status);
		}
	});

	app.post("/auth/continue", async (c) => {
		let rawBody: unknown;
		const requestCost = startRequestCost();
		try {
			rawBody = await c.req.raw
				.clone()
				.json()
				.catch(() => undefined);
			const body = withAuthRequestHeaders(
				AuthFlowRequestSchema.parse(rawBody),
				c.req.raw.headers,
			);
			const response = await handleAuthFlow(
				provider,
				body,
				"continue",
				options,
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
			);
			return response instanceof Response ? response : c.json(response);
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
			);
			return c.json(toErrorResponse(error, requestId), status);
		}
	});

	app.post("/auth/poll", async (c) => {
		let rawBody: unknown;
		const requestCost = startRequestCost();
		try {
			rawBody = await c.req.raw
				.clone()
				.json()
				.catch(() => undefined);
			const body = withAuthRequestHeaders(
				AuthFlowRequestSchema.parse(rawBody),
				c.req.raw.headers,
			);
			const response = await handleAuthFlow(
				provider,
				body,
				"poll",
				options,
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
			);
			return response instanceof Response ? response : c.json(response);
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
			);
			return c.json(toErrorResponse(error, requestId), status);
		}
	});

	app.post("/auth/refresh", async (c) => {
		let rawBody: unknown;
		const requestCost = startRequestCost();
		try {
			rawBody = await c.req.raw
				.clone()
				.json()
				.catch(() => undefined);
			const body = withAuthRequestHeaders(
				AuthFlowRequestSchema.parse(rawBody),
				c.req.raw.headers,
			);
			const response = await handleAuthFlow(
				provider,
				body,
				"refresh",
				options,
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
			);
			return response instanceof Response ? response : c.json(response);
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
			);
			return c.json(toErrorResponse(error, requestId), status);
		}
	});

	app.post("/auth/disconnect", async (c) => {
		let rawBody: unknown;
		const requestCost = startRequestCost();
		try {
			rawBody = await c.req.raw
				.clone()
				.json()
				.catch(() => undefined);
			const body = withAuthRequestHeaders(
				AuthFlowRequestSchema.parse(rawBody),
				c.req.raw.headers,
			);
			const response = await handleAuthFlow(
				provider,
				body,
				"abort",
				options,
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
			);
			return response instanceof Response ? response : c.json(response);
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
			);
			return c.json(toErrorResponse(error, requestId), status);
		}
	});

	return app;
}

type BunServeRuntime = {
	serve: (options: {
		port: number;
		hostname: string;
		fetch: (request: Request) => Response | Promise<Response>;
	}) => unknown;
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
			return serve(options);
		},
	};
}

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

export async function serve(
	provider: ProviderDefinition,
	options: ServeOptions = {},
): Promise<void> {
	const bunRuntime = getBunServeRuntime();

	if (bunRuntime === undefined) {
		throw new ProviderError(
			"Bun runtime is required to start the provider server",
			{
				code: "RUNTIME_UNSUPPORTED",
			},
		);
	}

	const app = createServerApp(provider, {
		logger: options.logger,
		stt: options.stt,
	});

	bunRuntime.serve({
		port: options.port ?? DEFAULT_PORT,
		hostname: options.host ?? DEFAULT_HOST,
		fetch: app.fetch,
	});

	// Internal self-test listener (health dependency inversion): a SEPARATE
	// socket the tenant-facing gateway never dials. Off by default — it only
	// starts when the shared self-test master secret env is present.
	const selfTestSecrets = resolveSelfTestMasterSecrets();
	if (selfTestSecrets) {
		const selfTestApp = createSelfTestApp(provider, {
			secrets: selfTestSecrets,
			invoke: createSelfTestInvoke(app),
		});
		bunRuntime.serve({
			port: options.selfTestPort ?? resolveSelfTestPort(),
			hostname: options.host ?? DEFAULT_HOST,
			fetch: selfTestApp.fetch,
		});
	}
	await Promise.resolve();
}
