import type ms from "ms";

import type { infer as ZodInfer, ZodType } from "zod";

/** Minimal Standard Schema v1 shape accepted by provider operations. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (
			value: unknown,
		) =>
			| StandardSchemaV1.Result<Output>
			| Promise<StandardSchemaV1.Result<Output>>;
		readonly types?: { readonly input: Input; readonly output: Output };
	};
}
export namespace StandardSchemaV1 {
	export interface Issue {
		readonly message: string;
		readonly path?: readonly (PropertyKey | PathSegment)[];
	}
	export interface PathSegment {
		readonly key: PropertyKey;
	}
	export interface SuccessResult<Output> {
		readonly value: Output;
	}
	export interface FailureResult {
		readonly issues: readonly Issue[];
	}
	export type Result<Output> = SuccessResult<Output> | FailureResult;
}
/** Schema formats supported by provider operations. */
export type SchemaLike = ZodType | StandardSchemaV1;
/** Infer the validated output type produced by a Zod or Standard Schema. */
export type InferSchemaOutput<TSchema extends SchemaLike> =
	TSchema extends ZodType
		? ZodInfer<TSchema>
		: TSchema extends StandardSchemaV1<unknown, infer Output>
			? Output
			: unknown;

export interface OperationInputExample {
	scenario: string;
	input: unknown;
	rationale?: string;
}

export type OperationRiskClass =
	| "read"
	| "write"
	| "destructive"
	| "external-send";

export type OperationApprovalPolicy = "never" | "risk-based" | "always";

export interface OperationToolRouterMetadata {
	/** Optional MCP-safe override. Defaults to providerId__operationId. */
	name?: string;
	/** Safety class exposed to Tool Router clients and approval policy. */
	riskClass?: OperationRiskClass;
	/** OpenAI remote-MCP approval hint. Defaults from riskClass. */
	approval?: OperationApprovalPolicy;
	/** Override connection requirement when provider auth + openWorld inference is insufficient. */
	requiresConnection?: boolean;
	/** Public argument used to resolve the tenant-owned connection. Defaults to externalRef. */
	connectionExternalRefParam?: string;
}

export type OperationSensitivePath = string;

export interface OperationObservabilitySensitiveConfig {
	/**
	 * Additional dot paths to redact from captured invocation inputs. Use `*`
	 * for array elements, for example `items.*.phone`.
	 */
	input?: readonly OperationSensitivePath[];
	/**
	 * Additional dot paths to redact from captured invocation outputs. Use `*`
	 * for array elements, for example `items.*.paymentUrl`.
	 */
	output?: readonly OperationSensitivePath[];
}

export interface OperationObservabilityConfig {
	/**
	 * Complements schema-level `fields.*()` / `sensitive()` metadata for values
	 * that are shape-dependent, provider-normalized, or otherwise easier to
	 * express as stable public paths.
	 */
	sensitive?: OperationObservabilitySensitiveConfig;
}

export interface OperationAnnotations {
	readOnly?: boolean;
	destructive?: boolean;
	idempotent?: boolean;
	/**
	 * Marks the operation as callable without provider-level authentication.
	 *
	 * Provider-level `auth.mode` describes the **majority** auth model of a
	 * provider; individual operations can still opt out via `openWorld: true`
	 * when their handler does not consume `ctx.credential`. This is the
	 * canonical way to declare "this operation is public, even though the
	 * provider is `credentials`-mode" without splitting the provider into two.
	 *
	 * Health-check projections treat `openWorld: true` operations as
	 * connection-free probes (no `requiresConnection` required, no SA token
	 * lookup). Future gateway work MAY extend this annotation to bypass
	 * `X-ApiFuse-Connection-Id` enforcement at proxy time.
	 *
	 * Example: Naver Map's `search`, `geocode`, and directions operations
	 * call public Naver endpoints with no cookies, while `collections` and
	 * `export` consume the user's session cookie — the provider declares
	 * `auth.mode: "credentials"` (for the latter) and the former mark
	 * `openWorld: true`.
	 */
	openWorld?: boolean;
	rateLimit?: {
		calls: number;
		window: "minute" | "hour" | "day";
	};
	timeoutMs?: number;
}

export const OPERATION_TIMEOUT_MS_MIN = 1;
export const OPERATION_TIMEOUT_MS_MAX = 60_000;

export const STREAM_HEARTBEAT_MS_MIN = 1_000;
export const STREAM_HEARTBEAT_MS_MAX = 60_000;
export const STREAM_IDLE_TIMEOUT_MS_MIN = 1_000;
export const STREAM_IDLE_TIMEOUT_MS_MAX = 300_000;
export const STREAM_MAX_DURATION_MS_MIN = 1_000;
export const STREAM_MAX_DURATION_MS_MAX = 1_800_000;
export const STREAM_CHUNK_BYTES_MIN = 1;
export const STREAM_CHUNK_BYTES_MAX = 1_048_576;

export type OperationTransportKind =
	| "json"
	| "sse"
	| "http-stream"
	| "websocket";

export interface OperationJsonTransport {
	kind: "json";
}

export interface OperationSseTransport {
	kind: "sse";
	heartbeatMs?: number;
	idleTimeoutMs?: number;
	maxDurationMs?: number;
	maxEventBytes?: number;
	resumable?: false | "last-event-id";
	events: Record<string, SchemaLike>;
}

export interface OperationHttpStreamTransport {
	kind: "http-stream";
	contentType?: string;
	idleTimeoutMs?: number;
	maxDurationMs?: number;
	maxChunkBytes?: number;
}

export interface OperationWebSocketTransport {
	kind: "websocket";
	subprotocols?: readonly string[];
	idleTimeoutMs?: number;
	maxDurationMs?: number;
	maxFrameBytes?: number;
	/**
	 * WebSocket Operation metadata is future-ready. Gateway dispatch remains
	 * disabled until a gateway-managed session implementation is present.
	 */
	dispatch: "unsupported";
}

export type OperationTransport =
	| OperationJsonTransport
	| OperationSseTransport
	| OperationHttpStreamTransport
	| OperationWebSocketTransport;

export const DEFAULT_OPERATION_TRANSPORT: OperationJsonTransport = {
	kind: "json",
};

export interface OperationRelationships {
	alternatives?: string[];
}

export type Iso3166Alpha2CountryCode = Uppercase<string>;
export type Bcp47Locale = string;
export type ProviderLocale = Bcp47Locale;
export type ProviderLocaleKey = string & {
	readonly __brand: "ProviderLocaleKey";
};
export type ProviderLocaleKeyInput = ProviderLocaleKey | string;
export type Iso8601Duration = string;
export type Rfc3339Instant = string;
export type IanaTimeZone = string;
export type Iso4217CurrencyCode = Uppercase<string>;
export type E164PhoneNumber = `+${string}`;

