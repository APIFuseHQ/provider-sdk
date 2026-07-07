import ms from "ms";

import { ProviderError, ValidationError } from "./errors";
import { safeParseSchemaSync } from "./schema";
import type {
	AuthConfig,
	BrowserEngine,
	ContextDeclaration,
	CredentialDeclaration,
	HealthCheckCase,
	HealthCheckSuite,
	HealthCheckUnsupported,
	HealthJourneyDefinition,
	HealthJourneySchedule,
	HealthScheduleRandomization,
	InferSchemaOutput,
	NativeTcpEgressRule,
	OperationDefinition,
	OperationHandlerResult,
	OperationHttpStreamTransport,
	OperationSseTransport,
	OperationTransport,
	OperationWebSocketTransport,
	ProviderAccessConfig,
	ProviderDefinition,
	ProviderHealthMonitorConfig,
	ProviderProxyConfig,
	ProviderPublicProfile,
	ProviderReviewed,
	ProviderSecretDeclaration,
	ProviderStreamEvent,
	ProviderSttConfig,
	SchemaLike,
	SmsOtpMatcherDefinition,
	StealthPlatform,
} from "./types";
import {
	HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MAX,
	HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MIN,
	HEALTH_CHECK_TIMEOUT_MS_MAX,
	HEALTH_CHECK_TIMEOUT_MS_MIN,
	OPERATION_TIMEOUT_MS_MAX,
	OPERATION_TIMEOUT_MS_MIN,
	STREAM_CHUNK_BYTES_MAX,
	STREAM_CHUNK_BYTES_MIN,
	STREAM_HEARTBEAT_MS_MAX,
	STREAM_HEARTBEAT_MS_MIN,
	STREAM_IDLE_TIMEOUT_MS_MAX,
	STREAM_IDLE_TIMEOUT_MS_MIN,
	STREAM_MAX_DURATION_MS_MAX,
	STREAM_MAX_DURATION_MS_MIN,
} from "./types";

type ProviderImplementationSourceAccess =
	| "official_api"
	| "private_api"
	| "browser_flow"
	| "hybrid";

type ProviderImplementationCredentialStrategy =
	| "apifuse_managed"
	| "workspace_secret"
	| "user_oauth"
	| "user_session"
	| "none";

interface ProviderImplementationProfile {
	sourceAccess: ProviderImplementationSourceAccess;
	credentialStrategy: ProviderImplementationCredentialStrategy;
	officialDocsUrl?: string;
	operatorNotes?: string;
	visibility: "internal" | "operator";
}

const CONNECTOR_ID_REGEX = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;
const OPERATION_ID_REGEX = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const VALID_RUNTIMES = ["standard", "shared", "browser"] as const;
const VALID_AUTH_MODES = [
	"none",
	"platform-managed",
	"credentials",
	"oauth2",
] as const;
const VALID_NATIVE_TCP_TLS_MODES = ["required", "allowed", "disabled"] as const;
const VALID_PROVIDER_ACCESS_VISIBILITIES = ["public", "early_access"] as const;
const VALID_PROVIDER_PROXY_MODES = [
	"disabled",
	"optional",
	"required",
] as const;
const VALID_PROVIDER_PROXY_PROVIDERS = [
	"smartproxy",
	"decodo",
	"custom",
] as const;
const VALID_PROVIDER_PROXY_AFFINITIES = [
	"request",
	"operation",
	"auth-flow",
	"connection",
] as const;
const VALID_PROVIDER_STT_MODES = ["optional", "required"] as const;
const SMARTPROXY_APP_KEY_SECRET = "APIFUSE__PROXY__SMARTPROXY_APP_KEY";
const RESERVED_OPERATION_IDS = new Set(["auth", "health"]);
const MCP_TOOL_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const VALID_OPERATION_RISK_CLASSES = [
	"read",
	"write",
	"destructive",
	"external-send",
] as const;
const VALID_OPERATION_APPROVAL_POLICIES = [
	"never",
	"risk-based",
	"always",
] as const;
const VALID_OPERATION_TRANSPORT_KINDS = [
	"json",
	"sse",
	"http-stream",
	"websocket",
] as const;
const SSE_EVENT_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const WEBSOCKET_SUBPROTOCOL_REGEX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const MS_DURATION_PATTERN = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*([a-zA-Z]+)?$/;

function isPositiveMsDurationString(value: unknown): value is string {
	if (typeof value !== "string") return false;
	return parsePositiveMsDuration(value) !== undefined;
}

function msDurationMs(value: string): number {
	return parsePositiveMsDuration(value) ?? 0;
}

function parsePositiveMsDuration(value: string): number | undefined {
	const trimmed = value.trim();
	if (!MS_DURATION_PATTERN.test(trimmed)) return undefined;
	const parsed = ms(
		(trimmed.startsWith("+") ? trimmed.slice(1) : trimmed) as ms.StringValue,
	);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
}

type ProviderOperation = OperationDefinition<SchemaLike, SchemaLike>;
type OperationConfig<
	TInput extends SchemaLike,
	TOutput extends SchemaLike,
> = Omit<OperationDefinition<TInput, TOutput>, "handler"> & {
	handler(
		ctx: Parameters<OperationDefinition<TInput, TOutput>["handler"]>[0],
		input: InferSchemaOutput<TInput>,
	):
		| OperationHandlerResult<InferSchemaOutput<TOutput>>
		| Promise<OperationHandlerResult<InferSchemaOutput<TOutput>>>;
};
type OperationMapConfig<TOperations extends Record<string, ProviderOperation>> =
	{
		[K in keyof TOperations]: TOperations[K] extends OperationDefinition<
			infer TInput,
			infer TOutput
		>
			? OperationConfig<TInput, TOutput> | OperationDefinition<TInput, TOutput>
			: never;
	};
type StreamOperationConfig<
	TInput extends SchemaLike,
	TOutput extends SchemaLike,
> =
	| SseOperationConfig<TInput, TOutput>
	| HttpStreamOperationConfig<TInput, TOutput>
	| WebSocketOperationConfig<TInput, TOutput>;
type SseOperationConfig<
	TInput extends SchemaLike,
	TOutput extends SchemaLike,
> = Omit<OperationConfig<TInput, TOutput>, "handler" | "transport"> & {
	transport: OperationSseTransport;
	handler(
		ctx: Parameters<OperationDefinition<TInput, TOutput>["handler"]>[0],
		input: InferSchemaOutput<TInput>,
	):
		| AsyncIterable<ProviderStreamEvent>
		| Promise<AsyncIterable<ProviderStreamEvent>>;
};
type HttpStreamOperationConfig<
	TInput extends SchemaLike,
	TOutput extends SchemaLike,
> = Omit<OperationConfig<TInput, TOutput>, "handler" | "transport"> & {
	transport: OperationHttpStreamTransport;
	handler(
		ctx: Parameters<OperationDefinition<TInput, TOutput>["handler"]>[0],
		input: InferSchemaOutput<TInput>,
	):
		| Response
		| ReadableStream<Uint8Array>
		| Promise<Response | ReadableStream<Uint8Array>>;
};
type WebSocketOperationConfig<
	TInput extends SchemaLike,
	TOutput extends SchemaLike,
> = Omit<OperationConfig<TInput, TOutput>, "handler" | "transport"> & {
	transport: OperationWebSocketTransport;
	handler(
		ctx: Parameters<OperationDefinition<TInput, TOutput>["handler"]>[0],
		input: InferSchemaOutput<TInput>,
	):
		| Response
		| ReadableStream<Uint8Array>
		| Promise<Response | ReadableStream<Uint8Array>>;
};

type AuthStartNoInputGuard<TConfig> = TConfig extends {
	auth?: { flow?: { start: infer TStart } };
}
	? TStart extends (...args: infer TArgs) => unknown
		? TArgs extends [] | [unknown]
			? unknown
			: {
					"auth start handlers must not declare input parameters; return a form turn from start and receive user input in continue": never;
				}
		: unknown
	: unknown;

export interface ProviderConfig<
	TOperations extends Record<string, ProviderOperation>,
> {
	id: string;
	version: string;
	runtime: "standard" | "shared" | "browser";
	allowedHosts?: string[];
	native?: {
		network?: {
			tcp?: readonly NativeTcpEgressRule[];
		};
	};
	stealth?: {
		profile: string;
		platform: StealthPlatform;
	};
	proxy?: ProviderProxyConfig;
	stt?: ProviderSttConfig;
	browser?: { engine: BrowserEngine };
	auth?: AuthConfig;
	reviewed?: ProviderReviewed;
	access?: ProviderAccessConfig;
	secrets?: ProviderSecretDeclaration[];
	credential?: CredentialDeclaration;
	context?: ContextDeclaration;
	meta: {
		displayName: string;
		displayNameKey?: string;
		descriptionKey: string;
		category: string;
		tags?: readonly string[];
		icon?: string;
		docTitleKey?: string;
		docDescriptionKey?: string;
		docSummaryKey?: string;
		docMarkdownKey?: string;
		normalizationNotesKeys?: readonly string[];
		environment?: "staging";
		purpose?: string;
		purposeKey?: string;
		publicProfile?: ProviderPublicProfile;
		implementationProfile?: ProviderImplementationProfile;
		contract?: {
			publicSchemaFieldNames?: "normalized";
		};
	};
	operations: OperationMapConfig<TOperations>;
	healthMonitor?: ProviderHealthMonitorConfig;
	healthJourneys?: readonly HealthJourneyDefinition[];
}

/** Define one provider operation with schema-driven handler inference. */
export function defineOperation<
	TInput extends SchemaLike,
	TOutput extends SchemaLike,
>(
	operation: OperationConfig<TInput, TOutput>,
): OperationDefinition<TInput, TOutput> {
	return operation;
}

/** Define a non-JSON provider operation with explicit transport metadata. */
export function defineStreamOperation<
	TInput extends SchemaLike,
	TOutput extends SchemaLike,
>(
	operation: StreamOperationConfig<TInput, TOutput>,
): OperationDefinition<TInput, TOutput> {
	return operation;
}

