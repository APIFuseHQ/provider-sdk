import { createRequire } from "node:module";

import type { ZodType } from "zod";

import {
	SDK_RUNTIME_OWNED_ERROR_CODES,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
} from "./error-resolution.js";
import { lintPublicSchemaFieldNames } from "./public-schema-field-lint.js";
import { APIFUSE_DESCRIPTION_KEY_META_KEY, APIFUSE_SENSITIVE_META_KEY } from "./schema.js";

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
const AUTH_LIFECYCLE_WHOLE_ID_WORDS = new Set([
	"authorize",
	"revoke",
	"unlink",
	"disconnect",
]);

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
			message: `${providerLabel} must not declare credential.keys for platform-managed auth mode.`,
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

function getChildSchemas(schema: SchemaLike): Array<{ key: string; schema: SchemaLike }> {
	const seen = new Map<string, SchemaLike>();
	const def = getSchemaDef(schema);

	const add = (key: string, value: unknown) => {
		if (!isSchema(value)) {
			return;
		}
		seen.set(`${key}:${seen.size}`, value);
	};

	for (const [key, value] of Object.entries(getObjectShape(schema))) {
		add(key, value);
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
	}));
}

function uniqueFields(fields: string[]): string[] {
	return Array.from(new Set(fields));
}

function isSensitiveSchema(schema: unknown): boolean {
	if (!schema || typeof schema !== "object" || !("meta" in schema)) {
		return false;
	}
	const meta = schema.meta;
	if (typeof meta !== "function") return false;
	const metadata = meta.call(schema);
	return (
		!!metadata &&
		typeof metadata === "object" &&
		Reflect.get(metadata, APIFUSE_SENSITIVE_META_KEY) === true
	);
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

function isSensitiveFieldName(name: string): boolean {
	const normalized = name.toLowerCase().replace(/[-_\s]/g, "");
	return SENSITIVE_FIELD_NAMES.has(normalized);
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
		if (isSensitiveFieldName(key) && !isSensitiveSchema(child)) {
			out.push(childPath);
		}
		out.push(...collectUnmarkedSensitiveFields(child, childPath, seen));
	}
	for (const child of getChildSchemas(schema)) {
		if (Object.hasOwn(getObjectShape(schema), child.key)) continue;
		const isWrapperNode = [
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
		].includes(child.key);
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
		const isWrapperNode = [
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
		].includes(child.key);
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

function isComplexSchema(schema: unknown, seen = new Set<SchemaLike>()): boolean {
	if (!isSchema(schema) || seen.has(schema)) {
		return false;
	}

	seen.add(schema);
	const children = getChildSchemas(schema);
	const hasNestedComposite = children.some(({ schema: child }) => {
		const childChildren = getChildSchemas(child);
		return childChildren.length > 0;
	});

	return hasNestedComposite || children.some(({ schema: child }) => isComplexSchema(child, seen));
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

const THROWN_ERROR_CONSTRUCTION_PATTERN = /new\s+(?:ProviderError|ValidationError)\s*\(/g;

const TEST_SOURCE_FILE_PATTERN = /(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const RECORDED_FIXTURE_SOURCE_FILE_PATTERN =
	/(?:^|\/)__fixtures__(?:\/|$)|(?:^|\/)__tests__\/fixtures(?:\/|$)/;
const JAVASCRIPT_SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const VERSIONED_PROFILE_LITERAL_PATTERN =
	/\b(?:chrome|chromium|firefox|safari|edge|opera|ios[-_]safari)[-_]\d+(?:[._-]\d+)*(?=$|[^A-Za-z0-9])/i;
const VERSIONED_USER_AGENT_PATTERN = /\b(?:Chrome|CriOS|Firefox|FxiOS|EdgA?|OPR)\/\d+(?:\.\d+)*/i;
const VERSIONED_SAFARI_USER_AGENT_PATTERN = /\bVersion\/(\d+(?:\.\d+)*)(?=[\s\S]*\bSafari\/\d)/i;
const VERSIONED_CLIENT_HINT_PATTERN = /(?:^|[;,\s])v\s*=\s*["']?\d+/i;

type BrowserVersionLiteralKind = "profile" | "user-agent" | "sec-ch-ua";

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

function collectBrowserVersionLiteralFindings(source: string): BrowserVersionLiteralFinding[] {
	const ts = getTypeScript();
	const sourceFile = ts.createSourceFile(
		"provider-source.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	const findings: BrowserVersionLiteralFinding[] = [];
	const seen = new Set<string>();

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

	const visit = (node: import("typescript").Node) => {
		const text = staticStringText(node);
		if (text !== undefined) inspectLiteral(text, node.getStart(sourceFile));

		if (ts.isPropertyAssignment(node) && isSecChUaHeaderName(staticPropertyName(node.name))) {
			inspectSecChUaValue(node.initializer);
		}

		if (ts.isCallExpression(node) && isSecChUaHeaderName(staticStringText(node.arguments[0]))) {
			inspectSecChUaValue(node.arguments[1]);
		}

		if (
			ts.isArrayLiteralExpression(node) &&
			isSecChUaHeaderName(staticStringText(node.elements[0]))
		) {
			inspectSecChUaValue(node.elements[1]);
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return findings.sort((left, right) => left.position - right.position);
}

function browserVersionLiteralMessage(finding: BrowserVersionLiteralFinding): string {
	switch (finding.kind) {
		case "profile":
			return `Hardcoded stealth profile "${finding.literal}" pins a browser version and will rot. Select the browser and OS structurally, for example stealth: { browser: "chrome", os: "macos" }.`;
		case "user-agent":
			return `Hardcoded User-Agent browser version "${finding.literal}" can disagree with the stealth TLS fingerprint. Remove the literal and derive it from the structured profile, for example getStealthProfile({ browser: "chrome", os: "macos" }).userAgent.`;
		case "sec-ch-ua":
			return 'Hardcoded sec-ch-ua versions can disagree with the stealth TLS fingerprint. Remove the literal and let ctx.stealth generate client hints from stealth: { browser: "chrome", os: "macos" }; derive any explicit User-Agent with getStealthProfile({ browser: "chrome", os: "macos" }).userAgent.';
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
 * Collects literal string values of top-level `code:` properties inside a
 * ProviderError/ValidationError options object. Only plain `"..."` / `'...'`
 * literals at options-object depth count; computed codes (identifiers,
 * ternaries, template substitutions, concatenations, escapes) are skipped
 * silently so the rule never guesses.
 */
function collectLiteralErrorCodeValues(args: string): string[] {
	const codes: string[] = [];
	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let previousSignificantChar = "";
	for (let index = 0; index < args.length; index++) {
		const char = args[index] ?? "";
		if (char === '"' || char === "'" || char === "`") {
			const end = skipStringLiteral(args, index);
			if (end < 0) {
				return codes;
			}
			index = end;
			previousSignificantChar = char;
			continue;
		}
		if (char === "/" && args[index + 1] === "/") {
			const newline = args.indexOf("\n", index);
			if (newline === -1) {
				return codes;
			}
			index = newline;
			continue;
		}
		if (char === "/" && args[index + 1] === "*") {
			const end = args.indexOf("*/", index + 2);
			if (end === -1) {
				return codes;
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
			(previousSignificantChar === "{" || previousSignificantChar === ",") &&
			args.startsWith("code", index)
		) {
			let cursor = index + "code".length;
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
						if (!value.includes("\\") && (nextChar === "," || nextChar === "}" || nextChar === "")) {
							codes.push(value);
						}
						index = end;
						previousSignificantChar = quote;
						continue;
					}
					return codes;
				}
			}
		}
		previousSignificantChar = char;
	}
	return codes;
}

function collectLiteralThrownErrorCodes(source: string): string[] {
	const codes: string[] = [];
	THROWN_ERROR_CONSTRUCTION_PATTERN.lastIndex = 0;
	for (
		let match = THROWN_ERROR_CONSTRUCTION_PATTERN.exec(source);
		match;
		match = THROWN_ERROR_CONSTRUCTION_PATTERN.exec(source)
	) {
		const argsStart = match.index + match[0].length;
		const args = extractBalancedCallArguments(source, argsStart);
		if (args !== undefined) {
			codes.push(...collectLiteralErrorCodeValues(args));
		}
		THROWN_ERROR_CONSTRUCTION_PATTERN.lastIndex = argsStart;
	}
	return codes;
}

/**
 * Static counterpart of the runtime `unregistered_provider_error_code`
 * signal (honest-provider-error-contract Phase 3.5.5): flags
 * `new ProviderError(...)` / `new ValidationError(...)` constructions whose
 * literal `code` is neither SDK-registered (SDK_RUNTIME_OWNED_ERROR_CODES
 * plus the canonical status-mapped codes shared with serve.ts toStatusCode)
 * nor declared in any operation's docs.errorCodes. At runtime such a code
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
			docs?: { errorCodes?: ReadonlyArray<{ code: string }> };
		}
	>;
}): LintDiagnostic[] {
	const knownCodes = new Set<string>([
		...SDK_RUNTIME_OWNED_ERROR_CODES,
		...SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.keys(),
	]);
	for (const operation of Object.values(provider.operations ?? {})) {
		for (const entry of operation.docs?.errorCodes ?? []) {
			if (typeof entry?.code === "string") {
				knownCodes.add(entry.code);
			}
		}
	}

	const sources: Array<{ field: string; source: string }> = [];
	const sourceFiles = Object.entries(provider.providerSourceFiles ?? {}).filter(
		([filePath]) => !TEST_SOURCE_FILE_PATTERN.test(filePath),
	);
	if (sourceFiles.length > 0) {
		for (const [filePath, source] of sourceFiles) {
			sources.push({ field: `sourceFiles.${filePath}`, source });
		}
	} else {
		if (provider.authFlowSource) {
			sources.push({ field: "auth.flow", source: provider.authFlowSource });
		}
		for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
			const source = getOperationSource(operation);
			if (source) {
				sources.push({ field: `operations.${operationKey}.handler`, source });
			}
		}
	}

	const diagnostics: LintDiagnostic[] = [];
	for (const { field, source } of sources) {
		const undeclaredCodes = new Set(
			collectLiteralThrownErrorCodes(source).filter((code) => !knownCodes.has(code)),
		);
		for (const code of undeclaredCodes) {
			diagnostics.push({
				rule: "thrown-error-code-undeclared",
				level: "warn",
				field,
				message: `Thrown error code "${code}" (${field}) is neither SDK-registered nor declared in any operation's docs.errorCodes; at runtime it serves HTTP 500 and emits the unregistered_provider_error_code signal. Declare it in the owning operation's docs.errorCodes with status and retryable.`,
			});
		}
	}
	return diagnostics;
}

export function lintOperation(op: {
	description?: string;
	descriptionKey?: string;
	whenToUse?: readonly string[];
	whenToUseKeys?: readonly string[];
	whenNotToUse?: readonly string[];
	whenNotToUseKeys?: readonly string[];
	input: unknown;
	output: unknown;
	fixtures?: unknown;
	inputExamples?: readonly unknown[];
	derivations?: Record<string, string>;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const description = op.description ?? "";
	const hasDescriptionKey = typeof op.descriptionKey === "string" && op.descriptionKey.length > 0;

	if (description.trim().length > 0 && !hasDescriptionKey) {
		diagnostics.push({
			rule: "operation-description-raw-prose",
			level: "error",
			field: "description",
			message: "Operation description must use descriptionKey instead of raw static prose.",
		});
	}

	if (!hasDescriptionKey && description.length < 150) {
		diagnostics.push({
			rule: "description-min-length",
			level: "error",
			field: "description",
			message: "Operation description must be at least 150 characters.",
		});
	}

	if ((op.whenToUse?.length ?? 0) > 0 && !(op.whenToUseKeys?.length ?? 0)) {
		diagnostics.push({
			rule: "operation-when-to-use-raw-prose",
			level: "error",
			field: "whenToUse",
			message: "Operation whenToUse must use whenToUseKeys instead of raw static prose.",
		});
	}

	if ((op.whenNotToUse?.length ?? 0) > 0 && !(op.whenNotToUseKeys?.length ?? 0)) {
		diagnostics.push({
			rule: "operation-when-not-to-use-raw-prose",
			level: "error",
			field: "whenNotToUse",
			message: "Operation whenNotToUse must use whenNotToUseKeys instead of raw static prose.",
		});
	}

	const lowerDescription = description.toLowerCase();
	if (
		!hasDescriptionKey &&
		!(lowerDescription.includes("use") && lowerDescription.includes("when"))
	) {
		diagnostics.push({
			rule: "description-has-when-clause",
			level: "warn",
			field: "description",
			message: 'Operation description should include both "use" and "when".',
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

	if (isComplexSchema(op.input) && (op.inputExamples?.length ?? 0) < 2) {
		diagnostics.push({
			rule: "complex-input-has-examples",
			level: "warn",
			field: "inputExamples",
			message: "Complex input schemas should provide at least 2 input examples.",
		});
	}

	for (const field of uniqueFields(collectUnmarkedSensitiveFields(op.input, "input"))) {
		diagnostics.push({
			rule: "sensitive-field-unmarked",
			level: "warn",
			field,
			message: `Schema field "${field}" looks sensitive; mark it with fields.*(), field(..., { sensitive: true }), or sensitive(...).`,
		});
	}

	for (const field of uniqueFields(collectUnmarkedSensitiveFields(op.output, "output"))) {
		diagnostics.push({
			rule: "sensitive-field-unmarked",
			level: "warn",
			field,
			message: `Schema field "${field}" looks sensitive; mark it with fields.*(), field(..., { sensitive: true }), or sensitive(...).`,
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
				description?: string;
				descriptionKey?: string;
				whenToUse?: readonly string[];
				whenToUseKeys?: readonly string[];
				whenNotToUse?: readonly string[];
				whenNotToUseKeys?: readonly string[];
				input: unknown;
				output: unknown;
				fixtures?: unknown;
				inputExamples?: readonly unknown[];
				derivations?: Record<string, string>;
				handler?: unknown;
				source?: string;
				docs?: { errorCodes?: ReadonlyArray<{ code: string }> };
			}
		>;
		meta?: {
			contract?: ProviderContractMetaLike;
		};
		reviewed?: string;
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
	];

	if (provider.operations) {
		const authMode = provider.auth?.mode;
		// Every authenticated mode owns an auth.flow; `oauth2_proxied` was
		// previously exempt, which let auth-lifecycle operations ship on
		// proxied providers unchecked.
		if (
			authMode === "credentials" ||
			authMode === "oauth2" ||
			authMode === "oauth2_proxied"
		) {
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
					description: operation.description ?? "",
					descriptionKey: operation.descriptionKey,
					whenToUse: operation.whenToUse,
					whenToUseKeys: operation.whenToUseKeys,
					whenNotToUse: operation.whenNotToUse,
					whenNotToUseKeys: operation.whenNotToUseKeys,
					input: operation.input,
					output: operation.output,
					fixtures: operation.fixtures,
					inputExamples: operation.inputExamples,
					derivations: operation.derivations,
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