export type SmsOrigin =
	| {
			/** Sender represented as an ITU-T E.164 phone number. */
			kind: "e164";
			value: E164PhoneNumber;
			display?: string;
	  }
	| {
			/** Country-local service sender, for example KR 1661-5270. */
			kind: "nationalServiceCode";
			country: Iso3166Alpha2CountryCode;
			value: string;
			display?: string;
	  };

export interface SmsOtpExtractionPattern {
	/** RegExp or source string containing exactly one usable OTP capture. */
	pattern: RegExp | string;
	/** Named capture key or one-based numeric capture index. Defaults to first capture. */
	capture?: string | number;
}

export interface SmsOtpMatcherDefinition {
	id: string;
	country: Iso3166Alpha2CountryCode;
	locale?: Bcp47Locale;
	phoneNumber?: E164PhoneNumber;
	origins: readonly [SmsOrigin, ...SmsOrigin[]];
	code: SmsOtpExtractionPattern;
	maxAge: Iso8601Duration;
	waitTimeout: Iso8601Duration;
	clockSkew?: Iso8601Duration;
	/** Runtime/fixture helper. Not serialized into generated registry artifacts. */
	extractOtp(body: string): string | null;
}

export type SttTranscribeMode = "general" | "otp";
export type SttPromptPolicy = "none" | "default-hint" | "custom-hint";
export type SttUnsupportedOptionPolicy = "warn" | "error";
export type ProviderSttMode = "optional" | "required";

export interface ProviderSttConfig {
	mode: ProviderSttMode;
}

export type SttAudioInput = {
	kind: "base64";
	data: string;
	mediaType?: string;
	durationMs?: number;
};

export interface SttVerificationCodeOptions {
	locale?: Bcp47Locale;
	codeLengths?: number | readonly number[] | { min: number; max: number };
}

export interface SttTranscribeRequest {
	audio: SttAudioInput;
	language?: Bcp47Locale;
	mode?: SttTranscribeMode;
	promptPolicy?: SttPromptPolicy;
	initialPrompt?: string;
	unsupportedOptionPolicy?: SttUnsupportedOptionPolicy;
	verificationCode?: SttVerificationCodeOptions;
	timeoutMs?: number;
	maxAudioBytes?: number;
}

export interface SttSegment {
	text: string;
	startMs?: number;
	endMs?: number;
	confidence?: number;
}

export interface SttUsage {
	audioDurationMs?: number;
	audioBytes?: number;
	billableUnits?: number;
}

export interface SttWarning {
	code: "UNSUPPORTED_STT_OPTION" | "PROMPT_IGNORED" | "LOCALE_PARTIAL";
	message: string;
}

export interface SttTranscript {
	text: string;
	language?: Bcp47Locale;
	durationMs?: number;
	segments?: readonly SttSegment[];
	usage?: SttUsage;
	warnings?: readonly SttWarning[];
	verificationCode?: VerificationCodeExtractionResult;
}

export type VerificationCodeCandidateSource =
	| "digits"
	| "spoken_words"
	| "mixed";

export interface VerificationCodeCandidate {
	code: string;
	source: VerificationCodeCandidateSource;
	startIndex?: number;
	endIndex?: number;
}

export interface VerificationCodeExtractionResult {
	code: string;
	candidates: readonly VerificationCodeCandidate[];
	normalizedText: string;
}

export interface SttContext {
	transcribe(request: SttTranscribeRequest): Promise<SttTranscript>;
	extractVerificationCode(
		text: string,
		options?: SttVerificationCodeOptions,
	): VerificationCodeExtractionResult;
}

export interface HealthJourneySchedule {
	kind: "interval";
	/** ISO 8601 duration, for example PT8H. */
	interval: Iso8601Duration;
	jitter?: Iso8601Duration;
}

export interface HealthJourneyStep {
	id: string;
	description?: string;
	operationId?: string;
	usesSmsMatcher?: string;
	coversOperations?: readonly string[];
	safeBoundary?: "paymentWebviewUrl" | "paymentUrl" | "none";
	kind?: "operation" | "smsOtp" | "assertion" | "journal";
}

export interface HealthJourneyGatewayContext {
	connect?(options?: {
		providerId?: string;
		externalRef?: string;
		authMode?: "credentials" | "oauth2";
		input?: Record<string, unknown>;
		metadata?: Record<string, unknown>;
	}): Promise<{ connectionId: string; rowVersion: number }>;
	disconnect?(connection: {
		connectionId: string;
		rowVersion: number;
	}): Promise<void>;
	execute(
		providerId: string,
		operationId: string,
		input: unknown,
		options?: {
			connectionId?: string;
			requestId?: string;
			/**
			 * Set false when the journey will record the semantic operation
			 * outcome itself through `ctx.event.operation()`. Transport success
			 * must not become a competing public health sample in that case.
			 */
			recordOperationEvent?: boolean;
		},
	): Promise<{
		data: unknown;
		status: number;
		duration: number;
		meta?: Record<string, unknown>;
	}>;
}

export interface SmsPhoneIdentity {
	id: string;
	country: Iso3166Alpha2CountryCode | string;
	e164: E164PhoneNumber | string;
	nationalNumber: string;
	displayName?: string;
}

export interface HealthJourneySmsContext {
	resolvePhone(params?: { matcherId?: string }): Promise<SmsPhoneIdentity>;
	waitForOtp(params: {
		matcherId: string;
		attemptId: string;
		phoneId?: string;
		phoneNumber?: string;
		signal?: AbortSignal;
	}): Promise<{ code: string; messageId: string; receivedAt: string }>;
}

export interface HealthJourneyJournalContext {
	sideEffect<T>(params: {
		stepId: string;
		kind: string;
		idempotencyKey: string;
		run: () => Promise<T>;
	}): Promise<T>;
}

export interface HealthJourneyEventContext {
	/**
	 * Record an operation-level health outcome that was proven by the journey but
	 * not emitted by a direct `ctx.gateway.execute()` call, such as a recovery or
	 * manual-review assertion. This is intentionally narrow; it is not a generic
	 * event bus.
	 */
	operation(params: {
		operationId: string;
		status: "ok" | "degraded" | "down" | "unknown" | "not_reached";
		stepId?: string;
		label?: string;
		error?: string;
		latencyMs?: number;
		statusCode?: number;
		metadata?: Record<string, unknown>;
	}): Promise<void>;
}

export interface HealthJourneyRunContext {
	attemptId: string;
	providerId: string;
	journeyId: string;
	gateway: HealthJourneyGatewayContext;
	sms: HealthJourneySmsContext;
	journal: HealthJourneyJournalContext;
	state: ProviderRuntimeState;
	event: HealthJourneyEventContext;
	signal: AbortSignal;
	secrets: Record<string, string | undefined>;
}

