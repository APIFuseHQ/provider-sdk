import { createRequire } from "node:module";

import type { ZodType } from "zod";

import {
	SDK_CANONICAL_ERROR_CODE_RETRYABILITY,
	SDK_RUNTIME_OWNED_ERROR_CODES,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
} from "./error-resolution.js";
import {
	APIFUSE_HANDLE_META_KEY,
	type HandleFieldMeta,
	type HandleKindDeclaration,
	handleFieldDescription,
	handleIssuerList,
	isHandleIssuedBy,
	isHandleFieldMeta,
} from "./handle-meta.js";
import { PROVIDER_ERROR_CATALOG_NAMESPACE } from "./i18n/error-messages.js";
import {
	getProviderLocaleSegments,
	isProviderLocaleKey,
	type ProviderLocaleCatalog,
} from "./i18n/keys.js";
import { lintPublicSchemaFieldNames } from "./public-schema-field-lint.js";
import {
	isStealthOwnedHeaderName,
	SDK_OWNED_CHROME_HEADER_PREFIX,
} from "./runtime/stealth-owned-headers.js";
import { APIFUSE_DESCRIPTION_KEY_META_KEY, APIFUSE_SENSITIVE_META_KEY } from "./schema.js";
import type { AuthMode, OperationApprovalPolicy, OperationRiskClass } from "./types.js";

const requireModule = createRequire(import.meta.url);
// `typeof import(...)` keeps the type without emitting a static import: the
// typescript package is a CLI-only dependency and src/lint.ts is production
// runtime, which the typescript-import-boundary test enforces.
let typeScriptModule: typeof import("typescript") | undefined;

function getTypeScript(): typeof import("typescript") {
	typeScriptModule ??= requireModule("typescript") as typeof import("typescript");
	return typeScriptModule;
}

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

export type ProviderLintMode = "official" | "standalone";

type ProviderLintOptions = {
	mode?: ProviderLintMode;
};

export interface ProviderLintInformation {
	rule: string;
	message: string;
	field?: string;
}

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
 * Handle meta placed by `kind.field()` lives on the string schema itself; zod
 * wrappers (`.optional()`, `.nullable()`, `.default()`, pipes) do not inherit
 * registry metadata, so look through wrapper nodes until a non-wrapper is hit.
 */
