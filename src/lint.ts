import type { ZodType } from "zod";

import {
	SDK_ERROR_REGISTRY_BY_CODE,
	SDK_RUNTIME_OWNED_ERROR_CODES,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
} from "./error-resolution.js";
import { legacyHandleOptionsOf } from "./handle/contract.js";
import {
	APIFUSE_HANDLE_META_KEY,
	type HandleFieldMeta,
	handleFieldDescription,
	isHandleFieldMeta,
} from "./handle-meta.js";
import { isExpectedErrorByCode } from "./health-scenario.js";
import {
	PROVIDER_ERROR_CATEGORIES,
	type ProviderErrorCategory,
	type ProviderErrorSource,
	sourceForCategory,
} from "./observability.js";
import { lintPublicSchemaFieldNames } from "./public-schema-field-lint.js";
import {
	isStealthOwnedHeaderName,
	SDK_OWNED_CHROME_HEADER_PREFIX,
} from "./runtime/stealth-owned-headers.js";
import { APIFUSE_DESCRIPTION_KEY_META_KEY, APIFUSE_SENSITIVE_META_KEY } from "./schema.js";
import type { AuthMode, OperationApprovalPolicy, OperationRiskClass } from "./types.js";
import { getTypeScript, scriptKindForSourceFile } from "./typescript-module.js";

type AuthModeLike =
	| "none"
	| "platform-managed"
	| "credentials"
	| "oauth2"
	| "oauth2_proxied"
	| "api-key";

const CREDENTIAL_BEARING_AUTH_MODES = [
	"credentials",
	"oauth2",
	"oauth2_proxied",
] satisfies readonly AuthMode[];

function isCredentialBearingAuthMode(mode: AuthModeLike | undefined): boolean {
	return CREDENTIAL_BEARING_AUTH_MODES.some((credentialMode) => credentialMode === mode);
}

function defaultApprovalPolicy(riskClass: OperationRiskClass): OperationApprovalPolicy {
	if (riskClass === "read") return "never";
	if (riskClass === "write") return "risk-based";
	return "always";
}

type ProviderAuthLike = {
	mode?: AuthModeLike;
	flow?: {
		start?: unknown;
		continue?: unknown;
		poll?: unknown;
		abort?: unknown;
		refresh?: unknown;
	};
	exchange?: unknown;
};

// Operations that perform an auth-lifecycle action belong on the single
// `auth.flow` interface, never on a provider operation:
//   - entry (login / signin / authenticate) => auth.flow.start/continue
//   - exit  (logout / signout / disconnect) => auth.flow.abort
//
// Matching works on `-`/`_` separated segments rather than a raw substring or a
// leading anchor, so `shop-logout`, `shop_logout` and `user-sign-out-everywhere`
// are all recognised: a domain prefix does not make the operation any less of an
// auth-lifecycle action, and operation ids may use either separator.
//
// Vocabulary is split into two tiers because auth words collide with ordinary
// domain verbs. Measured against the live fleet plus synthetic domain ids:
//   - `authorize-payment`, `revoke-invitation`, `unlink-record`,
//     `disconnect-device` are domain actions that never touch the connection
//     credential, so these verbs are NOT matched as segments;
//   - the same verbs as a complete operation id (`authorize`, `revoke`) do
//     refer to the credential itself, so they are matched only in that form.
// `exchange`, `callback`, `connect`, `session`, `token`, `credential`,
// `password` and `otp` stay out entirely for the same reason.
const AUTH_LIFECYCLE_SEGMENT_WORDS = new Set([
	"login",
	"logout",
	"signin",
	"signout",
	"signup",
	"authenticate",
	"reauth",
	"auth",
]);

// Ambiguous as a prefix, unambiguous when they are the whole operation id.
const AUTH_LIFECYCLE_WHOLE_ID_WORDS = new Set(["authorize", "revoke", "unlink", "disconnect"]);

// A verb stem followed by a direction word across two segments: `sign-out`,
// `user_sign_up_flow`, and the spelled-out `log-in` / `shop-log-out` forms
// (their fused equivalents `login`/`logout` live in the segment set above).
// `sign` pairs match anywhere; `log` pairs match only at the END of the id,
// because mid-id `log` is the noun in domain phrases measured against real
// fleets (`audit-log-in-range`, `change-log-out-of-band` are reads of a log,
// while `shop-log-out` is a logout).
const AUTH_DIRECTION_PAIRS: ReadonlyMap<
	string,
	{ directions: ReadonlySet<string>; endOnly: boolean }
> = new Map([
	["sign", { directions: new Set(["in", "out", "up"]), endOnly: false }],
	["log", { directions: new Set(["in", "out"]), endOnly: true }],
]);

// Legacy anchored form kept for token-plumbing words whose bare use is only
// auth-related when it leads the operation id (`exchange-code`, `refresh`).
const AUTH_OPERATION_ID_PATTERN =
	/^(?:auth[-_])?(?:login|exchange|continue|refresh|callback)(?:[-_]|$)/i;

function isAuthLifecycleOperationId(operationId: string, authMode: string): boolean {
	const segments = operationId.toLowerCase().split(/[-_]+/).filter(Boolean);

	if (segments.some((segment) => AUTH_LIFECYCLE_SEGMENT_WORDS.has(segment))) return true;

	// A verb stem + direction spread across two segments (`sign-out`,
	// `sign_up`, `shop-log-out`); see AUTH_DIRECTION_PAIRS for positioning.
	if (
		segments.some((segment, index) => {
			const pair = AUTH_DIRECTION_PAIRS.get(segment);
			if (pair === undefined || index + 1 >= segments.length) return false;
			if (!pair.directions.has(segments[index + 1] as string)) return false;
			return pair.endOnly ? index + 2 === segments.length : true;
		})
	) {
		return true;
	}

	if (segments.length === 1 && AUTH_LIFECYCLE_WHOLE_ID_WORDS.has(segments[0] as string)) {
		return true;
	}

	// The legacy anchored pattern keeps its original scope. It matches ordinary
	// domain ids such as `exchange-rates` and `refresh-catalog`, so extending it
	// to `oauth2_proxied` would spread that behavior to providers it never
	// applied to; proxied providers are covered by the segment tiers above.
	if (authMode === "credentials" || authMode === "oauth2") {
		return AUTH_OPERATION_ID_PATTERN.test(operationId);
	}

	return false;
}

type ProviderContractMetaLike = {
	publicSchemaFieldNames?: "normalized";
	pinnedWireFieldPaths?: readonly {
		readonly path: string;
		readonly reason: string;
	}[];
};

type SchemaLike = ZodType & {
	description?: string;
	def?: Record<string, unknown>;
	_def?: Record<string, unknown>;
	meta?: () => Record<string, unknown> | undefined;
	shape?: Record<string, SchemaLike> | (() => Record<string, SchemaLike>);
	element?: SchemaLike;
	items?: SchemaLike[];
	options?: SchemaLike[] | Set<SchemaLike> | Map<string, SchemaLike>;
	innerType?: SchemaLike;
	sourceType?: () => SchemaLike;
	unwrap?: () => SchemaLike;
	in?: SchemaLike;
	out?: SchemaLike;
	left?: SchemaLike;
	right?: SchemaLike;
};

export interface LintDiagnostic {
	rule: string;
	level: "error" | "warn";
	message: string;
	field?: string;
}

/**
 * `official` for fleet providers, `standalone` for bounty submissions
 * (`apifuse submit-check`). Drives the level of the browser-driver findings in
 * `bundleProvider`.
 */
export type ProviderLintMode = "official" | "standalone";

/**
 * @deprecated `lintProvider` takes no options: the browser-driver level the
 * mode used to drive now belongs to `bundleProvider(providerRoot, { mode })`.
 * The argument is ignored and is removed in the next major.
 */
type ProviderLintOptions = {
	mode?: ProviderLintMode;
};

let warnedProviderLintOptions = false;

function warnProviderLintOptionsOnce(options: ProviderLintOptions | undefined): void {
	if (options === undefined || warnedProviderLintOptions) return;
	warnedProviderLintOptions = true;
	console.warn(
		"[@apifuse/provider-sdk] lintProvider(provider, options) is deprecated: the options argument is ignored and is removed in the next major; pass mode to bundleProvider(providerRoot, { mode }) instead.",
	);
}

/**
 * A non-blocking audit line: a finding the author acknowledged with
 * `// @apifuse-allow <rule>: <reason>`, kept visible in `apifuse check` output.
 */
export interface ProviderLintInformation {
	rule: string;
	message: string;
	field?: string;
}

/** Diagnostics plus the acknowledged findings that accompany them. */
export interface ProviderLintResult {
	diagnostics: LintDiagnostic[];
	information: ProviderLintInformation[];
}

type ProviderSourceLike = {
	authFlowSource?: string;
	providerSourceFiles?: Record<string, string>;
	operations?: Record<string, { handler?: unknown; source?: string }>;
};

function lintAllowedHosts(
	providerId: string | undefined,
	allowedHosts: readonly string[] | undefined,
): LintDiagnostic[] {
	const prefix = providerId ? `Provider "${providerId}"` : "Provider";

	if (!allowedHosts) {
		return [
			{
				rule: "allowed-hosts-required",
				level: "error",
				field: "allowedHosts",
				message: `${prefix} must declare allowedHosts.`,
			},
		];
	}

	if (allowedHosts.length === 0) {
		return [
			{
				rule: "allowed-hosts-non-empty",
				level: "error",
				field: "allowedHosts",
				message: `${prefix} must declare at least one allowed host.`,
			},
		];
	}

	const wildcardHost = allowedHosts.find((host) => host.trim().includes("*"));
	if (wildcardHost) {
		return [
			{
				rule: "allowed-hosts-no-wildcards",
				level: "error",
				field: "allowedHosts",
				message: `${prefix} must not declare wildcard allowedHosts entries like "${wildcardHost}".`,
			},
		];
	}

	return [];
}

function lintReviewed(
	providerId: string | undefined,
	reviewed: string | undefined,
): LintDiagnostic[] {
	if (reviewed === "first-party" || reviewed === "community") {
		return [];
	}

	const prefix = providerId ? `Provider "${providerId}"` : "Provider";
	return [
		{
			rule: "reviewed-required",
			level: "error",
			field: "reviewed",
			message: `${prefix} must declare reviewed as "first-party" or "community".`,
		},
	];
}

