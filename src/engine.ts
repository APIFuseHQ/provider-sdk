import { ProviderError } from "./errors.js";
import {
	APIFUSE__RESOLVER__2CAPTCHA__API_KEY,
	APIFUSE__RESOLVER__CAPMONSTER__API_KEY,
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY,
} from "./runtime/resolver-config.js";
import {
	OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_EXPORTER_OTLP_HEADERS,
	OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
	OTEL_EXPORTER_OTLP_TRACES_HEADERS,
	OTEL_RESOURCE_ATTRIBUTES,
	OTEL_SERVICE_NAME,
} from "./runtime/otlp.js";
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
	ResolverContext,
	StealthClient,
	SttContext,
	TraceContext,
} from "./types.js";

/** Versioned envelope protocol used by out-of-process engine transports. */
export const PROVIDER_ENGINE_PROTOCOL_VERSION = "provider-engine.v1" as const;

/** Credential names owned by the engine and forbidden in provider declarations. */
export const ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES = [
	"APIFUSE__PROXY__SMARTPROXY_APP_KEY",
	"APIFUSE__PROXY__NODEMAVEN_USERNAME",
	"APIFUSE__PROXY__NODEMAVEN_PASSWORD",
] as const;

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

/** Hosted resolver credentials owned by the engine and never projected to providers. */
export const ENGINE_OWNED_RESOLVER_CREDENTIAL_ENV_NAMES = [
	APIFUSE__RESOLVER__2CAPTCHA__API_KEY,
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	APIFUSE__RESOLVER__CAPMONSTER__API_KEY,
	APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY,
] as const;

const ENGINE_OWNED_RESOLVER_CREDENTIAL_ENV_NAME_SET = new Set<string>(
	ENGINE_OWNED_RESOLVER_CREDENTIAL_ENV_NAMES,
);

export function isEngineOwnedResolverCredentialName(name: string): boolean {
	const canonical = canonicalEnvName(name);
	return (
		ENGINE_OWNED_RESOLVER_CREDENTIAL_ENV_NAME_SET.has(canonical) ||
		canonical.startsWith("APIFUSE__RESOLVER__") ||
		/^APIFUSE__PROVIDER__.+__HYPER_API_KEY$/u.test(canonical)
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
	const canonical = canonicalEnvName(name);
	return (
		canonical.startsWith("APIFUSE__ENGINE__") ||
		isEngineOwnedProxyCredentialName(name) ||
		isEngineOwnedResolverCredentialName(name) ||
		isEngineOwnedTelemetryEnvName(name)
	);
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
	declaredNames: readonly string[],
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		declaredNames.flatMap((name) => {
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
	request<TResponse = unknown>(request: ProviderEngineRequest): Promise<TResponse>;
	openStream?(request: ProviderEngineRequest): Promise<ReadableStream<Uint8Array>>;
	openSession?(request: ProviderEngineRequest): Promise<ProviderEngineSession>;
}

export interface ProviderEngineRequest {
	readonly version: typeof PROVIDER_ENGINE_PROTOCOL_VERSION;
	readonly providerId: string;
	readonly requestId: string;
	readonly capability: ProviderCapabilityKey;
	readonly method: string;
	readonly payload: unknown;
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
	attach<TDeclaration extends object = Record<string, unknown>>(
		input: ProviderEngineAttachmentInput,
	): ProviderContext<TDeclaration>;
}

const CAPABILITY_KEY_SET = new Set<string>(PROVIDER_CAPABILITY_KEYS);

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

function undeclaredCapabilityError(
	provider: ProviderDefinition,
	capability: ProviderCapabilityKey,
): ProviderError {
	return new ProviderError(
		`Provider "${provider.id}" accessed undeclared capability "${capability}"; add the "${capability}" declaration`,
		{
			code: "PROVIDER_CAPABILITY_UNDECLARED",
			details: { providerId: provider.id, capability },
			fix: `Add ${capability}: {} to the provider declaration, or remove the access.`,
		},
	);
}

function attachInProcess<TDeclaration extends object>(
	input: ProviderEngineAttachmentInput,
): ProviderContext<TDeclaration> {
	const { provider, bindings } = input;
	if (provider.runtimeTarget === "vanilla" && declaresCapability(provider, "native")) {
		throw new ProviderError(
			`Provider "${provider.id}" cannot attach capability "native" to runtime target "vanilla"; native requires an engine-resident runtime`,
			{
				code: "PROVIDER_RUNTIME_CAPABILITY_CONFLICT",
				details: { providerId: provider.id, capability: "native", runtimeTarget: "vanilla" },
			},
		);
	}

	const context: Record<PropertyKey, unknown> = { trace: bindings.trace };
	if (bindings.request !== undefined) context.request = bindings.request;
	for (const capability of PROVIDER_CAPABILITY_KEYS) {
		if (!declaresCapability(provider, capability)) continue;
		const binding = bindings[capability];
		if (binding === undefined || binding === null) throw attachmentError(provider, capability);
		context[capability] = binding;
	}

	return new Proxy(context, {
		get(target, property, receiver) {
			if (
				typeof property === "string" &&
				CAPABILITY_KEY_SET.has(property) &&
				!declaresCapability(provider, property as ProviderCapabilityKey)
			) {
				throw undeclaredCapabilityError(provider, property as ProviderCapabilityKey);
			}
			return Reflect.get(target, property, receiver);
		},
		has(target, property) {
			if (typeof property === "string" && CAPABILITY_KEY_SET.has(property)) {
				return declaresCapability(provider, property as ProviderCapabilityKey);
			}
			return Reflect.has(target, property);
		},
	}) as ProviderContext<TDeclaration>;
}

/** Local engine attachment; deployed bridges implement the same interface with RPC clients. */
export function createInProcessProviderEngine(): ProviderEngine {
	return { attach: attachInProcess };
}