function assertObjectConfig(
	value: unknown,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object") {
		throw new ProviderError(
			"defineProvider config must be an object. Offending field: config",
			{
				fix: "Pass defineProvider({ id, version, runtime, meta, operations })",
			},
		);
	}
}
function assertRequiredField(
	config: Record<string, unknown>,
	field: string,
	providerId?: string,
): void {
	if (!Object.hasOwn(config, field) || config[field] === undefined) {
		const prefix = providerId ? `Provider "${providerId}"` : "Provider config";
		throw new ProviderError(`${prefix} is missing required field "${field}"`, {
			fix: `Add ${field} to defineProvider({ ... })`,
		});
	}
}
function assertLiteralField<TValue extends string>(
	value: string,
	field: string,
	validValues: readonly TValue[],
	providerId: string,
): asserts value is TValue {
	if (!validValues.some((validValue) => validValue === value)) {
		throw new ProviderError(
			`Provider "${providerId}" has invalid ${field}: "${value}". Expected one of: ${validValues.join(", ")}`,
			{
				fix: `Set ${field} to one of ${validValues.map((item) => `"${item}"`).join(", ")}`,
			},
		);
	}
}
function validateProviderShape(config: unknown): void {
	assertObjectConfig(config);
	assertRequiredField(config, "id");
	assertRequiredField(config, "version", String(config.id));
	assertRequiredField(config, "runtime", String(config.id));
	assertRequiredField(config, "meta", String(config.id));
	assertRequiredField(config, "operations", String(config.id));
	if (typeof config.runtime === "string")
		assertLiteralField(
			config.runtime,
			"runtime",
			VALID_RUNTIMES,
			String(config.id),
		);
	const auth = config.auth;
	if (
		auth &&
		typeof auth === "object" &&
		"mode" in auth &&
		typeof auth.mode === "string"
	)
		assertLiteralField(
			auth.mode,
			"auth.mode",
			VALID_AUTH_MODES,
			String(config.id),
		);
	if (auth && typeof auth === "object" && "exchange" in auth) {
		throw new ProviderError(
			`Provider "${String(config.id)}" auth.exchange is not part of the Provider SDK auth contract`,
			{
				fix: "Use the single canonical auth interface: auth.flow. Gateway calls auth.flow.start/continue/poll/abort/refresh only and persists complete turn data.credential as-is, so put login/token/session exchange inside auth.flow.continue.",
			},
		);
	}
	if (
		auth &&
		typeof auth === "object" &&
		"flow" in auth &&
		auth.flow &&
		typeof auth.flow === "object" &&
		"start" in auth.flow &&
		typeof auth.flow.start === "function" &&
		auth.flow.start.length > 1
	) {
		throw new ProviderError(
			`Provider "${String(config.id)}" auth.flow.start must not declare an input parameter`,
			{
				fix: "Return a form turn from start(ctx), then receive user input in continue(ctx, input).",
			},
		);
	}
	const access = config.access;
	if (access !== undefined) {
		if (!access || typeof access !== "object" || Array.isArray(access)) {
			throw new ValidationError(
				`Provider "${String(config.id)}" has invalid access: must be an object.`,
				{
					fix: `Set access to { visibility?: "public" | "early_access" }.`,
				},
			);
		}
		const accessRecord: Record<string, unknown> = Object.fromEntries(
			Object.entries(access),
		);
		for (const key of Object.keys(accessRecord)) {
			if (key !== "visibility") {
				throw new ValidationError(`Unknown field "${key}" on access.`, {
					fix: `Remove access.${key} or rename it to visibility.`,
				});
			}
		}
		const visibility = accessRecord.visibility;
		if (visibility !== undefined) {
			if (typeof visibility !== "string") {
				throw new ValidationError(
					`Provider "${String(config.id)}" has invalid access.visibility: must be "public" or "early_access".`,
					{
						fix: `Set access.visibility to "public" or "early_access".`,
					},
				);
			}
			assertLiteralField(
				visibility,
				"access.visibility",
				VALID_PROVIDER_ACCESS_VISIBILITIES,
				String(config.id),
			);
		}
	}
}

function validateNativeTcpEgressRules(config: {
	id: string;
	native?: {
		network?: {
			tcp?: readonly NativeTcpEgressRule[];
		};
	};
}): void {
	const rules = config.native?.network?.tcp;
	if (rules === undefined) return;
	if (!Array.isArray(rules)) {
		throw new ValidationError(
			`Provider "${config.id}" native.network.tcp must be an array.`,
			{
				fix: "Declare native.network.tcp as an array of { host, ports, tls } rules.",
			},
		);
	}
	for (const [index, rule] of rules.entries()) {
		const path = `native.network.tcp[${index}]`;
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
			throw new ValidationError(
				`Provider "${config.id}" ${path} must be an object.`,
			);
		}
		if (typeof rule.host !== "string" || rule.host.trim().length === 0) {
			throw new ValidationError(
				`Provider "${config.id}" ${path}.host must be a non-empty host.`,
			);
		}
		if (rule.host.includes("*")) {
			throw new ValidationError(
				`Provider "${config.id}" ${path}.host must not contain wildcards.`,
			);
		}
		if (!Array.isArray(rule.ports) || rule.ports.length === 0) {
			throw new ValidationError(
				`Provider "${config.id}" ${path}.ports must be a non-empty array.`,
			);
		}
		for (const port of rule.ports) {
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				throw new ValidationError(
					`Provider "${config.id}" ${path}.ports contains invalid port "${String(port)}".`,
				);
			}
		}
		if (
			typeof rule.tls !== "string" ||
			!VALID_NATIVE_TCP_TLS_MODES.some((mode) => mode === rule.tls)
		) {
			throw new ValidationError(
				`Provider "${config.id}" ${path}.tls must be "required", "allowed", or "disabled".`,
			);
		}
	}
}

function validateProviderProxy(config: {
	id: string;
	proxy?: ProviderProxyConfig;
	secrets?: ProviderSecretDeclaration[];
}): void {
	const proxy = config.proxy;
	if (proxy === undefined || typeof proxy === "boolean") {
		return;
	}
	if (!proxy || typeof proxy !== "object" || Array.isArray(proxy)) {
		throw new ValidationError(
			`Provider "${config.id}" has invalid proxy: must be a boolean or provider proxy policy object.`,
			{
				fix: `Use proxy: { mode: "required", provider: "smartproxy", geo: { country: "KR" }, session: { affinity: "connection", lifetimeMinutes: 30 } }`,
			},
		);
	}
	rejectUnknownFields(
		proxy,
		new Set(["mode", "provider", "geo", "session"]),
		"proxy",
	);
	assertLiteralField(
		proxy.mode,
		"proxy.mode",
		VALID_PROVIDER_PROXY_MODES,
		config.id,
	);
	if (proxy.provider !== undefined) {
		assertLiteralField(
			proxy.provider,
			"proxy.provider",
			VALID_PROVIDER_PROXY_PROVIDERS,
			config.id,
		);
	}
	if (proxy.geo !== undefined) {
		if (
			!proxy.geo ||
			typeof proxy.geo !== "object" ||
			Array.isArray(proxy.geo)
		) {
			throw new ValidationError(
				`Provider "${config.id}" has invalid proxy.geo: must be an object.`,
				{
					fix: `Use proxy.geo: { country: "KR" } with ISO alpha-2 country codes.`,
				},
			);
		}
		rejectUnknownFields(
			proxy.geo,
			new Set(["country", "subdivision", "city"]),
			"proxy.geo",
		);
		if (proxy.geo.country !== undefined) {
			assertIsoCountry(proxy.geo.country, "proxy.geo.country");
		}
		for (const field of ["subdivision", "city"] as const) {
			const value = proxy.geo[field];
			if (value !== undefined && (typeof value !== "string" || !value.trim())) {
				throw new ValidationError(
					`Provider "${config.id}" has invalid proxy.geo.${field}: must be a non-empty string.`,
				);
			}
		}
	}
	if (proxy.session !== undefined) {
		if (
			!proxy.session ||
			typeof proxy.session !== "object" ||
			Array.isArray(proxy.session)
		) {
			throw new ValidationError(
				`Provider "${config.id}" has invalid proxy.session: must be an object.`,
				{
					fix: `Use proxy.session: { affinity: "connection", lifetimeMinutes: 30 }.`,
				},
			);
		}
		rejectUnknownFields(
			proxy.session,
			new Set(["affinity", "lifetimeMinutes", "poolSize"]),
			"proxy.session",
		);
		if (proxy.session.affinity !== undefined) {
			assertLiteralField(
				proxy.session.affinity,
				"proxy.session.affinity",
				VALID_PROVIDER_PROXY_AFFINITIES,
				config.id,
			);
		}
		const lifetime = proxy.session.lifetimeMinutes;
		if (
			lifetime !== undefined &&
			(!Number.isFinite(lifetime) || lifetime <= 0)
		) {
			throw new ValidationError(
				`Provider "${config.id}" has invalid proxy.session.lifetimeMinutes: must be a positive number of minutes.`,
			);
		}
		const poolSize = proxy.session.poolSize;
		if (
			poolSize !== undefined &&
			(!Number.isInteger(poolSize) || poolSize <= 0)
		) {
			throw new ValidationError(
				`Provider "${config.id}" has invalid proxy.session.poolSize: must be a positive integer.`,
			);
		}
	}
	if (proxy.mode === "required" && proxy.provider === "smartproxy") {
		const hasSmartproxySecret = config.secrets?.some(
			(secret) =>
				secret.name === SMARTPROXY_APP_KEY_SECRET && secret.required !== false,
		);
		if (!hasSmartproxySecret) {
			throw new ValidationError(
				`Provider "${config.id}" requires Smartproxy egress but does not declare ${SMARTPROXY_APP_KEY_SECRET}.`,
				{
					fix: `Add secrets: [{ name: "${SMARTPROXY_APP_KEY_SECRET}", required: true }] to the provider.`,
				},
			);
		}
	}
}

function validateProviderStt(config: {
	id: string;
	stt?: ProviderSttConfig;
}): void {
	const stt = config.stt;
	if (stt === undefined) return;
	if (!stt || typeof stt !== "object" || Array.isArray(stt)) {
		throw new ValidationError(
			`Provider "${config.id}" has invalid stt: must be an object.`,
			{ fix: `Use stt: { mode: "required" } or stt: { mode: "optional" }.` },
		);
	}
	rejectUnknownFields(stt, new Set(["mode"]), "stt");
	assertLiteralField(stt.mode, "stt.mode", VALID_PROVIDER_STT_MODES, config.id);
}