function isProviderAuthLike(value: unknown): value is ProviderAuthLike {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasReusableSecretKeys(keys: readonly string[] | undefined): boolean {
	if (!keys) {
		return false;
	}

	return keys.some((key) =>
		/(access_token|refresh_token|password|secret|cookie|session|token|api[_-]?key)/i.test(key),
	);
}

function hasReusableReloginSecretKeys(keys: readonly string[] | undefined): boolean {
	if (!keys) {
		return false;
	}

	return keys.some((key) => /(password|passcode|secret|cookie|session)/i.test(key));
}

function getAuthFlowSource(provider: { auth?: ProviderAuthLike; authFlowSource?: string }): string {
	if (provider.authFlowSource) {
		return provider.authFlowSource;
	}

	const parts = [
		provider.auth?.flow?.start,
		provider.auth?.flow?.continue,
		provider.auth?.flow?.poll,
		provider.auth?.flow?.abort,
		provider.auth?.flow?.refresh,
	];

	return parts
		.filter((part): part is (...args: unknown[]) => unknown => typeof part === "function")
		.map((part) => part.toString())
		.join("\n");
}

function lintAuthModel(provider: {
	id?: string;
	auth?: ProviderAuthLike;
	credential?: {
		keys?: readonly string[];
		storesReusableSecret?: boolean;
		justification?: string;
	};
	context?: {
		keys?: readonly string[];
	};
	authFlowSource?: string;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const providerLabel = provider.id ? `Provider "${provider.id}"` : "Provider";
	const authMode = provider.auth?.mode;
	const credentialKeys = provider.credential?.keys ?? [];

	if (authMode === "api-key") {
		diagnostics.push({
			rule: "auth-mode-api-key-removed",
			level: "error",
			field: "auth.mode",
			message: `${providerLabel} must not use auth.mode "api-key".`,
		});
	}

	if (
		(authMode === "credentials" || authMode === "oauth2") &&
		typeof provider.auth?.flow?.continue !== "function"
	) {
		diagnostics.push({
			rule: "auth-flow-continue-required",
			level: "error",
			field: "auth.flow.continue",
			message: `${providerLabel} must define auth.flow.continue for ${authMode} auth mode.`,
		});
	}

	if (isProviderAuthLike(provider.auth) && "exchange" in provider.auth) {
		diagnostics.push({
			rule: "auth-exchange-unsupported",
			level: "error",
			field: "auth.exchange",
			message: `${providerLabel} must not define auth.exchange. The Provider SDK has one auth interface: auth.flow. Gateway only calls auth.flow.start/continue/poll/abort/refresh and persists complete turn data.credential as-is; put login/token/session exchange inside auth.flow.continue.`,
		});
	}

	if (authMode === "credentials" && credentialKeys.length === 0) {
		diagnostics.push({
			rule: "credential-keys-required-when-credentials-mode",
			level: "error",
			field: "credential.keys",
			message: `${providerLabel} must declare credential.keys for credentials auth mode.`,
		});
	}

	if (
		hasReusableSecretKeys(credentialKeys) &&
		(!provider.credential?.storesReusableSecret || !provider.credential.justification)
	) {
		diagnostics.push({
			rule: "credential-reusable-secret",
			level: "error",
			field: "credential",
			message: `${providerLabel} must set storesReusableSecret and justification when credential.keys includes reusable secrets.`,
		});
	}

	if (
		typeof provider.auth?.flow?.refresh === "function" &&
		hasReusableReloginSecretKeys(credentialKeys) &&
		(!provider.credential?.storesReusableSecret || !provider.credential.justification)
	) {
		diagnostics.push({
			rule: "auth-refresh-reusable-secret",
			level: "error",
			field: "credential",
			message: `${providerLabel} must set storesReusableSecret and justification when auth.flow.refresh may silently re-login with reusable credential secrets.`,
		});
	}

	if (authMode === "platform-managed" && credentialKeys.length > 0) {
		diagnostics.push({
			rule: "platform-managed-no-credential-keys",
			level: "error",
			field: "credential.keys",
			message: `${providerLabel} must not declare credential.keys because platform-managed auth mode already implies the unfiltered credential capability.`,
		});
	}

	const authFlowSource = getAuthFlowSource(provider);
	if (authFlowSource.includes("ctx.context") && (provider.context?.keys?.length ?? 0) === 0) {
		diagnostics.push({
			rule: "context-keys-required",
			level: "warn",
			field: "context.keys",
			message: `${providerLabel} should declare context.keys when auth flow code accesses ctx.context.*.`,
		});
	}

	return diagnostics;
}

function isSchema(value: unknown): value is SchemaLike {
	return (
		!!value &&
		typeof value === "object" &&
		"safeParse" in value &&
		typeof value.safeParse === "function"
	);
}

function getSchemaDef(schema: SchemaLike): Record<string, unknown> {
	const def = schema.def ?? schema._def;
	if (def && typeof def === "object") {
		return def;
	}
	return {};
}

function isSchemaRecord(value: unknown): value is Record<string, SchemaLike> {
	if (!value || typeof value !== "object") {
		return false;
	}
	for (const entry of Object.values(value)) {
		if (!isSchema(entry)) {
			return false;
		}
	}
	return true;
}

function getObjectShape(schema: SchemaLike): Record<string, SchemaLike> {
	const rawShape = typeof schema.shape === "function" ? schema.shape() : schema.shape;
	if (isSchemaRecord(rawShape)) {
		return rawShape;
	}

	const defShape = getSchemaDef(schema).shape;
	if (typeof defShape === "function") {
		const resolved = defShape();
		if (isSchemaRecord(resolved)) {
			return resolved;
		}
		return {};
	}

	if (isSchemaRecord(defShape)) {
		return defShape;
	}
	return {};
}

/**
 * Child edges of a schema node. `origin: "shape"` marks object properties whose
 * key is provider-chosen (and may collide with a structural edge name such as
 * `item`, `type`, or `schema`); `origin: "structural"` marks zod internals
 * (wrappers, array elements, union options, pipe stages).
 */
type SchemaChildEdge = { key: string; schema: SchemaLike; origin: "shape" | "structural" };

function getChildSchemas(schema: SchemaLike): SchemaChildEdge[] {
	const seen = new Map<string, SchemaLike>();
	const origins = new Map<string, "shape" | "structural">();
	const def = getSchemaDef(schema);

	const add = (key: string, value: unknown, origin: "shape" | "structural" = "structural") => {
		if (!isSchema(value)) {
			return;
		}
		const id = `${key}:${seen.size}`;
		seen.set(id, value);
		origins.set(id, origin);
	};

	for (const [key, value] of Object.entries(getObjectShape(schema))) {
		add(key, value, "shape");
	}

	add("element", schema.element);
	add("innerType", schema.innerType);
	add("unwrap", schema.unwrap?.());
	add("sourceType", schema.sourceType?.());
	add("in", schema.in);
	add("out", schema.out);
	add("left", schema.left);
	add("right", schema.right);

	if (Array.isArray(schema.items)) {
		for (const [index, item] of schema.items.entries()) {
			add(String(index), item);
		}
	}

	if (Array.isArray(def.items)) {
		for (const [index, item] of def.items.entries()) {
			add(String(index), item);
		}
	}

	const options = schema.options ?? def.options;
	if (Array.isArray(options)) {
		for (const [index, option] of options.entries()) {
			add(String(index), option);
		}
	} else if (options instanceof Set) {
		for (const [index, option] of Array.from(options).entries()) {
			add(String(index), option);
		}
	} else if (options instanceof Map) {
		for (const [key, option] of options.entries()) {
			add(String(key), option);
		}
	}

	for (const key of [
		"schema",
		"innerType",
		"type",
		// zod v4 intersections keep their branches on the definition.
		"left",
		"right",
		"valueType",
		"keyType",
		"item",
		"rest",
		"catchall",
		"option",
		"pipe",
		"payload",
		"shape",
	]) {
		const value = def[key];
		if (Array.isArray(value)) {
			for (const [index, item] of value.entries()) {
				add(`${key}.${index}`, item);
			}
		} else {
			add(key, value);
		}
	}

	return Array.from(seen.entries()).map(([entryKey, child]) => ({
		key: entryKey.split(":")[0] ?? entryKey,
		schema: child,
		origin: origins.get(entryKey) ?? "structural",
	}));
}

function uniqueFields(fields: string[]): string[] {
	return Array.from(new Set(fields));
}

function readSensitivityDeclaration(
	schema: unknown,
	seen = new Set<unknown>(),
): boolean | undefined {
	// Declarations sit on the leaf; same-path wrappers such as .optional(),
	// .nullable(), .pipe() or z.lazy() carry no metadata of their own, so look
	// through them.
	if (!isSchema(schema) || seen.has(schema)) return undefined;
	seen.add(schema);
	const value = Reflect.get(getSchemaMetadata(schema), APIFUSE_SENSITIVE_META_KEY);
	if (typeof value === "boolean") return value;
	const def = getSchemaDef(schema);
	const children =
		def.type === "pipe"
			? [def.in, def.out]
			: def.type === "lazy" && typeof def.getter === "function"
				? [def.getter()]
				: [def.innerType];
	for (const child of children) {
		const declaration = readSensitivityDeclaration(child, seen);
		if (declaration !== undefined) return declaration;
	}
	return undefined;
}

function getSchemaMetadata(schema: SchemaLike): Record<string, unknown> {
	return schema.meta?.() ?? {};
}

function getSchemaDescriptionKey(schema: SchemaLike): string | undefined {
	const value = Reflect.get(getSchemaMetadata(schema), APIFUSE_DESCRIPTION_KEY_META_KEY);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

const SENSITIVE_FIELD_NAMES = new Set([
	"apikey",
	"authorization",
	"cookie",
	"secret",
	"secrets",
	"token",
	"accesstoken",
	"refreshtoken",
	"password",
	"passwd",
	"otp",
	"otpcode",
	"phone",
	"phonenumber",
	"paymenturl",
]);

// Only phone-shaped keys can hold reviewed public data (facility phones); the
// rest are credentials, which a public declaration must not launder.
const PUBLIC_DECLARABLE_FIELD_NAMES = new Set(["phone", "phonenumber"]);

function normalizeFieldName(name: string): string {
	return name.toLowerCase().replace(/[-_\s]/g, "");
}

function isSensitiveFieldName(name: string): boolean {
	return SENSITIVE_FIELD_NAMES.has(normalizeFieldName(name));
}

function isDeclaredSensitiveField(key: string, schema: unknown): boolean {
	const declaration = readSensitivityDeclaration(schema);
	return (
		declaration === true ||
		(declaration === false && PUBLIC_DECLARABLE_FIELD_NAMES.has(normalizeFieldName(key)))
	);
}

// Child keys produced by getChildSchemas() that wrap a schema without adding a
// property path segment (optional/nullable/default/pipe/effects/etc.).
const SCHEMA_WRAPPER_NODE_KEYS: readonly string[] = [
	"unwrap",
	"innerType",
	"sourceType",
	"schema",
	"type",
	"in",
	"out",
	"option",
	"pipe",
	"payload",
	"item",
	"rest",
	"catchall",
	"keyType",
	"valueType",
	// zod v4 intersection branches: transparent, the enclosing property key applies.
	"left",
	"right",
];

function isSchemaWrapperNodeKey(key: string): boolean {
	return SCHEMA_WRAPPER_NODE_KEYS.includes(key) || key.startsWith("pipe.");
}

function getOwnHandleFieldMeta(schema: SchemaLike): HandleFieldMeta | undefined {
	const value = Reflect.get(getSchemaMetadata(schema), APIFUSE_HANDLE_META_KEY);
	return isHandleFieldMeta(value) ? value : undefined;
}

/**
 * True when `schema` is a handle field (directly or through zod wrappers) whose
 * description is still the SDK-generated wording and no wrapper adds its own
 * description.
 */
function isSdkOwnedHandleField(schema: unknown, seen = new Set<SchemaLike>()): boolean {
	if (!isSchema(schema) || seen.has(schema)) return false;
	seen.add(schema);
	const own = getOwnHandleFieldMeta(schema);
	if (own) return schema.description === handleFieldDescription(own);
	if (schema.description) return false;
	for (const child of getChildSchemas(schema)) {
		if (child.origin === "shape" || !isSchemaWrapperNodeKey(child.key)) continue;
		if (isSdkOwnedHandleField(child.schema, seen)) return true;
	}
	return false;
}

function collectUnmarkedSensitiveFields(
	schema: unknown,
	basePath: string,
	seen = new Set<SchemaLike>(),
): string[] {
	if (!isSchema(schema) || seen.has(schema)) {
		return [];
	}
	seen.add(schema);
	const out: string[] = [];
	for (const [key, child] of Object.entries(getObjectShape(schema))) {
		const childPath = basePath ? `${basePath}.${key}` : key;
		if (isSensitiveFieldName(key) && !isDeclaredSensitiveField(key, child)) {
			out.push(childPath);
		}
		out.push(...collectUnmarkedSensitiveFields(child, childPath, seen));
	}
	for (const child of getChildSchemas(schema)) {
		if (Object.hasOwn(getObjectShape(schema), child.key)) continue;
		const isWrapperNode = SCHEMA_WRAPPER_NODE_KEYS.includes(child.key);
		const childPath =
			child.key === "element" || child.key.startsWith("element.")
				? `${basePath}[]`
				: isWrapperNode || child.key.startsWith("pipe.")
					? basePath
					: basePath
						? `${basePath}.${child.key}`
						: child.key;
		out.push(...collectUnmarkedSensitiveFields(child.schema, childPath, seen));
	}
	return out;
}

function collectSchemaDescriptionKeyDiagnostics(
	schema: unknown,
	basePath: string,
	seen = new Set<SchemaLike>(),
	requireCurrentDescription = true,
): LintDiagnostic[] {
	if (!isSchema(schema) || seen.has(schema)) {
		return [];
	}

	seen.add(schema);
	const diagnostics: LintDiagnostic[] = [];
	const currentPath = basePath || "schema";
	const hasDescriptionKey = getSchemaDescriptionKey(schema) !== undefined;

	// Handle fields (`kind.field()`, ADR-0012) carry SDK-owned wording via
	// .describe() plus x-apifuse-handle meta; they count as described and are
	// leaves, so neither this node nor its wrapper chain needs a describeKey.
	// A provider override of that wording (`.describe("…")` on the field or on
	// a wrapper) is provider prose again and stays subject to the rules below.
	if (isSdkOwnedHandleField(schema)) {
		return diagnostics;
	}

	if (schema.description && !hasDescriptionKey) {
		diagnostics.push({
			rule: "schema-description-raw-prose",
			level: "error",
			field: currentPath,
			message: `Schema field "${currentPath}" must use .describeKey() or describeKey() instead of raw static prose.`,
		});
	}

	if (requireCurrentDescription && !hasDescriptionKey) {
		diagnostics.push({
			rule: "schema-description-key-required",
			level: "error",
			field: currentPath,
			message: schema.description
				? `Schema field "${currentPath}" has a raw description but is missing .describeKey() or describeKey() metadata.`
				: `Schema field "${currentPath}" is missing .describeKey() or describeKey() metadata.`,
		});
	}

	for (const child of getChildSchemas(schema)) {
		const isWrapperNode = SCHEMA_WRAPPER_NODE_KEYS.includes(child.key);
		const isStructuralNode =
			isWrapperNode ||
			child.key.startsWith("pipe.") ||
			child.key === "element" ||
			child.key.startsWith("element.");
		const childPath = isWrapperNode
			? currentPath
			: currentPath === "schema"
				? child.key
				: /^\d+$/.test(child.key)
					? `${currentPath}[${child.key}]`
					: child.key === "element" || child.key.startsWith("element.")
						? `${currentPath}[]`
						: `${currentPath}.${child.key}`;
		diagnostics.push(
			...collectSchemaDescriptionKeyDiagnostics(child.schema, childPath, seen, !isStructuralNode),
		);
	}

	return diagnostics;
}

function hasBidirectionalFixtures(fixtures: unknown): boolean {
	if (!fixtures || typeof fixtures !== "object") {
		return true;
	}

	return "request" in fixtures && "response" in fixtures;
}

function getOperationSource(operation: { handler?: unknown; source?: string }): string {
	if (operation.source) {
		return operation.source;
	}
	return typeof operation.handler === "function" ? operation.handler.toString() : "";
}

function lintStealthTransportUsage(provider: {
	id?: string;
	stealth?: unknown;
	operations?: Record<string, { handler?: unknown; source?: string }>;
}): LintDiagnostic[] {
	if (provider.stealth || !provider.operations) {
		return [];
	}

	const providerLabel = provider.id ? `Provider "${provider.id}"` : "Provider";
	return Object.entries(provider.operations).flatMap(([operationKey, operation]) => {
		const source = getOperationSource(operation);
		if (!/\bctx\.stealth\b/.test(source)) {
			return [];
		}
		return [
			{
				rule: "stealth-config-required",
				level: "error" as const,
				field: `operations.${operationKey}`,
				message: `${providerLabel} operation "${operationKey}" uses ctx.stealth but provider.stealth is not declared.`,
			},
		];
	});
}

function lintCredentialWriteUsage(provider: {
	operations?: Record<string, { handler?: unknown; source?: string }>;
}): LintDiagnostic[] {
	if (!provider.operations) {
		return [];
	}

	return Object.entries(provider.operations).flatMap(([operationKey, operation]) => {
		const source = getOperationSource(operation);
		if (!/\bctx\.credential\.(?:set|setMany)\s*\(/.test(source)) {
			return [];
		}

		return [
			{
				rule: "ctx-credential-write-forbidden-in-handler",
				level: "error" as const,
				field: `operations.${operationKey}.handler`,
				message:
					"Operation handlers must not mutate credentials; return refreshed credentials from auth.flow.refresh instead.",
			},
		];
	});
}

// Captures the constructor name so each rule can pick its own scope: the
// undeclared-code rule keeps its historical ProviderError/ValidationError
// surface, while the localization rules also cover AuthError.
const THROWN_ERROR_CONSTRUCTION_PATTERN = /new\s+(ProviderError|AuthError|ValidationError)\s*\(/g;
const UNDECLARED_CODE_ERROR_CLASSES: ReadonlySet<string> = new Set([
	"ProviderError",
	"ValidationError",
]);

const TEST_SOURCE_FILE_PATTERN = /(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
// Broader than TEST_SOURCE_FILE_PATTERN: also covers a plain `tests/`
// directory. Kept separate because merging the two would silently change what
// the older source rules scan.
const SHARED_TEST_SOURCE_FILE_PATTERN =
	/(?:^|\/)(?:__tests__|__mocks__|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const RECORDED_FIXTURE_SOURCE_FILE_PATTERN =
	/(?:^|\/)__fixtures__(?:\/|$)|(?:^|\/)__tests__\/fixtures(?:\/|$)/;
const JAVASCRIPT_SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const VERSIONED_PROFILE_LITERAL_PATTERN =
	/\b(?:chrome|chromium|firefox|safari|edge|opera|ios[-_]safari)[-_]\d+(?:[._-]\d+)*(?=$|[^A-Za-z0-9])/i;
const VERSIONED_USER_AGENT_PATTERN = /\b(?:Chrome|CriOS|Firefox|FxiOS|EdgA?|OPR)\/\d+(?:\.\d+)*/i;
const VERSIONED_SAFARI_USER_AGENT_PATTERN = /\bVersion\/(\d+(?:\.\d+)*)(?=[\s\S]*\bSafari\/\d)/i;
const VERSIONED_CLIENT_HINT_PATTERN = /(?:^|[;,\s])v\s*=\s*["']?\d+/i;
// Calls that write a header entry as (name, value): Headers/Map `set` and
// `append`, Node's `setHeader`. Predicates, replacements, and logging calls
// take string arguments too and must not count as header writes.
const HEADER_SETTER_CALLEE_PATTERN = /^(?:set|append|setHeader|addHeader)$/;
const OWNED_CLIENT_HINT_HEADER_PREFIX = "sec-ch-ua";

type BrowserVersionLiteralKind = "profile" | "user-agent" | "sec-ch-ua" | "owned-header";

type BrowserVersionLiteralFinding = {
	kind: BrowserVersionLiteralKind;
	literal: string;
	position: number;
};

function staticStringText(node: import("typescript").Node | undefined): string | undefined {
	if (!node) return undefined;
	const ts = getTypeScript();
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	return undefined;
}

function staticPropertyName(node: import("typescript").PropertyName): string | undefined {
	const ts = getTypeScript();
	if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
		return node.text;
	}
	if (ts.isComputedPropertyName(node)) return staticStringText(node.expression);
	return undefined;
}

function isSecChUaHeaderName(value: string | undefined): boolean {
	return value?.toLowerCase() === "sec-ch-ua";
}

/**
 * True for the code paths that reach the stealth transport: `ctx.stealth`,
 * `ctx["stealth"]`, and `const { stealth } = ctx`. Read from the AST so a
 * comment or string that mentions ctx.stealth does not scope a ctx.http file
 * into this rule.
 */
function isStealthContextAccess(node: import("typescript").Node): boolean {
	const ts = getTypeScript();
	if (ts.isPropertyAccessExpression(node)) {
		return (
			ts.isIdentifier(node.expression) &&
			node.expression.text === "ctx" &&
			node.name.text === "stealth"
		);
	}
	if (ts.isElementAccessExpression(node)) {
		return (
			ts.isIdentifier(node.expression) &&
			node.expression.text === "ctx" &&
			staticStringText(node.argumentExpression) === "stealth"
		);
	}
	if (ts.isBindingElement(node)) {
		const key = node.propertyName ?? node.name;
		if (!ts.isIdentifier(key) || key.text !== "stealth") return false;
		const declaration = node.parent?.parent;
		return (
			declaration !== undefined &&
			ts.isVariableDeclaration(declaration) &&
			declaration.initializer !== undefined &&
			ts.isIdentifier(declaration.initializer) &&
			declaration.initializer.text === "ctx"
		);
	}
	return false;
}

function isTupleTypeNode(type: import("typescript").TypeNode | undefined): boolean {
	if (!type) return false;
	const ts = getTypeScript();
	if (ts.isTypeOperatorNode(type)) return isTupleTypeNode(type.type);
	return ts.isTupleTypeNode(type);
}

/**
 * True where a two-element array is consumed as a `[name, value]` header entry:
 * inside an entries list (`new Headers([[name, value]])`,
 * `Object.fromEntries([...])`), passed to a call such as `tuples.push(...)`, or
 * declared with a tuple type. A two-name list is bound, iterated, or handed to
 * a constructor instead — `const STRIP = ["sec-fetch-dest", "referer"]`,
 * `for (const name of [...])`, `new Set([...])` — and is not an entry. The
 * position decides because a Sec-Fetch-* value ("document", "navigate") is
 * token-shaped exactly like a header name.
 */
function isHeaderEntryPosition(node: import("typescript").ArrayLiteralExpression): boolean {
	const ts = getTypeScript();
	let child: import("typescript").Node = node;
	let parent = node.parent;
	while (
		parent &&
		(ts.isParenthesizedExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isSatisfiesExpression(parent) ||
			ts.isTypeAssertionExpression(parent))
	) {
		if (!ts.isParenthesizedExpression(parent) && isTupleTypeNode(parent.type)) return true;
		child = parent;
		parent = parent.parent;
	}
	if (!parent) return false;
	if (ts.isArrayLiteralExpression(parent)) return true;
	if (ts.isCallExpression(parent)) return parent.arguments.some((argument) => argument === child);
	if (ts.isVariableDeclaration(parent)) {
		return parent.initializer === child && isTupleTypeNode(parent.type);
	}
	return false;
}

function isStaticUndefined(node: import("typescript").Node | undefined): boolean {
	if (!node) return false;
	const ts = getTypeScript();
	return (ts.isIdentifier(node) && node.text === "undefined") || ts.isVoidExpression(node);
}

function calleeName(node: import("typescript").CallExpression): string | undefined {
	const ts = getTypeScript();
	if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
	if (ts.isIdentifier(node.expression)) return node.expression.text;
	return undefined;
}

/**
 * Header names this rule reports in ctx.stealth files: the Sec-Fetch-* and
 * client-hint (sec-ch-ua*) families, restricted to what the stealth runtime
 * really rejects (isStealthOwnedHeaderName). Deliberately narrower than the
 * runtime rejection: host, connection, and accept-encoding are left alone
 * because ctx.http callers set them legitimately in the same files, and
 * user-agent only reaches a finding through the "user-agent" kind, which
 * matches a versioned literal value rather than the name.
 *
 * This rule is the early, same-file signal only. The complete check is the
 * offline test harness: `runStandardTests` runs every `ctx.stealth` request
 * through the runtime's own `assertCallerHeadersSupported`, so a header spread
 * from another module, or a user-agent read from a variable or
 * `getStealthProfile(...)`, fails the provider's tests exactly as it would fail
 * in production.
 */
function isReportedOwnedHeaderName(value: string | undefined): boolean {
	if (value === undefined) return false;
	const name = value.toLowerCase();
	if (!isStealthOwnedHeaderName(name)) return false;
	if (name.startsWith(SDK_OWNED_CHROME_HEADER_PREFIX)) {
		return name.length > SDK_OWNED_CHROME_HEADER_PREFIX.length;
	}
	return name.startsWith(OWNED_CLIENT_HINT_HEADER_PREFIX);
}

function collectBrowserVersionLiteralFindings(
	fileName: string,
	source: string,
): BrowserVersionLiteralFinding[] {
	const ts = getTypeScript();
	const sourceFile = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForSourceFile(ts, fileName),
	);
	let findings: BrowserVersionLiteralFinding[] = [];
	const seen = new Set<string>();
	// Owned-header entries only count once the file is known to reach
	// ctx.stealth, which may appear after the entry; collect them and decide
	// after the walk.
	let stealthAccess = false;
	const ownedHeaderEntries: Array<{ name: string; position: number; valuePosition?: number }> = [];

	const addFinding = (kind: BrowserVersionLiteralKind, literal: string, position: number) => {
		const key = `${kind}:${position}:${literal}`;
		if (seen.has(key)) return;
		seen.add(key);
		findings.push({ kind, literal, position });
	};

	const inspectLiteral = (text: string, position: number) => {
		const profile = text.match(VERSIONED_PROFILE_LITERAL_PATTERN)?.[0];
		if (profile) addFinding("profile", profile, position);

		const userAgent =
			text.match(VERSIONED_USER_AGENT_PATTERN)?.[0] ??
			text.match(VERSIONED_SAFARI_USER_AGENT_PATTERN)?.[0];
		if (userAgent) addFinding("user-agent", userAgent, position);
	};

	const inspectSecChUaValue = (node: import("typescript").Node | undefined) => {
		const text = staticStringText(node);
		if (text && VERSIONED_CLIENT_HINT_PATTERN.test(text)) {
			addFinding("sec-ch-ua", "sec-ch-ua", node!.getStart(sourceFile));
		}
	};

	// A header entry `name: value` in any of the shapes below. In a ctx.stealth
	// file an owned name is the finding (the runtime rejects it whatever the
	// value); elsewhere only a versioned sec-ch-ua value is. A statically
	// undefined value is exempt only in the "record" shapes, the ones the
	// runtime drops before the ownership check (`normalizedHeaderEntries`):
	// `Headers.set(name, undefined)` stringifies to "undefined" and still
	// throws, so it stays a finding.
	const inspectHeaderEntry = (
		nameNode: import("typescript").Node,
		name: string | undefined,
		valueNode: import("typescript").Node | undefined,
		ownedHeaderShape: false | "record" | "entry",
	) => {
		if (name === undefined) return;
		if (
			ownedHeaderShape !== false &&
			isReportedOwnedHeaderName(name) &&
			!(ownedHeaderShape === "record" && isStaticUndefined(valueNode))
		) {
			ownedHeaderEntries.push({
				name,
				position: nameNode.getStart(sourceFile),
				valuePosition: valueNode?.getStart(sourceFile),
			});
		}
		if (isSecChUaHeaderName(name)) inspectSecChUaValue(valueNode);
	};

	const visit = (node: import("typescript").Node) => {
		const text = staticStringText(node);
		if (text !== undefined) inspectLiteral(text, node.getStart(sourceFile));
		if (isStealthContextAccess(node)) stealthAccess = true;

		if (ts.isPropertyAssignment(node)) {
			inspectHeaderEntry(node.name, staticPropertyName(node.name), node.initializer, "record");
		}

		if (ts.isCallExpression(node) && node.arguments[0]) {
			// Only `headers.set(name, value)`-style calls write a header;
			// `name.startsWith("sec-fetch-")` or `log("sec-fetch-dest", x)` do not.
			inspectHeaderEntry(
				node.arguments[0],
				staticStringText(node.arguments[0]),
				node.arguments[1],
				node.arguments.length >= 2 && HEADER_SETTER_CALLEE_PATTERN.test(calleeName(node) ?? "")
					? "entry"
					: false,
			);
		}

		if (ts.isArrayLiteralExpression(node) && node.elements[0]) {
			// Only a `[name, value]` tuple is a header: a two-element array in an
			// entry position (isHeaderEntryPosition) whose second element is not
			// itself an owned name.
			const second = node.elements[1];
			inspectHeaderEntry(
				node.elements[0],
				staticStringText(node.elements[0]),
				second,
				node.elements.length === 2 &&
					isHeaderEntryPosition(node) &&
					!isStealthOwnedHeaderName(staticStringText(second) ?? "")
					? "entry"
					: false,
			);
		}

		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isElementAccessExpression(node.left)
		) {
			const nameNode = node.left.argumentExpression;
			inspectHeaderEntry(nameNode, staticStringText(nameNode), node.right, "record");
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	if (stealthAccess) {
		// The owned name is the finding; do not also report its sec-ch-ua value.
		const shadowedValues = new Set(ownedHeaderEntries.map((entry) => entry.valuePosition));
		findings = findings.filter(
			(finding) => !(finding.kind === "sec-ch-ua" && shadowedValues.has(finding.position)),
		);
		for (const entry of ownedHeaderEntries) {
			addFinding("owned-header", entry.name, entry.position);
		}
	}
	return findings.sort((left, right) => left.position - right.position);
}

function browserVersionLiteralMessage(finding: BrowserVersionLiteralFinding): string {
	switch (finding.kind) {
		case "profile":
			return `Hardcoded stealth profile "${finding.literal}" pins a browser version and will rot. Select the browser and OS structurally, for example stealth: { browser: "chrome", os: "macos" }.`;
		case "user-agent":
			return `Hardcoded User-Agent browser version "${finding.literal}" can disagree with the stealth TLS fingerprint. Remove the literal. ctx.stealth owns User-Agent and rejects a caller value with STEALTH_HEADER_OVERRIDE_UNSUPPORTED, so omit the header there and select the profile with stealth: { browser: "chrome", os: "macos" }. For ctx.http only, derive it from getStealthProfile({ browser: "chrome", os: "macos" }).userAgent.`;
		case "sec-ch-ua":
			return 'Hardcoded sec-ch-ua versions can disagree with the stealth TLS fingerprint. Remove the literal and let ctx.stealth generate client hints from stealth: { browser: "chrome", os: "macos" }. ctx.stealth also owns User-Agent, so omit that header there as well; for ctx.http only, derive it from getStealthProfile({ browser: "chrome", os: "macos" }).userAgent.';
		case "owned-header":
			return `ctx.stealth owns the "${finding.literal}" header and rejects a caller value with STEALTH_HEADER_OVERRIDE_UNSUPPORTED (HTTP 500 at request time). Remove it; declare stealth: { requestClass: "navigation" | "form-post" | "xhr" | "post" } to drive Sec-Fetch-* and select the profile with stealth: { browser: "chrome", os: "macos" } for client hints.`;
	}
}

function lintBrowserVersionLiterals(provider: ProviderSourceLike): LintDiagnostic[] {
	const sources: Array<{ field: string; fileName: string; source: string }> = [];
	const sourceFiles = Object.entries(provider.providerSourceFiles ?? {}).filter(
		([filePath]) =>
			JAVASCRIPT_SOURCE_FILE_PATTERN.test(filePath) &&
			!TEST_SOURCE_FILE_PATTERN.test(filePath) &&
			!RECORDED_FIXTURE_SOURCE_FILE_PATTERN.test(filePath),
	);
	if (sourceFiles.length > 0) {
		for (const [filePath, source] of sourceFiles) {
			sources.push({ field: `sourceFiles.${filePath}`, fileName: filePath, source });
		}
	} else {
		if (provider.authFlowSource)
			sources.push({
				field: "auth.flow",
				fileName: "auth-flow.ts",
				source: provider.authFlowSource,
			});
		for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
			const source = getOperationSource(operation);
			if (source)
				sources.push({
					field: `operations.${operationKey}.handler`,
					fileName: `${operationKey}.ts`,
					source,
				});
		}
	}

	return sources.flatMap(({ field, fileName, source }) =>
		collectBrowserVersionLiteralFindings(fileName, source).map((finding) => ({
			rule: "browser-version-literal",
			level: "error" as const,
			field,
			message: browserVersionLiteralMessage(finding),
		})),
	);
}

/**
 * Skips a string literal starting at `startIndex` (which must point at the
 * opening quote). Returns the index of the closing quote, or -1 when the
 * literal is unterminated. Template literals handle nested `${...}`
 * expressions, including strings inside them.
 */
function skipStringLiteral(source: string, startIndex: number): number {
	const quote = source[startIndex];
	for (let index = startIndex + 1; index < source.length; index++) {
		const char = source[index];
		if (char === "\\") {
			index++;
			continue;
		}
		if (quote === "`" && char === "$" && source[index + 1] === "{") {
			index = skipTemplateExpression(source, index + 2);
			if (index < 0) {
				return -1;
			}
			continue;
		}
		if (char === quote) {
			return index;
		}
		if (quote !== "`" && char === "\n") {
			return -1;
		}
	}
	return -1;
}

function skipTemplateExpression(source: string, startIndex: number): number {
	let depth = 1;
	for (let index = startIndex; index < source.length; index++) {
		const char = source[index];
		if (char === '"' || char === "'" || char === "`") {
			index = skipStringLiteral(source, index);
			if (index < 0) {
				return -1;
			}
			continue;
		}
		if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

/**
 * Extracts the argument text of a call whose opening paren has already been
 * consumed (`startIndex` points just past it). Returns undefined when the
 * call never closes in this source, which the caller treats as "skip
 * silently" — this scanner is conservative by design.
 */
function extractBalancedCallArguments(source: string, startIndex: number): string | undefined {
	let depth = 1;
	for (let index = startIndex; index < source.length; index++) {
		const char = source[index];
		if (char === '"' || char === "'" || char === "`") {
			index = skipStringLiteral(source, index);
			if (index < 0) {
				return undefined;
			}
			continue;
		}
		if (char === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index);
			if (newline === -1) {
				return undefined;
			}
			index = newline;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			if (end === -1) {
				return undefined;
			}
			index = end + 1;
			continue;
		}
		if (char === "(") {
			depth++;
		} else if (char === ")") {
			depth--;
			if (depth === 0) {
				return source.slice(startIndex, index);
			}
		}
	}
	return undefined;
}

/**
 * Option names whose value is read as a `true` / `false` literal instead of a
 * string literal. Collected as the text "true" / "false".
 */
const BOOLEAN_ERROR_OPTION_NAMES: ReadonlySet<string> = new Set(["retryable"]);

/**
 * Collects literal string values of the named top-level properties inside a
 * ProviderError/AuthError/ValidationError options object. Only plain `"..."` /
 * `'...'` literals at options-object depth count; computed values (identifiers,
 * ternaries, template substitutions, concatenations, escapes) are skipped
 * silently so the rules never guess. The first literal wins per property name.
 * Names in BOOLEAN_ERROR_OPTION_NAMES are read as boolean literals instead.
 */
function collectLiteralErrorOptionValues(
	args: string,
	optionNames: readonly string[],
	/**
	 * Receives every option name the object sets without a plain string literal:
	 * a variable or expression value (`category: mapped.category`), a shorthand
	 * member (`{ code, category }`), or a top-level spread whose text names it
	 * (`...(mapped.category ? { category: mapped.category } : {})`).
	 */
	nonLiteral?: Set<string>,
): Record<string, string> {
	const collected: Record<string, string> = {};
	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let previousSignificantChar = "";
	// Start of the top-level `...spread` member being read, or -1.
	let spreadStart = -1;
	const closeSpread = (end: number) => {
		if (spreadStart < 0) return;
		const text = args.slice(spreadStart, end);
		for (const name of optionNames) {
			if (new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`).test(text)) {
				nonLiteral?.add(name);
			}
		}
		spreadStart = -1;
	};
	for (let index = 0; index < args.length; index++) {
		const char = args[index] ?? "";
		if (char === '"' || char === "'" || char === "`") {
			const end = skipStringLiteral(args, index);
			if (end < 0) {
				return collected;
			}
			index = end;
			previousSignificantChar = char;
			continue;
		}
		if (char === "/" && args[index + 1] === "/") {
			const newline = args.indexOf("\n", index);
			if (newline === -1) {
				return collected;
			}
			index = newline;
			continue;
		}
		if (char === "/" && args[index + 1] === "*") {
			const end = args.indexOf("*/", index + 2);
			if (end === -1) {
				return collected;
			}
			index = end + 1;
			continue;
		}
		if (/\s/.test(char)) {
			continue;
		}
		if (char === "{") {
			braceDepth++;
		} else if (char === "}") {
			braceDepth--;
			if (braceDepth === 0) closeSpread(index);
		} else if (char === "(") {
			parenDepth++;
		} else if (char === ")") {
			parenDepth--;
		} else if (char === "[") {
			bracketDepth++;
		} else if (char === "]") {
			bracketDepth--;
		} else if (char === "," && braceDepth === 1 && parenDepth === 0 && bracketDepth === 0) {
			closeSpread(index);
		} else if (
			braceDepth === 1 &&
			parenDepth === 0 &&
			bracketDepth === 0 &&
			(previousSignificantChar === "{" || previousSignificantChar === ",")
		) {
			if (args.startsWith("...", index)) {
				spreadStart = index + 3;
				index += 2;
				previousSignificantChar = ".";
				continue;
			}
			const optionName = optionNames.find((name) => startsWithOptionName(args, index, name));
			if (optionName === undefined) {
				previousSignificantChar = char;
				continue;
			}
			let cursor = index + optionName.length;
			while (cursor < args.length && /\s/.test(args[cursor] ?? "")) {
				cursor++;
			}
			if (args[cursor] === ":") {
				cursor++;
				while (cursor < args.length && /\s/.test(args[cursor] ?? "")) {
					cursor++;
				}
				const quote = args[cursor];
				if (quote === '"' || quote === "'") {
					const end = skipStringLiteral(args, cursor);
					if (end > cursor) {
						const value = args.slice(cursor + 1, end);
						let after = end + 1;
						while (after < args.length && /\s/.test(args[after] ?? "")) {
							after++;
						}
						const nextChar = after < args.length ? (args[after] ?? "") : "";
						if (
							!value.includes("\\") &&
							(nextChar === "," || nextChar === "}" || nextChar === "")
						) {
							collected[optionName] ??= value;
						} else {
							nonLiteral?.add(optionName);
						}
						index = end;
						previousSignificantChar = quote;
						continue;
					}
					return collected;
				}
				if (BOOLEAN_ERROR_OPTION_NAMES.has(optionName)) {
					const word = args.startsWith("true", cursor)
						? "true"
						: args.startsWith("false", cursor)
							? "false"
							: undefined;
					if (word !== undefined) {
						let after = cursor + word.length;
						while (after < args.length && /\s/.test(args[after] ?? "")) {
							after++;
						}
						const nextChar = after < args.length ? (args[after] ?? "") : "";
						if (nextChar === "," || nextChar === "}" || nextChar === "") {
							collected[optionName] ??= word;
							index = cursor + word.length - 1;
							previousSignificantChar = word[word.length - 1] ?? "";
							continue;
						}
					}
				}
				nonLiteral?.add(optionName);
			} else if (args[cursor] === "," || args[cursor] === "}") {
				// Shorthand member: the value is a variable of the same name.
				nonLiteral?.add(optionName);
			}
		}
		previousSignificantChar = char;
	}
	return collected;
}

/** True when `name` starts at `index` and is not the prefix of a longer identifier. */
function startsWithOptionName(args: string, index: number, name: string): boolean {
	if (!args.startsWith(name, index)) return false;
	const next = args[index + name.length] ?? "";
	return !/[A-Za-z0-9_$]/.test(next);
}

/** One `new ProviderError|AuthError|ValidationError(...)` construction found by source scan. */
type ThrownErrorConstructionSite = {
	/** Constructor name, e.g. `ProviderError`. */
	readonly errorClass: string;
	readonly code?: string;
	readonly messageKey?: string;
	readonly fixKey?: string;
	/** Literal `category` option, when the site sets one. */
	readonly category?: string;
	/** Literal `retryable: true | false` option, when the site sets one. */
	readonly retryable?: boolean;
	/**
	 * The site sets `category` from something other than a string literal (a
	 * variable, a shorthand member, or a spread that names it), so it may carry
	 * any category.
	 */
	readonly nonLiteralCategory?: true;
};

const THROWN_ERROR_SCANNED_OPTION_NAMES = [
	"code",
	"messageKey",
	"fixKey",
	"category",
	"retryable",
] as const;

function collectThrownErrorConstructionSites(source: string): ThrownErrorConstructionSite[] {
	const sites: ThrownErrorConstructionSite[] = [];
	THROWN_ERROR_CONSTRUCTION_PATTERN.lastIndex = 0;
	for (
		let match = THROWN_ERROR_CONSTRUCTION_PATTERN.exec(source);
		match;
		match = THROWN_ERROR_CONSTRUCTION_PATTERN.exec(source)
	) {
		const argsStart = match.index + match[0].length;
		const args = extractBalancedCallArguments(source, argsStart);
		if (args !== undefined) {
			const nonLiteral = new Set<string>();
			const values = collectLiteralErrorOptionValues(
				args,
				THROWN_ERROR_SCANNED_OPTION_NAMES,
				nonLiteral,
			);
			sites.push({
				errorClass: match[1] ?? "",
				...(values.code === undefined ? {} : { code: values.code }),
				...(values.messageKey === undefined ? {} : { messageKey: values.messageKey }),
				...(values.fixKey === undefined ? {} : { fixKey: values.fixKey }),
				...(values.category === undefined ? {} : { category: values.category }),
				...(values.retryable === undefined ? {} : { retryable: values.retryable === "true" }),
				...(nonLiteral.has("category") ? { nonLiteralCategory: true as const } : {}),
			});
		}
		THROWN_ERROR_CONSTRUCTION_PATTERN.lastIndex = argsStart;
	}
	return sites;
}

type ThrowSiteLintSource = { readonly field: string; readonly source: string };

/**
 * The provider sources a throw-site rule scans, with the diagnostic field path
 * each one reports under. Prefers the CLI-collected source files (whole-repo
 * coverage) and falls back to the handler/auth-flow function text available
 * when `lintProvider` is called without them. Test sources are excluded.
 */
function collectThrowSiteLintSources(provider: {
	authFlowSource?: string;
	providerSourceFiles?: Record<string, string>;
	operations?: Record<string, { handler?: unknown; source?: string }>;
}): ThrowSiteLintSource[] {
	const sourceFiles = Object.entries(provider.providerSourceFiles ?? {}).filter(
		([filePath]) => !TEST_SOURCE_FILE_PATTERN.test(filePath),
	);
	if (sourceFiles.length > 0) {
		return sourceFiles.map(([filePath, source]) => ({
			field: `sourceFiles.${filePath}`,
			source,
		}));
	}
	const sources: ThrowSiteLintSource[] = [];
	if (provider.authFlowSource) {
		sources.push({ field: "auth.flow", source: provider.authFlowSource });
	}
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		const source = getOperationSource(operation);
		if (source) {
			sources.push({ field: `operations.${operationKey}.handler`, source });
		}
	}
	return sources;
}

/**
 * The one rule for the pre-`defineErrors` error path, kept until that path is
 * removed. Reports, with the migration, each throw site that still sets the
 * deprecated per-throw `category` / `retryable` options and each operation
 * that still declares its codes in the deprecated `errorCodes` table. A
 * provider on `defineErrors` + `errors: [...]` never trips it: the factory
 * sets no per-throw option and the table is gone. Warning level: the existing
 * fleet migrates on its own schedule, so this must not fail `apifuse check`.
 */
function lintLegacyErrorOptions(provider: {
	id?: string;
	authFlowSource?: string;
	providerSourceFiles?: Record<string, string>;
	operations?: Record<
		string,
		{
			handler?: unknown;
			source?: string;
			errorCodes?: ReadonlyArray<{ code: string }>;
		}
	>;
}): LintDiagnostic[] {
	const providerId = provider.id ?? "unknown";
	const diagnostics: LintDiagnostic[] = [];
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		const codes = (operation.errorCodes ?? []).flatMap((entry) =>
			typeof entry?.code === "string" ? [entry.code] : [],
		);
		if (codes.length === 0) continue;
		diagnostics.push({
			rule: "legacy-error-options",
			level: "warn",
			field: `operations.${operationKey}.errorCodes`,
			message: `Provider "${providerId}" operation "${operationKey}" declares ${codes.join(", ")} in the deprecated errorCodes table. Declare each code once with defineErrors({ ${codes[0]}: { status, category, description } }) (an SDK-registered code is sdkErrors.${codes[0]}) and list the factories as errors: [errors.${codes[0]}, ...]; status, retryable and the locale keys then come from that declaration.`,
		});
	}
	for (const { field, source } of collectThrowSiteLintSources(provider)) {
		const reported = new Set<string>();
		for (const site of collectThrownErrorConstructionSites(source)) {
			if (!UNDECLARED_CODE_ERROR_CLASSES.has(site.errorClass)) continue;
			const options = [
				...(site.category !== undefined || site.nonLiteralCategory ? ["category"] : []),
				...(site.retryable !== undefined ? ["retryable"] : []),
			];
			if (options.length === 0) continue;
			const code = site.code ?? "CODE";
			const key = `${code}:${options.join(",")}`;
			if (reported.has(key)) continue;
			reported.add(key);
			diagnostics.push({
				rule: "legacy-error-options",
				level: "warn",
				field,
				message: `${site.errorClass} with code "${code}" (${field}) sets ${options.join(" and ")} per throw; these options are deprecated (still served over the declaration for one release, then removed). Declare the code once with defineErrors({ ${code}: { status, category, description } }) and throw errors.${code}({ details, cause }).`,
			});
		}
	}
	return diagnostics;
}

/**
 * Handle contract (ADR-0012, amended 2026-10-28): the property key and the
 * issuing operation of a kind are read from the operation schemas by
 * `defineProvider`, `ctx.handle` is typed to the declared kinds, and
 * `handle: [...]` without `state` is a compile error. The only rule left is the
 * one for the deprecated declaration path, which the codemod removes.
 */
function lintLegacyHandleDeclarations(provider: {
	id?: string;
	handle?: unknown;
}): LintDiagnostic[] {
	if (!Array.isArray(provider.handle)) return [];
	const providerLabel = provider.id ? `Provider "${provider.id}"` : "Provider";
	const diagnostics: LintDiagnostic[] = [];
	for (const kind of provider.handle) {
		const declared = legacyHandleOptionsOf(kind);
		if (declared.length === 0) continue;
		const name =
			typeof kind === "object" && kind !== null && typeof Reflect.get(kind, "name") === "string"
				? (Reflect.get(kind, "name") as string)
				: "?";
		diagnostics.push({
			rule: "legacy-handle-declaration",
			level: "warn",
			field: `handle.${name}`,
			message: `${providerLabel} handle kind "${name}" still declares ${declared.join(" and ")}; the property key and the issuing operation are read from the operation schemas where ${name}.field() is placed. Delete the option(s): bunx ast-grep scan -r node_modules/@apifuse/provider-sdk/scripts/codemods/handles.yml --update-all .`,
		});
	}
	return diagnostics;
}

const LEGACY_CHOICE_USAGE_PATTERN =
	/\bctx\.choice\b|\b(?:createProviderChoiceToken|parseProviderChoiceToken|ProviderChoiceTokenError|createTestProviderChoiceContext)\b/;

const LEGACY_CHOICE_USAGE_MESSAGE =
	"Choice tokens were replaced by handles (ADR-0012). See docs/migrations/handle.md.";

/**
 * The inline choice-token API was removed outright (no aliases). Any surviving
 * reference in provider source would fail at runtime, so report it at check time.
 */
const LEGACY_CHOICE_IDENTIFIERS = new Set([
	"createProviderChoiceToken",
	"parseProviderChoiceToken",
	"ProviderChoiceTokenError",
	"createTestProviderChoiceContext",
]);

/**
 * Finds the first legacy choice API reference in executable code. Uses the
 * TypeScript AST when available so comments, string and template literal text
 * never count (a migration note such as `// moved from ctx.choice` must not fail
 * the provider) while code inside `${}` interpolations still does. Falls back
 * to a raw-source regex when TypeScript is not installed.
 */
function findLegacyChoiceUsage(fileName: string, source: string): string | undefined {
	let ts: typeof import("typescript");
	try {
		ts = getTypeScript();
	} catch {
		return LEGACY_CHOICE_USAGE_PATTERN.exec(source)?.[0];
	}
	const file = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		false,
		scriptKindForSourceFile(ts, fileName),
	);
	let found: string | undefined;
	const visit = (node: import("typescript").Node): void => {
		if (found) return;
		if (ts.isIdentifier(node) && LEGACY_CHOICE_IDENTIFIERS.has(node.text)) {
			found = node.text;
			return;
		}
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "ctx" &&
			node.name.text === "choice"
		) {
			found = "ctx.choice";
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

function lintLegacyChoiceUsage(provider: ProviderSourceLike): LintDiagnostic[] {
	const sources: Array<{ field: string; fileName: string; source: string }> = [];

	if (provider.authFlowSource) {
		sources.push({ field: "auth.flow", fileName: "auth-flow.ts", source: provider.authFlowSource });
	}
	for (const [filePath, source] of Object.entries(provider.providerSourceFiles ?? {})) {
		sources.push({ field: `sourceFiles.${filePath}`, fileName: filePath, source });
	}
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		const source = getOperationSource(operation);
		if (source) {
			sources.push({
				field: `operations.${operationKey}.handler`,
				fileName: `${operationKey}.ts`,
				source,
			});
		}
	}

	return sources.flatMap(({ field, fileName, source }) => {
		const match = findLegacyChoiceUsage(fileName, source);
		if (!match) return [];
		return [
			{
				rule: "legacy-choice-usage",
				level: "error" as const,
				field,
				message: `Legacy choice API "${match}" is no longer supported. ${LEGACY_CHOICE_USAGE_MESSAGE}`,
			},
		];
	});
}

// ---------------------------------------------------------------------------
// meta-requires-as-const
// ---------------------------------------------------------------------------

const META_AS_CONST_RULE = "meta-requires-as-const";

/**
 * Why this is checked from source and not from the loaded provider.
 *
 * `defineProvider` is declared `<const TConfig extends ProviderDeclaration>`, so
 * an object literal written AT the call keeps its literal types. A `const` type
 * parameter cannot re-narrow a value that widened somewhere else: when the
 * declaration — or its `meta` block — lives in its own module and is passed by
 * name, the call sees that module's declared type. `as const` has no runtime
 * trace at all (the loaded object is byte-identical with and without it), so
 * only the syntax carries the narrowing, which is why this rule reads
 * `providerSourceFiles` rather than the provider value.
 *
 * What is actually at stake, measured against this SDK rather than reasoned
 * about (probe: declare `http` only, then read `ctx.files`):
 *
 * | how the extracted `meta` is declared        | at the call | ProviderContextOf |
 * |---------------------------------------------|-------------|-------------------|
 * | `meta` written inline in `defineProvider({...})` | ok       | narrowed          |
 * | `meta = { ... } as const`                    | ok          | narrowed          |
 * | `meta = { ... } satisfies ProviderMeta`      | ok          | narrowed          |
 * | `meta: ProviderMeta = { ... }`               | ok          | narrowed          |
 * | `meta = { ... }`, no literal-typed field     | ok          | narrowed          |
 * | `meta = { ... }` with a literal-typed field  | **TS2322**  | **degenerate**    |
 * | `decl: ProviderDeclaration = { ... }`        | **ok**      | **degenerate**    |
 * | `decl: Pick<ProviderDeclaration, …>`         | ok          | narrowed          |
 * | `decl: ProviderDeclaration & { … }`          | **ok**      | **degenerate**    |
 * | `defineProvider<ProviderDeclaration>({…})`   | **ok**      | **degenerate**    |
 *
 * The last two rows are the rule, and they fail differently.
 *
 * LOUD (`warn`). A widened `meta` is one property of the call literal, so it
 * cannot change `keyof TConfig` by itself — rows 5 and 6 differ only in whether
 * some widened value is still assignable. Once one is not
 * (`contract.publicSchemaFieldNames` going from `"normalized"` to `string` is
 * the one the fleet hits), inference for `TConfig` falls back to the constraint
 * and the context degenerates — but `tsc` also rejects the call with TS2322, so
 * nothing ships. It warns because row 5 is one added field away from row 6.
 *
 * SILENT (`error`). Annotating the WHOLE declaration
 * (`const decl: ProviderDeclaration = { ... }; defineProvider(decl)`) is
 * different in kind. It is perfectly assignable, so the call compiles; but
 * every capability is an OPTIONAL key of `ProviderDeclaration`, so
 * `keyof TConfig` is all of them at once. Every branch of `ProviderContext` is
 * keyed on `"<capability>" extends keyof TConfig`, so the context hands
 * `ctx.files`, `ctx.browser`, `ctx.state` and the rest to a provider that
 * declared none of them, and no diagnostic anywhere points at it. `satisfies
 * ProviderDeclaration` checks the same shape and keeps the key set.
 *
 * The rule is scoped to what is mechanically decidable from the provider's own
 * sources. A `meta` written inline at the call is fine (the `const` type
 * parameter does the work). A value passed by name is checked at its
 * declaration, following at most {@link MODULE_HOP_LIMIT} re-export hops. An
 * indexed access such as `ProviderDeclaration["meta"]` names one member and is
 * not a key-erasing annotation. A value that cannot be resolved inside the
 * provider tree (a bare-specifier import, a computed expression, a function
 * call) is left alone rather than guessed at.
 */
const MODULE_HOP_LIMIT = 4;

/**
 * Narrowing verdict for one `const` declaration.
 *
 * `silent` separates the two failure modes measured in the table above. A
 * declaration typed as `ProviderDeclaration` keeps every optional capability
 * key, so `keyof TConfig` is the whole union, the context degenerates, and
 * `tsc` says NOTHING — that is an error. A bare object literal degenerates only
 * once one of its widened values stops being assignable, and when it does the
 * call fails to compile — that is a warning.
 */
type NarrowingVerdict =
	| { kind: "narrowed" }
	| { kind: "widened"; reason: string; silent: boolean }
	| { kind: "unresolved" };

/**
 * True for a type node that erases the authored key set to
 * `keyof ProviderDeclaration` — the declaration type itself, or a mapped type
 * over it (`Partial<ProviderDeclaration>`, `Omit<ProviderDeclaration, "auth">`).
 *
 * An indexed access into it (`ProviderDeclaration["meta"]`) is NOT this: it
 * names one member's type and leaves the declaration's own key set alone, which
 * is why `satisfies ProviderDeclaration["meta"]` is a safe and used convention.
 */
function erasesDeclarationKeys(
	ts: typeof import("typescript"),
	node: import("typescript").TypeNode,
	declarationTypeNames: ReadonlySet<string>,
): boolean {
	if (ts.isParenthesizedTypeNode(node)) {
		return erasesDeclarationKeys(ts, node.type, declarationTypeNames);
	}
	// `ProviderDeclaration & { http: true }` still carries every optional
	// capability key, so an intersection is erasing when any constituent is.
	if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
		return node.types.some((member) => erasesDeclarationKeys(ts, member, declarationTypeNames));
	}
	if (ts.isIndexedAccessTypeNode(node)) return false;
	if (ts.isTypeReferenceNode(node)) {
		const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
		if (declarationTypeNames.has(name)) return true;
		// `Pick<ProviderDeclaration, "id" | "http">` names an explicit key subset,
		// so the authored keys survive and the context stays narrow — measured.
		// Every other transformation over the declaration (`Omit` keeps all the
		// keys but one, `Partial`/`Readonly`/`Required` keep them all) leaves the
		// optional capability keys in place and is erasing.
		if (name === "Pick") return false;
		return (node.typeArguments ?? []).some((argument) =>
			erasesDeclarationKeys(ts, argument, declarationTypeNames),
		);
	}
	return false;
}

/** True for an `@apifuse/provider-sdk` (or subpath) module specifier. */
function isSdkSpecifier(specifier: string): boolean {
	return specifier === "@apifuse/provider-sdk" || specifier.startsWith("@apifuse/provider-sdk/");
}

/**
 * Local names that denote `ProviderDeclaration` inside one file.
 *
 * The type is usually imported under its own name, but `import type
 * { ProviderDeclaration as Decl }` and `type Decl = ProviderDeclaration` are
 * the same type wearing another word, and annotating with either erases the
 * key set just as thoroughly. Comparing the written name alone would miss both.
 */
function declarationTypeNamesIn(
	ts: typeof import("typescript"),
	file: import("typescript").SourceFile,
): Set<string> {
	const names = new Set<string>(["ProviderDeclaration"]);
	for (const statement of file.statements) {
		if (ts.isImportDeclaration(statement)) {
			const bindings = statement.importClause?.namedBindings;
			if (!bindings || !ts.isNamedImports(bindings)) continue;
			if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
			if (!isSdkSpecifier(statement.moduleSpecifier.text)) continue;
			for (const element of bindings.elements) {
				if ((element.propertyName?.text ?? element.name.text) === "ProviderDeclaration") {
					names.add(element.name.text);
				}
			}
			continue;
		}
		if (
			ts.isTypeAliasDeclaration(statement) &&
			ts.isTypeReferenceNode(statement.type) &&
			ts.isIdentifier(statement.type.typeName) &&
			names.has(statement.type.typeName.text)
		) {
			names.add(statement.name.text);
		}
	}
	return names;
}

/**
 * Local names bound to the SDK's `defineProvider` inside one file.
 *
 * Restricting the callee match to these keeps an unrelated local helper called
 * `defineProvider` out of the rule, and picks the SDK call up when it is
 * imported under another name. A file with no SDK import at all falls back to
 * the bare name, which is what an in-repo fixture looks like.
 */
function defineProviderNamesIn(
	ts: typeof import("typescript"),
	file: import("typescript").SourceFile,
): Set<string> {
	const names = new Set<string>();
	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
		if (!isSdkSpecifier(statement.moduleSpecifier.text)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings) continue;
		if (ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				if ((element.propertyName?.text ?? element.name.text) === "defineProvider") {
					names.add(element.name.text);
				}
			}
		}
		// `import * as sdk from "@apifuse/provider-sdk"` reaches the call as
		// `sdk.defineProvider`, and calleeName() already reduces that to the
		// member name.
		if (ts.isNamespaceImport(bindings)) names.add("defineProvider");
	}
	if (names.size > 0) return names;
	// No SDK import in this file. The bare name is the right fallback for an
	// in-repo fixture, but not when the file declares or imports a
	// `defineProvider` of its own — passing a ProviderDeclaration to an
	// unrelated local helper is not an SDK call and must not fail a check.
	for (const statement of file.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name?.text === "defineProvider") {
			return names;
		}
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name) && declaration.name.text === "defineProvider") {
					return names;
				}
			}
		}
		if (ts.isImportDeclaration(statement)) {
			const bindings = statement.importClause?.namedBindings;
			if (bindings && ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) {
					if (element.name.text === "defineProvider") return names;
				}
			}
		}
	}
	return new Set(["defineProvider"]);
}

function normalizeSourcePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Resolves `./meta` (or `./meta.js`) from `index.ts` against the source map. */
function resolveProviderModule(
	fromFile: string,
	specifier: string,
	files: Record<string, string>,
): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const fromSegments = normalizeSourcePath(fromFile).split("/");
	fromSegments.pop();
	for (const segment of specifier.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") fromSegments.pop();
		else fromSegments.push(segment);
	}
	const joined = fromSegments.join("/");
	// An ESM provider writes `./meta.js` and ships `meta.mts`; the extension in
	// the specifier is the EMITTED one, so every TypeScript counterpart of the
	// scan set has to be tried, not just `.ts`.
	const withoutJs = joined.replace(/\.(js|mjs|cjs)$/, "");
	const candidates = [
		joined,
		...["ts", "tsx", "mts", "cts"].flatMap((extension) => [
			`${withoutJs}.${extension}`,
			`${withoutJs}/index.${extension}`,
		]),
	];
	const normalized = new Map(Object.keys(files).map((key) => [normalizeSourcePath(key), key]));
	for (const candidate of candidates) {
		const match = normalized.get(candidate);
		if (match !== undefined) return match;
	}
	return undefined;
}

/** True for `<expr> as const`. */
function isConstAssertion(
	ts: typeof import("typescript"),
	node: import("typescript").Node,
): node is import("typescript").AsExpression {
	return (
		ts.isAsExpression(node) &&
		ts.isTypeReferenceNode(node.type) &&
		ts.isIdentifier(node.type.typeName) &&
		node.type.typeName.text === "const"
	);
}

