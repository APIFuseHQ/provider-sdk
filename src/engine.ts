import {
	ProviderEgressDeniedError,
	ProviderEngineAuthenticationError,
	ProviderEngineProtocolVersionError,
	ProviderEngineUnavailableError,
	ProviderError,
	isProviderError,
} from "./errors.js";
import { markRemoteProviderEngine } from "./engine-private.js";
import {
	OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_EXPORTER_OTLP_HEADERS,
	OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
	OTEL_EXPORTER_OTLP_TRACES_HEADERS,
	OTEL_RESOURCE_ATTRIBUTES,
	OTEL_SERVICE_NAME,
} from "./runtime/otlp.js";
import { createProviderChoiceContext } from "./runtime/choice.js";
import type {
	AuthContext,
	BrowserClient,
	CredentialContext,
	EnvContext,
	HttpClient,
	NativeContext,
	OcrContext,
	ProviderCache,
	ProviderChoiceContext,
	ProviderContext,
	ProviderDefinition,
	ProviderFilesContext,
	ProviderRequestContext,
	ProviderRuntimeState,
	ProviderSecretDeclaration,
	ResolverContext,
	StealthClient,
	SttContext,
	TraceContext,
} from "./types.js";

/** Versioned envelope protocol used by out-of-process engine transports. */
export const PROVIDER_ENGINE_PROTOCOL_VERSION = "provider-engine.v1" as const;

/** Workspace credential read by local SDK entry points. */
export const PROVIDER_ENGINE_API_KEY_ENV = "APIFUSE__ENGINE__API_KEY" as const;

/** Optional endpoint override for development and staged engine deployments. */
export const PROVIDER_ENGINE_URL_ENV = "APIFUSE__ENGINE__URL" as const;

/**
 * Placeholder public endpoint until the monorepo engine deployment publishes
 * its production discovery URL. Override with APIFUSE__ENGINE__URL meanwhile.
 */
export const DEFAULT_PROVIDER_ENGINE_URL = "https://engine.apifuse.com" as const;

/** Credential names owned by the engine and forbidden in provider declarations. */
export const ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES = [
	"APIFUSE__PROXY__SMARTPROXY_APP_KEY",
	"APIFUSE__PROXY__NODEMAVEN_USERNAME",
	"APIFUSE__PROXY__NODEMAVEN_PASSWORD",
] as const;

/** All non-telemetry runtime/vendor names that may exist only on the engine. */
export const ENGINE_OWNED_RUNTIME_ENV_NAMES = [
	...ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES,
	"APIFUSE__RESOLVER__2CAPTCHA__API_KEY",
	"APIFUSE__RESOLVER__CAPSOLVER__API_KEY",
	"APIFUSE__RESOLVER__CAPMONSTER__API_KEY",
	"APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY",
	"APIFUSE__STT__CLOUDFLARE_API_TOKEN",
	"APIFUSE__OCR__CLOUDFLARE_API_TOKEN",
	"APIFUSE__OCR__API_KEY",
	"APIFUSE__CLOUDFLARE__ACCOUNT_ID",
	"APIFUSE__CACHE__KEY_PEPPER",
	"APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET",
] as const;

const ENGINE_OWNED_RUNTIME_ENV_NAME_SET = new Set<string>(ENGINE_OWNED_RUNTIME_ENV_NAMES);

const ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAME_SET = new Set<string>(
	ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES,
);

/**
 * Environment names are compared case-insensitively: Windows resolves `otel_exporter_otlp_headers`
 * to the same variable as `OTEL_EXPORTER_OTLP_HEADERS`, so a mixed-case alias must be treated as
 * the engine-owned name it resolves to.
 */
function canonicalEnvName(name: string): string {
	return name.toUpperCase();
}

export function isEngineOwnedProxyCredentialName(name: string): boolean {
	return ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAME_SET.has(canonicalEnvName(name));
}

export function isEngineOwnedRuntimeEnvName(name: string): boolean {
	const canonicalName = canonicalEnvName(name);
	return (
		ENGINE_OWNED_RUNTIME_ENV_NAME_SET.has(canonicalName) ||
		canonicalName.startsWith("APIFUSE__CDP_POOL__")
	);
}