export type HealthJourneyManualTriggerPolicy =
	| { enabled: false; reason?: string }
	| {
			enabled: true;
			requiresAcknowledgement: boolean;
			risk: "read_only" | "writes_external_state" | "sms_or_payment";
			/** ISO 8601 duration. Minimum time between manual executions. */
			minManualInterval: Iso8601Duration;
			publicRationale: string;
	  };

export interface HealthJourneyRunResult {
	status?: "ok" | "degraded" | "down" | "unknown";
	label?: string;
	metadata?: Record<string, unknown>;
}

export interface HealthJourneyDefinition {
	id: string;
	title?: string;
	description?: string;
	schedule: HealthJourneySchedule;
	coversOperations: readonly [string, ...string[]];
	timeout?: Iso8601Duration;
	cooldown?: Iso8601Duration;
	smsMatchers?: readonly SmsOtpMatcherDefinition[];
	requiredSecrets?: readonly string[];
	manualTrigger?: HealthJourneyManualTriggerPolicy;
	steps: readonly [HealthJourneyStep, ...HealthJourneyStep[]];
	run?: (
		ctx: HealthJourneyRunContext,
	) => Promise<HealthJourneyRunResult | undefined>;
}

/**
 * Health-check authoring surface owned by `@apifuse/provider-sdk`.
 *
 * IMPORTANT (architectural invariant): These types are PURE DATA + assertion
 * lambdas. They MUST NOT import or reference any health-monitor runtime
 * surface (scheduler, recorder, gateway client, registry projection types).
 * Provider declarations remain runtime-agnostic at build time.
 *
 * See `openspec/changes/enforce-sdk-operation-health-suite/design.md` §D1.
 */

/** Polling interval duration accepted by the health-monitor runtime. */
export type ProbeInterval = ms.StringValue;

/**
 * Common probe interval examples retained for discoverability/backwards
 * compatibility. This list is not exhaustive; any positive `ms`-style duration
 * string accepted by `@types/ms` (for example `2m`, `8h`, or `1 day`) is valid.
 */
export const PROBE_INTERVALS: readonly ProbeInterval[] = [
	"30s",
	"1m",
	"3m",
	"5m",
	"15m",
	"30m",
	"1h",
	"2h",
	"8h",
	"24h",
] as const;

export const HEALTH_CHECK_TIMEOUT_MS_MIN = 1;
export const HEALTH_CHECK_TIMEOUT_MS_MAX = 60_000;
export const HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MIN = 1;
export const HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MAX = 60_000;

/**
 * Context passed to a `HealthCheckCase.assertions` lambda.
 * `data` is typed against the operation's declared output schema (TOutput).
 */
export interface HealthCheckAssertionContext<TOutput = unknown> {
	/** Parsed response body (already validated against operation.output). */
	readonly data: TOutput;
	/** HTTP status code returned by the gateway. */
	readonly status: number;
	/** Wall-clock duration of the operation invocation, in milliseconds. */
	readonly durationMs: number;
	/** Optional provider response metadata such as cache hit/stale flags. */
	readonly meta?: Record<string, unknown>;
}

export interface HealthCheckInputPreparationContext<TInput = unknown> {
	readonly providerId: string;
	readonly operationId: string;
	readonly input: TInput;
	readonly connectionId?: string;
	readonly gateway: {
		execute: (
			providerId: string,
			operationId: string,
			input: unknown,
			options?: { connectionId?: string },
		) => Promise<{
			status: number;
			duration: number;
			data: unknown;
			meta?: Record<string, unknown>;
		}>;
	};
}

/**
 * Optional return value from an assertions lambda. Allows the case to
 * downgrade to "degraded" without throwing, and to attach a human-friendly
 * label that surfaces on the status page (e.g., "BTC 95,000,000원").
 */
export interface HealthCheckCaseResult {
	/** Override final status; if omitted, "ok" unless assertion threw. */
	status?: "ok" | "degraded";
	/** Optional human-readable label surfaced on the status page. */
	label?: string;
}

/**
 * A single test-case-style verification scenario for an operation.
 *
 * Type parameters flow from the OperationDefinition's input/output schemas
 * so authors get IntelliSense and compile-time errors when accessing fields
 * that do not exist on the operation's declared output schema.
 */
export interface HealthCheckCase<TInput = unknown, TOutput = unknown> {
	/** Human-readable case name; unique within the suite. */
	name: string;
	/** Optional longer description shown on ops dashboards. */
	description?: string;
	/** Input passed to the operation handler for this case. */
	input: TInput;
	/**
	 * Optional runtime input preparation hook for volatile probes. Use this when
	 * the durable probe input must be derived from a live read-only operation
	 * immediately before the checked operation executes.
	 */
	prepareInput?: (
		ctx: HealthCheckInputPreparationContext<TInput>,
	) => TInput | Promise<TInput>;
	/**
	 * Assertion executed against the operation's response and timing.
	 *
	 * - Throw to fail the case (recorded as `down`).
	 * - Return `{ status: "degraded", label }` to flag without failing.
	 * - Return `void` (implicit) for `ok`.
	 *
	 * MUST NOT access scheduler, recorder, or any runtime type — pure data
	 * + lambda only.
	 */
	assertions: (
		ctx: HealthCheckAssertionContext<TOutput>,
	) =>
		| void
		| Promise<void>
		| HealthCheckCaseResult
		| Promise<HealthCheckCaseResult>;
	/** Override per-case degradation threshold (ms); falls back to the suite default. */
	degradedThresholdMs?: number;
	/** Override per-case timeout in milliseconds; falls back to the suite/provider/runtime default. */
	timeoutMs?: number;
	/** Expected outcome for "negative" cases (e.g., expecting a degraded baseline). Default: `"ok"`. */
	expectedStatus?: "ok" | "degraded";
	/** Runtime gate (env-driven); if returns false the case is skipped & logged. */
	enabled?: () => boolean;
}

/**
 * Operation-level health-check suite. At least one case is required when
 * present. All cases share the suite's interval and default timeout.
 */
export interface HealthCheckSuite<TInput = unknown, TOutput = unknown> {
	/** Polling interval for the suite. All cases share this cadence. */
	interval: ProbeInterval;
	/** Per-case timeout in milliseconds. Default: 30000. */
	timeoutMs?: number;
	/** Default degradation threshold for cases in this suite. Default: runtime threshold. */
	degradedThresholdMs?: number;
	/** Non-empty list of cases. Empty arrays are rejected at definition time. */
	cases: [
		HealthCheckCase<TInput, TOutput>,
		...HealthCheckCase<TInput, TOutput>[],
	];
	/**
	 * If true, the runtime SHALL invoke `connect()` before `execute()` and
	 * `disconnect()` after, using the service-account token. The provider
	 * MUST also declare `healthMonitor.requiredSecrets` for the env values
	 * the connect ceremony will consume.
	 */
	requiresConnection?: boolean;
}