function validateOperationIds(
	providerId: string,
	operations: Record<string, ProviderOperation>,
): void {
	for (const operationName of Object.keys(operations)) {
		if (!OPERATION_ID_REGEX.test(operationName))
			throw new ProviderError(
				`Provider "${providerId}" has invalid operations.${operationName}: operation ids must be URL-safe and cannot contain slashes.`,
				{
					fix: `Rename operations.${operationName} to a lowercase URL-safe id such as "search-items"`,
				},
			);
		if (RESERVED_OPERATION_IDS.has(operationName))
			throw new ProviderError(
				`Provider "${providerId}" operation "${operationName}" conflicts with a reserved server path.`,
				{
					fix: `Rename operations.${operationName} to avoid /${operationName}`,
				},
			);
	}
}
const OPERATION_CONTRACT_VERSION_REGEX =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const OPERATION_SENSITIVE_PATH_REGEX =
	/^(?:[A-Za-z0-9_$-]+|\*)(?:\.(?:[A-Za-z0-9_$-]+|\*))*$/;
const VALID_OPERATION_LIFECYCLES = [
	"stable",
	"beta",
	"deprecated",
	"removed",
] as const;

function assertNonEmptyString(
	value: unknown,
	field: string,
	providerId: string,
	operationName: string,
): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ValidationError(
			`Provider "${providerId}" operation "${operationName}" has invalid ${field}: must be a non-empty string.`,
			{ fix: `Set ${field} to a non-empty customer-facing value.` },
		);
	}
}

function validateToolRouterMetadata(
	providerId: string,
	operations: Record<string, ProviderOperation>,
): void {
	for (const [operationName, operation] of Object.entries(operations)) {
		const toolRouter = operation.toolRouter;
		if (toolRouter === undefined) continue;
		if (!toolRouter || typeof toolRouter !== "object") {
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" has invalid operations.${operationName}.toolRouter: must be an object.`,
				{
					fix: `Remove operations.${operationName}.toolRouter or provide MCP-safe metadata.`,
				},
			);
		}
		if (
			toolRouter.name !== undefined &&
			!MCP_TOOL_NAME_REGEX.test(toolRouter.name)
		) {
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" has invalid operations.${operationName}.toolRouter.name: expected an MCP-safe name.`,
				{
					fix: `Use letters, numbers, and underscores only, starting with a letter, for example "${providerId.replace(/[^A-Za-z0-9]+/g, "_")}__${operationName.replace(/[^A-Za-z0-9]+/g, "_")}".`,
				},
			);
		}
		if (toolRouter.riskClass !== undefined) {
			assertLiteralField(
				toolRouter.riskClass,
				`operations.${operationName}.toolRouter.riskClass`,
				VALID_OPERATION_RISK_CLASSES,
				providerId,
			);
		}
		if (toolRouter.approval !== undefined) {
			assertLiteralField(
				toolRouter.approval,
				`operations.${operationName}.toolRouter.approval`,
				VALID_OPERATION_APPROVAL_POLICIES,
				providerId,
			);
		}
		if (
			toolRouter.connectionExternalRefParam !== undefined &&
			(typeof toolRouter.connectionExternalRefParam !== "string" ||
				toolRouter.connectionExternalRefParam.trim().length === 0)
		) {
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" has invalid operations.${operationName}.toolRouter.connectionExternalRefParam: must be a non-empty string.`,
				{
					fix: `Use "externalRef" unless the operation has a documented public alias.`,
				},
			);
		}
	}
}

function validateOperationContracts(
	providerId: string,
	operations: Record<string, ProviderOperation>,
): void {
	for (const [operationName, operation] of Object.entries(operations)) {
		const contract = operation.contract;
		if (contract === undefined) continue;
		if (!contract || typeof contract !== "object") {
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" has invalid operations.${operationName}.contract: must be an object.`,
				{
					fix: `Remove operations.${operationName}.contract or provide { version, lifecycle, deprecation }.`,
				},
			);
		}
		if (
			contract.version !== undefined &&
			(typeof contract.version !== "string" ||
				!OPERATION_CONTRACT_VERSION_REGEX.test(contract.version))
		) {
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" has invalid operations.${operationName}.contract.version: expected semver major.minor.patch.`,
				{ fix: `Use an operation contract version such as "1.0.0".` },
			);
		}
		if (contract.lifecycle !== undefined) {
			assertLiteralField(
				contract.lifecycle,
				`operations.${operationName}.contract.lifecycle`,
				VALID_OPERATION_LIFECYCLES,
				providerId,
			);
		}
		if (
			contract.lifecycle === "deprecated" ||
			contract.lifecycle === "removed"
		) {
			if (!contract.deprecation || typeof contract.deprecation !== "object") {
				throw new ValidationError(
					`Provider "${providerId}" operation "${operationName}" is ${contract.lifecycle} but lacks operations.${operationName}.contract.deprecation metadata.`,
					{
						fix: `Add announcedAt, removalAfter, and migrationGuide to operations.${operationName}.contract.deprecation.`,
					},
				);
			}
			assertNonEmptyString(
				contract.deprecation.announcedAt,
				`operations.${operationName}.contract.deprecation.announcedAt`,
				providerId,
				operationName,
			);
			assertNonEmptyString(
				contract.deprecation.removalAfter,
				`operations.${operationName}.contract.deprecation.removalAfter`,
				providerId,
				operationName,
			);
			assertNonEmptyString(
				contract.deprecation.migrationGuide,
				`operations.${operationName}.contract.deprecation.migrationGuide`,
				providerId,
				operationName,
			);
		}
	}
}

function validateOperationAnnotations(
	providerId: string,
	operations: Record<string, ProviderOperation>,
): void {
	for (const [operationName, operation] of Object.entries(operations)) {
		const annotations = operation.annotations;
		if (!annotations) continue;
		const timeoutMs = annotations.timeoutMs;
		if (timeoutMs === undefined) continue;
		const field = `operations.${operationName}.annotations.timeoutMs`;
		if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs))
			throw new ValidationError(
				`Provider "${providerId}" has invalid ${field}: must be an integer number of milliseconds.`,
				{
					fix: `Set ${field} to an integer in [${OPERATION_TIMEOUT_MS_MIN}, ${OPERATION_TIMEOUT_MS_MAX}] (milliseconds).`,
				},
			);
		if (
			timeoutMs < OPERATION_TIMEOUT_MS_MIN ||
			timeoutMs > OPERATION_TIMEOUT_MS_MAX
		)
			throw new ValidationError(
				`Provider "${providerId}" has invalid ${field}: ${timeoutMs} is outside [${OPERATION_TIMEOUT_MS_MIN}, ${OPERATION_TIMEOUT_MS_MAX}] ms.`,
				{
					fix: `Set ${field} to an integer in [${OPERATION_TIMEOUT_MS_MIN}, ${OPERATION_TIMEOUT_MS_MAX}] ms (the upper bound stays below the gateway/ALB ceiling).`,
				},
			);
	}
}

function validateOperationObservability(
	providerId: string,
	operations: Record<string, ProviderOperation>,
): void {
	for (const [operationName, operation] of Object.entries(operations)) {
		const observability = operation.observability;
		if (observability === undefined) continue;
		if (!observability || typeof observability !== "object") {
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" has invalid operations.${operationName}.observability: must be an object.`,
				{
					fix: `Use observability: { sensitive: { input: ["field"], output: ["items.*.secret"] } }.`,
				},
			);
		}
		rejectUnknownFields(
			observability,
			new Set(["sensitive"]),
			`operations.${operationName}.observability`,
		);
		const sensitive = observability.sensitive;
		if (sensitive === undefined) continue;
		if (!sensitive || typeof sensitive !== "object") {
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" has invalid operations.${operationName}.observability.sensitive: must be an object.`,
			);
		}
		rejectUnknownFields(
			sensitive,
			new Set(["input", "output"]),
			`operations.${operationName}.observability.sensitive`,
		);
		for (const side of ["input", "output"] as const) {
			const paths = sensitive[side];
			if (paths === undefined) continue;
			if (!Array.isArray(paths)) {
				throw new ValidationError(
					`Provider "${providerId}" operation "${operationName}" has invalid operations.${operationName}.observability.sensitive.${side}: must be an array of dot paths.`,
				);
			}
			for (const [index, path] of paths.entries()) {
				if (
					typeof path !== "string" ||
					path.trim() !== path ||
					!OPERATION_SENSITIVE_PATH_REGEX.test(path)
				) {
					throw new ValidationError(
						`Provider "${providerId}" operation "${operationName}" has invalid operations.${operationName}.observability.sensitive.${side}[${index}]: expected dot path segments or "*" wildcards.`,
						{
							fix: `Use paths like "password" or "items.*.phone"; do not include empty segments, brackets, or leading/trailing spaces.`,
						},
					);
				}
			}
		}
	}
}

const JSON_TRANSPORT_FIELDS = new Set(["kind"]);
const SSE_TRANSPORT_FIELDS = new Set([
	"kind",
	"heartbeatMs",
	"idleTimeoutMs",
	"maxDurationMs",
	"maxEventBytes",
	"resumable",
	"events",
]);
const HTTP_STREAM_TRANSPORT_FIELDS = new Set([
	"kind",
	"contentType",
	"idleTimeoutMs",
	"maxDurationMs",
	"maxChunkBytes",
]);
const WEBSOCKET_TRANSPORT_FIELDS = new Set([
	"kind",
	"subprotocols",
	"idleTimeoutMs",
	"maxDurationMs",
	"maxFrameBytes",
	"dispatch",
]);

function assertTransportObject(
	transport: unknown,
	fieldPath: string,
	providerId: string,
	operationName: string,
): asserts transport is OperationTransport {
	if (!transport || typeof transport !== "object" || Array.isArray(transport)) {
		throw new ValidationError(
			`Provider "${providerId}" operation "${operationName}" has invalid ${fieldPath}: must be a transport object.`,
			{
				fix: `Use ${fieldPath}: { kind: "sse", ... } or omit ${fieldPath} for JSON operations.`,
			},
		);
	}
}

function assertStreamMs(
	value: unknown,
	fieldPath: string,
	min: number,
	max: number,
	label: string,
): void {
	if (value === undefined) return;
	assertBoundedIntegerMs(value, fieldPath, { min, max, label });
}

function assertPositiveBytes(value: unknown, fieldPath: string): void {
	if (value === undefined) return;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < STREAM_CHUNK_BYTES_MIN ||
		value > STREAM_CHUNK_BYTES_MAX
	) {
		throw new ValidationError(
			`${fieldPath} must be an integer byte size in [${STREAM_CHUNK_BYTES_MIN}, ${STREAM_CHUNK_BYTES_MAX}].`,
			{
				fix: `Set ${fieldPath} to an integer byte size no larger than ${STREAM_CHUNK_BYTES_MAX}.`,
			},
		);
	}
}