/**
 * Trace-export configuration owned by the engine and forbidden in provider
 * declarations. The header variables carry collector credentials; the rest are
 * engine deployment settings a provider has no reason to read.
 */
export const ENGINE_OWNED_TELEMETRY_ENV_NAMES = [
	OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
	OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_EXPORTER_OTLP_TRACES_HEADERS,
	OTEL_EXPORTER_OTLP_HEADERS,
	OTEL_SERVICE_NAME,
	OTEL_RESOURCE_ATTRIBUTES,
] as const;

const ENGINE_OWNED_TELEMETRY_ENV_NAME_SET = new Set<string>(ENGINE_OWNED_TELEMETRY_ENV_NAMES);

export function isEngineOwnedTelemetryEnvName(name: string): boolean {
	return ENGINE_OWNED_TELEMETRY_ENV_NAME_SET.has(canonicalEnvName(name));
}

/** Every environment name the engine owns: rejected in declarations and filtered from provider projections. */
export function isEngineOwnedEnvName(name: string): boolean {
	return isEngineOwnedRuntimeEnvName(name) || isEngineOwnedTelemetryEnvName(name);
}

/** Capture credentials in the engine host before constructing provider bindings. */
export function readEngineProxyCredentials(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES.flatMap((name) => {
			const value = environment[name]?.trim();
			return value ? [[name, value] as const] : [];
		}),
	);
}

/** Build the exact environment projection permitted to enter a provider runtime. */
export function createProviderEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
	declaredSecrets: readonly ProviderSecretDeclaration[],
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		declaredSecrets.flatMap(({ name, issuer }) => {
			if (issuer !== "contributor") return [];
			if (isEngineOwnedEnvName(name)) return [];
			const value = environment[name];
			return value === undefined ? [] : [[name, value] as const];
		}),
	);
}

/**
 * Request/response is the first remote transport lane. Stream and session
 * handles are separate lanes so lifecycle-bearing capabilities are never
 * disguised as ordinary JSON calls.
 */
export interface ProviderEngineTransport {
	request(request: ProviderEngineProtocolRequest): Promise<unknown>;
	openStream?(request: ProviderEngineProtocolRequest): Promise<ReadableStream<Uint8Array>>;
	openSession?(request: ProviderEngineProtocolRequest): Promise<ProviderEngineSession>;
}

export interface ProviderEngineAuthentication {
	readonly scheme: "workspace-api-key";
	readonly credential: string;
}

export type ProviderEngineProtocolCapability = ProviderCapabilityKey | "attachment" | "trace";

export interface ProviderEngineRequest {
	readonly version: typeof PROVIDER_ENGINE_PROTOCOL_VERSION;
	readonly lane: "request" | "stream" | "session";
	readonly authentication: ProviderEngineAuthentication;
	readonly providerId: string;
	readonly requestId: string;
	readonly capability: ProviderEngineProtocolCapability;
	readonly method: string;
	readonly payload: unknown;
}

export interface ProviderEngineHandshakeRequest extends ProviderEngineRequest {
	readonly lane: "request";
	readonly capability: "attachment";
	readonly method: "attach";
	readonly payload: {
		readonly runtimeTarget: "vanilla" | "engine";
		readonly capabilities: readonly ProviderCapabilityKey[];
	};
}

export type ProviderEngineProtocolRequest = ProviderEngineRequest | ProviderEngineHandshakeRequest;

export interface ProviderEngineRemoteError {
	readonly code: string;
	readonly message: string;
	readonly retryable?: boolean;
	readonly details?: unknown;
	readonly fix?: string;
}

export type ProviderEngineResponse<T = unknown> =
	| {
			readonly version: string;
			readonly requestId: string;
			readonly ok: true;
			readonly result: T;
	  }
	| {
			readonly version: string;
			readonly requestId: string;
			readonly ok: false;
			readonly error: ProviderEngineRemoteError;
	  };

export interface ProviderEngineTraceBody {
	readonly encoding: "utf8" | "base64";
	readonly data: string;
	readonly bytes: number;
	readonly truncated: boolean;
}