/**
 * Explicit, audited opt-out for operations that genuinely cannot be probed
 * (e.g., destructive mutations, paid-per-call flows). Either `healthCheck`
 * or `healthCheckUnsupported` SHALL be present on every operation; missing
 * both is a registry-build error.
 */
export interface HealthCheckUnsupported {
	/** Human-readable explanation. Required, non-empty. */
	reason: string;
	/** Optional issue/PR url that revisits the decision. */
	trackedIn?: string;
}

/**
 * Provider-level monitoring metadata for credential-bearing health checks.
 * Describes ONLY env-secret keys the runtime needs and the service account
 * to use; SHALL NOT carry probe schedules, sample inputs, or assertion
 * logic (those remain on `OperationDefinition.healthCheck`).
 */
export interface ProviderHealthMonitorConfig {
	/**
	 * Provider-wide default probe timeout in milliseconds. Individual
	 * `healthCheck.timeoutMs` and `healthCheck.cases[].timeoutMs` values take
	 * precedence. Defaults to the monitor runtime default.
	 */
	defaultProbeTimeoutMs?: number;
	/**
	 * Provider-wide default latency threshold in milliseconds before an
	 * otherwise successful probe is marked degraded. Suite/case thresholds take
	 * precedence. Defaults to the monitor runtime default.
	 */
	defaultDegradedThresholdMs?: number;
	/**
	 * Env-secret key names (e.g., "APIFUSE__HEALTH_MONITOR__CATCHTABLE_PHONE") the
	 * synthetic-monitor runtime needs to execute probes that declare
	 * `requiresConnection: true`.
	 */
	requiredSecrets?: string[];
	/**
	 * Mapping from provider auth ceremony input fields to runtime env-secret
	 * names. The health-monitor uses this to create a fresh connection for
	 * `requiresConnection: true` probes, then disconnects after execution.
	 */
	credentialInputs?: Record<string, string>;
	/**
	 * Runtime probe overrides keyed by generated registry probe id. Use this for
	 * operation health checks that need a runtime-specific interval or threshold
	 * without changing the provider-authored default suite.
	 */
	probeOverrides?: Record<string, HealthMonitorProbeOverride>;
	/**
	 * Override the default service account ID for this provider's probes.
	 * Defaults to the runtime's `APIFUSE__HEALTH_MONITOR__SERVICE_ACCOUNT_ID` env var.
	 */
	serviceAccount?: string;
}

export interface HealthMonitorProbeOverride {
	/** Optional runtime interval override as a positive `ms`-style duration string. */
	interval?: ProbeInterval;
	/** Optional timeout override for generated registry probes. */
	timeoutMs?: number;
	/** Optional degraded threshold override for generated registry probes. */
	degradedThresholdMs?: number;
}

export interface OperationErrorCode {
	code: string;
	status?: number;
	description: string;
	retryable?: boolean;
}

export interface OperationDocMeta {
	titleKey?: ProviderLocaleKeyInput;
	descriptionKey?: ProviderLocaleKeyInput;
	summaryKey?: ProviderLocaleKeyInput;
	markdownKey?: ProviderLocaleKeyInput;
	normalizationNotesKeys?: ProviderLocaleKeyInput[];
	requestExample?: Record<string, unknown>;
	responseExample?: unknown;
	errorCodes?: OperationErrorCode[];
}

export type StealthPlatform = "macos" | "windows" | "linux" | "android" | "ios";

export type BrowserEngine = "playwright-stealth" | "nodriver" | "selenium-uc";
export interface BrowserOptions {
	headless?: boolean;
	stealth?: boolean;
	proxy?: string;
	engine?: BrowserEngine;
	requireCdpPool?: boolean;
}

export interface StealthProfile {
	name: string;
	platform: StealthPlatform;
	version: string;
	userAgent: string;
	tlsClientIdentifier?: string;
	ja3?: string;
	ja4?: string;
	h2Settings?: Record<string, unknown>;
	headerOrder?: string[];
}

export type AuthMode = "none" | "platform-managed" | "credentials" | "oauth2";

export type ConnectionMode = AuthMode;

export type ProviderReviewed = "first-party" | "community" | "staging";

export type ProviderAccessVisibility = "public" | "early_access";

export type ProviderProxyMode = "disabled" | "optional" | "required";

export type ProviderProxyProvider = "smartproxy" | "decodo" | "custom";

export type ProviderProxySessionAffinity =
	| "request"
	| "operation"
	| "auth-flow"
	| "connection";

export interface ProviderProxyPolicy {
	/**
	 * Provider intent only. Transport details such as raw CONNECT, origin
	 * certificate verification, and vendor allocator endpoints are SDK-owned.
	 */
	mode: ProviderProxyMode;
	provider?: ProviderProxyProvider;
	geo?: {
		/** ISO 3166-1 alpha-2 country code, for example KR or US. */
		country?: Iso3166Alpha2CountryCode;
		subdivision?: string;
		city?: string;
	};
	session?: {
		affinity?: ProviderProxySessionAffinity;
		lifetimeMinutes?: number;
		poolSize?: number;
	};
}

export type ProviderProxyConfig = boolean | ProviderProxyPolicy;

export interface ProviderAccessConfig {
	/**
	 * Provider-level rollout visibility.
	 *
	 * - `public`: visible in public docs/catalog/OpenAPI and callable through
	 *   the existing provider policy stack.
	 * - `early_access`: hidden from public discovery and callable only when the
	 *   active customer organization has a provider-level access grant.
	 *
	 * This is intentionally provider-level only. It does not alter auth mode,
	 * operation schemas, health-check authoring, `openWorld`, or Connection
	 * requirements.
	 */
	visibility?: ProviderAccessVisibility;
}

export type ProviderLogoSource = "asset" | "monogram" | "none";

export type ProviderLogoProfile =
	| {
			source: "asset";
			path: string;
			/**
			 * Absolute, customer-renderable URL emitted by discovery projections.
			 * Provider source definitions may omit this and let the registry projection
			 * derive it from the committed public asset path.
			 */
			url?: string;
			background?: string;
	  }
	| {
			source: "monogram" | "none";
			background?: string;
			fallbackReason: string;
	  };

export type ProviderPublicConnectionMode =
	| "apifuse_managed"
	| "workspace_enabled"
	| "user_connected"
	| "no_connection_required";

export type ProviderSupportLevel = "stable" | "beta" | "experimental";