/**
 * Decides whether `name`, as declared in `fileName`, still carries its literal
 * types when it is read from another module. Follows `import`/`export ... from`
 * re-exports up to {@link MODULE_HOP_LIMIT} hops.
 */
function narrowingOfExportedConst(
	ts: typeof import("typescript"),
	files: Record<string, string>,
	fileName: string,
	name: string,
	hops = 0,
): NarrowingVerdict {
	if (hops > MODULE_HOP_LIMIT) return { kind: "unresolved" };
	const source = files[fileName];
	if (source === undefined) return { kind: "unresolved" };
	const file = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForSourceFile(ts, fileName),
	);
	const declarationTypeNames = declarationTypeNamesIn(ts, file);

	for (const statement of file.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
				// An annotation (`: ProviderMeta`) and a `satisfies` check both give
				// the literal a contextual type whose literal-typed members stay
				// literal. Measured: neither degenerates ProviderContextOf — UNLESS
				// the type named is the declaration itself, which replaces the
				// authored key set with every optional capability key.
				if (declaration.type) {
					if (erasesDeclarationKeys(ts, declaration.type, declarationTypeNames)) {
						return {
							kind: "widened",
							silent: true,
							reason: `it is annotated \`: ${declaration.type.getText(file)}\`, and every capability is an OPTIONAL key of ProviderDeclaration, so \`keyof TConfig\` becomes all of them`,
						};
					}
					return { kind: "narrowed" };
				}
				let initializer = declaration.initializer;
				while (initializer && ts.isParenthesizedExpression(initializer)) {
					initializer = initializer.expression;
				}
				if (!initializer) return { kind: "unresolved" };
				if (ts.isSatisfiesExpression(initializer)) return { kind: "narrowed" };
				if (isConstAssertion(ts, initializer)) return { kind: "narrowed" };
				if (ts.isAsExpression(initializer)) {
					if (erasesDeclarationKeys(ts, initializer.type, declarationTypeNames)) {
						return {
							kind: "widened",
							silent: true,
							reason: `it is asserted \`as ${initializer.type.getText(file)}\`, and every capability is an OPTIONAL key of ProviderDeclaration, so \`keyof TConfig\` becomes all of them`,
						};
					}
					return { kind: "narrowed" };
				}
				if (ts.isObjectLiteralExpression(initializer)) {
					return {
						kind: "widened",
						silent: false,
						reason:
							"it is a bare object literal — no `as const`, no annotation, no `satisfies` — so TypeScript widens every literal in it before `defineProvider` ever sees it",
					};
				}
				return { kind: "unresolved" };
			}
		}

		// `export { providerMeta } from "./meta";` and
		// `import { providerMeta } from "./meta"; export { providerMeta };`
		if (ts.isExportDeclaration(statement) && statement.exportClause) {
			if (!ts.isNamedExports(statement.exportClause)) continue;
			for (const element of statement.exportClause.elements) {
				if (element.name.text !== name) continue;
				const origin = element.propertyName?.text ?? name;
				const specifier =
					statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
						? statement.moduleSpecifier.text
						: undefined;
				if (specifier === undefined) {
					return narrowingOfImportedName(ts, files, file, fileName, origin, hops + 1);
				}
				const target = resolveProviderModule(fileName, specifier, files);
				if (target === undefined) return { kind: "unresolved" };
				return narrowingOfExportedConst(ts, files, target, origin, hops + 1);
			}
		}
	}

	return narrowingOfImportedName(ts, files, file, fileName, name, hops + 1);
}