function validateSseEvents(
	value: unknown,
	fieldPath: string,
	providerId: string,
	operationName: string,
): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(
			`Provider "${providerId}" operation "${operationName}" has invalid ${fieldPath}: must be an object keyed by SSE event name.`,
			{
				fix: `Set ${fieldPath} to an object, for example delta: z.object({ ... }). SSE transports require explicit event schemas.`,
			},
		);
	}
	if (Object.keys(value).length === 0) {
		throw new ValidationError(
			`Provider "${providerId}" operation "${operationName}" has invalid ${fieldPath}: must declare at least one SSE event schema.`,
			{
				fix: `Declare every emitted event, for example ${fieldPath}: { delta: z.object({ ... }) }.`,
			},
		);
	}
	for (const [eventName, schema] of Object.entries(value)) {
		if (!SSE_EVENT_NAME_REGEX.test(eventName)) {
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" has invalid ${fieldPath}.${eventName}: event names must be SSE-safe identifiers.`,
				{
					fix: `Use letters, numbers, underscore, dash, or dot, starting with a letter.`,
				},
			);
		}
		if (!schema || typeof schema !== "object") {
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" has invalid ${fieldPath}.${eventName}: event schema must be a schema object.`,
				{
					fix: `Set ${fieldPath}.${eventName} to a Zod or Standard Schema object.`,
				},
			);
		}
	}
}

function validateOperationTransports(
	providerId: string,
	operations: Record<string, ProviderOperation>,
): void {
	for (const [operationName, operation] of Object.entries(operations)) {
		const transport = operation.transport;
		if (transport === undefined) continue;
		const fieldPath = `operations.${operationName}.transport`;
		assertTransportObject(transport, fieldPath, providerId, operationName);
		const kind = Reflect.get(transport, "kind");
		if (typeof kind !== "string") {
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" has invalid ${fieldPath}.kind: must be a string.`,
				{
					fix: `Set ${fieldPath}.kind to one of ${VALID_OPERATION_TRANSPORT_KINDS.map((item) => `"${item}"`).join(", ")}.`,
				},
			);
		}
		assertLiteralField(
			kind,
			`${fieldPath}.kind`,
			VALID_OPERATION_TRANSPORT_KINDS,
			providerId,
		);

		switch (kind) {
			case "json":
				rejectUnknownFields(transport, JSON_TRANSPORT_FIELDS, fieldPath);
				break;
			case "sse": {
				rejectUnknownFields(transport, SSE_TRANSPORT_FIELDS, fieldPath);
				const heartbeatMs = Reflect.get(transport, "heartbeatMs");
				const idleTimeoutMs = Reflect.get(transport, "idleTimeoutMs");
				const maxDurationMs = Reflect.get(transport, "maxDurationMs");
				assertStreamMs(
					heartbeatMs,
					`${fieldPath}.heartbeatMs`,
					STREAM_HEARTBEAT_MS_MIN,
					STREAM_HEARTBEAT_MS_MAX,
					"heartbeat",
				);
				assertStreamMs(
					idleTimeoutMs,
					`${fieldPath}.idleTimeoutMs`,
					STREAM_IDLE_TIMEOUT_MS_MIN,
					STREAM_IDLE_TIMEOUT_MS_MAX,
					"idle timeout",
				);
				assertStreamMs(
					maxDurationMs,
					`${fieldPath}.maxDurationMs`,
					STREAM_MAX_DURATION_MS_MIN,
					STREAM_MAX_DURATION_MS_MAX,
					"max duration",
				);
				assertPositiveBytes(
					Reflect.get(transport, "maxEventBytes"),
					`${fieldPath}.maxEventBytes`,
				);
				const resumable = Reflect.get(transport, "resumable");
				if (
					resumable !== undefined &&
					resumable !== false &&
					resumable !== "last-event-id"
				) {
					throw new ValidationError(
						`Provider "${providerId}" operation "${operationName}" has invalid ${fieldPath}.resumable: expected false or "last-event-id".`,
						{
							fix: `Use ${fieldPath}.resumable: "last-event-id" for SSE Last-Event-ID resume support, or false to disable resume.`,
						},
					);
				}
				validateSseEvents(
					Reflect.get(transport, "events"),
					`${fieldPath}.events`,
					providerId,
					operationName,
				);
				break;
			}
			case "http-stream": {
				rejectUnknownFields(transport, HTTP_STREAM_TRANSPORT_FIELDS, fieldPath);
				const contentType = Reflect.get(transport, "contentType");
				if (contentType !== undefined) {
					assertNonEmptyString(
						contentType,
						`${fieldPath}.contentType`,
						providerId,
						operationName,
					);
				}
				assertStreamMs(
					Reflect.get(transport, "idleTimeoutMs"),
					`${fieldPath}.idleTimeoutMs`,
					STREAM_IDLE_TIMEOUT_MS_MIN,
					STREAM_IDLE_TIMEOUT_MS_MAX,
					"idle timeout",
				);
				assertStreamMs(
					Reflect.get(transport, "maxDurationMs"),
					`${fieldPath}.maxDurationMs`,
					STREAM_MAX_DURATION_MS_MIN,
					STREAM_MAX_DURATION_MS_MAX,
					"max duration",
				);
				assertPositiveBytes(
					Reflect.get(transport, "maxChunkBytes"),
					`${fieldPath}.maxChunkBytes`,
				);
				break;
			}
			case "websocket": {
				rejectUnknownFields(transport, WEBSOCKET_TRANSPORT_FIELDS, fieldPath);
				const dispatch = Reflect.get(transport, "dispatch");
				if (dispatch !== "unsupported") {
					throw new ValidationError(
						`Provider "${providerId}" operation "${operationName}" has invalid ${fieldPath}.dispatch: websocket dispatch is future-ready only.`,
						{
							fix: `Use ${fieldPath}.dispatch: "unsupported" until gateway-managed sessions are implemented.`,
						},
					);
				}
				const subprotocols = Reflect.get(transport, "subprotocols");
				if (subprotocols !== undefined) {
					if (!Array.isArray(subprotocols)) {
						throw new ValidationError(
							`Provider "${providerId}" operation "${operationName}" has invalid ${fieldPath}.subprotocols: must be an array.`,
							{
								fix: `Set ${fieldPath}.subprotocols to an array of WebSocket subprotocol tokens.`,
							},
						);
					}
					for (const subprotocol of subprotocols) {
						if (
							typeof subprotocol !== "string" ||
							!WEBSOCKET_SUBPROTOCOL_REGEX.test(subprotocol)
						) {
							throw new ValidationError(
								`Provider "${providerId}" operation "${operationName}" has invalid ${fieldPath}.subprotocols: each subprotocol must be an RFC token string.`,
								{
									fix: `Use values such as "apifuse.v1" without spaces or separators that are invalid for Sec-WebSocket-Protocol.`,
								},
							);
						}
					}
				}
				assertStreamMs(
					Reflect.get(transport, "idleTimeoutMs"),
					`${fieldPath}.idleTimeoutMs`,
					STREAM_IDLE_TIMEOUT_MS_MIN,
					STREAM_IDLE_TIMEOUT_MS_MAX,
					"idle timeout",
				);
				assertStreamMs(
					Reflect.get(transport, "maxDurationMs"),
					`${fieldPath}.maxDurationMs`,
					STREAM_MAX_DURATION_MS_MIN,
					STREAM_MAX_DURATION_MS_MAX,
					"max duration",
				);
				assertPositiveBytes(
					Reflect.get(transport, "maxFrameBytes"),
					`${fieldPath}.maxFrameBytes`,
				);
				break;
			}
		}
	}
}

const HEALTH_CHECK_SUITE_FIELDS = new Set([
	"interval",
	"schedule",
	"timeoutMs",
	"degradedThresholdMs",
	"cases",
	"requiresConnection",
]);
const HEALTH_CHECK_CASE_FIELDS = new Set([
	"name",
	"description",
	"input",
	"prepareInput",
	"assertions",
	"degradedThresholdMs",
	"timeoutMs",
	"expectedStatus",
	"enabled",
]);
const HEALTH_CHECK_UNSUPPORTED_FIELDS = new Set(["reason", "trackedIn"]);
const PROVIDER_HEALTH_MONITOR_FIELDS = new Set([
	"defaultProbeTimeoutMs",
	"defaultDegradedThresholdMs",
	"requiredSecrets",
	"credentialInputs",
	"probeOverrides",
	"serviceAccount",
]);
const PROVIDER_HEALTH_MONITOR_PROBE_OVERRIDE_FIELDS = new Set([
	"interval",
	"timeoutMs",
	"degradedThresholdMs",
]);

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const prev = new Array<number>(n + 1);
	const curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			const deletion = (prev[j] ?? 0) + 1;
			const insertion = (curr[j - 1] ?? 0) + 1;
			const substitution = (prev[j - 1] ?? 0) + cost;
			curr[j] = Math.min(deletion, insertion, substitution);
		}
		for (let j = 0; j <= n; j++) prev[j] = curr[j] ?? 0;
	}
	return prev[n] ?? 0;
}

function suggestField(
	unknown: string,
	candidates: ReadonlySet<string>,
): string | undefined {
	let best: string | undefined;
	let bestDist = 3;
	for (const candidate of candidates) {
		const dist = levenshtein(unknown, candidate);
		if (dist < bestDist) {
			bestDist = dist;
			best = candidate;
		}
	}
	return best;
}

function rejectUnknownFields(
	value: object,
	allowed: ReadonlySet<string>,
	fieldPath: string,
): void {
	for (const key of Object.keys(value)) {
		if (allowed.has(key)) continue;
		const hint = suggestField(key, allowed);
		throw new ValidationError(
			hint
				? `Unknown field "${key}" on ${fieldPath}. Did you mean "${hint}"?`
				: `Unknown field "${key}" on ${fieldPath}.`,
			{ fix: `Remove ${fieldPath}.${key} or rename it.` },
		);
	}
}

function assertBoundedIntegerMs(
	value: unknown,
	fieldPath: string,
	options: { min: number; max: number; label: string },
): void {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < options.min ||
		value > options.max
	) {
		throw new ValidationError(
			`${fieldPath} must be an integer ${options.label} in [${options.min}, ${options.max}] ms.`,
			{
				fix: `Set ${fieldPath} to an integer in [${options.min}, ${options.max}] ms.`,
			},
		);
	}
}