export interface ProviderPublicProfile {
	displayNameKey?: ProviderLocaleKeyInput;
	shortDescriptionKey?: ProviderLocaleKeyInput;
	longDescriptionKey?: ProviderLocaleKeyInput;
	logo?: ProviderLogoProfile;
	category?: string;
	tags?: readonly string[];
	capabilityKeys?: readonly ProviderLocaleKeyInput[];
	examplePromptKeys?: readonly ProviderLocaleKeyInput[];
	setupSummaryKey?: ProviderLocaleKeyInput;
	connectionMode?: ProviderPublicConnectionMode;
	requirementKeys?: readonly ProviderLocaleKeyInput[];
	limitationKeys?: readonly ProviderLocaleKeyInput[];
	availability?: {
		regions?: readonly string[];
		supportLevel?: ProviderSupportLevel;
	};
	/**
	 * Brand primary color as a 6-digit hex string (e.g. "#1a73e8").
	 * Single source of truth for all provider-specific color expressions
	 * (mood wash, monogram fallback, icon tint). The UI derives subtle washes
	 * via color-mix; provider definitions do not control mood percentages.
	 */
	primaryColor?: string;
}

export interface ProviderMeta {
	displayName: string;
	displayNameKey?: ProviderLocaleKeyInput;
	descriptionKey: ProviderLocaleKeyInput;
	category: string;
	tags?: readonly string[];
	icon?: string;
	docTitleKey?: ProviderLocaleKeyInput;
	docDescriptionKey?: ProviderLocaleKeyInput;
	docSummaryKey?: ProviderLocaleKeyInput;
	docMarkdownKey?: ProviderLocaleKeyInput;
	normalizationNotesKeys?: readonly ProviderLocaleKeyInput[];
	environment?: "staging";
	purpose?: string;
	purposeKey?: ProviderLocaleKeyInput;
	publicProfile?: ProviderPublicProfile;
	contract?: {
		publicSchemaFieldNames?: "normalized";
	};
}

export type RequestParamPrimitive =
	| string
	| number
	| boolean
	| null
	| undefined;
export type RequestParamValue =
	| RequestParamPrimitive
	| readonly RequestParamPrimitive[];
export type RequestParams = Record<string, RequestParamValue>;

export const HttpRetryPreset = {
	Off: "off",
	TransportTransient: "transport_transient",
	SafeRead: "safe_read",
	AggressiveRead: "aggressive_read",
	RateLimitAware: "rate_limit_aware",
} as const;
export type HttpRetryPreset =
	(typeof HttpRetryPreset)[keyof typeof HttpRetryPreset];

export const HttpRetryJitter = {
	None: "none",
	Full: "full",
	Equal: "equal",
} as const;
export type HttpRetryJitter =
	(typeof HttpRetryJitter)[keyof typeof HttpRetryJitter];

export const HttpRetryDelayStrategy = {
	Fixed: "fixed",
	Exponential: "exponential",
} as const;
export type HttpRetryDelayStrategy =
	(typeof HttpRetryDelayStrategy)[keyof typeof HttpRetryDelayStrategy];

export const HttpRetryAfterPolicy = {
	Ignore: "ignore",
	/** Honor Retry-After up to maxDelayMs. */
	Respect: "respect",
	/** Honor Retry-After but also cap it to the SDK-computed backoff delay. */
	Cap: "cap",
} as const;
export type HttpRetryAfterPolicy =
	(typeof HttpRetryAfterPolicy)[keyof typeof HttpRetryAfterPolicy];

export const HttpRetryUnsafeMethodPolicy = {
	Reject: "reject",
	AllowExplicitUnsafe: "allow_explicit_unsafe",
} as const;
export type HttpRetryUnsafeMethodPolicy =
	(typeof HttpRetryUnsafeMethodPolicy)[keyof typeof HttpRetryUnsafeMethodPolicy];

export interface HttpRetryOptions {
	preset?: HttpRetryPreset;
	/** Total logical ctx.http attempts, including the first attempt. */
	attempts?: number;
	methods?: readonly HttpMethod[];
	statusCodes?: readonly number[];
	errorCodes?: readonly string[];
	delayStrategy?: HttpRetryDelayStrategy;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitter?: HttpRetryJitter;
	retryAfter?: HttpRetryAfterPolicy;
	unsafeMethodPolicy?: HttpRetryUnsafeMethodPolicy;
}

export interface HttpRetrySummary {
	attempts: number;
	retries: number;
	preset?: HttpRetryPreset;
	transport: "native";
	lastErrorCode?: string;
	lastStatus?: number;
}

export interface RequestOptions {
	headers?: Record<string, string>;
	params?: RequestParams;
	proxy?: string;
	timeout?: number;
	/**
	 * Defaults to true. Set to false when callers need to inspect upstream
	 * non-2xx bodies themselves instead of converting them to TransportError.
	 */
	throwOnHttpError?: boolean;
	retry?: boolean | HttpRetryPreset | HttpRetryOptions;
}

export type HttpMethod =
	| "HEAD"
	| "head"
	| "GET"
	| "get"
	| "POST"
	| "post"
	| "PUT"
	| "put"
	| "DELETE"
	| "delete"
	| "OPTIONS"
	| "options"
	| "TRACE"
	| "trace"
	| "PATCH"
	| "patch";

export interface StealthFetchOptions extends RequestOptions {
	method?: HttpMethod;
	body?: string | Buffer;
	redirect?: "follow" | "manual" | "error";
	/**
	 * Offsets policy-managed proxy pool selection for caller-managed retries.
	 * Use when a request receives an upstream challenge page rather than a
	 * transport error, so the next logical retry does not restart at the same
	 * operation-affinity proxy.
	 */
	proxyAttemptOffset?: number;
	/** Override the configured browser-like stealth profile for this request. */
	profile?: string;
	/**
	 * Stealth transport certificate controls. Use only for proxy products that
	 * terminate CONNECT with a private CA instead of tunneling the origin
	 * certificate chain.
	 */
	stealth?: {
		insecureSkipVerify?: boolean;
	};
}

export interface CookieJar {
	get(name: string): string | undefined;
	getAll(): Record<string, string>;
	toString(): string;
	find?(predicate: (cookie: string) => boolean): string | undefined;
}

export interface StealthSessionCookies extends CookieJar {
	has(name: string): boolean;
	setFromCookieStrings(cookieStrings: readonly string[]): void;
	toHeader(): string;
	snapshot(): Record<string, string>;
	restore(cookies: Record<string, string>): void;
	clear(): void;
}

export interface DeclarativeStealthResponse {
	status: number;
	ok: boolean;
	url?: string;
	redirected?: boolean;
	headers: Record<string, string>;
	rawHeaders: [string, string][];
	body: string;
	httpVersion?: string;
	tlsInfo?: { protocol?: string; cipher?: string; [key: string]: unknown };
	cookies: CookieJar;
	json<T>(): Promise<T>;
	arrayBuffer(): Promise<ArrayBuffer>;
	bytes(): Promise<Uint8Array>;
}

export type StealthResponse = DeclarativeStealthResponse;

export type RequestWithMethodOptions = RequestOptions & {
	method?: string;
	body?: unknown;
};

export interface StealthRedirectHop {
	url: string;
	status: number;
	method: string;
	location?: string;
	nextUrl?: string;
}