/** Safe trace event for traffic owned by the attached workspace session. */
export interface ProviderEngineTraceEvent {
	readonly type: "provider-engine.trace";
	readonly requestId: string;
	readonly operationId?: string;
	readonly phase: "request" | "response" | "error";
	readonly capability: Exclude<ProviderEngineProtocolCapability, "attachment" | "trace">;
	readonly method: string;
	readonly host: string;
	readonly path: string;
	readonly status?: number;
	readonly durationMs?: number;
	readonly requestBytes?: number;
	readonly responseBytes?: number;
	readonly retryCount?: number;
	readonly errorCode?: string;
	readonly body?: ProviderEngineTraceBody;
}

export interface ProviderEngineSession {
	request<TResponse = unknown>(method: string, payload: unknown): Promise<TResponse>;
	close(): Promise<void>;
}

/** Capability implementations owned by the engine rather than provider code. */
export interface ProviderEngineCapabilitySurface {
	readonly http: HttpClient;
	readonly browser: BrowserClient;
	readonly stealth: StealthClient;
	readonly stt: SttContext;
	readonly ocr: OcrContext;
	readonly resolver: ResolverContext;
	readonly cache: ProviderCache;
	readonly state: ProviderRuntimeState;
	readonly choice: ProviderChoiceContext;
	readonly files: ProviderFilesContext;
}

/** Engine-resident-only capabilities, kept separate from the portable surface. */
export interface ProviderEngineResidentSurface {
	readonly native: NativeContext;
}

export const PROVIDER_CAPABILITY_KEYS = [
	"env",
	"credential",
	"http",
	"files",
	"native",
	"cache",
	"state",
	"stealth",
	"browser",
	"auth",
	"ocr",
	"stt",
	"resolver",
	"choice",
] as const;

export type ProviderCapabilityKey = (typeof PROVIDER_CAPABILITY_KEYS)[number];

export type ProviderEngineBindingCandidates = Partial<
	ProviderEngineCapabilitySurface &
		ProviderEngineResidentSurface & {
			readonly env: EnvContext;
			readonly credential: CredentialContext;
			readonly files: ProviderFilesContext;
			readonly auth: AuthContext;
			readonly choice: ProviderChoiceContext;
		}
> & {
	readonly request?: ProviderRequestContext;
	readonly trace: TraceContext;
};

export interface ProviderEngineAttachmentInput {
	readonly provider: ProviderDefinition;
	readonly bindings: ProviderEngineBindingCandidates;
}

/** Attachment boundary shared by in-process development and remote RPC bridges. */
export interface ProviderEngine {
	ready?(): Promise<void>;
	attach<TDeclaration extends object = Record<string, unknown>>(
		input: ProviderEngineAttachmentInput,
	): ProviderContext<TDeclaration>;
	openTraceStream?(): Promise<ReadableStream<Uint8Array>>;
}

function declaresCapability(
	provider: ProviderDefinition,
	capability: ProviderCapabilityKey,
): boolean {
	return Object.hasOwn(provider, capability) && provider[capability] !== undefined;
}

function attachmentError(
	provider: ProviderDefinition,
	capability: ProviderCapabilityKey,
): ProviderError {
	return new ProviderError(
		`Provider engine could not attach declared capability "${capability}" for provider "${provider.id}"`,
		{
			code: "PROVIDER_ENGINE_ATTACHMENT_FAILED",
			details: { providerId: provider.id, capability },
			fix: `Configure the engine binding for "${capability}" before starting the provider.`,
		},
	);
}

export interface RemoteProviderEngineOptions {
	readonly provider: ProviderDefinition;
	readonly apiKey: string;
	readonly endpoint?: string;
	readonly transport?: ProviderEngineTransport;
}

function requiredWorkspaceApiKey(value: string | undefined): string {
	const key = value?.trim();
	if (key) return key;
	throw new ProviderEngineAuthenticationError(
		"APIFUSE__ENGINE__API_KEY is required to attach the remote provider engine; set it to the workspace API key from your authenticated APIFuse bounty dashboard",
	);
}

export function workspaceApiKeyFromEnv(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
	return requiredWorkspaceApiKey(environment[PROVIDER_ENGINE_API_KEY_ENV]);
}

function requestId(): string {
	return `engine_${crypto.randomUUID()}`;
}