function validateProviderHealthMonitor(
	providerId: string,
	healthMonitor: unknown,
): void {
	if (healthMonitor === undefined) return;
	if (
		!healthMonitor ||
		typeof healthMonitor !== "object" ||
		Array.isArray(healthMonitor)
	)
		throw new ValidationError(
			`Provider "${providerId}" has invalid healthMonitor: must be an object.`,
			{
				fix: `Set healthMonitor to { requiredSecrets?: string[]; serviceAccount?: string }`,
			},
		);
	const healthMonitorRecord = Object.fromEntries(Object.entries(healthMonitor));
	rejectUnknownFields(
		healthMonitorRecord,
		PROVIDER_HEALTH_MONITOR_FIELDS,
		"healthMonitor",
	);
	if (healthMonitorRecord.defaultProbeTimeoutMs !== undefined) {
		assertBoundedIntegerMs(
			healthMonitorRecord.defaultProbeTimeoutMs,
			`Provider "${providerId}" healthMonitor.defaultProbeTimeoutMs`,
			{
				min: HEALTH_CHECK_TIMEOUT_MS_MIN,
				max: HEALTH_CHECK_TIMEOUT_MS_MAX,
				label: "timeout",
			},
		);
	}
	if (healthMonitorRecord.defaultDegradedThresholdMs !== undefined) {
		assertBoundedIntegerMs(
			healthMonitorRecord.defaultDegradedThresholdMs,
			`Provider "${providerId}" healthMonitor.defaultDegradedThresholdMs`,
			{
				min: HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MIN,
				max: HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MAX,
				label: "degraded threshold",
			},
		);
	}
	const requiredSecrets = healthMonitorRecord.requiredSecrets;
	if (requiredSecrets !== undefined) {
		if (!Array.isArray(requiredSecrets))
			throw new ValidationError(
				`Provider "${providerId}" has invalid healthMonitor.requiredSecrets: must be string[].`,
			);
		for (const [index, secret] of requiredSecrets.entries()) {
			if (typeof secret !== "string" || secret.length === 0)
				throw new ValidationError(
					`Provider "${providerId}" has invalid healthMonitor.requiredSecrets[${index}]: must be a non-empty string.`,
				);
		}
	}
	const credentialInputs = healthMonitorRecord.credentialInputs;
	if (credentialInputs !== undefined) {
		if (
			!credentialInputs ||
			typeof credentialInputs !== "object" ||
			Array.isArray(credentialInputs)
		) {
			throw new ValidationError(
				`Provider "${providerId}" has invalid healthMonitor.credentialInputs: must be an object mapping auth input fields to env var names.`,
			);
		}
		for (const [field, envVar] of Object.entries(credentialInputs)) {
			if (field.trim().length === 0) {
				throw new ValidationError(
					`Provider "${providerId}" has invalid healthMonitor.credentialInputs key: must be a non-empty auth input field.`,
				);
			}
			if (typeof envVar !== "string" || envVar.trim().length === 0) {
				throw new ValidationError(
					`Provider "${providerId}" has invalid healthMonitor.credentialInputs.${field}: must be a non-empty env var name.`,
				);
			}
			if (Array.isArray(requiredSecrets) && !requiredSecrets.includes(envVar)) {
				throw new ValidationError(
					`Provider "${providerId}" healthMonitor.credentialInputs.${field} references ${envVar}, which must also be listed in healthMonitor.requiredSecrets.`,
				);
			}
		}
	}

	const probeOverrides = healthMonitorRecord.probeOverrides;
	if (probeOverrides !== undefined) {
		if (
			!probeOverrides ||
			typeof probeOverrides !== "object" ||
			Array.isArray(probeOverrides)
		)
			throw new ValidationError(
				`Provider "${providerId}" has invalid healthMonitor.probeOverrides: must be an object keyed by probe id.`,
			);
		for (const [probeId, override] of Object.entries(probeOverrides)) {
			if (probeId.length === 0)
				throw new ValidationError(
					`Provider "${providerId}" has invalid healthMonitor.probeOverrides key: must be a non-empty probe id.`,
				);
			if (!override || typeof override !== "object" || Array.isArray(override))
				throw new ValidationError(
					`Provider "${providerId}" has invalid healthMonitor.probeOverrides["${probeId}"]: must be an object.`,
				);
			const overrideRecord = Object.fromEntries(Object.entries(override));
			rejectUnknownFields(
				overrideRecord,
				PROVIDER_HEALTH_MONITOR_PROBE_OVERRIDE_FIELDS,
				`healthMonitor.probeOverrides["${probeId}"]`,
			);
			const interval = overrideRecord.interval;
			if (interval !== undefined && !isPositiveMsDurationString(interval))
				throw new ValidationError(
					`Provider "${providerId}" has invalid healthMonitor.probeOverrides["${probeId}"].interval: must be a positive ms-style duration string such as 30s, 5m, 8h, or 1 day.`,
				);
			if (overrideRecord.timeoutMs !== undefined) {
				assertBoundedIntegerMs(
					overrideRecord.timeoutMs,
					`Provider "${providerId}" healthMonitor.probeOverrides["${probeId}"].timeoutMs`,
					{
						min: HEALTH_CHECK_TIMEOUT_MS_MIN,
						max: HEALTH_CHECK_TIMEOUT_MS_MAX,
						label: "timeout",
					},
				);
			}
			if (overrideRecord.degradedThresholdMs !== undefined) {
				assertBoundedIntegerMs(
					overrideRecord.degradedThresholdMs,
					`Provider "${providerId}" healthMonitor.probeOverrides["${probeId}"].degradedThresholdMs`,
					{
						min: HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MIN,
						max: HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MAX,
						label: "degraded threshold",
					},
				);
			}
		}
	}
	const serviceAccount = healthMonitorRecord.serviceAccount;
	if (
		serviceAccount !== undefined &&
		(typeof serviceAccount !== "string" || serviceAccount.length === 0)
	)
		throw new ValidationError(
			`Provider "${providerId}" has invalid healthMonitor.serviceAccount: must be a non-empty string.`,
		);
}

function validateHealthCheckCase(
	providerId: string,
	operationName: string,
	caseValue: unknown,
	caseIndex: number,
): void {
	const fieldPath = `operations.${operationName}.healthCheck.cases[${caseIndex}]`;
	if (!caseValue || typeof caseValue !== "object" || Array.isArray(caseValue))
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath} must be an object.`,
		);
	rejectUnknownFields(
		caseValue as Record<string, unknown>,
		HEALTH_CHECK_CASE_FIELDS,
		fieldPath,
	);
	const c = caseValue as HealthCheckCase;
	if (typeof c.name !== "string" || c.name.length === 0)
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.name must be a non-empty string.`,
		);
	if (typeof c.assertions !== "function")
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.assertions must be a function.`,
			{
				fix: `Set ${fieldPath}.assertions to (ctx) => { ... } that throws on failure.`,
			},
		);
	if (c.prepareInput !== undefined && typeof c.prepareInput !== "function")
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.prepareInput must be a function.`,
		);
	if (
		c.degradedThresholdMs !== undefined &&
		(typeof c.degradedThresholdMs !== "number" ||
			!Number.isInteger(c.degradedThresholdMs) ||
			c.degradedThresholdMs < HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MIN ||
			c.degradedThresholdMs > HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MAX)
	)
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.degradedThresholdMs must be an integer degraded threshold in [${HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MIN}, ${HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MAX}] ms.`,
		);
	if (c.timeoutMs !== undefined) {
		assertBoundedIntegerMs(
			c.timeoutMs,
			`Provider "${providerId}" ${fieldPath}.timeoutMs`,
			{
				min: HEALTH_CHECK_TIMEOUT_MS_MIN,
				max: HEALTH_CHECK_TIMEOUT_MS_MAX,
				label: "timeout",
			},
		);
	}
	if (
		c.expectedStatus !== undefined &&
		c.expectedStatus !== "ok" &&
		c.expectedStatus !== "degraded"
	)
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.expectedStatus must be "ok" or "degraded".`,
		);
	if (c.enabled !== undefined && typeof c.enabled !== "function")
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.enabled must be a function returning boolean.`,
		);
}

function validateHealthCheckSuite(
	providerId: string,
	operationName: string,
	suite: unknown,
): void {
	const fieldPath = `operations.${operationName}.healthCheck`;
	if (!suite || typeof suite !== "object" || Array.isArray(suite))
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath} must be an object.`,
		);
	rejectUnknownFields(
		suite as Record<string, unknown>,
		HEALTH_CHECK_SUITE_FIELDS,
		fieldPath,
	);
	const s = suite as HealthCheckSuite;
	if (!isPositiveMsDurationString(s.interval))
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.interval must be a positive ms-style duration string such as 30s, 5m, 8h, or 1 day.`,
			{
				fix: `Set ${fieldPath}.interval to a positive ms-style duration string.`,
			},
		);
	if (s.schedule !== undefined) {
		if (
			!s.schedule ||
			typeof s.schedule !== "object" ||
			Array.isArray(s.schedule)
		) {
			throw new ValidationError(
				`Provider "${providerId}" ${fieldPath}.schedule must be an object.`,
			);
		}
		if (Reflect.get(s.schedule, "jitter") !== undefined) {
			throw new ValidationError(
				`Provider "${providerId}" ${fieldPath}.schedule.jitter is not supported for operation healthCheck schedules. Use schedule.randomize instead.`,
			);
		}
		rejectUnknownFields(
			s.schedule,
			new Set(["randomize"]),
			`${fieldPath}.schedule`,
		);
		const randomize = Reflect.get(s.schedule, "randomize");
		if (randomize !== undefined) {
			validateScheduleRandomization(
				randomize,
				`Provider "${providerId}" ${fieldPath}.schedule.randomize`,
				msDurationMs(s.interval),
			);
		}
	}
	if (s.timeoutMs !== undefined) {
		assertBoundedIntegerMs(
			s.timeoutMs,
			`Provider "${providerId}" ${fieldPath}.timeoutMs`,
			{
				min: HEALTH_CHECK_TIMEOUT_MS_MIN,
				max: HEALTH_CHECK_TIMEOUT_MS_MAX,
				label: "timeout",
			},
		);
	}
	if (s.degradedThresholdMs !== undefined) {
		assertBoundedIntegerMs(
			s.degradedThresholdMs,
			`Provider "${providerId}" ${fieldPath}.degradedThresholdMs`,
			{
				min: HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MIN,
				max: HEALTH_CHECK_DEGRADED_THRESHOLD_MS_MAX,
				label: "degraded threshold",
			},
		);
	}
	if (
		s.requiresConnection !== undefined &&
		typeof s.requiresConnection !== "boolean"
	)
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.requiresConnection must be a boolean.`,
		);
	if (!Array.isArray(s.cases) || s.cases.length === 0)
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.cases must be a non-empty array.`,
			{
				fix: `Add at least one HealthCheckCase to ${fieldPath}.cases.`,
			},
		);
	const seenNames = new Set<string>();
	for (const [index, caseValue] of s.cases.entries()) {
		validateHealthCheckCase(providerId, operationName, caseValue, index);
		const name = (caseValue as HealthCheckCase).name;
		if (seenNames.has(name))
			throw new ValidationError(
				`Provider "${providerId}" ${fieldPath}.cases has duplicate case name "${name}".`,
				{
					fix: `Rename one of the duplicate cases to be unique within the suite.`,
				},
			);
		seenNames.add(name);
	}
}

function validateHealthCheckUnsupported(
	providerId: string,
	operationName: string,
	unsupported: unknown,
): void {
	const fieldPath = `operations.${operationName}.healthCheckUnsupported`;
	if (
		!unsupported ||
		typeof unsupported !== "object" ||
		Array.isArray(unsupported)
	)
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath} must be an object.`,
		);
	rejectUnknownFields(
		unsupported as Record<string, unknown>,
		HEALTH_CHECK_UNSUPPORTED_FIELDS,
		fieldPath,
	);
	const u = unsupported as HealthCheckUnsupported;
	if (typeof u.reason !== "string" || u.reason.trim().length === 0)
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.reason must be a non-empty string.`,
			{
				fix: `Document why the operation cannot be probed (e.g., "Destructive mutation; cannot probe in production").`,
			},
		);
	if (u.trackedIn !== undefined && typeof u.trackedIn !== "string")
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.trackedIn must be a string when present.`,
		);
}