export interface StealthRedirectRunOptions
	extends Omit<StealthFetchOptions, "redirect"> {
	url: string;
	maxHops?: number;
	stopWhen?: (hop: StealthRedirectHop) => boolean | Promise<boolean>;
}

export interface StealthRedirectRunResult {
	final: StealthResponse;
	hops: StealthRedirectHop[];
	reason: "completed" | "stopped" | "max_hops" | "missing_location" | "loop";
	cookies: Record<string, string>;
}

export interface StealthSession {
	fetch(url: string, options?: StealthFetchOptions): Promise<StealthResponse>;
	cookies: StealthSessionCookies;
	redirects: {
		run(options: StealthRedirectRunOptions): Promise<StealthRedirectRunResult>;
	};
	close(): void;
}

export interface ApiFuseResponse<T> {
	data: T;
	meta: {
		requestId: string;
		duration: number;
		cached?: boolean;
		stale?: boolean;
		cache?: ProviderCacheResponseMeta;
		retry?: HttpRetrySummary;
	};
}

export interface HttpResponse<T = unknown> {
	status: number;
	ok: boolean;
	headers: Record<string, string>;
	data: T;
	json<U = T>(): Promise<U>;
	text(): Promise<string>;
}

export interface HttpStreamResponse {
	status: number;
	ok: boolean;
	headers: Record<string, string>;
	body: ReadableStream<Uint8Array>;
	bytes(): AsyncIterable<Uint8Array>;
	textChunks(): AsyncIterable<string>;
	lines(): AsyncIterable<string>;
}

export interface SseMessage {
	event: string;
	data: string;
	id?: string;
	retry?: number;
	json<T = unknown>(): T;
}

export interface ProviderStreamEvent<TData = unknown> {
	event: string;
	data: TData;
	id?: string;
	retry?: number;
}

export type OperationHandlerResult<TOutput> =
	| TOutput
	| Response
	| ReadableStream<Uint8Array>
	| AsyncIterable<ProviderStreamEvent>;

export interface HttpClient {
	request(url: string, opts?: RequestWithMethodOptions): Promise<HttpResponse>;
	get(url: string, options?: RequestOptions): Promise<HttpResponse>;
	post(
		url: string,
		body: unknown,
		options?: RequestOptions,
	): Promise<HttpResponse>;
	put(
		url: string,
		body: unknown,
		options?: RequestOptions,
	): Promise<HttpResponse>;
	delete(url: string, options?: RequestOptions): Promise<HttpResponse>;
	stream(
		url: string,
		options?: RequestWithMethodOptions,
	): Promise<HttpStreamResponse>;
	sse(
		url: string,
		options?: RequestWithMethodOptions,
	): Promise<AsyncIterable<SseMessage>>;
}

export interface ProviderCacheKeyOptions {
	/**
	 * Additional field names to omit from stable key material. The SDK always
	 * omits known secret-bearing names such as serviceKey, authorization,
	 * cookie, token, password, and secret.
	 */
	redactFields?: string[];
}

export interface ProviderCacheGetOrSetOptions {
	/** Freshness TTL. A fresh hit returns without calling the loader. */
	ttlMs: number;
	/**
	 * Optional stale window after ttlMs. If the loader fails while the entry is
	 * still inside this window, stale data is returned and marked stale.
	 */
	staleIfErrorMs?: number;
	/** Optional jitter applied to writes to avoid synchronized expiry. */
	jitterPct?: number;
}

export interface ProviderCacheLookupMeta {
	key: string;
	hit: boolean;
	stale: boolean;
	ageMs?: number;
	source: "redis" | "memory" | "loader";
}

export interface ProviderCacheResult<T> {
	value: T;
	meta: ProviderCacheLookupMeta;
}

export interface ProviderCacheResponseMeta {
	hit: boolean;
	stale: boolean;
	keys: string[];
	source?: "redis" | "memory" | "loader" | "mixed";
}

export interface ProviderCache {
	key(
		namespace: string,
		parts: unknown,
		options?: ProviderCacheKeyOptions,
	): string;
	get<T = unknown>(key: string): Promise<ProviderCacheResult<T> | null>;
	set<T = unknown>(
		key: string,
		value: T,
		options: ProviderCacheGetOrSetOptions,
	): Promise<void>;
	delete(key: string): Promise<void>;
	getOrSet<T = unknown>(
		key: string,
		loader: () => Promise<T>,
		options: ProviderCacheGetOrSetOptions,
	): Promise<ProviderCacheResult<T>>;
	responseMeta(): ProviderCacheResponseMeta | undefined;
}

export interface StealthClient {
	fetch(url: string, options?: StealthFetchOptions): Promise<StealthResponse>;
	createSession(opts?: { profile?: string }): StealthSession;
	close?(): void;
}

export interface BrowserClient {
	readonly engine: BrowserEngine;
	close?(): Promise<void>;
	newPage(): Promise<BrowserPage>;
	rawPage(): Promise<BrowserPage>;
	withIsolatedContext<T>(
		handler: (page: BrowserPage) => Promise<T>,
	): Promise<T>;
	solveChallenge(
		request: BrowserChallengeRequest,
	): Promise<BrowserChallengeResult>;
}

export interface BrowserLocator {
	click(): Promise<void>;
	fill(text: string): Promise<void>;
	textContent(): Promise<string | null>;
	waitFor(options?: { timeout?: number }): Promise<void>;
}

export interface BrowserFrame {
	id: string;
	name?: string;
	parentId?: string;
	url(): Promise<string>;
	title(): Promise<string>;
	content(): Promise<string>;
	evaluate<T>(fn: string | (() => T)): Promise<T>;
	locator(selector: string): BrowserLocator;
}