/** Follows `import { name } from "./x"` declared in `file` to its definition. */
function narrowingOfImportedName(
	ts: typeof import("typescript"),
	files: Record<string, string>,
	file: import("typescript").SourceFile,
	fileName: string,
	name: string,
	hops: number,
): NarrowingVerdict {
	if (hops > MODULE_HOP_LIMIT) return { kind: "unresolved" };
	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const element of bindings.elements) {
			if (element.name.text !== name) continue;
			if (!ts.isStringLiteral(statement.moduleSpecifier)) return { kind: "unresolved" };
			const target = resolveProviderModule(fileName, statement.moduleSpecifier.text, files);
			if (target === undefined) return { kind: "unresolved" };
			return narrowingOfExportedConst(ts, files, target, element.propertyName?.text ?? name, hops);
		}
	}
	return { kind: "unresolved" };
}

type MetaNarrowingFinding = {
	/** `meta` when the meta block alone is widened, `declaration` for the whole call argument. */
	subject: "meta" | "declaration";
	name: string;
	reason: string;
	/** True when the degeneration compiles cleanly; see {@link NarrowingVerdict}. */
	silent: boolean;
};

/**
 * Finds every `defineProvider(...)` in one file and reports the arguments that
 * reach it already widened.
 */
function findWidenedDefineProviderArguments(
	ts: typeof import("typescript"),
	files: Record<string, string>,
	fileName: string,
): MetaNarrowingFinding[] {
	const source = files[fileName];
	if (source === undefined) return [];
	const file = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForSourceFile(ts, fileName),
	);
	const findings: MetaNarrowingFinding[] = [];
	const declarationTypeNames = declarationTypeNamesIn(ts, file);
	const calleeNames = defineProviderNamesIn(ts, file);

	const check = (subject: "meta" | "declaration", expression: import("typescript").Expression) => {
		let current = expression;
		while (ts.isParenthesizedExpression(current)) current = current.expression;
		// `satisfies` and `as const` narrow a literal written HERE; neither can
		// re-narrow a binding that widened at its own declaration, and neither
		// re-narrows a value spread in from one. Unwrap and keep looking rather
		// than treating the wrapper as proof.
		while (ts.isSatisfiesExpression(current) || isConstAssertion(ts, current)) {
			current = current.expression;
			while (ts.isParenthesizedExpression(current)) current = current.expression;
		}
		// `defineProvider({...} as ProviderDeclaration)` and
		// `defineProvider(declaration as ProviderDeclaration)` erase the key set
		// at the call itself, without any widened binding to resolve to.
		if (ts.isAsExpression(current)) {
			if (erasesDeclarationKeys(ts, current.type, declarationTypeNames)) {
				findings.push({
					subject,
					name: current.expression.getText(file).slice(0, 60),
					reason: `it is asserted \`as ${current.type.getText(file)}\` at the call, and every capability is an OPTIONAL key of ProviderDeclaration, so \`keyof TConfig\` becomes all of them`,
					silent: subject === "declaration",
				});
				return;
			}
			current = current.expression;
			while (ts.isParenthesizedExpression(current)) current = current.expression;
		}
		if (ts.isObjectLiteralExpression(current)) {
			// Written at the call: the `const` type parameter narrows it. Only a
			// spread of an already-widened binding can still lose the literals.
			for (const property of current.properties) {
				if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
					check(subject, property.expression);
				}
			}
			return;
		}
		if (!ts.isIdentifier(current)) return;
		const verdict = narrowingOfImportedName(ts, files, file, fileName, current.text, 1);
		const resolved =
			verdict.kind === "unresolved"
				? narrowingOfExportedConst(ts, files, fileName, current.text, 1)
				: verdict;
		if (resolved.kind === "widened") {
			// A widened `meta` is only ever the loud row: it is one property of the
			// call literal, so it cannot change `keyof TConfig` by itself.
			const silent = resolved.silent && subject === "declaration";
			findings.push({ subject, name: current.text, reason: resolved.reason, silent });
		}
	};

	const visit = (node: import("typescript").Node): void => {
		const callee = ts.isCallExpression(node) ? calleeName(node) : undefined;
		if (ts.isCallExpression(node) && callee !== undefined && calleeNames.has(callee)) {
			// `defineProvider<ProviderDeclaration>({...})` pins TConfig explicitly,
			// so the `const` type parameter never infers anything and even an inline
			// literal gets the full optional-key set. The value argument looks
			// perfect; the type argument is the whole defect.
			const pinned = (node.typeArguments ?? []).find((argument) =>
				erasesDeclarationKeys(ts, argument, declarationTypeNames),
			);
			if (pinned) {
				findings.push({
					subject: "declaration",
					name: `${callee}<${pinned.getText(file)}>`,
					reason: `the call pins its type parameter with \`<${pinned.getText(file)}>\`, so the \`const TConfig\` inference never runs and every capability is an OPTIONAL key of ProviderDeclaration`,
					silent: true,
				});
				ts.forEachChild(node, visit);
				return;
			}
			const argument = node.arguments[0];
			if (argument) {
				let current: import("typescript").Expression = argument;
				while (ts.isParenthesizedExpression(current)) current = current.expression;
				if (ts.isAsExpression(current)) {
					// `defineProvider(x as T)`: check() decides whether T erases the
					// key set, and unwraps to x when it does not.
					check("declaration", current);
					ts.forEachChild(node, visit);
					return;
				}
				if (ts.isObjectLiteralExpression(current)) {
					for (const property of current.properties) {
						if (ts.isPropertyAssignment(property) && staticPropertyName(property.name) === "meta") {
							check("meta", property.initializer);
						} else if (
							ts.isShorthandPropertyAssignment(property) &&
							property.name.text === "meta"
						) {
							check("meta", property.name);
						} else if (ts.isSpreadAssignment(property)) {
							check("declaration", property.expression);
						}
					}
				} else {
					check("declaration", argument);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return findings;
}

/**
 * `meta-requires-as-const`: the provider declaration, and its `meta` block in
 * particular, should reach `defineProvider` with its literal types intact.
 *
 * See the table above {@link MODULE_HOP_LIMIT} for the measured consequences
 * and for why this warns rather than errors.
 */
function lintProviderMetaNarrowing(provider: ProviderSourceLike): LintDiagnostic[] {
	const files = provider.providerSourceFiles ?? {};
	if (Object.keys(files).length === 0) return [];
	let ts: typeof import("typescript");
	try {
		ts = getTypeScript();
	} catch {
		// No TypeScript in the consumer's tree: the other AST rules degrade the
		// same way rather than guessing from raw text.
		return [];
	}

	const diagnostics: LintDiagnostic[] = [];
	for (const fileName of Object.keys(files)) {
		const normalized = normalizeSourcePath(fileName);
		if (!/\.(ts|tsx|mts|cts)$/.test(normalized) || /\.d\.(ts|mts|cts)$/.test(normalized)) continue;
		// Test sources routinely build throwaway declarations to exercise a
		// capability shape, and several do it with a `ProviderDeclaration`
		// annotation on purpose. Reporting those would fail `apifuse check` over
		// code that is not the provider's runtime contract.
		if (SHARED_TEST_SOURCE_FILE_PATTERN.test(normalized)) continue;
		for (const finding of findWidenedDefineProviderArguments(ts, files, fileName)) {
			const what =
				finding.subject === "meta"
					? `The \`meta\` block passed to defineProvider (\`${finding.name}\`)`
					: `The declaration passed to defineProvider (\`${finding.name}\`)`;
			const consequence = finding.silent
				? "ProviderContextOf<typeof buildProvider> is therefore ProviderContext<ProviderDeclaration>: ctx.files, ctx.browser, ctx.state and every other capability type-check in a provider that declared none of them, and nothing anywhere reports it — the call itself still compiles. Replace the annotation with `satisfies ProviderDeclaration`, which checks the same shape and leaves the authored key set intact."
				: 'That is latent rather than broken today: a widened property of `meta` cannot change `keyof TConfig` on its own. It turns into a failure the moment one widened value stops being assignable to ProviderDeclaration — `contract.publicSchemaFieldNames` going from "normalized" to `string` is the one the fleet hits — and then the call fails with TS2322 and the context degenerates at the same time. Add `as const` to the declaration; `satisfies ProviderMeta`, an explicit annotation, or an `as const` on each literal-union field are equally sound.';
			diagnostics.push({
				rule: META_AS_CONST_RULE,
				level: finding.silent ? "error" : "warn",
				field: finding.subject,
				message: `${what} reaches the call already widened: ${finding.reason}. ${consequence}`,
			});
		}
	}
	return diagnostics;
}

const STALE_IF_ERROR_OPTION = "staleIfErrorMs";
const STALE_IF_ERROR_PATTERN = /\bstaleIfErrorMs\b/;

/**
 * Whether a property assignment's initializer leaves no stale window.
 * `staleIfErrorMs: 0` makes `staleUntil` equal `freshUntil` in
 * `runtime/cache.ts`, so a loader failure propagates instead of being answered
 * from cache — a provider deliberately turning stale serving OFF must not be
 * told its probes conceal outages.
 */
function disablesStaleWindow(
	ts: typeof import("typescript"),
	initializer: import("typescript").Expression,
): boolean {
	if (ts.isNumericLiteral(initializer)) return Number(initializer.text) === 0;
	return ts.isIdentifier(initializer) && initializer.text === "undefined";
}

/**
 * Whether executable source configures a stale-if-error window.
 *
 * Parsed, not matched: comments and unrelated string literals must not count,
 * and a regex cannot tell them apart (an `Accept: "*​/*"` header literal opens a
 * block comment to a stripping regex and swallows the cache call after it).
 * This is the approach `findLegacyChoiceUsage` already uses here. All three
 * spellings of the option count — `staleIfErrorMs: n`, the shorthand
 * `{ ttlMs, staleIfErrorMs }`, and the quoted `"staleIfErrorMs": n` — because
 * refactoring between them must not change the verdict. Falls back to the raw
 * identifier match when TypeScript is not installed, which is the fail-closed
 * direction for this rule: it warns rather than goes quiet.
 */
function servesStaleIfError(source: string, fileName = "provider.ts"): boolean {
	if (!source.includes(STALE_IF_ERROR_OPTION)) return false;
	let ts: typeof import("typescript");
	try {
		ts = getTypeScript();
	} catch {
		return STALE_IF_ERROR_PATTERN.test(source);
	}
	const file = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		false,
		scriptKindForSourceFile(ts, fileName),
	);
	/** The statically known name of a property, however it is written. */
	const propertyName = (name: import("typescript").PropertyName): string | undefined => {
		if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
		if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
			return name.expression.text;
		}
		return undefined;
	};
	/**
	 * A type declaring the option is not a cache call setting it. Skipping these
	 * whole subtrees also stops a `CachePolicy` interface from overriding the
	 * disabled-window exemption for a provider whose only real call passes 0.
	 */
	const isTypeOnly = (node: import("typescript").Node): boolean =>
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isTypeLiteralNode(node) ||
		ts.isPropertySignature(node) ||
		ts.isTypeReferenceNode(node) ||
		ts.isTypeParameterDeclaration(node);
	/**
	 * The cache write options that travel with `staleIfErrorMs`
	 * (`ProviderCacheWriteOptions`). An object literal carrying one of these
	 * alongside the option is a cache configuration wherever it is declared.
	 */
	const siblingCacheOptions = new Set(["ttlMs", "jitterPct"]);
	/**
	 * A callee that writes the provider cache: `ctx.cache.getOrSet(...)`,
	 * `ctx.cache.set(...)`, and the `cached*` helpers built on them. An unrelated
	 * call receiving an object that happens to carry the name is not cache
	 * configuration. Every one of these takes its options LAST.
	 */
	const isCacheCallee = (expression: import("typescript").Expression): boolean => {
		if (ts.isIdentifier(expression)) return /^cached[A-Z]/.test(expression.text);
		if (!ts.isPropertyAccessExpression(expression)) return false;
		if (expression.name.text === "getOrSet") return true;
		return (
			(expression.name.text === "set" || expression.name.text === "write") &&
			ts.isPropertyAccessExpression(expression.expression) &&
			expression.expression.name.text === "cache"
		);
	};
	/**
	 * `const POLICY = { ... }` object literals, so `{ ...POLICY }` can be judged.
	 * Keyed by name file-wide: a shadowed name may resolve to the wrong literal,
	 * which at warning level is a mis-nudge rather than a wrong build — but the
	 * expansion below still has to be cycle-safe, because shadowing can make the
	 * resolution circular in valid source.
	 */
	const literalsByName = new Map<string, import("typescript").ObjectLiteralExpression>();
	const collect = (node: import("typescript").Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined &&
			ts.isObjectLiteralExpression(node.initializer)
		) {
			literalsByName.set(node.name.text, node.initializer);
		}
		ts.forEachChild(node, collect);
	};
	collect(file);

	type OptionReading = { window: "enabled" | "disabled" | undefined; hasSibling: boolean };

	/**
	 * The EFFECTIVE stale-window setting of an object literal, spreads expanded
	 * and later properties overriding earlier ones the way JavaScript does — so
	 * `{ ...policy, staleIfErrorMs: 0 }` reads as disabled even when `policy`
	 * enables it.
	 */
	const readOptions = (
		literal: import("typescript").ObjectLiteralExpression,
		seen: Set<import("typescript").ObjectLiteralExpression>,
	): OptionReading => {
		if (seen.has(literal)) return { window: undefined, hasSibling: false };
		seen.add(literal);
		let window: OptionReading["window"];
		let hasSibling = false;
		for (const property of literal.properties) {
			if (ts.isSpreadAssignment(property)) {
				const target = ts.isIdentifier(property.expression)
					? literalsByName.get(property.expression.text)
					: ts.isObjectLiteralExpression(property.expression)
						? property.expression
						: undefined;
				if (target === undefined) continue;
				const inner = readOptions(target, seen);
				if (inner.window !== undefined) window = inner.window;
				hasSibling ||= inner.hasSibling;
				continue;
			}
			if (ts.isShorthandPropertyAssignment(property)) {
				if (property.name.text === STALE_IF_ERROR_OPTION) window = "enabled";
				else if (siblingCacheOptions.has(property.name.text)) hasSibling = true;
				continue;
			}
			if (!ts.isPropertyAssignment(property)) continue;
			const name = propertyName(property.name);
			if (name === STALE_IF_ERROR_OPTION) {
				window = disablesStaleWindow(ts, property.initializer) ? "disabled" : "enabled";
			} else if (name !== undefined && siblingCacheOptions.has(name)) {
				hasSibling = true;
			}
		}
		seen.delete(literal);
		return { window, hasSibling };
	};

	let found = false;
	/**
	 * `inOptionsArgument` is the second way to recognise a cache configuration:
	 * the literal is the options argument of a cache call. Together with the
	 * sibling-option test this covers the real shapes, while an upstream payload
	 * that merely carries a field of the same name does not count.
	 */
	const visit = (node: import("typescript").Node, inOptionsArgument: boolean): void => {
		if (found || isTypeOnly(node)) return;
		if (ts.isObjectLiteralExpression(node)) {
			const { window, hasSibling } = readOptions(node, new Set());
			if (window === "enabled" && (hasSibling || inOptionsArgument)) {
				found = true;
				return;
			}
		}
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			const argumentList = node.arguments ?? [];
			// Options come last on every cache API; the earlier arguments are the
			// key, the loader, or the value being cached.
			const optionsIndex = isCacheCallee(node.expression) ? argumentList.length - 1 : -1;
			visit(node.expression, false);
			for (const [index, argument] of [...argumentList].entries()) {
				visit(argument, index === optionsIndex);
			}
			return;
		}
		ts.forEachChild(node, (child) => visit(child, false));
	};
	visit(file, false);
	return found;
}