function remoteError(error: ProviderEngineRemoteError): ProviderError {
	switch (error.code) {
		case "PROVIDER_ENGINE_AUTHENTICATION_FAILED":
			return new ProviderEngineAuthenticationError(error.message, {
				details: error.details,
				retryable: error.retryable,
				...(error.fix ? { fix: error.fix } : {}),
			});
		case "PROVIDER_ENGINE_PROTOCOL_VERSION_MISMATCH":
			return new ProviderEngineProtocolVersionError(
				(error.details as { receivedVersion?: unknown } | undefined)?.receivedVersion,
				PROVIDER_ENGINE_PROTOCOL_VERSION,
			);
		case "PROVIDER_EGRESS_DENIED":
			return new ProviderEgressDeniedError(error.message, error.details);
		default:
			return new ProviderError(error.message, {
				code: error.code,
				retryable: error.retryable,
				details: error.details,
				fix: error.fix,
			});
	}
}

function unwrapResponse<T>(response: unknown): T {
	if (!response || typeof response !== "object") return response as T;
	const envelope = response as Partial<ProviderEngineResponse<T>>;
	if (typeof envelope.version !== "string") return response as T;
	if (envelope.version !== PROVIDER_ENGINE_PROTOCOL_VERSION) {
		throw new ProviderEngineProtocolVersionError(
			envelope.version,
			PROVIDER_ENGINE_PROTOCOL_VERSION,
		);
	}
	if (envelope.ok === false && envelope.error) throw remoteError(envelope.error);
	if (envelope.ok === true) return envelope.result as T;
	return response as T;
}