const HEALTH_JOURNEY_FIELDS = new Set([
	"id",
	"title",
	"description",
	"schedule",
	"coversOperations",
	"timeout",
	"cooldown",
	"smsMatchers",
	"requiredSecrets",
	"manualTrigger",
	"steps",
	"run",
]);
const HEALTH_JOURNEY_SCHEDULE_FIELDS = new Set([
	"kind",
	"interval",
	"jitter",
	"randomize",
]);
const HEALTH_JOURNEY_STEP_FIELDS = new Set([
	"id",
	"description",
	"operationId",
	"usesSmsMatcher",
	"coversOperations",
	"safeBoundary",
	"kind",
]);

const HEALTH_JOURNEY_MANUAL_TRIGGER_FIELDS = new Set([
	"enabled",
	"reason",
	"requiresAcknowledgement",
	"risk",
	"minManualInterval",
	"publicRationale",
]);
const HEALTH_JOURNEY_MANUAL_TRIGGER_DISABLED_FIELDS = new Set([
	"enabled",
	"reason",
]);
const HEALTH_JOURNEY_MANUAL_TRIGGER_ENABLED_FIELDS = new Set([
	"enabled",
	"requiresAcknowledgement",
	"risk",
	"minManualInterval",
	"publicRationale",
]);
const HEALTH_JOURNEY_MANUAL_TRIGGER_RISKS = new Set([
	"read_only",
	"writes_external_state",
	"sms_or_payment",
]);