/** The operation-step field that distinguishes a stale-if-error serve. */
const SERVED_STALE_CACHE_OPERAND = "served_stale_cache";

/**
 * Sources that describe behaviour rather than serve it. Mirrors the broadest
 * test-source predicate in this module (`SHARED_TEST_SOURCE_FILE_PATTERN`, which
 * covers a plain `tests/` directory and `__mocks__/` as well as `__tests__/`)
 * and adds recorded-fixture directories, so a mock that mentions
 * `staleIfErrorMs` cannot raise a warning about code the runtime never serves.
 */
const NON_SERVING_SOURCE_FILE_PATTERN =
	/(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Operator tooling and bootstrap entrypoints: a cache option used by a fixture recorder or a
 * start script is not the request path a probe reads through.
 */
const NON_SERVING_TOOLING_DIRECTORY_PATTERN = /^(?:scripts|tools|bin)\//;
const NON_SERVING_BOOTSTRAP_FILE_PATTERN = /^(?:dev|start|deploy)\.[cm]?[jt]sx?$/;

function isServingProviderSourcePath(relativePath: string): boolean {
	return (
		JAVASCRIPT_SOURCE_FILE_PATTERN.test(relativePath) &&
		!NON_SERVING_SOURCE_FILE_PATTERN.test(relativePath) &&
		!NON_SERVING_TOOLING_DIRECTORY_PATTERN.test(relativePath) &&
		!NON_SERVING_BOOTSTRAP_FILE_PATTERN.test(relativePath)
	);
}

function isLintRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads `healthCheck.cases` structurally. The lint input is the loaded provider
 * declaration, which `defineProvider` has already validated, but this rule must
 * not throw on a shape it did not expect.
 */
function readHealthCheckCases(healthCheck: unknown): Record<string, unknown>[] {
	if (!isLintRecord(healthCheck)) return [];
	const cases = healthCheck.cases;
	if (!Array.isArray(cases)) return [];
	return cases.filter(isLintRecord);
}

/**
 * The `result` bindings of the `operation` steps that invoke `operationId`.
 *
 * Scoped to the probe's own operation on purpose: a scenario may invoke a
 * preparatory read before the operation the case is about, and a guard on the
 * preparation's result says nothing about whether the checked operation was
 * answered from a stale cache.
 */
function operationStepBindings(steps: readonly unknown[], operationId: string): Set<string> {
	const bindings = new Set<string>();
	for (const step of steps) {
		if (
			isLintRecord(step) &&
			step.kind === "operation" &&
			step.operationId === operationId &&
			typeof step.result === "string"
		) {
			bindings.add(step.result);
		}
	}
	return bindings;
}

/**
 * Whether an operand is the operand: the runtime's `served_stale_cache`
 * projection on an operation step result for the probe's own operation.
 *
 * Exact on three counts, because each looser form is a way to silence the rule
 * without checking cache provenance: a literal `"served_stale_cache"` in an
 * `inputTemplate` or a `reasonKey` is not a reference at all;
 * `["data", "served_stale_cache"]` is an upstream payload field the provider
 * happens to have named that way; and a reference bound to an `extract` result
 * is not the operation step this probe invoked.
 */
function isStaleCacheOperand(operand: unknown, bindings: ReadonlySet<string>): boolean {
	if (!isLintRecord(operand)) return false;
	const reference = operand.ref;
	return (
		isLintRecord(reference) &&
		reference.namespace === "steps" &&
		typeof reference.binding === "string" &&
		bindings.has(reference.binding) &&
		Array.isArray(reference.path) &&
		reference.path.length === 1 &&
		reference.path[0] === SERVED_STALE_CACHE_OPERAND
	);
}

/**
 * Whether a single predicate over the operand is FALSE for a stale serve, under
 * `negated` negation depth. `served_stale_cache` is always present and always a
 * boolean, so `exists` and `type_is: "boolean"` pass for a stale serve too —
 * reading the operand is not the same as rejecting it.
 */
function predicateRejectsStaleServe(
	predicate: Record<string, unknown>,
	bindings: ReadonlySet<string>,
	negated: boolean,
): boolean {
	// `equals`/`not_equals` are symmetric and the schema allows a reference on
	// either side, so `equals(actual: false, expected: <ref>)` is the same check
	// written the other way round.
	const onActual = isStaleCacheOperand(predicate.actual, bindings);
	const onExpected = isStaleCacheOperand(predicate.expected, bindings);
	if (!onActual && !onExpected) return false;
	const { operator } = predicate;
	const literal = onActual ? predicate.expected : predicate.actual;
	const failsWhenStale =
		(operator === "not_equals" && literal === true) || (operator === "equals" && literal === false);
	const holdsWhenStale =
		(operator === "is_true" && onActual) ||
		(operator === "equals" && literal === true) ||
		(operator === "not_equals" && literal === false);
	return negated ? holdsWhenStale : failsWhenStale;
}

/**
 * Whether an assertion expression evaluates FALSE when the operation step was
 * answered from a stale cache — the only thing that makes a guard degrade or an
 * assert fail. A clause under `any` only counts if every sibling branch also
 * rejects the stale serve, because `any` is satisfied by the branch that still
 * passes (`status_2xx` on a stale 200 being the obvious one).
 */
function rejectsStaleServe(node: unknown, bindings: ReadonlySet<string>, negated = false): boolean {
	if (!isLintRecord(node)) return false;
	if (node.kind === "not") return rejectsStaleServe(node.clause, bindings, !negated);
	if (node.kind === "all" || node.kind === "any") {
		if (!Array.isArray(node.clauses)) return false;
		// `all` fails if ANY clause fails; `any` fails only if EVERY clause fails.
		// Negation swaps which of the two the operator behaves like.
		const conjunctive = negated ? node.kind === "any" : node.kind === "all";
		return conjunctive
			? node.clauses.some((clause) => rejectsStaleServe(clause, bindings, negated))
			: node.clauses.every((clause) => rejectsStaleServe(clause, bindings, negated));
	}
	if (node.kind === "predicate") return predicateRejectsStaleServe(node, bindings, negated);
	return false;
}

/**
 * Whether a guard's degrade lands on the operation the case is about. A guard
 * whose condition reads the checked operation's freshness but attributes the
 * failure to a different operation leaves the checked one green through the
 * stale serve — covered on paper, not on the status page.
 */
/**
 * Whether an assert records its verdict against the checked operation. Same
 * concern as `guardAttributesTo`: an assertion that covers only some other
 * operation fails that one, not this one.
 */
function assertCoversOperation(coversOperations: unknown, operationId: string): boolean {
	return Array.isArray(coversOperations) && coversOperations.includes(operationId);
}

function guardAttributesTo(onFail: unknown, operationId: string): boolean {
	if (!isLintRecord(onFail) || !Array.isArray(onFail.attribute)) return false;
	return onFail.attribute.some((entry) => isLintRecord(entry) && entry.operationId === operationId);
}

/**
 * Whether a scenario reaches a verdict on freshness: a `guard` condition
 * (degraded, the shape this rule recommends) or an `assert` expression (down,
 * harsher but still real coverage). Any other position — an extract selector,
 * an operation input — is not a verdict.
 *
 * Order matters, and this is the rule the guidance states: the freshness
 * verdict must come before any OTHER guard. Every guard stops the scenario when
 * it fires, so a row or emptiness guard placed first answers a stale serve that
 * happens to be empty with its own reason and the freshness guard never runs —
 * the probe degrades for the wrong cause and the tenant reads "no rows" during
 * an upstream outage. Asserts before it are fine; they are the evidence clauses
 * and only stop the scenario by failing it outright.
 */
function scenarioChecksFreshness(scenario: unknown, operationId: string): boolean {
	if (!isLintRecord(scenario) || !Array.isArray(scenario.steps)) return false;
	const bindings = [...operationStepBindings(scenario.steps, operationId)];
	if (bindings.length === 0) return false;
	// EVERY read of the operation must be checked. A scenario that invokes it
	// twice with different inputs has two chances to serve stale, and one fresh
	// read must not conceal the other.
	return bindings.every((binding) =>
		resultBindingChecksFreshness(
			scenario.steps as readonly unknown[],
			binding,
			operationId,
			bindings,
		),
	);
}

function resultBindingChecksFreshness(
	steps: readonly unknown[],
	binding: string,
	operationId: string,
	siblingBindings: readonly string[],
): boolean {
	const operand = new Set([binding]);
	let produced = false;
	for (const step of steps) {
		if (!isLintRecord(step)) continue;
		if (!produced) {
			// Nothing before the read can have checked its freshness.
			produced = step.kind === "operation" && step.result === binding;
			continue;
		}
		if (
			step.kind === "assert" &&
			rejectsStaleServe(step.expression, operand) &&
			assertCoversOperation(step.coversOperations, operationId)
		) {
			return true;
		}
		if (step.kind !== "guard") continue;
		if (rejectsStaleServe(step.condition, operand)) {
			return guardAttributesTo(step.onFail, operationId);
		}
		// A freshness guard for ANOTHER read of the same operation is not a row or
		// emptiness guard masking the cause: it degrades on exactly this concern,
		// so `read A, read B, guard A, guard B` covers both. Anything else stops
		// the scenario first and shadows a later freshness guard.
		const coversSibling = siblingBindings.some(
			(sibling) =>
				sibling !== binding &&
				rejectsStaleServe(step.condition, new Set([sibling])) &&
				guardAttributesTo(step.onFail, operationId),
		);
		if (!coversSibling) return false;
	}
	return false;
}

/**
 * Whether a freshness guard for this operation still attributes
 * `expected_absence` — the only code the attribution schema admitted before
 * `served_stale_cache` existed, so earlier guidance recommended it. It IS
 * freshness coverage (the guard runs and stops the scenario), which is why
 * `scenarioChecksFreshness` accepts it; but the platform publishes
 * `expected_absence` as a non-incident status, so the stale serve it catches
 * would read as "nothing to return" instead of `degraded`.
 */
function freshnessGuardAttributesExpectedAbsence(scenario: unknown, operationId: string): boolean {
	if (!isLintRecord(scenario) || !Array.isArray(scenario.steps)) return false;
	const bindings = operationStepBindings(scenario.steps, operationId);
	if (bindings.size === 0) return false;
	return scenario.steps.some(
		(step) =>
			isLintRecord(step) &&
			step.kind === "guard" &&
			rejectsStaleServe(step.condition, bindings) &&
			isLintRecord(step.onFail) &&
			Array.isArray(step.onFail.attribute) &&
			step.onFail.attribute.some(
				(entry) =>
					isLintRecord(entry) &&
					entry.operationId === operationId &&
					entry.reasonCode === "expected_absence",
			),
	);
}

/** How many uncovered probes the stale-serve message names before eliding. */
const STALE_SERVE_MESSAGE_PROBE_LIMIT = 8;

/**
 * Stale-if-error serves no probe can see, on the deprecated per-call path.
 *
 * An operation that declares `cache: { staleIfErrorMs }` gets the freshness
 * guard attached by `defineProvider` and is never linted here. An operation
 * that still passes `staleIfErrorMs` to `ctx.cache.getOrSet` / `set` (kept
 * one release, `@deprecated`, runtime warn) has nothing attached, so for that
 * release the two rules main carried stay for exactly that path and are
 * removed together with the per-call option in the next minor:
 *
 * - `health-check-stale-serve-unguarded`: the provider serves stale-if-error
 *   per call and a case of an undeclared operation never checks
 *   `served_stale_cache`. During an upstream outage the cache answers HTTP 200
 *   with a schema-valid body, so every clause over `status_code` and `data`
 *   passes and the probe reports `ok` for the whole stale window.
 * - `health-check-stale-serve-reason`: a freshness guard of such an operation
 *   attributes `expected_absence`, which the platform publishes as a
 *   non-incident status, so the outage it catches reads as "nothing to
 *   return" instead of `degraded`.
 *
 * Both messages name the declaration as the fix: it replaces the per-call
 * option and the hand-written guard at once.
 */
function lintHealthCheckStaleServe(provider: {
	id?: string;
	providerSourceFiles?: Record<string, string>;
	operations?: Record<
		string,
		{ handler?: unknown; source?: string; healthCheck?: unknown; cache?: unknown }
	>;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const providerLabel = provider.id ? `Provider "${provider.id}"` : "Provider";
	// Attribution. A handler that carries the cache call in its OWN source names
	// exactly the operation that serves stale. A file does not: the linter cannot
	// follow the call graph, and it cannot reliably tell a handler's own file
	// from a shared helper either — `getOperationSource` returns the runtime's
	// `handler.toString()`, which type erasure and reformatting make textually
	// unequal to the TypeScript on disk. So any file-level evidence degrades the
	// verdict to "somewhere in this provider", and the message says so instead of
	// implying every listed probe reads through that cache.
	const sources = new Set<string>();
	const operationsServingStale = new Set<string>();
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		if (servesStaleIfError(getOperationSource(operation), `${operationKey}.ts`)) {
			sources.add(`operations.${operationKey} handler`);
			operationsServingStale.add(operationKey);
		}
	}
	let unattributed = false;
	for (const [filePath, source] of Object.entries(provider.providerSourceFiles ?? {})) {
		if (!isServingProviderSourcePath(filePath) || !servesStaleIfError(source, filePath)) continue;
		sources.add(filePath);
		unattributed = true;
	}
	if (sources.size === 0) return diagnostics;
	const attributable = !unattributed;

	// Freshness is judged per CASE. Operation-level bookkeeping would let one
	// guarded case silence its unguarded siblings, which still report `ok`
	// through a stale serve. An operation that declares `cache` is skipped
	// outright: the SDK attached its guard.
	const uncoveredByOperation = new Map<string, string[]>();
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		if (operation.cache !== undefined) continue;
		if (attributable && !operationsServingStale.has(operationKey)) continue;
		const absenceAttributed: string[] = [];
		for (const [caseIndex, healthCase] of readHealthCheckCases(operation.healthCheck).entries()) {
			const caseLabel =
				typeof healthCase.name === "string" && healthCase.name.length > 0
					? `"${healthCase.name}"`
					: `[${caseIndex}]`;
			if (!scenarioChecksFreshness(healthCase.scenario, operationKey)) {
				const uncovered = uncoveredByOperation.get(operationKey) ?? [];
				uncovered.push(`${operationKey} ${caseLabel}`);
				uncoveredByOperation.set(operationKey, uncovered);
			}
			if (freshnessGuardAttributesExpectedAbsence(healthCase.scenario, operationKey)) {
				absenceAttributed.push(caseLabel);
			}
		}
		if (absenceAttributed.length > 0) {
			diagnostics.push({
				rule: "health-check-stale-serve-reason",
				level: "warn",
				field: `operations.${operationKey}.healthCheck.cases`,
				message: `${providerLabel} operation "${operationKey}" health-check ${absenceAttributed.length === 1 ? "case" : "cases"} ${absenceAttributed.join(", ")} guard ${SERVED_STALE_CACHE_OPERAND} but attribute reasonCode "expected_absence". The platform publishes expected_absence as a non-incident status (neither ok nor degraded, excluded from uptime and incidents), so an upstream outage this guard catches would read as "nothing to return" instead of degraded. Declare cache: { staleIfErrorMs } on the operation and delete the per-call option and this guard: the SDK attaches a guard that attributes "served_stale_cache". Until then, attribute reasonCode "served_stale_cache"; the reasonKey and its copy can stay.`,
			});
		}
	}
	if (uncoveredByOperation.size === 0) return diagnostics;
	const uncovered = [...uncoveredByOperation]
		.filter(([operationKey]) => !attributable || operationsServingStale.has(operationKey))
		.flatMap(([, probes]) => probes);
	if (uncovered.length === 0) return diagnostics;

	const elided = uncovered.length - STALE_SERVE_MESSAGE_PROBE_LIMIT;
	const named = uncovered
		.slice(0, STALE_SERVE_MESSAGE_PROBE_LIMIT)
		.join(", ")
		.concat(elided > 0 ? `, and ${elided} more` : "");
	const caveat = attributable
		? ""
		: ` The cache call is in provider source the linter cannot attribute to one operation, so every uncovered probe is listed — skip any whose operation does not read through that cache.`;
	diagnostics.push({
		rule: "health-check-stale-serve-unguarded",
		level: "warn",
		field: "healthCheck",
		message: `${providerLabel} serves stale-if-error (staleIfErrorMs in ${[...sources].sort().join(", ")}) and these health-check cases never check ${SERVED_STALE_CACHE_OPERAND}: ${named}. During an upstream outage the cache answers HTTP 200 with a schema-valid body, so every clause over status_code and data still passes and those probes report ok for the whole stale window. Add one guard step per affected probe on { ref: { namespace: "steps", binding: "<operation step result>", path: ["${SERVED_STALE_CACHE_OPERAND}"] } } attributing status "degraded" with reasonCode "served_stale_cache" (a stale serve is an upstream fault; "expected_absence" is the non-incident status for an absence the provider declares in advance), placed before any row or emptiness guard, or declare cache: { staleIfErrorMs } on the operation and delete the per-call option: the SDK then attaches that guard and this rule no longer applies. The per-call option and this rule are removed in the next minor.${caveat}`,
	});
	return diagnostics;
}