async function invokeRemoteRequest<T>(
	transport: ProviderEngineTransport,
	request: ProviderEngineProtocolRequest,
): Promise<T> {
	try {
		return unwrapResponse<T>(await transport.request(request));
	} catch (error) {
		if (isProviderError(error)) throw error;
		throw new ProviderEngineUnavailableError(
			"The remote provider engine request failed; local capability execution is disabled",
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}

function createFetchTransport(endpoint: string): ProviderEngineTransport {
	const baseUrl = endpoint.replace(/\/$/, "");
	const call = async <T>(path: string, request: ProviderEngineProtocolRequest): Promise<T> => {
		let response: Response;
		try {
			response = await fetch(`${baseUrl}${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${request.authentication.credential}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
			});
		} catch (error) {
			throw new ProviderEngineUnavailableError(
				`Could not reach the remote provider engine at ${baseUrl}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			throw new ProviderEngineUnavailableError(
				`Provider engine returned an invalid response (HTTP ${response.status})`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		return unwrapResponse<T>(body);
	};
	return {
		request: (request) => call<unknown>("/v1/provider-engine/request", request),
		async openStream(request) {
			let response: Response;
			try {
				response = await fetch(`${baseUrl}/v1/provider-engine/stream`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${request.authentication.credential}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(request),
				});
			} catch (error) {
				throw new ProviderEngineUnavailableError(
					`Could not reach the remote provider engine at ${baseUrl}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
			if (!response.ok || !response.body) {
				const body = await response.json().catch(() => undefined);
				if (body) unwrapResponse(body);
				throw new ProviderEngineUnavailableError(
					`Provider engine trace stream failed (HTTP ${response.status})`,
				);
			}
			const responseVersion = response.headers.get("x-apifuse-engine-protocol");
			if (responseVersion && responseVersion !== PROVIDER_ENGINE_PROTOCOL_VERSION) {
				throw new ProviderEngineProtocolVersionError(
					responseVersion,
					PROVIDER_ENGINE_PROTOCOL_VERSION,
				);
			}
			return response.body;
		},
	};
}

function declaredCapabilities(provider: ProviderDefinition): ProviderCapabilityKey[] {
	return PROVIDER_CAPABILITY_KEYS.filter((capability) => declaresCapability(provider, capability));
}

function authenticatedRequest(
	provider: ProviderDefinition,
	apiKey: string,
	lane: ProviderEngineRequest["lane"],
	capability: ProviderEngineProtocolCapability,
	method: string,
	payload: unknown,
	correlationId = requestId(),
): ProviderEngineRequest {
	return {
		version: PROVIDER_ENGINE_PROTOCOL_VERSION,
		lane,
		authentication: { scheme: "workspace-api-key", credential: apiKey },
		providerId: provider.id,
		requestId: correlationId,
		capability,
		method,
		payload,
	};
}

function createRemoteCapability(
	provider: ProviderDefinition,
	apiKey: string,
	transport: ProviderEngineTransport,
	capability: ProviderCapabilityKey,
	correlationId?: string,
): object {
	return new Proxy(
		{},
		{
			get(_target, property) {
				if (capability === "browser" && property === "engine") {
					return provider.browser?.engine ?? "playwright-stealth";
				}
				if (property === "then") return undefined;
				return (...args: unknown[]) =>
					invokeRemoteRequest(
						transport,
						authenticatedRequest(
							provider,
							apiKey,
							"request",
							capability,
							String(property),
							{ args },
							correlationId,
						),
					);
			},
		},
	);
}

function createRemoteChoiceCapability(
	local: ProviderChoiceContext,
	remote: ProviderChoiceContext,
): ProviderChoiceContext {
	return new Proxy(remote, {
		get(target, property, receiver) {
			if (property === "issue" || property === "parse") {
				return (options: { readonly storage?: { readonly mode?: string } }) =>
					options.storage === undefined || options.storage.mode === "inline"
						? Reflect.apply(local[property], local, [options])
						: Reflect.apply(Reflect.get(target, property, receiver), target, [options]);
			}
			return Reflect.get(target, property, receiver);
		},
	}) as ProviderChoiceContext;
}

/** Create the authenticated client attachment used by serve, dev, and record. */
export function createRemoteProviderEngine(options: RemoteProviderEngineOptions): ProviderEngine {
	const apiKey = requiredWorkspaceApiKey(options.apiKey);
	const transport =
		options.transport ?? createFetchTransport(options.endpoint ?? DEFAULT_PROVIDER_ENGINE_URL);
	let readyPromise: Promise<void> | undefined;
	const ready = () => {
		readyPromise ??= invokeRemoteRequest(
			transport,
			authenticatedRequest(options.provider, apiKey, "request", "attachment", "attach", {
				runtimeTarget: options.provider.runtimeTarget ?? "vanilla",
				capabilities: declaredCapabilities(options.provider),
			}) as ProviderEngineHandshakeRequest,
		);
		return readyPromise;
	};
	return markRemoteProviderEngine({
		ready,
		attach<TDeclaration extends object>(input: ProviderEngineAttachmentInput) {
			const context: Record<PropertyKey, unknown> = {
				trace: input.bindings.trace,
			};
			// Inline choices remain local by D2. The already-required workspace key is
			// session-local key material, so no engine-owned vendor secret is projected.
			const inlineChoice = createProviderChoiceContext({
				providerId: input.provider.id,
				masterSecret: apiKey,
				request: input.bindings.request,
				credential: input.bindings.credential,
			});
			if (input.bindings.request) context.request = input.bindings.request;
			for (const capability of declaredCapabilities(input.provider)) {
				if (["env", "credential", "auth"].includes(capability)) {
					const local = input.bindings[capability];
					if (local === undefined) throw attachmentError(input.provider, capability);
					context[capability] = local;
					continue;
				}
				const remote = createRemoteCapability(
					input.provider,
					apiKey,
					transport,
					capability,
					input.bindings.request?.headers["x-request-id"],
				);
				context[capability] =
					capability === "choice"
						? createRemoteChoiceCapability(inlineChoice, remote as ProviderChoiceContext)
						: remote;
			}
			return context as ProviderContext<TDeclaration>;
		},
		openTraceStream() {
			if (!transport.openStream) {
				throw new ProviderEngineUnavailableError("Provider engine transport has no stream lane");
			}
			return transport
				.openStream(
					authenticatedRequest(options.provider, apiKey, "stream", "trace", "trace.subscribe", {}),
				)
				.catch((error) => {
					if (isProviderError(error)) throw error;
					throw new ProviderEngineUnavailableError(
						"The remote provider engine trace stream failed; local execution is disabled",
						error instanceof Error ? error : new Error(String(error)),
					);
				});
		},
	});
}

export function createRemoteProviderEngineFromEnv(
	provider: ProviderDefinition,
	environment: Readonly<Record<string, string | undefined>> = process.env,
): ProviderEngine {
	return createRemoteProviderEngine({
		provider,
		apiKey: workspaceApiKeyFromEnv(environment),
		endpoint: environment[PROVIDER_ENGINE_URL_ENV]?.trim() || DEFAULT_PROVIDER_ENGINE_URL,
	});
}