function getHandleFieldMeta(
	schema: unknown,
	seen = new Set<SchemaLike>(),
): HandleFieldMeta | undefined {
	if (!isSchema(schema) || seen.has(schema)) return undefined;
	seen.add(schema);
	const own = getOwnHandleFieldMeta(schema);
	if (own) return own;
	for (const child of getChildSchemas(schema)) {
		if (child.origin === "shape" || !isSchemaWrapperNodeKey(child.key)) continue;
		const found = getHandleFieldMeta(child.schema, seen);
		if (found) return found;
	}
	return undefined;
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

function lintPlaywrightDirectImports(provider: {
	authFlowSource?: string;
	providerSourceFiles?: Record<string, string>;
	operations?: Record<string, { handler?: unknown; source?: string }>;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const importPattern =
		/(?:import\s+(?:type\s+)?[\s\S]*?\s+from\s+["'](?:playwright|playwright-core)["']|require\(\s*["'](?:playwright|playwright-core)["']\s*\)|import\(\s*["'](?:playwright|playwright-core)["']\s*\))/;

	if (provider.authFlowSource && importPattern.test(provider.authFlowSource)) {
		diagnostics.push({
			rule: "playwright-direct-import",
			level: "warn",
			field: "auth.flow",
			message:
				"Provider auth flow imports playwright directly; use ctx.browser frame-aware methods so the SDK can enforce the CDP pool runtime.",
		});
	}

	for (const [filePath, source] of Object.entries(provider.providerSourceFiles ?? {})) {
		if (!importPattern.test(source)) {
			continue;
		}

		diagnostics.push({
			rule: "playwright-direct-import",
			level: "warn",
			field: `sourceFiles.${filePath}`,
			message:
				"Provider source imports playwright directly; use ctx.browser frame-aware methods so the SDK can enforce the CDP pool runtime.",
		});
	}

	if (!provider.operations) {
		return diagnostics;
	}

	for (const [operationKey, operation] of Object.entries(provider.operations)) {
		const source = getOperationSource(operation);
		if (!importPattern.test(source)) {
			continue;
		}

		diagnostics.push({
			rule: "playwright-direct-import",
			level: "warn",
			field: `operations.${operationKey}.handler`,
			message:
				"Operation source imports playwright directly; use ctx.browser frame-aware methods so the SDK can enforce the CDP pool runtime.",
		});
	}

	return diagnostics;
}

type SelfHostedBrowserPattern = {
	rule: string;
	pattern: RegExp;
	message: string;
};

const SELF_HOSTED_BROWSER_MESSAGE =
	"Official browser providers must use ctx.browser backed by the managed CDP Pool; do not launch or connect to provider-local Chrome/CDP runtimes.";

const SELF_HOSTED_BROWSER_PATTERNS: readonly SelfHostedBrowserPattern[] = [
	{
		rule: "browser-self-hosted-launch",
		pattern: /\b(?:playwright|chromium|firefox|webkit|puppeteer)\.launch\s*\(/,
		message: `${SELF_HOSTED_BROWSER_MESSAGE} Replace direct Playwright/Puppeteer launch calls with ctx.browser.newPage() or ctx.browser.withIsolatedContext().`,
	},
	{
		rule: "browser-self-hosted-child-process",
		pattern:
			/(?:\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\([\s\S]{0,240}\b(?:google-chrome|chrome|chromium|chromium-browser)\b|\b(?:Bun\.)?spawn(?:Sync)?\s*\([\s\S]{0,240}\b(?:google-chrome|chrome|chromium|chromium-browser)\b|\$`[\s\S]{0,240}\b(?:google-chrome|chrome|chromium|chromium-browser)\b)/,
		message: `${SELF_HOSTED_BROWSER_MESSAGE} Provider pods must not start Chrome with child_process, Bun.spawn, or shell commands.`,
	},
	{
		rule: "browser-self-hosted-remote-debugging-port",
		pattern:
			/(?:\b(?:google-chrome|chrome|chromium|chromium-browser)\b[\s\S]{0,240}--remote-debugging-port\b|--remote-debugging-port(?:=|\s+))/,
		message: `${SELF_HOSTED_BROWSER_MESSAGE} Provider entrypoints, Dockerfiles, and scripts must not start Chrome with a remote debugging port; use the managed CDP Pool instead.`,
	},
	{
		rule: "browser-direct-cdp-version-poll",
		pattern: /\/json\/version\b/,
		message: `${SELF_HOSTED_BROWSER_MESSAGE} Do not poll /json/version from provider code; the SDK manages CDP leases through APIFUSE__CDP_POOL__URL.`,
	},
	{
		rule: "browser-provider-local-cdp-env",
		pattern:
			/\b(?!APIFUSE__CDP_POOL__URL\b)[A-Z][A-Z0-9_]*_CDP_URL\b|process\.env(?:\.(?!APIFUSE__CDP_POOL__URL\b)[A-Z0-9_]*_CDP_URL\b|\[\s*["'`](?!APIFUSE__CDP_POOL__URL\b)[A-Z0-9_]*_CDP_URL["'`]\s*\])/,
		message: `${SELF_HOSTED_BROWSER_MESSAGE} Do not read provider-local CDP endpoint env vars including AMAZON_CDP_URL or custom *_CDP_URL names; production uses APIFUSE__CDP_POOL__URL through ctx.browser.`,
	},
];

function lintSelfHostedBrowserPatterns(
	provider: ProviderSourceLike,
	options: ProviderLintOptions,
): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const level = options.mode === "standalone" ? "warn" : "error";
	const sources: Array<{ field: string; source: string }> = [];

	if (provider.authFlowSource) {
		sources.push({ field: "auth.flow", source: provider.authFlowSource });
	}

	for (const [filePath, source] of Object.entries(provider.providerSourceFiles ?? {})) {
		sources.push({ field: `sourceFiles.${filePath}`, source });
	}

	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		const source = getOperationSource(operation);
		if (source) {
			sources.push({
				field: `operations.${operationKey}.handler`,
				source,
			});
		}
	}

	for (const { field, source } of sources) {
		for (const item of SELF_HOSTED_BROWSER_PATTERNS) {
			item.pattern.lastIndex = 0;
			if (!item.pattern.test(source)) {
				continue;
			}
			diagnostics.push({
				rule: item.rule,
				level,
				field,
				message: item.message,
			});
		}
	}

	return diagnostics;
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
 * matches a versioned literal value rather than the name — a user-agent read
 * from a variable is rejected by the runtime and stays silent here. Widening
 * the set needs a per-file transport scope and a suppression path first.
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

function collectBrowserVersionLiteralFindings(source: string): BrowserVersionLiteralFinding[] {
	const ts = getTypeScript();
	const sourceFile = ts.createSourceFile(
		"provider-source.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
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
			// Only a `[name, value]` tuple is a header. A name list such as
			// `new Set(["sec-ch-ua-mobile", "sec-ch-ua-platform"])` is not: it is
			// the argument of a constructor, or its second element is itself an
			// owned name.
			const second = node.elements[1];
			inspectHeaderEntry(
				node.elements[0],
				staticStringText(node.elements[0]),
				second,
				node.elements.length === 2 &&
					!ts.isNewExpression(node.parent) &&
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
			return `ctx.stealth owns the "${finding.literal}" header and rejects a caller value with STEALTH_HEADER_OVERRIDE_UNSUPPORTED (HTTP 500 at request time). Remove it; declare stealth: { requestClass: "navigation" | "xhr" | "post" } to drive Sec-Fetch-* and select the profile with stealth: { browser: "chrome", os: "macos" } for client hints.`;
	}
}

function lintBrowserVersionLiterals(provider: ProviderSourceLike): LintDiagnostic[] {
	const sources: Array<{ field: string; source: string }> = [];
	const sourceFiles = Object.entries(provider.providerSourceFiles ?? {}).filter(
		([filePath]) =>
			JAVASCRIPT_SOURCE_FILE_PATTERN.test(filePath) &&
			!TEST_SOURCE_FILE_PATTERN.test(filePath) &&
			!RECORDED_FIXTURE_SOURCE_FILE_PATTERN.test(filePath),
	);
	if (sourceFiles.length > 0) {
		for (const [filePath, source] of sourceFiles) {
			sources.push({ field: `sourceFiles.${filePath}`, source });
		}
	} else {
		if (provider.authFlowSource)
			sources.push({ field: "auth.flow", source: provider.authFlowSource });
		for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
			const source = getOperationSource(operation);
			if (source) sources.push({ field: `operations.${operationKey}.handler`, source });
		}
	}

	return sources.flatMap(({ field, source }) =>
		collectBrowserVersionLiteralFindings(source).map((finding) => ({
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
 * Collects literal string values of the named top-level properties inside a
 * ProviderError/AuthError/ValidationError options object. Only plain `"..."` /
 * `'...'` literals at options-object depth count; computed values (identifiers,
 * ternaries, template substitutions, concatenations, escapes) are skipped
 * silently so the rules never guess. The first literal wins per property name.
 */
function collectLiteralErrorOptionValues(
	args: string,
	optionNames: readonly string[],
): Record<string, string> {
	const collected: Record<string, string> = {};
	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let previousSignificantChar = "";
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
		} else if (char === "(") {
			parenDepth++;
		} else if (char === ")") {
			parenDepth--;
		} else if (char === "[") {
			bracketDepth++;
		} else if (char === "]") {
			bracketDepth--;
		} else if (
			braceDepth === 1 &&
			parenDepth === 0 &&
			bracketDepth === 0 &&
			(previousSignificantChar === "{" || previousSignificantChar === ",")
		) {
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
						}
						index = end;
						previousSignificantChar = quote;
						continue;
					}
					return collected;
				}
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
};

const THROWN_ERROR_LOCALE_OPTION_NAMES = ["code", "messageKey", "fixKey"] as const;

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
			const values = collectLiteralErrorOptionValues(args, THROWN_ERROR_LOCALE_OPTION_NAMES);
			sites.push({
				errorClass: match[1] ?? "",
				...(values.code === undefined ? {} : { code: values.code }),
				...(values.messageKey === undefined ? {} : { messageKey: values.messageKey }),
				...(values.fixKey === undefined ? {} : { fixKey: values.fixKey }),
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
 * Static counterpart of the runtime `unregistered_provider_error_code`
 * signal (honest-provider-error-contract Phase 3.5.5): flags
 * `new ProviderError(...)` / `new ValidationError(...)` constructions whose
 * literal `code` is neither SDK-registered (SDK_RUNTIME_OWNED_ERROR_CODES
 * plus the canonical status-mapped codes shared with serve.ts toStatusCode)
 * nor declared in any operation's errorCodes. At runtime such a code
 * serves HTTP 500 and emits the signal; this rule surfaces it at check time.
 *
 * A throw site cannot be attributed to a specific operation statically —
 * providers routinely throw from helpers shared across operations — so this
 * rule matches against the provider-level union of declared codes. That is
 * the honest scope: it will not catch a code declared only on the "wrong"
 * operation, and it never claims per-operation attribution it cannot prove.
 * Only literal string codes are checked; computed/dynamic codes and test
 * sources are skipped silently. Warning level: the long tail of existing
 * providers converges gradually, so this must not fail `apifuse check`.
 */
function lintUndeclaredThrownErrorCodes(provider: {
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
	const knownCodes = new Set<string>([
		...SDK_RUNTIME_OWNED_ERROR_CODES,
		...SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.keys(),
	]);
	for (const operation of Object.values(provider.operations ?? {})) {
		for (const entry of operation.errorCodes ?? []) {
			if (typeof entry?.code === "string") {
				knownCodes.add(entry.code);
			}
		}
	}

	const sources = collectThrowSiteLintSources(provider);

	const diagnostics: LintDiagnostic[] = [];
	for (const { field, source } of sources) {
		const undeclaredCodes = new Set(
			collectThrownErrorConstructionSites(source)
				.filter((site) => UNDECLARED_CODE_ERROR_CLASSES.has(site.errorClass))
				.flatMap((site) => (site.code === undefined ? [] : [site.code]))
				.filter((code) => !knownCodes.has(code)),
		);
		for (const code of undeclaredCodes) {
			diagnostics.push({
				rule: "thrown-error-code-undeclared",
				level: "warn",
				field,
				message: `Thrown error code "${code}" (${field}) is neither SDK-registered nor declared in any operation's errorCodes; at runtime it serves HTTP 500 and emits the unregistered_provider_error_code signal. Declare it in the owning operation's errorCodes with status and retryable.`,
			});
		}
	}
	return diagnostics;
}

/**
 * Flags an operation `errorCodes` entry whose declared `status` or `retryable`
 * contradicts the SDK's canonical resolution for that code.
 *
 * For a code the SDK status-maps but does not runtime-own (UPSTREAM_ERROR,
 * BLOCKED, and the fleet-consensus codes registered alongside them), the
 * declaration still wins at runtime — `toStatusCode` reads the declaration
 * before the canonical map. So registering a code never silently rewrites an
 * existing declaration's status, and it must not: that would change a served
 * status behind the author's back. What it does create is a fleet that answers
 * one code two ways. This rule is where that divergence surfaces, by name, with
 * the canonical value to converge on.
 *
 * Codes the SDK runtime-owns are handled separately: `defineProvider` already
 * warns there, because for those the declaration really is ignored.
 *
 * Warning level, deliberately: the divergent providers are live and converge on
 * their own schedule, so this must not fail `apifuse check`.
 */
function lintErrorCodeDeclarationConflicts(provider: {
	id?: string;
	operations?: Record<
		string,
		{
			errorCodes?: ReadonlyArray<{ code: string; status?: number; retryable?: boolean }>;
		}
	>;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const providerId = provider.id ?? "unknown";
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		for (const [index, entry] of (operation.errorCodes ?? []).entries()) {
			if (typeof entry?.code !== "string") continue;
			// SDK-owned codes ignore the declaration outright; defineProvider owns
			// that message so authors are not told two different things.
			if (SDK_RUNTIME_OWNED_ERROR_CODES.has(entry.code)) continue;

			const field = `operations.${operationKey}.errorCodes[${index}]`;
			const canonicalStatus = SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get(entry.code);
			if (canonicalStatus !== undefined && entry.status !== undefined) {
				if (entry.status !== canonicalStatus) {
					diagnostics.push({
						rule: "error-code-status-conflicts-sdk",
						level: "warn",
						field: `${field}.status`,
						message: `Provider "${providerId}" operation "${operationKey}" declares status ${entry.status} for SDK-registered error code "${entry.code}", whose canonical status is ${canonicalStatus}. The declaration still wins at runtime, so this operation serves ${entry.status} while the rest of the fleet serves ${canonicalStatus} for the same code. Drop the status (the SDK supplies ${canonicalStatus}) or, if ${entry.status} is genuinely the right answer here, throw a distinct code that means that.`,
					});
				}
			}

			const canonicalRetryable = SDK_CANONICAL_ERROR_CODE_RETRYABILITY.get(entry.code);
			if (
				canonicalRetryable !== undefined &&
				entry.retryable !== undefined &&
				entry.retryable !== canonicalRetryable
			) {
				diagnostics.push({
					rule: "error-code-retryable-conflicts-sdk",
					level: "warn",
					field: `${field}.retryable`,
					message: `Provider "${providerId}" operation "${operationKey}" declares retryable ${entry.retryable} for SDK-registered error code "${entry.code}", whose canonical retryability is ${canonicalRetryable}. The declaration still wins at runtime, so callers and the Gateway retry policy get a different answer here than everywhere else the same code is thrown. Drop the retryable (the SDK supplies ${canonicalRetryable}) or throw a distinct code for the retryable condition.`,
				});
			}
		}
	}
	return diagnostics;
}

/** Declared `errorCodes[]` entry shape the localization rules read. */
type OperationErrorCodeLike = {
	code: string;
	messageKey?: string;
	fixKey?: string;
};

type ErrorLocaleKeyStatus = "ok" | "missing" | "malformed";

function errorLocaleKeyStatus(catalog: ProviderLocaleCatalog, key: string): ErrorLocaleKeyStatus {
	if (!isProviderLocaleKey(key)) return "malformed";
	const value = getProviderLocaleSegments(catalog, key.split("."));
	return typeof value === "string" && value.trim().length > 0 ? "ok" : "missing";
}

function hasDerivedErrorCatalogText(
	catalog: ProviderLocaleCatalog,
	code: string,
	field: "message" | "fix",
): boolean {
	const value = getProviderLocaleSegments(catalog, [PROVIDER_ERROR_CATALOG_NAMESPACE, code, field]);
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Authoring rules for localized provider error text (see
 * `ProviderErrorOptions.messageKey`).
 *
 * - `error-locale-key-missing` / `error-locale-key-malformed` (**error**): a
 *   literal `messageKey`/`fixKey`, whether on a throw site or on an
 *   `errorCodes[]` declaration, that the provider's `en` catalog does not
 *   resolve to non-empty text, or that is not a legal locale dot path. At
 *   runtime such a key is silently skipped and the caller gets the English
 *   literal, so nothing fails loudly without this rule.
 * - `thrown-error-message-not-localized` (**warn**): a throw site whose literal
 *   `code` is declared in the provider's `errorCodes` but that carries no
 *   `messageKey`, no declaration-level `messageKey`, and no derived
 *   `errors.<code>.message` in `en`. Such an error is served untranslated to
 *   every caller. Warning while the ~2,000 existing sites migrate; it is
 *   promoted to error per provider as each migration wave lands.
 *
 * Both rules are skipped entirely when the caller did not supply
 * `localeCatalogEn`: without the catalog they could only guess.
 */
function lintErrorMessageLocalization(provider: {
	authFlowSource?: string;
	providerSourceFiles?: Record<string, string>;
	localeCatalogEn?: ProviderLocaleCatalog;
	operations?: Record<
		string,
		{
			handler?: unknown;
			source?: string;
			errorCodes?: ReadonlyArray<OperationErrorCodeLike>;
		}
	>;
}): LintDiagnostic[] {
	const catalog = provider.localeCatalogEn;
	if (!catalog) return [];

	const diagnostics: LintDiagnostic[] = [];
	const declaredCodes = new Set<string>();
	const codesWithDeclaredMessageKey = new Set<string>();

	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		for (const entry of operation.errorCodes ?? []) {
			if (typeof entry?.code !== "string") continue;
			declaredCodes.add(entry.code);
			for (const keyField of ["messageKey", "fixKey"] as const) {
				const key = entry[keyField];
				if (typeof key !== "string") continue;
				if (keyField === "messageKey") codesWithDeclaredMessageKey.add(entry.code);
				const status = errorLocaleKeyStatus(catalog, key);
				if (status === "ok") continue;
				diagnostics.push(
					errorLocaleKeyDiagnostic(
						status,
						`operations.${operationKey}.errorCodes`,
						key,
						`errorCodes entry "${entry.code}" of operation "${operationKey}"`,
					),
				);
			}
		}
	}

	for (const { field, source } of collectThrowSiteLintSources(provider)) {
		const reportedKeys = new Set<string>();
		const reportedCodes = new Set<string>();
		for (const site of collectThrownErrorConstructionSites(source)) {
			for (const key of [site.messageKey, site.fixKey]) {
				if (key === undefined || reportedKeys.has(key)) continue;
				const status = errorLocaleKeyStatus(catalog, key);
				if (status === "ok") continue;
				reportedKeys.add(key);
				diagnostics.push(
					errorLocaleKeyDiagnostic(status, field, key, `a thrown error in ${field}`),
				);
			}
			const code = site.code;
			if (code === undefined || reportedCodes.has(code)) continue;
			if (site.messageKey !== undefined) continue;
			if (!declaredCodes.has(code) || codesWithDeclaredMessageKey.has(code)) continue;
			if (hasDerivedErrorCatalogText(catalog, code, "message")) continue;
			reportedCodes.add(code);
			diagnostics.push({
				rule: "thrown-error-message-not-localized",
				level: "warn",
				field,
				message: `${site.errorClass} with declared code "${code}" (${field}) has no messageKey, its errorCodes declaration has none, and locales/en.json has no "${PROVIDER_ERROR_CATALOG_NAMESPACE}.${code}.message"; this error is served untranslated to ko and ja callers. Add messageKey (or "${PROVIDER_ERROR_CATALOG_NAMESPACE}.${code}.message" to every locale catalog).`,
			});
		}
	}

	return diagnostics;
}

function errorLocaleKeyDiagnostic(
	status: Exclude<ErrorLocaleKeyStatus, "ok">,
	field: string,
	key: string,
	owner: string,
): LintDiagnostic {
	return status === "malformed"
		? {
				rule: "error-locale-key-malformed",
				level: "error",
				field,
				message: `Locale key ${JSON.stringify(key)} on ${owner} is not a locale dot path such as "errors.upstreamSchema.message"; the SDK skips it at serve time and the caller gets the English literal instead.`,
			}
		: {
				rule: "error-locale-key-missing",
				level: "error",
				field,
				message: `Locale key ${JSON.stringify(key)} on ${owner} is missing from locales/en.json (or resolves to a non-string/empty value); the SDK falls back to the English literal at serve time, so the key never takes effect.`,
			};
}

type HandleFieldOccurrence = {
	/** Diagnostic path, e.g. `output.offers[].waiting_token`. */
	path: string;
	/** Property key the field is declared under (inherited through arrays/wrappers). */
	key: string;
	meta: HandleFieldMeta;
};

function collectHandleFields(
	schema: unknown,
	basePath: string,
	key: string | undefined = undefined,
	seen = new Set<SchemaLike>(),
): HandleFieldOccurrence[] {
	if (!isSchema(schema)) return [];

	// Record before the cycle guard so one `kind.field()` instance reused under
	// two property keys is still reported at both positions.
	const own = getOwnHandleFieldMeta(schema);
	if (own && key !== undefined) {
		return [{ path: basePath, key, meta: own }];
	}
	// Path-local cycle guard: the same wrapped schema instance may legitimately
	// appear under several property keys (`Kind.field().optional()` reused), and
	// each position must be checked. Only true ancestor cycles are cut.
	if (seen.has(schema)) return [];
	seen.add(schema);
	try {
		return collectHandleFieldChildren(schema, basePath, key, seen);
	} finally {
		seen.delete(schema);
	}
}

function collectHandleFieldChildren(
	schema: SchemaLike,
	basePath: string,
	key: string | undefined,
	seen: Set<SchemaLike>,
): HandleFieldOccurrence[] {
	const out: HandleFieldOccurrence[] = [];
	// zod exposes the same inner schema under several structural edges
	// (`unwrap`/`innerType`, `element`/`def.element`); traverse each structural
	// child object once. Shape children are always traversed: the same instance
	// under two property keys is two fields.
	const structuralSeen = new Set<SchemaLike>();
	for (const child of getChildSchemas(schema)) {
		if (child.origin !== "shape") {
			if (structuralSeen.has(child.schema)) continue;
			structuralSeen.add(child.schema);
		}
		if (child.origin === "shape") {
			// Provider-chosen property key: always a real field, even when it is
			// spelled like a structural edge (`item`, `type`, `schema`, ...).
			out.push(...collectHandleFields(child.schema, `${basePath}.${child.key}`, child.key, seen));
		} else if (isSchemaWrapperNodeKey(child.key)) {
			out.push(...collectHandleFields(child.schema, basePath, key, seen));
		} else if (child.key === "element" || child.key.startsWith("element.")) {
			out.push(...collectHandleFields(child.schema, `${basePath}[]`, key, seen));
		} else if (/^\d+$/.test(child.key)) {
			out.push(...collectHandleFields(child.schema, `${basePath}[${child.key}]`, key, seen));
		} else {
			out.push(...collectHandleFields(child.schema, `${basePath}.${child.key}`, child.key, seen));
		}
	}
	return out;
}

/**
 * Reads `provider.handle` structurally. The declaration type is owned by
 * define.ts/types.ts; lint only needs the HandleKindDeclaration view, so
 * malformed entries are skipped rather than reported.
 */
function readHandleKindDeclarations(value: unknown): HandleKindDeclaration[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is HandleKindDeclaration => {
		if (typeof entry !== "object" || entry === null) return false;
		const record = entry as Record<string, unknown>;
		return (
			typeof record.name === "string" &&
			(record.type === "cursor" || record.type === "draft") &&
			typeof record.fieldName === "string" &&
			(record.issuedBy === undefined || isHandleIssuedBy(record.issuedBy))
		);
	});
}

/**
 * ADR-0012 handle rules: every `x-apifuse-handle` schema field must belong to
 * a declared kind under its declared property key; every declared kind must be
 * both issued (some output) and accepted (some input); every `issuedBy` entry
 * must be an operation key and at least one of them must output the field; and
 * `ctx.handle` needs `state`.
 */
function lintHandleDeclarations(provider: {
	id?: string;
	handle?: unknown;
	state?: unknown;
	operations?: Record<string, { input: unknown; output: unknown }>;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const providerLabel = provider.id ? `Provider "${provider.id}"` : "Provider";
	const kinds = readHandleKindDeclarations(provider.handle);
	const kindByName = new Map(kinds.map((kind) => [kind.name, kind]));
	const operations = provider.operations ?? {};

	if (kinds.length > 0 && !provider.state) {
		diagnostics.push({
			rule: "handle-requires-state",
			level: "warn",
			field: "handle",
			message: `${providerLabel} declares handle kinds but not the state capability; ctx.handle stores records through ctx.state, so declare state: true.`,
		});
	}

	const kindsInInputs = new Set<string>();
	const kindsInOutputs = new Set<string>();
	const outputKindsByOperation = new Map<string, Set<string>>();

	for (const [operationKey, operation] of Object.entries(operations)) {
		const positions = [
			{ side: "input", fields: collectHandleFields(operation.input, "input") },
			{ side: "output", fields: collectHandleFields(operation.output, "output") },
		] as const;
		for (const { side, fields } of positions) {
			for (const occurrence of fields) {
				const field = `operations.${operationKey}.${occurrence.path}`;
				const { kind, fieldName } = occurrence.meta;

				if (!kindByName.has(kind)) {
					diagnostics.push({
						rule: "handle-kind-undeclared",
						level: "error",
						field,
						message: `${providerLabel} operation "${operationKey}" ${side} field "${occurrence.path}" is a handle of kind "${kind}", which is not declared in provider.handle. Add the kind to handle: [...] or remove the field.`,
					});
				}

				if (occurrence.key !== fieldName) {
					diagnostics.push({
						rule: "handle-field-name",
						level: "error",
						field,
						message: `${providerLabel} operation "${operationKey}" ${side} declares handle kind "${kind}" under property "${occurrence.key}" but the kind's fieldName is "${fieldName}". Use the same key in every schema so the LLM sees one name.`,
					});
				}

				if (side === "input") {
					kindsInInputs.add(kind);
				} else {
					kindsInOutputs.add(kind);
					let outputKinds = outputKindsByOperation.get(operationKey);
					if (!outputKinds) {
						outputKinds = new Set<string>();
						outputKindsByOperation.set(operationKey, outputKinds);
					}
					outputKinds.add(kind);
				}
			}
		}
	}

	for (const kind of kinds) {
		const field = `handle.${kind.name}`;
		const issued = kindsInOutputs.has(kind.name);
		const accepted = kindsInInputs.has(kind.name);

		if (!issued) {
			diagnostics.push({
				rule: "handle-field-parity",
				level: "error",
				field,
				message: `${providerLabel} handle kind "${kind.name}" is never issued: no operation output contains its field "${kind.fieldName}". Add ${kind.name}.field() to the issuing operation's output.`,
			});
		}
		if (!accepted) {
			diagnostics.push({
				rule: "handle-field-parity",
				level: "error",
				field,
				message: `${providerLabel} handle kind "${kind.name}" is never accepted: no operation input contains its field "${kind.fieldName}". Add ${kind.name}.field() to the consuming operation's input.`,
			});
		}

		if (kind.issuedBy === undefined) continue;
		const issuers = handleIssuerList(kind.issuedBy);
		const known = issuers.filter((operationKey) => Object.hasOwn(operations, operationKey));
		for (const operationKey of issuers) {
			if (known.includes(operationKey)) continue;
			diagnostics.push({
				rule: "handle-issued-by",
				level: "error",
				field,
				message: `${providerLabel} handle kind "${kind.name}" declares issuedBy "${operationKey}", which is not an operation key.`,
			});
		}
		if (known.length === 0) continue;
		const issuing = known.filter((operationKey) =>
			outputKindsByOperation.get(operationKey)?.has(kind.name),
		);
		if (issuing.length > 0) continue;
		if (known.length === 1) {
			diagnostics.push({
				rule: "handle-issued-by",
				level: "error",
				field,
				message: `${providerLabel} handle kind "${kind.name}" declares issuedBy "${known[0]}", but that operation's output has no "${kind.fieldName}" handle field.`,
			});
		} else {
			diagnostics.push({
				rule: "handle-issued-by",
				level: "error",
				field,
				message: `${providerLabel} handle kind "${kind.name}" declares issuedBy ${known
					.map((operationKey) => `"${operationKey}"`)
					.join(
						", ",
					)}, but none of those operations' outputs has a "${kind.fieldName}" handle field. At least one listed issuer must output it.`,
			});
		}
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
function findLegacyChoiceUsage(source: string): string | undefined {
	let ts: typeof import("typescript");
	try {
		ts = getTypeScript();
	} catch {
		return LEGACY_CHOICE_USAGE_PATTERN.exec(source)?.[0];
	}
	const file = ts.createSourceFile(
		"provider.ts",
		source,
		ts.ScriptTarget.Latest,
		false,
		ts.ScriptKind.TSX,
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
	const sources: Array<{ field: string; source: string }> = [];

	if (provider.authFlowSource) {
		sources.push({ field: "auth.flow", source: provider.authFlowSource });
	}
	for (const [filePath, source] of Object.entries(provider.providerSourceFiles ?? {})) {
		sources.push({ field: `sourceFiles.${filePath}`, source });
	}
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		const source = getOperationSource(operation);
		if (source) {
			sources.push({ field: `operations.${operationKey}.handler`, source });
		}
	}

	return sources.flatMap(({ field, source }) => {
		const match = findLegacyChoiceUsage(source);
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
		/**
		 * The provider's `locales/en.json`, injected by `apifuse check`. Error
		 * message localization rules are skipped when it is absent.
		 */
		localeCatalogEn?: ProviderLocaleCatalog;
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
				errorCodes?: ReadonlyArray<{
					code: string;
					status?: number;
					retryable?: boolean;
					messageKey?: string;
					fixKey?: string;
				}>;
			}
		>;
		meta?: {
			contract?: ProviderContractMetaLike;
		};
		reviewed?: string;
		/** Declared handle kinds (ADR-0012); read structurally, see readHandleKindDeclarations. */
		handle?: unknown;
		state?: unknown;
	},
	options: ProviderLintOptions = {},
): LintDiagnostic[] {
	return lintProviderWithInformation(provider, options).diagnostics;
}

/** Internal detailed result used by the CLI to render suppression audits. */
export function lintProviderWithInformation(
	provider: Parameters<typeof lintProvider>[0],
	options: ProviderLintOptions = {},
): ProviderLintResult {
	const diagnostics: LintDiagnostic[] = [
		...lintAllowedHosts(provider.id, provider.allowedHosts),
		...lintReviewed(provider.id, provider.reviewed),
		...lintAuthModel(provider),
		...lintStealthTransportUsage(provider),
		...lintCredentialWriteUsage(provider),
		...lintPlaywrightDirectImports(provider),
		...lintSelfHostedBrowserPatterns(provider, options),
		...lintBrowserVersionLiterals(provider),
		...lintUndeclaredThrownErrorCodes(provider),
		...lintErrorCodeDeclarationConflicts(provider),
		...lintErrorMessageLocalization(provider),
		...lintLegacyChoiceUsage(provider),
		...lintHandleDeclarations(provider),
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