/**
 * Health-check cases the platform monitor cannot execute.
 *
 * The monitor runs a case's SERIALIZED `scenario` and nothing else — a closure
 * cannot cross the registry's serialization boundary. A case carrying only
 * `assertions` is still published as a probe, but the registry projects it as
 * `legacy_function_assertions_not_serializable` and the monitor answers
 * `unknown` / `monitoring_unavailable` for it forever: the operation reads as
 * monitored on the status page while nothing is checked.
 *
 * Kept as a rule rather than a type because the only structural fix is making
 * `scenario` required on `HealthCheckCase`, which removes the self-test-only
 * `assertions` shape; that is a deprecation release, and this is the old
 * path's rule until then. A warning while the fleet migrates; it becomes an
 * error once no repository carries an unmonitored case.
 */
function lintHealthCheckMonitorability(provider: {
	id?: string;
	operations?: Record<string, { healthCheck?: unknown }>;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const providerLabel = provider.id ? `Provider "${provider.id}"` : "Provider";
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		const unmonitored = readHealthCheckCases(operation.healthCheck).flatMap(
			(healthCase, caseIndex) =>
				healthCase.scenario === undefined
					? [
							typeof healthCase.name === "string" && healthCase.name.length > 0
								? `"${healthCase.name}"`
								: `[${caseIndex}]`,
						]
					: [],
		);
		if (unmonitored.length > 0) {
			diagnostics.push({
				rule: "health-check-assertions-not-monitored",
				level: "warn",
				field: `operations.${operationKey}.healthCheck.cases`,
				message: `${providerLabel} operation "${operationKey}" health-check ${unmonitored.length === 1 ? "case" : "cases"} ${unmonitored.join(", ")} declare assertions without a scenario. The platform health monitor executes only a case's serialized scenario, so this operation publishes a probe whose outcome is permanently unknown/monitoring_unavailable — it reads as monitored while nothing is checked. Express the checks as scenario: defineHealthScenario({ ... }).`,
			});
		}
	}
	return diagnostics;
}

/**
 * Codes an `expectedErrors` entry may never name, whatever status they serve:
 * the upstream refusing the platform-managed key, the caller needing to
 * re-authenticate, an unprovisioned secret, and every rate-limit code. Each
 * one is a measured fault the platform publishes as such; declaring it an
 * absence would publish an outage as a non-incident.
 */
const EXPECTED_ERROR_FORBIDDEN_CODES: ReadonlySet<string> = new Set([
	"AUTH_REQUIRED",
	"reauth_required",
	"MISSING_SECRET",
	...Array.from(SDK_ERROR_REGISTRY_BY_CODE)
		.filter(
			([, registration]) =>
				registration.category === "upstream_auth" ||
				registration.category === "upstream_rate_limited",
		)
		.map(([code]) => code),
]);

/** Statuses the `expectedErrors` schema excludes; a code that serves one is not an absence. */
const EXPECTED_ERROR_FORBIDDEN_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

const PROVIDER_ERROR_CATEGORY_SET: ReadonlySet<string> = new Set(PROVIDER_ERROR_CATEGORIES);

function isProviderErrorCategory(value: string): value is ProviderErrorCategory {
	return PROVIDER_ERROR_CATEGORY_SET.has(value);
}

type ExpectedErrorEntry = { status: number; code: string };

/**
 * The by-code `expectedErrors` entries of one operation step, read
 * structurally. A reference entry (`{ error: errors.X, attribute }`) is
 * declared, status-bound and refusal-free by construction and serializes to
 * the same `{ status, code, attribute }`, so only the entries
 * `defineHealthScenario` tagged as authored by code are read; the reference
 * path has no rule (DX rule 2).
 */
function readExpectedErrors(step: Record<string, unknown>): ExpectedErrorEntry[] {
	if (step.kind !== "operation" || !Array.isArray(step.expectedErrors)) return [];
	return step.expectedErrors.flatMap((entry) =>
		isLintRecord(entry) &&
		isExpectedErrorByCode(entry) &&
		typeof entry.status === "number" &&
		typeof entry.code === "string"
			? [{ status: entry.status, code: entry.code }]
			: [],
	);
}

/**
 * The declaration the runtime reads for a code: `buildOperationErrorCodeLookup`
 * builds a `Map` from the list, so a duplicate code resolves to its LAST entry.
 */
function lastErrorCodeDeclaration<T extends { code: string }>(
	errorCodes: readonly T[] | undefined,
	code: string,
): T | undefined {
	if (errorCodes === undefined) return undefined;
	for (let index = errorCodes.length - 1; index >= 0; index -= 1) {
		const entry = errorCodes[index];
		if (entry?.code === code) return entry;
	}
	return undefined;
}

/** What an operation declares for a code, from either declaration shape. */
type ExpectedErrorDeclaration = {
	readonly status?: number;
	readonly category?: ProviderErrorCategory;
};

/**
 * The declaration the runtime reads for a code on an operation: a listed
 * `defineErrors` factory's declaration (the one `buildOperationErrorCodeLookup`
 * keeps when both shapes name the code, since factories are added after the
 * table) or the last legacy `errorCodes` row.
 */
function expectedErrorDeclaration(
	operation:
		| {
				errorCodes?: ReadonlyArray<{ code: string; status?: number }>;
				errors?: ReadonlyArray<{ declaration: ExpectedErrorDeclaration & { code: string } }>;
		  }
		| undefined,
	code: string,
): ExpectedErrorDeclaration | undefined {
	if (operation === undefined) return undefined;
	const factory = lastErrorCodeDeclaration(
		operation.errors?.map((entry) => entry.declaration),
		code,
	);
	if (factory !== undefined) return factory;
	return lastErrorCodeDeclaration(operation.errorCodes, code);
}

/**
 * The category the serve layer derives for a code when the throw site sets
 * none (`resolveProviderErrorContract`): the declaration's own category (a
 * `defineErrors` declaration always carries one), then a declared rejection
 * status, then the registered code's category. `undefined` leaves the class
 * default.
 */
function derivedExpectedErrorCategory(
	code: string,
	declared: ExpectedErrorDeclaration | undefined,
): ProviderErrorCategory | undefined {
	if (declared?.category !== undefined) return declared.category;
	const declaredStatus = declared?.status;
	if (declaredStatus === 409 || declaredStatus === 410 || declaredStatus === 422)
		return "upstream_rejected";
	return SDK_ERROR_REGISTRY_BY_CODE.get(code)?.category;
}

/**
 * Every `source` the serve layer can put on the envelope of a thrown code, as
 * far as the linter can see: `publicErrorSource` pins MISSING_SECRET,
 * UPSTREAM_ERROR and BLOCKED, and otherwise follows the category — the throw
 * site's literal `category` when it sets one, else the derived category, else
 * the class default (`provider_error` for ProviderError, `input_validation`
 * for ValidationError).
 *
 * A site whose `code` is not a literal (a helper that receives the code) may be
 * the one that throws this code, so it counts; a site with another literal
 * code does not. A candidate site that sets `category` from something other
 * than a literal (a mapping table's `...(mapped.category ? { category:
 * mapped.category } : {})`, a helper's `{ code, category }`) may carry an
 * upstream category, so it counts as possibly `upstream_failure` beside its
 * literal/derived resolution — the same reading as a non-literal `code`. With
 * no candidate site at all the derived resolution is the answer, which for a
 * provider code that nothing registers is `apifuse`. A `defineErrors`
 * declaration is thrown through its factory (`errors.X(...)`), which is not a
 * construction site, so its own category always counts beside any legacy site
 * that still hand-builds the code.
 */
function expectedErrorEnvelopeSources(
	code: string,
	declared: ExpectedErrorDeclaration | undefined,
	sites: readonly ThrownErrorConstructionSite[],
): ReadonlySet<ProviderErrorSource> {
	if (code === "MISSING_SECRET") return new Set(["apifuse"]);
	if (code === "UPSTREAM_ERROR" || code === "BLOCKED") return new Set(["upstream_failure"]);
	const derived = derivedExpectedErrorCategory(code, declared);
	const candidates = sites.filter((site) => site.code === code || site.code === undefined);
	if (candidates.length === 0) return new Set([sourceForCategory(derived ?? "provider_error")]);
	const declaredSource: ProviderErrorSource[] =
		declared?.category === undefined ? [] : [sourceForCategory(declared.category)];
	return new Set([
		...declaredSource,
		...candidates.flatMap((site): ProviderErrorSource[] => {
			const literal =
				site.category !== undefined && isProviderErrorCategory(site.category)
					? site.category
					: undefined;
			const fallback =
				site.errorClass === "ValidationError" ? "input_validation" : "provider_error";
			const resolved = sourceForCategory(literal ?? derived ?? fallback);
			return site.nonLiteralCategory === true ? [resolved, "upstream_failure"] : [resolved];
		}),
	]);
}