function validateHealthJourneyManualTrigger(
	providerId: string,
	journeyId: string,
	manualTrigger: unknown,
): void {
	const fieldPath = `healthJourneys.${journeyId}.manualTrigger`;
	if (
		!manualTrigger ||
		typeof manualTrigger !== "object" ||
		Array.isArray(manualTrigger)
	) {
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath} must be an object when present.`,
		);
	}
	rejectUnknownFields(
		manualTrigger,
		HEALTH_JOURNEY_MANUAL_TRIGGER_FIELDS,
		fieldPath,
	);
	const enabled = Reflect.get(manualTrigger, "enabled");
	if (typeof enabled !== "boolean") {
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.enabled must be a boolean.`,
		);
	}
	if (enabled === false) {
		rejectUnknownFields(
			manualTrigger,
			HEALTH_JOURNEY_MANUAL_TRIGGER_DISABLED_FIELDS,
			fieldPath,
		);
		if (
			Reflect.get(manualTrigger, "reason") !== undefined &&
			(typeof Reflect.get(manualTrigger, "reason") !== "string" ||
				Reflect.get(manualTrigger, "reason") === "")
		) {
			throw new ValidationError(
				`Provider "${providerId}" ${fieldPath}.reason must be a non-empty string when present.`,
			);
		}
		return;
	}
	rejectUnknownFields(
		manualTrigger,
		HEALTH_JOURNEY_MANUAL_TRIGGER_ENABLED_FIELDS,
		fieldPath,
	);
	const requiresAcknowledgement = Reflect.get(
		manualTrigger,
		"requiresAcknowledgement",
	);
	if (typeof requiresAcknowledgement !== "boolean") {
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.requiresAcknowledgement must be a boolean.`,
		);
	}
	const risk = Reflect.get(manualTrigger, "risk");
	if (
		typeof risk !== "string" ||
		!HEALTH_JOURNEY_MANUAL_TRIGGER_RISKS.has(risk)
	) {
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.risk must be one of read_only, writes_external_state, or sms_or_payment.`,
		);
	}
	if (risk !== "read_only" && requiresAcknowledgement !== true) {
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.requiresAcknowledgement must be true when risk is writes_external_state or sms_or_payment.`,
		);
	}
	const minManualInterval = Reflect.get(manualTrigger, "minManualInterval");
	assertIsoDuration(
		minManualInterval,
		`Provider "${providerId}" ${fieldPath}.minManualInterval`,
	);
	if (isoDurationMs(minManualInterval) <= 0) {
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.minManualInterval must be a positive duration.`,
		);
	}
	const rationale = Reflect.get(manualTrigger, "publicRationale");
	if (typeof rationale !== "string" || rationale.trim().length === 0) {
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.publicRationale must be a non-empty string.`,
		);
	}
}

const SMS_OTP_MATCHER_FIELDS = new Set([
	"id",
	"country",
	"locale",
	"phoneNumber",
	"origins",
	"code",
	"maxAge",
	"waitTimeout",
	"clockSkew",
	"extractOtp",
]);
const SMS_OTP_CODE_FIELDS = new Set(["pattern", "capture"]);
const SMS_ORIGIN_FIELDS_BY_KIND: Record<string, ReadonlySet<string>> = {
	e164: new Set(["kind", "value", "display"]),
	nationalServiceCode: new Set(["kind", "country", "value", "display"]),
};
const DURATION_RE =
	/^P(?=\d|T\d)(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;
const E164_RE = /^\+[1-9]\d{1,14}$/;
const ISO_COUNTRY_RE = /^[A-Z]{2}$/;
const NATIONAL_SERVICE_CODE_RE = /^[0-9]{2,15}$/;
const BCP47_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const JOURNEY_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function assertIsoDuration(
	value: unknown,
	fieldPath: string,
): asserts value is string {
	if (typeof value !== "string" || !DURATION_RE.test(value)) {
		throw new ValidationError(
			`${fieldPath} must be an ISO 8601 duration for example PT8H or PT2M30S.`,
		);
	}
}

function isoDurationMs(value: string): number {
	const match = DURATION_RE.exec(value);
	if (!match) return 0;
	const days = Number(/(\d+)D/.exec(value)?.[1] ?? 0);
	const hours = Number(/(\d+)H/.exec(value)?.[1] ?? 0);
	const minutes = Number(/(\d+)M/.exec(value)?.[1] ?? 0);
	const seconds = Number(/(\d+(?:\.\d+)?)S/.exec(value)?.[1] ?? 0);
	return (
		days * 86_400_000 + hours * 3_600_000 + minutes * 60_000 + seconds * 1_000
	);
}

function scheduleRandomizationMs(
	randomize: unknown,
	fieldPath: string,
): number {
	const mode = Reflect.get(randomize as object, "mode");
	switch (mode) {
		case "centered": {
			const maxOffset = Reflect.get(randomize as object, "maxOffset");
			assertIsoDuration(maxOffset, `${fieldPath}.maxOffset`);
			return isoDurationMs(maxOffset);
		}
		case "delayed": {
			const maxDelay = Reflect.get(randomize as object, "maxDelay");
			assertIsoDuration(maxDelay, `${fieldPath}.maxDelay`);
			return isoDurationMs(maxDelay);
		}
		default:
			throw new ValidationError(
				`${fieldPath}.mode must be "centered" or "delayed".`,
			);
	}
}

function validateScheduleRandomization(
	randomize: unknown,
	fieldPath: string,
	intervalMs: number,
): void {
	if (!randomize || typeof randomize !== "object" || Array.isArray(randomize)) {
		throw new ValidationError(`${fieldPath} must be an object.`);
	}
	const mode = Reflect.get(randomize, "mode");
	const allowedFields =
		mode === "centered"
			? new Set(["mode", "maxOffset"])
			: new Set(["mode", "maxDelay"]);
	rejectUnknownFields(randomize, allowedFields, fieldPath);
	const offsetMs = scheduleRandomizationMs(randomize, fieldPath);
	if (offsetMs <= 0) {
		throw new ValidationError(`${fieldPath} duration must be positive.`);
	}
	if (offsetMs >= intervalMs) {
		throw new ValidationError(
			`${fieldPath} duration must be shorter than schedule interval.`,
		);
	}
}

function assertIsoCountry(
	value: unknown,
	fieldPath: string,
): asserts value is string {
	if (typeof value !== "string" || !ISO_COUNTRY_RE.test(value)) {
		throw new ValidationError(
			`${fieldPath} must be an ISO 3166-1 alpha-2 country code for example KR.`,
		);
	}
}

function normalizeIntervalDuration(input: string): string {
	const trimmed = input.trim();
	const shorthand = /^(\d+)(s|m|h|d)$/i.exec(trimmed);
	if (shorthand) {
		const durationMs = msDurationMs(trimmed);
		const unit = shorthand[2]?.toLowerCase();
		const amount =
			unit === "s"
				? durationMs / 1_000
				: unit === "m"
					? durationMs / 60_000
					: unit === "h"
						? durationMs / 3_600_000
						: durationMs / 86_400_000;
		if (!Number.isInteger(amount) || amount <= 0) {
			throw new ValidationError(
				`Journey schedule interval must be a positive duration.`,
			);
		}
		if (unit === "s") return `PT${amount}S`;
		if (unit === "m") return `PT${amount}M`;
		if (unit === "h") return `PT${amount}H`;
		if (unit === "d") return `P${amount}D`;
	}
	assertIsoDuration(trimmed, "journey schedule interval");
	return trimmed;
}

export function every(
	interval: string,
	options: { jitter?: string; randomize?: HealthScheduleRandomization } = {},
): HealthJourneySchedule {
	if (options.jitter !== undefined && options.randomize !== undefined) {
		throw new ValidationError(
			`Schedule cannot define both jitter and randomize. Use randomize instead.`,
		);
	}
	const schedule: HealthJourneySchedule = {
		kind: "interval",
		interval: normalizeIntervalDuration(interval),
	};
	if (options.randomize !== undefined) {
		schedule.randomize = options.randomize;
	}
	if (options.jitter !== undefined) {
		schedule.jitter = normalizeIntervalDuration(options.jitter);
	}
	return schedule;
}

export function centered(maxOffset: string): HealthScheduleRandomization {
	return { mode: "centered", maxOffset: normalizeIntervalDuration(maxOffset) };
}

export function delayed(maxDelay: string): HealthScheduleRandomization {
	return { mode: "delayed", maxDelay: normalizeIntervalDuration(maxDelay) };
}

function countCapturingGroups(pattern: RegExp): number {
	let count = 0;
	const source = pattern.source;
	let inCharacterClass = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (isRegexCharEscaped(source, i)) continue;
		if (char === "[") {
			inCharacterClass = true;
			continue;
		}
		if (char === "]") {
			inCharacterClass = false;
			continue;
		}
		if (inCharacterClass || char !== "(") continue;
		const next = source[i + 1];
		if (next === "?" && source[i + 2] !== "<") continue;
		if (
			next === "?" &&
			source[i + 2] === "<" &&
			(source[i + 3] === "=" || source[i + 3] === "!")
		)
			continue;
		count += 1;
	}
	return count;
}

function isRegexCharEscaped(source: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && source[i] === "\\"; i--) backslashes += 1;
	return backslashes % 2 === 1;
}

function validateSmsOrigin(origin: unknown, fieldPath: string): void {
	if (!origin || typeof origin !== "object" || Array.isArray(origin)) {
		throw new ValidationError(`${fieldPath} must be an object.`);
	}
	const kind = Reflect.get(origin, "kind");
	if (kind !== "e164" && kind !== "nationalServiceCode") {
		throw new ValidationError(
			`${fieldPath}.kind must be "e164" or "nationalServiceCode".`,
		);
	}
	rejectUnknownFields(origin, SMS_ORIGIN_FIELDS_BY_KIND[kind], fieldPath);
	if (kind === "e164") {
		if (
			typeof Reflect.get(origin, "value") !== "string" ||
			!E164_RE.test(Reflect.get(origin, "value"))
		) {
			throw new ValidationError(
				`${fieldPath}.value must be an ITU-T E.164 number for example +821012345678.`,
			);
		}
	} else {
		assertIsoCountry(Reflect.get(origin, "country"), `${fieldPath}.country`);
		if (
			typeof Reflect.get(origin, "value") !== "string" ||
			!NATIONAL_SERVICE_CODE_RE.test(Reflect.get(origin, "value"))
		) {
			throw new ValidationError(
				`${fieldPath}.value must be digits only for a national service code.`,
			);
		}
	}
	if (
		Reflect.get(origin, "display") !== undefined &&
		typeof Reflect.get(origin, "display") !== "string"
	) {
		throw new ValidationError(
			`${fieldPath}.display must be a string when present.`,
		);
	}
}

function validateSmsOtpMatcher(
	matcher: unknown,
	fieldPath: string,
): asserts matcher is SmsOtpMatcherDefinition {
	if (!matcher || typeof matcher !== "object" || Array.isArray(matcher)) {
		throw new ValidationError(`${fieldPath} must be an object.`);
	}
	rejectUnknownFields(matcher, SMS_OTP_MATCHER_FIELDS, fieldPath);
	const matcherId = Reflect.get(matcher, "id");
	if (typeof matcherId !== "string" || !JOURNEY_ID_RE.test(matcherId)) {
		throw new ValidationError(
			`${fieldPath}.id must be a kebab-case identifier.`,
		);
	}
	assertIsoCountry(Reflect.get(matcher, "country"), `${fieldPath}.country`);
	if (
		Reflect.get(matcher, "locale") !== undefined &&
		(typeof Reflect.get(matcher, "locale") !== "string" ||
			!BCP47_RE.test(Reflect.get(matcher, "locale")))
	) {
		throw new ValidationError(
			`${fieldPath}.locale must be a BCP 47 locale for example ko-KR.`,
		);
	}
	if (
		Reflect.get(matcher, "phoneNumber") !== undefined &&
		(typeof Reflect.get(matcher, "phoneNumber") !== "string" ||
			!E164_RE.test(Reflect.get(matcher, "phoneNumber")))
	) {
		throw new ValidationError(
			`${fieldPath}.phoneNumber must be an ITU-T E.164 number.`,
		);
	}
	const origins = Reflect.get(matcher, "origins");
	if (!Array.isArray(origins) || origins.length === 0) {
		throw new ValidationError(
			`${fieldPath}.origins must be a non-empty array.`,
		);
	}
	for (const [index, origin] of origins.entries()) {
		validateSmsOrigin(origin, `${fieldPath}.origins[${index}]`);
	}
	if (
		!Reflect.get(matcher, "code") ||
		typeof Reflect.get(matcher, "code") !== "object" ||
		Array.isArray(Reflect.get(matcher, "code"))
	) {
		throw new ValidationError(`${fieldPath}.code must be an object.`);
	}
	const code = Reflect.get(matcher, "code");
	rejectUnknownFields(code, SMS_OTP_CODE_FIELDS, `${fieldPath}.code`);
	const pattern = Reflect.get(code, "pattern");
	if (!(pattern instanceof RegExp) && typeof pattern !== "string") {
		throw new ValidationError(
			`${fieldPath}.code.pattern must be a RegExp or pattern source string.`,
		);
	}
	const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
	if (
		countCapturingGroups(regex) !== 1 &&
		Reflect.get(code, "capture") === undefined
	) {
		throw new ValidationError(
			`${fieldPath}.code.pattern must contain exactly one OTP capture or declare code.capture.`,
		);
	}
	if (
		Reflect.get(code, "capture") !== undefined &&
		typeof Reflect.get(code, "capture") !== "string" &&
		typeof Reflect.get(code, "capture") !== "number"
	) {
		throw new ValidationError(
			`${fieldPath}.code.capture must be a string or number when present.`,
		);
	}
	assertIsoDuration(Reflect.get(matcher, "maxAge"), `${fieldPath}.maxAge`);
	assertIsoDuration(
		Reflect.get(matcher, "waitTimeout"),
		`${fieldPath}.waitTimeout`,
	);
	if (Reflect.get(matcher, "clockSkew") !== undefined)
		assertIsoDuration(
			Reflect.get(matcher, "clockSkew"),
			`${fieldPath}.clockSkew`,
		);
}

export function defineSmsOtpMatcher(
	config: Omit<SmsOtpMatcherDefinition, "extractOtp">,
): SmsOtpMatcherDefinition {
	const rawPattern = config.code.pattern;
	const pattern =
		rawPattern instanceof RegExp
			? new RegExp(rawPattern.source, rawPattern.flags)
			: new RegExp(rawPattern);
	const matcher = {
		...config,
		extractOtp(body: string): string | null {
			pattern.lastIndex = 0;
			const match = pattern.exec(body);
			pattern.lastIndex = 0;
			if (!match) return null;
			const capture = config.code.capture;
			const code =
				typeof capture === "string"
					? match.groups?.[capture]
					: typeof capture === "number"
						? match[capture]
						: match[1];
			return typeof code === "string" ? code : null;
		},
	};
	validateSmsOtpMatcher(matcher, "smsOtpMatcher");
	return matcher;
}

export function defineHealthJourney(
	config: HealthJourneyDefinition,
): HealthJourneyDefinition {
	return config;
}

function validateHealthJourneySchedule(
	providerId: string,
	journeyId: string,
	schedule: unknown,
): void {
	const fieldPath = `healthJourneys.${journeyId}.schedule`;
	if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath} must be an object.`,
		);
	}
	rejectUnknownFields(schedule, HEALTH_JOURNEY_SCHEDULE_FIELDS, fieldPath);
	if (Reflect.get(schedule, "kind") !== "interval")
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath}.kind must be "interval".`,
		);
	const interval = Reflect.get(schedule, "interval");
	assertIsoDuration(interval, `Provider "${providerId}" ${fieldPath}.interval`);
	const randomize = Reflect.get(schedule, "randomize");
	if (
		Reflect.get(schedule, "jitter") !== undefined &&
		randomize !== undefined
	) {
		throw new ValidationError(
			`Provider "${providerId}" ${fieldPath} cannot define both jitter and randomize.`,
		);
	}
	if (Reflect.get(schedule, "jitter") !== undefined)
		assertIsoDuration(
			Reflect.get(schedule, "jitter"),
			`Provider "${providerId}" ${fieldPath}.jitter`,
		);
	if (randomize !== undefined) {
		validateScheduleRandomization(
			randomize,
			`Provider "${providerId}" ${fieldPath}.randomize`,
			isoDurationMs(interval),
		);
	}
}

function validateHealthJourneys(
	providerId: string,
	operations: Record<string, ProviderOperation>,
	healthJourneys: readonly HealthJourneyDefinition[] | undefined,
): Set<string> {
	const covered = new Set<string>();
	if (healthJourneys === undefined) return covered;
	if (!Array.isArray(healthJourneys)) {
		throw new ValidationError(
			`Provider "${providerId}" healthJourneys must be an array.`,
		);
	}
	const journeyIds = new Set<string>();
	for (const [index, journey] of healthJourneys.entries()) {
		const prefix = `healthJourneys[${index}]`;
		if (!journey || typeof journey !== "object" || Array.isArray(journey)) {
			throw new ValidationError(
				`Provider "${providerId}" ${prefix} must be an object.`,
			);
		}
		rejectUnknownFields(journey, HEALTH_JOURNEY_FIELDS, prefix);
		if (typeof journey.id !== "string" || !JOURNEY_ID_RE.test(journey.id)) {
			throw new ValidationError(
				`Provider "${providerId}" ${prefix}.id must be a kebab-case identifier.`,
			);
		}
		if (journeyIds.has(journey.id))
			throw new ValidationError(
				`Provider "${providerId}" has duplicate health journey id "${journey.id}".`,
			);
		journeyIds.add(journey.id);
		validateHealthJourneySchedule(providerId, journey.id, journey.schedule);
		if (
			!Array.isArray(journey.coversOperations) ||
			journey.coversOperations.length === 0
		) {
			throw new ValidationError(
				`Provider "${providerId}" healthJourneys.${journey.id}.coversOperations must be a non-empty array.`,
			);
		}
		for (const operationId of journey.coversOperations) {
			if (typeof operationId !== "string" || operationId.length === 0) {
				throw new ValidationError(
					`Provider "${providerId}" healthJourneys.${journey.id}.coversOperations contains an invalid operation id.`,
				);
			}
			if (!operations[operationId]) {
				throw new ValidationError(
					`Provider "${providerId}" health journey "${journey.id}" covers unknown operation "${operationId}".`,
				);
			}
			if (operations[operationId].healthCheckUnsupported) {
				throw new ValidationError(
					`Provider "${providerId}" health journey "${journey.id}" cannot cover unsupported operation "${operationId}".`,
				);
			}
			covered.add(operationId);
		}
		if (!Array.isArray(journey.steps) || journey.steps.length === 0) {
			throw new ValidationError(
				`Provider "${providerId}" healthJourneys.${journey.id}.steps must be a non-empty array.`,
			);
		}
		const matcherIds = new Set<string>();
		if (journey.smsMatchers !== undefined) {
			if (!Array.isArray(journey.smsMatchers))
				throw new ValidationError(
					`Provider "${providerId}" healthJourneys.${journey.id}.smsMatchers must be an array.`,
				);
			for (const [matcherIndex, matcher] of journey.smsMatchers.entries()) {
				validateSmsOtpMatcher(
					matcher,
					`healthJourneys.${journey.id}.smsMatchers[${matcherIndex}]`,
				);
				if (matcherIds.has(matcher.id))
					throw new ValidationError(
						`Provider "${providerId}" healthJourneys.${journey.id}.smsMatchers has duplicate matcher id "${matcher.id}".`,
					);
				matcherIds.add(matcher.id);
			}
		}
		for (const [stepIndex, step] of journey.steps.entries()) {
			const stepPath = `healthJourneys.${journey.id}.steps[${stepIndex}]`;
			if (!step || typeof step !== "object" || Array.isArray(step))
				throw new ValidationError(
					`Provider "${providerId}" ${stepPath} must be an object.`,
				);
			rejectUnknownFields(step, HEALTH_JOURNEY_STEP_FIELDS, stepPath);
			if (typeof step.id !== "string" || !JOURNEY_ID_RE.test(step.id))
				throw new ValidationError(
					`Provider "${providerId}" ${stepPath}.id must be a kebab-case identifier.`,
				);
			if (step.operationId !== undefined && !operations[step.operationId])
				throw new ValidationError(
					`Provider "${providerId}" ${stepPath}.operationId references unknown operation "${step.operationId}".`,
				);
			if (
				step.usesSmsMatcher !== undefined &&
				!matcherIds.has(step.usesSmsMatcher)
			)
				throw new ValidationError(
					`Provider "${providerId}" ${stepPath}.usesSmsMatcher references unknown matcher "${step.usesSmsMatcher}".`,
				);
		}
		if (journey.manualTrigger !== undefined)
			validateHealthJourneyManualTrigger(
				providerId,
				journey.id,
				journey.manualTrigger,
			);
		if (journey.timeout !== undefined)
			assertIsoDuration(
				journey.timeout,
				`Provider "${providerId}" healthJourneys.${journey.id}.timeout`,
			);
		if (journey.cooldown !== undefined)
			assertIsoDuration(
				journey.cooldown,
				`Provider "${providerId}" healthJourneys.${journey.id}.cooldown`,
			);
		if (journey.run !== undefined && typeof journey.run !== "function") {
			throw new ValidationError(
				`Provider "${providerId}" healthJourneys.${journey.id}.run must be a function when present.`,
			);
		}
		if (journey.requiredSecrets !== undefined) {
			if (!Array.isArray(journey.requiredSecrets))
				throw new ValidationError(
					`Provider "${providerId}" healthJourneys.${journey.id}.requiredSecrets must be an array.`,
				);
			for (const secret of journey.requiredSecrets)
				if (typeof secret !== "string" || secret.length === 0)
					throw new ValidationError(
						`Provider "${providerId}" healthJourneys.${journey.id}.requiredSecrets entries must be non-empty strings.`,
					);
		}
	}
	return covered;
}

function validateOperationHealthChecks(
	providerId: string,
	operations: Record<string, ProviderOperation>,
	journeyCoveredOperations: ReadonlySet<string> = new Set(),
): void {
	for (const [operationName, operation] of Object.entries(operations)) {
		const hasCheck = operation.healthCheck !== undefined;
		const hasUnsupported = operation.healthCheckUnsupported !== undefined;
		if (hasCheck && hasUnsupported)
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" declares both healthCheck and healthCheckUnsupported. Choose exactly one.`,
				{
					fix: `Remove either operations.${operationName}.healthCheck or operations.${operationName}.healthCheckUnsupported.`,
				},
			);
		if (hasCheck)
			validateHealthCheckSuite(
				providerId,
				operationName,
				operation.healthCheck,
			);
		if (hasUnsupported)
			validateHealthCheckUnsupported(
				providerId,
				operationName,
				operation.healthCheckUnsupported,
			);
		if (
			!hasCheck &&
			!hasUnsupported &&
			!journeyCoveredOperations.has(operationName)
		)
			throw new ValidationError(
				`Provider "${providerId}" operation "${operationName}" declares neither healthCheck nor healthCheckUnsupported.`,
				{
					fix: `Add \`healthCheck: { interval, cases: [...] }\` or \`healthCheckUnsupported: { reason: "..." }\` to operations.${operationName}.`,
				},
			);
	}
}