export interface BrowserPage extends BrowserFrame {
	close(): Promise<void>;
	fill(selector: string, text: string): Promise<void>;
	goto(url: string): Promise<void>;
	pageId?: string;
	screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
	click(selector: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	waitForSelector(
		selector: string,
		options?: { timeout?: number },
	): Promise<void>;
	frames(): Promise<BrowserFrame[]>;
}

export type BrowserChallengeRequest = {
	type: "recaptcha";
	siteKey?: string;
	timeout?: number;
};

export type BrowserChallengeResult = {
	type: BrowserChallengeRequest["type"];
	solved: boolean;
	frameUrl?: string;
};

export type TraceAttributeValue = string | number | boolean;

export interface TraceSpan {
	id: string;
	name: string;
	startedAt: number;
	endedAt: number;
	duration_ms: number;
	status: "ok" | "error";
	error?: string;
	attributes: Record<string, TraceAttributeValue>;
	parentId?: string;
}

export interface TraceConfig {
	enabled?: boolean;
	maxSpans?: number;
	onSpan?: (span: TraceSpan) => void;
	exporter?: "console" | "json" | "otlp" | "none";
	endpoint?: string;
	otlp?: {
		endpoint: string;
		headers?: Record<string, string>;
		timeout?: number;
	};
}

export interface TraceContext {
	span<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface AuthContext {
	requestField(
		name: string,
		options?: { type?: "otp" | "text" },
	): Promise<string>;
}

export interface EnvContext {
	get(key: string): string | undefined;
}

export interface CredentialContext {
	mode: AuthMode;
	get(key: string): string | undefined;
	getAll(): Record<string, string>;
	getAccessToken(): string | undefined;
	getScopes(): string[];
}

export interface ProviderRequestContext {
	connectionId?: string;
	headers: Record<string, string>;
}

export interface ProviderChoiceBindingOptions {
	connection?: boolean;
	credentialKeys?: readonly string[];
}

export type ProviderChoiceStorageOptions =
	| {
			readonly mode: "inline";
	  }
	| {
			readonly mode: "server";
			readonly namespace: string;
			readonly state?: ProviderRuntimeState;
			readonly ttl?: ProviderStateDurationString;
			readonly maxEntries: number;
			readonly maxValueBytes: number;
			readonly unavailable?: "reject";
	  }
	| {
			readonly mode: "auto";
			readonly namespace: string;
			readonly state?: ProviderRuntimeState;
			readonly ttl?: ProviderStateDurationString;
			readonly maxInlineBytes: number;
			readonly maxEntries: number;
			readonly maxValueBytes: number;
			readonly unavailable?: "reject";
	  };

export interface ProviderChoiceIssueOptions<
	TPayload extends Record<string, unknown>,
> {
	prefix: string;
	purpose: string;
	payload: TPayload;
	ttlMs: number;
	nowMs?: number;
	bind?: ProviderChoiceBindingOptions;
	storage?: ProviderChoiceStorageOptions;
}

export interface ProviderChoiceParseOptions {
	token: string;
	prefix: string;
	purpose: string;
	ttlMs?: number;
	nowMs?: number;
	futureToleranceMs?: number;
	bind?: ProviderChoiceBindingOptions;
	storage?: ProviderChoiceStorageOptions;
}

export interface ProviderChoiceContext {
	issue<TPayload extends Record<string, unknown>>(
		options: ProviderChoiceIssueOptions<TPayload> & {
			readonly storage?: { readonly mode: "inline" };
		},
	): string;
	issue<TPayload extends Record<string, unknown>>(
		options: ProviderChoiceIssueOptions<TPayload> & {
			readonly storage: Extract<
				ProviderChoiceStorageOptions,
				{ readonly mode: "server" }
			>;
		},
	): Promise<string>;
	issue<TPayload extends Record<string, unknown>>(
		options: ProviderChoiceIssueOptions<TPayload> & {
			readonly storage: Extract<
				ProviderChoiceStorageOptions,
				{ readonly mode: "auto" }
			>;
		},
	): string | Promise<string>;
	issue<TPayload extends Record<string, unknown>>(
		options: ProviderChoiceIssueOptions<TPayload>,
	): string | Promise<string>;
	parse(
		options: ProviderChoiceParseOptions & {
			readonly storage?: { readonly mode: "inline" };
		},
	): Record<string, unknown>;
	parse(
		options: ProviderChoiceParseOptions & {
			readonly storage: Extract<
				ProviderChoiceStorageOptions,
				{ readonly mode: "server" }
			>;
		},
	): Promise<Record<string, unknown>>;
	parse(
		options: ProviderChoiceParseOptions & {
			readonly storage: Extract<
				ProviderChoiceStorageOptions,
				{ readonly mode: "auto" }
			>;
		},
	): Record<string, unknown> | Promise<Record<string, unknown>>;
	parse(options: ProviderChoiceParseOptions): Record<string, unknown>;
}

export interface ContextScratchpad {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	toJSON(): Record<string, unknown>;
}

export type FlowContextStore = ContextScratchpad;

export type AuthSafeJson =
	| string
	| number
	| boolean
	| null
	| readonly AuthSafeJson[]
	| { readonly [key: string]: AuthSafeJson };

export type AuthSafeData = { readonly [key: string]: AuthSafeJson };

export type AuthAbortRetry = "never" | "retry" | "after_user_action";

export type AuthAbortData = Record<string, unknown> & {
	readonly code: string;
	readonly message?: string;
	readonly retry?: AuthAbortRetry;
	readonly actionHint?: AuthSafeJson;
	readonly fieldErrors?: { readonly [field: string]: string };
	readonly details?: AuthSafeData;
};

export interface AuthFlowTerminalContext {
	readonly signal?: AbortSignal;
	readonly deadline?: string;
	complete<TCredential extends Record<string, string>>(options: {
		readonly credential: TCredential;
		readonly metadata?: AuthSafeData;
		readonly data?: AuthSafeData;
		readonly turnId?: string;
		readonly expiresAt?: string;
	}): AuthTurn;
	abort(options: {
		readonly code: string;
		readonly message?: string;
		readonly retry?: AuthAbortRetry;
		readonly actionHint?: AuthSafeJson;
		readonly fieldErrors?: { readonly [field: string]: string };
		readonly data?: AuthSafeData;
		readonly turnId?: string;
		readonly expiresAt?: string;
	}): AuthTurn;
	nextForm(
		options: {
			readonly hintKey?: ProviderLocaleKeyInput;
			readonly data?: AuthSafeData;
			readonly turnId?: string;
			readonly expiresAt?: string;
			readonly timing?: AuthTurn["timing"];
		} & (
			| {
					readonly fields: Record<
						string,
						{
							readonly type?: "string" | "email" | "password" | "otp";
							readonly labelKey?: ProviderLocaleKeyInput;
							readonly descriptionKey?: ProviderLocaleKeyInput;
							readonly placeholderKey?: ProviderLocaleKeyInput;
							readonly required?: boolean;
							readonly sensitive?: boolean;
						}
					>;
					readonly expectedInput?: never;
			  }
			| {
					readonly expectedInput: Record<string, unknown>;
					readonly fields?: never;
			  }
		),
	): AuthTurn;
	nextPoll(options?: {
		readonly hintKey?: ProviderLocaleKeyInput;
		readonly data?: AuthSafeData;
		readonly turnId?: string;
		readonly expiresAt?: string;
		readonly timing?: AuthTurn["timing"];
	}): AuthTurn;
}

export interface FlowContext {
	connectionId?: string;
	externalRef?: string;
	tenantId: string;
	providerId: string;
	http: HttpClient;
	stealth: StealthClient;
	env: EnvContext;
	credential?: CredentialContext;
	context: ContextScratchpad;
	stt: SttContext;
	auth: AuthFlowTerminalContext;
}

export interface AuthTurn {
	kind: string;
	turnId: string;
	expiresAt?: string;
	data?: Record<string, unknown>;
	expectedInput?: Record<string, unknown>;
	/**
	 * @deprecated Compatibility-only materialized provider auth hint.
	 * Provider source must emit hintKey; SDK/server boundaries may materialize
	 * this field from provider locale catalogs for legacy clients.
	 */
	hint?: string;
	/** Provider locale catalog key for the auth turn hint. */
	hintKey?: ProviderLocaleKeyInput;
	timing?: {
		suggestedPollIntervalMs?: number;
		maxWaitMs?: number;
	};
}

export type AuthFlowStartHandler = (ctx: FlowContext) => Promise<AuthTurn>;

export type AuthFlowInputHandler = (
	ctx: FlowContext,
	input?: Record<string, unknown>,
) => Promise<AuthTurn>;

export interface AuthFlowDefinition {
	start: AuthFlowStartHandler;
	continue: AuthFlowInputHandler;
	poll?: AuthFlowStartHandler;
	abort?: AuthFlowStartHandler;
	refresh?: AuthFlowInputHandler;
}

export type ProviderStateDurationString =
	| `${number}${"ms" | "s" | "m" | "h" | "d"}`
	| `PT${string}`;

export interface StateNamespaceOptions {
	/** Default TTL used when a write omits ttl. Required to avoid unbounded state. */
	defaultTtl: ProviderStateDurationString;
	/** Maximum allowed TTL; writes are rejected when they exceed this policy. */
	maxTtl: ProviderStateDurationString;
	/** Maximum number of live entries in this namespace scope. */
	maxEntries: number;
	/** Maximum JSON-encoded value size in bytes. */
	maxValueBytes: number;
}

export interface StateWriteOptions {
	ttl?: ProviderStateDurationString;
}

export interface StateValue<T = unknown> {
	key: string;
	value: T;
	version: number;
	expiresAt: string;
	createdAt: string;
	updatedAt: string;
}

export type StateCasResult<T = unknown> =
	| { ok: true; value: StateValue<T> }
	| { ok: false; current: StateValue<T> | null };

export interface ProviderStateNamespace {
	list<T = unknown>(options?: {
		limit?: number;
		/** Optional literal key prefix used for scoped recovery scans. */
		prefix?: string;
	}): Promise<StateValue<T>[]>;
	get<T = unknown>(key: string): Promise<StateValue<T> | null>;
	set<T = unknown>(
		key: string,
		value: T,
		options?: StateWriteOptions,
	): Promise<StateValue<T>>;
	patch<T extends Record<string, unknown>>(
		key: string,
		partial: Partial<T>,
		options?: StateWriteOptions,
	): Promise<StateValue<T>>;
	compareAndSet<T = unknown>(
		key: string,
		expectedVersion: number,
		value: T,
		options?: StateWriteOptions,
	): Promise<StateCasResult<T>>;
	delete(key: string): Promise<void>;
	increment(
		key: string,
		field: string,
		delta?: number,
		options?: StateWriteOptions,
	): Promise<StateValue<Record<string, unknown>>>;
}

export interface ProviderRuntimeState {
	namespace(
		name: string,
		options: StateNamespaceOptions,
	): ProviderStateNamespace;
}

export interface ProviderContext {
	env: EnvContext;
	credential: CredentialContext;
	request?: ProviderRequestContext;
	http: HttpClient;
	cache: ProviderCache;
	state: ProviderRuntimeState;
	stealth: StealthClient;
	browser: BrowserClient;
	trace: TraceContext;
	auth: AuthContext;
	stt: SttContext;
	choice: ProviderChoiceContext;
}

export interface AuthConfig {
	mode: AuthMode;
	flow?: AuthFlowDefinition;
}

export interface ProviderSecretDeclaration {
	name: string;
	description?: string;
	required?: boolean;
}

export interface CredentialDeclaration {
	keys: string[];
	storesReusableSecret?: boolean;
	justification?: string;
}

export interface ContextDeclaration {
	keys: string[];
}

export type OperationLifecycle = "stable" | "beta" | "deprecated" | "removed";

export interface OperationDeprecationMetadata {
	announcedAt: string;
	removalAfter: string;
	replacement?: string;
	migrationGuide: string;
}

export interface OperationContractMetadata {
	/**
	 * Callable operation contract version. Defaults to 1.0.0 for the clean
	 * pre-GA baseline; it intentionally does not fall back to provider.version.
	 */
	version?: string;
	lifecycle?: OperationLifecycle;
	deprecation?: OperationDeprecationMetadata;
}

export interface OperationDefinition<
	TInput extends SchemaLike = SchemaLike,
	TOutput extends SchemaLike = SchemaLike,
> {
	descriptionKey?: ProviderLocaleKeyInput;
	docs?: OperationDocMeta;
	whenToUseKeys?: readonly ProviderLocaleKeyInput[];
	whenNotToUseKeys?: readonly ProviderLocaleKeyInput[];
	derivations?: Record<string, string>;
	inputExamples?: readonly OperationInputExample[];
	annotations?: OperationAnnotations;
	contract?: OperationContractMetadata;
	tags?: readonly string[];
	relatedOperations?: OperationRelationships;
	toolRouter?: OperationToolRouterMetadata;
	observability?: OperationObservabilityConfig;
	transport?: OperationTransport;
	retryOnAuthRefresh?: boolean;
	input: TInput;
	output: TOutput;
	handler(
		ctx: ProviderContext,
		input: InferSchemaOutput<TInput>,
	):
		| OperationHandlerResult<InferSchemaOutput<TOutput>>
		| Promise<OperationHandlerResult<InferSchemaOutput<TOutput>>>;
	fixtures?: {
		request: InferSchemaOutput<TInput>;
		response: InferSchemaOutput<TOutput>;
	};
	upstream?: {
		baseUrl?: string;
		proxy?: boolean | ProviderProxyPolicy;
	};
	hints?: Record<string, string>;
	healthCheck?: HealthCheckSuite<
		InferSchemaOutput<TInput>,
		InferSchemaOutput<TOutput>
	>;
	healthCheckUnsupported?: HealthCheckUnsupported;
}

export interface ProviderDefinition {
	id: string;
	version: string;
	runtime: "standard" | "shared" | "browser";
	allowedHosts?: string[];
	stealth?: {
		profile: string;
		platform: StealthPlatform;
	};
	proxy?: ProviderProxyConfig;
	stt?: ProviderSttConfig;
	browser?: {
		engine: BrowserEngine;
	};
	auth?: AuthConfig;
	reviewed?: ProviderReviewed;
	access?: ProviderAccessConfig;
	secrets?: ProviderSecretDeclaration[];
	credential?: CredentialDeclaration;
	context?: ContextDeclaration;
	meta: ProviderMeta;
	operations: Record<string, OperationDefinition<SchemaLike, SchemaLike>>;
	healthMonitor?: ProviderHealthMonitorConfig;
	healthJourneys?: readonly HealthJourneyDefinition[];
}