/**
 * `expectedErrors` entries the runtime can never produce as a matching
 * envelope, and entries that would turn a credential or rate-limit refusal
 * into an absence.
 *
 * `expectedErrors` on an operation step tells the platform monitor that one
 * specific non-2xx answer — this `status` and `code`, served by the
 * provider's own upstream envelope (`source: "upstream_failure"`) — is the
 * provider's declared "nothing to return". The monitor matches all three, so
 * an entry naming a code the operation never serves, a status the runtime
 * never serves for that code, or a code whose envelope the serve layer
 * attributes elsewhere (`upstream_rule` for a declared rejection status or a
 * registered refusal, `apifuse` for a provider code thrown without an
 * upstream `category`) is silently dead: the quiet day stays recorded as
 * `down`, which is the defect the clause exists to fix. The served status and
 * source are the ones `toStatusCode` / `publicErrorSource` resolve, read the
 * way the runtime reads them: a listed `defineErrors` factory (`errors:
 * [errors.X]`) or the legacy `errorCodes` row (a duplicate entry resolves to
 * its last declaration).
 *
 * Error level: a dead or dangerous entry has no partial value.
 *
 * The rule of the deprecated by-code form only. The reference form
 * (`errorRefs(errorCodes).X`) makes an undeclared code, a status outside the
 * absence class and a refusal code compile errors, so it is never linted;
 * both rules are removed together with the by-code form in the next minor.
 */
function lintHealthCheckExpectedErrors(provider: {
	id?: string;
	authFlowSource?: string;
	providerSourceFiles?: Record<string, string>;
	operations?: Record<
		string,
		{
			handler?: unknown;
			source?: string;
			healthCheck?: unknown;
			errorCodes?: ReadonlyArray<{ code: string; status?: number }>;
			errors?: ReadonlyArray<{
				declaration: { code: string; status?: number; category?: ProviderErrorCategory };
			}>;
		}
	>;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const providerLabel = provider.id ? `Provider "${provider.id}"` : "Provider";
	const operations = provider.operations ?? {};
	let scannedSites: ThrownErrorConstructionSite[] | undefined;
	const throwSites = (): ThrownErrorConstructionSite[] => {
		scannedSites ??= collectThrowSiteLintSources(provider).flatMap(({ source }) =>
			collectThrownErrorConstructionSites(source),
		);
		return scannedSites;
	};
	for (const [operationKey, operation] of Object.entries(operations)) {
		const cases = readHealthCheckCases(operation.healthCheck);
		for (const [caseIndex, healthCase] of cases.entries()) {
			const scenario = healthCase.scenario;
			if (!isLintRecord(scenario) || !Array.isArray(scenario.steps)) continue;
			for (const [stepIndex, step] of scenario.steps.entries()) {
				if (!isLintRecord(step)) continue;
				const entries = readExpectedErrors(step);
				if (entries.length === 0) continue;
				const stepOperationId = typeof step.operationId === "string" ? step.operationId : "";
				const owning = operations[stepOperationId];
				for (const [entryIndex, entry] of entries.entries()) {
					const field = `operations.${operationKey}.healthCheck.cases[${caseIndex}].scenario.steps[${stepIndex}].expectedErrors[${entryIndex}]`;
					const label = `${providerLabel} operation "${operationKey}" health-check case [${caseIndex}] step "${typeof step.id === "string" ? step.id : stepIndex}" declares expectedErrors ${entry.status} "${entry.code}" for operation "${stepOperationId}"`;
					const declared = expectedErrorDeclaration(owning, entry.code);
					const canonicalStatus = SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get(entry.code);
					// Mirrors toStatusCode: an SDK-owned code ignores the declaration,
					// any other declared status wins over the canonical mapping.
					const sdkOwned = SDK_RUNTIME_OWNED_ERROR_CODES.has(entry.code);
					const servedStatus = sdkOwned ? canonicalStatus : (declared?.status ?? canonicalStatus);
					if (
						EXPECTED_ERROR_FORBIDDEN_CODES.has(entry.code) ||
						(servedStatus !== undefined && EXPECTED_ERROR_FORBIDDEN_STATUSES.has(servedStatus))
					) {
						diagnostics.push({
							rule: "health-check-expected-error-not-an-absence",
							level: "error",
							field,
							message: `${label}, but that code is a credential or rate-limit refusal${servedStatus === undefined ? "" : ` (served ${servedStatus})`}: a measured fault the platform publishes as degraded or down, never an absence. Remove the entry; declare only the code the handler throws when the upstream has nothing to return.`,
						});
						continue;
					}
					if (declared === undefined && canonicalStatus === undefined) {
						diagnostics.push({
							rule: "health-check-expected-error-unmatchable",
							level: "error",
							field,
							message: `${label}, which neither declares that code (a defineErrors factory in errors, or an errorCodes row) nor is it SDK-registered; the runtime serves HTTP 500 for it, so this entry can never match and the absence it describes is recorded as down. Declare the code with status ${entry.status} and list it in the owning operation's errors, or name the registered code the handler actually throws.`,
						});
						continue;
					}
					if (servedStatus === undefined) {
						diagnostics.push({
							rule: "health-check-expected-error-unmatchable",
							level: "error",
							field,
							message: `${label}, but the errorCodes declaration for "${entry.code}" carries no status and the SDK has no canonical one, so the runtime serves HTTP 500 for it and this entry can never match. Add status ${entry.status} to that errorCodes entry.`,
						});
						continue;
					}
					if (servedStatus !== entry.status) {
						diagnostics.push({
							rule: "health-check-expected-error-unmatchable",
							level: "error",
							field,
							message: `${label}, but the runtime serves status ${servedStatus} for that code (${declared?.status !== undefined && !sdkOwned ? "its declaration" : "the SDK's canonical status"}); the monitor matches status and code together, so this entry can never match. Use status ${servedStatus}.`,
						});
						continue;
					}
					const sources = expectedErrorEnvelopeSources(
						entry.code,
						sdkOwned ? undefined : declared,
						throwSites(),
					);
					if (sources.has("upstream_failure")) continue;
					const registered = SDK_ERROR_REGISTRY_BY_CODE.get(entry.code);
					const hint =
						registered !== undefined
							? `A code registered as ${registered.category} is an upstream refusal, not an absence; throw the registered code the upstream answer means (NO_DATA for an empty result).`
							: servedStatus === 409 || servedStatus === 410 || servedStatus === 422
								? `A declared status of ${servedStatus} classes the code as an upstream refusal (upstream_rejected → upstream_rule); an absence is a 404-class answer.`
								: `A provider code thrown without a category is classed provider_error (source "apifuse"). Set category: "upstream_http" on the new ProviderError(...) that throws it — the linter reads construction sites, so a helper that builds the error must set the category there (a literal, or a variable or spread it passes through).`;
					diagnostics.push({
						rule: "health-check-expected-error-unmatchable",
						level: "error",
						field,
						message: `${label}, but the runtime serves that code with source ${[...sources].map((source) => `"${source}"`).join(" or ")}; the monitor honours expectedErrors only for the provider's own upstream envelope (source "upstream_failure"), so this entry can never match. ${hint}`,
					});
				}
			}
		}
	}
	return diagnostics;
}

export function lintOperation(op: {
	descriptionKey?: string;
	whenToUseKeys?: readonly string[];
	whenNotToUseKeys?: readonly string[];
	input: unknown;
	output: unknown;
	fixtures?: unknown;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const hasDescriptionKey = typeof op.descriptionKey === "string" && op.descriptionKey.length > 0;

	if (!hasDescriptionKey) {
		diagnostics.push({
			rule: "description-key-required",
			level: "error",
			field: "descriptionKey",
			message: "Operation must declare a locale-backed descriptionKey.",
		});
	}

	diagnostics.push(
		...collectSchemaDescriptionKeyDiagnostics(op.input, "input"),
		...collectSchemaDescriptionKeyDiagnostics(op.output, "output"),
	);

	if (!hasBidirectionalFixtures(op.fixtures)) {
		diagnostics.push({
			rule: "fixtures-both-directions",
			level: "error",
			field: "fixtures",
			message: "Fixtures must include both request and response.",
		});
	}

	for (const field of uniqueFields(collectUnmarkedSensitiveFields(op.input, "input"))) {
		diagnostics.push({
			rule: "sensitive-field-unmarked",
			level: "warn",
			field,
			message: `Schema field "${field}" looks sensitive; mark it with fields.*() or sensitive(...); publicField(...) is accepted only for reviewed public phone-shaped fields.`,
		});
	}

	for (const field of uniqueFields(collectUnmarkedSensitiveFields(op.output, "output"))) {
		diagnostics.push({
			rule: "sensitive-field-unmarked",
			level: "warn",
			field,
			message: `Schema field "${field}" looks sensitive; mark it with fields.*() or sensitive(...); publicField(...) is accepted only for reviewed public phone-shaped fields.`,
		});
	}

	return diagnostics;
}

function declaredPinnedWireFieldPaths(provider: {
	meta?: { contract?: ProviderContractMetaLike };
}): readonly { readonly path: string; readonly reason: string }[] {
	const pins = provider.meta?.contract?.pinnedWireFieldPaths;
	if (!Array.isArray(pins)) return [];
	return pins.filter(
		(pin) =>
			pin !== null &&
			typeof pin === "object" &&
			typeof pin.path === "string" &&
			pin.path.trim().length > 0 &&
			typeof pin.reason === "string" &&
			pin.reason.trim().length > 0,
	);
}

function applyPinnedWireFieldPaths(
	provider: { meta?: { contract?: ProviderContractMetaLike } },
	diagnostics: readonly LintDiagnostic[],
): ProviderLintResult {
	const pins = declaredPinnedWireFieldPaths(provider);
	if (pins.length === 0) {
		return { diagnostics: [...diagnostics], information: [] };
	}

	const pinsByPath = new Map(pins.map((pin) => [pin.path, pin]));
	const matchedPaths = new Set<string>();
	const remainingDiagnostics = diagnostics.filter((diagnostic) => {
		if (
			diagnostic.rule !== "public-schema-upstream-field" ||
			diagnostic.field === undefined ||
			!pinsByPath.has(diagnostic.field)
		) {
			return true;
		}
		matchedPaths.add(diagnostic.field);
		return false;
	});

	const information: ProviderLintInformation[] = [];
	for (const pin of pins) {
		if (matchedPaths.has(pin.path)) {
			information.push({
				rule: "public-schema-pinned-wire-field",
				field: pin.path,
				message: `Suppressed exact public-schema-upstream-field diagnostic. Reason: ${pin.reason}`,
			});
			continue;
		}

		remainingDiagnostics.push({
			rule: "public-schema-pinned-wire-field-stale",
			level: "error",
			field: pin.path,
			message: `Pinned wire field path ${JSON.stringify(pin.path)} matches no current public-schema-upstream-field diagnostic; remove the stale declaration.`,
		});
	}

	return { diagnostics: remainingDiagnostics, information };
}

export function lintProvider(
	provider: {
		id?: string;
		allowedHosts?: readonly string[];
		stealth?: unknown;
		auth?: ProviderAuthLike;
		credential?: {
			keys?: readonly string[];
			storesReusableSecret?: boolean;
			justification?: string;
		};
		context?: {
			keys?: readonly string[];
		};
		authFlowSource?: string;
		providerSourceFiles?: Record<string, string>;
		operations?: Record<
			string,
			{
				descriptionKey?: string;
				whenToUseKeys?: readonly string[];
				whenNotToUseKeys?: readonly string[];
				connectionMode?: "none" | "optional" | "required";
				riskClass?: OperationRiskClass;
				approval?: OperationApprovalPolicy;
				input: unknown;
				output: unknown;
				fixtures?: unknown;
				handler?: unknown;
				source?: string;
				/** Read structurally by the health-check monitorability rules. */
				healthCheck?: unknown;
				/** `cache: { staleIfErrorMs }`; an operation that declares it is never stale-serve linted. */
				cache?: unknown;
				errorCodes?: ReadonlyArray<{
					code: string;
					status?: number;
					retryable?: boolean;
					messageKey?: string;
					fixKey?: string;
				}>;
				/** `defineErrors` factories the operation lists; read by the health-check expectedErrors rule. */
				errors?: ReadonlyArray<{
					declaration: { code: string; status?: number; category?: ProviderErrorCategory };
				}>;
			}
		>;
		meta?: {
			contract?: ProviderContractMetaLike;
		};
		reviewed?: string;
		/** Declared handle kinds (ADR-0012); read structurally, see lintLegacyHandleDeclarations. */
		handle?: unknown;
		state?: unknown;
	},
	/** @deprecated Ignored; pass `mode` to `bundleProvider(providerRoot, { mode })`. Removed in the next major. */
	options?: ProviderLintOptions,
): LintDiagnostic[] {
	return lintProviderWithInformation(provider, options).diagnostics;
}

/** Internal detailed result used by the CLI to render suppression audits. */
export function lintProviderWithInformation(
	provider: Parameters<typeof lintProvider>[0],
	/** @deprecated Ignored; pass `mode` to `bundleProvider(providerRoot, { mode })`. Removed in the next major. */
	options?: ProviderLintOptions,
): ProviderLintResult {
	warnProviderLintOptionsOnce(options);
	const diagnostics: LintDiagnostic[] = [
		...lintAllowedHosts(provider.id, provider.allowedHosts),
		...lintReviewed(provider.id, provider.reviewed),
		...lintAuthModel(provider),
		...lintStealthTransportUsage(provider),
		...lintCredentialWriteUsage(provider),
		...lintBrowserVersionLiterals(provider),
		...lintLegacyErrorOptions(provider),
		...lintLegacyChoiceUsage(provider),
		...lintProviderMetaNarrowing(provider),
		...lintLegacyHandleDeclarations(provider),
		...lintHealthCheckMonitorability(provider),
		...lintHealthCheckStaleServe(provider),
		...lintHealthCheckExpectedErrors(provider),
	];
	if (provider.operations) {
		const authMode = provider.auth?.mode;
		for (const [operationKey, operation] of Object.entries(provider.operations)) {
			if (isCredentialBearingAuthMode(authMode) && operation.connectionMode === undefined) {
				diagnostics.push({
					rule: "mixed-auth-connection-mode-required",
					level: "error",
					field: `operations.${operationKey}.connectionMode`,
					message: `Provider "${provider.id ?? "unknown"}" uses credential-bearing auth.mode "${authMode}"; operation "${operationKey}" must declare connectionMode explicitly.`,
				});
			}
			if (
				operation.riskClass !== undefined &&
				operation.approval !== undefined &&
				operation.approval === defaultApprovalPolicy(operation.riskClass)
			) {
				diagnostics.push({
					rule: "redundant-approval",
					level: "error",
					field: `operations.${operationKey}.approval`,
					message: `Operation "${operationKey}" approval "${operation.approval}" repeats the default for riskClass "${operation.riskClass}"; omit approval unless it is a deliberate override.`,
				});
			}
		}
		// Every authenticated mode owns an auth.flow; `oauth2_proxied` was
		// previously exempt, which let auth-lifecycle operations ship on
		// proxied providers unchecked.
		if (authMode === "credentials" || authMode === "oauth2" || authMode === "oauth2_proxied") {
			for (const operationKey of Object.keys(provider.operations)) {
				if (isAuthLifecycleOperationId(operationKey, authMode)) {
					diagnostics.push({
						rule: "auth-operation-unsupported",
						level: "error",
						field: `operations.${operationKey}`,
						message: `Provider "${provider.id ?? "unknown"}" operation "${operationKey}" performs an auth-lifecycle action (login, logout, token exchange or similar). Authenticated providers must expose the whole credential lifecycle through the single auth.flow interface because Gateway persists only auth.flow complete turn data.credential as the connection credential, and an operation that mutates the session outside that interface leaves the stored connection stale. Move sign-in logic into auth.flow.start/continue and sign-out/disconnect logic into auth.flow.abort (served by POST /auth/disconnect) instead of a provider operation.`,
					});
				}
			}
		}
	}

	if (!provider.operations) {
		return applyPinnedWireFieldPaths(provider, diagnostics);
	}

	diagnostics.push(
		...Object.entries(provider.operations).flatMap(([operationKey, operation]) =>
			[
				...lintOperation({
					descriptionKey: operation.descriptionKey,
					whenToUseKeys: operation.whenToUseKeys,
					whenNotToUseKeys: operation.whenNotToUseKeys,
					input: operation.input,
					output: operation.output,
					fixtures: operation.fixtures,
				}),
				...lintPublicSchemaFieldNames(
					provider.id,
					operationKey,
					operation.input,
					operation.output,
					provider.meta?.contract?.publicSchemaFieldNames === "normalized",
				),
			].map((diagnostic) => ({
				...diagnostic,
				field: diagnostic.field
					? `operations.${operationKey}.${diagnostic.field}`
					: `operations.${operationKey}`,
				message: `[${operationKey}] ${diagnostic.message}`,
			})),
		),
	);

	return applyPinnedWireFieldPaths(provider, diagnostics);
}