function validateOperationFixtures(
	providerId: string,
	operations: Record<string, ProviderOperation>,
): void {
	for (const [operationName, operation] of Object.entries(operations)) {
		if (typeof operation.handler !== "function")
			throw new ValidationError(
				`Operation handler must be defined for provider "${providerId}" operation "${operationName}"`,
				{
					fix: `Add operations.${operationName}.handler as an async function with signature (ctx, input) => Promise<output>`,
				},
			);
		if (operation.fixtures?.request !== undefined) {
			const result = safeParseSchemaSync(
				operation.input,
				operation.fixtures.request,
				`operations.${operationName}.fixtures.request`,
			);
			if (!result.success)
				throw new ValidationError(
					`Fixture request does not match input schema for provider "${providerId}" operation "${operationName}"`,
					{
						fix: `Update operations.${operationName}.fixtures.request to match operations.${operationName}.input`,
						zodError: result.error,
					},
				);
		}
		if (operation.fixtures?.response !== undefined) {
			const result = safeParseSchemaSync(
				operation.output,
				operation.fixtures.response,
				`operations.${operationName}.fixtures.response`,
			);
			if (!result.success)
				throw new ValidationError(
					`Fixture response does not match output schema for provider "${providerId}" operation "${operationName}"`,
					{
						fix: `Update operations.${operationName}.fixtures.response to match operations.${operationName}.output`,
						zodError: result.error,
					},
				);
		}
	}
}

export function defineProvider<
	TOperations extends Record<string, ProviderOperation>,
	TConfig extends ProviderConfig<TOperations>,
>(
	config: TConfig & AuthStartNoInputGuard<TConfig>,
): ProviderDefinition & { operations: OperationMapConfig<TOperations> } {
	validateProviderShape(config);
	if (!CONNECTOR_ID_REGEX.test(config.id))
		throw new ProviderError(`Invalid provider id: "${config.id}"`, {
			fix: 'Use lowercase alphanumeric with dashes, e.g., "korea-air-quality"',
		});
	if (Object.keys(config.operations).length === 0)
		throw new ProviderError(
			`Provider "${config.id}" must define at least one operation`,
			{
				fix: "Add at least one operation to the operations object",
			},
		);
	validateOperationIds(config.id, config.operations);
	validateOperationAnnotations(config.id, config.operations);
	validateOperationObservability(config.id, config.operations);
	validateOperationTransports(config.id, config.operations);
	validateOperationContracts(config.id, config.operations);
	validateToolRouterMetadata(config.id, config.operations);
	const journeyCoveredOperations = validateHealthJourneys(
		config.id,
		config.operations,
		config.healthJourneys,
	);
	validateOperationHealthChecks(
		config.id,
		config.operations,
		journeyCoveredOperations,
	);
	validateProviderHealthMonitor(config.id, config.healthMonitor);
	validateOperationFixtures(config.id, config.operations);
	validateProviderProxy(config);
	validateProviderStt(config);
	validateNativeTcpEgressRules(config);
	if (config.runtime === "browser" && !config.browser)
		throw new ProviderError(
			`Provider "${config.id}" must define browser.engine when runtime is "browser"`,
			{
				fix: 'Add browser: { engine: "playwright-stealth" } for TypeScript providers, or another supported engine for your runtime',
			},
		);
	if (config.browser && config.runtime !== "browser")
		throw new ProviderError(
			`Provider "${config.id}" cannot define browser config unless runtime is "browser"`,
			{ fix: 'Set runtime: "browser" or remove the browser config' },
		);
	return {
		id: config.id,
		version: config.version,
		runtime: config.runtime,
		allowedHosts: config.allowedHosts,
		native: config.native,
		stealth: config.stealth,
		proxy: config.proxy,
		stt: config.stt,
		browser: config.browser,
		auth: config.auth,
		reviewed: config.reviewed,
		access: config.access,
		secrets: config.secrets,
		credential: config.credential,
		context: config.context,
		meta: config.meta,
		operations: config.operations,
		healthMonitor: config.healthMonitor,
		healthJourneys: config.healthJourneys,
	};
}
